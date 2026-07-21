import { useEffect, useState } from 'react'
import { Boxes, Loader2, Check, XCircle } from 'lucide-react'
import { SubAgentInfo } from '../lib/api'

// Live view of the child agents the chat agent has delegated to via
// SpawnAgent. Fed by the main-process sub-agent registry (subagent-event).
export function AgentsLivePanel() {
  const [subs, setSubs] = useState<SubAgentInfo[]>([])

  useEffect(() => {
    window.api.subagentList().then((r) => { if (r.ok) setSubs(r.subagents) }).catch(() => {})
    return window.api.onSubagentEvent((list) => setSubs(list))
  }, [])

  if (subs.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-zinc-500 leading-relaxed">
        <div className="flex items-center gap-1.5 text-zinc-400 font-medium mb-1">
          <Boxes size={13} className="text-violet-400" /> Sub-agents
        </div>
        No sub-agents running. When the chat agent delegates work with
        <span className="text-zinc-300"> SpawnAgent</span>, its children appear here live.
      </div>
    )
  }

  // Running first, then most-recently-finished.
  const sorted = [...subs].sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
    return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
  })

  return (
    <div className="flex flex-col gap-2 p-1">
      {sorted.map((s) => <SubAgentRow key={s.childRunId} sub={s} />)}
    </div>
  )
}

function SubAgentRow({ sub }: { sub: SubAgentInfo }) {
  const [, force] = useState(0)
  // Tick the elapsed time while running.
  useEffect(() => {
    if (sub.status !== 'running') return
    const iv = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(iv)
  }, [sub.status])

  const end = sub.endedAt ?? Date.now()
  const secs = Math.max(0, Math.round((end - sub.startedAt) / 1000))
  const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  const dot = sub.status === 'running'
    ? <Loader2 size={12} className="animate-spin text-blue-400" />
    : sub.status === 'done' ? <Check size={12} className="text-emerald-400" />
    : <XCircle size={12} className="text-rose-400" />

  return (
    <div className={`rounded-lg border p-2.5 ${
      sub.status === 'running' ? 'border-violet-500/40 bg-violet-500/5' : 'border-zinc-800 bg-zinc-900/40'
    }`}>
      <div className="flex items-center gap-1.5 mb-1">
        <Boxes size={12} className="text-violet-400 flex-shrink-0" />
        <span className="text-xs font-semibold text-zinc-200 truncate">{sub.label}</span>
        <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 text-[10px] text-zinc-500 font-mono">
          {dur} {dot}
        </span>
      </div>
      <div className="text-[10px] text-zinc-500 line-clamp-2 leading-snug">{sub.task}</div>
      {sub.status !== 'running' && sub.summary && (
        <div className="mt-1 text-[10px] text-zinc-400 line-clamp-3 leading-snug border-t border-zinc-800/70 pt-1">
          {sub.summary}
        </div>
      )}
    </div>
  )
}
