// extra-tools.ts — git, git-account/login, web, todo and background tools for
// the IDE agent. These run in the Electron main process (where ide-agent runs)
// so they can shell out to `git`/`gh`, hit the network, and manage child
// processes. File/shell tools live in agent-tools.ts; this module is the
// "everything else" tool family.
//
// SAFETY MODEL: read-only tools (status/diff/log/config-get/auth-status/…) run
// freely. Anything that mutates git state, the account identity, or logs in
// (commit, push, config set, remote set, switch account, gh login) is gated:
// runExtraTool calls the injected `confirm` callback and refuses if the user
// declines. No tokens/credentials are persisted by this module.

import { execFile } from 'node:child_process'
import { spawn, ChildProcess } from 'node:child_process'
import * as db from './db'
import { ToolSpec } from './agent-tools'

// ── context passed by ide-agent ─────────────────────────────────

export interface PendingAction {
  actionId: string
  tool: string
  title: string    // one-line summary shown to the user
  detail: string   // the concrete command(s) that will run
}

export interface ExtraToolCtx {
  cwd: string
  // Ask the user to approve a sensitive action. Resolves true = proceed.
  confirm: (action: Omit<PendingAction, 'actionId'>) => Promise<boolean>
  // Emit a todo-list update so the UI can render the agent's checklist.
  emitTodos?: (todos: { content: string; status: string }[]) => void
}

// ── git exec helper ──────────────────────────────────────────────

interface ExecResult { ok: boolean; stdout: string; stderr: string; code: number | null }

function run(cmd: string, args: string[], cwd: string, input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code })
      },
    )
    if (input != null && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

function git(cwd: string, args: string[], input?: string): Promise<ExecResult> {
  return run('git', args, cwd, input)
}

function gh(cwd: string, args: string[], input?: string): Promise<ExecResult> {
  return run('gh', args, cwd, input)
}

// Format an ExecResult into a tool-result string (last 4KB of output).
function fmt(r: ExecResult): string {
  const body = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim()
  const tail = body.length > 4000 ? body.slice(-4000) : body
  return `exit ${r.code}\n${tail || '(no output)'}`
}

async function ghAvailable(cwd: string): Promise<boolean> {
  const r = await run('gh', ['--version'], cwd)
  return r.ok
}

// ── durable notes (RememberNote / RecallNotes) ───────────────────
const NOTES_META_KEY = 'agent_notes'
interface Note { ts: string; text: string }
function loadNotes(): Note[] {
  try { const v = db.getMeta(NOTES_META_KEY); return v ? JSON.parse(v) : [] } catch { return [] }
}
function saveNotes(notes: Note[]): void {
  db.setMeta(NOTES_META_KEY, JSON.stringify(notes.slice(-200))) // keep last 200
}

// ── tool specs ───────────────────────────────────────────────────

export const EXTRA_TOOL_SPECS: ToolSpec[] = [
  // ── git: read-only ──
  {
    name: 'GitStatus',
    description: 'Show the working-tree status (git status). Read-only.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'GitDiff',
    description: 'Show a git diff. Set staged=true for staged changes. Optional path limits the diff to one file/dir. Read-only.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, staged: { type: 'boolean' } },
      required: [],
    },
  },
  {
    name: 'GitLog',
    description: 'Show recent commit history (git log --oneline). limit defaults to 20. Read-only.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] },
  },
  {
    name: 'GitBranch',
    description: 'List branches and the current branch. Read-only.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'GitConfigGet',
    description: 'Read git config for the current identity. scope is "local" (this repo) or "global". Returns user.name and user.email. Read-only.',
    input_schema: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['local', 'global'] } },
      required: [],
    },
  },
  {
    name: 'GitRemoteGet',
    description: 'List git remotes and their URLs (git remote -v). Read-only.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'GitHubAuthStatus',
    description: 'Show which GitHub account(s) the gh CLI is logged in as (gh auth status). Read-only. Reports if gh is not installed.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ListGitProfiles',
    description: 'List the saved git account profiles (label, name, email, remote, gh account). Read-only. Use these with SwitchGitAccount.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── git: mutating (require confirmation) ──
  {
    name: 'GitAdd',
    description: 'Stage files for commit (git add). Pass paths (array) or set all=true for `git add -A`. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } },
      required: [],
    },
  },
  {
    name: 'GitCommit',
    description: 'Create a commit with the given message (git commit -m). Only staged changes are committed unless all=true (git commit -am). Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' }, all: { type: 'boolean' } },
      required: ['message'],
    },
  },
  {
    name: 'GitPush',
    description: 'Push commits to a remote (git push). Optional remote + branch; set set_upstream=true to add -u. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { remote: { type: 'string' }, branch: { type: 'string' }, set_upstream: { type: 'boolean' } },
      required: [],
    },
  },
  {
    name: 'GitPull',
    description: 'Pull from a remote (git pull). Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { remote: { type: 'string' }, branch: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'GitCheckout',
    description: 'Switch branches (git checkout). Set create=true to create a new branch (-b). Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { branch: { type: 'string' }, create: { type: 'boolean' } },
      required: ['branch'],
    },
  },
  {
    name: 'GitConfigSet',
    description: 'Set the git identity (user.name and/or user.email). scope "local" (this repo, default) or "global". This changes who commits are attributed to. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        user_name: { type: 'string' },
        user_email: { type: 'string' },
        scope: { type: 'string', enum: ['local', 'global'] },
      },
      required: [],
    },
  },
  {
    name: 'GitRemoteSet',
    description: 'Set (or add) a remote URL, e.g. point origin at a different account/repo. name defaults to "origin". Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'SwitchGitAccount',
    description: 'Switch the git account in one step by applying a saved profile: sets git user.name/user.email (local repo), optionally repoints origin, and optionally switches the gh CLI account. Pass the profile label from ListGitProfiles. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { profile: { type: 'string', description: 'the profile label to apply' } },
      required: ['profile'],
    },
  },
  {
    name: 'SaveGitProfile',
    description: 'Save (or update) a reusable git account profile for quick switching later. Stores name/email and optional remote URL + gh account handle. No credentials are stored. This only writes to the local app database.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        user_name: { type: 'string' },
        user_email: { type: 'string' },
        remote_url: { type: 'string' },
        gh_account: { type: 'string' },
      },
      required: ['label', 'user_name', 'user_email'],
    },
  },
  {
    name: 'GitHubAuthSwitch',
    description: 'Switch the active GitHub account in the gh CLI (gh auth switch --user <account>). Requires gh and that you are already logged into that account. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { account: { type: 'string' } },
      required: ['account'],
    },
  },
  {
    name: 'GitHubLogin',
    description: 'Log the gh CLI into a GitHub account. If a token is provided it logs in non-interactively (gh auth login --with-token). Without a token, returns instructions to run `gh auth login` in the integrated terminal (interactive browser/device flow cannot run inside the agent). Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'a GitHub personal access token (optional)' } },
      required: [],
    },
  },

  // ── web ──
  {
    name: 'WebFetch',
    description: 'Fetch the contents of a URL over HTTP(S) and return it as text (HTML is reduced to readable text). Use for docs, references, or API responses. Read-only.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, as: { type: 'string', enum: ['text', 'raw'] } },
      required: ['url'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web and return the top result titles + URLs (via DuckDuckGo). Use to find documentation or references, then WebFetch a result. Read-only.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },

  // ── agent utilities ──
  {
    name: 'TodoWrite',
    description: 'Record or update your task checklist for this run so the user can follow your plan. Pass the full list each time. status is pending|in_progress|completed. Keep exactly one item in_progress.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'BashBackground',
    description: 'Start a long-running shell command in the background (e.g. a dev server, watcher, or build over 120s). Returns a job id. Use BashOutput to read its output and KillBash to stop it. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'BashOutput',
    description: 'Read the accumulated stdout/stderr of a background job started with BashBackground. Read-only.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'KillBash',
    description: 'Stop a background job started with BashBackground.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  // ── GitHub (gh CLI) ──
  {
    name: 'ListPRs',
    description: 'List pull requests in the current repo (gh pr list). Optional state (open|closed|merged|all) and limit.',
    input_schema: {
      type: 'object',
      properties: { state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'] }, limit: { type: 'integer' } },
      required: [],
    },
  },
  {
    name: 'ViewPR',
    description: 'View a pull request: title, body, status, checks (gh pr view). Set comments=true to include the discussion.',
    input_schema: {
      type: 'object',
      properties: { number: { type: 'integer' }, comments: { type: 'boolean' } },
      required: ['number'],
    },
  },
  {
    name: 'ListIssues',
    description: 'List issues in the current repo (gh issue list). Optional state (open|closed|all) and limit.',
    input_schema: {
      type: 'object',
      properties: { state: { type: 'string', enum: ['open', 'closed', 'all'] }, limit: { type: 'integer' } },
      required: [],
    },
  },
  {
    name: 'CreatePR',
    description: 'Open a pull request for the current branch (gh pr create). Requires title. Optional body, base branch, draft. Push your branch first.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, body: { type: 'string' },
        base: { type: 'string' }, draft: { type: 'boolean' },
      },
      required: ['title'],
    },
  },
  {
    name: 'CommentIssue',
    description: 'Add a comment to an issue or pull request (gh issue/pr comment). Set pr=true to comment on a PR number.',
    input_schema: {
      type: 'object',
      properties: { number: { type: 'integer' }, body: { type: 'string' }, pr: { type: 'boolean' } },
      required: ['number', 'body'],
    },
  },
  // ── memory (persists across sessions in the DB) ──
  {
    name: 'RememberNote',
    description: 'Save a short note to durable memory (decisions, conventions, gotchas) so you recall it in later sessions. Use for facts worth keeping, not transient chatter.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'RecallNotes',
    description: 'Retrieve saved notes from durable memory. Optional query filters by substring.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: [] },
  },
]

export const EXTRA_TOOL_NAMES = new Set(EXTRA_TOOL_SPECS.map((s) => s.name))

// Tools that mutate git/account/login state or run background processes. These
// are gated behind a user confirmation before they execute.
export const SENSITIVE_EXTRA_TOOLS = new Set([
  'GitAdd', 'GitCommit', 'GitPush', 'GitPull', 'GitCheckout',
  'GitConfigSet', 'GitRemoteSet', 'SwitchGitAccount',
  'GitHubAuthSwitch', 'GitHubLogin', 'BashBackground',
  'CreatePR', 'CommentIssue',
])

// ── background job registry ──────────────────────────────────────
// Jobs live for the lifetime of the main process. Output is buffered (capped)
// so BashOutput can read it. Keyed by a short job id.

interface BgJob {
  id: string
  command: string
  proc: ChildProcess
  output: string
  done: boolean
  exitCode: number | null
}

const bgJobs = new Map<string, BgJob>()
let bgCounter = 0
const BG_OUTPUT_CAP = 200_000 // chars retained per job

function startBackground(cwd: string, command: string): string {
  const id = `job-${++bgCounter}`
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['-Command', command] : ['-c', command]
  const proc = spawn(shell, shellArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const job: BgJob = { id, command, proc, output: '', done: false, exitCode: null }
  const append = (chunk: Buffer) => {
    job.output += chunk.toString('utf-8')
    if (job.output.length > BG_OUTPUT_CAP) job.output = job.output.slice(-BG_OUTPUT_CAP)
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)
  proc.on('exit', (code) => { job.done = true; job.exitCode = code })
  proc.on('error', (err) => { job.output += `\n[spawn error] ${err.message}`; job.done = true; job.exitCode = 1 })
  bgJobs.set(id, job)
  return id
}

// Kill any surviving background jobs (called on app quit from main).
export function killAllBackgroundJobs(): void {
  for (const job of bgJobs.values()) {
    if (!job.done) { try { job.proc.kill() } catch { /* ignore */ } }
  }
  bgJobs.clear()
}

// ── web helpers ──────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function webFetch(url: string, as: string): Promise<string> {
  let u: URL
  try { u = new URL(url) } catch { return `error: invalid URL: ${url}` }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'error: only http(s) URLs are supported'
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30_000)
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Orqon-IDE-agent/1.0' },
    })
    clearTimeout(timer)
    const raw = await resp.text()
    const ct = resp.headers.get('content-type') || ''
    const text = as === 'raw' || !ct.includes('html') ? raw : htmlToText(raw)
    const capped = text.length > 12_000 ? text.slice(0, 12_000) + '\n… (truncated)' : text
    return `HTTP ${resp.status} ${resp.statusText} (${ct})\n\n${capped}`
  } catch (e: any) {
    if (e?.name === 'AbortError') return 'error: request timed out after 30s'
    return `error: fetch failed: ${e?.message || e}`
  }
}

async function webSearch(query: string): Promise<string> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30_000)
    const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Orqon-IDE-agent/1.0)' },
    })
    clearTimeout(timer)
    const html = await resp.text()
    const results: string[] = []
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) && results.length < 10) {
      const title = htmlToText(m[2])
      let href = m[1]
      // DuckDuckGo wraps links in a redirect; extract the uddg= target.
      const wrapped = href.match(/[?&]uddg=([^&]+)/)
      if (wrapped) { try { href = decodeURIComponent(wrapped[1]) } catch { /* keep */ } }
      if (title && href) results.push(`${results.length + 1}. ${title}\n   ${href}`)
    }
    return results.length ? results.join('\n') : 'no results'
  } catch (e: any) {
    if (e?.name === 'AbortError') return 'error: search timed out after 30s'
    return `error: search failed: ${e?.message || e}`
  }
}

// ── main dispatcher ──────────────────────────────────────────────
//
// Returns the tool-result string, or null if `name` is not an extra tool (so
// the caller can try other tool families). Sensitive tools call ctx.confirm
// first and short-circuit to a "declined" result if the user says no.

export async function runExtraTool(
  name: string,
  args: any,
  ctx: ExtraToolCtx,
): Promise<string | null> {
  if (!EXTRA_TOOL_NAMES.has(name)) return null
  const cwd = ctx.cwd

  // Gate mutating tools behind a user confirmation.
  if (SENSITIVE_EXTRA_TOOLS.has(name)) {
    const preview = await previewSensitive(name, args)
    const ok = await ctx.confirm({ tool: name, title: preview.title, detail: preview.detail })
    if (!ok) return `declined by user: the ${name} action was not performed`
  }

  switch (name) {
    // ── read-only git ──
    case 'GitStatus':
      return fmt(await git(cwd, ['status']))
    case 'GitDiff': {
      const a = args as { path?: string; staged?: boolean }
      const gargs = ['diff']
      if (a.staged) gargs.push('--staged')
      if (a.path) gargs.push('--', a.path)
      return fmt(await git(cwd, gargs))
    }
    case 'GitLog': {
      const limit = Math.max(1, Math.min(200, Number((args as { limit?: number }).limit) || 20))
      return fmt(await git(cwd, ['log', '--oneline', '-n', String(limit)]))
    }
    case 'GitBranch':
      return fmt(await git(cwd, ['branch', '-vv']))
    case 'GitConfigGet': {
      const scope = (args as { scope?: string }).scope === 'global' ? '--global' : '--local'
      const nm = await git(cwd, ['config', scope, 'user.name'])
      const em = await git(cwd, ['config', scope, 'user.email'])
      return `scope=${scope === '--global' ? 'global' : 'local'}\n` +
        `user.name=${nm.stdout.trim() || '(unset)'}\n` +
        `user.email=${em.stdout.trim() || '(unset)'}`
    }
    case 'GitRemoteGet':
      return fmt(await git(cwd, ['remote', '-v']))
    case 'GitHubAuthStatus': {
      if (!(await ghAvailable(cwd))) return 'gh CLI is not installed. Install from https://cli.github.com to manage GitHub accounts.'
      return fmt(await gh(cwd, ['auth', 'status']))
    }
    case 'ListGitProfiles': {
      const rows = db.listGitProfiles()
      if (rows.length === 0) return 'no saved profiles. Use SaveGitProfile to add one.'
      return rows
        .map((p) => `- ${p.label}: ${p.user_name} <${p.user_email}>` +
          (p.remote_url ? ` remote=${p.remote_url}` : '') +
          (p.gh_account ? ` gh=${p.gh_account}` : ''))
        .join('\n')
    }

    // ── mutating git (already confirmed above) ──
    case 'GitAdd': {
      const a = args as { paths?: string[]; all?: boolean }
      if (a.all) return fmt(await git(cwd, ['add', '-A']))
      if (!a.paths || a.paths.length === 0) return 'error: provide paths[] or all=true'
      return fmt(await git(cwd, ['add', '--', ...a.paths]))
    }
    case 'GitCommit': {
      const a = args as { message: string; all?: boolean }
      if (!a.message?.trim()) return 'error: commit message required'
      const gargs = ['commit']
      if (a.all) gargs.push('-a')
      gargs.push('-m', a.message)
      return fmt(await git(cwd, gargs))
    }
    case 'GitPush': {
      const a = args as { remote?: string; branch?: string; set_upstream?: boolean }
      const gargs = ['push']
      if (a.set_upstream) gargs.push('-u')
      if (a.remote) gargs.push(a.remote)
      if (a.branch) gargs.push(a.branch)
      return fmt(await git(cwd, gargs))
    }
    case 'GitPull': {
      const a = args as { remote?: string; branch?: string }
      const gargs = ['pull']
      if (a.remote) gargs.push(a.remote)
      if (a.branch) gargs.push(a.branch)
      return fmt(await git(cwd, gargs))
    }
    case 'GitCheckout': {
      const a = args as { branch: string; create?: boolean }
      if (!a.branch?.trim()) return 'error: branch required'
      const gargs = a.create ? ['checkout', '-b', a.branch] : ['checkout', a.branch]
      return fmt(await git(cwd, gargs))
    }
    case 'GitConfigSet': {
      const a = args as { user_name?: string; user_email?: string; scope?: string }
      const scope = a.scope === 'global' ? '--global' : '--local'
      if (!a.user_name && !a.user_email) return 'error: provide user_name and/or user_email'
      const out: string[] = []
      if (a.user_name) out.push(fmt(await git(cwd, ['config', scope, 'user.name', a.user_name])))
      if (a.user_email) out.push(fmt(await git(cwd, ['config', scope, 'user.email', a.user_email])))
      return `git identity updated (${scope === '--global' ? 'global' : 'local'})\n` + out.join('\n')
    }
    case 'GitRemoteSet': {
      const a = args as { name?: string; url: string }
      const remoteName = a.name || 'origin'
      if (!a.url?.trim()) return 'error: url required'
      // set-url fails if the remote doesn't exist; fall back to `remote add`.
      const setRes = await git(cwd, ['remote', 'set-url', remoteName, a.url])
      if (setRes.ok) return `remote ${remoteName} -> ${a.url}\n${fmt(setRes)}`
      const addRes = await git(cwd, ['remote', 'add', remoteName, a.url])
      return `added remote ${remoteName} -> ${a.url}\n${fmt(addRes)}`
    }
    case 'SwitchGitAccount':
      return await switchGitAccount(cwd, (args as { profile: string }).profile)
    case 'SaveGitProfile': {
      const a = args as { label: string; user_name: string; user_email: string; remote_url?: string; gh_account?: string }
      if (!a.label || !a.user_name || !a.user_email) return 'error: label, user_name and user_email are required'
      db.upsertGitProfile({
        label: a.label, user_name: a.user_name, user_email: a.user_email,
        remote_url: a.remote_url ?? null, gh_account: a.gh_account ?? null,
      })
      return `saved profile "${a.label}" (${a.user_name} <${a.user_email}>)`
    }
    case 'GitHubAuthSwitch': {
      const a = args as { account: string }
      if (!(await ghAvailable(cwd))) return 'error: gh CLI is not installed'
      if (!a.account?.trim()) return 'error: account required'
      return fmt(await gh(cwd, ['auth', 'switch', '--user', a.account]))
    }
    case 'GitHubLogin': {
      const a = args as { token?: string }
      if (!(await ghAvailable(cwd))) return 'error: gh CLI is not installed. Install from https://cli.github.com'
      if (a.token?.trim()) {
        const r = await gh(cwd, ['auth', 'login', '--with-token'], a.token.trim())
        return fmt(r)
      }
      return 'Interactive login (browser/device flow) cannot run inside the agent. ' +
        'Open the integrated terminal and run:  gh auth login  — or call GitHubLogin again with a personal access token.'
    }

    // ── GitHub (gh CLI) ──
    case 'ListPRs': {
      if (!(await ghAvailable(cwd))) return 'error: gh CLI is not installed. Install from https://cli.github.com'
      const a = args as { state?: string; limit?: number }
      const limit = Math.max(1, Math.min(100, Number(a.limit) || 20))
      return fmt(await gh(cwd, ['pr', 'list', '--state', a.state || 'open', '--limit', String(limit)]))
    }
    case 'ViewPR': {
      if (!(await ghAvailable(cwd))) return 'error: gh CLI is not installed'
      const a = args as { number: number; comments?: boolean }
      if (a.number == null) return 'error: number required'
      const gargs = ['pr', 'view', String(a.number)]
      if (a.comments) gargs.push('--comments')
      return fmt(await gh(cwd, gargs))
    }
    case 'ListIssues': {
      if (!(await ghAvailable(cwd))) return 'error: gh CLI is not installed'
      const a = args as { state?: string; limit?: number }
      const limit = Math.max(1, Math.min(100, Number(a.limit) || 20))
      return fmt(await gh(cwd, ['issue', 'list', '--state', a.state || 'open', '--limit', String(limit)]))
    }
    case 'CreatePR': {
      if (!(await ghAvailable(cwd))) return 'error: gh CLI is not installed'
      const a = args as { title: string; body?: string; base?: string; draft?: boolean }
      if (!a.title?.trim()) return 'error: title required'
      const gargs = ['pr', 'create', '--title', a.title, '--body', a.body || '']
      if (a.base) gargs.push('--base', a.base)
      if (a.draft) gargs.push('--draft')
      return fmt(await gh(cwd, gargs))
    }
    case 'CommentIssue': {
      if (!(await ghAvailable(cwd))) return 'error: gh CLI is not installed'
      const a = args as { number: number; body: string; pr?: boolean }
      if (a.number == null || !a.body?.trim()) return 'error: number and body required'
      return fmt(await gh(cwd, [a.pr ? 'pr' : 'issue', 'comment', String(a.number), '--body', a.body]))
    }

    // ── memory ──
    case 'RememberNote': {
      const a = args as { text: string }
      if (!a.text?.trim()) return 'error: text required'
      const notes = loadNotes()
      notes.push({ ts: db.nowStampLocal(), text: a.text.trim() })
      saveNotes(notes)
      return `remembered (${Math.min(notes.length, 200)} notes total)`
    }
    case 'RecallNotes': {
      const a = args as { query?: string }
      let notes = loadNotes()
      if (a.query?.trim()) { const q = a.query.toLowerCase(); notes = notes.filter((n) => n.text.toLowerCase().includes(q)) }
      if (!notes.length) return a.query ? `no notes matching "${a.query}"` : 'no notes saved yet'
      return notes.slice(-30).map((n) => `- [${n.ts}] ${n.text}`).join('\n')
    }

    // ── web ──
    case 'WebFetch': {
      const a = args as { url: string; as?: string }
      return await webFetch(a.url, a.as || 'text')
    }
    case 'WebSearch':
      return await webSearch((args as { query: string }).query || '')

    // ── utilities ──
    case 'TodoWrite': {
      const a = args as { todos: { content: string; status: string }[] }
      if (!Array.isArray(a.todos)) return 'error: todos must be an array'
      ctx.emitTodos?.(a.todos)
      const done = a.todos.filter((t) => t.status === 'completed').length
      return `recorded ${a.todos.length} todo(s), ${done} completed`
    }
    case 'BashBackground': {
      const a = args as { command: string }
      if (!a.command?.trim()) return 'error: command required'
      const id = startBackground(cwd, a.command)
      return `started background job ${id}. Use BashOutput("${id}") to read output, KillBash("${id}") to stop.`
    }
    case 'BashOutput': {
      const a = args as { job_id: string }
      const job = bgJobs.get(a.job_id)
      if (!job) return `error: no job ${a.job_id}`
      const status = job.done ? `exited (code ${job.exitCode})` : 'running'
      const out = job.output.length > 6000 ? job.output.slice(-6000) : job.output
      return `[${job.id}] ${status}\n${out || '(no output yet)'}`
    }
    case 'KillBash': {
      const a = args as { job_id: string }
      const job = bgJobs.get(a.job_id)
      if (!job) return `error: no job ${a.job_id}`
      if (job.done) return `job ${a.job_id} already exited (code ${job.exitCode})`
      try { job.proc.kill() } catch { /* ignore */ }
      return `killed job ${a.job_id}`
    }
  }
  return `error: unhandled extra tool ${name}`
}

// Apply a saved profile: set local git identity, optional remote, optional gh
// account. Confirmation already happened in runExtraTool.
async function switchGitAccount(cwd: string, label: string): Promise<string> {
  if (!label?.trim()) return 'error: profile label required'
  const p = db.getGitProfile(label)
  if (!p) return `error: no profile "${label}". Use ListGitProfiles to see saved profiles.`
  const steps: string[] = []
  const nm = await git(cwd, ['config', '--local', 'user.name', p.user_name])
  steps.push(nm.ok ? `✓ user.name = ${p.user_name}` : `✗ user.name: ${nm.stderr.trim()}`)
  const em = await git(cwd, ['config', '--local', 'user.email', p.user_email])
  steps.push(em.ok ? `✓ user.email = ${p.user_email}` : `✗ user.email: ${em.stderr.trim()}`)
  if (p.remote_url) {
    const setRes = await git(cwd, ['remote', 'set-url', 'origin', p.remote_url])
    if (setRes.ok) steps.push(`✓ origin -> ${p.remote_url}`)
    else {
      const addRes = await git(cwd, ['remote', 'add', 'origin', p.remote_url])
      steps.push(addRes.ok ? `✓ added origin -> ${p.remote_url}` : `✗ origin: ${setRes.stderr.trim()}`)
    }
  }
  if (p.gh_account) {
    if (await ghAvailable(cwd)) {
      const sw = await gh(cwd, ['auth', 'switch', '--user', p.gh_account])
      steps.push(sw.ok ? `✓ gh account -> ${p.gh_account}` : `✗ gh switch: ${sw.stderr.trim() || 'not logged into that account'}`)
    } else {
      steps.push('• gh CLI not installed — skipped GitHub account switch')
    }
  }
  return `switched to profile "${label}":\n${steps.join('\n')}`
}

// Build a human-readable preview (title + concrete command) for the confirm UI.
async function previewSensitive(
  name: string,
  args: any,
): Promise<{ title: string; detail: string }> {
  switch (name) {
    case 'GitAdd':
      return { title: 'Stage files', detail: args.all ? 'git add -A' : `git add -- ${(args.paths || []).join(' ')}` }
    case 'GitCommit':
      return { title: 'Create a commit', detail: `git commit ${args.all ? '-a ' : ''}-m ${JSON.stringify(args.message || '')}` }
    case 'GitPush':
      return {
        title: 'Push to remote',
        detail: `git push${args.set_upstream ? ' -u' : ''}${args.remote ? ' ' + args.remote : ''}${args.branch ? ' ' + args.branch : ''}`,
      }
    case 'GitPull':
      return { title: 'Pull from remote', detail: `git pull${args.remote ? ' ' + args.remote : ''}${args.branch ? ' ' + args.branch : ''}` }
    case 'GitCheckout':
      return { title: `Switch branch${args.create ? ' (new)' : ''}`, detail: `git checkout ${args.create ? '-b ' : ''}${args.branch}` }
    case 'CreatePR':
      return { title: 'Open a pull request', detail: `gh pr create --title ${JSON.stringify(args.title || '')}${args.base ? ' --base ' + args.base : ''}${args.draft ? ' --draft' : ''}` }
    case 'CommentIssue':
      return { title: `Comment on ${args.pr ? 'PR' : 'issue'} #${args.number}`, detail: `gh ${args.pr ? 'pr' : 'issue'} comment ${args.number} --body ${JSON.stringify(args.body || '')}` }
    case 'GitConfigSet': {
      const scope = args.scope === 'global' ? 'global' : 'local'
      const parts: string[] = []
      if (args.user_name) parts.push(`user.name = ${args.user_name}`)
      if (args.user_email) parts.push(`user.email = ${args.user_email}`)
      return { title: `Change git identity (${scope})`, detail: parts.join('\n') }
    }
    case 'GitRemoteSet':
      return { title: 'Set git remote URL', detail: `git remote set-url ${args.name || 'origin'} ${args.url}` }
    case 'SwitchGitAccount': {
      const p = db.getGitProfile(args.profile)
      const detail = p
        ? `Profile "${p.label}":\n  user.name = ${p.user_name}\n  user.email = ${p.user_email}` +
          (p.remote_url ? `\n  origin -> ${p.remote_url}` : '') +
          (p.gh_account ? `\n  gh account -> ${p.gh_account}` : '')
        : `Profile "${args.profile}" (not found)`
      return { title: 'Switch git account', detail }
    }
    case 'GitHubAuthSwitch':
      return { title: 'Switch GitHub account (gh)', detail: `gh auth switch --user ${args.account}` }
    case 'GitHubLogin':
      return {
        title: 'Log in to GitHub (gh)',
        detail: args.token ? 'gh auth login --with-token  (token provided)' : 'gh auth login (interactive)',
      }
    case 'BashBackground':
      return { title: 'Run a background command', detail: args.command || '' }
    default:
      return { title: name, detail: JSON.stringify(args) }
  }
}
