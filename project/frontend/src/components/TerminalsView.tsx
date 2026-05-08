import { useState, useEffect } from 'react'
import { activeAgents, colorFor, AgentName, AgentsConfig, PtySessionDetail } from '../lib/api'
import { AgentTerminal } from './AgentTerminal'
import { AgentModelPicker } from './AgentModelPicker'
import { RestartAgentButton } from './RestartAgentButton'

interface Props {
  config: AgentsConfig | null
  onConfigChange?: () => void
}

// Idle thresholds (seconds) for the tab status dot.
const IDLE_WARN_S = 5 * 60       // amber from this point
const IDLE_DANGER_S = 12 * 60    // rose from this point (~3 min before kill at 15m)

export function TerminalsView({ config, onConfigChange }: Props) {
  const agents = activeAgents(config)
  const [active, setActive] = useState<AgentName>('orchestrator')
  const [opened, setOpened] = useState<Set<AgentName>>(new Set(['orchestrator']))
  const [details, setDetails] = useState<PtySessionDetail[]>([])
  const [restartTick, setRestartTick] = useState(0)

  useEffect(() => {
    const refresh = () => window.api.ptyStatusDetail().then(setDetails)
    refresh()
    const i = setInterval(refresh, 2000)
    return () => clearInterval(i)
  }, [])

  useEffect(() => {
    return window.api.onAgentKilled(() => {
      // Detail poll will pick up the removal on the next tick; nothing else to do.
    })
  }, [])

  const detailByAgent = new Map(details.map((d) => [d.agent, d]))
  const running = details.map((d) => d.agent)

  const switchTo = (a: AgentName) => {
    setActive(a)
    setOpened((s) => (s.has(a) ? s : new Set([...s, a])))
  }

  const entry = config?.agents[active]
  const activeConfig = {
    provider: entry?.provider ?? entry?.backend?.kind ?? 'anthropic',
    model: entry?.model ?? entry?.backend?.model ?? 'unknown',
  }

  const onModelChange = async (provider: string, model: string) => {
    if (provider === activeConfig.provider && model === activeConfig.model) return
    await window.api.updateAgentModel(active, provider, model)
    onConfigChange?.()
    if (confirm(`Restart agent ${active} with new model "${model}"?`)) {
      await window.api.ptyRestart(active)
      setRestartTick((t) => t + 1)
    }
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <div className="flex border-b border-zinc-800 bg-zinc-950/60 px-2">
        {agents.map((a) => {
          const isActive = a === active
          const detail = detailByAgent.get(a)
          const isRunning = !!detail
          const idleS = detail?.idle_seconds ?? 0
          const preWarmed = !!detail?.pre_warmed
          const dotClass = !isRunning
            ? 'bg-zinc-700'
            : preWarmed || idleS < IDLE_WARN_S
              ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
              : idleS < IDLE_DANGER_S
                ? 'bg-amber-400'
                : 'bg-rose-400'
          const tooltip = !isRunning
            ? 'not running — click to start'
            : preWarmed
              ? 'running (pre-warmed, never auto-killed)'
              : idleS < 60
                ? 'running'
                : `idle ${formatIdle(idleS)}` + (idleS < IDLE_DANGER_S ? '' : ' — kill imminent')
          const model = config?.agents[a]?.model
          return (
            <button
              key={a}
              onClick={() => switchTo(a)}
              title={tooltip}
              className={`group relative px-4 py-2.5 text-xs font-medium transition-colors flex items-center gap-2 border-b-2 ${
                isActive
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-zinc-500 hover:text-zinc-200'
              }`}
            >
              <span className={`size-1.5 rounded-full ${dotClass}`} />
              <span className={isActive ? colorFor(a) : ''}>{a.replace('-', ' ')}</span>
              {model && (
                <span className="text-[10px] text-zinc-600 font-mono hidden group-hover:inline">
                  {model}
                </span>
              )}
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-2 px-3 text-[10px] text-zinc-500">
          <span>{running.length}/{agents.length} running</span>
          {config && (
            <AgentModelPicker
              agent={active}
              current={activeConfig}
              options={config.available_models}
              onChange={onModelChange}
            />
          )}
          <RestartAgentButton
            agent={active}
            onRestarted={() => setRestartTick((t) => t + 1)}
            small
          />
          <button
            onClick={() => {
              if (confirm(`Kill claude session for ${active}?`)) {
                window.api.ptyKill(active)
              }
            }}
            className="px-2 py-0.5 text-[10px] text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-colors"
          >
            Kill
          </button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {agents.map((a) => {
          if (!opened.has(a)) return null
          const isVisible = a === active
          return (
            <div
              key={`${a}-${a === active ? restartTick : 0}`}
              className="absolute inset-0"
              style={{
                visibility: isVisible ? 'visible' : 'hidden',
                zIndex: isVisible ? 1 : 0,
              }}
            >
              <AgentTerminal agent={a} active={isVisible} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatIdle(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}
