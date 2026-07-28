// browser-tools.ts — the "browser" tool group: the agent drives a real page
// that renders INSIDE the IDE (a WebContentsView overlaid on the editor area),
// via playwright-core attached over CDP to the app's own debug endpoint.
// Phase 2 attaches the same way to an external Chrome/Edge debug port.
//
// Why WebContentsView and not <webview>: CDP lists webview guests as type
// "webview" and playwright's connectOverCDP only surfaces type "page" targets
// (probed empirically on Electron 33 + playwright-core 1.61) — a
// WebContentsView's webContents IS a page target, and locators/auto-waiting
// work on it directly.
//
// Element refs: public ariaSnapshot() has no ref support in 1.61, so
// BrowserSnapshot tags interactive elements with data-orqon-ref="eN" via
// page.evaluate and actions target them with locator('[data-orqon-ref=...]')
// — public API only, auto-waiting retained.

import { app, BrowserWindow, WebContentsView, clipboard } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Browser, Page } from 'playwright-core'
import { ToolSpec } from './agent-tools'

// The main bundle is ESM (see main.ts) — bring in a CJS require for lazy
// native/heavy deps.
const cjsRequire = createRequire(import.meta.url)

// ── tool specs ────────────────────────────────────────────────────

export const BROWSER_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'BrowserOpen',
    description: 'Open a URL in the IDE\'s embedded browser tab (the user watches you work). Great for testing localhost apps you are building and for reading JS-rendered pages WebFetch cannot see. Returns title + a snapshot of interactive elements. target "external" attaches to a real Chrome/Edge running with a debug port instead.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        target: { type: 'string', enum: ['ide', 'external'] },
        port: { type: 'integer', description: 'external debug port (default 9222)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'BrowserNavigate',
    description: 'Navigate the browser to another URL, or pass "back" to go back one page.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'BrowserSnapshot',
    description: 'See the current page: URL, title, headings, and every interactive element (links, buttons, inputs) numbered with a ref like [e5]. Use the refs with BrowserClick/BrowserType. Call again after the page changes — refs are re-assigned per snapshot.',
    input_schema: { type: 'object', properties: { wait_ms: { type: 'integer', description: 'wait before snapshotting (max 5000)' } } },
  },
  {
    name: 'BrowserRead',
    description: 'Read the visible text of the current page (8KB per call; pass offset to continue).',
    input_schema: { type: 'object', properties: { offset: { type: 'integer' } } },
  },
  {
    name: 'BrowserClick',
    description: 'Click the element with the given ref from the last BrowserSnapshot (e.g. "e5"). Auto-waits for the element; waits out any navigation it triggers.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'BrowserType',
    description: 'Type text into the input with the given ref from the last BrowserSnapshot. submit=true presses Enter afterwards. Escalates through several input methods automatically (including rich-text editors and React-controlled fields) and VERIFIES the text actually landed — if it returns an error, nothing was typed, so pick a different ref instead of assuming it worked. Pass text="" to clear the field.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'BrowserPressKey',
    description: 'Press a key on the page: "Enter", "Tab", "Escape", "Backspace", "ArrowDown", or a chord like "Control+a". Pass ref to focus that element first (from the last BrowserSnapshot); without ref the key goes to whatever is currently focused. Use for dropdowns, modals, and multi-step forms that BrowserClick/BrowserType cannot drive.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        ref: { type: 'string', description: 'element to focus before pressing (optional)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'BrowserScroll',
    description: 'Scroll the page: "down" | "up" (one viewport) | "top" | "bottom".',
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } }, required: ['direction'] },
  },
  {
    name: 'BrowserConsole',
    description: 'Read the last ~50 console messages and page errors of the embedded browser — use this to debug the localhost app you are testing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'BrowserScreenshot',
    description: 'Save a PNG screenshot of the current page into .orqon/browser/ in the workspace and return its path (for the user to look at — you cannot see images).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'BrowserLaunchExternal',
    description: 'Launch the user\'s real Chrome or Edge with a debugging port and a dedicated persistent profile (~/.orqon/browser-profile), so the user can browse/log in normally in that window while you assist. After it starts, call BrowserOpen with target "external" to attach. Requires user approval.',
    input_schema: {
      type: 'object',
      properties: {
        browser: { type: 'string', enum: ['chrome', 'edge'] },
        port: { type: 'integer', description: 'debug port (default 9222)' },
      },
      required: ['browser'],
    },
  },
  {
    name: 'BrowserClose',
    description: 'Close the embedded browser tab (or detach from the external browser). Sessions/cookies persist for next time.',
    input_schema: { type: 'object', properties: {} },
  },
]
export const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOL_SPECS.map((s) => s.name))

// ── host wiring (set once from main.ts) ──────────────────────────

interface BrowserHost {
  getWindow: () => BrowserWindow | null
  showTab: () => void // ask the renderer to open/focus the browser tab
  urlChanged: (url: string, title: string) => void
}
let host: BrowserHost | null = null
export function initBrowserTools(h: BrowserHost): void { host = h }

// ── embedded view lifecycle ──────────────────────────────────────

let view: WebContentsView | null = null
let shotCounter = 0
const consoleBuf: string[] = []
const CONSOLE_CAP = 60

function pushConsole(line: string): void {
  consoleBuf.push(line.length > 400 ? line.slice(0, 400) + '…' : line)
  if (consoleBuf.length > CONSOLE_CAP) consoleBuf.splice(0, consoleBuf.length - CONSOLE_CAP)
}

// A standard Chrome UA — the default one advertises Electron/orqon, which
// anti-bot heuristics flag immediately.
function chromeUA(): string {
  const chrome = process.versions.chrome?.split('.')[0] ?? '130'
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`
}

function ensureView(): WebContentsView {
  const win = host?.getWindow()
  if (!win || win.isDestroyed()) throw new Error('main window unavailable')
  if (view && !view.webContents.isDestroyed()) return view
  view = new WebContentsView({
    webPreferences: { partition: 'persist:orqon-agent-browser', contextIsolation: true, nodeIntegration: false },
  })
  view.webContents.setUserAgent(chromeUA())
  // Popups/target=_blank navigate the same view instead of opening windows.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void view?.webContents.loadURL(url)
    return { action: 'deny' }
  })
  view.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lv = ['debug', 'log', 'warn', 'error'][level] ?? String(level)
    pushConsole(`[${lv}] ${message}${sourceId ? ` (${sourceId.split('/').pop()}:${line})` : ''}`)
  })
  view.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (code === -3) return // aborted (normal during redirects)
    pushConsole(`[pageerror] failed to load ${url}: ${desc} (${code})`)
    if (isMainFrame && view && !view.webContents.isDestroyed()) {
      void view.webContents.loadURL(errorPage(url, `${desc} (${code})`))
    }
  })
  const report = () => {
    if (view && !view.webContents.isDestroyed()) {
      host?.urlChanged(view.webContents.getURL(), view.webContents.getTitle())
    }
  }
  view.webContents.on('did-navigate', report)
  view.webContents.on('did-navigate-in-page', report)
  view.webContents.on('page-title-updated', report)
  view.setVisible(false)
  view.setBounds({ x: 0, y: 0, width: 1024, height: 700 })
  win.contentView.addChildView(view)
  return view
}

// Renderer-driven placement: the browser tab's placeholder rect (CSS px),
// scaled by the window zoom factor into DIP coordinates.
export function browserSetBounds(rect: { x: number; y: number; width: number; height: number }): void {
  const win = host?.getWindow()
  if (!view || view.webContents.isDestroyed() || !win) return
  const z = win.webContents.getZoomFactor()
  view.setBounds({
    x: Math.round(rect.x * z),
    y: Math.round(rect.y * z),
    width: Math.max(1, Math.round(rect.width * z)),
    height: Math.max(1, Math.round(rect.height * z)),
  })
}

export function browserSetVisible(visible: boolean): void {
  if (view && !view.webContents.isDestroyed()) view.setVisible(visible)
}

// Address-bar navigation typed by the USER (not the agent).
export function browserUserNavigate(url: string): void {
  if (!view || view.webContents.isDestroyed()) return
  void view.webContents.loadURL(normalizeUrl(url))
}

export function closeBrowserView(): void {
  idePage = null
  if (view) {
    const win = host?.getWindow()
    try { win?.contentView.removeChildView(view) } catch { /* window gone */ }
    try { view.webContents.close() } catch { /* already closed */ }
    view = null
  }
}

// ── playwright attach ────────────────────────────────────────────

type Playwright = typeof import('playwright-core')
let pwBrowser: Browser | null = null // connection to our own app
let idePage: Page | null = null
let extBrowser: Browser | null = null
let extPage: Page | null = null

function playwright(): Playwright {
  // Lazy so playwright-core only loads when a browser tool actually runs.
  return cjsRequire('playwright-core') as Playwright
}

// The app runs with --remote-debugging-port=0; Chromium writes the actual
// port to DevToolsActivePort in userData once ready.
function ownCdpPort(): number {
  const p = path.join(app.getPath('userData'), 'DevToolsActivePort')
  const port = parseInt(fs.readFileSync(p, 'utf8').split('\n')[0].trim(), 10)
  if (!port) throw new Error('CDP port unavailable (DevToolsActivePort unreadable)')
  return port
}

// Attach playwright to the embedded view. The view is first pointed at a
// unique token URL so we can pick OUR page out of the target list (in dev the
// IDE's own renderer is also a localhost page — URL matching alone is unsafe).
async function attachIdePage(): Promise<Page> {
  if (idePage && !idePage.isClosed()) return idePage
  const v = ensureView()
  host?.showTab()
  const token = `about:blank#orqon-agent-${Math.random().toString(36).slice(2)}`
  await v.webContents.loadURL(token)
  if (!pwBrowser || !pwBrowser.isConnected()) {
    pwBrowser = await playwright().chromium.connectOverCDP(`http://127.0.0.1:${ownCdpPort()}`)
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const ctx of pwBrowser.contexts()) {
      for (const pg of ctx.pages()) {
        if (pg.url() === token) { idePage = pg; return pg }
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('could not attach playwright to the embedded browser view')
}

// Attach to a real Chrome/Edge started with --remote-debugging-port. Opens a
// NEW tab for the agent instead of hijacking whatever the user is reading.
async function attachExternal(port: number): Promise<Page> {
  if (extPage && !extPage.isClosed()) return extPage
  if (!extBrowser || !extBrowser.isConnected()) {
    try {
      extBrowser = await playwright().chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      throw new Error(
        `no browser reachable on debug port ${port}. Start one first, e.g.\n` +
        `  open -na "Google Chrome" --args --remote-debugging-port=${port} --user-data-dir=$HOME/.orqon/browser-profile/chrome\n` +
        `  open -na "Microsoft Edge" --args --remote-debugging-port=${port} --user-data-dir=$HOME/.orqon/browser-profile/edge`,
      )
    }
  }
  const ctx = extBrowser.contexts()[0]
  if (!ctx) throw new Error('external browser has no context')
  extPage = await ctx.newPage()
  extPage.on('console', (m) => pushConsole(`[ext:${m.type()}] ${m.text()}`))
  extPage.on('pageerror', (e) => pushConsole(`[ext:pageerror] ${e.message}`))
  return extPage
}

let activePage: (() => Page | null) = () => null
function currentPage(): Page {
  const pg = activePage()
  if (!pg || pg.isClosed()) throw new Error('no browser open — call BrowserOpen first')
  return pg
}

// ── gate info for the approve-once check in ide-agent ────────────

function isLocalUrl(u: string): boolean {
  try {
    const h = new URL(normalizeUrl(u)).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
  } catch { return false }
}

// Is this call confined to localhost? Open/Navigate are judged by their url
// argument; everything else by the page the agent is currently on.
export function browserGateInfo(name: string, args: Record<string, unknown>): { local: boolean; detail: string } {
  if (name === 'BrowserLaunchExternal') {
    return { local: false, detail: `launch ${args?.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} with a debugging port (dedicated profile)` }
  }
  if (name === 'BrowserOpen' || name === 'BrowserNavigate') {
    const url = String(args?.url ?? '')
    if (url === 'back') return { local: true, detail: 'go back' }
    return { local: isLocalUrl(url), detail: `${name}: ${url}` }
  }
  const pg = activePage()
  const cur = pg && !pg.isClosed() ? pg.url() : ''
  // Read-only tools and anything on a localhost page stay ungated.
  const readonly = ['BrowserSnapshot', 'BrowserRead', 'BrowserScroll', 'BrowserConsole', 'BrowserScreenshot', 'BrowserClose']
  if (readonly.includes(name)) return { local: true, detail: name }
  return { local: cur ? isLocalUrl(cur) : true, detail: `${name} on ${cur || '(no page)'}` }
}

// ── helpers ──────────────────────────────────────────────────────

function normalizeUrl(u: string): string {
  const s = u.trim()
  if (/^(https?|file|about|data):/i.test(s)) return s
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`
  // Bare words ("github") or phrases aren't hostnames — search instead of
  // producing a dead https://github/ that fails to a blank white page.
  if (/\s/.test(s) || !s.includes('.')) return `https://www.google.com/search?q=${encodeURIComponent(s)}`
  return `https://${s}`
}

// A dead navigation (bad DNS, refused connection) leaves Chromium on a bare
// white page — swap in a small dark error page that says what happened.
function errorPage(url: string, desc: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#09090b;color:#a1a1aa;` +
    `font:13px ui-monospace,monospace"><div style="text-align:center;max-width:520px;padding:24px">` +
    `<div style="font-size:28px;margin-bottom:12px">⚠︎</div>` +
    `<div style="color:#e4e4e7;margin-bottom:6px">Couldn't load ${esc(url)}</div>` +
    `<div>${esc(desc)}</div></div></body>`,
  )
}

const CHALLENGE_RE = /captcha|cloudflare|turnstile|verify you are (a )?human|just a moment|access denied/i
function challengeHint(text: string): string {
  return CHALLENGE_RE.test(text)
    ? '\n\n⚠ This page appears to be showing a CAPTCHA / verification challenge. Do NOT retry — ask the user to complete it by hand in the browser tab, then continue.'
    : ''
}

// Tag interactive elements with data-orqon-ref and return a text map of the
// page. Runs inside the page; refs are re-assigned on every snapshot.
const SNAPSHOT_JS = `(() => {
  const out = []
  let n = 0
  const seen = new Set()
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.value || '').trim().replace(/\\s+/g, ' ')
    return t.slice(0, 80)
  }
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }
  for (const h of document.querySelectorAll('h1,h2,h3')) {
    if (vis(h)) out.push('# '.repeat(1) + h.tagName.toLowerCase() + ': ' + (h.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 100))
    if (out.length > 250) break
  }
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox],[role=checkbox],[role=combobox],[role=menuitem],[role=tab],[onclick],[contenteditable=true]'
  for (const el of document.querySelectorAll(sel)) {
    if (out.length > 250) { out.push('… (more elements not shown — scroll or read)'); break }
    if (seen.has(el) || !vis(el)) continue
    seen.add(el)
    n++
    const ref = 'e' + n
    el.setAttribute('data-orqon-ref', ref)
    const tag = el.tagName.toLowerCase()
    const kind = tag === 'a' ? 'link' : tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag
    let line = '[' + ref + '] ' + kind + ' "' + label(el) + '"'
    if (tag === 'a' && el.getAttribute('href')) line += ' → ' + el.getAttribute('href').slice(0, 80)
    if ((tag === 'input' || tag === 'textarea') && el.value) line += ' (value: "' + String(el.value).slice(0, 40) + '")'
    out.push(line)
  }
  return out.join('\\n')
})()`

// Wait for the page to actually settle before snapshotting — 'load' fires
// before SPA content hydrates, which used to hand the model a near-empty map
// and force it to guess. Best-effort: every wait is optional (many sites never
// reach networkidle) and capped so it never hangs.
async function settle(pg: Page): Promise<void> {
  try { await pg.waitForLoadState('domcontentloaded', { timeout: 8000 }) } catch { /* already past */ }
  try { await pg.waitForLoadState('networkidle', { timeout: 2500 }) } catch { /* SPA that never idles */ }
  await pg.waitForTimeout(300) // let late paint / client hydration flush
}

// `after` labels a snapshot produced automatically after an action, so the
// model treats it as ground truth for its NEXT step instead of re-deriving.
async function snapshot(pg: Page, opts?: { waitMs?: number; settleFirst?: boolean; after?: string }): Promise<string> {
  if (opts?.settleFirst) await settle(pg)
  if (opts?.waitMs) await pg.waitForTimeout(Math.min(Math.max(opts.waitMs, 0), 5000))
  const body = String(await pg.evaluate(SNAPSHOT_JS))
  const banner = opts?.after
    ? `== CURRENT PAGE (${opts.after}) — use these refs for your next action, do not guess ==`
    : '== CURRENT PAGE — use these refs for your next action, do not guess =='
  const head = `${banner}\nURL: ${pg.url()}\nTitle: ${await pg.title()}`
  const text = `${head}\n${body || '(no interactive elements found — try BrowserScroll or BrowserRead)'}`
  // Cap generously: a truncated element list is the main cause of the model
  // "guessing" a target it never saw (busy pages like GitHub list 100+
  // elements). ~10k chars keeps a full typical page while bounding tokens.
  const LIMIT = 10_000
  const capped = text.length > LIMIT
    ? text.slice(0, LIMIT) + `\n… (element list truncated — ${body.length - LIMIT}+ chars more; if your target is not listed above, BrowserRead the page or ask the user to narrow the view rather than guessing)`
    : text
  return capped + challengeHint(capped)
}

function refLocator(pg: Page, ref: string) {
  // Snapshot tags elements as data-orqon-ref="eN" and shows them as [eN].
  // Models often pass just the number ("1") or "e1" — normalize both to "eN".
  const digits = String(ref).replace(/\D/g, '')
  const clean = digits ? `e${digits}` : String(ref).trim()
  return pg.locator(`[data-orqon-ref="${clean}"]`).first()
}

// A ref only exists until the next snapshot re-tags the page. If the model
// aims at a stale ref, hand back the current page instead of a bare timeout so
// it can re-pick without a wasted turn.
async function ensureRef(pg: Page, ref: string): Promise<string | null> {
  const loc = refLocator(pg, ref)
  if (await loc.count() > 0) return null
  const fresh = await snapshot(pg, { after: `ref ${ref} no longer exists` })
  return `error: element ${ref} is not on the current page (it changed since the last snapshot).\n${fresh}`
}

// ── virtual cursor ───────────────────────────────────────────────
// A purely-visual dark/gray pointer injected into the page so the user can
// SEE what the agent is about to click/type into. pointer-events:none — the
// real interaction is playwright's. Re-injected lazily (navigations wipe it),
// glides to the target, pulses on click, fades out when idle.
const CURSOR_JS = `(() => {
  let c = document.getElementById('__orqon_cursor')
  if (!c) {
    c = document.createElement('div')
    c.id = '__orqon_cursor'
    c.style.cssText = 'position:fixed;left:40px;top:40px;z-index:2147483647;pointer-events:none;' +
      'width:22px;height:22px;opacity:0;transition:left .38s cubic-bezier(.3,.7,.3,1),top .38s cubic-bezier(.3,.7,.3,1),opacity .3s'
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))">' +
      '<path d="M5 3 L5 17 L9 13.5 L11.5 19 L14 18 L11.5 12.5 L17 12.5 Z" fill="#27272a" stroke="#a1a1aa" stroke-width="1.2"/></svg>'
    document.documentElement.appendChild(c)
  }
  window.__orqonCursor = (x, y, click) => {
    c.style.opacity = '1'
    c.style.left = x + 'px'
    c.style.top = y + 'px'
    clearTimeout(window.__orqonCursorFade)
    window.__orqonCursorFade = setTimeout(() => { c.style.opacity = '0' }, 2200)
    if (click) setTimeout(() => {
      const r = document.createElement('div')
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:30px;height:30px;' +
        'left:' + (x - 12) + 'px;top:' + (y - 12) + 'px;border:2px solid #a1a1aa;border-radius:50%;' +
        'animation:none;opacity:.85;transform:scale(.4);transition:transform .45s ease-out,opacity .45s ease-out'
      document.documentElement.appendChild(r)
      requestAnimationFrame(() => { r.style.transform = 'scale(1.5)'; r.style.opacity = '0' })
      setTimeout(() => r.remove(), 600)
    }, 400)
  }
  return true
})()`

// Glide the virtual cursor to the locator's center; returns after the travel
// animation so the real click lands right when the pointer "arrives".
async function pointAt(pg: Page, loc: ReturnType<Page['locator']>, click: boolean): Promise<void> {
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 })
    const box = await loc.boundingBox()
    if (!box) return
    const x = box.x + box.width / 2
    const y = box.y + Math.min(box.height / 2, 200)
    await pg.evaluate(CURSOR_JS)
    await pg.evaluate(`window.__orqonCursor(${Math.round(x)}, ${Math.round(y)}, ${click})`)
    await pg.waitForTimeout(click ? 620 : 450) // travel + (click) pulse start
  } catch { /* cursor is decoration only — never block the real action */ }
}

// ── typing: escalation ladder ────────────────────────────────────
// fill() alone loses to contenteditable editors (Draft/Slate/ProseMirror/
// CodeMirror), React-controlled inputs behind a custom widget, and IME fields.
// The previous code fell back exactly once and swallowed BOTH failures with
// `.catch(() => {})`, so a field that never received a character still returned
// an ordinary snapshot and the agent moved on believing it had typed. Every
// rung below is verified by reading the value back, and the tool now fails
// loudly instead of lying.

// What the field currently holds.
//
// Code editors are the trap here. Monaco and CodeMirror put a 1-line proxy
// <textarea> over the document for IME/clipboard; a snapshot ref lands on THAT,
// and its .value is a window around the caret, never the document. Reading it
// makes every verification fail, and a ladder that escalates on failure then
// writes the text again — measured on LeetCode: the proxy read 1001 chars while
// the real model held 1510, and the solution went in several times over, each
// copy spliced into the middle of the last.
async function readFieldText(loc: ReturnType<Page['locator']>): Promise<string> {
  try {
    return String(await loc.evaluate((el: any) => {
      // Follow FOCUS, not the ref. A snapshot ref frequently lands on a wrapper
      // beside the editor rather than on its proxy textarea — keystrokes still
      // reach the focused editor, so describing the ref element describes the
      // wrong thing entirely. That mismatch is what produced a staircase
      // (suppression skipped because the ref was not "in" an editor) stacked
      // under two more copies (clear aimed at an element that ignored it).
      const host = document.activeElement?.closest?.('.monaco-editor')
        ?? el.closest?.('.monaco-editor')
      if (host) {
        // Prefer the real model: .view-lines is virtualized, so it only holds
        // the lines currently scrolled into view.
        try {
          const models = (window as any).monaco?.editor?.getModels?.() ?? []
          if (models.length) {
            return models.map((m: any) => m.getValue()).sort((a: string, b: string) => b.length - a.length)[0]
          }
        } catch { /* monaco not exposed on this page */ }
        return host.querySelector('.view-lines')?.innerText ?? ''
      }
      const cm = document.activeElement?.closest?.('.cm-editor') ?? el.closest?.('.cm-editor')
      if (cm) return cm.querySelector('.cm-content')?.innerText ?? ''
      return el.value ?? el.textContent ?? ''
    }))
  } catch {
    return '' // detached / unreadable — treat as "nothing landed"
  }
}

// Empty the field in a way the EDITOR understands. loc.clear() sets the DOM
// element's value, which on a Monaco proxy textarea leaves the document
// untouched — so the next rung appends instead of replacing.
async function clearField(pg: Page, loc: ReturnType<Page['locator']>): Promise<void> {
  try {
    await loc.click({ force: true, timeout: 2000 })
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await pg.keyboard.press(`${mod}+a`)
    await pg.keyboard.press('Delete')
    // Select-all only empties the thing that has focus. When the ref named a
    // wrapper the keys went nowhere, the field stayed full, and the next rung
    // appended to it. If an editor holds focus, empty it through its own model
    // as well, so "cleared" means cleared regardless of what the ref pointed at.
    await loc.evaluate(() => {
      const host = document.activeElement?.closest?.('.monaco-editor')
      if (!host) return
      const editors = (window as any).monaco?.editor?.getEditors?.() ?? []
      const ed = editors.find((e: any) => host.contains(e.getDomNode?.()))
      if (ed?.getModel?.()?.getValue?.()) ed.getModel().setValue('')
    }).catch(() => { /* no monaco on this page */ })
  } catch { /* best effort — the verification below is the real guard */ }
}

// Did `want` actually land?
//
// The field is cleared before every rung, so a correct write leaves EXACTLY the
// text and nothing else. Substring matching is what let this lie: an append
// still contains the text, so a buffer holding the solution twice reported
// "typed (via paste)" — and a Monaco staircase, which contains every character
// of the original with extra indentation, passed a whitespace-insensitive
// check too. Equality is the only test that separates "wrote it" from "wrote it
// again underneath the last one".
//
// `strict` (multi-line, i.e. code) demands equality. Single-line fields get one
// concession: widgets that reformat as you type — phone numbers, dates,
// currency — legitimately hold something other than what was typed, so those
// match loosely, but only while the field has not grown beyond the input, which
// is what an append looks like.
function textLanded(got: string, want: string, strict: boolean): boolean {
  if (want === '') return got.trim() === ''
  if (got.trim() === want.trim()) return true
  if (strict) return false
  const squash = (s: string) => s.replace(/\s+/g, '')
  const g = squash(got)
  const w = squash(want)
  return g.includes(w) && g.length <= w.length * 1.3
}

// Is this page our embedded view (as opposed to an attached external browser)?
// Only the embedded one can be driven through Electron's own webContents API.
function onIdeView(pg: Page): boolean {
  return pg === idePage && !!view && !view.webContents.isDestroyed()
}

// Rung 4 — insert BELOW the JS layer, at the browser's own input pipeline.
// Embedded view: Electron's webContents API. External Chrome/Edge: a raw CDP
// session. Neither emits keydown/keyup — they place text into whatever holds
// focus, which is what reaches editors the Playwright rungs cannot touch.
async function lowLevelInsert(pg: Page, text: string): Promise<void> {
  if (onIdeView(pg)) {
    view!.webContents.focus() // sendInputEvent/insertText need a focused contents
    await view!.webContents.insertText(text)
    return
  }
  const cdp = await pg.context().newCDPSession(pg)
  try {
    await cdp.send('Input.insertText', { text })
  } finally {
    await cdp.detach().catch(() => { /* session dies with the page anyway */ })
  }
}

// Rung 4b — synthesize one `char` event per character. Slower, but it is the
// only rung that reaches widgets listening for keypress/textInput rather than
// for input. Capped: this costs a round-trip per character.
const CHAR_RUNG_MAX = 200
async function lowLevelChars(pg: Page, text: string): Promise<void> {
  if (text.length > CHAR_RUNG_MAX) throw new Error('too long for char-by-char injection')
  if (onIdeView(pg)) {
    view!.webContents.focus()
    for (const ch of text) {
      view!.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      await pg.waitForTimeout(4)
    }
    return
  }
  const cdp = await pg.context().newCDPSession(pg)
  try {
    for (const ch of text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
  } finally {
    await cdp.detach().catch(() => { /* ignore */ })
  }
}

// Rung: system clipboard + a real paste keystroke.
//
// This is the ONLY path that puts multi-line code into a code editor verbatim.
// Every other rung reaches the document through the editor's type handler,
// which re-runs auto-indent on each newline — measured on LeetCode's Monaco,
// `type` turned a 6-line Python solution into a widening staircase and
// `insertText` doubled every indent level, while a real paste landed the same
// 185 characters byte-for-byte. A synthesized ClipboardEvent does NOT work
// (Monaco ignores untrusted paste); it has to be the OS clipboard.
//
// The user's clipboard is theirs, so it is restored afterwards.
async function clipboardPaste(pg: Page, loc: ReturnType<Page['locator']>, text: string): Promise<void> {
  const previous = clipboard.readText()
  try {
    clipboard.writeText(text)
    await loc.click({ force: true, timeout: 2500 }).catch(() => { /* focus best effort */ })
    await pg.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v')
    await pg.waitForTimeout(250) // let the editor apply the paste before we restore
  } finally {
    clipboard.writeText(previous)
  }
}

// Per-character delay for the visible typing rung. Slow enough to read, fast
// enough that a full solution lands in a few seconds (~150 chars ≈ 3.5s).
const TYPE_DELAY_MS = 12

// Options a code editor applies to TYPED input that rewrite what was typed:
// auto-indent re-indents every newline (a 6-line Python function becomes a
// widening staircase), auto-closing pairs inject characters that were never
// sent, and Enter can accept a suggestion instead of breaking the line.
const TYPING_HOSTILE_OPTIONS = {
  autoIndent: 'none', autoClosingBrackets: 'never', autoClosingQuotes: 'never',
  autoSurround: 'never', formatOnType: false, acceptSuggestionOnEnter: 'off',
  quickSuggestions: false, tabCompletion: 'off',
} as const

// Rung: type character by character, visibly.
//
// The point of driving a real browser is that the user can watch the work
// happen; a paste appears instantly and shows nothing. So this stays the
// preferred path for code, and the editor's rewriting is switched off for the
// duration rather than fought afterwards — verified on LeetCode's Monaco, where
// 153 characters typed at 12ms landed byte-for-byte with indentation intact,
// against a staircase when the same keystrokes ran with auto-indent on.
// Editors we cannot reach through the monaco API just get plain typing; the
// verification below catches it if that comes out wrong.
async function typewriter(pg: Page, loc: ReturnType<Page['locator']>, text: string): Promise<void> {
  // Focus FIRST, then resolve the editor from what actually holds focus — the
  // ref may name a wrapper, and suppressing options on the wrong instance (or
  // on none) is what let auto-indent through.
  await loc.click({ force: true, timeout: 2500 }).catch(() => { /* focus best effort */ })
  const suppressed = await loc.evaluate((el: any, opts: Record<string, unknown>) => {
    const host = document.activeElement?.closest?.('.monaco-editor') ?? el.closest?.('.monaco-editor')
    if (!host) return false
    const editors = (window as any).monaco?.editor?.getEditors?.() ?? []
    const ed = editors.find((e: any) => host.contains(e.getDomNode?.())) ?? editors[0]
    if (!ed?.updateOptions) return false
    const raw = ed.getRawOptions?.() ?? {}
    const prev: Record<string, unknown> = {}
    for (const k of Object.keys(opts)) prev[k] = raw[k]
    ;(window as any).__orqonTypingOpts = prev
    ed.updateOptions(opts)
    return true
  }, { ...TYPING_HOSTILE_OPTIONS }).catch(() => false)

  try {
    await pg.keyboard.type(text, { delay: TYPE_DELAY_MS })
  } finally {
    if (suppressed) {
      await loc.evaluate((el: any) => {
        const host = document.activeElement?.closest?.('.monaco-editor') ?? el.closest?.('.monaco-editor')
        const editors = (window as any).monaco?.editor?.getEditors?.() ?? []
        const ed = editors.find((e: any) => host?.contains(e.getDomNode?.())) ?? editors[0]
        const prev = (window as any).__orqonTypingOpts
        if (ed?.updateOptions && prev) ed.updateOptions(prev)
        delete (window as any).__orqonTypingOpts
      }).catch(() => { /* the page navigated away — options die with it */ })
    }
  }
}

// Walk the rungs until the text is verifiably in the field. Returns which rung
// worked (null = none did) plus everything tried, for the error message.
async function typeIntoField(
  pg: Page,
  loc: ReturnType<Page['locator']>,
  text: string,
): Promise<{ via: string | null; tried: string[]; dirtied?: boolean }> {
  // Focus is best-effort on the lower rungs: they insert into whatever is
  // focused, so a click that misses is survivable but worth attempting.
  const focus = () => loc.click({ force: true, timeout: 2500 }).catch(() => { /* best effort */ })
  const external = !onIdeView(pg)
  // Key events run the editor's own input handling: Monaco auto-indents after
  // every newline (and again after a Python `:`), so typing multi-line text
  // key-by-key produces a widening staircase. The atomic rungs insert the text
  // as one edit and are unaffected, so they go first once text spans lines.
  const multiline = text.includes('\n')

  const fill: [string, () => Promise<void>] =
    ['fill', async () => { await loc.fill(text, { timeout: 4000 }) }]
  const type: [string, () => Promise<void>] =
    ['type', async () => { await focus(); await pg.keyboard.type(text, { delay: 12 }) }]
  const insertText: [string, () => Promise<void>] =
    ['insertText', async () => { await focus(); await pg.keyboard.insertText(text) }]
  // Below JS. On an EXTERNAL browser this is the same CDP call insertText
  // already made, so it is dropped there and escalation goes to char events.
  const lowlevel: [string, () => Promise<void>][] = external
    ? []
    : [['lowlevel', async () => { await focus(); await lowLevelInsert(pg, text) }]]
  const chars: [string, () => Promise<void>] =
    ['chars', async () => { await focus(); await lowLevelChars(pg, text) }]
  // Last resort: write through the native setter React patched over, then
  // announce it. The most synthetic rung, so it goes last.
  const nativeSet: [string, () => Promise<void>] = ['nativeSet', async () => {
    await loc.evaluate((el: any, t: string) => {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      if (set && 'value' in el) set.call(el, t)
      else el.textContent = t
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, text)
  }]

  const paste: [string, () => Promise<void>] =
    ['paste', async () => { await clipboardPaste(pg, loc, text) }]
  const typewriterRung: [string, () => Promise<void>] =
    ['typewriter', async () => { await typewriter(pg, loc, text) }]

  // Multi-line leads with the visible typing rung — watching the agent write is
  // the reason for driving a real browser at all — and falls back to paste,
  // which is instant but correct anywhere. Single-line text is not affected by
  // auto-indent, so it keeps the cheap rungs first and only borrows the
  // clipboard late.
  const rungs: [string, () => Promise<void>][] = multiline
    ? [typewriterRung, paste, fill, insertText, ...lowlevel, chars, nativeSet]
    : [fill, type, insertText, ...lowlevel, chars, paste, nativeSet]

  const tried: string[] = []
  for (const [name, run] of rungs) {
    // Start every rung from a known-empty field, through the editor rather than
    // through the DOM element, so a rung that partially wrote cannot leave a
    // prefix for the next one to append to.
    await clearField(pg, loc)
    const before = await readFieldText(loc)
    try { await run() } catch { /* rung failed outright — escalate */ }
    tried.push(name)
    const after = await readFieldText(loc)
    if (textLanded(after, text, multiline)) return { via: name, tried }
    // The rung wrote something wrong. Escalating on top of it is how six rungs
    // put a LeetCode solution into Monaco six times, each spliced into the
    // middle of the last — so the leftovers have to go before anything else
    // runs. If they will not go, the field is beyond our control: stop rather
    // than pile on.
    if (after !== before && after.trim() !== '') {
      await clearField(pg, loc)
      if ((await readFieldText(loc)).trim() !== '') return { via: null, tried, dirtied: true }
    }
  }
  return { via: null, tried, dirtied: false }
}

// ── external browser launch (phase 2) ───────────────────────────

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch { return false }
}

// Chrome/Edge 136+ refuse a debug port on the DEFAULT profile, so external
// browsers run on a dedicated persistent profile the user logs into once.
function launchExternalBrowser(brand: 'chrome' | 'edge', port: number): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = cjsRequire('node:child_process') as typeof import('node:child_process')
  const profile = path.join(app.getPath('home'), '.orqon', 'browser-profile', brand)
  fs.mkdirSync(profile, { recursive: true })
  const flags = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check']
  if (process.platform === 'darwin') {
    const appName = brand === 'edge' ? 'Microsoft Edge' : 'Google Chrome'
    const installed = fs.existsSync(`/Applications/${appName}.app`) ||
      fs.existsSync(path.join(app.getPath('home'), 'Applications', `${appName}.app`))
    if (!installed) throw new Error(`${appName} is not installed in /Applications`)
    spawn('open', ['-na', appName, '--args', ...flags], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (process.platform === 'win32') {
    const rel = brand === 'edge' ? 'Microsoft\\Edge\\Application\\msedge.exe' : 'Google\\Chrome\\Application\\chrome.exe'
    const candidates = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map((base) => path.join(base as string, rel))
    const exe = candidates.find((p) => fs.existsSync(p))
    if (!exe) throw new Error(`${brand} executable not found (looked in Program Files / LocalAppData)`)
    spawn(exe, flags, { detached: true, stdio: 'ignore' }).unref()
    return
  }
  // linux: rely on PATH
  const bin = brand === 'edge' ? 'microsoft-edge' : 'google-chrome'
  spawn(bin, flags, { detached: true, stdio: 'ignore' }).unref()
}

// ── dispatcher ───────────────────────────────────────────────────

export async function runBrowserTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { workspaceRoot: string },
): Promise<string> {
  switch (name) {
    case 'BrowserOpen': {
      const url = normalizeUrl(String(args.url ?? ''))
      if (!/^https?:/i.test(url) && !url.startsWith('about:')) return `error: unsupported URL ${url}`
      const external = args.target === 'external'
      const pg = external ? await attachExternal(Number(args.port) || 9222) : await attachIdePage()
      activePage = () => (external ? extPage : idePage)
      await pg.goto(url, { waitUntil: 'load', timeout: 25_000 }).catch((e) => {
        throw new Error(`navigation failed: ${e?.message || e}`)
      })
      return snapshot(pg, { settleFirst: true, after: 'opened' })
    }
    case 'BrowserNavigate': {
      const pg = currentPage()
      const url = String(args.url ?? '')
      if (url === 'back') await pg.goBack({ timeout: 15_000 })
      else await pg.goto(normalizeUrl(url), { waitUntil: 'load', timeout: 25_000 })
      return snapshot(pg, { settleFirst: true, after: 'navigated' })
    }
    case 'BrowserSnapshot':
      return snapshot(currentPage(), { waitMs: Number(args.wait_ms) || 0, settleFirst: true })
    case 'BrowserRead': {
      const pg = currentPage()
      const text = String(await pg.evaluate('document.body ? document.body.innerText : ""'))
      const off = Math.max(0, Number(args.offset) || 0)
      // Scroll the page along with the reading position so the user can watch
      // the agent read instead of it slurping text invisibly.
      const frac = text.length > 0 ? Math.min(off / text.length, 1) : 0
      await pg.evaluate(
        `window.scrollTo({ top: ${frac.toFixed(4)} * Math.max(0, document.body.scrollHeight - window.innerHeight), behavior: 'smooth' })`,
      ).catch(() => { /* decoration only */ })
      const slice = text.slice(off, off + 8000)
      const more = off + 8000 < text.length ? `\n… (${text.length - off - 8000} more chars — call again with offset=${off + 8000})` : ''
      return `URL: ${pg.url()}\n${slice}${more}` + challengeHint(slice)
    }
    case 'BrowserClick': {
      const pg = currentPage()
      const stale = await ensureRef(pg, String(args.ref))
      if (stale) return stale
      const loc = refLocator(pg, String(args.ref))
      const urlBefore = pg.url()
      await pointAt(pg, loc, true) // glide the virtual cursor + pulse
      let clickErr: unknown = null
      try {
        // Short timeout: complex elements (aria-haspopup, overlays) can hang
        // the actionability wait — fall through to a forced click fast.
        await loc.click({ timeout: 4000 })
      } catch (e1) {
        clickErr = e1
        try {
          // force: skip the actionability checks that stalled (intercepting
          // overlay, or the node detaching mid-navigation) but keep a real
          // trusted mouse click.
          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
          await loc.click({ force: true, timeout: 3000 })
          clickErr = null
        } catch (e2) {
          clickErr = e2
          // Last resort: synthetic in-page click (fires even if covered).
          try { await loc.dispatchEvent('click'); clickErr = null } catch { /* keep e2 */ }
        }
      }
      // A click may navigate OR just open an overlay — wait for either to settle.
      await pg.waitForLoadState('load', { timeout: 8000 }).catch(() => { /* overlay, no nav */ })
      const navved = pg.url() !== urlBefore
      // The click likely WORKED even if playwright threw: the element was torn
      // down by the very navigation it triggered. Detect that and report the
      // new page so the agent doesn't think it failed and re-navigate by hand.
      if (clickErr && !navved) {
        const snap = await snapshot(pg, { after: 'click may not have registered' })
        return `error: could not click ${args.ref} (${String((clickErr as any)?.message || clickErr).slice(0, 120)}) — it may be covered, disabled, or off-screen. Current page below; pick another ref or scroll.\n${snap}`
      }
      return snapshot(pg, { settleFirst: true, after: navved ? `clicked → navigated to ${pg.url()}` : 'after click' })
    }
    case 'BrowserType': {
      const pg = currentPage()
      const stale = await ensureRef(pg, String(args.ref))
      if (stale) return stale
      const loc = refLocator(pg, String(args.ref))
      const text = String(args.text ?? '')
      const urlBefore = pg.url()
      await pointAt(pg, loc, false) // glide the virtual cursor to the field
      const { via, tried, dirtied } = await typeIntoField(pg, loc, text)
      if (!via) {
        const snap = await snapshot(pg, {
          after: dirtied ? `typing into ${args.ref} FAILED — the field was left modified` : `typing into ${args.ref} FAILED`,
        })
        return dirtied
          // Stopped on purpose after the first rung that changed the field:
          // retrying would stack another copy on top. The field is NOT clean,
          // so say so — the agent must inspect before writing again.
          ? `error: typing into ${args.ref} did not produce the expected content, and the field HAS been ` +
            `modified (tried: ${tried.join(' → ')}, then stopped so a retry could not stack a second copy). ` +
            'Do NOT simply call BrowserType again — first read the field back to see what is actually in it, ' +
            `clear it, and only then retry.\n${snap}`
          : `error: could not type into ${args.ref}; every input method failed (tried: ${tried.join(' → ')}) ` +
            'and the field is unchanged. It may be disabled/readonly, a custom editor that ignores injected ' +
            'input, or the ref may point at a wrapper rather than the real input. Pick a different ref from ' +
            `the page below, or ask the user to type it by hand.\n${snap}`
      }
      if (args.submit) {
        await loc.press('Enter').catch(() => { /* element may detach on submit */ })
        await pg.waitForLoadState('load', { timeout: 10_000 }).catch(() => { /* SPA — no full navigation */ })
      }
      const navved = pg.url() !== urlBefore
      // Name the rung only when it wasn't the ordinary one — a note on every
      // single type() call would be noise in the transcript.
      const how = via === 'fill' ? '' : ` (via ${via})`
      return snapshot(pg, {
        settleFirst: true,
        // The rung is named on every path, navigation included — dropping it
        // when a submit navigated hid exactly the fact needed to tell whether
        // the text was typed or pasted.
        after: navved
          ? `submitted${how} → navigated to ${pg.url()}`
          : args.submit ? `after submit${how}` : `typed${how}`,
      })
    }
    case 'BrowserPressKey': {
      const pg = currentPage()
      const key = String(args.key ?? '').trim()
      if (!key) return 'error: key is required (e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a")'
      const urlBefore = pg.url()
      if (args.ref) {
        const stale = await ensureRef(pg, String(args.ref))
        if (stale) return stale
        const loc = refLocator(pg, String(args.ref))
        await pointAt(pg, loc, false)
        try {
          await loc.press(key, { timeout: 4000 })
        } catch (e: any) {
          return `error: could not press ${key} on ${args.ref}: ${String(e?.message || e).slice(0, 160)}`
        }
      } else {
        try {
          await pg.keyboard.press(key)
        } catch (e: any) {
          return `error: invalid key "${key}" (${String(e?.message || e).slice(0, 120)}) — use a key name ` +
            'like Enter/Tab/Escape/ArrowDown/Backspace, or a chord like "Control+a"'
        }
      }
      // The key may navigate, open a menu, or do nothing visible — wait for a
      // navigation if one starts, then report the settled page either way.
      await pg.waitForLoadState('load', { timeout: 8000 }).catch(() => { /* no navigation */ })
      const navved = pg.url() !== urlBefore
      return snapshot(pg, {
        settleFirst: true,
        after: navved ? `pressed ${key} → navigated to ${pg.url()}` : `after pressing ${key}`,
      })
    }
    case 'BrowserScroll': {
      const pg = currentPage()
      const dir = String(args.direction ?? 'down')
      const js = dir === 'top' ? 'window.scrollTo({top:0,behavior:"smooth"})'
        : dir === 'bottom' ? 'window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"})'
        : dir === 'up' ? 'window.scrollBy({top:-window.innerHeight*0.9,behavior:"smooth"})'
        : 'window.scrollBy({top:window.innerHeight*0.9,behavior:"smooth"})'
      await pg.evaluate(js)
      await pg.waitForTimeout(450) // let the smooth scroll settle before reporting
      return `scrolled ${dir} — ${await pg.evaluate('Math.round(window.scrollY) + "/" + Math.round(document.body.scrollHeight)')}px`
    }
    case 'BrowserConsole':
      return consoleBuf.length ? consoleBuf.join('\n') : '(console is empty)'
    case 'BrowserScreenshot': {
      const pg = currentPage()
      const dir = path.join(ctx.workspaceRoot, '.orqon', 'browser')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `shot-${++shotCounter}-${Date.now() % 100000}.png`)
      await pg.screenshot({ path: file, timeout: 10_000 })
      return `saved screenshot to ${path.relative(ctx.workspaceRoot, file)} (tell the user to open it — you cannot view images)`
    }
    case 'BrowserLaunchExternal': {
      const brand = args.browser === 'edge' ? 'edge' : 'chrome'
      const port = Number(args.port) || 9222
      if (await cdpAlive(port)) {
        return `a browser is already listening on port ${port} — call BrowserOpen with target "external" (port ${port}) to attach`
      }
      launchExternalBrowser(brand, port)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (await cdpAlive(port)) {
          return `${brand} launched with debugging port ${port} (dedicated profile ~/.orqon/browser-profile/${brand} — ` +
            'the user can browse and log in normally in that window). Call BrowserOpen with target "external" to attach.'
        }
      }
      return `error: launched ${brand} but port ${port} never came up — it may already be running WITHOUT a debug port; ask the user to quit it fully and retry`
    }
    case 'BrowserClose': {
      if (extPage && !extPage.isClosed()) { await extPage.close().catch(() => {}) }
      extPage = null
      if (extBrowser?.isConnected()) await extBrowser.close().catch(() => {})
      extBrowser = null
      closeBrowserView()
      return 'browser closed (cookies/session kept for next time)'
    }
  }
  return `error: unhandled browser tool ${name}`
}
