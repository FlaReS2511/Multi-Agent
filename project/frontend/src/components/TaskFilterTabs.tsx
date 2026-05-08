import { Task, TaskStatus } from '../lib/api'

export type StatusFilter = TaskStatus | 'all'

const TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all',         label: 'All' },
  { key: 'todo',        label: 'TODO' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review',      label: 'Review' },
  { key: 'done',        label: 'Done' },
  { key: 'blocked',     label: 'Blocked' },
]

interface Props {
  tasks: Task[]
  active: StatusFilter
  onChange: (f: StatusFilter) => void
}

export function TaskFilterTabs({ tasks, active, onChange }: Props) {
  const counts: Record<StatusFilter, number> = {
    all: tasks.length,
    todo: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    blocked: 0,
  }
  for (const t of tasks) counts[t.status]++

  return (
    <div className="flex border-b border-zinc-800 bg-zinc-950/50 px-2 gap-0.5 overflow-x-auto">
      {TABS.map((tab) => {
        const isActive = active === tab.key
        const count = counts[tab.key]
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={`px-2.5 py-1.5 text-[11px] font-medium rounded-t transition-colors flex items-center gap-1.5 whitespace-nowrap ${
              isActive
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'
            }`}
          >
            <span>{tab.label}</span>
            <span
              className={`px-1.5 py-0.5 text-[9px] rounded font-mono font-bold ${
                isActive ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-800 text-zinc-500'
              }`}
            >
              {count}
            </span>
          </button>
        )
      })}
    </div>
  )
}
