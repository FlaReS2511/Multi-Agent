import { useState, useRef, useEffect } from 'react'
import { ModelOption } from '../lib/api'

interface Props {
  agent: string
  current: { provider: string; model: string }
  options: ModelOption[]
  onChange: (provider: string, model: string) => void
}

const TIER_BADGE: Record<string, string> = {
  smart: 'bg-fuchsia-500/15 text-fuchsia-300',
  balanced: 'bg-blue-500/15 text-blue-300',
  fast: 'bg-emerald-500/15 text-emerald-300',
}

export function AgentModelPicker({ current, options, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const currentLabel =
    options.find((o) => o.provider === current.provider && o.id === current.model)?.label ??
    current.model

  // Group by provider for future expansion
  const byProvider = options.reduce<Record<string, ModelOption[]>>((acc, o) => {
    acc[o.provider] = acc[o.provider] || []
    acc[o.provider].push(o)
    return acc
  }, {})

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="px-2 py-0.5 text-[10px] font-mono rounded border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors flex items-center gap-1"
        title="Model for this agent"
      >
        <span className="size-1.5 rounded-full bg-emerald-400"></span>
        {currentLabel}
        <span className="text-zinc-600">▾</span>
      </button>

      {open && (
        <div className="absolute z-20 right-0 top-full mt-1 w-60 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 max-h-72 overflow-y-auto">
          {Object.entries(byProvider).map(([provider, models]) => (
            <div key={provider}>
              <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-zinc-600 border-b border-zinc-800">
                {provider}
              </div>
              {models.map((m) => {
                const isActive = m.provider === current.provider && m.id === current.model
                return (
                  <button
                    key={`${m.provider}-${m.id}`}
                    onClick={() => {
                      onChange(m.provider, m.id)
                      setOpen(false)
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-zinc-800 transition-colors ${
                      isActive ? 'bg-zinc-800/60' : ''
                    }`}
                  >
                    <span className={isActive ? 'text-emerald-300' : 'text-zinc-300'}>
                      {isActive ? '✓' : ' '}
                    </span>
                    <span className="flex-1 text-zinc-200">{m.label}</span>
                    <span
                      className={`px-1.5 py-0.5 text-[9px] rounded ${
                        TIER_BADGE[m.tier] ?? 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {m.tier}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
          <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-600 italic">
            More providers coming soon
          </div>
        </div>
      )}
    </div>
  )
}
