// agent-runtime.ts — runs one multi-agent role using an API backend (Node/TS).
//
// This is the TypeScript port of the former scripts/agent_runtime.py. It is a
// standalone Node entry point spawned as a child process by the Electron main
// process (one per role). It:
//   - reads agents/<role>/AGENT.md as the system prompt (+ PROTOCOL_APPENDIX),
//   - polls the SQLite messages table (shared/state.db) for unread messages,
//   - dispatches each to the configured LLM with a Read/Write/Edit/Bash/Grep/
//     Glob + SendMessage/ListTasks/CreateTask/UpdateTask tool kit,
//   - records usage/logs back into the same DB.
//
// API-only: providers are defined in shared/agents-config.json under
// "providers" (kind: anthropic | openai | openai-compatible; base_url for
// gateways like VietAPI). API keys arrive via env MULTIAGENT_KEY_<PROVIDER>,
// injected by the main process from the encrypted secrets table.
//
// Usage:  electron/node agent-runtime.js --role <role>
//   (spawned as: process.execPath agent-runtime.js --role <role> with
//    ELECTRON_RUN_AS_NODE=1 so Electron runs it as a plain Node script)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import * as db from './db'
import { contextWindowFor } from './context-window'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dist-electron/agent-runtime.js → ROOT is three levels up
// (dist-electron → frontend → project → repo root).
const ROOT = path.resolve(__dirname, '..', '..', '..')
const SHARED = path.join(ROOT, 'shared')
const AGENTS = path.join(ROOT, 'agents')

const POLL_INTERVAL_MS = 2000
const MAX_TURNS = parseInt(process.env.MULTIAGENT_MAX_TURNS || '25', 10)
const BASH_TIMEOUT_MS = 120_000

const PROTOCOL_APPENDIX = `

---

# RUNTIME PROTOCOL (API mode) — overrides any file-based instructions above

You run via a direct API backend. All coordination state lives in a SQLite
database, not in markdown/JSON files. IGNORE older instructions that tell you to
read/write \`shared/inbox/*.md\`, \`shared/outbox/*.md\`, \`shared/tasks.json\`, or
\`shared/logs/*.log\` by hand. Use these tools instead:

- **SendMessage(to, body, task_id?, subject?, priority?)** — message another
  agent. This is the ONLY way to communicate. Workers report to \`orchestrator\`;
  the orchestrator routes to workers. Do not edit inbox files.
- **ListTasks(status?)** — read the task board.
- **CreateTask(title, owner, priority?, deps?, parent_id?)** — orchestrator only.
- **UpdateTask(task_id, status, artifact?)** — orchestrator only. Status is one
  of todo|in_progress|review|done|blocked|waiting_children.

The message you are processing was delivered from the DB inbox; it is marked
processed automatically when you finish this turn. Your activity is logged
automatically — you do not need to append to any log file.

Code lives under \`project/\`. Use Read/Write/Edit/Bash/Grep/Glob for code as
usual. Your role here is: {role}.
`

// USD per million tokens (input, output). Fallback for known model ids; custom
// gateway models default to 0 unless the provider declares price_in/price_out.
const PRICING_USD_PER_MTOK: Record<string, [number, number]> = {
  'claude-opus-4-7': [15.0, 75.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-haiku-4-5': [0.8, 4.0],
  'gpt-5': [1.25, 10.0],
  'gpt-5-codex': [10.0, 30.0],
  'gpt-5-mini': [0.25, 2.0],
  'gemini-2.5-pro': [1.25, 10.0],
  'gemini-2.5-flash': [0.3, 2.5],
  'lm-studio-local': [0.0, 0.0],
}

function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  rates?: [number, number] | null,
): number {
  const [inRate, outRate] = rates ?? PRICING_USD_PER_MTOK[model] ?? [0, 0]
  return (tokensIn * inRate + tokensOut * outRate) / 1_000_000
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── Tools ────────────────────────────────────────────────────────
// File tools operate relative to process.cwd() (set to the workspace root in
// main()). DB tools operate on the shared state.db via the db module.

let CTX_ROLE = ''

function toolRead(a: { path: string; limit?: number; offset?: number }): string {
  const p = path.resolve(process.cwd(), a.path)
  const text = fs.readFileSync(p, 'utf-8')
  if (a.limit == null && !a.offset) return text
  let lines = text.split('\n')
  if (a.offset) lines = lines.slice(a.offset)
  if (a.limit) lines = lines.slice(0, a.limit)
  return lines.join('\n')
}

function toolWrite(a: { path: string; content: string }): string {
  const p = path.resolve(process.cwd(), a.path)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, a.content, 'utf-8')
  return `wrote ${a.content.length} chars to ${a.path}`
}

function toolEdit(a: { path: string; old_string: string; new_string: string; replace_all?: boolean }): string {
  const p = path.resolve(process.cwd(), a.path)
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

function toolBash(a: { command: string }): string {
  try {
    const out = execSync(a.command, {
      cwd: process.cwd(),
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

function toolGrep(a: { pattern: string; path?: string; glob?: string }): string {
  const searchPath = a.path || '.'
  try {
    const cmd = ['rg', '--no-heading', '-n', JSON.stringify(a.pattern), JSON.stringify(searchPath)]
    if (a.glob) cmd.push('--glob', JSON.stringify(a.glob))
    const out = execSync(cmd.join(' '), { encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
    return (out || 'no matches').slice(0, 4000)
  } catch (e: any) {
    // rg exits non-zero when no matches; treat as empty. Only fall back on ENOENT.
    if (e?.code === 'ENOENT') {
      return grepFallback(a.pattern, searchPath)
    }
    const out = String(e?.stdout ?? '')
    return (out || 'no matches').slice(0, 4000)
  }
}

function grepFallback(pattern: string, searchPath: string): string {
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
  walk(path.resolve(process.cwd(), searchPath))
  return out.join('\n').slice(0, 4000) || 'no matches'
}

function toolGlob(a: { pattern: string }): string {
  // Minimal glob: support **/*.ext and *.ext style by walking + matching.
  const matches: string[] = []
  const base = process.cwd()
  const rx = globToRegex(a.pattern)
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const fp = path.join(dir, ent.name)
      const rel = path.relative(base, fp).split(path.sep).join('/')
      if (ent.isDirectory()) { walk(fp); continue }
      if (rx.test(rel)) matches.push(rel)
      if (matches.length >= 200) return
    }
  }
  walk(base)
  return matches.sort().join('\n') || 'no matches'
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const re = esc
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${re}$`)
}

// DB-aware tools.
function toolSendMessage(a: { to: string; body: string; task_id?: string; subject?: string; priority?: string }): string {
  const mid = db.addMessage({
    ts: nowStamp(),
    from_role: CTX_ROLE,
    to_role: a.to,
    body: a.body,
    task_id: a.task_id || null,
    subject: a.subject || null,
    priority: a.priority || null,
    status: 'unread',
  })
  return `sent message id=${mid} to ${a.to}` + (a.task_id ? ` (task ${a.task_id})` : '')
}

function toolListTasks(a: { status?: string }): string {
  let tasks = db.getTasks().tasks
  if (a.status) tasks = tasks.filter((t) => t.status === a.status)
  if (tasks.length === 0) return 'no tasks'
  return tasks
    .map(
      (t) =>
        `${t.id} [${t.status}] owner=${t.owner} deps=${JSON.stringify(t.deps)} ` +
        `parent=${t.parent_id || '-'} :: ${t.title}`,
    )
    .join('\n')
}

function toolCreateTask(a: { title: string; owner: string; priority?: string; deps?: string[]; parent_id?: string }): string {
  if (CTX_ROLE !== 'orchestrator') return 'error: only the orchestrator may create tasks'
  try {
    const tid = db.createTask({
      title: a.title,
      owner: a.owner,
      priority: (a.priority as 'low' | 'medium' | 'high') || 'medium',
      deps: a.deps || [],
      parent_id: a.parent_id || null,
    })
    return `created ${tid} owner=${a.owner}`
  } catch (e: any) {
    return `error: ${e?.message || e}`
  }
}

function toolUpdateTask(a: { task_id: string; status: string; artifact?: string }): string {
  if (CTX_ROLE !== 'orchestrator') return 'error: only the orchestrator may update tasks'
  const ok = db.updateTaskStatus(a.task_id, a.status, a.artifact || null)
  return ok ? `updated ${a.task_id} -> ${a.status}` : `error: task ${a.task_id} not found or invalid status`
}

// ── group signal tools (v2, group mode only) ─────────────────────
// These do NOT act on their own. They write group_memory + set a `signal` on
// the group row, then end the session. The GroupCoordinator (main process)
// reads the signal and owns every real transition (spawn/kill/budget/retry).

// Set by runGroupSession(). When a group tool fires, it stores the signal here
// and the session loop breaks after the current turn.
let CTX_GROUP: string | null = null
let CTX_GROUP_TASK = ''
let CTX_GROUP_KIND: 'worker' | 'reviewer' | '' = ''
let GROUP_SIGNAL: string | null = null

function toolRequestReview(a: { summary: string }): string {
  if (!CTX_GROUP) return 'error: RequestReview is only available inside a group session'
  if (CTX_GROUP_KIND !== 'worker') return 'error: only the worker may request review'
  db.addGroupMemory({
    group_id: CTX_GROUP,
    task_id: CTX_GROUP_TASK || null,
    role: 'worker',
    kind: 'progress_note',
    content: a.summary || '(no summary provided)',
  })
  GROUP_SIGNAL = 'request_review'
  return 'review requested; the coordinator will spawn a reviewer. Ending your session now.'
}

function toolSubmitReview(a: { verdict: string; report?: string }): string {
  if (!CTX_GROUP) return 'error: SubmitReview is only available inside a group session'
  if (CTX_GROUP_KIND !== 'reviewer') return 'error: only the reviewer may submit a review'
  const verdict = (a.verdict || '').toLowerCase()
  if (verdict !== 'pass' && verdict !== 'fail') {
    return 'error: verdict must be "pass" or "fail"'
  }
  if (verdict === 'fail' && !(a.report && a.report.trim())) {
    return 'error: a fail verdict requires a report describing what is wrong and how to fix it'
  }
  db.addGroupMemory({
    group_id: CTX_GROUP,
    task_id: CTX_GROUP_TASK || null,
    role: 'reviewer',
    kind: 'review_report',
    content: `verdict=${verdict}\n${a.report || '(no detail)'}`,
  })
  GROUP_SIGNAL = `verdict:${verdict}`
  return `review submitted: ${verdict}. Ending your session now.`
}

function toolDispatchTask(a: { title: string; note?: string }): string {
  if (!CTX_GROUP) return 'error: DispatchTask is only available inside a group session'
  if (CTX_GROUP_KIND !== 'worker') return 'error: only the worker may dispatch sub-tasks'
  if (!(a.title && a.title.trim())) return 'error: title is required'
  db.addGroupMemory({
    group_id: CTX_GROUP,
    task_id: CTX_GROUP_TASK || null,
    role: 'worker',
    kind: 'dispatch',
    content: JSON.stringify({ title: a.title, note: a.note || '' }),
  })
  GROUP_SIGNAL = 'dispatch'
  return 'sub-task dispatched to the coordinator. Ending your session now.'
}

// Escape hatch: the worker declares the task impossible/blocked. The coordinator
// fails the group immediately — no reviewer, no retry — so an unachievable task
// stops burning retries instead of looping to the cap. Reason is REQUIRED.
function toolReportBlocked(a: { reason: string }): string {
  if (!CTX_GROUP) return 'error: ReportBlocked is only available inside a group session'
  if (CTX_GROUP_KIND !== 'worker') return 'error: only the worker may report a task blocked'
  if (!(a.reason && a.reason.trim())) {
    return 'error: reason is required — explain concretely why the task cannot be completed'
  }
  db.addGroupMemory({
    group_id: CTX_GROUP,
    task_id: CTX_GROUP_TASK || null,
    role: 'worker',
    kind: 'blocked',
    content: a.reason.trim(),
  })
  GROUP_SIGNAL = `blocked:${a.reason.trim().slice(0, 200)}`
  return 'task reported as blocked; the coordinator will stop this group without retrying. Ending your session now.'
}

const TOOLS: Record<string, (args: any) => string> = {
  Read: toolRead, Write: toolWrite, Edit: toolEdit,
  Bash: toolBash, Grep: toolGrep, Glob: toolGlob,
  SendMessage: toolSendMessage, ListTasks: toolListTasks,
  CreateTask: toolCreateTask, UpdateTask: toolUpdateTask,
  RequestReview: toolRequestReview, SubmitReview: toolSubmitReview,
  DispatchTask: toolDispatchTask, ReportBlocked: toolReportBlocked,
}

interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'Read',
    description: 'Read a file. Paths are relative to the workspace root.',
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
    description: 'Replace old_string with new_string in path. Use replace_all=true for multi-occurrence.',
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
    description: 'Run a shell command in cwd with a 120s timeout. Returns exit code + last 4KB of output.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'Grep',
    description: 'Recursively search a regex pattern under path (uses ripgrep when available).',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'List files matching a glob pattern relative to cwd.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'SendMessage',
    description:
      "Send a message to another agent's inbox. Use this to report progress, hand off work, or reply to " +
      'the orchestrator. Workers talk only via the orchestrator.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'recipient role, e.g. orchestrator, backend-engineer' },
        body: { type: 'string' },
        task_id: { type: 'string', description: 'T-XXX this message relates to (optional)' },
        subject: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'ListTasks',
    description:
      'List tasks on the board, optionally filtered by status (todo|in_progress|review|done|blocked|waiting_children).',
    input_schema: { type: 'object', properties: { status: { type: 'string' } }, required: [] },
  },
  {
    name: 'CreateTask',
    description:
      'Create a task on the board. Orchestrator only. Pass parent_id to make it a child (HTN depth cap = 2). ' +
      'Returns the new T-XXX id.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        owner: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        deps: { type: 'array', items: { type: 'string' } },
        parent_id: { type: 'string' },
      },
      required: ['title', 'owner'],
    },
  },
  {
    name: 'UpdateTask',
    description:
      'Update a task\'s status. Orchestrator only. status one of todo|in_progress|review|done|blocked|waiting_children. artifact optional path.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, status: { type: 'string' }, artifact: { type: 'string' } },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'RequestReview',
    description:
      'Worker only, group mode. Call when your part of the task is done and needs review. Provide a short ' +
      'summary of what you did and what remains. This ends your session; the coordinator spawns a reviewer.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'what you did, files touched, anything left' } },
      required: ['summary'],
    },
  },
  {
    name: 'SubmitReview',
    description:
      'Reviewer only, group mode. Submit your verdict: pass or fail. On fail, report is REQUIRED and must ' +
      'say what is wrong (file/line), why, and how to fix it. This ends your session.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        report: { type: 'string', description: 'required on fail: concrete defects + fix direction' },
      },
      required: ['verdict'],
    },
  },
  {
    name: 'DispatchTask',
    description:
      'Worker only, group mode. Propose splitting off a sub-task that deserves its own group. The coordinator ' +
      'decides whether to spawn a sub-group (respecting recursion depth and budget). This ends your session.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        note: { type: 'string', description: 'context for the sub-group worker' },
      },
      required: ['title'],
    },
  },
  {
    name: 'ReportBlocked',
    description:
      'Worker only, group mode. Use ONLY when the task genuinely cannot be completed (missing prerequisites, ' +
      'contradictory/impossible requirements, needed access or file absent). This fails the group immediately ' +
      'with no reviewer and no retry — do NOT use it to avoid hard work. reason is REQUIRED: state concretely ' +
      'what blocks the task. This ends your session.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'concrete reason the task is impossible' } },
      required: ['reason'],
    },
  },
]

// ── Provider adapters ────────────────────────────────────────────
// Each adapter exposes chat() → { text, toolCalls, assistantMsg, usage } and
// toolResultsMessages() to append tool outputs back into the conversation.

interface ToolCall { id: string; name: string; args: Record<string, unknown> }
interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  assistantMsg: unknown
  usage: { input: number; output: number }
}
interface Adapter {
  model: string
  chat(messages: unknown[], system: string): Promise<ChatResult>
  toolResultsMessages(toolCalls: ToolCall[], results: string[]): unknown[]
}

class OpenAIAdapter implements Adapter {
  model: string
  private baseUrl: string
  private key: string
  private tools: unknown[]

  constructor(model: string, baseUrl: string | undefined, key: string) {
    this.model = model || 'gpt-5'
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.key = key || 'no-key'
    this.tools = TOOL_SPECS.map((s) => ({
      type: 'function',
      function: { name: s.name, description: s.description, parameters: s.input_schema },
    }))
  }

  async chat(messages: unknown[], system: string): Promise<ChatResult> {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: system }, ...messages],
      tools: this.tools,
      tool_choice: 'auto',
      max_tokens: 8192,
    }
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
    }
    const json: any = await resp.json()
    const msg = json.choices?.[0]?.message ?? {}
    const toolCalls: ToolCall[] = []
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { /* leave empty */ }
        toolCalls.push({ id: tc.id, name: tc.function?.name, args })
      }
    }
    let text: string = msg.content || ''
    // Reasoning models may put the answer in reasoning_content when content is empty.
    if (!text && toolCalls.length === 0) {
      text = msg.reasoning_content || msg.reasoning || ''
    }
    const assistantMsg: any = { role: 'assistant', content: text }
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }))
    }
    const usage = {
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
    }
    return { text, toolCalls, assistantMsg, usage }
  }

  toolResultsMessages(toolCalls: ToolCall[], results: string[]): unknown[] {
    return toolCalls.map((tc, i) => ({ role: 'tool', tool_call_id: tc.id, content: String(results[i]) }))
  }
}

class AnthropicAdapter implements Adapter {
  model: string
  private baseUrl: string
  private key: string
  private tools: unknown[]

  constructor(model: string, key: string, baseUrl?: string) {
    this.model = model || 'claude-sonnet-4-6'
    this.baseUrl = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
    this.key = key
    this.tools = TOOL_SPECS.map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: s.input_schema,
    }))
  }

  async chat(messages: unknown[], system: string): Promise<ChatResult> {
    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        system,
        tools: this.tools,
        messages,
      }),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
    }
    const json: any = await resp.json()
    const textParts: string[] = []
    const toolCalls: ToolCall[] = []
    for (const block of json.content ?? []) {
      if (block.type === 'text') textParts.push(block.text)
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} })
    }
    const usage = {
      input: json.usage?.input_tokens ?? 0,
      output: json.usage?.output_tokens ?? 0,
    }
    return {
      text: textParts.join('\n'),
      toolCalls,
      assistantMsg: { role: 'assistant', content: json.content },
      usage,
    }
  }

  toolResultsMessages(toolCalls: ToolCall[], results: string[]): unknown[] {
    return [
      {
        role: 'user',
        content: toolCalls.map((tc, i) => ({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: String(results[i]),
        })),
      },
    ]
  }
}

// ── config / provider resolution ─────────────────────────────────

interface ProviderCfg { kind?: string; base_url?: string; models?: string[]; price_in?: number; price_out?: number; context_window?: number; context_windows?: Record<string, number> }
interface AgentCfg { provider?: string; model?: string }
interface Config { providers?: Record<string, ProviderCfg>; agents?: Record<string, AgentCfg> }

function apiKeyFor(providerId: string): string {
  const envName = 'MULTIAGENT_KEY_' + providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return process.env[envName] || ''
}

function buildAdapter(providerCfg: ProviderCfg, providerId: string, model: string): Adapter {
  const kind = providerCfg.kind || 'openai-compatible'
  const key = apiKeyFor(providerId)
  if (kind === 'anthropic') return new AnthropicAdapter(model, key, providerCfg.base_url)
  if (kind === 'openai' || kind === 'openai-compatible') {
    return new OpenAIAdapter(model, providerCfg.base_url, key)
  }
  throw new Error(`agent-runtime does not handle provider kind: ${kind}`)
}

function priceRates(providerCfg: ProviderCfg): [number, number] | null {
  if (providerCfg.price_in != null || providerCfg.price_out != null) {
    return [Number(providerCfg.price_in ?? 0), Number(providerCfg.price_out ?? 0)]
  }
  return null
}

// ── message handling ─────────────────────────────────────────────

async function handleMessage(
  role: string,
  adapter: Adapter,
  systemPrompt: string,
  msgRow: db.MessageRow,
  rates: [number, number] | null,
): Promise<void> {
  const taskId = msgRow.task_id || ''
  const header =
    `FROM: ${msgRow.from_role} | TASK: ${taskId || 'none'}\n` +
    `Subject: ${msgRow.subject || ''}\n\n`
  const messages: unknown[] = [{ role: 'user', content: header + msgRow.body }]
  const model = adapter.model
  let finalText = ''
  let totalIn = 0
  let totalOut = 0
  let turns = 0

  for (let i = 0; i < MAX_TURNS; i++) {
    const { text, toolCalls, assistantMsg, usage } = await adapter.chat(messages, systemPrompt)
    turns++
    totalIn += usage.input
    totalOut += usage.output
    db.addUsage({
      ts: nowStamp(),
      role,
      model,
      tokens_in: usage.input,
      tokens_out: usage.output,
      cost_usd: estimateCostUsd(model, usage.input, usage.output, rates),
      task_id: taskId || null,
    })
    if (text) finalText = text
    if (toolCalls.length === 0) break

    const results: string[] = []
    for (const call of toolCalls) {
      const fn = TOOLS[call.name]
      if (!fn) { results.push(`error: unknown tool ${call.name}`); continue }
      try {
        results.push(fn(call.args))
      } catch (e: any) {
        results.push(`error: ${e?.constructor?.name || 'Error'}: ${e?.message || e}`)
      }
      db.addLog(role, `tool_call ${call.name}`, nowStamp())
    }
    messages.push(assistantMsg)
    for (const m of adapter.toolResultsMessages(toolCalls, results)) messages.push(m)
  }

  db.markProcessed(msgRow.id, nowStamp())
  const totalCost = estimateCostUsd(model, totalIn, totalOut, rates)
  db.addLog(
    role,
    `message_done turns=${turns} total_in=${totalIn} total_out=${totalOut} ` +
      `total_cost=$${totalCost.toFixed(4)}` + (taskId ? ` task=${taskId}` : ''),
    nowStamp(),
  )
  if (finalText) console.log(`[${role}] response: ${finalText.slice(0, 240)}`)
}

// ── main loop ────────────────────────────────────────────────────

interface Args {
  role: string
  group: string | null
  groupKind: 'worker' | 'reviewer' | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null
  }
  const role = get('--role')
  if (!role) {
    console.error('usage: agent-runtime --role <role> [--group <G-id> --group-kind worker|reviewer]')
    process.exit(1)
  }
  const group = get('--group')
  const gk = get('--group-kind')
  const groupKind = gk === 'reviewer' ? 'reviewer' : gk === 'worker' ? 'worker' : group ? 'worker' : null
  return { role, group, groupKind }
}

// Resolve provider/adapter/system-prompt for a role. Shared by both modes.
function setupRole(role: string): {
  adapter: Adapter
  systemPrompt: string
  rates: [number, number] | null
  model: string
  providerId: string
  providerCfg: ProviderCfg
} {
  const agentDir = path.join(AGENTS, role)
  if (!fs.existsSync(agentDir)) { console.error(`agent dir not found: ${agentDir}`); process.exit(1) }

  const cfg: Config = JSON.parse(fs.readFileSync(path.join(SHARED, 'agents-config.json'), 'utf-8'))
  const agentCfg = cfg.agents?.[role]
  if (!agentCfg) { console.error(`no config for role ${role}`); process.exit(1) }

  const providerId = agentCfg.provider || ''
  const model = agentCfg.model || ''
  const providerCfg: ProviderCfg = cfg.providers?.[providerId] || { kind: 'openai-compatible' }
  const adapter = buildAdapter(providerCfg, providerId, model)
  const rates = priceRates(providerCfg)

  const agentMd = path.join(agentDir, 'AGENT.md')
  if (!fs.existsSync(agentMd)) { console.error(`AGENT.md missing in ${agentDir}`); process.exit(1) }
  const systemPrompt = fs.readFileSync(agentMd, 'utf-8') + PROTOCOL_APPENDIX.replace('{role}', role)

  return { adapter, systemPrompt, rates, model, providerId, providerCfg }
}

function chdirWorkspace(): void {
  const ws = db.getMeta('workspace_root')
  const workdir = ws && fs.existsSync(ws) ? ws : ROOT
  process.chdir(workdir)
}

// ── group session (one-shot: load memory → tool loop → signal → exit) ─────
//
// Group agents (worker/reviewer) run exactly one session and exit. They do NOT
// poll the inbox. They read the task + latest progress_note + review_report
// from group_memory, run the tool loop, and set a `signal` on the group row via
// RequestReview/SubmitReview/DispatchTask. The GroupCoordinator owns everything
// that happens next. On exit code 0, look at groups.signal.

const GROUP_PROTOCOL = `

---

# GROUP MODE

You are running as the **{kind}** of group {group} on task {task_id}. You run a
SINGLE session then exit — you do NOT poll an inbox. Coordination is handled by
the code-level coordinator, not by messaging other agents.

- If you are the **worker**: do the coding work. When your part is done (or you
  need it checked), call **RequestReview(summary)**. If the task is too big and a
  chunk deserves its own group, call **DispatchTask(title, note)**. If the task
  genuinely CANNOT be done (missing prerequisites, impossible/contradictory
  requirements, needed file or access absent), call **ReportBlocked(reason)** —
  this stops the group without retrying. Do NOT use it to dodge hard work. Do NOT
  call SendMessage/CreateTask/UpdateTask — those are for the resident orchestrator.
- If you are the **reviewer**: inspect the worker's output against the task, then
  call **SubmitReview(verdict, report)**. On fail, the report is the handoff the
  next worker reads, so be concrete (file/line, why, how to fix).

Calling your signal tool ENDS the session. If you finish without calling one,
the coordinator treats it as an implicit request-for-review using your progress.
`

function buildGroupPrompt(basePrompt: string, kind: string, groupId: string, taskId: string): string {
  return basePrompt + GROUP_PROTOCOL
    .replace('{kind}', kind)
    .replace('{group}', groupId)
    .replace(/\{task_id\}/g, taskId)
}

function buildGroupUserMessage(g: db.GroupRow, kind: 'worker' | 'reviewer'): string {
  const task = db.getTask(g.task_id)
  const lines: string[] = []
  lines.push(`TASK ${g.task_id}: ${task?.title || '(unknown)'}`)
  if (task?.priority) lines.push(`Priority: ${task.priority}`)
  lines.push('')

  const progress = db.latestGroupMemory(g.id, 'progress_note')
  const report = db.latestGroupMemory(g.id, 'review_report')

  if (kind === 'worker') {
    if (report) {
      lines.push('A previous review FAILED. Fix these findings, then RequestReview again:')
      lines.push(report.content)
      lines.push('')
    }
    if (progress) {
      lines.push('Latest progress note (where work was left off):')
      lines.push(progress.content)
      lines.push('')
    }
    if (!report && !progress) {
      lines.push('Fresh start. Implement the task, then call RequestReview with a summary.')
    }
  } else {
    lines.push('Review the current state of the work for this task.')
    if (progress) {
      lines.push('')
      lines.push("Worker's progress note (what they claim to have done):")
      lines.push(progress.content)
    }
    lines.push('')
    lines.push('Inspect the actual files, then call SubmitReview with pass or fail.')
  }
  return lines.join('\n')
}

async function runGroupSession(args: Args): Promise<void> {
  const { role, group: groupId, groupKind } = args
  if (!groupId || !groupKind) { console.error('group mode requires --group and a kind'); process.exit(1) }
  CTX_ROLE = role
  CTX_GROUP = groupId
  CTX_GROUP_KIND = groupKind

  const { adapter, systemPrompt, rates, model, providerCfg } = setupRole(role)
  const contextWindow = contextWindowFor(model, providerCfg)
  let peakContext = 0
  db.initDb(SHARED)
  chdirWorkspace()

  const g = db.getGroup(groupId)
  if (!g) { console.error(`group ${groupId} not found`); process.exit(1) }
  CTX_GROUP_TASK = g.task_id

  // Clear any stale signal and register our PID + heartbeat for this session.
  const pidField = groupKind === 'worker' ? 'worker_pid' : 'reviewer_pid'
  db.updateGroupFields(groupId, { signal: null, [pidField]: process.pid, heartbeat_at: nowStamp() } as any)

  const prompt = buildGroupPrompt(systemPrompt, groupKind, groupId, g.task_id)
  const userMsg = buildGroupUserMessage(g, groupKind)
  const messages: unknown[] = [{ role: 'user', content: userMsg }]

  console.log(`[${role}#${groupId}] group session start kind=${groupKind} model=${model}`)
  db.addLog(role, `group_session_start ${groupId} kind=${groupKind}`, nowStamp())

  let totalIn = 0
  let totalOut = 0
  let turns = 0

  for (let i = 0; i < MAX_TURNS; i++) {
    const { text, toolCalls, assistantMsg, usage } = await adapter.chat(messages, prompt)
    turns++
    totalIn += usage.input
    totalOut += usage.output
    if (usage.input > peakContext) peakContext = usage.input
    db.addUsage({
      ts: nowStamp(),
      role,
      model,
      tokens_in: usage.input,
      tokens_out: usage.output,
      cost_usd: estimateCostUsd(model, usage.input, usage.output, rates),
      task_id: g.task_id || null,
      group_id: groupId,
    })
    db.updateGroupFields(groupId, {
      heartbeat_at: nowStamp(),
      peak_context: peakContext,
      context_window: contextWindow,
    })

    if (toolCalls.length === 0) {
      if (text) console.log(`[${role}#${groupId}] said: ${text.slice(0, 200)}`)
      break
    }

    const results: string[] = []
    for (const call of toolCalls) {
      const fn = TOOLS[call.name]
      if (!fn) { results.push(`error: unknown tool ${call.name}`); continue }
      try {
        results.push(fn(call.args))
      } catch (e: any) {
        results.push(`error: ${e?.constructor?.name || 'Error'}: ${e?.message || e}`)
      }
      db.addLog(role, `tool_call ${call.name} (${groupId})`, nowStamp())
    }
    messages.push(assistantMsg)
    for (const m of adapter.toolResultsMessages(toolCalls, results)) messages.push(m)

    if (GROUP_SIGNAL) break
  }

  // Fallback: session ended without an explicit signal. Treat a worker as
  // implicitly requesting review (using whatever progress it recorded); a
  // reviewer with no verdict is a soft fail so the coordinator can retry.
  if (!GROUP_SIGNAL) {
    if (groupKind === 'worker') {
      if (!db.latestGroupMemory(groupId, 'progress_note')) {
        db.addGroupMemory({
          group_id: groupId, task_id: g.task_id, role: 'worker',
          kind: 'progress_note', content: '(worker ended without a summary)',
        })
      }
      GROUP_SIGNAL = 'request_review'
    } else {
      db.addGroupMemory({
        group_id: groupId, task_id: g.task_id, role: 'reviewer',
        kind: 'review_report', content: 'verdict=fail\n(reviewer ended without submitting a verdict)',
      })
      GROUP_SIGNAL = 'verdict:fail'
    }
  }

  db.updateGroupFields(groupId, { signal: GROUP_SIGNAL, [pidField]: null } as any)
  const totalCost = estimateCostUsd(model, totalIn, totalOut, rates)
  db.addLog(
    role,
    `group_session_done ${groupId} signal=${GROUP_SIGNAL} turns=${turns} ` +
      `in=${totalIn} out=${totalOut} cost=$${totalCost.toFixed(4)}`,
    nowStamp(),
  )
  console.log(`[${role}#${groupId}] session done signal=${GROUP_SIGNAL} cost=$${totalCost.toFixed(4)}`)
}

// ── resident mode (planner/orchestrator: poll inbox forever) ─────

async function runResident(role: string): Promise<void> {
  CTX_ROLE = role
  const { adapter, systemPrompt, rates, model, providerId } = setupRole(role)
  db.initDb(SHARED)
  chdirWorkspace()

  console.log(`[${role}] runtime started: provider=${providerId} model=${model}`)
  db.addLog(role, `runtime_start provider=${providerId} model=${model}`, nowStamp())

  let stopping = false
  process.on('SIGINT', () => { stopping = true })
  process.on('SIGTERM', () => { stopping = true })

  while (!stopping) {
    const unread = db.getUnreadFor(role)
    if (unread.length === 0) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    for (const msgRow of unread) {
      console.log(`[${role}] processing message id=${msgRow.id}`)
      db.addLog(role, `message_received id=${msgRow.id}`, nowStamp())
      try {
        await handleMessage(role, adapter, systemPrompt, msgRow, rates)
      } catch (e: any) {
        console.error(`[${role}] error handling message: ${e?.message || e}`)
        db.addLog(role, `error ${e?.constructor?.name || 'Error'}: ${e?.message || e}`, nowStamp())
        // Mark processed to avoid an infinite retry loop on a bad message.
        db.markProcessed(msgRow.id, nowStamp())
      }
    }
  }
  console.log(`[${role}] runtime stopped`)
  db.addLog(role, 'runtime_stop', nowStamp())
}

async function main(): Promise<void> {
  const args = parseArgs()
  if (args.group) {
    await runGroupSession(args)
    process.exit(0)
  }
  await runResident(args.role)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})



