// ai-client.ts — direct provider calls for the inline "Ask AI" editor feature.
//
// Reuses the dynamic provider model from shared/agents-config.json (the same
// providers the agents use) and the encrypted keys in the DB. Streams the
// completion back to the renderer chunk-by-chunk via a callback.
//
// Uses global fetch (Node 20+ in Electron) so no provider SDK is needed on the
// Node side. Supports two wire formats:
//   - OpenAI Chat Completions SSE  (kind: openai | openai-compatible)
//   - Anthropic Messages SSE       (kind: anthropic)

import path from 'node:path'
import fs from 'node:fs/promises'
import * as db from './db'

interface ProviderCfg {
  kind: string
  name?: string
  base_url?: string
  models?: string[]
}

export interface InlineEditParams {
  provider: string
  model?: string
  instruction: string
  selection: string
  language?: string
  prefix?: string // code before the selection (context)
  suffix?: string // code after the selection (context)
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatContextFile {
  path: string
  language?: string
  content: string
}

export interface ChatParams {
  provider: string
  model?: string
  messages: ChatMessage[]
  // Optional file context (e.g. the file currently open in the editor).
  contextFiles?: ChatContextFile[]
  // Optional selected snippet the user is asking about.
  selection?: string
}

async function loadProviders(sharedDir: string): Promise<Record<string, ProviderCfg>> {
  try {
    const raw = await fs.readFile(path.join(sharedDir, 'agents-config.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    return cfg.providers ?? {}
  } catch {
    return {}
  }
}

function buildPrompt(p: InlineEditParams): { system: string; user: string } {
  const system =
    'You are a precise code-editing assistant embedded in an IDE. The user has ' +
    'selected a region of code and wants it rewritten according to an instruction. ' +
    'Return ONLY the replacement code for the selected region — no explanations, ' +
    'no markdown fences, no commentary. Preserve surrounding indentation style.'
  const lang = p.language ? ` (language: ${p.language})` : ''
  const ctxBefore = p.prefix ? `\n\nCode before selection:\n\`\`\`\n${p.prefix.slice(-1500)}\n\`\`\`` : ''
  const ctxAfter = p.suffix ? `\n\nCode after selection:\n\`\`\`\n${p.suffix.slice(0, 1500)}\n\`\`\`` : ''
  const user =
    `Instruction: ${p.instruction}${lang}` +
    ctxBefore +
    ctxAfter +
    `\n\nSelected code to rewrite:\n\`\`\`\n${p.selection}\n\`\`\`\n\n` +
    `Return only the rewritten replacement for the selected code.`
  return { system, user }
}

function decryptKeyFor(provider: string, decrypt: (b64: string) => string): string {
  const enc = db.getSecret(provider)
  return enc ? decrypt(enc) : ''
}

// Strip a leading/trailing ```lang fence if the model added one despite being told not to.
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/
  const m = trimmed.match(fence)
  return m ? m[1] : text
}

// Stream an inline edit. onChunk receives incremental text; resolves with the
// full text when done. Throws on HTTP / config errors.
export async function streamInlineEdit(
  sharedDir: string,
  params: InlineEditParams,
  decrypt: (b64: string) => string,
  onChunk: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const providers = await loadProviders(sharedDir)
  const pc = providers[params.provider]
  if (!pc) throw new Error(`unknown provider: ${params.provider}`)
  const key = decryptKeyFor(params.provider, decrypt)
  const model = params.model || pc.models?.[0] || ''
  if (!model) throw new Error(`no model for provider ${params.provider}`)
  const { system, user } = buildPrompt(params)

  if (pc.kind === 'anthropic') {
    return streamAnthropic(pc, model, key, system, user, onChunk, signal)
  }
  // openai | openai-compatible
  return streamOpenAI(pc, model, key, system, user, onChunk, signal)
}

// ── Chat (multi-turn coding assistant) ───────────────────────────
// Reuses the same providers/keys as inline edit, but keeps full conversation
// history and injects the open file(s) as context.

function buildChatSystem(params: ChatParams): string {
  let system =
    'You are an expert AI coding assistant embedded in an IDE. ' +
    'Help the user understand, write, and improve code. Be concise and precise. ' +
    'When you output code, always use fenced code blocks with a language tag. ' +
    'Reference file names and line numbers when relevant.'

  if (params.contextFiles && params.contextFiles.length > 0) {
    system += '\n\nThe user is working in these files:\n'
    for (const f of params.contextFiles) {
      // Cap each file so a huge file cannot blow the context / cost budget.
      const body = f.content.length > 12000 ? f.content.slice(0, 12000) + '\n… (truncated)' : f.content
      system += `\n--- ${f.path} ---\n\`\`\`${f.language ?? ''}\n${body}\n\`\`\`\n`
    }
  }
  if (params.selection && params.selection.trim()) {
    system += `\n\nThe user has selected this snippet:\n\`\`\`\n${params.selection.slice(0, 4000)}\n\`\`\`\n`
  }
  return system
}

// Stream a chat completion. onChunk receives incremental text; resolves with
// the full text when done. Throws on HTTP / config errors.
export async function streamChat(
  sharedDir: string,
  params: ChatParams,
  decrypt: (b64: string) => string,
  onChunk: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const providers = await loadProviders(sharedDir)
  const pc = providers[params.provider]
  if (!pc) throw new Error(`unknown provider: ${params.provider}`)
  const key = decryptKeyFor(params.provider, decrypt)
  const model = params.model || pc.models?.[0] || ''
  if (!model) throw new Error(`no model for provider ${params.provider}`)
  const system = buildChatSystem(params)

  if (pc.kind === 'anthropic') {
    return streamAnthropicChat(pc, model, key, system, params.messages, onChunk, signal)
  }
  return streamOpenAIChat(pc, model, key, system, params.messages, onChunk, signal)
}

async function streamOpenAI(
  pc: ProviderCfg, model: string, key: string,
  system: string, user: string,
  onChunk: (d: string) => void, signal?: AbortSignal,
): Promise<string> {
  const base = (pc.base_url || 'https://api.openai.com/v1').replace(/\/$/, '')
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key || 'no-key'}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
      temperature: 0.2,
    }),
    signal,
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
  }
  let full = ''
  await readSse(resp.body, (data) => {
    if (data === '[DONE]') return
    try {
      const json = JSON.parse(data)
      const delta = json.choices?.[0]?.delta?.content
      if (delta) {
        full += delta
        onChunk(delta)
      }
    } catch {
      /* ignore keep-alive / partial */
    }
  })
  return full
}

async function streamAnthropic(
  pc: ProviderCfg, model: string, key: string,
  system: string, user: string,
  onChunk: (d: string) => void, signal?: AbortSignal,
): Promise<string> {
  const base = (pc.base_url || 'https://api.anthropic.com').replace(/\/$/, '')
  const resp = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
      stream: true,
    }),
    signal,
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
  }
  let full = ''
  await readSse(resp.body, (data) => {
    try {
      const json = JSON.parse(data)
      if (json.type === 'content_block_delta' && json.delta?.text) {
        full += json.delta.text
        onChunk(json.delta.text)
      }
    } catch {
      /* ignore */
    }
  })
  return full
}

async function streamOpenAIChat(
  pc: ProviderCfg, model: string, key: string,
  system: string, messages: ChatMessage[],
  onChunk: (d: string) => void, signal?: AbortSignal,
): Promise<string> {
  const base = (pc.base_url || 'https://api.openai.com/v1').replace(/\/$/, '')
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key || 'no-key'}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: true,
      temperature: 0.3,
    }),
    signal,
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
  }
  let full = ''
  let finish = ''
  let sawDone = false
  await readSse(resp.body, (data) => {
    if (data === '[DONE]') { sawDone = true; return }
    try {
      const json = JSON.parse(data)
      if (json.choices?.[0]?.finish_reason) finish = json.choices[0].finish_reason
      const delta = json.choices?.[0]?.delta?.content
      if (delta) {
        full += delta
        onChunk(delta)
      }
    } catch {
      /* ignore keep-alive / partial */
    }
  })
  // Surface silent truncation (marker goes to the UI only, not into history).
  if (finish === 'length') onChunk('\n\n⚠ [reply hit the output limit]')
  else if (!sawDone && !finish && full) onChunk('\n\n⚠ [stream dropped — reply may be truncated]')
  return full
}

async function streamAnthropicChat(
  pc: ProviderCfg, model: string, key: string,
  system: string, messages: ChatMessage[],
  onChunk: (d: string) => void, signal?: AbortSignal,
): Promise<string> {
  const base = (pc.base_url || 'https://api.anthropic.com').replace(/\/$/, '')
  const resp = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages,
      stream: true,
    }),
    signal,
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
  }
  let full = ''
  let stopReason = ''
  let stopped = false
  await readSse(resp.body, (data) => {
    try {
      const json = JSON.parse(data)
      if (json.type === 'content_block_delta' && json.delta?.text) {
        full += json.delta.text
        onChunk(json.delta.text)
      }
      if (json.type === 'message_delta' && json.delta?.stop_reason) stopReason = json.delta.stop_reason
      if (json.type === 'message_stop') stopped = true
    } catch {
      /* ignore */
    }
  })
  // Surface silent truncation (marker goes to the UI only, not into history).
  if (stopReason === 'max_tokens') onChunk('\n\n⚠ [reply hit the output limit]')
  else if (!stopped && full) onChunk('\n\n⚠ [stream dropped — reply may be truncated]')
  return full
}

// Read an SSE stream, invoking onData with each `data:` payload.
async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        onData(trimmed.slice(5).trim())
      }
    }
  }
  // Flush the tail: buffering proxies may close the stream right after a final
  // `data:` line WITHOUT a trailing newline — dropping it here silently lost
  // the end of long replies. Also flush the decoder (pending multibyte chars).
  buffer += decoder.decode()
  const tail = buffer.trim()
  if (tail.startsWith('data:')) onData(tail.slice(5).trim())
}
