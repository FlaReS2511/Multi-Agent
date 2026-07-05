// ChatPanel.tsx — an in-editor coding assistant chat.
//
// Reuses the same providers/keys as the agents and the inline "Ask AI" edit.
// Streams responses token-by-token over the ai-chat IPC channel and can inject
// the currently open file (+ selection) as context so the model can reason
// about the code the user is looking at.

import { useEffect, useRef, useState, ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles, Send, Square, Trash2, FileCode,
  FileText, FilePen, FilePlus2, Search, FolderSearch, Wrench, CheckCircle2, XCircle,
} from 'lucide-react'
import { ModelOption, IdeAgentEvent } from '../lib/api'

export interface ChatContext {
  path: string
  language?: string
  content: string
  selection?: string
}

interface Msg {
  role: 'user' | 'assistant'
  content: string
}

// A tool activity entry shown inline in the Agent transcript.
interface ToolEntry {
  kind: 'tool'
  callId: string
  name: string
  args: Record<string, unknown>
  result?: string
  isError?: boolean
  running: boolean
}

type AgentItem =
  | { kind: 'text'; id?: string; role: 'user' | 'assistant'; content?: string; chunks?: string[] }
  | { kind: 'reasoning'; id: string; chunks?: string[]; content?: string }
  | ToolEntry

// Revealed text of an item, whether it stores whole content or streamed chunks.
function itemText(it: AgentItem): string {
  if (it.kind === 'text' || it.kind === 'reasoning') {
    if (it.chunks) return it.chunks.join('')
    return it.content ?? ''
  }
  return ''
}

interface Props {
  models: ModelOption[]
  // Provides the file context on demand (called at send time so it's fresh).
  getContext: () => ChatContext | null
  // Called when the agent writes/edits a file, so the editor can reload it.
  onFileChanged?: (relPath: string) => void
  // When true, inner elements fade/slide in with a staggered "wind-up" after
  // the panel frame has slid open. When false, everything renders instantly.
  windup?: boolean
}

// Wind-up choreography: the frame slides open first (handled by the parent),
// then children fade/rise in sequence. delayChildren waits for the slide.
const containerVariants = {
  hidden: {},
  show: {
    transition: { delayChildren: 0.18, staggerChildren: 0.07 },
  },
}
const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: 'easeOut' } },
}

export function ChatPanel({ models, getContext, onFileChanged, windup = true }: Props) {
  const [mode, setMode] = useState<'ask' | 'agent'>('ask')
  const [messages, setMessages] = useState<Msg[]>([])
  const [agentItems, setAgentItems] = useState<AgentItem[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [useFileContext, setUseFileContext] = useState(true)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const reqIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Typewriter: target[id] = full text received; displayed length is advanced
  // toward it by a steady rAF loop so streamed tokens reveal smoothly.
  const targetRef = useRef<Map<string, string>>(new Map())
  const shownRef = useRef<Map<string, number>>(new Map())
  const rafRef = useRef<number | null>(null)

  // Default provider/model from the first available model.
  useEffect(() => {
    if (!provider && models.length > 0) {
      setProvider(models[0].provider)
      setModel(models[0].id)
    }
  }, [models, provider])

  // Auto-scroll to the bottom as content streams in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, agentItems, streaming])



  const providerIds = Array.from(new Set(models.map((m) => m.provider)))
  const providerModels = models.filter((m) => m.provider === provider)

  const send = () => {
    const text = input.trim()
    if (!text || streaming) return

    const ctx = useFileContext ? getContext() : null
    const nextMessages: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages([...nextMessages, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)

    const requestId = `chat-${Date.now()}`
    reqIdRef.current = requestId

    const offChunk = window.api.onAiChatChunk(requestId, (delta) => {
      setMessages((prev) => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = { ...last, content: last.content + delta }
        }
        return copy
      })
    })
    const offDone = window.api.onAiChatDone(requestId, (info) => {
      offChunk()
      offDone()
      reqIdRef.current = null
      setStreaming(false)
      if (!info.ok && info.error) {
        setMessages((prev) => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last && last.role === 'assistant' && !last.content) {
            copy[copy.length - 1] = { ...last, content: `⚠ ${info.error}` }
          }
          return copy
        })
      }
    })

    window.api.aiChat(requestId, {
      provider,
      model: model || undefined,
      messages: nextMessages,
      contextFiles: ctx ? [{ path: ctx.path, language: ctx.language, content: ctx.content }] : undefined,
      selection: ctx?.selection,
    })
  }

  // Typewriter reveal: each frame advance displayed text toward the received
  // target at a STEADY linear rate. If the backlog is large (model tubes faster
  // than we can type), skip ahead so we never lag thousands of chars behind —
  // keep only a short tail for the typewriter feel.
  // Reveal ~1 short chunk per couple frames. Each revealed slice becomes its
  // own <span> that fades dark→bright once (see .stream-chunk). Steady rate,
  // with catch-up if the model tubes text faster than we reveal.
  const CHUNK_SIZE = 4           // chars revealed per tick (small = glowier)
  const TICK_EVERY = 2           // reveal every N frames (slower, smoother glow)
  const MAX_BACKLOG = 240        // never trail more than this far behind
  const frameCtr = useRef(0)
  // The loop is driven by refs (targetRef = full text received, shownRef =
  // chars already revealed) so lag detection is SYNCHRONOUS — it does not rely
  // on React having flushed the last setState (which caused the loop to stall).
  const ensureReveal = () => {
    if (rafRef.current != null) return
    const step = () => {
      frameCtr.current++
      // Compute which ids still lag, straight from refs.
      const pending: { id: string; slice: string }[] = []
      let anyLag = false
      for (const [id, target] of targetRef.current) {
        const shown = shownRef.current.get(id) ?? 0
        if (shown >= target.length) continue
        const remaining = target.length - shown
        const catchUp = remaining > MAX_BACKLOG ? remaining - MAX_BACKLOG : 0
        const take = catchUp + Math.min(CHUNK_SIZE, remaining - catchUp)
        if (frameCtr.current % TICK_EVERY === 0) {
          pending.push({ id, slice: target.slice(shown, shown + take) })
          shownRef.current.set(id, shown + take)
          if (shown + take < target.length) anyLag = true
        } else {
          anyLag = true
        }
      }
      if (pending.length > 0) {
        setAgentItems((prev) => prev.map((it) => {
          if ((it.kind === 'text' || it.kind === 'reasoning') && it.id) {
            const p = pending.find((x) => x.id === it.id)
            if (p) return { ...it, chunks: [...(it.chunks ?? []), p.slice] }
          }
          return it
        }))
      }
      if (anyLag) rafRef.current = requestAnimationFrame(step)
      else rafRef.current = null
    }
    rafRef.current = requestAnimationFrame(step)
  }

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }, [])

  // Agent mode: run the tool-calling loop, rendering tool activity inline.
  const sendAgent = () => {
    const text = input.trim()
    if (!text || streaming) return

    const ctx = useFileContext ? getContext() : null
    const priorText: Msg[] = agentItems
      .filter((it): it is Extract<AgentItem, { kind: 'text' }> => it.kind === 'text')
      .map((it) => ({ role: it.role, content: itemText(it) }))
    const history: Msg[] = [...priorText, { role: 'user', content: text }]

    setAgentItems((prev) => [...prev, { kind: 'text', role: 'user', content: text }])
    setInput('')
    setStreaming(true)

    const runId = `agent-${Date.now()}`
    reqIdRef.current = runId
    targetRef.current.clear()
    shownRef.current.clear()

    const off = window.api.onAiAgentEvent(runId, (e: IdeAgentEvent) => {
      if (e.type === 'reasoning' || e.type === 'token') {
        const id = `${e.type}-${e.turn}`
        targetRef.current.set(id, (targetRef.current.get(id) ?? '') + e.delta)
        setAgentItems((prev) => {
          const idx = prev.findIndex((it) => (it.kind === 'text' || it.kind === 'reasoning') && it.id === id)
          if (idx >= 0) return prev // existing item; reveal loop grows its chunks
          const copy = [...prev]
          if (e.type === 'reasoning') copy.push({ kind: 'reasoning', id, chunks: [] })
          else copy.push({ kind: 'text', id, role: 'assistant', chunks: [] })
          return copy
        })
        ensureReveal()
        return
      }
      setAgentItems((prev) => {
        const copy = [...prev]
        if (e.type === 'tool_call') {
          copy.push({ kind: 'tool', callId: e.callId, name: e.name, args: e.args, running: true })
        } else if (e.type === 'tool_result') {
          const idx = copy.findIndex((it) => it.kind === 'tool' && it.callId === e.callId)
          if (idx >= 0) {
            const t = copy[idx] as ToolEntry
            copy[idx] = { ...t, result: e.result, isError: e.isError, running: false }
          }
        }
        return copy
      })
      if (e.type === 'file_changed') onFileChanged?.(e.path)
      if (e.type === 'done' || e.type === 'error') {
        off()
        reqIdRef.current = null
        setStreaming(false)
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
        // Snap every streaming item to its full received text — append the
        // remaining tail as one final glowing chunk, no lingering typewriter.
        setAgentItems((prev) => {
          const copy = prev.map((it) => {
            if ((it.kind === 'text' || it.kind === 'reasoning') && it.id) {
              const target = targetRef.current.get(it.id)
              const shown = shownRef.current.get(it.id) ?? 0
              if (target != null && shown < target.length) {
                shownRef.current.set(it.id, target.length)
                return { ...it, chunks: [...(it.chunks ?? []), target.slice(shown)] }
              }
            }
            return it
          })
          if (e.type === 'error') copy.push({ kind: 'text', role: 'assistant', content: `⚠ ${e.error}` })
          return copy
        })
      }
    })

    window.api.aiAgentRun(runId, {
      provider,
      model: model || undefined,
      messages: history,
      openFile: ctx ? { path: ctx.path, language: ctx.language, content: ctx.content } : undefined,
      selection: ctx?.selection,
    })
  }

  const stop = () => {
    if (reqIdRef.current) {
      if (mode === 'agent') window.api.aiAgentCancel(reqIdRef.current)
      else window.api.aiChatCancel(reqIdRef.current)
    }
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    // Snap streaming items to whatever text has arrived so far.
    setAgentItems((prev) => prev.map((it) => {
      if ((it.kind === 'text' || it.kind === 'reasoning') && it.id) {
        const target = targetRef.current.get(it.id)
        const shown = shownRef.current.get(it.id) ?? 0
        if (target != null && shown < target.length) {
          shownRef.current.set(it.id, target.length)
          return { ...it, chunks: [...(it.chunks ?? []), target.slice(shown)] }
        }
      }
      return it
    }))
    setStreaming(false)
  }

  const clear = () => {
    if (streaming) stop()
    setMessages([])
    setAgentItems([])
  }

  const submit = () => (mode === 'agent' ? sendAgent() : send())

  const ctxPreview = useFileContext ? getContext() : null

  // The most recent reasoning item — docked above the composer, not inline.
  const latestReasoning = [...agentItems].reverse().find((it) => it.kind === 'reasoning') as
    | Extract<AgentItem, { kind: 'reasoning' }>
    | undefined

  return (
    <motion.div
      className="h-full flex flex-col bg-zinc-950"
      variants={windup ? containerVariants : undefined}
      initial={windup ? 'hidden' : false}
      animate={windup ? 'show' : false}
    >
      {/* Header */}
      <motion.div
        variants={windup ? itemVariants : undefined}
        className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 flex-shrink-0"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-blue-400" />
          {/* Ask / Agent mode toggle */}
          <div className="flex rounded-md bg-zinc-900 border border-zinc-800 p-0.5">
            {(['ask', 'agent'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { if (!streaming) setMode(m) }}
                disabled={streaming}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  mode === m ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300'
                } ${streaming ? 'cursor-not-allowed' : ''}`}
                title={m === 'agent' ? 'Agent can read and modify your files' : 'Ask questions (read-only)'}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={clear}
          disabled={messages.length === 0 && agentItems.length === 0}
          title="Clear conversation"
          className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-600"
        >
          <Trash2 size={14} />
        </button>
      </motion.div>

      {/* Messages */}
      <motion.div
        variants={windup ? itemVariants : undefined}
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-4"
      >
        {mode === 'ask' ? (
          <>
            {messages.length === 0 && (
              <div className="text-center text-zinc-600 text-xs mt-8 leading-relaxed px-4">
                Ask about the code you're working on.<br />
                The open file is sent as context.
              </div>
            )}
            {messages.map((m, i) => (
              <MessageBubble key={i} role={m.role} content={m.content} streaming={streaming && i === messages.length - 1} />
            ))}
          </>
        ) : (
          <>
            {agentItems.length === 0 && (
              <div className="text-center text-zinc-600 text-xs mt-8 leading-relaxed px-4">
                Agent mode: describe a change and the agent will<br />
                read and edit files in your workspace directly.
              </div>
            )}
            {agentItems.map((it, i) =>
              it.kind === 'text' ? (
                <RiseIn key={i}>
                  {it.chunks
                    ? <GlowMessage role={it.role} chunks={it.chunks} />
                    : <MessageBubble role={it.role} content={it.content ?? ''} streaming={false} />}
                </RiseIn>
              ) : it.kind === 'tool' ? (
                <RiseIn key={i}><ToolActivity entry={it} /></RiseIn>
              ) : null,
            )}
            {streaming && (
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 px-1">
                <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
                working…
              </div>
            )}
          </>
        )}
      </motion.div>

      {/* Thinking dock — reasoning lives here, not in the chat flow */}
      {mode === 'agent' && latestReasoning && (
        <ThinkingDock chunks={latestReasoning.chunks ?? []} active={streaming} />
      )}

      {/* Composer */}
      <motion.div
        variants={windup ? itemVariants : undefined}
        className="border-t border-zinc-800 p-2.5 flex-shrink-0 space-y-2"
      >
        {/* Context chip */}
        <button
          onClick={() => setUseFileContext((v) => !v)}
          className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono transition-colors ${
            useFileContext && ctxPreview
              ? 'bg-blue-500/10 border border-blue-500/30 text-blue-300'
              : 'bg-zinc-900 border border-zinc-800 text-zinc-600'
          }`}
          title="Toggle sending the open file as context"
        >
          <FileCode size={11} />
          {ctxPreview
            ? `${useFileContext ? '' : '(off) '}${ctxPreview.path}${ctxPreview.selection ? ' · selection' : ''}`
            : 'No file open'}
        </button>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
          placeholder={mode === 'agent'
            ? 'Describe a change… the agent will edit files (Enter to run)'
            : 'Ask anything… (Enter to send, Shift+Enter for newline)'}
          className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 resize-none focus:outline-none focus:border-blue-500"
        />

        <div className="flex items-center gap-1.5">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value)
              const first = models.find((m) => m.provider === e.target.value)
              if (first) setModel(first.id)
            }}
            className="px-1.5 py-1 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-300 focus:outline-none max-w-[90px]"
          >
            {providerIds.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="flex-1 min-w-0 px-1.5 py-1 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-300 focus:outline-none"
          >
            {providerModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {streaming ? (
            <button
              onClick={stop}
              title="Stop"
              className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 flex items-center gap-1"
            >
              <Square size={11} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!input.trim()}
              title={mode === 'agent' ? 'Run agent' : 'Send'}
              className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white flex items-center gap-1"
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

function MessageBubble({ role, content, streaming }: { role: 'user' | 'assistant'; content: string; streaming: boolean }) {
  const isUser = role === 'user'
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
          isUser
            ? 'bg-blue-600/20 border border-blue-500/30 text-zinc-100'
            : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
        }`}
      >
        {content ? <MessageContent text={content} /> : streaming ? (
          <span className="inline-flex gap-1 items-center text-zinc-500">
            <span className="size-1.5 rounded-full bg-zinc-500 animate-pulse" />
            thinking…
          </span>
        ) : null}
        {streaming && content && <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-blue-400 animate-pulse" />}
      </div>
    </div>
  )
}

// Minimal markdown-ish renderer: splits fenced code blocks from prose.
function MessageContent({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```$/)
        if (m) {
          const lang = m[1]
          const code = m[2].replace(/\n$/, '')
          return (
            <pre key={i} className="my-1.5 p-2 rounded bg-zinc-950 border border-zinc-800 overflow-x-auto">
              {lang && <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1">{lang}</div>}
              <code className="text-[11px] font-mono text-zinc-200 whitespace-pre">{code}</code>
            </pre>
          )
        }
        if (!part) return null
        return <span key={i} className="whitespace-pre-wrap">{part}</span>
      })}
    </>
  )
}

// Render streamed chunks with a dark→bright glow reveal. Only the last few
// chunks are animated <span>s; everything older is collapsed into ONE static
// text node. This keeps the DOM tiny (a handful of spans, not hundreds) so the
// animation never bogs down on long outputs.
const GLOW_TAIL = 12
function GlowChunks({ chunks }: { chunks: string[] }) {
  if (chunks.length <= GLOW_TAIL) {
    return (
      <>
        {chunks.map((c, i) => <span key={i} className="stream-chunk">{c}</span>)}
      </>
    )
  }
  const splitAt = chunks.length - GLOW_TAIL
  const head = chunks.slice(0, splitAt).join('')
  const tail = chunks.slice(splitAt)
  return (
    <>
      <span>{head}</span>
      {tail.map((c, i) => <span key={splitAt + i} className="stream-chunk">{c}</span>)}
    </>
  )
}

// Assistant text rendered as glowing streamed chunks (agent mode).
function GlowMessage({ role, chunks }: { role: 'user' | 'assistant'; chunks: string[] }) {
  const isUser = role === 'user'
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-blue-600/20 border border-blue-500/30 text-zinc-100'
            : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
        }`}
      >
        <GlowChunks chunks={chunks} />
      </div>
    </div>
  )
}

// Fade + rise-in wrapper for transcript items appearing one by one.
function RiseIn({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

// Renders text as per-word spans whose dark-dip animation is staggered by word
// index, so a dark band sweeps through the words in reading order (left→right,
// wrapping line to line) and loops. The whole band completes one pass per CYCLE.
// Codex-style shimmer: dim text with a brighter band sweeping horizontally.
// The gradient is clipped to the glyphs, so it flows smoothly at the pixel
// level (not per word). All wrapped lines share one moving band.
function ShimmerText({ text }: { text: string }) {
  return <span className="thinking-shimmer">{text}</span>
}

// The model's reasoning ("thinking"), docked above the composer so it doesn't
// clutter the chat. Collapsed by default: shows the last couple of lines auto-
// scrolling like a ticker. Expand for the full, scrollable chain.
function ThinkingDock({ chunks, active }: { chunks: string[]; active: boolean }) {
  const [expanded, setExpanded] = useState(false)
  // "settled" = text has fully streamed in but the model is still thinking
  // (no new chunk for a beat). Drives the loading shimmer sweep.
  const [settled, setSettled] = useState(false)
  const tickerRef = useRef<HTMLDivElement>(null)

  // Keep the collapsed ticker pinned to the newest text as it streams.
  useEffect(() => {
    if (!expanded) tickerRef.current?.scrollTo({ top: tickerRef.current.scrollHeight })
  }, [chunks, expanded])

  // Whenever new reasoning text arrives, reset "settled"; if nothing new comes
  // for 700ms while still active, mark settled so the shimmer kicks in.
  const total = chunks.length
  useEffect(() => {
    setSettled(false)
    if (!active) return
    const t = setTimeout(() => setSettled(true), 700)
    return () => clearTimeout(t)
  }, [total, active])
  const shimmer = active && settled

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="border-t border-zinc-800 bg-zinc-900/40 flex-shrink-0"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
      >
        <Sparkles size={11} className={active ? 'text-violet-400 animate-pulse' : 'text-violet-400/60'} />
        <span>{active ? 'Thinking…' : 'Thought process'}</span>
        <span className="ml-auto text-zinc-600">{expanded ? 'collapse ▾' : 'expand ▴'}</span>
      </button>
      <div
        ref={tickerRef}
        className={`px-3 pb-2 text-[12.5px] leading-relaxed whitespace-pre-wrap overflow-y-auto scrollbar-thin transition-all ${
          shimmer ? '' : 'text-zinc-400'
        } ${expanded ? 'max-h-60' : 'max-h-10'}`}
        style={expanded ? undefined : { maskImage: 'linear-gradient(to bottom, transparent, black 40%)' }}
      >
        {shimmer ? <ShimmerText text={chunks.join('')} /> : <GlowChunks chunks={chunks} />}
      </div>
    </motion.div>
  )
}

// Inline card for one tool call. Collapsed by default: a single summary line
// (icon + name + target). Expand to see the tool's output.
function ToolActivity({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false)
  const icon = {
    Read: <FileText size={12} />,
    Write: <FilePlus2 size={12} />,
    Edit: <FilePen size={12} />,
    Grep: <Search size={12} />,
    Glob: <FolderSearch size={12} />,
  }[entry.name] ?? <Wrench size={12} />

  const p = entry.args as { path?: string; pattern?: string; command?: string }
  const target = p.path || p.pattern || p.command || ''
  const hasResult = Boolean(entry.result) && !entry.running

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 text-[11px]">
      <button
        onClick={() => hasResult && setOpen((v) => !v)}
        className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left ${hasResult ? 'hover:bg-zinc-800/40' : 'cursor-default'}`}
      >
        <span className="text-zinc-400">{icon}</span>
        <span className="font-semibold text-zinc-300">{entry.name}</span>
        {target && <span className="font-mono text-zinc-500 truncate">{target}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {hasResult && <span className="text-zinc-600 text-[9px]">{open ? '▾' : '▸'}</span>}
          {entry.running ? (
            <span className="size-1.5 rounded-full bg-blue-400 animate-pulse inline-block" />
          ) : entry.isError ? (
            <XCircle size={12} className="text-rose-400" />
          ) : (
            <CheckCircle2 size={12} className="text-emerald-400" />
          )}
        </span>
      </button>
      {open && hasResult && (
        <pre className={`px-2.5 pb-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-snug scrollbar-thin ${
          entry.isError ? 'text-rose-300/80' : 'text-zinc-500'
        }`}>
          {entry.result!.length > 1000 ? entry.result!.slice(0, 1000) + '…' : entry.result}
        </pre>
      )}
    </div>
  )
}
