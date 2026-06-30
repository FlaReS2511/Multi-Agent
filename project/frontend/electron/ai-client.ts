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
}
