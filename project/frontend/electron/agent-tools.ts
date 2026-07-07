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
import { execSync, execFileSync } from 'node:child_process'

const BASH_TIMEOUT_MS = 120_000
const DIAG_TIMEOUT_MS = 180_000
const DOWNLOAD_MAX_BYTES = 26_214_400 // 25 MB cap for DownloadFile

// Resolve a user-supplied path against the workspace root and ensure it does
// not escape. Throws on traversal so a tool call can't touch files outside.
function resolveInside(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel)
  const root = path.resolve(cwd)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace root: ${rel}`)
  }
  return abs
}

export function toolRead(cwd: string, a: { path: string; limit?: number; offset?: number }): string {
  const p = resolveInside(cwd, a.path)
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

export function toolBash(cwd: string, a: { command: string }): string {
  try {
    const out = execSync(a.command, {
      cwd,
      timeout: BASH_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      maxBuffer: 10 * 1024 * 1024,
    })
    return `exit 0\n${String(out).slice(-4000)}`
  } catch (e: any) {
    if (e?.killed && e?.signal === 'SIGTERM') return `error: command timed out after ${BASH_TIMEOUT_MS / 1000}s`
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`
    return `exit ${e?.status ?? 1}\n${out.slice(-4000)}`
  }
}

export function toolGrep(cwd: string, a: { pattern: string; path?: string; glob?: string }): string {
  const searchPath = a.path || '.'
  try {
    const cmd = ['rg', '--no-heading', '-n', JSON.stringify(a.pattern), JSON.stringify(searchPath)]
    if (a.glob) cmd.push('--glob', JSON.stringify(a.glob))
    const out = execSync(cmd.join(' '), { cwd, encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
    return (out || 'no matches').slice(0, 4000)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return grepFallback(cwd, a.pattern, searchPath)
    const out = String(e?.stdout ?? '')
    return (out || 'no matches').slice(0, 4000)
  }
}

function grepFallback(cwd: string, pattern: string, searchPath: string): string {
  const rx = new RegExp(pattern)
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const fp = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(fp); continue }
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

export function toolGlob(cwd: string, a: { pattern: string; path?: string }): string {
  const searchPath = a.path || '.'
  // Prefer ripgrep: it honours .gitignore, expands `{ts,tsx}`, skips junk dirs
  // and is fast. `--files -g <pattern>` lists files matching the glob.
  try {
    const cmd = ['rg', '--files', '-g', JSON.stringify(a.pattern), JSON.stringify(searchPath)]
    const out = execSync(cmd.join(' '), { cwd, encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
    const files = out.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!files.length) return 'no matches'
    return sortByMtime(cwd, files).slice(0, GLOB_MAX).join('\n')
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      // rg ran but matched nothing (exit 1) or errored — fall through to walk
      const out = String(e?.stdout ?? '').trim()
      if (out) return sortByMtime(cwd, out.split('\n').filter(Boolean)).slice(0, GLOB_MAX).join('\n')
    }
    return globFallback(cwd, a.pattern, searchPath)
  }
}

// Manual walk used only when ripgrep is missing. Skips heavy dirs, matches with
// a properly-compiled regex, sorts newest-first like the ripgrep path.
function globFallback(cwd: string, pattern: string, searchPath: string): string {
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
  return sortByMtime(cwd, matches).join('\n')
}

function sortByMtime(cwd: string, rels: string[]): string[] {
  const withTime = rels.map((rel) => {
    let mtime = 0
    try { mtime = fs.statSync(path.resolve(cwd, rel)).mtimeMs } catch { /* keep 0 */ }
    return { rel, mtime }
  })
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
function runDiag(cwd: string, cmd: string, args: string[]): string {
  try {
    const out = execSync([cmd, ...args].join(' '), {
      cwd, timeout: DIAG_TIMEOUT_MS, encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      maxBuffer: 10 * 1024 * 1024,
    })
    const text = String(out).trim()
    return text ? `clean (exit 0)\n${text.slice(-4000)}` : 'clean (exit 0) — no diagnostics'
  } catch (e: any) {
    if (e?.killed && e?.signal === 'SIGTERM') return `error: ${cmd} timed out after ${DIAG_TIMEOUT_MS / 1000}s`
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim()
    return `exit ${e?.status ?? 1}\n${out.slice(-4000) || '(no output)'}`
  }
}

export function toolGetDiagnostics(cwd: string, a: { tool?: string; path?: string }): string {
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
// Fetch a URL into the workspace via curl (execFileSync avoids shell injection
// from a model-supplied URL). Creates a file. Mutator.
export function toolDownloadFile(cwd: string, a: { url: string; path: string }): string {
  if (!/^https?:\/\//i.test(a.url)) return 'error: url must be http(s)'
  const dest = resolveInside(cwd, a.path)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    execFileSync('curl', ['-fsSL', '--max-filesize', String(DOWNLOAD_MAX_BYTES), '-o', dest, a.url], {
      timeout: BASH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
    })
  } catch (e: any) {
    const out = `${e?.stderr ?? ''}${e?.stdout ?? ''}`.trim()
    return `error: download failed (${e?.status ?? '?'}): ${out.slice(-300) || a.url}`
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
export function runFileTool(cwd: string, name: string, args: any): string | null {
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
