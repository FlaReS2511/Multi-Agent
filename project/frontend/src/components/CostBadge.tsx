import { useEffect, useState } from 'react'
import { CostSummary } from '../lib/api'

interface Props {
  onClick: () => void
  pollMs?: number
}

export function CostBadge({ onClick, pollMs = 30_000 }: Props) {
  const [summary, setSummary] = useState<CostSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const s = await window.api.getCostSummary()
      if (!cancelled) setSummary(s)
    }
    tick()
    const i = setInterval(tick, pollMs)
    return () => {
      cancelled = true
      clearInterval(i)
    }
  }, [pollMs])

  const usd = summary?.today.usd ?? 0
  const isFresh = usd > 0
  return (
    <button
      onClick={onClick}
      title={summary
        ? `Today: $${usd.toFixed(4)} • ${summary.today.tokens_in} in + ${summary.today.tokens_out} out tokens (CLI agents not counted)`
        : 'API cost today (click for breakdown)'}
      className={`px-2 py-1 text-[10px] font-medium rounded border transition-colors flex items-center gap-1.5 ${
        isFresh
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15'
          : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
      }`}
    >
      <span className="font-mono">${usd.toFixed(2)}</span>
      <span className="opacity-70">today</span>
    </button>
  )
}
