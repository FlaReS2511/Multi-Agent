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
import { FILE_TOOL_SPECS, runFileTool, ToolSpec } from './agent-tools'
import { buildAdapter, ProviderCfgLike } from './adapters'
import * as db from './db'

const MAX_TURNS = parseInt(process.env.IDE_AGENT_MAX_TURNS || '30', 10)

// GĐ1: file tools only, Bash excluded (dangerous; gated on later).
const IDE_TOOL_SPECS: ToolSpec[] = FILE_TOOL_SPECS.filter((s) => s.name !== 'Bash')

export interface IdeAgentParams {
  provider: string
  model?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  // The file currently open in the editor (optional context).
  openFile?: { path: string; language?: string; content: string }
  selection?: string
}

export type IdeAgentEvent =
  | { type: 'reasoning'; delta: string; turn: number }
  | { type: 'token'; delta: string; turn: number }
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; result: string; isError: boolean }
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
// aborts between turns. Resolves when the loop ends (done or error emitted).
export async function runIdeAgent(
  sharedDir: string,
  params: IdeAgentParams,
  decrypt: (b64: string) => string,
  emit: (e: IdeAgentEvent) => void,
  signal: AbortSignal,
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

      const results: string[] = []
      for (const call of toolCalls) {
        if (signal.aborted) { emit({ type: 'error', error: 'cancelled' }); return }
        const callId = call.id || `${call.name}-${Date.now()}`
        emit({ type: 'tool_call', callId, name: call.name, args: call.args })
        let result: string
        let isError = false
        try {
          const r = runFileTool(workspaceRoot, call.name, call.args)
          result = r == null ? `error: unknown tool ${call.name}` : r
          if (r == null || r.startsWith('error:')) isError = true
        } catch (e: any) {
          result = `error: ${e?.message || e}`
          isError = true
        }
        results.push(result)
        emit({ type: 'tool_result', callId, name: call.name, result: result.slice(0, 2000), isError })
        // Notify the renderer so it can reload a changed file / the tree.
        if ((call.name === 'Write' || call.name === 'Edit') && !isError) {
          const rel = (call.args as { path?: string }).path
          if (rel) emit({ type: 'file_changed', path: rel })
        }
      }

      messages.push(assistantMsg)
      for (const m of adapter.toolResultsMessages(toolCalls, results)) messages.push(m)
    }

    emit({ type: 'done', text: finalText, turns })
  } catch (e: any) {
    emit({ type: 'error', error: e?.message || String(e) })
  }
}
