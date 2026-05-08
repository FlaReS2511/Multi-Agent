import { useEffect, useState } from 'react'
import { Task, TaskThreadEntry, AGENT_COLORS, STATUS_STYLES } from '../lib/api'

interface Props {
  taskId: string | null
  task: Task | null
}

const POLL_MS = 5000

export function TaskInboxPanel({ taskId, task }: Props) {
  const [thread, setThread] = useState<TaskThreadEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!taskId) {
      setThread([])
      return
    }
    let cancelled = false
    setLoading(true)
    const tick = async () => {
      const t = await window.api.getTaskThread(taskId)
      if (!cancelled) {
        setThread(t)
        setLoading(false)
      }
    }
    tick()
    const i = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(i) }
  }, [taskId])

  if (!taskId || !task) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Inbox</h2>
          <span className="text-xs text-zinc-500">no task selected</span>
        </div>
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="space-y-2 max-w-xs">
            <div className="text-xs text-zinc-500">Click a task on the left.</div>
            <div className="text-[10px] text-zinc-600">
              The inbox is task-scoped now: it shows every message any agent has sent or received about the selected task,
              cross-agent and chronological. Pure agent-grouped inbox is gone — you almost never want to know
              "what's in be-reviewer's inbox" when agents come and go.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const status = STATUS_STYLES[task.status]
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`px-2 py-0.5 text-[10px] font-bold rounded ring-1 ring-inset ${status.classes}`}>
            {status.label}
          </span>
          <span className="font-mono text-xs text-zinc-400">{task.id}</span>
          <span className="text-xs text-zinc-300 truncate">{task.title}</span>
        </div>
        <span className="text-xs text-zinc-500 flex-shrink-0">
          {loading ? '…' : `${thread.length} msg${thread.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {thread.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-zinc-500 italic text-center">
            No messages reference {task.id} yet. They will appear here once any agent sends or receives one.
          </div>
        ) : (
          thread.map((m, i) => (
            <ThreadEntry key={`${m.source}-${m.source_file}-${i}-${m.ts}`} entry={m} />
          ))
        )}
      </div>
    </div>
  )
}

function ThreadEntry({ entry }: { entry: TaskThreadEntry }) {
  const [expanded, setExpanded] = useState(true)
  const fromColor = AGENT_COLORS[entry.from] ?? 'text-zinc-400'
  const toColor = AGENT_COLORS[entry.to] ?? 'text-zinc-400'
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded text-[11px]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-zinc-900/80 text-left"
      >
        <span className={`size-1 rounded-full ${entry.source === 'inbox' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
        <span className="font-mono text-[10px] text-zinc-500 flex-shrink-0">{entry.ts}</span>
        <span className={`font-medium ${fromColor} flex-shrink-0`}>{entry.from}</span>
        <span className="text-zinc-600 flex-shrink-0">→</span>
        <span className={`font-medium ${toColor} flex-shrink-0`}>{entry.to}</span>
        {entry.subject && (
          <span className="text-zinc-300 truncate flex-1 text-left">{entry.subject}</span>
        )}
        <span className={`text-[9px] uppercase tracking-wider flex-shrink-0 ${
          entry.source === 'inbox' ? 'text-amber-400' : 'text-emerald-400'
        }`}>
          {entry.source}
        </span>
      </button>
      {expanded && entry.body && (
        <div className="px-3 pb-2 pt-1 border-t border-zinc-800">
          <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">{entry.body}</pre>
        </div>
      )}
    </div>
  )
}
