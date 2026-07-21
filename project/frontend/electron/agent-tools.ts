// agent-tools.ts — shared file/shell tool implementations for agents.
//
// Extracted from agent-runtime.ts so both the headless group worker and the
// in-editor IDE agent run the SAME battle-tested tool logic. The only
// difference is that these take an explicit `cwd` (workspace root) instead of
// relying on process.cwd(), so the IDE agent (running in the Electron main
// process, whose cwd is the app dir) can operate on the user's workspace.
//
// All paths are resolved relative to cwd and MUST stay inside it — callers pass
// the workspace root and these helpers reject `..` escapes.

import fs from 'node:fs'
import path from 'node:path'
import { exec, execFile } from 'node:child_process'

// exceljs costs ~150ms of require() — paid on first Excel tool use instead of
// at app boot (this module loads with the main process).
let excelMod: any = null
async function excel(): Promise<any> {
  if (!excelMod) {
    const m: any = await import('exceljs')
    excelMod = m.default ?? m
  }
  return excelMod
}

const BASH_TIMEOUT_MS = 120_000
const DIAG_TIMEOUT_MS = 180_000
const DOWNLOAD_MAX_BYTES = 26_214_400 // 25 MB cap for DownloadFile
// Read refuses to return whole files bigger than this — the content goes
// straight into the model's context, and it would also be re-sent every turn.
const READ_WHOLE_FILE_MAX_BYTES = 2 * 1024 * 1024

interface RunResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
  spawnError?: string // 'ENOENT' etc — the binary itself failed to start
}

// Run a child process WITHOUT blocking the event loop. These tools execute in
// the Electron main process — the previous execSync calls froze the entire app
// (all IPC, PTYs, even the Stop button) for the duration of a build or test
// run. `argv === null` runs `command` through the shell (Bash tool).
function runChild(
  command: string,
  argv: string[] | null,
  opts: { cwd?: string; timeout: number; shell?: boolean },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const common = {
      cwd: opts.cwd,
      timeout: opts.timeout,
      killSignal: 'SIGTERM' as const,
      encoding: 'utf-8' as const,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }
    const cb = (err: any, stdout: string | Buffer, stderr: string | Buffer) => resolve({
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      code: err == null ? 0 : typeof err.code === 'number' ? err.code : 1,
      timedOut: Boolean(err?.killed && err?.signal === 'SIGTERM'),
      spawnError: typeof err?.code === 'string' ? err.code : undefined,
    })
    const child = argv === null
      ? exec(command, { ...common, shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh' }, cb)
      : execFile(command, argv, { ...common, shell: opts.shell === true }, cb)
    child.stdin?.end()
  })
}

// Directories OUTSIDE the workspace the user has explicitly approved (via the
// agent's Approve/Decline prompt). Grants last until the process exits.
const ALLOWED_OUTSIDE: string[] = []

export function allowOutsidePath(abs: string): void {
  const norm = path.resolve(abs)
  if (!ALLOWED_OUTSIDE.includes(norm)) ALLOWED_OUTSIDE.push(norm)
}

export function isOutsideRoot(cwd: string, rel: string): string | null {
  const abs = path.resolve(cwd, rel)
  const root = path.resolve(cwd)
  if (abs === root || abs.startsWith(root + path.sep)) return null
  return abs
}

// Resolve a user-supplied path against the workspace root and ensure it does
// not escape — unless the target is inside a user-approved outside directory.
// Throws on unapproved traversal so a tool call can't silently touch files
// outside the workspace.
function resolveInside(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel)
  const root = path.resolve(cwd)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    const approved = ALLOWED_OUTSIDE.some((d) => abs === d || abs.startsWith(d + path.sep))
    if (!approved) throw new Error(`path escapes workspace root: ${rel}`)
  }
  return abs
}

export function toolRead(cwd: string, a: { path: string; limit?: number; offset?: number }): string {
  const p = resolveInside(cwd, a.path)
  const size = fs.statSync(p).size
  if (size > READ_WHOLE_FILE_MAX_BYTES && a.limit == null) {
    return `error: ${a.path} is ${(size / 1048576).toFixed(1)}MB — too large to read whole. ` +
      'Pass limit (and offset) to read a window, e.g. limit=2000.'
  }
  const text = fs.readFileSync(p, 'utf-8')
  if (a.limit == null && !a.offset) return text
  let lines = text.split('\n')
  if (a.offset) lines = lines.slice(a.offset)
  if (a.limit) lines = lines.slice(0, a.limit)
  return lines.join('\n')
}

export function toolWrite(cwd: string, a: { path: string; content: string }): string {
  const p = resolveInside(cwd, a.path)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, a.content, 'utf-8')
  return `wrote ${a.content.length} chars to ${a.path}`
}

export function toolEdit(
  cwd: string,
  a: { path: string; old_string: string; new_string: string; replace_all?: boolean },
): string {
  const p = resolveInside(cwd, a.path)
  const text = fs.readFileSync(p, 'utf-8')
  if (!text.includes(a.old_string)) return `error: old_string not found in ${a.path}`
  const occurrences = text.split(a.old_string).length - 1
  if (!a.replace_all && occurrences > 1) {
    return `error: old_string occurs ${occurrences} times in ${a.path}; add more context or set replace_all=true`
  }
  const next = a.replace_all
    ? text.split(a.old_string).join(a.new_string)
    : text.replace(a.old_string, a.new_string)
  fs.writeFileSync(p, next, 'utf-8')
  return `edited ${a.path} (${a.replace_all ? occurrences : 1} replacement(s))`
}

// ── Preview / apply split (for review mode) ─────────────────
// These let the IDE agent compute what a Write/Edit *would* do without touching
// disk, so the user can review a diff first, then apply on approval.

export interface ChangePreview {
  path: string
  kind: 'write' | 'edit'
  before: string   // '' when creating a new file
  after: string
  isNew: boolean
  note: string     // human summary (e.g. "2 replacement(s)")
}

// Compute a Write without persisting. Throws on path escape.
export function previewWrite(cwd: string, a: { path: string; content: string }): ChangePreview {
  const p = resolveInside(cwd, a.path)
  let before = ''
  let isNew = true
  try { before = fs.readFileSync(p, 'utf-8'); isNew = false } catch { /* new file */ }
  return {
    path: a.path, kind: 'write', before, after: a.content, isNew,
    note: isNew ? `create ${a.path}` : `overwrite ${a.path}`,
  }
}

// Compute an Edit without persisting. Returns an error string if the edit can't
// be resolved (old_string missing / ambiguous) — same rules as toolEdit.
export function previewEdit(
  cwd: string,
  a: { path: string; old_string: string; new_string: string; replace_all?: boolean },
): ChangePreview | string {
  const p = resolveInside(cwd, a.path)
  let before: string
  try { before = fs.readFileSync(p, 'utf-8') } catch { return `error: cannot read ${a.path}` }
  if (!before.includes(a.old_string)) return `error: old_string not found in ${a.path}`
  const occurrences = before.split(a.old_string).length - 1
  if (!a.replace_all && occurrences > 1) {
    return `error: old_string occurs ${occurrences} times in ${a.path}; add more context or set replace_all=true`
  }
  const after = a.replace_all
    ? before.split(a.old_string).join(a.new_string)
    : before.replace(a.old_string, a.new_string)
  return {
    path: a.path, kind: 'edit', before, after, isNew: false,
    note: `${a.replace_all ? occurrences : 1} replacement(s)`,
  }
}

// Persist an already-approved change (full-content write).
export function applyChange(cwd: string, relPath: string, content: string): void {
  const p = resolveInside(cwd, relPath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

export async function toolBash(cwd: string, a: { command: string }): Promise<string> {
  const r = await runChild(a.command, null, { cwd, timeout: BASH_TIMEOUT_MS })
  if (r.timedOut) return `error: command timed out after ${BASH_TIMEOUT_MS / 1000}s`
  if (r.code === 0) return `exit 0\n${r.stdout.slice(-4000)}`
  return `exit ${r.code}\n${(r.stdout + r.stderr).slice(-4000)}`
}

export async function toolGrep(cwd: string, a: { pattern: string; path?: string; glob?: string }): Promise<string> {
  const searchPath = a.path || '.'
  const args = ['--no-heading', '-n', a.pattern, searchPath]
  if (a.glob) args.push('--glob', a.glob)
  const r = await runChild('rg', args, { cwd, timeout: 30_000 })
  if (r.spawnError === 'ENOENT') return grepFallback(cwd, a.pattern, searchPath)
  return (r.stdout || 'no matches').slice(0, 4000)
}

function grepFallback(cwd: string, pattern: string, searchPath: string): string {
  const rx = new RegExp(pattern)
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const fp = path.join(dir, ent.name)
      if (ent.isDirectory()) { if (!GLOB_SKIP_DIRS.has(ent.name)) walk(fp); continue }
      if (!ent.isFile()) continue
      try {
        const lines = fs.readFileSync(fp, 'utf-8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i])) {
            out.push(`${fp}:${i + 1}:${lines[i]}`)
            if (out.length >= 200) return
          }
        }
      } catch { /* skip binary/unreadable */ }
    }
  }
  walk(resolveInside(cwd, searchPath))
  return out.join('\n').slice(0, 4000) || 'no matches'
}

const GLOB_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', 'coverage'])
const GLOB_MAX = 300

export async function toolGlob(cwd: string, a: { pattern: string; path?: string }): Promise<string> {
  const searchPath = a.path || '.'
  // Prefer ripgrep: it honours .gitignore, expands `{ts,tsx}`, skips junk dirs
  // and is fast. `--files -g <pattern>` lists files matching the glob.
  const r = await runChild('rg', ['--files', '-g', a.pattern, searchPath], { cwd, timeout: 30_000 })
  if (r.spawnError === 'ENOENT') return globFallback(cwd, a.pattern, searchPath)
  const files = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!files.length) return 'no matches'
  return (await sortByMtime(cwd, files)).slice(0, GLOB_MAX).join('\n')
}

// Manual walk used only when ripgrep is missing. Skips heavy dirs, matches with
// a properly-compiled regex, sorts newest-first like the ripgrep path.
async function globFallback(cwd: string, pattern: string, searchPath: string): Promise<string> {
  const base = path.resolve(cwd)
  const root = resolveInside(cwd, searchPath)
  const rx = globToRegex(pattern)
  const matches: string[] = []
  const walk = (dir: string) => {
    if (matches.length >= GLOB_MAX) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (matches.length >= GLOB_MAX) return
      const fp = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!GLOB_SKIP_DIRS.has(ent.name)) walk(fp)
        continue
      }
      const rel = path.relative(base, fp).split(path.sep).join('/')
      if (rx.test(rel)) matches.push(rel)
    }
  }
  walk(root)
  if (!matches.length) return 'no matches'
  return (await sortByMtime(cwd, matches)).join('\n')
}

// Newest-first ordering. Skipped for very large candidate sets — stat-ing
// thousands of files to sort a list that gets capped at GLOB_MAX anyway is
// wasted IO; rg's own ordering is good enough there.
async function sortByMtime(cwd: string, rels: string[]): Promise<string[]> {
  if (rels.length > 2000) return rels
  const withTime = await Promise.all(rels.map(async (rel) => {
    let mtime = 0
    try { mtime = (await fs.promises.stat(path.resolve(cwd, rel))).mtimeMs } catch { /* keep 0 */ }
    return { rel, mtime }
  }))
  withTime.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel))
  return withTime.map((x) => x.rel)
}

// Compile a glob to an anchored regex. Tokenises the string in a SINGLE pass so
// earlier substitutions can't be re-processed by later ones (the previous
// chained-.replace() version corrupted `**/` and `?`). Supports `**`, `*`, `?`,
// `{a,b}` brace alternation and character classes `[...]`.
function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` — cross directory boundaries. Consume an optional trailing slash.
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' }
        else re += '.*'
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) { re += '\\{'; continue }
      const parts = glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      re += `(?:${parts.join('|')})`
      i = end
    } else if (c === '[') {
      const end = glob.indexOf(']', i)
      if (end === -1) { re += '\\['; continue }
      re += glob.slice(i, end + 1)
      i = end
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

// ── additional filesystem tools ─────────────────────────────────

// List a directory's entries (one per line, dirs suffixed with '/'). Unlike
// Glob (which recurses + matches), this is a shallow `ls` of one folder.
export function toolListDir(cwd: string, a: { path?: string }): string {
  const rel = a.path || '.'
  const abs = resolveInside(cwd, rel)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch (e: any) {
    return `error: cannot list ${rel}: ${e?.message || e}`
  }
  if (entries.length === 0) return '(empty)'
  return entries
    .sort((x, y) => {
      // dirs first, then files, each alphabetical
      if (x.isDirectory() !== y.isDirectory()) return x.isDirectory() ? -1 : 1
      return x.name.localeCompare(y.name)
    })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .join('\n')
}

// Move or rename a file/dir. Both endpoints must stay inside the workspace.
export function toolMove(cwd: string, a: { from: string; to: string }): string {
  const from = resolveInside(cwd, a.from)
  const to = resolveInside(cwd, a.to)
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    return `moved ${a.from} -> ${a.to}`
  } catch (e: any) {
    return `error: cannot move ${a.from}: ${e?.message || e}`
  }
}

// Delete a file or directory (recursive). Guarded to stay inside the workspace
// and to never delete the workspace root itself.
export function toolDelete(cwd: string, a: { path: string; recursive?: boolean }): string {
  const abs = resolveInside(cwd, a.path)
  if (abs === path.resolve(cwd)) return 'error: refusing to delete the workspace root'
  try {
    const st = fs.statSync(abs)
    if (st.isDirectory()) {
      if (!a.recursive) {
        const kids = fs.readdirSync(abs)
        if (kids.length > 0) return `error: ${a.path} is a non-empty directory; pass recursive=true to delete it`
      }
      fs.rmSync(abs, { recursive: true, force: true })
      return `deleted directory ${a.path}`
    }
    fs.rmSync(abs, { force: true })
    return `deleted ${a.path}`
  } catch (e: any) {
    if (e?.code === 'ENOENT') return `error: ${a.path} does not exist`
    return `error: cannot delete ${a.path}: ${e?.message || e}`
  }
}

// Apply several sequential string replacements to one file atomically. Each
// edit is applied in order to the running content; the file is only written if
// every edit resolves. Returns an error (no write) on the first failure.
export function toolMultiEdit(
  cwd: string,
  a: { path: string; edits: { old_string: string; new_string: string; replace_all?: boolean }[] },
): string {
  const p = resolveInside(cwd, a.path)
  if (!Array.isArray(a.edits) || a.edits.length === 0) return 'error: edits must be a non-empty array'
  let text: string
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch (e: any) {
    return `error: cannot read ${a.path}: ${e?.message || e}`
  }
  let applied = 0
  for (let i = 0; i < a.edits.length; i++) {
    const ed = a.edits[i]
    if (!text.includes(ed.old_string)) return `error: edit #${i + 1}: old_string not found in ${a.path}`
    const occurrences = text.split(ed.old_string).length - 1
    if (!ed.replace_all && occurrences > 1) {
      return `error: edit #${i + 1}: old_string occurs ${occurrences} times; add more context or set replace_all=true`
    }
    text = ed.replace_all
      ? text.split(ed.old_string).join(ed.new_string)
      : text.replace(ed.old_string, ed.new_string)
    applied += ed.replace_all ? occurrences : 1
  }
  fs.writeFileSync(p, text, 'utf-8')
  return `applied ${a.edits.length} edit(s) to ${a.path} (${applied} replacement(s))`
}

// ── GetDiagnostics ───────────────────────────────────────────────
// Run the project's typechecker / linter / tests and return the output so the
// agent can close the loop after edits. Safer than raw Bash: a fixed command
// set, auto-detected from the workspace. Not a mutator.
async function runDiag(cwd: string, cmd: string, args: string[]): Promise<string> {
  // execFile directly (no shell hop); npx/python are .cmd shims on Windows so
  // they still need the shell there.
  const r = await runChild(cmd, args, { cwd, timeout: DIAG_TIMEOUT_MS, shell: process.platform === 'win32' })
  if (r.timedOut) return `error: ${cmd} timed out after ${DIAG_TIMEOUT_MS / 1000}s`
  if (r.spawnError) return `error: cannot run ${cmd} (${r.spawnError})`
  if (r.code === 0) {
    const text = r.stdout.trim()
    return text ? `clean (exit 0)\n${text.slice(-4000)}` : 'clean (exit 0) — no diagnostics'
  }
  const out = (r.stdout + r.stderr).trim()
  return `exit ${r.code}\n${out.slice(-4000) || '(no output)'}`
}

export async function toolGetDiagnostics(cwd: string, a: { tool?: string; path?: string }): Promise<string> {
  const has = (rel: string) => fs.existsSync(path.join(cwd, rel))
  let tool = a.tool || 'auto'
  if (tool === 'auto') {
    if (has('tsconfig.json')) tool = 'tsc'
    else if (has('.eslintrc') || has('.eslintrc.json') || has('.eslintrc.cjs') || has('eslint.config.js') || has('eslint.config.mjs')) tool = 'eslint'
    else if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg')) tool = 'pytest'
    else return 'error: could not auto-detect a diagnostics tool (no tsconfig/eslint/pytest). Pass tool="tsc"|"eslint"|"pytest".'
  }
  const target = a.path ? resolveInside(cwd, a.path) && a.path : ''
  switch (tool) {
    case 'tsc': return runDiag(cwd, 'npx', ['--no-install', 'tsc', '--noEmit'])
    case 'eslint': return runDiag(cwd, 'npx', ['--no-install', 'eslint', target || '.'])
    case 'pytest': return runDiag(cwd, 'python', ['-m', 'pytest', '-q', ...(target ? [target] : [])])
    default: return `error: unknown diagnostics tool "${tool}" (use tsc|eslint|pytest)`
  }
}

// ── NotebookEdit ─────────────────────────────────────────────────
// Edit a Jupyter .ipynb cell (replace / insert / delete). Mutator.
export function toolNotebookEdit(
  cwd: string,
  a: { path: string; cell_index?: number; new_source?: string; cell_type?: string; edit_mode?: string },
): string {
  const p = resolveInside(cwd, a.path)
  let nb: any
  try { nb = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch (e) { return `error: cannot read notebook ${a.path}: ${(e as Error).message}` }
  if (!Array.isArray(nb.cells)) return `error: ${a.path} is not a valid notebook (no cells array)`
  const mode = a.edit_mode || 'replace'
  const idx = a.cell_index ?? (mode === 'insert' ? nb.cells.length : 0)
  const toSource = (s: string) => s.split('\n').map((l, i, arr) => (i < arr.length - 1 ? l + '\n' : l))

  if (mode === 'delete') {
    if (idx < 0 || idx >= nb.cells.length) return `error: cell_index ${idx} out of range (0..${nb.cells.length - 1})`
    nb.cells.splice(idx, 1)
  } else if (mode === 'insert') {
    const cell: any = { cell_type: a.cell_type || 'code', metadata: {}, source: toSource(a.new_source ?? '') }
    if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null }
    nb.cells.splice(Math.min(idx, nb.cells.length), 0, cell)
  } else { // replace
    if (idx < 0 || idx >= nb.cells.length) return `error: cell_index ${idx} out of range (0..${nb.cells.length - 1})`
    nb.cells[idx].source = toSource(a.new_source ?? '')
    if (a.cell_type) nb.cells[idx].cell_type = a.cell_type
    if (nb.cells[idx].cell_type === 'code' && nb.cells[idx].outputs == null) nb.cells[idx].outputs = []
  }
  fs.writeFileSync(p, JSON.stringify(nb, null, 1) + '\n', 'utf-8')
  return `${mode} cell ${idx} in ${a.path}`
}

// ── DownloadFile ─────────────────────────────────────────────────
// Fetch a URL into the workspace via curl (execFile args avoid shell injection
// from a model-supplied URL). Creates a file. Mutator.
export async function toolDownloadFile(cwd: string, a: { url: string; path: string }): Promise<string> {
  if (!/^https?:\/\//i.test(a.url)) return 'error: url must be http(s)'
  const dest = resolveInside(cwd, a.path)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const r = await runChild(
    'curl',
    ['-fsSL', '--max-filesize', String(DOWNLOAD_MAX_BYTES), '-o', dest, a.url],
    { timeout: BASH_TIMEOUT_MS },
  )
  if (r.timedOut || r.code !== 0 || r.spawnError) {
    const out = (r.stderr + r.stdout).trim()
    return `error: download failed (${r.timedOut ? 'timeout' : r.spawnError ?? r.code}): ${out.slice(-300) || a.url}`
  }
  let size = 0
  try { size = fs.statSync(dest).size } catch { /* ignore */ }
  return `downloaded ${size} bytes to ${a.path}`
}

export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// The file/shell tool specs shared by every agent. DB/orchestration tools are
// declared by their own runtimes; these are the universal coding tools.
export const FILE_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'Read',
    description: 'Read a file. Paths are relative to the workspace root. Use limit/offset for large files.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file (creates parent dirs, overwrites).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace old_string with new_string in a file. Set replace_all=true for multiple occurrences.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description: 'Run a shell command in the workspace root with a 120s timeout. Returns exit code + last 4KB output.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'Grep',
    description: 'Search a regex pattern recursively (ripgrep when available). Optional path + glob filter.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files by glob pattern, sorted by most-recently-modified. Supports **, *, ?, brace {ts,tsx} and char classes. Respects .gitignore and skips node_modules/.git/dist. Examples: "src/**/*.{ts,tsx}", "**/*.test.ts". Optional path scopes the search.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'ListDir',
    description: 'List the entries of a single directory (shallow, like `ls`). Directories are suffixed with "/". Use to explore folder structure. path defaults to the workspace root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'Move',
    description: 'Move or rename a file or directory within the workspace. Creates parent directories of the destination as needed.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'Delete',
    description: 'Delete a file or directory in the workspace. For a non-empty directory, pass recursive=true. Cannot delete the workspace root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path'],
    },
  },
  {
    name: 'MultiEdit',
    description: 'Apply several string replacements to ONE file in order, atomically. Each edit has old_string/new_string and optional replace_all. If any edit fails to match, nothing is written. Prefer this over multiple Edit calls on the same file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'GetDiagnostics',
    description: 'Run the project typechecker/linter/tests and return errors — use after editing to verify your change compiles. tool: "auto" (default, detects tsc/eslint/pytest), "tsc", "eslint", or "pytest". Optional path scopes eslint/pytest.',
    input_schema: {
      type: 'object',
      properties: { tool: { type: 'string', enum: ['auto', 'tsc', 'eslint', 'pytest'] }, path: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter .ipynb cell. edit_mode: "replace" (default, needs cell_index), "insert" (at cell_index, or appends), or "delete" (cell_index). new_source is the full cell text. cell_type "code"|"markdown" for inserts.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        cell_index: { type: 'integer' },
        new_source: { type: 'string' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      },
      required: ['path'],
    },
  },
  {
    name: 'DownloadFile',
    description: 'Download an http(s) URL into a file in the workspace (max 25MB). Use for fetching assets/fixtures. For reading web page text, use WebFetch instead.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, path: { type: 'string' } },
      required: ['url', 'path'],
    },
  },
]

// Dispatch a file/shell tool by name. Returns the tool result string, or null
// if the name is not a file/shell tool (caller handles other tool families).
export async function runFileTool(cwd: string, name: string, args: any): Promise<string | null> {
  switch (name) {
    case 'Read': return toolRead(cwd, args)
    case 'Write': return toolWrite(cwd, args)
    case 'Edit': return toolEdit(cwd, args)
    case 'Bash': return toolBash(cwd, args)
    case 'Grep': return toolGrep(cwd, args)
    case 'Glob': return toolGlob(cwd, args)
    case 'ListDir': return toolListDir(cwd, args)
    case 'Move': return toolMove(cwd, args)
    case 'Delete': return toolDelete(cwd, args)
    case 'MultiEdit': return toolMultiEdit(cwd, args)
    case 'GetDiagnostics': return toolGetDiagnostics(cwd, args)
    case 'NotebookEdit': return toolNotebookEdit(cwd, args)
    case 'DownloadFile': return toolDownloadFile(cwd, args)
    default: return null
  }
}

// ── Excel (.xlsx) tools ──────────────────────────────────────────
// Async (exceljs) → dispatched via runExcelTool, not the sync runFileTool.

function colToNum(col: string): number {
  let n = 0
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}
function parseA1(a1: string): { row: number; col: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(a1.trim())
  if (!m) throw new Error(`bad cell reference: ${a1}`)
  return { col: colToNum(m[1]), row: parseInt(m[2], 10) }
}
function parseRange(r: string): { r1: number; c1: number; r2: number; c2: number } {
  const [a, b] = r.split(':')
  const p1 = parseA1(a)
  const p2 = b ? parseA1(b) : p1
  return { r1: Math.min(p1.row, p2.row), c1: Math.min(p1.col, p2.col), r2: Math.max(p1.row, p2.row), c2: Math.max(p1.col, p2.col) }
}
// Strings starting with "=" become formulas.
function toCellValue(v: unknown): unknown {
  if (typeof v === 'string' && v.startsWith('=')) return { formula: v.slice(1) }
  return v
}
function readCell(cell: any): unknown {
  const v = cell?.value
  if (v == null) return null
  if (typeof v === 'object') {
    if ('result' in v) return (v as any).result
    if ('text' in v) return (v as any).text
    if (v instanceof Date) return v.toISOString()
    if ('richText' in v) return (v as any).richText.map((t: any) => t.text).join('')
    return String(v)
  }
  return v
}
function normArgb(c: string): string {
  const h = c.replace('#', '').toUpperCase()
  return h.length === 6 ? 'FF' + h : h
}
async function loadWorkbook(p: string, allowNew: boolean): Promise<any> {
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  if (fs.existsSync(p)) await wb.xlsx.readFile(p)
  else if (!allowNew) throw new Error(`file not found: ${p}`)
  return wb
}
function sheetOf(wb: any, name?: string): any {
  return name ? wb.getWorksheet(name) : wb.worksheets[0]
}

async function toolExcelInfo(cwd: string, a: { path: string }): Promise<string> {
  const wb = await loadWorkbook(resolveInside(cwd, a.path), false)
  const lines = wb.worksheets.map((ws: any) => `- ${ws.name}: ${ws.rowCount} rows × ${ws.columnCount} cols`)
  return `Workbook ${a.path}:\n${lines.join('\n') || '(no sheets)'}`
}
async function toolExcelRead(cwd: string, a: { path: string; sheet?: string; range?: string; as?: string }): Promise<string> {
  const wb = await loadWorkbook(resolveInside(cwd, a.path), false)
  const ws = sheetOf(wb, a.sheet)
  if (!ws) return `error: sheet ${a.sheet ?? '(first)'} not found`
  let { r1, c1, r2, c2 } = a.range ? parseRange(a.range) : { r1: 1, c1: 1, r2: ws.rowCount || 0, c2: ws.columnCount || 0 }
  if (r2 - r1 > 2000) r2 = r1 + 2000 // cap
  const rows: unknown[][] = []
  for (let r = r1; r <= r2; r++) {
    const row: unknown[] = []
    for (let c = c1; c <= c2; c++) row.push(readCell(ws.getCell(r, c)))
    rows.push(row)
  }
  if (a.as === 'json' && rows.length) {
    const [hdr, ...body] = rows
    const objs = body.map((rw) => Object.fromEntries((hdr as unknown[]).map((h, i) => [String(h ?? `col${i + 1}`), rw[i] ?? null])))
    return JSON.stringify(objs).slice(0, 12000)
  }
  return JSON.stringify(rows).slice(0, 12000)
}
async function toolExcelWrite(cwd: string, a: { path: string; sheets: { name?: string; rows: unknown[][] }[] }): Promise<string> {
  const p = resolveInside(cwd, a.path)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  const sheets = a.sheets || []
  sheets.forEach((s, i) => {
    const ws = wb.addWorksheet(s.name || `Sheet${i + 1}`)
    for (const row of s.rows || []) ws.addRow((row || []).map(toCellValue))
  })
  if (sheets.length === 0) wb.addWorksheet('Sheet1')
  await wb.xlsx.writeFile(p)
  return `wrote ${sheets.length || 1} sheet(s) to ${a.path}`
}
async function toolExcelSetRange(cwd: string, a: { path: string; sheet?: string; anchor: string; values: unknown[][] }): Promise<string> {
  const p = resolveInside(cwd, a.path)
  const wb = await loadWorkbook(p, true)
  let ws = sheetOf(wb, a.sheet)
  if (!ws) ws = wb.addWorksheet(a.sheet || 'Sheet1')
  const { row: r0, col: c0 } = parseA1(a.anchor)
  ;(a.values || []).forEach((rowVals, ri) => (rowVals || []).forEach((v, ci) => { ws.getCell(r0 + ri, c0 + ci).value = toCellValue(v) as any }))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  await wb.xlsx.writeFile(p)
  return `set ${(a.values || []).length}×${((a.values || [])[0] || []).length} block at ${a.anchor} in ${ws.name} of ${a.path}`
}
async function toolExcelAppendRows(cwd: string, a: { path: string; sheet?: string; rows: unknown[][] }): Promise<string> {
  const p = resolveInside(cwd, a.path)
  const wb = await loadWorkbook(p, true)
  let ws = sheetOf(wb, a.sheet)
  if (!ws) ws = wb.addWorksheet(a.sheet || 'Sheet1')
  for (const row of a.rows || []) ws.addRow((row || []).map(toCellValue))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  await wb.xlsx.writeFile(p)
  return `appended ${(a.rows || []).length} row(s) to ${ws.name} in ${a.path}`
}
async function toolExcelSheetOp(cwd: string, a: { path: string; op: string; sheet: string; new_name?: string }): Promise<string> {
  const p = resolveInside(cwd, a.path)
  const wb = await loadWorkbook(p, a.op === 'add')
  if (a.op === 'add') {
    if (wb.getWorksheet(a.sheet)) return `error: sheet "${a.sheet}" already exists`
    wb.addWorksheet(a.sheet)
  } else {
    const ws = wb.getWorksheet(a.sheet)
    if (!ws) return `error: sheet "${a.sheet}" not found`
    if (a.op === 'delete') wb.removeWorksheet(ws.id)
    else if (a.op === 'rename') { if (!a.new_name) return 'error: new_name required'; ws.name = a.new_name }
    else return `error: unknown op "${a.op}" (use add|delete|rename)`
  }
  await wb.xlsx.writeFile(p)
  return `${a.op} sheet "${a.sheet}"${a.new_name ? ` → "${a.new_name}"` : ''} in ${a.path}`
}
async function toolExcelFormat(cwd: string, a: { path: string; sheet?: string; range: string; number_format?: string; bold?: boolean; fill?: string; font_color?: string }): Promise<string> {
  const p = resolveInside(cwd, a.path)
  const wb = await loadWorkbook(p, false)
  const ws = sheetOf(wb, a.sheet)
  if (!ws) return `error: sheet ${a.sheet ?? '(first)'} not found`
  const { r1, c1, r2, c2 } = parseRange(a.range)
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    const cell = ws.getCell(r, c)
    if (a.number_format) cell.numFmt = a.number_format
    if (a.bold) cell.font = { ...(cell.font || {}), bold: true }
    if (a.font_color) cell.font = { ...(cell.font || {}), color: { argb: normArgb(a.font_color) } }
    if (a.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: normArgb(a.fill) } }
  }
  await wb.xlsx.writeFile(p)
  return `formatted ${a.range} in ${ws.name} of ${a.path}`
}

export const EXCEL_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'ExcelInfo',
    description: 'List the sheets in an .xlsx workbook with their row/column counts. Use before reading/editing to understand the structure.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'ExcelRead',
    description: 'Read cells from an .xlsx sheet as a 2D array (or as JSON objects with as="json", using row 1 as headers). Optional range like "A1:D50"; sheet defaults to the first.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, sheet: { type: 'string' }, range: { type: 'string' }, as: { type: 'string', enum: ['rows', 'json'] } },
      required: ['path'],
    },
  },
  {
    name: 'ExcelWrite',
    description: 'Create or overwrite an .xlsx workbook. sheets = [{ name, rows: [[cell,...],...] }] (multiple sheets supported). A cell string starting with "=" is treated as a formula (e.g. "=SUM(A1:A10)").',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } }, required: ['rows'] } },
      },
      required: ['path', 'sheets'],
    },
  },
  {
    name: 'ExcelSetRange',
    description: 'Write a block of values into an existing (or new) .xlsx starting at a cell anchor like "B2", without rewriting the whole file. Creates the sheet/file if missing. Cell strings starting with "=" are formulas.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, sheet: { type: 'string' }, anchor: { type: 'string' }, values: { type: 'array', items: { type: 'array' } } },
      required: ['path', 'anchor', 'values'],
    },
  },
  {
    name: 'ExcelAppendRows',
    description: 'Append rows to the end of a sheet in an .xlsx (creates the file/sheet if missing).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, sheet: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } },
      required: ['path', 'rows'],
    },
  },
  {
    name: 'ExcelSheetOp',
    description: 'Manage sheets in an .xlsx: op = "add" | "delete" | "rename" (rename needs new_name).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, op: { type: 'string', enum: ['add', 'delete', 'rename'] }, sheet: { type: 'string' }, new_name: { type: 'string' } },
      required: ['path', 'op', 'sheet'],
    },
  },
  {
    name: 'ExcelFormat',
    description: 'Format a cell range in an .xlsx: number_format (e.g. "#,##0.00", "0%", "yyyy-mm-dd"), bold, fill (hex bg color), font_color (hex). range like "A1:C1".',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' }, sheet: { type: 'string' }, range: { type: 'string' },
        number_format: { type: 'string' }, bold: { type: 'boolean' }, fill: { type: 'string' }, font_color: { type: 'string' },
      },
      required: ['path', 'range'],
    },
  },
]
export const EXCEL_TOOL_NAMES = new Set(EXCEL_TOOL_SPECS.map((s) => s.name))
// Excel tools that write the file (for /undo tracking + editor refresh).
export const EXCEL_MUTATORS = new Set(['ExcelWrite', 'ExcelSetRange', 'ExcelAppendRows', 'ExcelSheetOp', 'ExcelFormat'])

export async function runExcelTool(cwd: string, name: string, args: any): Promise<string | null> {
  switch (name) {
    case 'ExcelInfo': return toolExcelInfo(cwd, args)
    case 'ExcelRead': return toolExcelRead(cwd, args)
    case 'ExcelWrite': return toolExcelWrite(cwd, args)
    case 'ExcelSetRange': return toolExcelSetRange(cwd, args)
    case 'ExcelAppendRows': return toolExcelAppendRows(cwd, args)
    case 'ExcelSheetOp': return toolExcelSheetOp(cwd, args)
    case 'ExcelFormat': return toolExcelFormat(cwd, args)
    default: return null
  }
}
