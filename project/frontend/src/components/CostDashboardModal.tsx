import { useEffect, useState } from 'react'
import { CostSummary, AGENT_COLORS } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
}

export function CostDashboardModal({ open, onClose }: Props) {
  const [summary, setSummary] = useState<CostSummary | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const tick = async () => {
      const s = await window.api.getCostSummary()
      if (!cancelled) setSummary(s)
    }
    tick()
    const i = setInterval(tick, 5000)
    return () => {
      cancelled = true
      clearInterval(i)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[860px] max-w-[95vw] max-h-[90vh] overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between sticky top-0 bg-zinc-900 z-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-100">
            Cost Dashboard
            <span className="ml-2 text-[10px] font-mono text-zinc-500">{summary?.date ?? ''}</span>
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">×</button>
        </div>

        {!summary ? (
          <div className="p-8 text-center text-zinc-500 text-sm">Loading…</div>
        ) : (
          <div className="p-5 space-y-6">
            <HeroNumbers summary={summary} />
            <ByAgent summary={summary} />
            <TopTasks summary={summary} />
            <HourlySparkline summary={summary} />
            <p className="text-[10px] text-zinc-600 italic">
              Pricing as of {summary.pricing_as_of}. CLI-backed agents (Claude Code / Codex / Gemini) are not counted —
              only programmatic API + LM Studio calls log usage.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function HeroNumbers({ summary }: { summary: CostSummary }) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <Stat
        label="Today's spend"
        value={`$${summary.today.usd.toFixed(4)}`}
        color={summary.today.usd > 0 ? 'text-emerald-300' : 'text-zinc-400'}
      />
      <Stat
        label="Input tokens"
        value={summary.today.tokens_in.toLocaleString()}
        color="text-zinc-200"
      />
      <Stat
        label="Output tokens"
        value={summary.today.tokens_out.toLocaleString()}
        color="text-zinc-200"
      />
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="px-4 py-3 bg-zinc-950 border border-zinc-800 rounded">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-mono font-semibold ${color}`}>{value}</div>
    </div>
  )
}

function ByAgent({ summary }: { summary: CostSummary }) {
  if (summary.by_agent.length === 0) {
    return (
      <Section title="By agent">
        <div className="text-xs text-zinc-500">No API agents have run today.</div>
      </Section>
    )
  }
  const max = summary.by_agent[0].usd
  return (
    <Section title="By agent">
      <div className="space-y-1.5">
        {summary.by_agent.map((row) => {
          const pct = max > 0 ? (row.usd / max) * 100 : 0
          return (
            <div key={row.agent} className="grid grid-cols-[140px_1fr_100px] gap-3 items-center">
              <span className={`text-xs font-medium ${AGENT_COLORS[row.agent] ?? 'text-zinc-300'}`}>
                {row.agent}
              </span>
              <div className="h-4 bg-zinc-950 rounded relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-emerald-500/30 border-r border-emerald-500/60"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs font-mono text-zinc-300 text-right">${row.usd.toFixed(4)}</span>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function TopTasks({ summary }: { summary: CostSummary }) {
  const top = summary.by_task.slice(0, 10)
  if (top.length === 0) {
    return (
      <Section title="Top tasks">
        <div className="text-xs text-zinc-500">No task-attributed cost yet today.</div>
      </Section>
    )
  }
  const max = top[0].usd
  return (
    <Section title="Top tasks (by cost)">
      <div className="space-y-1.5">
        {top.map((row) => {
          const pct = max > 0 ? (row.usd / max) * 100 : 0
          return (
            <div key={row.task_id} className="grid grid-cols-[140px_1fr_100px] gap-3 items-center">
              <span className="text-xs font-mono text-zinc-300">{row.task_id}</span>
              <div className="h-4 bg-zinc-950 rounded relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-cyan-500/30 border-r border-cyan-500/60"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs font-mono text-zinc-300 text-right">${row.usd.toFixed(4)}</span>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function HourlySparkline({ summary }: { summary: CostSummary }) {
  const max = Math.max(...summary.by_hour_today.map((h) => h.usd), 0)
  return (
    <Section title="Today by hour">
      <div className="flex items-end gap-1 h-20">
        {summary.by_hour_today.map((h) => {
          const heightPct = max > 0 ? (h.usd / max) * 100 : 0
          return (
            <div
              key={h.hour}
              title={`${String(h.hour).padStart(2, '0')}:00 — $${h.usd.toFixed(4)}`}
              className="flex-1 flex flex-col justify-end items-center gap-0.5"
            >
              <div
                className={`w-full rounded-t transition-all ${
                  h.usd > 0 ? 'bg-emerald-500/40' : 'bg-zinc-800'
                }`}
                style={{ height: `${Math.max(heightPct, 2)}%` }}
              />
              <span className="text-[8px] font-mono text-zinc-600">{h.hour}</span>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">{title}</h3>
      {children}
    </section>
  )
}
