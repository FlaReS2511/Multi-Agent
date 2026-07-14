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
import { buildAdapter, ProviderCfgLike } from './adapters'
import { contextWindowFor } from './context-window'
import * as db from './db'

const MAX_TURNS = parseInt(process.env.IDE_AGENT_MAX_TURNS || '30', 10)

// File-mutating tools whose success should reload the editor/file-tree.
const FILE_CHANGED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Move', 'Delete', 'NotebookEdit', 'DownloadFile'])

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
  'ReportBlocked',
])

// Research mode: read-only deep investigation with the web tools available
// (WebSearch/WebFetch/Research), producing a thorough cited answer.
const RESEARCH_READONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'ListDir', 'GetDiagnostics',
  'OpenFile', 'GetOpenEditor', 'ShowDiff',
  'GitStatus', 'GitDiff', 'GitLog', 'GitBranch',
  'WebFetch', 'WebSearch', 'Research', 'RecallNotes', 'TodoWrite', 'ReportBlocked',
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

// The FULL tool set for a run (used for plan-mode read-only filtering).
function toolSpecsFor(opts: { allowBash: boolean; orchestrationEnabled: boolean }): ToolSpec[] {
  const specs: ToolSpec[] = [
    ...FILE_TOOL_SPECS.filter((s) => opts.allowBash || s.name !== 'Bash'),
    ...EDITOR_TOOL_SPECS,
    ...EXTRA_TOOL_SPECS,
    REPORT_BLOCKED_SPEC,
  ]
  if (opts.orchestrationEnabled) specs.push(...ORCH_TOOL_SPECS)
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
  background: pickExtra(['BashBackground', 'BashOutput', 'KillBash']),
  excel: EXCEL_TOOL_SPECS,
}
const GROUP_BLURBS: Record<string, string> = {
  git: 'git (status/diff/log/branch/add/commit/push/pull/checkout/config/remote/account)',
  github: 'github (pull requests & issues via gh)',
  web: 'web (WebFetch, WebSearch)',
  memory: 'memory (remember/recall notes across sessions)',
  background: 'background (run/monitor/kill long-running commands)',
  excel: 'excel (create/read/edit .xlsx: sheets, ranges, formulas, formatting)',
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
}
const TODO_SPEC = EXTRA_BY_NAME.get('TodoWrite') // common + tiny → keep in core

// Core tools sent every turn: file + editor + todo + control + LoadToolGroup.
function coreSpecsFor(opts: { allowBash: boolean; orchestrationEnabled: boolean }): ToolSpec[] {
  const specs: ToolSpec[] = [
    ...FILE_TOOL_SPECS.filter((s) => opts.allowBash || s.name !== 'Bash'),
    ...EDITOR_TOOL_SPECS,
  ]
  if (TODO_SPEC) specs.push(TODO_SPEC)
  specs.push(REPORT_BLOCKED_SPEC, LOAD_GROUP_SPEC)
  if (opts.orchestrationEnabled) specs.push(...ORCH_TOOL_SPECS)
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
}

// Orchestration tools run in main (need db + coordinator), so they're routed
// through this bridge rather than executed in ide-agent directly.
export interface OrchestrationBridge {
  createTask(input: { title: string; owner: string; description?: string; priority?: string }): Promise<string>
  createGroup(input: { task_id: string; worker_role: string }): Promise<string>
}

// A change awaiting the user's verdict in review mode.
export interface PendingChange {
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

function buildSystemPrompt(params: IdeAgentParams, workspaceRoot: string): string {
  let s =
    'You are Orqon, an expert AI coding agent embedded in an IDE. You have tools ' +
    'to read and modify the user\'s workspace directly: Read, Write, Edit, MultiEdit, ' +
    'Grep, Glob, ListDir, Move, Delete. ' +
    'You also have editor tools to work with what the user sees: OpenFile (show a file ' +
    'in the editor, optionally at a line), GetOpenEditor (get the currently viewed file ' +
    'and selection), and ShowDiff (preview a proposed change without writing it), plus ' +
    'TodoWrite to track a plan. ' +
    'Extra tool groups are NOT loaded by default (to save context): git (status/diff/commit/' +
    'push/branch/checkout/config/account), github (PRs & issues), web (WebFetch, WebSearch), ' +
    'memory (remember/recall notes), and background (long-running commands). When the task ' +
    'needs one, call LoadToolGroup(group) FIRST to enable it, then call its tools. ' +
    'Sensitive actions (git mutations, changing the identity, switching accounts, logging ' +
    'in, background commands) ask the user for confirmation automatically — just call the ' +
    'tool and the user will approve or decline. ' +
    'Open the relevant file with OpenFile so the user can follow along. ' +
    'Work autonomously: inspect the code with Read/Grep/Glob before changing it, make ' +
    'the smallest correct edit, and prefer Edit over Write for existing files. ' +
    'Paths are relative to the workspace root. When done, give a brief summary of what ' +
    'you changed. Do not ask for confirmation in text — the user reviews changes in the editor.\n\n' +
    `Workspace root: ${workspaceRoot}`
  if (params.planMode) {
    s =
      'You are Orqon in PLAN MODE. You may ONLY investigate — read files, search, run ' +
      'diagnostics, inspect git, browse the web. You must NOT modify anything (no Write/Edit/' +
      'commits/commands). Research the request thoroughly FIRST. Only when your plan is complete ' +
      'and final, call the PresentPlan tool with the full step-by-step plan (files to change and how, ' +
      'key decisions, how to verify). Do NOT call PresentPlan until you have finished investigating — ' +
      'keep using read-only tools until you are confident. Calling PresentPlan is what shows the user ' +
      'the Approve button; until then, no approval is offered. ' +
      'As you investigate, briefly narrate what you find in one line each (this streams live to the ' +
      'user so they can follow your thinking) before you call PresentPlan.\n\n' +
      `Workspace root: ${workspaceRoot}`
  } else if (params.researchMode) {
    s =
      'You are Orqon in RESEARCH mode. Investigate the question DEEPLY and strictly READ-ONLY. You may ' +
      'read the codebase (Read/Grep/Glob/ListDir/GetDiagnostics), inspect git history (GitStatus/Diff/Log), ' +
      'and research the web with WebSearch, WebFetch, and Research (a one-call multi-source deep dive). ' +
      'Do NOT modify anything. Go DEEP: call Research with 2–4 sub-queries covering different angles of the ' +
      'question, read the returned sources, then run FOLLOW-UP Research/WebFetch calls to fill gaps, verify ' +
      'claims across sources, and chase specifics — do not stop at the first search. Keep digging until the ' +
      'answer is well-supported, then write a thorough, well-structured answer that CITES its sources ' +
      '(URLs / file paths).\n\n' +
      `Workspace root: ${workspaceRoot}`
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
  emit: (e: IdeAgentEvent) => void,
  signal: AbortSignal,
  requestReview?: (change: PendingChange) => Promise<ReviewDecision>,
  editorBridge?: (op: EditorRequest['op'], args: Record<string, unknown>) => Promise<EditorResponse>,
  orchestrationBridge?: OrchestrationBridge,
  requestAction?: (action: PendingAction) => Promise<boolean>,
): Promise<void> {
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
    const contextWindow = contextWindowFor(model, pc)
    const planMode = Boolean(params.planMode)
    const researchMode = Boolean(params.researchMode) && !planMode
    // Plan/research use a curated read-only set (no lazy loading). Normal mode
    // sends only the core set + LoadToolGroup; extra groups load on demand.
    let activeSpecs: ToolSpec[]
    if (planMode) {
      activeSpecs = toolSpecsFor({ allowBash, orchestrationEnabled }).filter((s) => PLAN_READONLY_TOOLS.has(s.name))
      activeSpecs.push(PRESENT_PLAN_SPEC)
    } else if (researchMode) {
      activeSpecs = toolSpecsFor({ allowBash, orchestrationEnabled }).filter((s) => RESEARCH_READONLY_TOOLS.has(s.name))
    } else {
      activeSpecs = coreSpecsFor({ allowBash, orchestrationEnabled })
    }
    let adapter = buildAdapter(pc, key, model, activeSpecs)
    const loadedGroups = new Set<string>()
    const system = buildSystemPrompt(params, workspaceRoot)
    // Seed the conversation with the prior chat turns (user + assistant text).
    const messages: unknown[] = params.messages.map((m) => ({ role: m.role, content: m.content }))

    let finalText = ''
    let turns = 0
    let anyActivity = false // any tool call ran this run

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
      }

      if (text) finalText = text
      if (toolCalls.length === 0) {
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

        let result: string
        let isError = false
        const isMutation = call.name === 'Write' || call.name === 'Edit'
        const isEditorTool = EDITOR_TOOL_NAMES.has(call.name)
        const isOrchTool = ORCH_TOOL_NAMES.has(call.name)
        const isExtraTool = EXTRA_TOOL_NAMES.has(call.name)
        const isExcelTool = EXCEL_TOOL_NAMES.has(call.name)

        if (isExcelTool) {
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
            const r = runFileTool(workspaceRoot, call.name, call.args)
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

        results.push(result)
        emit({ type: 'tool_result', callId, name: call.name, result: result.slice(0, 2000), isError })
      }

      messages.push(assistantMsg)
      for (const m of adapter.toolResultsMessages(toolCalls, results)) messages.push(m)
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
