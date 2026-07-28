// ide-agent.ts — agentic coding loop that runs inside the Electron main
// process and streams tool activity back to the ChatPanel (Agent mode).
//
// Unlike streamChat (which only returns text), this runs a tool-calling loop:
// the model can Read/Write/Edit/Grep/Glob the user's workspace directly. GĐ1
// scope: file tools + auto-apply (writes hit disk immediately). Bash, editor
// round-trip tools, and group spawning come in later phases.
//
// Runs in main so it can reuse the decrypted keys and emit realtime events to
// the renderer. cwd is the workspace root (NOT the app dir).

import fs from 'node:fs'
import path from 'node:path'
import {
  FILE_TOOL_SPECS, runFileTool, ToolSpec,
  ChangePreview, previewWrite, previewEdit, applyChange,
  EXCEL_TOOL_SPECS, EXCEL_TOOL_NAMES, EXCEL_MUTATORS, runExcelTool,
  isOutsideRoot, allowOutsidePath,
} from './agent-tools'
import {
  EXTRA_TOOL_SPECS, EXTRA_TOOL_NAMES, runExtraTool, PendingAction,
} from './extra-tools'
import { BROWSER_TOOL_SPECS, BROWSER_TOOL_NAMES, runBrowserTool, browserGateInfo } from './browser-tools'
import { DOCX_TOOL_SPECS, DOCX_TOOL_NAMES, DOCX_MUTATORS, runDocxTool } from './docx-tools'
import { buildAdapter, ProviderCfgLike } from './adapters'
import { contextWindowFor } from './context-window'
import * as db from './db'

const MAX_TURNS = parseInt(process.env.IDE_AGENT_MAX_TURNS || '30', 10)

// Cap a tool result fed back to the MODEL (the UI event is capped separately).
// Read of a big file used to inject the whole thing; a few of those and the
// prompt overflowed the context window, so the gateway truncated/dropped
// mid-run and the agent just stopped.
const MODEL_RESULT_CAP = 30_000

// When the prompt nears the model's window, old tool results are shrunk to
// this many chars (the model has already acted on them).
const TRIM_KEEP_CHARS = 600

// Shrink tool-result contents of OLDER messages in place, keeping the last
// `keepTail` messages intact. Handles both OpenAI ('tool' role, string
// content) and Anthropic (user message with tool_result blocks) shapes.
function trimOldToolResults(messages: unknown[], keepTail: number): void {
  const note = ' …[old tool output trimmed to save context]'
  const end = Math.max(0, messages.length - keepTail)
  for (let i = 0; i < end; i++) {
    const m = messages[i] as any
    if (!m) continue
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > TRIM_KEEP_CHARS + note.length) {
      m.content = m.content.slice(0, TRIM_KEEP_CHARS) + note
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > TRIM_KEEP_CHARS + note.length) {
          b.content = b.content.slice(0, TRIM_KEEP_CHARS) + note
        }
      }
    }
  }
}

// Coalesce token/reasoning deltas into one renderer event per ~25ms — one
// webContents.send per SSE token flooded IPC (and the renderer) at 30-100
// messages a second for the main run AND every sub-agent. Non-text events
// flush the buffer first so ordering (text before its tool card) is kept.
function coalesceEmit(raw: (e: IdeAgentEvent) => void): (e: IdeAgentEvent) => void {
  let buf: { type: 'reasoning' | 'token'; delta: string; turn: number } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (buf) { const b = buf; buf = null; raw(b) }
  }
  return (e: IdeAgentEvent) => {
    if (e.type === 'token' || e.type === 'reasoning') {
      if (buf && buf.type === e.type && buf.turn === e.turn) {
        buf.delta += e.delta
      } else {
        flush()
        buf = { type: e.type, delta: e.delta, turn: e.turn }
      }
      if (!timer) timer = setTimeout(flush, 25)
      return
    }
    flush()
    raw(e)
  }
}

// "I'll do X:" and then silence — the model narrated an action instead of
// calling the tool and ended its turn. These patterns (EN + VI) detect an
// announced-but-unexecuted action at the END of a text-only reply so the loop
// can nudge the model to actually execute instead of stopping the run.
// TAIL = the rest of the LAST sentence only: no !?, newline, or sentence-ending
// period — but a period glued to a non-space (ChatPanel.tsx, v1.2) is allowed.
// Note \b is ASCII-only, so Vietnamese words starting with đ/ê/… need the
// explicit (^|separator) boundary instead.
const INTENT_TAIL = String.raw`(?:[^.!?\n]|\.(?=\S)){0,160}[.!…]?\s*$`
const INTENT_TAIL_RES: RegExp[] = [
  /[:：]\s*$/,
  new RegExp(String.raw`\b(let me (?!know\b)|i['’]?ll |i will |i['’]?m going to |proceeding to )` + INTENT_TAIL, 'i'),
  new RegExp(String.raw`(^|[\s(,;—–-])(tôi|mình|ta|chúng ta)\s+sẽ\s` + INTENT_TAIL, 'i'),
  new RegExp(String.raw`(^|[\s(,;—–-])để\s+(tôi|mình)\s` + INTENT_TAIL, 'i'),
  new RegExp(String.raw`(^|[\s(,;—–.-])(tiến hành|bắt đầu)\s+\S+` + INTENT_TAIL, 'i'),
]
function looksLikeAnnouncedAction(text: string): boolean {
  const tail = text.slice(-260)
  return INTENT_TAIL_RES.some((re) => re.test(tail))
}

// File-mutating tools whose success should reload the editor/file-tree.
const FILE_CHANGED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Move', 'Delete', 'NotebookEdit', 'DownloadFile'])

// Review mode: Write/Edit render a diff card, but these mutators have no diff
// to show — they gate on the Approve/Decline action card instead, so nothing
// can change the workspace silently while review is on.
const REVIEW_CONFIRM_TOOLS = new Set(['Bash', 'MultiEdit', 'Move', 'Delete', 'NotebookEdit', 'DownloadFile'])

// Tools whose path args are guarded against escaping the workspace. When a
// call targets an outside path we ASK the user (Approve/Decline) instead of
// hard-failing; approval whitelists that directory for the rest of the session.
const ESCAPE_GUARDED_TOOLS = new Set([
  ...FILE_TOOL_SPECS.map((s) => s.name).filter((n) => n !== 'Bash'),
  ...EXCEL_TOOL_SPECS.map((s) => s.name),
])

function escapingPaths(cwd: string, name: string, args: Record<string, unknown>): string[] {
  const keys = name === 'Move' ? ['from', 'to'] : ['path']
  const out: string[] = []
  for (const k of keys) {
    const rel = args?.[k]
    if (typeof rel !== 'string' || !rel) continue
    const abs = isOutsideRoot(cwd, rel)
    if (abs) out.push(abs)
  }
  return out
}

// Plan mode: the agent may only investigate (no writes, no side effects) and
// then present a plan. This is the read-only tool allowlist.
const PLAN_READONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'ListDir', 'GetDiagnostics',
  'OpenFile', 'GetOpenEditor', 'ShowDiff',
  'GitStatus', 'GitDiff', 'GitLog', 'GitBranch', 'GitConfigGet', 'GitRemoteGet',
  'GitHubAuthStatus', 'ListGitProfiles', 'ListPRs', 'ViewPR', 'ListIssues',
  'WebFetch', 'WebSearch', 'RecallNotes', 'TodoWrite', 'BashOutput',
  'BrowserOpen', 'BrowserNavigate', 'BrowserSnapshot', 'BrowserRead',
  'BrowserScroll', 'BrowserConsole', 'BrowserScreenshot',
  'ReportBlocked',
])

// Research mode: read-only deep investigation with the web tools available
// (WebSearch/WebFetch/Research), producing a thorough cited answer.
const RESEARCH_READONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'ListDir', 'GetDiagnostics',
  'OpenFile', 'GetOpenEditor', 'ShowDiff',
  'GitStatus', 'GitDiff', 'GitLog', 'GitBranch',
  'WebFetch', 'WebSearch', 'Research', 'RecallNotes', 'TodoWrite', 'ReportBlocked',
  // Browser read set + Click (cookie banners / doc navigation) — no typing.
  'BrowserOpen', 'BrowserNavigate', 'BrowserSnapshot', 'BrowserRead',
  'BrowserScroll', 'BrowserConsole', 'BrowserScreenshot', 'BrowserClick',
])

// Editor round-trip tools (GĐ2). These don't touch fs — main asks the renderer
// to drive the Monaco editor the user is looking at, then returns the result.
const EDITOR_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'OpenFile',
    description: 'Open a file in the editor so the user can see it (like clicking it in the file tree). Optionally jump to a line (the editor scrolls to and flashes that line). When the user asks WHERE something is (a function, symbol, definition, usage), prefer navigating there with OpenFile(path, line) — after Grep-ing for the line — instead of pasting the code into chat.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, line: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'GetOpenEditor',
    description: 'Get the file path, full content, and current selection of the tab the user is currently viewing. Use this to see exactly what the user is looking at right now.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ShowDiff',
    description: 'Show the user a read-only diff between a file\'s current content and a proposed new version, WITHOUT writing it. Use this to preview or explain a change. To actually apply a change, use Write or Edit.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, new_content: { type: 'string' } },
      required: ['path', 'new_content'],
    },
  },
]
const EDITOR_TOOL_NAMES = new Set(EDITOR_TOOL_SPECS.map((s) => s.name))

// Orchestration tools (GĐ3): hand large/multi-step work to the v2 group
// coordinator instead of doing it inline. Gated on orchestration.enabled.
const ORCH_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'CreateTask',
    description: 'Create a task on the shared task board for a specialist agent to pick up. Use for work you are not doing inline. owner is a role like backend-engineer, frontend-engineer, or ai-engineer.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        owner: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['title', 'owner'],
    },
  },
  {
    name: 'CreateGroup',
    description: 'Spawn a v2 orchestration group to autonomously complete a task (a worker writes code, a reviewer checks it). Use for large or multi-step work rather than editing everything yourself. The user monitors progress in the Groups panel. Requires an existing task_id (call CreateTask first).',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, worker_role: { type: 'string' } },
      required: ['task_id', 'worker_role'],
    },
  },
]
const ORCH_TOOL_NAMES = new Set(ORCH_TOOL_SPECS.map((s) => s.name))

// SpawnAgent: delegate a sub-task to a CHILD instance of this same IDE agent
// (full toolset — files, bash, browser). The child runs to completion in the
// background and its summary is returned as the tool result. Always available
// to the top-level chat agent; withheld from sub-agents themselves (depth cap).
const SPAWN_AGENT_SPEC: ToolSpec = {
  name: 'SpawnAgent',
  description:
    'Delegate a self-contained sub-task to a child agent that runs in the background with the FULL toolset ' +
    '(read/write files, run commands, browse the web). It works autonomously and returns a summary of what it ' +
    'did when finished. Use this to parallelize or offload a chunky, well-scoped piece of work — e.g. exploring, ' +
    'reading, mapping or auditing a large area of the codebase, or a multi-file migration — NOT for small things ' +
    'you can just do yourself. To cover a whole repo, spawn several IN ONE turn, one per top-level area, and ' +
    'synthesize their summaries. Give it a clear, complete task description; it does not see this conversation.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'the complete, self-contained sub-task for the child agent' },
      label: { type: 'string', description: 'a short label shown in the UI (e.g. "migrate auth")' },
    },
    required: ['task'],
  },
}

// Control tool: let the agent bail out cleanly instead of looping to MAX_TURNS
// on an impossible task. Always available.
const REPORT_BLOCKED_SPEC: ToolSpec = {
  name: 'ReportBlocked',
  description:
    'Use ONLY when the request genuinely cannot be completed (missing files/prerequisites, contradictory or ' +
    'impossible requirements, needed access absent, or you are stuck with no viable next step). This ends the ' +
    'run and reports the blocker to the user. Do NOT use it to avoid hard work. reason is REQUIRED.',
  input_schema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'concrete reason the task cannot be completed' } },
    required: ['reason'],
  },
}

// Plan-mode control tool: the agent calls this ONCE, when the plan is complete,
// to present it for approval. Until then no approve UI appears.
const PRESENT_PLAN_SPEC: ToolSpec = {
  name: 'PresentPlan',
  description:
    'Call this EXACTLY ONCE, only when your plan is complete and final, to present it to the user for approval. ' +
    'Pass the full step-by-step plan as `plan` (markdown). This ends plan mode and shows the user an Approve button. ' +
    'Do NOT call it while you are still investigating or if you need to ask the user something first — just keep ' +
    'using read-only tools until the plan is genuinely ready.',
  input_schema: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'the complete step-by-step plan (markdown)' } },
    required: ['plan'],
  },
}

interface ToolSetOpts {
  allowBash: boolean
  orchestrationEnabled: boolean
  isSubAgent?: boolean  // withhold editor round-trip + SpawnAgent + orch tools
  canSpawn?: boolean    // top-level agent with a spawnSubAgent bridge available
}

// The FULL tool set for a run (used for plan-mode read-only filtering).
function toolSpecsFor(opts: ToolSetOpts): ToolSpec[] {
  const specs: ToolSpec[] = [
    ...FILE_TOOL_SPECS.filter((s) => opts.allowBash || s.name !== 'Bash'),
    ...(opts.isSubAgent ? [] : EDITOR_TOOL_SPECS),
    ...EXTRA_TOOL_SPECS,
    ...BROWSER_TOOL_SPECS,
    REPORT_BLOCKED_SPEC,
  ]
  if (opts.orchestrationEnabled && !opts.isSubAgent) specs.push(...ORCH_TOOL_SPECS)
  if (opts.canSpawn && !opts.isSubAgent) specs.push(SPAWN_AGENT_SPEC)
  return specs
}

// ── Lazy tool loading ────────────────────────────────────────────
// Only the CORE toolset is sent every turn. Heavier tool families (git, github,
// web, memory, background) live in groups the model loads on demand via
// LoadToolGroup, so their ~28 definitions don't cost input tokens each turn
// unless the task actually needs them.
const EXTRA_BY_NAME = new Map(EXTRA_TOOL_SPECS.map((s) => [s.name, s]))
function pickExtra(names: string[]): ToolSpec[] {
  return names.map((n) => EXTRA_BY_NAME.get(n)).filter((s): s is ToolSpec => !!s)
}
const TOOL_GROUPS: Record<string, ToolSpec[]> = {
  git: pickExtra(['GitStatus', 'GitDiff', 'GitLog', 'GitBranch', 'GitConfigGet', 'GitConfigSet', 'GitRemoteGet', 'GitRemoteSet', 'GitAdd', 'GitCommit', 'GitPush', 'GitPull', 'GitCheckout', 'SwitchGitAccount', 'SaveGitProfile', 'ListGitProfiles']),
  github: pickExtra(['GitHubAuthStatus', 'GitHubAuthSwitch', 'GitHubLogin', 'ListPRs', 'ViewPR', 'ListIssues', 'CreatePR', 'CommentIssue']),
  web: pickExtra(['WebFetch', 'WebSearch', 'Research']),
  memory: pickExtra(['RememberNote', 'RecallNotes']),
  background: pickExtra(['BashBackground', 'BashOutput', 'BashInput', 'KillBash']),
  excel: EXCEL_TOOL_SPECS,
  browser: BROWSER_TOOL_SPECS,
}
const GROUP_BLURBS: Record<string, string> = {
  git: 'git (status/diff/log/branch/add/commit/push/pull/checkout/config/remote/account)',
  github: 'github (pull requests & issues via gh)',
  web: 'web (WebFetch, WebSearch)',
  memory: 'memory (remember/recall notes across sessions)',
  background: 'background (run/monitor/kill long-running commands)',
  excel: 'excel (create/read/edit .xlsx: sheets, ranges, formulas, formatting)',
  browser: 'browser (drive a real page inside the IDE: open/click/type/read console+text — ideal for testing localhost apps and reading JS-rendered sites)',
}
const LOAD_GROUP_SPEC: ToolSpec = {
  name: 'LoadToolGroup',
  description:
    'Enable an extra group of tools when the task needs them (they are hidden until loaded, to save context). ' +
    'Groups: ' + Object.entries(GROUP_BLURBS).map(([k, v]) => `"${k}" = ${v}`).join('; ') + '. ' +
    'Call group=<name> to enable that group for the rest of this session, then call its tools directly. Load only what you need.',
  input_schema: {
    type: 'object',
    properties: { group: { type: 'string', enum: Object.keys(TOOL_GROUPS) } },
    required: ['group'],
  },
  docx: DOCX_TOOL_SPECS,
}
const TODO_SPEC = EXTRA_BY_NAME.get('TodoWrite') // common + tiny → keep in core

// Core tools sent every turn: file + editor + todo + control + LoadToolGroup.
// Sub-agents drop the editor round-trip (they don't drive the user's one
// Monaco) and SpawnAgent (depth cap); they Write to disk directly.
function coreSpecsFor(opts: ToolSetOpts): ToolSpec[] {
  const specs: ToolSpec[] = [
    ...FILE_TOOL_SPECS.filter((s) => opts.allowBash || s.name !== 'Bash'),
  docx: 'docx (edit .docx live in the IDE, preserving layout: outline/inspect/read, replace/insert/delete paragraphs, run+paragraph formatting, styles, images, tab-stops + column alignment for forms, tables. ALWAYS DocxOutline first — everything targets a paragraph by its ¶index)',
    ...(opts.isSubAgent ? [] : EDITOR_TOOL_SPECS),
  ]
  if (TODO_SPEC) specs.push(TODO_SPEC)
  specs.push(REPORT_BLOCKED_SPEC, LOAD_GROUP_SPEC)
  if (opts.orchestrationEnabled && !opts.isSubAgent) specs.push(...ORCH_TOOL_SPECS)
  if (opts.canSpawn && !opts.isSubAgent) specs.push(SPAWN_AGENT_SPEC)
  return specs
}

export interface IdeAgentParams {
  provider: string
  model?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  // The file currently open in the editor (optional context).
  openFile?: { path: string; language?: string; content: string }
  selection?: string
  // When true, every Write/Edit is held for user approval before hitting disk.
  reviewMode?: boolean
  // Opt-in capabilities (resolved from config in main before the run).
  allowBash?: boolean
  orchestrationEnabled?: boolean
  // Plan mode: read-only investigation, then present a plan (no file writes).
  planMode?: boolean
  // Research mode: read-only deep investigation (web + code) → cited answer.
  researchMode?: boolean
  // >0 when this run IS a spawned sub-agent (of the chat agent). Sub-agents
  // get the full toolset minus editor round-trip and minus SpawnAgent (depth
  // cap prevents fork-bombs).
  subAgentDepth?: number
}

// Orchestration tools run in main (need db + coordinator), so they're routed
// through this bridge rather than executed in ide-agent directly.
export interface OrchestrationBridge {
  createTask(input: { title: string; owner: string; description?: string; priority?: string }): Promise<string>
  createGroup(input: { task_id: string; worker_role: string }): Promise<string>
  // Run a child IDE-agent to completion and return its final summary. Provided
  // only for the top-level chat agent (sub-agents don't get SpawnAgent).
  spawnSubAgent?(input: { task: string; label?: string }): Promise<string>
}

// A change awaiting the user's verdict in review mode.
export interface PendingChange {
  // Whether the top-level chat agent may delegate to child sub-agents via
  // SpawnAgent. Resolved from ide_agent_config in main; default ON.
  allowSubagents?: boolean
  // When sub-agents are allowed, bias the agent toward parallelizing work into
  // sub-agents rather than doing it all sequentially itself. Default OFF.
  preferSubagents?: boolean
  changeId: string
  path: string
  kind: 'write' | 'edit'
  before: string
  after: string
  isNew: boolean
  note: string
}

export type ReviewDecision = 'accept' | 'reject'

// A request from the agent to drive the editor, answered by the renderer.
export interface EditorRequest {
  requestId: string
  op: 'OpenFile' | 'GetOpenEditor' | 'ShowDiff'
  args: Record<string, unknown>
}
// The renderer's reply. `result` is the string handed back to the model.
export interface EditorResponse {
  requestId: string
  ok: boolean
  result: string
}

export type IdeAgentEvent =
  | { type: 'reasoning'; delta: string; turn: number }
  | { type: 'token'; delta: string; turn: number }
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; result: string; isError: boolean }
  | { type: 'pending_change'; change: PendingChange }
  | { type: 'change_resolved'; changeId: string; decision: ReviewDecision }
  | { type: 'pending_action'; action: PendingAction }
  | { type: 'action_resolved'; actionId: string; approved: boolean }
  | { type: 'todos'; todos: { content: string; status: string }[] }
  | { type: 'file_changed'; path: string }
  | { type: 'context'; used: number; window: number; turn: number }
  | { type: 'blocked'; reason: string; turns: number }
  | { type: 'plan'; plan: string; turns: number }
  | { type: 'done'; text: string; turns: number }
  | { type: 'error'; error: string }
  // A child agent was spawned this turn: the renderer renders a nested card and
  // subscribes to ai-agent-event:<childRunId> for its live transcript.
  | { type: 'subagent_started'; childRunId: string; label: string; task: string }

interface ProviderCfg extends ProviderCfgLike {
  models?: string[]
  price_in?: number
  price_out?: number
  context_window?: number
  context_windows?: Record<string, number>
}

function loadProviders(sharedDir: string): Record<string, ProviderCfg> {
  try {
    const raw = fs.readFileSync(path.join(sharedDir, 'agents-config.json'), 'utf-8')
    return JSON.parse(raw).providers ?? {}
  } catch {
    return {}
  }
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function estimateCostUsd(tokensIn: number, tokensOut: number, rates: [number, number] | null): number {
  const [inRate, outRate] = rates ?? [0, 0]
  return (tokensIn * inRate + tokensOut * outRate) / 1_000_000
}

function buildSystemPrompt(params: IdeAgentParams, workspaceRoot: string, opts?: { canSpawn?: boolean; preferSubagents?: boolean }): string {
  const isSubAgent = Boolean(params.subAgentDepth && params.subAgentDepth > 0)
  const editorLine = isSubAgent
    ? '' // sub-agents don't drive the user's editor; they write to disk directly
    : 'You also have editor tools to work with what the user sees: OpenFile (show a file ' +
      'in the editor, optionally at a line), GetOpenEditor (get the currently viewed file ' +
      'and selection), and ShowDiff (preview a proposed change without writing it). '
  let s =
    (isSubAgent
      ? 'You are a delegated sub-agent working autonomously on ONE self-contained sub-task handed to you ' +
        'by the lead agent (given as the first user message). You do NOT see the main conversation. Complete ' +
        'the task end to end, then reply with a SHORT summary of what you did and any result the lead needs. '
      : 'You are an expert AI coding agent embedded in an IDE. ') +
    'You have tools ' +
    'to read and modify the user\'s workspace directly: Read, Write, Edit, MultiEdit, ' +
    'Grep, Glob, ListDir, Move, Delete. ' +
    editorLine +
    'You have TodoWrite to track a plan. ' +
    'Extra tool groups are NOT loaded by default (to save context): git (status/diff/commit/' +
    'push/branch/checkout/config/account), github (PRs & issues), web (WebFetch, WebSearch), ' +
    'memory (remember/recall notes), background (long-running commands), browser (drive a ' +
    'real page inside the IDE — open/click/type/read console; ideal for testing the localhost ' +
    'app you are building and reading JS-rendered sites), and docx (edit Word .docx files live ' +
    'in the IDE, preserving/upgrading layout). When the task ' +
    'needs one, call LoadToolGroup(group) FIRST to enable it, then call its tools. ' +
    'If a browser page shows a CAPTCHA or login wall, do NOT retry or try to bypass it — tell ' +
    'the user to complete it by hand in the browser tab, then continue. ' +
    'Every browser action (open/navigate/click/type) returns a fresh "CURRENT PAGE" snapshot ' +
    'with numbered element refs — ALWAYS pick your next BrowserClick/BrowserType target from the ' +
    'most recent snapshot; never guess a ref or an element that is not listed. ' +
    'When the user describes concrete UI steps (click this, type that, press enter), reproduce ' +
    'those steps with BrowserClick/BrowserType so they can watch — do not shortcut to a ' +
    'constructed URL unless they just ask for a destination. ' +
    'Sensitive actions (git mutations, changing the identity, switching accounts, logging ' +
    'in, background commands) ask the user for confirmation automatically — just call the ' +
    'tool and the user will approve or decline. ' +
    (isSubAgent ? '' : 'Open the relevant file with OpenFile so the user can follow along. ') +
    (opts?.canSpawn
      ? (opts.preferSubagents
          ? 'PREFER delegating to child sub-agents: whenever a task splits into independent parts, spawn a ' +
            'sub-agent per part instead of doing them yourself sequentially. In particular, to READ, MAP, ' +
            'UNDERSTAND or AUDIT a whole repo or many files, do NOT read it all yourself — split the codebase by ' +
            'top-level area/directory and spawn ONE sub-agent per area to explore and report back, then synthesize ' +
            'their summaries. Use SpawnAgent(task, label) — each runs autonomously with the full toolset and returns ' +
            'a summary. To run several AT THE SAME TIME, emit multiple SpawnAgent tool calls IN ONE turn (they ' +
            'execute in parallel); if the user asks for N agents, make N SpawnAgent calls in that single turn. Give ' +
            'each a narrow, specific task — never "the whole workspace". Still do a single trivial edit yourself. '
          : 'For large or parallelizable work, delegate a well-scoped sub-task to a child agent with ' +
            'SpawnAgent(task, label) — it runs autonomously with the full toolset and returns a summary. Reading, ' +
            'mapping or auditing a whole repo or many files is a good fit: split by area and spawn one sub-agent per ' +
            'area rather than reading it all yourself. Do NOT delegate trivial things you can just do yourself. To ' +
            'run several sub-agents AT THE SAME TIME, emit multiple SpawnAgent tool calls IN ONE turn (they execute ' +
            'in parallel); if the user asks for N agents, make N SpawnAgent calls in that single turn. Give each a ' +
            'narrow, specific task — never "the whole workspace". ') +
        'If the user explicitly asks you to use or spawn sub-agents, do so — even for work you could do yourself. '
      : '') +
    'Work autonomously: inspect the code with Read/Grep/Glob before changing it, make ' +
    'the smallest correct edit, and prefer Edit over Write for existing files. ' +
    'Stay on-task: only explore the workspace when the task actually requires it — if the ' +
    'user asks about one specific file (even outside the workspace), focus on that file. ' +
    'Paths are relative to the workspace root. When done, give a brief summary of what ' +
    'you changed. Do not ask for confirmation in text — the user reviews changes in the editor. ' +
    'Make tool calls through the normal tool interface — NEVER write tool-log markers such as ' +
    '"[used ToolName] →", element refs like "[e30]", or paste raw tool output into your reply; ' +
    'just speak to the user in plain prose about what you found or did.\n\n' +
    `Workspace root: ${workspaceRoot}`
  if (params.planMode) {
    s =
      'You are in PLAN MODE. You may ONLY investigate — read files, search, run ' +
      'diagnostics, inspect git, browse the web. You must NOT modify anything (no Write/Edit/' +
      'commits/commands). Research the request thoroughly FIRST. Only when your plan is complete ' +
      'and final, call the PresentPlan tool with the full step-by-step plan (files to change and how, ' +
      'key decisions, how to verify). Do NOT call PresentPlan until you have finished investigating — ' +
      'keep using read-only tools until you are confident. Calling PresentPlan is what shows the user ' +
    'For a .docx: LoadToolGroup("docx"), then ALWAYS call DocxOutline first to get each ' +
    'paragraph\'s ¶index/style — every docx edit targets a paragraph by that index. ALWAYS edit ' +
    'a .docx with the Docx* tools — NEVER unzip/edit/repack it by hand with Bash (that corrupts ' +
    'the file and the live viewer will not update). You cannot SEE the rendered page, so use ' +
    'DocxInspect to read the real structure (it shows tabs as →, tab stops, indent, and each ' +
    'run\'s formatting) before and after formatting changes — DocxReadText only gives plain text. ' +
    'To line up "label: value" rows (e.g. a form/contract) so the colons or values align, use ' +
    'DocxAlignColumns — do NOT add or remove spaces (spaces never align in a proportional font; ' +
    'Word aligns with tab stops). For real tabular data use DocxInsertTable/DocxSetCell. Prefer ' +
    'format-preserving edits (DocxFormatRun/DocxFormatParagraph/DocxApplyStyle) and keep or ' +
    'improve existing styling rather than flattening it. To add an image, find it with the web ' +
    'group, DownloadFile it into the workspace, then DocxInsertImage. The user watches every ' +
    'edit render live, so make focused, ordered changes. ' +
      'the Approve button; until then, no approval is offered. ' +
      'As you investigate, briefly narrate what you find in one line each (this streams live to the ' +
      'user so they can follow your thinking) before you call PresentPlan.\n\n' +
      `Workspace root: ${workspaceRoot}`
  } else if (params.researchMode) {
    s =
      'You are in RESEARCH mode. Investigate the question DEEPLY and strictly READ-ONLY. You may ' +
      'read the codebase (Read/Grep/Glob/ListDir/GetDiagnostics), inspect git history (GitStatus/Diff/Log), ' +
      'and research the web with WebSearch, WebFetch, and Research (a one-call multi-source deep dive). ' +
      'Do NOT modify anything. Go DEEP: call Research with 2–4 sub-queries covering different angles of the ' +
      'question, read the returned sources, then run FOLLOW-UP Research/WebFetch calls to fill gaps, verify ' +
      'claims across sources, and chase specifics — do not stop at the first search. Keep digging until the ' +
      'answer is well-supported, then write a thorough, well-structured answer that CITES its sources ' +
      '(URLs / file paths).\n\n' +
      `Workspace root: ${workspaceRoot}`
  }
  // Project rules: a checked-in ORQON.md (or AGENTS.md) at the workspace root
  // rides along on every run — conventions, build/test commands, do-nots.
  for (const name of ['ORQON.md', 'AGENTS.md']) {
    try {
      const raw = fs.readFileSync(path.join(workspaceRoot, name), 'utf8').trim()
      if (raw) {
        const body = raw.length > 10000 ? raw.slice(0, 10000) + '\n… (truncated)' : raw
        s += `\n\nProject rules from ${name} — follow them:\n${body}`
        break
      }
    } catch { /* absent or unreadable rules never block a run */ }
  }
  if (params.openFile) {
    const body = params.openFile.content.length > 12000
      ? params.openFile.content.slice(0, 12000) + '\n… (truncated)'
      : params.openFile.content
    s += `\n\nThe file currently open in the editor is ${params.openFile.path}:\n` +
      `\`\`\`${params.openFile.language ?? ''}\n${body}\n\`\`\``
  }
  if (params.selection && params.selection.trim()) {
    s += `\n\nThe user has selected this snippet:\n\`\`\`\n${params.selection.slice(0, 4000)}\n\`\`\``
  }
  return s
}

// Run the IDE agent loop. `emit` streams events to the renderer; `signal`
// aborts between turns. `requestReview` is awaited before a Write/Edit is
// persisted when reviewMode is on — it resolves with the user's verdict.
// Resolves when the loop ends (done or error emitted).
export async function runIdeAgent(
  sharedDir: string,
  params: IdeAgentParams,
  decrypt: (b64: string) => string,
  emitRaw: (e: IdeAgentEvent) => void,
  signal: AbortSignal,
  requestReview?: (change: PendingChange) => Promise<ReviewDecision>,
  editorBridge?: (op: EditorRequest['op'], args: Record<string, unknown>) => Promise<EditorResponse>,
  orchestrationBridge?: OrchestrationBridge,
  requestAction?: (action: PendingAction) => Promise<boolean>,
): Promise<void> {
  // Every terminal path below ends with a non-token event (done/error/
  // blocked/plan), which flushes any buffered text first.
  const emit = coalesceEmit(emitRaw)
  try {
    const providers = loadProviders(sharedDir)
    const pc = providers[params.provider]
    if (!pc) throw new Error(`unknown provider: ${params.provider}`)
    const model = params.model || pc.models?.[0] || ''
    if (!model) throw new Error(`no model for provider ${params.provider}`)
    const enc = db.getSecret(params.provider)
    const key = enc ? decrypt(enc) : ''
    const rates: [number, number] | null =
      pc.price_in != null || pc.price_out != null
        ? [Number(pc.price_in ?? 0), Number(pc.price_out ?? 0)]
        : null

    const workspaceRoot = db.getMeta('workspace_root')
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
      throw new Error('no workspace is open — open a folder first')
    }

    const allowBash = Boolean(params.allowBash)
    const orchestrationEnabled = Boolean(params.orchestrationEnabled && orchestrationBridge)
    // Top-level chat agent can delegate to child agents; sub-agents cannot
    // (depth cap). Gated on its own "allow sub-agents" setting (default on),
    // independent of the headless group-orchestration toggle.
    const canSpawn =
      params.allowSubagents !== false && !isSubAgent && Boolean(orchestrationBridge?.spawnSubAgent)
    const toolOpts: ToolSetOpts = { allowBash, orchestrationEnabled, isSubAgent, canSpawn }
    const contextWindow = contextWindowFor(model, pc)
    const planMode = Boolean(params.planMode)
    const researchMode = Boolean(params.researchMode) && !planMode
    // Plan/research use a curated read-only set (no lazy loading). Normal mode
    // sends only the core set + LoadToolGroup; extra groups load on demand.
    let activeSpecs: ToolSpec[]
    if (planMode) {
      activeSpecs = toolSpecsFor(toolOpts).filter((s) => PLAN_READONLY_TOOLS.has(s.name))
      activeSpecs.push(PRESENT_PLAN_SPEC)
    } else if (researchMode) {
      activeSpecs = toolSpecsFor(toolOpts).filter((s) => RESEARCH_READONLY_TOOLS.has(s.name))
    } else {
      activeSpecs = coreSpecsFor(toolOpts)
    }
    let adapter = buildAdapter(pc, key, model, activeSpecs)
    const loadedGroups = new Set<string>()
    const system = buildSystemPrompt(params, workspaceRoot, {
      canSpawn,
      preferSubagents: canSpawn && Boolean(params.preferSubagents),
    })
    // Seed the conversation with the prior chat turns (user + assistant text).
    const messages: unknown[] = params.messages.map((m) => ({ role: m.role, content: m.content }))

    let finalText = ''
    let turns = 0
    let anyActivity = false // any tool call ran this run
    let lengthContinues = 0 // auto-continuations after hitting the output cap
    let intentNudges = 0    // "you said you'd do it — call the tool" nudges
    let continuing = false  // this turn continues a capped reply
    let browserApproved = false // approve-once: driving the browser beyond localhost

    for (let i = 0; i < MAX_TURNS; i++) {
      if (signal.aborted) { emit({ type: 'error', error: 'cancelled' }); return }
      const turn = turns

      // Call the provider with retries. Two failure modes we recover from, as
      // long as nothing has streamed yet this turn (retrying after partial
      // output would duplicate it):
      //  - transient errors (429 / 5xx / network drop)
      //  - "silent" empty completions (gateway drops the stream and returns
      //    nothing) — previously these ended the run with no reply at all.
      let streamedThisTurn = false
      const handlers = {
        onText: (delta: string) => { streamedThisTurn = true; emit({ type: 'token', delta, turn }) },
        onReasoning: (delta: string) => { streamedThisTurn = true; emit({ type: 'reasoning', delta, turn }) },
      }
      let res: Awaited<ReturnType<typeof adapter.chatStream>>
      for (let attempt = 0; ; attempt++) {
        try {
          res = await adapter.chatStream(messages, system, handlers, signal)
        } catch (e: any) {
          const msg = String(e?.message || e)
          const transient = /HTTP (429|5\d\d)|fetch failed|network|ECONN|ETIMEDOUT|socket|timed? ?out/i.test(msg)
          if (transient && !streamedThisTurn && attempt < 2 && !signal.aborted) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
            continue
          }
          throw e
        }
        if (!res.text && res.toolCalls.length === 0 && !streamedThisTurn && attempt < 2 && !signal.aborted) {
          // Empty completion — retry quietly.
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        break
      }
      const { text, toolCalls, assistantMsg, usage } = res
      // One-line turn trace (main-process stdout) — how did the stream end?
      // Lets us tell apart: clean finish vs output cap vs dropped stream.
      console.log(
        `[agent] turn=${turns + 1} finish=${res.finishReason || '-'} dropped=${!!res.dropped} ` +
        `tools=${toolCalls.length} textLen=${text.length} in=${usage.input} out=${usage.output}`,
      )
      turns++

      // Record cost under a virtual role so it shows in the dashboard.
      db.addUsage({
        ts: nowStamp(),
        role: 'ide-agent',
        model,
        tokens_in: usage.input,
        tokens_out: usage.output,
        cost_usd: estimateCostUsd(usage.input, usage.output, rates),
        task_id: null,
      })

      // Report context fill: prompt tokens this turn = current context size.
      if (usage.input > 0) {
        emit({ type: 'context', used: usage.input, window: contextWindow, turn })
        // Emergency brake: prompt near the window → trim harder (keep only
        // the last 4 messages intact) so the next call doesn't overflow —
        // overflow made gateways truncate/drop tool calls mid-run.
        if (usage.input > contextWindow * 0.8) trimOldToolResults(messages, 4)
      }

      if (text) finalText = continuing ? finalText + text : text
      continuing = false
      if (toolCalls.length === 0) {
        // Output cap cut the reply mid-sentence: push the partial answer back
        // and ask the model to continue seamlessly (up to 2 continuations).
        // Some gateways silently cap output and report finish=stop anyway —
        // treat a "stop" that ends mid-sentence as capped too (heuristic).
        // A stream that DROPPED after partial output is the same situation
        // (gateway died mid-reply) — continue instead of ending the run.
        const t = text.trimEnd()
        const looksTruncated =
          res.finishReason === 'stop' && t.length > 150 && /[\p{L}\p{N},(–—-]$/u.test(t) && !t.endsWith('```')
        const capped = res.finishReason === 'length' || res.finishReason === 'max_tokens' || looksTruncated
          || (res.dropped && streamedThisTurn)
        if (capped && lengthContinues < 2 && !signal.aborted) {
          lengthContinues++
          continuing = true
          messages.push(assistantMsg)
          messages.push({
            role: 'user',
            content: 'Your reply was cut off by the output token limit. Continue EXACTLY where it stopped — do not repeat any earlier text.',
          })
          continue
        }
        if (capped) emit({ type: 'token', delta: '\n\n⚠ [reply was cut off — say "continue" to resume]', turn })
        // The model ANNOUNCED an action ("I'll now fix X:") but called no tool
        // and ended its turn — without a nudge the run would just stop there.
        // Push it to execute; bounded so a chatty model can't loop forever.
        if (!capped && t && looksLikeAnnouncedAction(t) && intentNudges < 2 && !signal.aborted) {
          intentNudges++
          messages.push(assistantMsg)
          messages.push({
            role: 'user',
            content:
              'You announced an action but did not call any tool — the turn ended with words only. ' +
              'CALL the tool(s) directly now to actually do it; do not re-describe the action. ' +
              'If the task is already fully complete, reply with only the final summary.',
          })
          continue
        }
        // Still empty after retries, nothing streamed, no tools ever ran →
        // surface it instead of silently ending the run with no reply at all.
        if (!finalText && !streamedThisTurn && !anyActivity) {
          emit({ type: 'error', error: 'provider returned an empty response (stream dropped) — please send again' })
          return
        }
        break
      }
      anyActivity = true

      const reviewOn = Boolean(params.reviewMode && requestReview)
      const results: string[] = []
      // SpawnAgent runs children CONCURRENTLY: each call reserves its result
      // slot and kicks off immediately, so two SpawnAgent calls in one turn run
      // in parallel instead of one-after-another. Filled after the loop.
      const pendingSpawns: { index: number; callId: string; promise: Promise<string> }[] = []

      // Ask the user to approve a sensitive action (shared by the extra-tools
      // gate and the outside-workspace gate below).
      const confirm = async (action: Omit<PendingAction, 'actionId'>): Promise<boolean> => {
        if (!requestAction) return false
        const actionId = `act-${++actionCounter}-${Date.now()}`
        const full: PendingAction = { actionId, ...action }
        emit({ type: 'pending_action', action: full })
        const approved = await requestAction(full)
        emit({ type: 'action_resolved', actionId, approved })
        return approved
      }
      for (const call of toolCalls) {
        if (signal.aborted) { emit({ type: 'error', error: 'cancelled' }); return }
        const callId = call.id || `${call.name}-${Date.now()}`
        emit({ type: 'tool_call', callId, name: call.name, args: call.args })

        // The call's argument JSON arrived truncated/malformed (output cap or
        // dropped stream) — don't execute it with empty args; tell the model
        // so it re-issues the call instead of the run silently misfiring.
        if (call.invalid) {
          const r = 'error: this tool call\'s arguments arrived truncated/malformed (the reply was likely cut off) — re-issue the call; if the arguments were large, send a smaller version'
          results.push(r)
          emit({ type: 'tool_result', callId, name: call.name, result: r, isError: true })
          continue
        }

        // Control tool: bail out of the run cleanly.
        if (call.name === 'ReportBlocked') {
          const reason = String((call.args as { reason?: string }).reason || '').trim()
          if (!reason) {
            emit({ type: 'tool_result', callId, name: call.name, result: 'error: reason is required', isError: true })
            results.push('error: reason is required — explain concretely why the task is blocked')
            continue
          }
          emit({ type: 'tool_result', callId, name: call.name, result: `blocked: ${reason}`, isError: false })
          emit({ type: 'blocked', reason, turns })
          return
        }

        // Plan-mode control tool: the plan is ready → present it for approval.
        if (call.name === 'PresentPlan') {
          const plan = String((call.args as { plan?: string }).plan || '').trim()
          if (!plan) {
            emit({ type: 'tool_result', callId, name: call.name, result: 'error: plan is required', isError: true })
            results.push('error: plan is required — pass the full step-by-step plan')
            continue
          }
          emit({ type: 'tool_result', callId, name: call.name, result: 'plan presented', isError: false })
          emit({ type: 'plan', plan, turns })
          return
        }

        // Lazy tool loading: enable a group's tools for the rest of the run.
        if (call.name === 'LoadToolGroup') {
          const g = String((call.args as { group?: string }).group || '')
          const grp = TOOL_GROUPS[g]
          let r: string
          if (!grp) {
            r = `error: unknown group "${g}". Available: ${Object.keys(TOOL_GROUPS).join(', ')}`
          } else if (loadedGroups.has(g)) {
            r = `group "${g}" is already loaded`
          } else {
            loadedGroups.add(g)
            activeSpecs = [...activeSpecs, ...grp]
            adapter = buildAdapter(pc, key, model, activeSpecs) // rebuild with the new tools
            r = `loaded ${grp.length} ${g} tools: ${grp.map((s) => s.name).join(', ')}. You can call them now.`
          }
          emit({ type: 'tool_result', callId, name: call.name, result: r, isError: r.startsWith('error:') })
          results.push(r)
          continue
        }

        // Outside-workspace path? Ask instead of hard-failing. Approving
        // whitelists that file's directory for the rest of the app session.
        if (ESCAPE_GUARDED_TOOLS.has(call.name)) {
          const outside = escapingPaths(workspaceRoot, call.name, call.args as Record<string, unknown>)
          if (outside.length > 0) {
            const ok = await confirm({
              tool: call.name,
              title: 'Access OUTSIDE the workspace',
              detail: `${call.name}:\n${outside.join('\n')}`,
            })
            if (!ok) {
              const denied = `denied by user: ${call.name} on a path outside the workspace root was not allowed`
              results.push(denied)
              emit({ type: 'tool_result', callId, name: call.name, result: denied, isError: true })
              continue
            }
            for (const abs of outside) {
              allowOutsidePath(abs)
              allowOutsidePath(path.dirname(abs))
            }
          }
        }

        // Browser gate: the FIRST browser action aimed beyond localhost asks
        // once per run (Approve/Decline); localhost (the app being built)
        // never asks. After approval the run drives the browser freely — the
        // user watches everything in the embedded browser tab.
        if (BROWSER_TOOL_NAMES.has(call.name) && !browserApproved) {
          const gi = browserGateInfo(call.name, call.args as Record<string, unknown>)
          if (!gi.local) {
            const ok = await confirm({
              tool: call.name,
              title: 'Drive the browser beyond localhost',
              detail: gi.detail,
            })
            if (!ok) {
              const denied = 'denied by user: browsing beyond localhost was not approved for this run'
              results.push(denied)
              emit({ type: 'tool_result', callId, name: call.name, result: denied, isError: true })
              continue
            }
            browserApproved = true
          }
        }

        // Review mode: mutators without a diff card ask via Approve/Decline.
        if (reviewOn && (REVIEW_CONFIRM_TOOLS.has(call.name) || EXCEL_MUTATORS.has(call.name))) {
          const detail = call.name === 'Bash'
            ? String((call.args as { command?: string }).command || '')
            : JSON.stringify(call.args, null, 2).slice(0, 1500)
          const ok = await confirm({ tool: call.name, title: `Review mode: approve ${call.name}`, detail })
          if (!ok) {
            const denied = `denied by user: ${call.name} was not approved in review mode`
            results.push(denied)
            emit({ type: 'tool_result', callId, name: call.name, result: denied, isError: true })
            continue
          }
        }

        // SpawnAgent: kick the child off WITHOUT awaiting so sibling spawns in
        // the same turn run in parallel. Reserve this call's result slot now;
        // the summary lands after the loop. Errors resolve synchronously.
        if (call.name === 'SpawnAgent') {
          const a = call.args as { task?: string; label?: string }
          if (!canSpawn || !orchestrationBridge?.spawnSubAgent) {
            const denied = 'error: SpawnAgent is unavailable — enable "Allow agent to spawn sub-agents" in Backend Settings'
            results.push(denied)
            emit({ type: 'tool_result', callId, name: call.name, result: denied, isError: true })
          } else if (!a.task?.trim()) {
            const denied = 'error: task is required — describe the complete self-contained sub-task'
            results.push(denied)
            emit({ type: 'tool_result', callId, name: call.name, result: denied, isError: true })
          } else {
            anyActivity = true
            const index = results.length
            results.push('') // placeholder; filled once the child finishes
            const promise = orchestrationBridge.spawnSubAgent({ task: a.task, label: a.label })
              .catch((e: any) => `error: ${e?.message || e}`)
            pendingSpawns.push({ index, callId, promise })
          }
          continue
        }

        let result: string
        let isError = false
        const isMutation = call.name === 'Write' || call.name === 'Edit'
        const isEditorTool = EDITOR_TOOL_NAMES.has(call.name)
        const isOrchTool = ORCH_TOOL_NAMES.has(call.name)
        const isExtraTool = EXTRA_TOOL_NAMES.has(call.name)
        const isExcelTool = EXCEL_TOOL_NAMES.has(call.name)
        const isBrowserTool = BROWSER_TOOL_NAMES.has(call.name)

        if (isBrowserTool) {
          try {
            result = await runBrowserTool(call.name, call.args as Record<string, unknown>, { workspaceRoot })
            isError = result.startsWith('error:')
          } catch (e: any) {
            result = `error: ${e?.message || e}`
            isError = true
          }
        } else if (isExcelTool) {
          // Excel tools are async (exceljs) → dispatched separately from runFileTool.
          try {
            const r = await runExcelTool(workspaceRoot, call.name, call.args)
            result = r == null ? `error: unknown tool ${call.name}` : r
            isError = result.startsWith('error:')
          } catch (e: any) {
            result = `error: ${e?.message || e}`
            isError = true
          }
          if (!isError && EXCEL_MUTATORS.has(call.name)) {
            const rel = (call.args as { path?: string }).path
            if (rel) emit({ type: 'file_changed', path: rel })
          }
        } else if (isExtraTool) {
          // Git / git-account / web / todo / background tools. Sensitive ones
          // (mutations, login, account switch) gate on the shared confirm above.
          try {
            const r = await runExtraTool(call.name, call.args, {
              cwd: workspaceRoot,
              confirm,
              emitTodos: (todos) => emit({ type: 'todos', todos }),
            })
            result = r == null ? `error: unknown tool ${call.name}` : r
            isError = r == null || r.startsWith('error:')
          } catch (e: any) {
            result = `error: ${e?.message || e}`
            isError = true
          }
          // Git mutations may touch tracked files; nudge the tree to refresh.
          if (!isError && (call.name === 'GitCheckout' || call.name === 'GitPull')) {
            emit({ type: 'file_changed', path: '' })
          }
        } else if (isOrchTool) {
          if (!orchestrationEnabled || !orchestrationBridge) {
            result = 'error: orchestration is disabled — enable it in Backend Settings to hand work to groups'
            isError = true
          } else {
            try {
              result = await runOrchTool(call, orchestrationBridge)
              isError = result.startsWith('error:')
            } catch (e: any) {
              result = `error: ${e?.message || e}`
              isError = true
            }
          }
        } else if (isEditorTool) {
          // Round-trip to the renderer to drive the editor.
          if (!editorBridge) {
            result = `error: editor tool ${call.name} is unavailable`
            isError = true
          } else {
            try {
              const resp = await editorBridge(call.name as EditorRequest['op'], call.args)
              result = resp.result
              isError = !resp.ok
            } catch (e: any) {
              result = `error: ${e?.message || e}`
              isError = true
            }
          }
        } else if (reviewOn && isMutation) {
          // Compute the change, show the user a diff, and only persist on accept.
          try {
            result = await reviewMutation(workspaceRoot, call, emit, requestReview!)
            isError = result.startsWith('error:')
          } catch (e: any) {
            result = `error: ${e?.message || e}`
            isError = true
          }
        } else {
          try {
            const r = await runFileTool(workspaceRoot, call.name, call.args)
            result = r == null ? `error: unknown tool ${call.name}` : r
            if (r == null || r.startsWith('error:')) isError = true
          } catch (e: any) {
            result = `error: ${e?.message || e}`
            isError = true
          }
          // Auto-apply mode: notify renderer so it reloads the changed file/tree.
          // Covers every file-mutating tool, not just Write/Edit.
          if (!isError && FILE_CHANGED_TOOLS.has(call.name)) {
            const a = call.args as { path?: string; to?: string }
            const rel = a.path || a.to
            if (rel) emit({ type: 'file_changed', path: rel })
          }
        }

        // Cap what goes back to the model — a single huge result (full-file
        // Read, big command output) could blow the context for the whole run.
        results.push(result.length > MODEL_RESULT_CAP
        const isDocxTool = DOCX_TOOL_NAMES.has(call.name)
          ? result.slice(0, MODEL_RESULT_CAP) + '\n…[output truncated — re-run with a narrower scope (offset/limit, tighter pattern) for more]'
          : result)
        emit({ type: 'tool_result', callId, name: call.name, result: result.slice(0, 2000), isError })
      }

      // Wait for any concurrently-spawned children, fill their result slots,
      // and emit their (suppressed-in-UI) tool_results now that they're done.
      if (pendingSpawns.length > 0) {
        await Promise.all(pendingSpawns.map(async ({ index, callId, promise }) => {
          const r = await promise
          results[index] = r.length > MODEL_RESULT_CAP ? r.slice(0, MODEL_RESULT_CAP) + '\n…[summary truncated]' : r
          emit({ type: 'tool_result', callId, name: 'SpawnAgent', result: r.slice(0, 2000), isError: r.startsWith('error:') })
        }))
      }

      messages.push(assistantMsg)
      for (const m of adapter.toolResultsMessages(toolCalls, results)) messages.push(m)
      // Proactively shrink tool results older than the last ~4 turns — the
      // model already acted on them, yet they were re-sent at full size every
      // turn until the 80% emergency brake. The trim is deterministic, so the
      // already-trimmed prefix stays byte-stable for provider prompt caches.
      trimOldToolResults(messages, 8)
    }

        } else if (isDocxTool) {
          // Docx tools are async (jszip + xmldom) → dispatched like Excel. A
          // mutating op emits file_changed so the live DocxViewer re-renders,
          // letting the user watch the edit land step by step.
          try {
            const r = await runDocxTool(workspaceRoot, call.name, call.args)
            result = r == null ? `error: unknown tool ${call.name}` : r
            isError = result.startsWith('error:')
          } catch (e: any) {
            result = `error: ${e?.message || e}`
            isError = true
          }
          if (!isError && DOCX_MUTATORS.has(call.name)) {
            const rel = (call.args as { path?: string }).path
            if (rel) emit({ type: 'file_changed', path: rel })
          }
    emit({ type: 'done', text: finalText, turns })
  } catch (e: any) {
    emit({ type: 'error', error: e?.message || String(e) })
  }
}

// Route a CreateTask/CreateGroup call through the main-process bridge.
async function runOrchTool(
  call: { name: string; args: Record<string, unknown> },
  bridge: OrchestrationBridge,
): Promise<string> {
  if (call.name === 'CreateTask') {
    const a = call.args as { title?: string; owner?: string; description?: string; priority?: string }
    if (!a.title || !a.owner) return 'error: title and owner are required'
    const id = await bridge.createTask({
      title: a.title, owner: a.owner, description: a.description, priority: a.priority,
    })
    return `created task ${id} (owner ${a.owner}). Call CreateGroup with this task_id to have a group work it.`
  }
  if (call.name === 'CreateGroup') {
    const a = call.args as { task_id?: string; worker_role?: string }
    if (!a.task_id || !a.worker_role) return 'error: task_id and worker_role are required'
    const groupId = await bridge.createGroup({ task_id: a.task_id, worker_role: a.worker_role })
    return `spawned group ${groupId} for ${a.task_id}. The user can watch it in the Groups panel.`
  }
  return `error: unknown orchestration tool ${call.name}`
}

let changeCounter = 0
let actionCounter = 0

// In review mode: compute the diff for a Write/Edit call, show it to the user,
// and only persist if they accept. Returns the tool-result string the model
// sees, so a reject reads as "rejected by user" (the model can react / stop).
async function reviewMutation(
  workspaceRoot: string,
  call: { name: string; args: Record<string, unknown> },
  emit: (e: IdeAgentEvent) => void,
  requestReview: (change: PendingChange) => Promise<ReviewDecision>,
): Promise<string> {
  let preview: ChangePreview | string
  if (call.name === 'Write') {
    preview = previewWrite(workspaceRoot, call.args as { path: string; content: string })
  } else {
    preview = previewEdit(
      workspaceRoot,
      call.args as { path: string; old_string: string; new_string: string; replace_all?: boolean },
    )
  }
  // A string means the change couldn't be resolved (missing/ambiguous) — surface
  // it as the tool error without prompting the user.
  if (typeof preview === 'string') return preview
  if (preview.before === preview.after) return `no change: ${preview.path} already matches`

  const changeId = `chg-${++changeCounter}-${Date.now()}`
  const pending: PendingChange = { changeId, ...preview }
  emit({ type: 'pending_change', change: pending })

  const decision = await requestReview(pending)
  emit({ type: 'change_resolved', changeId, decision })

  if (decision === 'reject') {
    return `rejected by user: the ${preview.kind} to ${preview.path} was not applied`
  }
  applyChange(workspaceRoot, preview.path, preview.after)
  emit({ type: 'file_changed', path: preview.path })
  return preview.kind === 'write'
    ? `wrote ${preview.after.length} chars to ${preview.path} (approved)`
    : `edited ${preview.path} — ${preview.note} (approved)`
}
          // A shell command can write anything and we cannot know what. An
          // empty path means "re-read every live surface" — cheaper than
          // leaving the editor and the docx viewer showing stale content.
          if (!isError && call.name === 'Bash') emit({ type: 'file_changed', path: '' })
