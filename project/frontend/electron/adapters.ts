// adapters.ts — provider adapters with tool-calling, over fetch (no SDK).
//
// Extracted from agent-runtime.ts so the IDE agent and the group worker share
// one implementation. Each adapter exposes chat() → { text, toolCalls,
// assistantMsg, usage } and toolResultsMessages() to feed tool outputs back in.
// Non-streaming: one request per turn, tool loop drives the conversation.

import { ToolSpec } from './agent-tools'

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  assistantMsg: unknown
  usage: { input: number; output: number }
  // True when a stream closed WITHOUT a proper finish marker ([DONE] /
  // finish_reason / message_stop) — the reply is likely truncated upstream.
  dropped?: boolean
}
// Callbacks fired during a streaming turn, so the UI can render text and
// reasoning tokens as they arrive.
export interface StreamHandlers {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
}

export interface Adapter {
  model: string
  chat(messages: unknown[], system: string): Promise<ChatResult>
  // Streaming variant: same result, but text/reasoning tokens are delivered
  // incrementally via handlers as they arrive.
  chatStream(messages: unknown[], system: string, handlers: StreamHandlers, signal?: AbortSignal): Promise<ChatResult>
  toolResultsMessages(toolCalls: ToolCall[], results: string[]): unknown[]
}

// Read an SSE stream, invoking onData with each `data:` payload string.
async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    if (signal?.aborted) { try { await reader.cancel() } catch { /* ignore */ } return }
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) onData(trimmed.slice(5).trim())
    }
  }
}

export class OpenAIAdapter implements Adapter {
  model: string
  private baseUrl: string
  private key: string
  private tools: unknown[]

  constructor(model: string, baseUrl: string | undefined, key: string, toolSpecs: ToolSpec[]) {
    this.model = model || 'gpt-5'
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.key = key || 'no-key'
    this.tools = toolSpecs.map((s) => ({
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

  async chatStream(
    messages: unknown[], system: string, handlers: StreamHandlers, signal?: AbortSignal,
  ): Promise<ChatResult> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...messages],
        tools: this.tools,
        tool_choice: 'auto',
        max_tokens: 8192,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
    }

    let text = ''
    let reasoning = ''
    let usageIn = 0
    let usageOut = 0
    // Did the stream end properly ([DONE] / finish_reason) or just drop?
    let finished = false
    // Accumulate tool calls by index (OpenAI streams argument fragments).
    const tcAcc = new Map<number, { id: string; name: string; args: string }>()

    await readSse(resp.body, (data) => {
      if (data === '[DONE]') { finished = true; return }
      let json: any
      try { json = JSON.parse(data) } catch { return }
      if (json.usage) {
        usageIn = json.usage.prompt_tokens ?? usageIn
        usageOut = json.usage.completion_tokens ?? usageOut
      }
      if (json.choices?.[0]?.finish_reason) finished = true
      const delta = json.choices?.[0]?.delta
      if (!delta) return
      const rc: string | undefined = delta.reasoning_content ?? delta.reasoning
      if (rc) { reasoning += rc; handlers.onReasoning?.(rc) }
      if (delta.content) { text += delta.content; handlers.onText?.(delta.content) }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const cur = tcAcc.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          tcAcc.set(idx, cur)
        }
      }
    }, signal)

    const toolCalls: ToolCall[] = [...tcAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(v.args || '{}') } catch { /* leave empty */ }
        return { id: v.id, name: v.name, args }
      })

    if (!text && toolCalls.length === 0 && reasoning) text = reasoning
    const assistantMsg: any = { role: 'assistant', content: text }
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }))
    }
    return { text, toolCalls, assistantMsg, usage: { input: usageIn, output: usageOut }, dropped: !finished }
  }

  toolResultsMessages(toolCalls: ToolCall[], results: string[]): unknown[] {
    return toolCalls.map((tc, i) => ({ role: 'tool', tool_call_id: tc.id, content: String(results[i]) }))
  }
}

export class AnthropicAdapter implements Adapter {
  model: string
  private baseUrl: string
  private key: string
  private tools: unknown[]

  constructor(model: string, key: string, baseUrl: string | undefined, toolSpecs: ToolSpec[]) {
    this.model = model || 'claude-sonnet-4-6'
    this.baseUrl = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
    this.key = key
    this.tools = toolSpecs.map((s) => ({
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

  async chatStream(
    messages: unknown[], system: string, handlers: StreamHandlers, signal?: AbortSignal,
  ): Promise<ChatResult> {
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
        stream: true,
      }),
      signal,
    })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`provider HTTP ${resp.status}: ${errText.slice(0, 300)}`)
    }

    // Reconstruct content blocks (text | thinking | tool_use) from the event
    // stream so we can rebuild the exact assistantMsg Anthropic expects back.
    const blocks: any[] = []
    let usageIn = 0
    let usageOut = 0
    // Did the stream end properly (message_stop) or just drop?
    let finished = false

    await readSse(resp.body, (data) => {
      let ev: any
      try { ev = JSON.parse(data) } catch { return }
      switch (ev.type) {
        case 'message_start':
          usageIn = ev.message?.usage?.input_tokens ?? usageIn
          break
        case 'content_block_start':
          blocks[ev.index] = ev.content_block?.type === 'tool_use'
            ? { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, input: {}, _json: '' }
            : ev.content_block?.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { type: 'text', text: '' }
          break
        case 'content_block_delta': {
          const b = blocks[ev.index]
          if (!b) return
          const d = ev.delta
          if (d.type === 'text_delta') { b.text += d.text; handlers.onText?.(d.text) }
          else if (d.type === 'thinking_delta') { b.thinking += d.thinking; handlers.onReasoning?.(d.thinking) }
          else if (d.type === 'input_json_delta') { b._json += d.partial_json }
          break
        }
        case 'message_delta':
          usageOut = ev.usage?.output_tokens ?? usageOut
          break
        case 'message_stop':
          finished = true
          break
      }
    }, signal)

    const textParts: string[] = []
    const toolCalls: ToolCall[] = []
    const cleanBlocks: any[] = []
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'text') { textParts.push(b.text); cleanBlocks.push({ type: 'text', text: b.text }) }
      else if (b.type === 'thinking') { cleanBlocks.push({ type: 'thinking', thinking: b.thinking }) }
      else if (b.type === 'tool_use') {
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(b._json || '{}') } catch { /* leave empty */ }
        toolCalls.push({ id: b.id, name: b.name, args: input })
        cleanBlocks.push({ type: 'tool_use', id: b.id, name: b.name, input })
      }
    }

    return {
      text: textParts.join('\n'),
      toolCalls,
      assistantMsg: { role: 'assistant', content: cleanBlocks },
      usage: { input: usageIn, output: usageOut },
      dropped: !finished,
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

export interface ProviderCfgLike { kind?: string; base_url?: string }

export function buildAdapter(
  providerCfg: ProviderCfgLike,
  key: string,
  model: string,
  toolSpecs: ToolSpec[],
): Adapter {
  const kind = providerCfg.kind || 'openai-compatible'
  if (kind === 'anthropic') return new AnthropicAdapter(model, key, providerCfg.base_url, toolSpecs)
  if (kind === 'openai' || kind === 'openai-compatible') {
    return new OpenAIAdapter(model, providerCfg.base_url, key, toolSpecs)
  }
  throw new Error(`unsupported provider kind: ${kind}`)
}
