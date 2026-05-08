import { useEffect, useState } from 'react'
import {
  Task, Priority, PRIORITY_STYLES, STATUS_STYLES, AGENT_COLORS,
} from '../lib/api'

interface Props {
  task: Task
  allTasks: Task[]
  onClose: () => void
  onChanged: () => void
  onOpenArtifact: (taskId: string) => void
  onSelectTask: (taskId: string) => void
}

export function TaskDetailPanel({
  task, allTasks, onClose, onChanged, onOpenArtifact, onSelectTask,
}: Props) {
  const [priority, setPriority] = useState<Priority>(task.priority ?? 'medium')
  const [depsText, setDepsText] = useState<string>(task.deps.join(', '))
  const [saving, setSaving] = useState(false)
  const [costForTask, setCostForTask] = useState<{ usd: number; tokens_in: number; tokens_out: number } | null>(null)

  useEffect(() => {
    setPriority(task.priority ?? 'medium')
    setDepsText(task.deps.join(', '))
  }, [task.id, task.priority, task.deps])

  // Poll cost-per-task while panel open. The full message thread lives in the
  // middle Inbox column (TaskInboxPanel), so we no longer fetch it here.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const cs = await window.api.getCostSummary()
      if (cancelled) return
      const taskCost = cs.by_task.find((t) => t.task_id === task.id)
      setCostForTask(taskCost ? { usd: taskCost.usd, tokens_in: taskCost.tokens_in, tokens_out: taskCost.tokens_out } : null)
    }
    tick()
    const i = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(i) }
  }, [task.id])

  const status = STATUS_STYLES[task.status]
  const taskById = new Map(allTasks.map((t) => [t.id, t]))

  const parsedDeps = depsText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const dirty =
    priority !== (task.priority ?? 'medium') ||
    parsedDeps.join(',') !== task.deps.join(',')

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      await window.api.updateTask(task.id, { priority, deps: parsedDeps })
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  const parent = task.parent_id ? taskById.get(task.parent_id) : null
  const children = (task.children ?? [])
    .map((cid) => taskById.get(cid))
    .filter((t): t is Task => Boolean(t))
  const childrenDone = children.filter((c) => c.status === 'done').length

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`px-2 py-0.5 text-[10px] font-bold rounded ring-1 ring-inset ${status.classes}`}>
            {status.label}
            {task.status === 'waiting_children' && children.length > 0 && ` (${childrenDone}/${children.length})`}
          </span>
          <span className="font-mono text-xs text-zinc-400">{task.id}</span>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200 text-lg leading-none px-1"
          title="Close detail"
        >
          ×
        </button>
      </div>

      {parent && (
        <button
          onClick={() => onSelectTask(parent.id)}
          className="px-4 py-1.5 text-[11px] text-zinc-400 hover:text-cyan-300 hover:bg-zinc-900 border-b border-zinc-800 text-left flex items-center gap-2"
          title="Open parent task"
        >
          <span>↑</span>
          <span className="font-mono text-zinc-500">{parent.id}</span>
          <span className="truncate">{parent.title}</span>
        </button>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Title</div>
          <div className="text-sm text-zinc-200">{task.title}</div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Owner</div>
          <div className={`text-xs font-medium ${AGENT_COLORS[task.owner] ?? 'text-zinc-300'}`}>
            {task.owner}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Priority</div>
          <div className="flex gap-1">
            {(['low', 'medium', 'high'] as Priority[]).map((p) => {
              const style = PRIORITY_STYLES[p]
              const isActive = priority === p
              return (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`px-2 py-0.5 text-[10px] font-bold rounded ring-1 ring-inset transition-colors ${
                    isActive
                      ? style.classes
                      : 'bg-zinc-900 text-zinc-500 ring-zinc-800 hover:text-zinc-300'
                  }`}
                >
                  {style.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Dependencies</div>
          <input
            type="text"
            value={depsText}
            onChange={(e) => setDepsText(e.target.value)}
            placeholder="T-001, T-002"
            className="w-full px-2 py-1 text-xs font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          {parsedDeps.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {parsedDeps.map((d) => {
                const dep = taskById.get(d)
                const isDone = dep?.status === 'done'
                const missing = !dep
                return (
                  <span
                    key={d}
                    title={missing ? 'Task not found' : `${dep!.title} — ${dep!.status}`}
                    className={`px-1.5 py-0.5 text-[10px] font-mono rounded ring-1 ring-inset ${
                      missing
                        ? 'bg-rose-500/20 text-rose-300 ring-rose-500/40'
                        : isDone
                        ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
                    }`}
                  >
                    {d} {isDone ? '✓' : missing ? '?' : '⏳'}
                  </span>
                )
              })}
            </div>
          )}
        </div>

        {children.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
              Children ({childrenDone}/{children.length} done)
            </div>
            <div className="space-y-1.5">
              {children.map((c) => {
                const cs = STATUS_STYLES[c.status]
                return (
                  <button
                    key={c.id}
                    onClick={() => onSelectTask(c.id)}
                    className="w-full text-left px-3 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded transition-colors flex items-center gap-2"
                  >
                    <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ring-1 ring-inset ${cs.classes}`}>
                      {cs.label}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500">{c.id}</span>
                    <span className={`text-xs font-medium ${AGENT_COLORS[c.owner] ?? 'text-zinc-300'}`}>
                      {c.owner}
                    </span>
                    <span className="text-xs text-zinc-300 truncate flex-1">{c.title}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {costForTask && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Cost</div>
            <div className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded flex items-center gap-3 text-xs">
              <span className="font-mono text-emerald-300">${costForTask.usd.toFixed(4)}</span>
              <span className="text-zinc-500">·</span>
              <span className="font-mono text-zinc-300">{costForTask.tokens_in.toLocaleString()} in</span>
              <span className="text-zinc-600">+</span>
              <span className="font-mono text-zinc-300">{costForTask.tokens_out.toLocaleString()} out</span>
              <span className="text-zinc-600 ml-auto text-[10px]">API calls only</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-[10px]">
          <div>
            <div className="uppercase tracking-wider text-zinc-500 mb-1">Created</div>
            <div className="font-mono text-zinc-400">{task.created_at}</div>
          </div>
          <div>
            <div className="uppercase tracking-wider text-zinc-500 mb-1">Updated</div>
            <div className="font-mono text-zinc-400">{task.updated_at}</div>
          </div>
        </div>

        <button
          onClick={() => onOpenArtifact(task.id)}
          className="w-full px-3 py-1.5 text-xs font-medium border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-600 text-zinc-300 rounded transition-colors"
        >
          Open Artifacts →
        </button>
      </div>

      <div className="px-4 py-2 border-t border-zinc-800 flex items-center justify-end gap-2">
        <span className="text-[10px] text-zinc-600 mr-auto">
          {dirty ? 'Unsaved changes' : 'No changes'}
        </span>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

