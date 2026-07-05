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

// File tools minus Bash (dangerous; gated in a later phase) + editor tools.
const IDE_TOOL_SPECS: ToolSpec[] = [
  ...FILE_TOOL_SPECS.filter((s) => s.name !== 'Bash'),
  ...EDITOR_TOOL_SPECS,
]

export interface IdeAgentParams {
  provider: string
  model?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  // The file currently open in the editor (optional context).
  openFile?: { path: string; language?: string; content: string }
  selection?: string
  // When true, every Write/Edit is held for user approval before hitting disk.
  reviewMode?: boolean
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
  | { type: 'done'; text: string; turns: number }
  | { type: 'error'; error: string }

interface ProviderCfg extends ProviderCfgLike {
  models?: string[]
  price_in?: number
  price_out?: number
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

    const adapter = buildAdapter(pc, key, model, IDE_TOOL_SPECS)
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

      if (text) finalText = text
      if (toolCalls.length === 0) break

      const reviewOn = Boolean(params.reviewMode && requestReview)
      const results: string[] = []
      for (const call of toolCalls) {
        if (signal.aborted) { emit({ type: 'error', error: 'cancelled' }); return }
        const callId = call.id || `${call.name}-${Date.now()}`
        emit({ type: 'tool_call', callId, name: call.name, args: call.args })
        let result: string
        let isError = false
        const isMutation = call.name === 'Write' || call.name === 'Edit'
        const isEditorTool = EDITOR_TOOL_NAMES.has(call.name)

        if (isEditorTool) {
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
