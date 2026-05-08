import { useState, useMemo } from 'react'
import { Task, STATUS_STYLES, PRIORITY_STYLES, AGENT_COLORS } from '../lib/api'
import { TaskFilterTabs, StatusFilter } from './TaskFilterTabs'
import { TaskDetailPanel } from './TaskDetailPanel'

interface Props {
  tasks: Task[]
  onChanged?: () => void
  onOpenArtifact?: (taskId: string) => void
}

export function TasksPanel({ tasks, onChanged, onOpenArtifact }: Props) {
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)),
    [tasks, filter]
  )

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const selected = selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Tasks</h2>
        <span className="text-xs text-zinc-500">
          {filtered.length} / {tasks.length}
        </span>
      </div>

      <TaskFilterTabs tasks={tasks} active={filter} onChange={setFilter} />

      <div className="flex-1 flex overflow-hidden">
        <div className={`overflow-y-auto ${selected ? 'w-1/2 border-r border-zinc-800' : 'flex-1'}`}>
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">
              {tasks.length === 0
                ? 'No tasks yet. Orchestrator chưa tạo task nào.'
                : `No tasks with status "${filter}".`}
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {filtered.map((t) => {
                const style = STATUS_STYLES[t.status] ?? STATUS_STYLES.todo
                const prio = t.priority ? PRIORITY_STYLES[t.priority] : null
                const blockedBy = t.deps.filter((d) => {
                  const dep = taskById.get(d)
                  return !dep || dep.status !== 'done'
                })
                const isSelected = selectedId === t.id
                return (
                  <li
                    key={t.id}
                    onClick={() => setSelectedId(isSelected ? null : t.id)}
                    className={`px-4 py-3 cursor-pointer transition-colors ${
                      isSelected ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`px-2 py-0.5 text-[10px] font-bold rounded ring-1 ring-inset ${style.classes}`}
                      >
                        {style.label}
                      </span>
                      {prio && (
                        <span
                          className={`px-1.5 py-0.5 text-[9px] font-bold rounded ring-1 ring-inset ${prio.classes}`}
                        >
                          {prio.label}
                        </span>
                      )}
                      <span className="font-mono text-xs text-zinc-500">{t.id}</span>
                      <span className={`text-xs font-medium ${AGENT_COLORS[t.owner] ?? 'text-zinc-400'}`}>
                        {t.owner}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-zinc-200">{t.title}</div>
                    {t.deps.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                        {t.deps.map((d) => {
                          const dep = taskById.get(d)
                          const isDone = dep?.status === 'done'
                          const isMissing = !dep
                          return (
                            <span
                              key={d}
                              title={isMissing ? 'Task not found' : `${dep!.title} — ${dep!.status}`}
                              className={`px-1 py-0.5 font-mono rounded ${
                                isDone
                                  ? 'bg-emerald-500/10 text-emerald-400'
                                  : 'bg-rose-500/15 text-rose-300'
                              }`}
                            >
                              {d}
                              {isDone ? ' ✓' : ' ⏳'}
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {blockedBy.length > 0 && t.status !== 'done' && (
                      <div className="mt-1 text-[10px] text-rose-400">
                        blocked by {blockedBy.length} dep{blockedBy.length > 1 ? 's' : ''}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {selected && (
          <div className="w-1/2 overflow-hidden">
            <TaskDetailPanel
              task={selected}
              allTasks={tasks}
              onClose={() => setSelectedId(null)}
              onChanged={() => onChanged?.()}
              onOpenArtifact={(id) => onOpenArtifact?.(id)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
