// adapters.ts — provider adapters with tool-calling, over fetch (no SDK).
//
// Extracted from agent-runtime.ts so the IDE agent and the group worker share
// one implementation. Each adapter exposes chat() → { text, toolCalls,
// assistantMsg, usage } and toolResultsMessages() to feed tool outputs back in.
// Non-streaming: one request per turn, tool loop drives the conversation.

import { ToolSpec } from './agent-tools'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  // The argument JSON arrived truncated/malformed (output cap or dropped
  // stream) — the caller should NOT execute this call with empty args.
  invalid?: boolean
}

// Some OpenAI-compatible gateways don't translate a model's native tool-call
// tokens, so the call leaks into the visible text as JSON/XML instead of
// arriving in `tool_calls` — the reply reads "I'll do X:" plus a JSON blob and
// the loop sees no tool call at all. Recover those: scan the text for the
// common leak formats and convert any whose name matches a real tool.
export function extractLeakedToolCalls(
  text: string,
  toolNames: Set<string>,
): { calls: ToolCall[]; cleaned: string } | null {
  if (!text || !text.includes('{')) return null
  const calls: ToolCall[] = []
  const tryAdd = (raw: string): boolean => {
    let obj: unknown
    try { obj = JSON.parse(raw) } catch { return false }
    const items = Array.isArray(obj) ? obj : [obj]
    if (items.length === 0) return false
    const found: ToolCall[] = []
    for (const item of items as any[]) {
      const name = item?.name ?? item?.tool ?? item?.function?.name
      if (typeof name !== 'string' || !toolNames.has(name)) return false
      let args = item?.arguments ?? item?.parameters ?? item?.input ?? item?.function?.arguments ?? {}
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return false } }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
      found.push({ id: `leak-${calls.length + found.length}-${Date.now()}`, name, args })
    }
    calls.push(...found)
    return true
  }
  // Formats, most specific first: <tool_call>{…}</tool_call> (Hermes/Qwen),
  // [TOOL_CALLS][{…}] (Mistral), fenced ```json blocks, and as a last resort a
  // bare {"name": …, "arguments": {…}} object ending the reply. tryAdd only
  // accepts objects naming a KNOWN tool, so ordinary JSON in prose survives.
  const patterns = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
    /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])\s*$/,
    /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g,
    /(\{[\s\S]*\})\s*$/,
  ]
  let cleaned = text
  for (const re of patterns) {
    const matchedAny = calls.length
    cleaned = cleaned.replace(re, (m, g1: string) => (tryAdd(g1) ? '' : m))
    if (calls.length > matchedAny) break // one leak format per reply
  }
  if (calls.length === 0) return null
  return { calls, cleaned: cleaned.trim() }
}
export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  assistantMsg: unknown
  usage: { input: number; output: number }
  // True when a stream closed WITHOUT a proper finish marker ([DONE] /
  // finish_reason / message_stop) — the reply is likely truncated upstream.
  dropped?: boolean
  // Provider finish reason ('length' / 'max_tokens' = output cap hit).
  finishReason?: string
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
  // Flush the tail: buffering proxies may close the stream right after a final
  // `data:` line WITHOUT a trailing newline — dropping it here silently lost
  // the end of long replies. Also flush the decoder (pending multibyte chars).
  buffer += decoder.decode()
  const tail = buffer.trim()
  if (tail.startsWith('data:')) onData(tail.slice(5).trim())
}

export class OpenAIAdapter implements Adapter {
  model: string
  private baseUrl: string
  private key: string
  private tools: unknown[]
  private toolNames: Set<string>

  constructor(model: string, baseUrl: string | undefined, key: string, toolSpecs: ToolSpec[]) {
    this.model = model || 'gpt-5'
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.key = key || 'no-key'
    this.tools = toolSpecs.map((s) => ({
      type: 'function',
      function: { name: s.name, description: s.description, parameters: s.input_schema },
    }))
    this.toolNames = new Set(toolSpecs.map((s) => s.name))
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
        let invalid = false
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { invalid = true }
        toolCalls.push({ id: tc.id, name: tc.function?.name, args, invalid: invalid || undefined })
      }
    }
    let text: string = msg.content || ''
    if (!text && toolCalls.length === 0) {
      text = msg.reasoning_content || msg.reasoning || ''
    }
    if (toolCalls.length === 0 && text) {
      const leaked = extractLeakedToolCalls(text, this.toolNames)
      if (leaked) { toolCalls.push(...leaked.calls); text = leaked.cleaned }
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
    let finishReason = ''
    // Accumulate tool calls as the stream delivers argument fragments. Keyed
    // by the stream `index` when present, else by call id; fragments carrying
    // NEITHER attach to the most recent call — some gateways omit index
    // entirely, and merging everything into slot 0 corrupted sibling calls.
    const tcAcc: { id: string; name: string; args: string }[] = []
    const tcKeys = new Map<string, number>()
    const tcSlot = (tc: any): { id: string; name: string; args: string } => {
      const key = tc.index != null ? `i:${tc.index}` : tc.id ? `id:${tc.id}` : ''
      if (key && tcKeys.has(key)) return tcAcc[tcKeys.get(key)!]
      if (!key && tcAcc.length > 0) return tcAcc[tcAcc.length - 1]
      const slot = { id: '', name: '', args: '' }
      if (key) tcKeys.set(key, tcAcc.length)
      tcAcc.push(slot)
      return slot
    }

    await readSse(resp.body, (data) => {
      if (data === '[DONE]') { finished = true; return }
      let json: any
      try { json = JSON.parse(data) } catch { return }
      if (json.usage) {
        usageIn = json.usage.prompt_tokens ?? usageIn
        usageOut = json.usage.completion_tokens ?? usageOut
      }
      if (json.choices?.[0]?.finish_reason) { finished = true; finishReason = json.choices[0].finish_reason }
      const delta = json.choices?.[0]?.delta
      if (!delta) return
      const rc: string | undefined = delta.reasoning_content ?? delta.reasoning
      if (rc) { reasoning += rc; handlers.onReasoning?.(rc) }
      if (delta.content) { text += delta.content; handlers.onText?.(delta.content) }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const cur = tcSlot(tc)
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
        }
      }
    }, signal)

    const toolCalls: ToolCall[] = tcAcc
      .filter((v) => v.name)
      .map((v, i) => {
        let args: Record<string, unknown> = {}
        let invalid = false
        try { args = JSON.parse(v.args || '{}') } catch { invalid = true }
        return { id: v.id || `call-${i}-${Date.now()}`, name: v.name, args, invalid: invalid || undefined }
      })

    if (!text && toolCalls.length === 0 && reasoning) text = reasoning
    if (toolCalls.length === 0 && text) {
      const leaked = extractLeakedToolCalls(text, this.toolNames)
      if (leaked) { toolCalls.push(...leaked.calls); text = leaked.cleaned }
    }
    const assistantMsg: any = { role: 'assistant', content: text }
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }))
    }
    return { text, toolCalls, assistantMsg, usage: { input: usageIn, output: usageOut }, dropped: !finished, finishReason }
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
  private toolNames: Set<string>

  constructor(model: string, key: string, baseUrl: string | undefined, toolSpecs: ToolSpec[]) {
    this.model = model || 'claude-sonnet-4-6'
    this.baseUrl = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
    this.key = key
    this.tools = toolSpecs.map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: s.input_schema,
    }))
    this.toolNames = new Set(toolSpecs.map((s) => s.name))
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
    let stopReason = ''

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
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
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
        let invalid = false
        try { input = JSON.parse(b._json || '{}') } catch { invalid = true }
        toolCalls.push({ id: b.id, name: b.name, args: input, invalid: invalid || undefined })
        cleanBlocks.push({ type: 'tool_use', id: b.id, name: b.name, input })
      }
    }

    let text = textParts.join('\n')
    if (toolCalls.length === 0 && text) {
      const leaked = extractLeakedToolCalls(text, this.toolNames)
      if (leaked) {
        toolCalls.push(...leaked.calls)
        text = leaked.cleaned
        // Rebuild the assistant blocks so the tool_use ids we invented here
        // match the tool_result ids we send back next turn.
        const rebuilt: any[] = cleanBlocks.filter((blk) => blk.type === 'thinking')
        if (text) rebuilt.push({ type: 'text', text })
        for (const c of leaked.calls) rebuilt.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
        cleanBlocks.length = 0
        cleanBlocks.push(...rebuilt)
      }
    }

    return {
      text,
      toolCalls,
      assistantMsg: { role: 'assistant', content: cleanBlocks },
      usage: { input: usageIn, output: usageOut },
      dropped: !finished,
      finishReason: stopReason,
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
