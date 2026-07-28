// docx-tools.ts — agent tool family for editing .docx (Word/OOXML) files IN
// PLACE, preserving formatting. A .docx is a zip of XML; we manipulate
// `word/document.xml` (+ styles/rels/media/content-types) directly with xmldom
// and re-zip, so anything we don't touch is byte-preserved. This mirrors the
// Excel tool family in agent-tools.ts (async dispatch + a MUTATORS set that the
// run loop turns into a `file_changed` event → the live DocxViewer re-renders).
//
// Covered: outline/read/inspect, replace/insert/delete paragraph, run
// formatting (bold/italic/strike/underline/color/size/font/highlight),
// paragraph formatting (alignment/indent/spacing/line-spacing), apply style,
// insert image, tab stops + column alignment, insert table + set cell.
// NOT covered yet: header/footer, numbering (w:numPr), page setup (w:sectPr),
// table row/column/merge/shading, replace-all, and a "beautify" pass.
//
// Every tool addresses a paragraph by the ¶index DocxOutline reports, and that
// index space SHIFTS on insert/delete — see `structureVersion` below.

import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import * as fs from 'fs'
import * as path from 'path'
import type { ToolSpec } from './agent-tools'

// ── Namespaces / units ───────────────────────────────────────────
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
const REL_TYPE_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

const EMU_PER_PX = 9525 // at 96 dpi
const px2emu = (px: number) => Math.round(px * EMU_PER_PX)
const pt2halfPt = (pt: number) => String(Math.round(pt * 2)) // w:sz is half-points
const pt2twip = (pt: number) => Math.round(pt * 20) // spacing/indent are twips (1pt = 20)
const twip2pt = (v: string | null) => (v ? Math.round(Number(v) / 20) : 0)

// ── Text width estimation ────────────────────────────────────────
// The agent cannot see the rendered page, so alignment has to be COMPUTED, not
// eyeballed. Tab stops align by construction — provided the stop sits past the
// widest label. Undershoot makes that one row jump to the next default stop and
// the column visibly breaks.
//
// The old estimate was `charCount * 7pt`: it ignored the font size AND the glyph
// widths, so it was wrong in both directions. Measured against the browser's own
// text metrics: "Người đại diện theo pháp luật:" at 11pt is 134pt wide, not the
// 228pt it guessed (a 3cm hole); "Số CMND/CCCD:" at 18pt is 137pt, not 109 —
// undershoot, which is the one that actually breaks the layout.
//
// Widths are em fractions for Times New Roman; the samples tested land within
// ~1pt of the real metrics.
const EM_WIDTH: Record<string, number> = {
  A: .72, B: .67, C: .67, D: .72, E: .61, F: .56, G: .72, H: .72, I: .33, J: .39,
  K: .72, L: .61, M: .89, N: .72, O: .72, P: .56, Q: .72, R: .67, S: .56, T: .61,
  U: .72, V: .72, W: .94, X: .72, Y: .72, Z: .61, 'Đ': .72,
  a: .44, b: .5, c: .44, d: .5, e: .44, f: .33, g: .5, h: .5, i: .28, j: .28,
  k: .5, l: .28, m: .78, n: .5, o: .5, p: .5, q: .5, r: .33, s: .39, t: .28,
  u: .5, v: .5, w: .72, x: .5, y: .5, z: .44, 'đ': .5,
  ' ': .25, '.': .25, ',': .25, ':': .25, ';': .25, "'": .18, '"': .41,
  '!': .33, '?': .44, '-': .33, '–': .5, '—': 1, '(': .33, ')': .33,
  '[': .33, ']': .33, '/': .28, '\\': .28, '%': .83, '&': .78, '+': .56, '=': .56,
}
const EM_UPPER_FALLBACK = 0.7
const EM_FALLBACK = 0.5

// Relative to Times New Roman at the same point size.
function familyFactor(font?: string): number {
  const f = (font || '').toLowerCase()
  if (/courier|consolas|menlo|mono/.test(f)) return 1.2
  if (/arial|helvetica|verdana|tahoma/.test(f)) return 1.09
  if (/calibri|segoe|aptos/.test(f)) return 0.96
  return 1
}

// Width of `text` in points. Vietnamese diacritics are combining marks in NFD
// and add no width, so decompose and skip them — "ê" is exactly as wide as "e".
export function textWidthPt(
  text: string,
  sizePt: number,
  opts?: { bold?: boolean; font?: string },
): number {
  let em = 0
  for (const ch of text.normalize('NFD')) {
    if (ch >= '̀' && ch <= 'ͯ') continue // combining accent
    em += EM_WIDTH[ch] ?? (ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? EM_UPPER_FALLBACK : EM_FALLBACK)
  }
  return em * sizePt * familyFactor(opts?.font) * (opts?.bold ? 1.05 : 1)
}

// ── Session cache (one parsed doc per open path) ─────────────────
interface DocxSession {
  zip: JSZip
  doc: Document
  mtimeMs: number
  // Version of the ¶index space. Every insert/delete of a paragraph or table
  // shifts every index after it, so it bumps this. DocxOutline records the
  // version it reported; a tool aiming at an index while the two differ is
  // aiming at stale numbers. Reproduced on a real document: outline → insert at
  // ¶1 → format ¶7 bolded the paragraph BEFORE the intended one, and the tool
  // reported success. See agent-behavior-bug.md §7.
  structureVersion: number
  outlinedVersion: number
  // Document-wide default run font, parsed from styles.xml on first use.
  defaults?: { sizePt: number; font?: string }
}
const sessions = new Map<string, DocxSession>()

async function getSession(abs: string): Promise<DocxSession> {
  const stat = fs.statSync(abs)
  const cached = sessions.get(abs)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached
  const buf = fs.readFileSync(abs)
  const zip = await JSZip.loadAsync(buf)
  const xml = await zip.file('word/document.xml')!.async('string')
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document
  // A fresh session starts un-outlined: the agent must read the structure
  // before it may address anything by index.
  const session: DocxSession = { zip, doc, mtimeMs: stat.mtimeMs, structureVersion: 0, outlinedVersion: -1 }
  sessions.set(abs, session)
  return session
}

// Serialize the (mutated) document back into the zip and write to disk.
async function saveSession(abs: string, s: DocxSession): Promise<void> {
  let xml = new XMLSerializer().serializeToString(s.doc as any)
  if (!xml.startsWith('<?xml')) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + xml
  s.zip.file('word/document.xml', xml)
  const out = await s.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  fs.writeFileSync(abs, out)
  s.mtimeMs = fs.statSync(abs).mtimeMs
}

// Drop a cached session (called when a docx tab closes / workspace changes).
export function closeDocxSession(abs: string): void {
  sessions.delete(abs)
}
export function resetDocxSessions(): void {
  sessions.clear()
}

// ── DOM helpers (xmldom, prefixed tag names kept literal) ─────────
function el(doc: Document, tag: string): Element {
  return doc.createElement(tag)
}
function childrenNamed(node: Node, name: string): Element[] {
  const out: Element[] = []
  const kids = node.childNodes
  for (let i = 0; i < kids.length; i++) {
    const n = kids.item(i)
    if (n && n.nodeType === 1 && n.nodeName === name) out.push(n as Element)
  }
  return out
}
function firstChildNamed(node: Node, name: string): Element | null {
  return childrenNamed(node, name)[0] ?? null
}
function body(doc: Document): Element {
  const b = doc.getElementsByTagName('w:body')
  if (!b || b.length === 0) throw new Error('document has no w:body')
  return b.item(0) as Element
}
function bodyParagraphs(doc: Document): Element[] {
  return childrenNamed(body(doc), 'w:p')
}
function paragraphText(p: Element): string {
  const ts = p.getElementsByTagName('w:t')
  let s = ''
  for (let i = 0; i < ts.length; i++) s += ts.item(i)?.textContent ?? ''
  return s
}
function paragraphStyleId(p: Element): string | undefined {
  const pPr = firstChildNamed(p, 'w:pPr')
  if (!pPr) return undefined
  const pStyle = firstChildNamed(pPr, 'w:pStyle')
  return pStyle?.getAttribute('w:val') ?? undefined
}

// Refuse an index-addressed operation whose indices come from an outline taken
// before the structure changed. Making the wrong call IMPOSSIBLE beats telling
// the model not to make it — the system prompt already said "DocxOutline first"
// and the agent still targeted shifted indices.
function requireFreshOutline(s: DocxSession, tool: string): void {
  if (s.outlinedVersion === s.structureVersion) return
  throw new Error(
    s.outlinedVersion < 0
      ? `${tool}: call DocxOutline on this file first — every Docx tool targets a paragraph by the ¶index it reports.`
      : `${tool}: the ¶indices you are using are STALE. The document structure changed since your last ` +
        `DocxOutline (inserting or deleting a paragraph shifts every index after it), so this call would hit ` +
        `the wrong paragraph. Call DocxOutline again and use the NEW indices.`,
  )
}

// The run font a paragraph actually renders with: the first text run wins,
// anything it leaves unset falls back to the document defaults. Ignoring this is
// why the old estimate could not be right — a 20-char label is 90pt at 11pt and
// 150pt at 18pt, and the guess used neither.
async function docDefaults(s: DocxSession): Promise<{ sizePt: number; font?: string }> {
  if (s.defaults) return s.defaults
  let sizePt = 11 // Word's default when styles.xml says nothing
  let font: string | undefined
  const f = s.zip.file('word/styles.xml')
  if (f) {
    try {
      const d = new DOMParser().parseFromString(await f.async('string'), 'text/xml') as unknown as Document
      const dd = d.getElementsByTagName('w:rPrDefault').item(0)
      if (dd) {
        const sz = dd.getElementsByTagName('w:sz').item(0)?.getAttribute('w:val')
        if (sz && Number(sz) > 0) sizePt = Number(sz) / 2
        font = dd.getElementsByTagName('w:rFonts').item(0)?.getAttribute('w:ascii') || undefined
      }
    } catch { /* malformed styles.xml → keep the defaults */ }
  }
  s.defaults = { sizePt, font }
  return s.defaults
}

function firstRunFont(p: Element): { sizePt?: number; font?: string; bold: boolean } {
  for (const r of childrenNamed(p, 'w:r')) {
    if (!r.getElementsByTagName('w:t').length) continue
    const rPr = firstChildNamed(r, 'w:rPr')
    if (!rPr) return { bold: false }
    const sz = firstChildNamed(rPr, 'w:sz')?.getAttribute('w:val')
    return {
      sizePt: sz && Number(sz) > 0 ? Number(sz) / 2 : undefined,
      font: firstChildNamed(rPr, 'w:rFonts')?.getAttribute('w:ascii') || undefined,
      bold: Boolean(firstChildNamed(rPr, 'w:b')),
    }
  }
  return { bold: false }
}

function requireParagraph(doc: Document, index: number): Element {
  const ps = bodyParagraphs(doc)
  if (typeof index !== 'number' || Number.isNaN(index) || index < 0 || index >= ps.length) {
    throw new Error(`invalid paragraph index ${index} — the doc has ${ps.length} paragraphs (0..${ps.length - 1}); call DocxOutline first to get indices`)
  }
  return ps[index]
}

// Ensure a <w:pPr> exists as the FIRST child of the paragraph, return it.
function ensurePPr(doc: Document, p: Element): Element {
  let pPr = firstChildNamed(p, 'w:pPr')
  if (!pPr) {
    pPr = el(doc, 'w:pPr')
    p.insertBefore(pPr, p.firstChild)
  }
  return pPr
}
// pPr children must follow the schema order; keep the subset we set ordered.
const PPR_ORDER = ['w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:numPr', 'w:tabs', 'w:spacing', 'w:ind', 'w:jc']
function setPPrChild(doc: Document, pPr: Element, name: string, attrs: Record<string, string>): void {
  let node = firstChildNamed(pPr, name)
  if (!node) {
    node = el(doc, name)
    // insert respecting PPR_ORDER
    const myRank = PPR_ORDER.indexOf(name)
    let ref: Node | null = null
    const kids = pPr.childNodes
    for (let i = 0; i < kids.length; i++) {
      const k = kids.item(i)
      if (k && k.nodeType === 1) {
        const rank = PPR_ORDER.indexOf(k.nodeName)
        if (rank > myRank) { ref = k; break }
      }
    }
    pPr.insertBefore(node, ref)
  }
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
}

// rPr children order (subset we set).
const RPR_ORDER = ['w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:strike', 'w:color', 'w:sz', 'w:szCs', 'w:highlight', 'w:u']
function ensureRPr(doc: Document, r: Element): Element {
  let rPr = firstChildNamed(r, 'w:rPr')
  if (!rPr) {
    rPr = el(doc, 'w:rPr')
    r.insertBefore(rPr, r.firstChild)
  }
  return rPr
}
function setRPrChild(doc: Document, rPr: Element, name: string, attrs: Record<string, string> | null): void {
  // attrs === null → remove (used to clear a toggle)
  const existing = firstChildNamed(rPr, name)
  if (attrs === null) { if (existing) rPr.removeChild(existing); return }
  let node = existing
  if (!node) {
    node = el(doc, name)
    const myRank = RPR_ORDER.indexOf(name)
    let ref: Node | null = null
    const kids = rPr.childNodes
    for (let i = 0; i < kids.length; i++) {
      const k = kids.item(i)
      if (k && k.nodeType === 1) {
        const rank = RPR_ORDER.indexOf(k.nodeName)
        if (rank > myRank) { ref = k; break }
      }
    }
    rPr.insertBefore(node, ref)
  } else {
    // clear old attrs
    while (node.attributes && node.attributes.length) node.removeAttribute(node.attributes.item(0)!.nodeName)
  }
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
}

// Ensure a namespace declaration exists on <w:document>.
function ensureRootNs(doc: Document, prefix: string, uri: string): void {
  const root = doc.documentElement
  if (!root.getAttribute('xmlns:' + prefix)) root.setAttribute('xmlns:' + prefix, uri)
}

// ── Marks (run formatting) ───────────────────────────────────────
interface RunMarks {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean | string // true=single or a ST_Underline value
  color?: string // hex RRGGBB (no #)
  fontSize?: number // points
  fontFamily?: string
  highlight?: string // Word highlight name (yellow, green, …) or 'none'
}
function applyMarksToRPr(doc: Document, rPr: Element, m: RunMarks): void {
  if (m.bold !== undefined) setRPrChild(doc, rPr, 'w:b', m.bold ? {} : { 'w:val': 'false' })
  if (m.italic !== undefined) setRPrChild(doc, rPr, 'w:i', m.italic ? {} : { 'w:val': 'false' })
  if (m.strike !== undefined) setRPrChild(doc, rPr, 'w:strike', m.strike ? {} : { 'w:val': 'false' })
  if (m.underline !== undefined) {
    const val = m.underline === true ? 'single' : m.underline === false ? 'none' : String(m.underline)
    setRPrChild(doc, rPr, 'w:u', { 'w:val': val })
  }
  if (m.color) setRPrChild(doc, rPr, 'w:color', { 'w:val': m.color.replace(/^#/, '') })
  if (m.fontSize) { setRPrChild(doc, rPr, 'w:sz', { 'w:val': pt2halfPt(m.fontSize) }); setRPrChild(doc, rPr, 'w:szCs', { 'w:val': pt2halfPt(m.fontSize) }) }
  if (m.fontFamily) setRPrChild(doc, rPr, 'w:rFonts', { 'w:ascii': m.fontFamily, 'w:hAnsi': m.fontFamily, 'w:cs': m.fontFamily })
  if (m.highlight) setRPrChild(doc, rPr, 'w:highlight', { 'w:val': m.highlight })
}

// Split a paragraph's runs so that exactly the runs covering `phrase` are
// isolated, then return those runs (for phrase-scoped formatting). Best-effort:
// works when the phrase lies within contiguous text; returns [] if not found.
function isolatePhraseRuns(doc: Document, p: Element, phrase: string): Element[] {
  const runs = childrenNamed(p, 'w:r').filter((r) => r.getElementsByTagName('w:t').length > 0)
  const full = runs.map((r) => paragraphText(r))
  const joined = full.join('')
  const at = joined.indexOf(phrase)
  if (at < 0) return []
  const end = at + phrase.length
  // Map global offsets to (runIndex, localOffset); split boundary runs.
  let pos = 0
  const result: Element[] = []
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const text = full[i]
    const rStart = pos
    const rEnd = pos + text.length
    pos = rEnd
    if (rEnd <= at || rStart >= end) continue // no overlap
    const cutStart = Math.max(at, rStart) - rStart
    const cutEnd = Math.min(end, rEnd) - rStart
    if (cutStart === 0 && cutEnd === text.length) { result.push(r); continue }
    // split this run into up to 3 runs: [before][match][after]
    const mkRun = (slice: string): Element => {
      const nr = el(doc, 'w:r')
      const rPr = firstChildNamed(r, 'w:rPr')
      if (rPr) nr.appendChild(rPr.cloneNode(true))
      const t = el(doc, 'w:t')
      t.setAttribute('xml:space', 'preserve')
      t.appendChild(doc.createTextNode(slice))
      nr.appendChild(t)
      return nr
    }
    const before = text.slice(0, cutStart)
    const mid = text.slice(cutStart, cutEnd)
    const after = text.slice(cutEnd)
    const parent = r.parentNode as Node
    if (before) parent.insertBefore(mkRun(before), r)
    const midRun = mkRun(mid)
    parent.insertBefore(midRun, r)
    if (after) parent.insertBefore(mkRun(after), r)
    parent.removeChild(r)
    result.push(midRun)
  }
  return result
}

// ── Tool implementations ─────────────────────────────────────────
function resolveIn(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel)
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) throw new Error('path is outside workspace')
  if (!/\.docx$/i.test(abs)) throw new Error('not a .docx file')
  return abs
}

async function outline(cwd: string, a: { path: string }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  const { doc, zip } = s
  // These indices are now the current truth — index-addressed tools unlock
  // until the next structural change.
  s.outlinedVersion = s.structureVersion
  const ps = bodyParagraphs(doc)
  const used = new Set<string>()
  const lines = ps.map((p, i) => {
    const style = paragraphStyleId(p)
    if (style) used.add(style)
    const text = paragraphText(p).slice(0, 90)
    const tag = style ? ` [${style}]` : ''
    return `¶${i}${tag}: ${JSON.stringify(text)}`
  })
  // Don't dump all ~150 built-in styles — show the ones in use plus the common
  // paragraph styles worth applying, capped so it doesn't flood the context.
  const COMMON = new Set(['Normal', 'Title', 'Subtitle', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Quote', 'IntenseQuote', 'ListParagraph', 'NoSpacing', 'BodyText'])
  const styles = (await listStyles(zip)).filter((s) => s.type === 'paragraph')
  const shown = styles.filter((s) => used.has(s.id) || COMMON.has(s.id))
  const styleList = shown.map((s) => `${s.id}${s.name && s.name !== s.id ? ` "${s.name}"` : ''}`).join(', ')
  return `${ps.length} paragraphs.\n${lines.join('\n')}\n\nStyleIds you can apply (in use + common; the doc has ${styles.length} paragraph styles total): ${styleList}`
}

async function listStyles(zip: JSZip): Promise<{ id: string; name?: string; type?: string }[]> {
  const f = zip.file('word/styles.xml')
  if (!f) return []
  const doc = new DOMParser().parseFromString(await f.async('string'), 'text/xml') as unknown as Document
  const out: { id: string; name?: string; type?: string }[] = []
  const styleEls = doc.getElementsByTagName('w:style')
  for (let i = 0; i < styleEls.length; i++) {
    const s = styleEls.item(i)!
    const id = s.getAttribute('w:styleId') || ''
    const type = s.getAttribute('w:type') || undefined
    const nameEl = firstChildNamed(s, 'w:name')
    out.push({ id, name: nameEl?.getAttribute('w:val') || undefined, type })
  }
  return out
}

async function readText(cwd: string, a: { path: string; from?: number; to?: number }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const { doc } = await getSession(abs)
  const ps = bodyParagraphs(doc)
  const from = a.from ?? 0
  const to = a.to ?? ps.length - 1
  const out: string[] = []
  for (let i = from; i <= to && i < ps.length; i++) out.push(`¶${i}: ${paragraphText(ps[i])}`)
  return out.join('\n')
}

async function replaceText(cwd: string, a: { path: string; paragraphIndex?: number; find: string; replace: string }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  if (a.find == null || a.replace == null) throw new Error('DocxReplaceText needs both find and replace (aka old_text / new_text)')
  // paragraphIndex is optional — without it, search the whole document and
  // replace in the first paragraph that contains `find`.
  let index = a.paragraphIndex
  if (typeof index !== 'number' || Number.isNaN(index)) {
    const ps = bodyParagraphs(s.doc)
    index = ps.findIndex((p) => paragraphText(p).includes(a.find))
    if (index < 0) throw new Error(`"${a.find}" not found anywhere in the document`)
  }
  // Only an explicit index can be stale; the search-by-text path is safe.
  if (typeof a.paragraphIndex === 'number' && !Number.isNaN(a.paragraphIndex)) requireFreshOutline(s, 'DocxReplaceText')
  const p = requireParagraph(s.doc, index)
  const full = paragraphText(p)
  if (!full.includes(a.find)) throw new Error(`"${a.find}" not found in ¶${index}`)
  // Prefer a single-run replacement (preserves that run's formatting).
  const runs = childrenNamed(p, 'w:r')
  let done = false
  for (const r of runs) {
    const t = firstChildNamed(r, 'w:t')
    if (t && (t.textContent ?? '').includes(a.find)) {
      t.textContent = (t.textContent ?? '').replace(a.find, a.replace)
      t.setAttribute('xml:space', 'preserve')
      done = true
      break
    }
  }
  if (!done) {
    // Fallback: match spans runs — rewrite first w:t with the whole new text and
    // clear the others (loses intra-paragraph run boundaries; noted to the agent).
    const newFull = full.replace(a.find, a.replace)
    const ts = p.getElementsByTagName('w:t')
    if (ts.length) {
      ts.item(0)!.textContent = newFull
      ts.item(0)!.setAttribute('xml:space', 'preserve')
      for (let i = 1; i < ts.length; i++) ts.item(i)!.textContent = ''
    }
  }
  await saveSession(abs, s)
  return `replaced "${a.find}" → "${a.replace}" in ¶${index}`
}

async function formatRun(cwd: string, a: { path: string; paragraphIndex: number; search?: string; marks: RunMarks }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  requireFreshOutline(s, 'DocxFormatRun')
  const p = requireParagraph(s.doc, a.paragraphIndex)
  let targets: Element[]
  if (a.search) {
    targets = isolatePhraseRuns(s.doc, p, a.search)
    if (targets.length === 0) throw new Error(`phrase "${a.search}" not found in ¶${a.paragraphIndex}`)
  } else {
    targets = childrenNamed(p, 'w:r').filter((r) => r.getElementsByTagName('w:t').length > 0)
    if (targets.length === 0) throw new Error(`¶${a.paragraphIndex} has no text runs to format`)
  }
  for (const r of targets) applyMarksToRPr(s.doc, ensureRPr(s.doc, r), a.marks)
  await saveSession(abs, s)
  return `formatted ${a.search ? `"${a.search}" in ` : ''}¶${a.paragraphIndex}`
}

interface ParaFmt {
  alignment?: 'left' | 'center' | 'right' | 'both'
  indentLeft?: number // points
  indentRight?: number
  firstLine?: number
  hanging?: number
  lineSpacing?: number // multiple, e.g. 1.5
  spaceBefore?: number // points
  spaceAfter?: number
}
async function formatParagraph(cwd: string, a: { path: string; paragraphIndex: number; formatting: ParaFmt }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  requireFreshOutline(s, 'DocxFormatParagraph')
  const p = requireParagraph(s.doc, a.paragraphIndex)
  const pPr = ensurePPr(s.doc, p)
  const f = a.formatting
  if (f.alignment) setPPrChild(s.doc, pPr, 'w:jc', { 'w:val': f.alignment })
  if (f.spaceBefore !== undefined || f.spaceAfter !== undefined || f.lineSpacing !== undefined) {
    const attrs: Record<string, string> = {}
    if (f.spaceBefore !== undefined) attrs['w:before'] = String(pt2twip(f.spaceBefore))
    if (f.spaceAfter !== undefined) attrs['w:after'] = String(pt2twip(f.spaceAfter))
    if (f.lineSpacing !== undefined) { attrs['w:line'] = String(Math.round(f.lineSpacing * 240)); attrs['w:lineRule'] = 'auto' }
    setPPrChild(s.doc, pPr, 'w:spacing', attrs)
  }
  if (f.indentLeft !== undefined || f.indentRight !== undefined || f.firstLine !== undefined || f.hanging !== undefined) {
    const attrs: Record<string, string> = {}
    if (f.indentLeft !== undefined) attrs['w:left'] = String(pt2twip(f.indentLeft))
    if (f.indentRight !== undefined) attrs['w:right'] = String(pt2twip(f.indentRight))
    if (f.firstLine !== undefined) attrs['w:firstLine'] = String(pt2twip(f.firstLine))
    if (f.hanging !== undefined) attrs['w:hanging'] = String(pt2twip(f.hanging))
    setPPrChild(s.doc, pPr, 'w:ind', attrs)
  }
  await saveSession(abs, s)
  return `formatted paragraph ¶${a.paragraphIndex}`
}

async function applyStyle(cwd: string, a: { path: string; paragraphIndex: number; styleId: string }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  requireFreshOutline(s, 'DocxApplyStyle')
  const p = requireParagraph(s.doc, a.paragraphIndex)
  const pPr = ensurePPr(s.doc, p)
  setPPrChild(s.doc, pPr, 'w:pStyle', { 'w:val': a.styleId })
  await saveSession(abs, s)
  return `applied style "${a.styleId}" to ¶${a.paragraphIndex}`
}

function newParagraph(doc: Document, text: string, styleId?: string): Element {
  const p = el(doc, 'w:p')
  if (styleId) setPPrChild(doc, ensurePPr(doc, p), 'w:pStyle', { 'w:val': styleId })
  const r = el(doc, 'w:r')
  const t = el(doc, 'w:t')
  t.setAttribute('xml:space', 'preserve')
  t.appendChild(doc.createTextNode(text))
  r.appendChild(t)
  p.appendChild(r)
  return p
}
async function insertParagraph(cwd: string, a: { path: string; atIndex: number; text: string; styleId?: string; position?: 'before' | 'after' }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  requireFreshOutline(s, 'DocxInsertParagraph')
  const ps = bodyParagraphs(s.doc)
  const np = newParagraph(s.doc, a.text, a.styleId)
  const ref = ps[Math.max(0, Math.min(a.atIndex, ps.length - 1))]
  if (a.position === 'after') ref.parentNode!.insertBefore(np, ref.nextSibling)
  else ref.parentNode!.insertBefore(np, ref)
  s.structureVersion++ // every ¶index at or after atIndex just shifted
  await saveSession(abs, s)
  return `inserted paragraph ${a.position ?? 'before'} ¶${a.atIndex}`
}

async function deleteParagraph(cwd: string, a: { path: string; paragraphIndex: number }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  requireFreshOutline(s, 'DocxDeleteParagraph')
  const p = requireParagraph(s.doc, a.paragraphIndex)
  p.parentNode!.removeChild(p)
  s.structureVersion++ // every ¶index after this one just shifted
  await saveSession(abs, s)
  return `deleted ¶${a.paragraphIndex}`
}

// ── Image insertion ──────────────────────────────────────────────
function imageDims(buf: Buffer): { w: number; h: number; ext: string } | null {
  // PNG: 8-byte sig + IHDR (width@16, height@20, big-endian)
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png' }
  // GIF: width@6, height@8 little-endian
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), ext: 'gif' }
  // JPEG: scan SOF markers
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue }
      const marker = buf[off + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7), ext: 'jpeg' }
      }
      off += 2 + buf.readUInt16BE(off + 2)
    }
  }
  return null
}

async function nextRelId(zip: JSZip): Promise<{ relsDoc: Document; relsEl: Element; id: string }> {
  const relPath = 'word/_rels/document.xml.rels'
  const f = zip.file(relPath)
  const relsDoc = new DOMParser().parseFromString(
    f ? await f.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    'text/xml',
  ) as unknown as Document
  const relsEl = relsDoc.getElementsByTagName('Relationships').item(0) as Element
  let max = 0
  const rels = relsDoc.getElementsByTagName('Relationship')
  for (let i = 0; i < rels.length; i++) {
    const m = /^rId(\d+)$/.exec(rels.item(i)!.getAttribute('Id') || '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return { relsDoc, relsEl, id: 'rId' + (max + 1) }
}

async function ensureContentType(zip: JSZip, ext: string): Promise<void> {
  const ctPath = '[Content_Types].xml'
  const doc = new DOMParser().parseFromString(await zip.file(ctPath)!.async('string'), 'text/xml') as unknown as Document
  const defaults = doc.getElementsByTagName('Default')
  for (let i = 0; i < defaults.length; i++) if ((defaults.item(i)!.getAttribute('Extension') || '').toLowerCase() === ext) return
  const d = doc.createElement('Default')
  d.setAttribute('Extension', ext)
  d.setAttribute('ContentType', ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg')
  doc.documentElement.appendChild(d)
  zip.file(ctPath, new XMLSerializer().serializeToString(doc as any))
}

async function insertImage(cwd: string, a: { path: string; paragraphIndex: number; imagePath: string; width?: number; height?: number; align?: 'left' | 'center' | 'right' }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const imgAbs = path.resolve(cwd, a.imagePath)
  if (imgAbs !== cwd && !imgAbs.startsWith(cwd + path.sep)) throw new Error('image path is outside workspace')
  const imgBuf = fs.readFileSync(imgAbs)
  const dims = imageDims(imgBuf)
  const ext = dims?.ext ?? (path.extname(imgAbs).replace('.', '').toLowerCase() || 'png')
  const s = await getSession(abs)
  const { zip, doc } = s

  // sizing: use given px, else intrinsic; if only one given, keep aspect
  let wPx = a.width
  let hPx = a.height
  if (dims) {
    if (wPx && !hPx) hPx = Math.round((dims.h / dims.w) * wPx)
    else if (hPx && !wPx) wPx = Math.round((dims.w / dims.h) * hPx)
    else if (!wPx && !hPx) { wPx = Math.min(dims.w, 450); hPx = Math.round((dims.h / dims.w) * wPx) }
  }
  wPx = wPx || 300
  hPx = hPx || 200

  // add media + content-type + relationship
  const mediaFiles = Object.keys(zip.files).filter((n) => /^word\/media\/image\d+\./.test(n))
  const num = mediaFiles.length + 1
  const mediaName = `image${num}.${ext}`
  zip.file(`word/media/${mediaName}`, imgBuf)
  await ensureContentType(zip, ext)
  const { relsDoc, relsEl, id } = await nextRelId(zip)
  const rel = relsDoc.createElement('Relationship')
  rel.setAttribute('Id', id)
  rel.setAttribute('Type', REL_TYPE_IMAGE)
  rel.setAttribute('Target', `media/${mediaName}`)
  relsEl.appendChild(rel)
  zip.file('word/_rels/document.xml.rels', new XMLSerializer().serializeToString(relsDoc as any))

  // make sure the drawing namespaces are declared on the root
  ensureRootNs(doc, 'wp', WP_NS)
  ensureRootNs(doc, 'a', A_NS)
  ensureRootNs(doc, 'pic', PIC_NS)
  ensureRootNs(doc, 'r', R_NS)

  const cx = String(px2emu(wPx))
  const cy = String(px2emu(hPx))
  const drawingXml =
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${num}" name="Picture ${num}"/>` +
    `<a:graphic xmlns:a="${A_NS}"><a:graphicData uri="${PIC_NS}">` +
    `<pic:pic xmlns:pic="${PIC_NS}"><pic:nvPicPr><pic:cNvPr id="${num}" name="${mediaName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  const runFrag = new DOMParser().parseFromString(`<w:r xmlns:w="${W}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}" xmlns:r="${R_NS}">${drawingXml.replace(/^<w:r>|<\/w:r>$/g, '')}</w:r>`, 'text/xml') as unknown as Document

  requireFreshOutline(s, 'DocxInsertImage')
  const p = requireParagraph(doc, a.paragraphIndex)
  if (a.align) setPPrChild(doc, ensurePPr(doc, p), 'w:jc', { 'w:val': a.align })
  const imported = (doc as unknown as { importNode?: (n: Node, deep: boolean) => Node }).importNode
    ? (doc as unknown as { importNode: (n: Node, deep: boolean) => Node }).importNode(runFrag.documentElement as unknown as Node, true)
    : (runFrag.documentElement.cloneNode(true) as unknown as Node)
  p.appendChild(imported)
  await saveSession(abs, s)
  return `inserted image ${mediaName} (${wPx}×${hPx}px) into ¶${a.paragraphIndex}`
}

// ── Structure inspection (so the agent isn't editing blind) ──────
// Render a run's inline content, marking tabs/breaks so the agent SEES them.
function runContent(r: Element): string {
  let s = ''
  const kids = r.childNodes
  for (let i = 0; i < kids.length; i++) {
    const c = kids.item(i)
    if (!c) continue
    if (c.nodeName === 'w:t') s += c.textContent ?? ''
    else if (c.nodeName === 'w:tab') s += '→'
    else if (c.nodeName === 'w:br' || c.nodeName === 'w:cr') s += '↵'
  }
  return s
}
// Width of the text up to the FIRST tab — exactly what must fit before the
// first tab stop for the row to line up. null when the paragraph has no tab.
function widthBeforeFirstTab(p: Element, defs: { sizePt: number; font?: string }): number | null {
  let w = 0
  for (const r of childrenNamed(p, 'w:r')) {
    const rPr = firstChildNamed(r, 'w:rPr')
    const sz = rPr ? firstChildNamed(rPr, 'w:sz')?.getAttribute('w:val') : null
    const font = (rPr ? firstChildNamed(rPr, 'w:rFonts')?.getAttribute('w:ascii') : null) || defs.font
    const bold = Boolean(rPr && firstChildNamed(rPr, 'w:b'))
    const size = sz && Number(sz) > 0 ? Number(sz) / 2 : defs.sizePt
    const kids = r.childNodes
    for (let i = 0; i < kids.length; i++) {
      const c = kids.item(i)
      if (!c) continue
      if (c.nodeName === 'w:tab') return w
      if (c.nodeName === 'w:t') w += textWidthPt(c.textContent ?? '', size, { bold, font })
    }
  }
  return null
}

function inspectParagraph(p: Element, index: number, defs: { sizePt: number; font?: string }): string {
  const pPr = firstChildNamed(p, 'w:pPr')
  const style = paragraphStyleId(p)
  const jc = pPr ? firstChildNamed(pPr, 'w:jc')?.getAttribute('w:val') : undefined
  const tabsEl = pPr ? firstChildNamed(pPr, 'w:tabs') : null
  const stops: string[] = []
  let firstStopPt: number | null = null
  if (tabsEl) for (const t of childrenNamed(tabsEl, 'w:tab')) {
    const pos = twip2pt(t.getAttribute('w:pos'))
    if (firstStopPt == null) firstStopPt = pos
    stops.push(`${t.getAttribute('w:val') || 'left'}@${pos}pt`)
  }
  // The agent cannot look at the page, so hand it the one number that decides
  // whether the column is straight: does the text before the tab clear the stop?
  let fitNote = ''
  if (firstStopPt != null) {
    const w = widthBeforeFirstTab(p, defs)
    if (w != null) {
      fitNote = w <= firstStopPt
        ? ` beforeTab≈${Math.round(w)}pt (fits, +${Math.round(firstStopPt - w)}pt)`
        : ` beforeTab≈${Math.round(w)}pt OVERFLOWS the ${firstStopPt}pt stop by ${Math.round(w - firstStopPt)}pt — this row jumps to the next default stop and breaks the column`
    }
  }
  const ind = pPr ? firstChildNamed(pPr, 'w:ind') : null
  const indStr = ind ? `indent(left=${twip2pt(ind.getAttribute('w:left'))}pt,firstLine=${twip2pt(ind.getAttribute('w:firstLine'))}pt)` : ''
  const parts: string[] = []
  for (const r of childrenNamed(p, 'w:r')) {
    const seg = runContent(r)
    if (seg === '') continue
    const rPr = firstChildNamed(r, 'w:rPr')
    const marks: string[] = []
    if (rPr) {
      if (firstChildNamed(rPr, 'w:b')) marks.push('bold')
      if (firstChildNamed(rPr, 'w:i')) marks.push('italic')
      if (firstChildNamed(rPr, 'w:u')) marks.push('underline')
      const col = firstChildNamed(rPr, 'w:color')?.getAttribute('w:val'); if (col && col !== 'auto') marks.push('#' + col)
      const sz = firstChildNamed(rPr, 'w:sz')?.getAttribute('w:val'); if (sz) marks.push(Number(sz) / 2 + 'pt')
      const hl = firstChildNamed(rPr, 'w:highlight')?.getAttribute('w:val'); if (hl) marks.push('hl:' + hl)
    }
    parts.push(marks.length ? `${JSON.stringify(seg)}{${marks.join(',')}}` : JSON.stringify(seg))
  }
  const meta = [style ? `style=${style}` : '', jc ? `align=${jc}` : '', stops.length ? `tabStops=[${stops.join(', ')}]` : '', indStr].filter(Boolean).join(' ') + fitNote
  return `¶${index}${meta ? ' — ' + meta : ''}\n  runs: ${parts.join(' + ') || '(empty)'}`
}
async function inspect(cwd: string, a: { path: string; from?: number; to?: number }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  const doc = s.doc
  const defs = await docDefaults(s)
  const ps = bodyParagraphs(doc)
  const from = a.from ?? 0
  const to = a.to ?? ps.length - 1
  const out: string[] = [
    'Legend: → = tab, ↵ = line break. Run text shown with {formatting}. ' +
    `beforeTab≈Npt = measured width of the text before the first tab (default font ${defs.sizePt}pt` +
    `${defs.font ? ' ' + defs.font : ''}) — it must be ≤ the first tab stop or that row breaks.`,
  ]
  for (let i = from; i <= to && i < ps.length; i++) out.push(inspectParagraph(ps[i], i, defs))
  return out.join('\n')
}

// ── Tab stops + column alignment (the correct way to line up ":" ) ─
function setParagraphTabStops(doc: Document, p: Element, positionsPt: number[], val: string): void {
  const pPr = ensurePPr(doc, p)
  const old = firstChildNamed(pPr, 'w:tabs')
  if (old) pPr.removeChild(old)
  if (!positionsPt.length) return
  const tabs = el(doc, 'w:tabs')
  for (const pt of positionsPt.sort((x, y) => x - y)) {
    const t = el(doc, 'w:tab')
    t.setAttribute('w:val', val)
    t.setAttribute('w:pos', String(pt2twip(pt)))
    tabs.appendChild(t)
  }
  // insert respecting PPR order
  const myRank = PPR_ORDER.indexOf('w:tabs')
  let ref: Node | null = null
  const kids = pPr.childNodes
  for (let i = 0; i < kids.length; i++) {
    const k = kids.item(i)
    if (k && k.nodeType === 1 && PPR_ORDER.indexOf(k.nodeName) > myRank) { ref = k; break }
  }
  pPr.insertBefore(tabs, ref)
}
async function setTabStops(cwd: string, a: { path: string; paragraphIndex?: number; from?: number; to?: number; positions: number[]; align?: string }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  const positions = (Array.isArray(a.positions) ? a.positions : [a.positions]).map(Number).filter((n) => Number.isFinite(n))
  if (!positions.length) throw new Error('DocxSetTabStops needs positions (points, e.g. [120] or [72,240])')
  const val = a.align === 'right' || a.align === 'center' || a.align === 'decimal' ? a.align : 'left'
  requireFreshOutline(s, 'DocxSetTabStops')
  const ps = bodyParagraphs(s.doc)
  const from = a.paragraphIndex ?? a.from ?? 0
  const to = a.paragraphIndex ?? a.to ?? from
  for (let i = from; i <= to && i < ps.length; i++) setParagraphTabStops(s.doc, ps[i], positions, val)
  await saveSession(abs, s)
  return `set tab stops [${positions.join(', ')}]pt on ¶${from}${to > from ? `..¶${to}` : ''}`
}

// Line up label/value pairs (e.g. "Họ tên: Nguyễn") by putting a single TAB
// after the separator and a shared tab stop on every paragraph — this is how
// Word actually aligns columns (spaces never align in a proportional font).
async function alignColumns(cwd: string, a: { path: string; from?: number; to?: number; separator?: string; position?: number }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  requireFreshOutline(s, 'DocxAlignColumns')
  const doc = s.doc
  const sep = a.separator ?? ':'
  const ps = bodyParagraphs(doc)
  const from = a.from ?? 0
  const to = a.to ?? ps.length - 1
  const defs = await docDefaults(s)
  const targets: { p: Element; label: string; value: string; widthPt: number; index: number }[] = []
  for (let i = from; i <= to && i < ps.length; i++) {
    const p = ps[i]
    if (childrenNamed(p, 'w:tbl').length) continue
    const full = paragraphText(p)
    const idx = full.indexOf(sep)
    if (idx < 0) continue
    const label = full.slice(0, idx + sep.length)
    let v = idx + sep.length
    while (v < full.length && /\s/.test(full[v])) v++
    // Each row is measured with ITS OWN font — a doc mixing 11pt body with a
    // 14pt heading row cannot share one guess.
    const f = firstRunFont(p)
    targets.push({
      p, label, index: i, value: full.slice(v),
      widthPt: textWidthPt(label, f.sizePt ?? defs.sizePt, { bold: f.bold, font: f.font ?? defs.font }),
    })
  }
  if (!targets.length) throw new Error(`no "${sep}" separator found in ¶${from}..¶${to}`)

  const widest = targets.reduce((m, t) => (t.widthPt > m.widthPt ? t : m))
  // Bias the margin outward: too wide is merely ugly, too narrow sends that one
  // row to the next default stop and visibly breaks the column. Rounded to a 6pt
  // grid so the number reads like something a person would have chosen.
  const autoPt = Math.ceil((widest.widthPt * 1.08 + 8) / 6) * 6
  if (a.position != null && a.position < widest.widthPt + 2) {
    throw new Error(
      `DocxAlignColumns: position ${a.position}pt is narrower than the widest label ` +
      `(¶${widest.index} "${widest.label}" ≈ ${Math.round(widest.widthPt)}pt). That row's tab would jump to the ` +
      `next default stop and break the column. Use at least ${autoPt}pt, or omit position and let it be measured.`,
    )
  }
  const posPt = a.position ?? autoPt
  for (const { p, label, value } of targets) {
    // preserve the label's run formatting + the value's run formatting
    const runs = childrenNamed(p, 'w:r')
    const labelRPr = runs[0] ? firstChildNamed(runs[0], 'w:rPr') : null
    const valRPr = runs[runs.length - 1] ? firstChildNamed(runs[runs.length - 1], 'w:rPr') : null
    for (const r of runs) p.removeChild(r)
    const pPr = firstChildNamed(p, 'w:pPr')
    const anchor: Node | null = pPr ? pPr.nextSibling : p.firstChild
    const mkRun = (txt: string, rPr: Element | null): Element => {
      const r = el(doc, 'w:r')
      if (rPr) r.appendChild(rPr.cloneNode(true))
      const t = el(doc, 'w:t')
      t.setAttribute('xml:space', 'preserve')
      t.appendChild(doc.createTextNode(txt))
      r.appendChild(t)
      return r
    }
    const tabRun = el(doc, 'w:r')
    tabRun.appendChild(el(doc, 'w:tab'))
    p.insertBefore(mkRun(label, labelRPr), anchor)
    p.insertBefore(tabRun, anchor)
    if (value) p.insertBefore(mkRun(value, valRPr), anchor)
    setParagraphTabStops(doc, p, [posPt], 'left')
  }
  await saveSession(abs, s)
  // Report the measurement, not just the action — this is how the agent knows
  // the column is straight without being able to look at it.
  return `aligned ${targets.length} "${sep}" rows at a ${posPt}pt tab stop. Widest label is ¶${widest.index} ` +
    `"${widest.label}" ≈ ${Math.round(widest.widthPt)}pt, so every label clears the stop by at least ` +
    `${Math.round(posPt - widest.widthPt)}pt — the values line up. Confirm with DocxInspect.`
}

// ── Tables ───────────────────────────────────────────────────────
function buildTable(doc: Document, rows: number, cols: number, data?: unknown[][]): Element {
  const tbl = el(doc, 'w:tbl')
  const tblPr = el(doc, 'w:tblPr')
  const tblW = el(doc, 'w:tblW'); tblW.setAttribute('w:w', '0'); tblW.setAttribute('w:type', 'auto'); tblPr.appendChild(tblW)
  const borders = el(doc, 'w:tblBorders')
  for (const edge of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
    const b = el(doc, 'w:' + edge)
    b.setAttribute('w:val', 'single'); b.setAttribute('w:sz', '4'); b.setAttribute('w:space', '0'); b.setAttribute('w:color', 'auto')
    borders.appendChild(b)
  }
  tblPr.appendChild(borders)
  tbl.appendChild(tblPr)
  const grid = el(doc, 'w:tblGrid')
  for (let c = 0; c < cols; c++) grid.appendChild(el(doc, 'w:gridCol'))
  tbl.appendChild(grid)
  for (let r = 0; r < rows; r++) {
    const tr = el(doc, 'w:tr')
    for (let c = 0; c < cols; c++) {
      const tc = el(doc, 'w:tc')
      tc.appendChild(el(doc, 'w:tcPr'))
      const cp = el(doc, 'w:p')
      const text = data?.[r]?.[c]
      if (text !== undefined && text !== null && String(text) !== '') {
        const cr = el(doc, 'w:r')
        const ct = el(doc, 'w:t'); ct.setAttribute('xml:space', 'preserve'); ct.appendChild(doc.createTextNode(String(text)))
        cr.appendChild(ct); cp.appendChild(cr)
      }
      tc.appendChild(cp)
      tr.appendChild(tc)
    }
    tbl.appendChild(tr)
  }
  return tbl
}
async function insertTable(cwd: string, a: { path: string; atIndex?: number; rows?: number; cols?: number; data?: unknown[][]; position?: 'before' | 'after' }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  requireFreshOutline(s, 'DocxInsertTable')
  const data = Array.isArray(a.data) ? a.data : undefined
  const rows = a.rows ?? data?.length ?? 2
  const cols = a.cols ?? (data ? Math.max(...data.map((r) => (Array.isArray(r) ? r.length : 0))) : 2)
  const tbl = buildTable(s.doc, rows, cols, data)
  const b = body(s.doc)
  const ps = bodyParagraphs(s.doc)
  // A table must be followed by a paragraph; anchor relative to a paragraph.
  if (a.atIndex !== undefined && ps[a.atIndex]) {
    const ref = ps[a.atIndex]
    if (a.position === 'after') b.insertBefore(tbl, ref.nextSibling)
    else b.insertBefore(tbl, ref)
  } else {
    const sectPr = firstChildNamed(b, 'w:sectPr')
    b.insertBefore(tbl, sectPr) // before the final sectPr (end of body)
    b.insertBefore(el(s.doc, 'w:p'), sectPr)
  }
  s.structureVersion++ // a table (and its trailing ¶) changed the index space
  await saveSession(abs, s)
  return `inserted ${rows}×${cols} table`
}
async function setCell(cwd: string, a: { path: string; tableIndex?: number; row: number; col: number; text: string }): Promise<string> {
  const abs = resolveIn(cwd, a.path)
  const s = await getSession(abs)
  const tables = childrenNamed(body(s.doc), 'w:tbl')
  const ti = a.tableIndex ?? 0
  const tbl = tables[ti]
  if (!tbl) throw new Error(`table ${ti} not found (${tables.length} tables in the doc)`)
  const trs = childrenNamed(tbl, 'w:tr')
  const tr = trs[a.row]
  if (!tr) throw new Error(`row ${a.row} out of range (${trs.length} rows)`)
  const tcs = childrenNamed(tr, 'w:tc')
  const tc = tcs[a.col]
  if (!tc) throw new Error(`col ${a.col} out of range (${tcs.length} cols)`)
  // replace the cell paragraph's content with the new text
  for (const p of childrenNamed(tc, 'w:p')) tc.removeChild(p)
  const cp = el(s.doc, 'w:p')
  const cr = el(s.doc, 'w:r')
  const ct = el(s.doc, 'w:t'); ct.setAttribute('xml:space', 'preserve'); ct.appendChild(s.doc.createTextNode(String(a.text ?? '')))
  cr.appendChild(ct); cp.appendChild(cr); tc.appendChild(cp)
  await saveSession(abs, s)
  return `set table ${ti} cell (${a.row},${a.col}) = ${JSON.stringify(a.text)}`
}

// ── Tool specs (mirror EXCEL_TOOL_SPECS shape) ───────────────────
const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', properties, required })
const str = { type: 'string' }
const num = { type: 'number' }
const bool = { type: 'boolean' }

export const DOCX_TOOL_SPECS: ToolSpec[] = [
  { name: 'DocxOutline', description: 'List every paragraph of a .docx with its index (¶N), style, and text preview, plus the available styleIds. ALWAYS call this first — every other Docx tool targets a paragraph by its index.', input_schema: obj({ path: str }, ['path']) },
  { name: 'DocxReadText', description: 'Read the plain text of a .docx paragraph range (from..to inclusive; defaults to the whole doc).', input_schema: obj({ path: str, from: num, to: num }, ['path']) },
  { name: 'DocxReplaceText', description: 'Replace the first occurrence of `find` with `replace`. If `paragraphIndex` is given, only that paragraph is searched; otherwise the whole document is searched. Preserves run formatting when the match is within one run.', input_schema: obj({ path: str, find: str, replace: str, paragraphIndex: num }, ['path', 'find', 'replace']) },
  { name: 'DocxInsertParagraph', description: 'Insert a new paragraph with `text` before/after paragraph `atIndex`. Optional styleId (from DocxOutline).', input_schema: obj({ path: str, atIndex: num, text: str, styleId: str, position: { type: 'string', enum: ['before', 'after'] } }, ['path', 'atIndex', 'text']) },
  { name: 'DocxDeleteParagraph', description: 'Delete paragraph `paragraphIndex`.', input_schema: obj({ path: str, paragraphIndex: num }, ['path', 'paragraphIndex']) },
  { name: 'DocxFormatRun', description: 'Apply character formatting to a paragraph (or, with `search`, only to that exact phrase within it). marks: bold/italic/strike (booleans; false clears), underline (true or a style name), color (hex "1A73E8"), fontSize (points), fontFamily, highlight (Word name like "yellow" or "none").', input_schema: obj({ path: str, paragraphIndex: num, search: str, marks: obj({ bold: bool, italic: bool, strike: bool, underline: {}, color: str, fontSize: num, fontFamily: str, highlight: str }, []) }, ['path', 'paragraphIndex', 'marks']) },
  { name: 'DocxFormatParagraph', description: 'Set paragraph formatting: alignment (left|center|right|both), indentLeft/indentRight/firstLine/hanging (points), lineSpacing (multiple e.g. 1.5), spaceBefore/spaceAfter (points).', input_schema: obj({ path: str, paragraphIndex: num, formatting: obj({ alignment: { type: 'string', enum: ['left', 'center', 'right', 'both'] }, indentLeft: num, indentRight: num, firstLine: num, hanging: num, lineSpacing: num, spaceBefore: num, spaceAfter: num }, []) }, ['path', 'paragraphIndex', 'formatting']) },
  { name: 'DocxApplyStyle', description: 'Apply a paragraph style (styleId from DocxOutline, e.g. "Heading1", "Normal") to paragraph `paragraphIndex`.', input_schema: obj({ path: str, paragraphIndex: num, styleId: str }, ['path', 'paragraphIndex', 'styleId']) },
  { name: 'DocxInsertImage', description: 'Insert an image file (already in the workspace — download it first with DownloadFile) into paragraph `paragraphIndex`. Optional width/height in px (aspect kept if only one given) and align (left|center|right).', input_schema: obj({ path: str, paragraphIndex: num, imagePath: str, width: num, height: num, align: { type: 'string', enum: ['left', 'center', 'right'] } }, ['path', 'paragraphIndex', 'imagePath']) },
  { name: 'DocxInspect', description: 'Show the DETAILED structure of a paragraph range (from..to): every run with its text + formatting {bold,#color,pt,…}, tabs (→), line breaks (↵), the paragraph style, alignment, tab stops and indent. Use this to SEE what you are editing — DocxReadText only gives plain text. For any paragraph with a tab stop it also reports beforeTab≈Npt, the measured width of the text before the first tab, and flags when it overflows the stop — that is how you verify an alignment without looking at the page.', input_schema: obj({ path: str, from: num, to: num }, ['path']) },
  { name: 'DocxSetTabStops', description: 'Set tab stops (in points from the left margin) on a paragraph or range. positions e.g. [120] or [72,240]; align = left|right|center|decimal. Tab stops are how Word lines up columns.', input_schema: obj({ path: str, paragraphIndex: num, from: num, to: num, positions: { type: 'array', items: num }, align: { type: 'string', enum: ['left', 'right', 'center', 'decimal'] } }, ['path', 'positions']) },
  { name: 'DocxAlignColumns', description: 'Line up "label: value" rows in a paragraph range so the values start at the SAME column (the correct way to align colons — spaces never align in Word). Puts a single tab after `separator` (default ":") and one shared tab stop on every row. Optional position (points) — otherwise MEASURED from the real glyph widths and font size of every row and set just past the widest label. Returns the measurement (widest label and the clearance) so you can confirm the column is straight without seeing the page. A pinned position narrower than the widest label is refused, because the tab on that row would jump to the next default stop and break the column.', input_schema: obj({ path: str, from: num, to: num, separator: str, position: num }, ['path', 'from', 'to']) },
  { name: 'DocxInsertTable', description: 'Insert a bordered table. Give rows+cols, and/or data as a 2D array of cell strings (rows). Inserts before/after paragraph atIndex, or at the end of the document if atIndex is omitted.', input_schema: obj({ path: str, atIndex: num, rows: num, cols: num, data: { type: 'array', items: { type: 'array' } }, position: { type: 'string', enum: ['before', 'after'] } }, ['path']) },
  { name: 'DocxSetCell', description: 'Set the text of one table cell. tableIndex (0-based order in the doc, default 0), row, col.', input_schema: obj({ path: str, tableIndex: num, row: num, col: num, text: str }, ['path', 'row', 'col', 'text']) },
]

export const DOCX_TOOL_NAMES = new Set(DOCX_TOOL_SPECS.map((s) => s.name))
// Tools that write the file → the run loop emits `file_changed` for the live viewer.
export const DOCX_MUTATORS = new Set(['DocxReplaceText', 'DocxInsertParagraph', 'DocxDeleteParagraph', 'DocxFormatRun', 'DocxFormatParagraph', 'DocxApplyStyle', 'DocxInsertImage', 'DocxSetTabStops', 'DocxAlignColumns', 'DocxInsertTable', 'DocxSetCell'])

// Models are loose with parameter names — they use snake_case (paragraph_index),
// synonyms (old_text/new_text for find/replace), and sometimes pass formatting
// flags at the top level instead of nested. Normalize all of that to the
// canonical shape so a reasonable call never fails on a naming mismatch.
function camelKey(k: string): string {
  return k.replace(/[_-]([a-z0-9])/gi, (_m, c: string) => c.toUpperCase())
}
function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[camelKey(k)] = camelize(val)
    return out
  }
  return v
}
const MARK_KEYS = ['bold', 'italic', 'strike', 'underline', 'color', 'fontSize', 'fontFamily', 'highlight']
const FMT_KEYS = ['alignment', 'indentLeft', 'indentRight', 'firstLine', 'hanging', 'lineSpacing', 'spaceBefore', 'spaceAfter']
function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
function normalizeArgs(name: string, raw: any): any {
  const a: any = camelize(raw || {})
  const alias = (canon: string, names: string[]) => {
    if (a[canon] === undefined) for (const n of names) if (a[n] !== undefined) { a[canon] = a[n]; break }
  }
  alias('path', ['file', 'filePath', 'document', 'doc', 'docx', 'fileName'])
  alias('paragraphIndex', ['paragraph', 'index', 'idx', 'para', 'p', 'paragraphIdx'])
  alias('atIndex', ['at', 'afterIndex', 'beforeIndex', 'insertAt', 'index', 'paragraphIndex'])
  alias('styleId', ['style', 'styleName'])
  alias('imagePath', ['image', 'img', 'src', 'imageFile'])
  alias('align', ['alignment', 'justify'])
  alias('search', ['phrase'])
  alias('text', ['content', 'value'])
  alias('separator', ['sep', 'delimiter'])
  alias('position', ['pos', 'tabPos', 'tabStop'])
  alias('tableIndex', ['table', 'tableIdx'])
  alias('positions', ['tabStops', 'stops', 'positionsPt'])
  if (name === 'DocxReplaceText') {
    alias('find', ['oldText', 'old', 'target', 'searchText', 'findText'])
    alias('replace', ['newText', 'new', 'replacement', 'with', 'replaceWith'])
  }
  if (a.positions !== undefined && !Array.isArray(a.positions)) a.positions = [a.positions]
  for (const k of ['paragraphIndex', 'atIndex', 'from', 'to', 'width', 'height', 'rows', 'cols', 'row', 'col', 'tableIndex']) if (a[k] !== undefined) a[k] = toNum(a[k])
  // `position` is a tab-stop number for AlignColumns but a 'before'|'after' string for insert tools.
  if (name === 'DocxAlignColumns' && a.position !== undefined) a.position = toNum(a.position)
  // A single-paragraph read expressed as paragraphIndex → from/to.
  if (name === 'DocxReadText' && a.from === undefined && a.to === undefined && a.paragraphIndex !== undefined) {
    a.from = a.paragraphIndex; a.to = a.paragraphIndex
  }
  // Formatting passed flat instead of nested.
  if (name === 'DocxFormatRun' && (a.marks === undefined || typeof a.marks !== 'object')) {
    const m: Record<string, unknown> = {}
    for (const k of MARK_KEYS) if (a[k] !== undefined) m[k] = a[k]
    if (Object.keys(m).length) a.marks = m
  }
  if (name === 'DocxFormatParagraph' && (a.formatting === undefined || typeof a.formatting !== 'object')) {
    const f: Record<string, unknown> = {}
    for (const k of FMT_KEYS) if (a[k] !== undefined) f[k] = a[k]
    if (Object.keys(f).length) a.formatting = f
  }
  return a
}

export async function runDocxTool(cwd: string, name: string, rawArgs: any): Promise<string | null> {
  const args = normalizeArgs(name, rawArgs)
  switch (name) {
    case 'DocxOutline': return outline(cwd, args)
    case 'DocxReadText': return readText(cwd, args)
    case 'DocxReplaceText': return replaceText(cwd, args)
    case 'DocxInsertParagraph': return insertParagraph(cwd, args)
    case 'DocxDeleteParagraph': return deleteParagraph(cwd, args)
    case 'DocxFormatRun': return formatRun(cwd, args)
    case 'DocxFormatParagraph': return formatParagraph(cwd, args)
    case 'DocxApplyStyle': return applyStyle(cwd, args)
    case 'DocxInsertImage': return insertImage(cwd, args)
    case 'DocxInspect': return inspect(cwd, args)
    case 'DocxSetTabStops': return setTabStops(cwd, args)
    case 'DocxAlignColumns': return alignColumns(cwd, args)
    case 'DocxInsertTable': return insertTable(cwd, args)
    case 'DocxSetCell': return setCell(cwd, args)
    default: return null
  }
}
