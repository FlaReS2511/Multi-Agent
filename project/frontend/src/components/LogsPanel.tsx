import { useEffect, useMemo, useState } from 'react'
import { AgentLogs, AgentName, colorFor } from '../lib/api'
import { LogSearchBar } from './LogSearchBar'

interface Props {
  logs: AgentLogs[]
  agents: string[]
}

interface LogEntry {
  agent: string
  ts: string
  text: string
  raw: string
}

const TS_RE = /^\[([^\]]+)\]\s*(.*)$/

function parseLine(agent: string, raw: string): LogEntry {
  const m = raw.match(TS_RE)
  if (m) return { agent, ts: m[1], text: m[2], raw }
  return { agent, ts: '', text: raw, raw }
}

export function LogsPanel({ logs, agents }: Props) {
  const [search, setSearch] = useState('')
  const [selectedAgents, setSelectedAgents] = useState<Set<AgentName>>(new Set(agents))
  const [allLogs, setAllLogs] = useState<AgentLogs[] | null>(null)
  const [showAll, setShowAll] = useState(false)

  // Keep selectedAgents in sync when the agent list changes (clones added/removed).
  useEffect(() => {
    setSelectedAgents((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const a of agents) if (!next.has(a)) { next.add(a); changed = true }
      for (const a of Array.from(next)) if (!agents.includes(a)) { next.delete(a); changed = true }
      return changed ? next : prev
    })
  }, [agents])

  useEffect(() => {
    if (!showAll) return
    let cancelled = false
    const load = () => {
      window.api.getAllLogs().then((l) => {
        if (!cancelled) setAllLogs(l)
      })
    }
    load()
    const interval = setInterval(load, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [showAll])

  const sourceLogs = showAll && allLogs ? allLogs : logs

  const entries = useMemo<LogEntry[]>(() => {
    const list: LogEntry[] = []
    for (const l of sourceLogs) {
      for (const line of l.lines) list.push(parseLine(l.agent, line))
    }
    return list
  }, [sourceLogs])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (!selectedAgents.has(e.agent as AgentName)) return false
      if (!q) return true
      return e.raw.toLowerCase().includes(q) || e.agent.toLowerCase().includes(q)
    })
  }, [entries, search, selectedAgents])

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' })
    triggerDownload(blob, `logs-${stamp()}.json`)
  }

  const exportCSV = () => {
    const header = 'agent,ts,text\n'
    const body = filtered
      .map((e) => `${csvEsc(e.agent)},${csvEsc(e.ts)},${csvEsc(e.text)}`)
      .join('\n')
    const blob = new Blob([header + body], { type: 'text/csv' })
    triggerDownload(blob, `logs-${stamp()}.csv`)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Activity</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-[10px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-zinc-900"
            title={showAll ? 'Showing full logs' : 'Showing recent (15 lines per agent)'}
          >
            {showAll ? 'Full' : 'Recent'}
          </button>
          <span className="text-xs text-zinc-500">{entries.length} lines</span>
        </div>
      </div>

      <LogSearchBar
        agents={agents}
        search={search}
        onSearchChange={setSearch}
        selectedAgents={selectedAgents}
        onAgentsChange={setSelectedAgents}
        onExportJSON={exportJSON}
        onExportCSV={exportCSV}
        matchCount={filtered.length}
      />

      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-zinc-600 text-xs italic">
            {entries.length === 0 ? 'no activity yet' : 'no matching log lines'}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((e, i) => (
              <li
                key={i}
                className="px-2 py-1 text-[11px] font-mono leading-relaxed flex items-start gap-2 hover:bg-zinc-900/40 rounded"
              >
                <span
                  className={`shrink-0 font-semibold w-32 truncate ${colorFor(e.agent)}`}
                >
                  {e.agent}
                </span>
                <span className="shrink-0 text-zinc-600 w-32 truncate">{e.ts}</span>
                <span className="text-zinc-300 break-all">
                  {highlight(e.text, search)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function highlight(text: string, q: string) {
  if (!q.trim()) return text
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-amber-500/30 text-amber-200 rounded px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}

function csvEsc(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
