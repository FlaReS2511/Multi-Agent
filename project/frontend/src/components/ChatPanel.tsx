// ChatPanel.tsx — an in-editor coding assistant chat.
//
// Reuses the same providers/keys as the agents and the inline "Ask AI" edit.
// Streams responses token-by-token over the ai-chat IPC channel and can inject
// the currently open file (+ selection) as context so the model can reason
// about the code the user is looking at.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, Send, Square, Trash2, FileCode } from 'lucide-react'
import { ModelOption } from '../lib/api'

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

interface Props {
  models: ModelOption[]
  // Provides the file context on demand (called at send time so it's fresh).
  getContext: () => ChatContext | null
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

export function ChatPanel({ models, getContext, windup = true }: Props) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [useFileContext, setUseFileContext] = useState(true)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const reqIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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
  }, [messages, streaming])

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

  const stop = () => {
    if (reqIdRef.current) window.api.aiChatCancel(reqIdRef.current)
    setStreaming(false)
  }

  const clear = () => {
    if (streaming) stop()
    setMessages([])
  }

  const ctxPreview = useFileContext ? getContext() : null

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
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          <Sparkles size={13} className="text-blue-400" />
          Chat
        </div>
        <button
          onClick={clear}
          disabled={messages.length === 0}
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
        {messages.length === 0 && (
          <div className="text-center text-zinc-600 text-xs mt-8 leading-relaxed px-4">
            Ask about the code you're working on.<br />
            The open file is sent as context.
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} role={m.role} content={m.content} streaming={streaming && i === messages.length - 1} />
        ))}
      </motion.div>

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
              send()
            }
          }}
          rows={3}
          placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"
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
              onClick={send}
              disabled={!input.trim()}
              title="Send"
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
