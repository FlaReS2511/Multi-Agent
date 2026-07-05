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
} from './agent-tools'
import { buildAdapter, ProviderCfgLike } from './adapters'
import { contextWindowFor } from './context-window'
import * as db from './db'

const MAX_TURNS = parseInt(process.env.IDE_AGENT_MAX_TURNS || '30', 10)

// Editor round-trip tools (GĐ2). These don't touch fs — main asks the renderer
// to drive the Monaco editor the user is looking at, then returns the result.
const EDITOR_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'OpenFile',
    description: 'Open a file in the editor so the user can see it (like clicking it in the file tree). Optionally jump to a line. Use this to show the user what you are working on.',
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

// Build the tool set for a run. Bash and orchestration tools are opt-in.
function toolSpecsFor(opts: { allowBash: boolean; orchestrationEnabled: boolean }): ToolSpec[] {
  const specs: ToolSpec[] = [
    ...FILE_TOOL_SPECS.filter((s) => opts.allowBash || s.name !== 'Bash'),
    ...EDITOR_TOOL_SPECS,
    REPORT_BLOCKED_SPEC,
  ]
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
  | { type: 'file_changed'; path: string }
  | { type: 'context'; used: number; window: number; turn: number }
  | { type: 'blocked'; reason: string; turns: number }
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
    'to read and modify the user\'s workspace directly: Read, Write, Edit, Grep, Glob. ' +
    'You also have editor tools to work with what the user sees: OpenFile (show a file ' +
    'in the editor, optionally at a line), GetOpenEditor (get the currently viewed file ' +
    'and selection), and ShowDiff (preview a proposed change without writing it). ' +
    'Open the relevant file with OpenFile so the user can follow along. ' +
    'Work autonomously: inspect the code with Read/Grep/Glob before changing it, make ' +
    'the smallest correct edit, and prefer Edit over Write for existing files. ' +
    'Paths are relative to the workspace root. When done, give a brief summary of what ' +
    'you changed. Do not ask for confirmation — the user reviews changes in the editor.\n\n' +
    `Workspace root: ${workspaceRoot}`
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
    const specs = toolSpecsFor({ allowBash, orchestrationEnabled })
    const adapter = buildAdapter(pc, key, model, specs)
    const system = buildSystemPrompt(params, workspaceRoot)
    // Seed the conversation with the prior chat turns (user + assistant text).
    const messages: unknown[] = params.messages.map((m) => ({ role: m.role, content: m.content }))

    let finalText = ''
    let turns = 0

    for (let i = 0; i < MAX_TURNS; i++) {
      if (signal.aborted) { emit({ type: 'error', error: 'cancelled' }); return }
      const turn = turns
      const { text, toolCalls, assistantMsg, usage } = await adapter.chatStream(
        messages,
        system,
        {
          onText: (delta) => emit({ type: 'token', delta, turn }),
          onReasoning: (delta) => emit({ type: 'reasoning', delta, turn }),
        },
        signal,
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
      }

      if (text) finalText = text
      if (toolCalls.length === 0) break

      const reviewOn = Boolean(params.reviewMode && requestReview)
      const results: string[] = []
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

        let result: string
        let isError = false
        const isMutation = call.name === 'Write' || call.name === 'Edit'
        const isEditorTool = EDITOR_TOOL_NAMES.has(call.name)
        const isOrchTool = ORCH_TOOL_NAMES.has(call.name)

        if (isOrchTool) {
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
          if (isMutation && !isError) {
            const rel = (call.args as { path?: string }).path
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
