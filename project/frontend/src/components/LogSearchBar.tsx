import { AgentName, colorFor } from '../lib/api'

interface Props {
  agents: string[]
  search: string
  onSearchChange: (s: string) => void
  selectedAgents: Set<AgentName>
  onAgentsChange: (next: Set<AgentName>) => void
  onExportJSON: () => void
  onExportCSV: () => void
  matchCount: number
}

export function LogSearchBar({
  agents,
  search,
  onSearchChange,
  selectedAgents,
  onAgentsChange,
  onExportJSON,
  onExportCSV,
  matchCount,
}: Props) {
  const toggleAgent = (a: AgentName) => {
    const next = new Set(selectedAgents)
    if (next.has(a)) next.delete(a)
    else next.add(a)
    onAgentsChange(next)
  }

  const allOn = selectedAgents.size === agents.length

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/60">
      <div className="px-3 py-2 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="search logs… (e.g. 'ai-engineer wrote')"
          className="flex-1 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
        />
        <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
          {matchCount} match
        </span>
        <button
          onClick={onExportJSON}
          className="px-2 py-1 text-[10px] font-medium text-zinc-300 bg-zinc-900 border border-zinc-700 hover:border-zinc-600 hover:text-white rounded transition-colors"
        >
          JSON
        </button>
        <button
          onClick={onExportCSV}
          className="px-2 py-1 text-[10px] font-medium text-zinc-300 bg-zinc-900 border border-zinc-700 hover:border-zinc-600 hover:text-white rounded transition-colors"
        >
          CSV
        </button>
      </div>
      <div className="px-3 pb-2 flex items-center gap-1 flex-wrap">
        <button
          onClick={() => onAgentsChange(allOn ? new Set() : new Set(agents))}
          className="px-2 py-0.5 text-[10px] rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900"
        >
          {allOn ? 'none' : 'all'}
        </button>
        {agents.map((a) => {
          const on = selectedAgents.has(a)
          return (
            <button
              key={a}
              onClick={() => toggleAgent(a)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded ring-1 ring-inset transition-colors ${
                on
                  ? `bg-zinc-900 ring-zinc-700 ${colorFor(a)}`
                  : 'bg-transparent text-zinc-600 ring-zinc-800 hover:text-zinc-400'
              }`}
            >
              {a.replace('-', ' ')}
            </button>
          )
        })}
      </div>
    </div>
  )
}
