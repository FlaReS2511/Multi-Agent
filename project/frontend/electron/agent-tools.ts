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
import { execSync } from 'node:child_process'

const BASH_TIMEOUT_MS = 120_000

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
    default: return null
  }
}
