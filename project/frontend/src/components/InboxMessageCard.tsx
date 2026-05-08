import { useState } from 'react'
import { AGENT_COLORS } from '../lib/api'

export interface ParsedMessage {
  id: string
  raw: string
  ts: string | null
  from: string | null
  to: string | null
  taskId: string | null
  subject: string | null
  priority: string | null
  body: string
}

const HEADER_RE = /^##\s*\[([^\]]+)\]\s*FROM:\s*([^|]+?)\s*\|\s*TO:\s*([^|]+?)\s*\|\s*TASK:\s*(\S+)/

export function parseInbox(content: string): ParsedMessage[] {
  if (!content.trim()) return []
  const blocks = content.split(/^---\s*$/m)
  const result: ParsedMessage[] = []
  blocks.forEach((block, idx) => {
    const trimmed = block.trim()
    if (!trimmed || !trimmed.startsWith('##')) return

    const lines = trimmed.split('\n')
    const headerLine = lines[0] ?? ''
    const m = headerLine.match(HEADER_RE)

    let subject: string | null = null
    let priority: string | null = null
    let bodyStartIdx = 1
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const sm = line.match(/^\*\*Subject:\*\*\s*(.+)/)
      const pm = line.match(/^\*\*Priority:\*\*\s*(\w+)/)
      if (sm) {
        subject = sm[1].trim()
        bodyStartIdx = Math.max(bodyStartIdx, i + 1)
      } else if (pm) {
        priority = pm[1].trim()
        bodyStartIdx = Math.max(bodyStartIdx, i + 1)
      } else if (/^\*\*Deps:\*\*/.test(line)) {
        bodyStartIdx = Math.max(bodyStartIdx, i + 1)
      }
    }

    const body = lines.slice(bodyStartIdx).join('\n').trim()

    result.push({
      id: `${idx}-${headerLine.slice(0, 80)}`,
      raw: trimmed,
      ts: m?.[1]?.trim() ?? null,
      from: m?.[2]?.trim() ?? null,
      to: m?.[3]?.trim() ?? null,
      taskId: m?.[4]?.trim() ?? null,
      subject,
      priority,
      body,
    })
  })
  return result
}

interface CardProps {
  msg: ParsedMessage
  unread: boolean
  defaultExpanded?: boolean
}

export function InboxMessageCard({ msg, unread, defaultExpanded = false }: CardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [showRaw, setShowRaw] = useState(false)

  const fromColor = msg.from ? AGENT_COLORS[msg.from] ?? 'text-zinc-300' : 'text-zinc-300'
  const toColor = msg.to ? AGENT_COLORS[msg.to] ?? 'text-zinc-300' : 'text-zinc-300'

  return (
    <div
      className={`rounded border bg-zinc-900/40 transition-colors ${
        unread ? 'border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]' : 'border-zinc-800/60'
      }`}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-zinc-900/60 rounded-t"
      >
        <span className="text-zinc-600 text-[10px] w-3">{expanded ? '▾' : '▸'}</span>
        {unread && (
          <span className="size-1.5 rounded-full bg-amber-400" title="Unread" />
        )}
        {msg.taskId && (
          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-zinc-800 text-zinc-300">
            {msg.taskId}
          </span>
        )}
        <span className={`text-[11px] font-medium ${fromColor}`}>{msg.from ?? '?'}</span>
        <span className="text-zinc-600 text-[10px]">→</span>
        <span className={`text-[11px] font-medium ${toColor}`}>{msg.to ?? '?'}</span>
        {msg.priority && (
          <span
            className={`px-1.5 py-0.5 text-[9px] rounded font-bold ${
              msg.priority === 'high'
                ? 'bg-rose-500/20 text-rose-300'
                : msg.priority === 'low'
                ? 'bg-zinc-700/40 text-zinc-400'
                : 'bg-blue-500/20 text-blue-300'
            }`}
          >
            {msg.priority.toUpperCase()}
          </span>
        )}
        <span className="ml-auto text-[10px] text-zinc-500 font-mono">{msg.ts}</span>
      </button>
      {msg.subject && (
        <div className="px-3 pb-2 text-xs text-zinc-200 truncate">{msg.subject}</div>
      )}

      {expanded && (
        <div className="border-t border-zinc-800/60">
          <div className="px-3 py-1 flex items-center justify-end gap-2 text-[10px]">
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-zinc-800"
            >
              {showRaw ? 'Formatted' : 'Raw'}
            </button>
          </div>
          {showRaw ? (
            <pre className="px-3 pb-3 text-[11px] font-mono text-zinc-400 whitespace-pre-wrap leading-relaxed">
              {msg.raw}
            </pre>
          ) : (
            <div className="px-3 pb-3 text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
              {msg.body || <span className="italic text-zinc-600">(empty body)</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
