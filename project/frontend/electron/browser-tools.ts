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

import { app, BrowserWindow, WebContentsView } from 'electron'
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
    description: 'Type text into the input with the given ref from the last BrowserSnapshot. submit=true presses Enter afterwards.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['ref', 'text'],
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
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code !== -3) pushConsole(`[pageerror] failed to load ${url}: ${desc} (${code})`)
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
  return `https://${s}`
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

async function snapshot(pg: Page, waitMs?: number): Promise<string> {
  if (waitMs) await pg.waitForTimeout(Math.min(Math.max(waitMs, 0), 5000))
  const body = String(await pg.evaluate(SNAPSHOT_JS))
  const head = `URL: ${pg.url()}\nTitle: ${await pg.title()}`
  const text = `${head}\n${body || '(no interactive elements found)'}`
  const capped = text.length > 6000 ? text.slice(0, 6000) + '\n… (truncated — use BrowserRead or scroll)' : text
  return capped + challengeHint(capped)
}

function refLocator(pg: Page, ref: string) {
  const clean = String(ref).replace(/[^e0-9]/g, '')
  return pg.locator(`[data-orqon-ref="${clean}"]`).first()
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
      return snapshot(pg)
    }
    case 'BrowserNavigate': {
      const pg = currentPage()
      const url = String(args.url ?? '')
      if (url === 'back') await pg.goBack({ timeout: 15_000 })
      else await pg.goto(normalizeUrl(url), { waitUntil: 'load', timeout: 25_000 })
      return snapshot(pg)
    }
    case 'BrowserSnapshot':
      return snapshot(currentPage(), Number(args.wait_ms) || 0)
    case 'BrowserRead': {
      const pg = currentPage()
      const text = String(await pg.evaluate('document.body ? document.body.innerText : ""'))
      const off = Math.max(0, Number(args.offset) || 0)
      const slice = text.slice(off, off + 8000)
      const more = off + 8000 < text.length ? `\n… (${text.length - off - 8000} more chars — call again with offset=${off + 8000})` : ''
      return `URL: ${pg.url()}\n${slice}${more}` + challengeHint(slice)
    }
    case 'BrowserClick': {
      const pg = currentPage()
      await refLocator(pg, String(args.ref)).click({ timeout: 8000 })
      await pg.waitForLoadState('load', { timeout: 8000 }).catch(() => { /* no navigation happened */ })
      return snapshot(pg)
    }
    case 'BrowserType': {
      const pg = currentPage()
      const loc = refLocator(pg, String(args.ref))
      await loc.fill(String(args.text ?? ''), { timeout: 8000 })
      if (args.submit) {
        await loc.press('Enter')
        await pg.waitForLoadState('load', { timeout: 10_000 }).catch(() => { /* SPA — no full navigation */ })
      }
      return snapshot(pg)
    }
    case 'BrowserScroll': {
      const pg = currentPage()
      const dir = String(args.direction ?? 'down')
      const js = dir === 'top' ? 'window.scrollTo(0,0)' : dir === 'bottom' ? 'window.scrollTo(0,document.body.scrollHeight)'
        : dir === 'up' ? 'window.scrollBy(0,-window.innerHeight*0.9)' : 'window.scrollBy(0,window.innerHeight*0.9)'
      await pg.evaluate(js)
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
