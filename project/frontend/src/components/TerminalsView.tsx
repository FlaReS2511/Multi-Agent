import { useState, useEffect } from 'react'
import { AGENTS, AgentName, AGENT_COLORS, AgentsConfig } from '../lib/api'
import { AgentTerminal } from './AgentTerminal'
import { AgentModelPicker } from './AgentModelPicker'
import { RestartAgentButton } from './RestartAgentButton'

interface Props {
  config: AgentsConfig | null
  onConfigChange?: () => void
}

export function TerminalsView({ config, onConfigChange }: Props) {
  const [active, setActive] = useState<AgentName>('orchestrator')
  const [opened, setOpened] = useState<Set<AgentName>>(new Set(['orchestrator']))
  const [running, setRunning] = useState<string[]>([])
  const [restartTick, setRestartTick] = useState(0)

  useEffect(() => {
    const refresh = () => window.api.ptyStatus().then(setRunning)
    refresh()
    const i = setInterval(refresh, 2000)
    return () => clearInterval(i)
  }, [])

  const switchTo = (a: AgentName) => {
    setActive(a)
    setOpened((s) => (s.has(a) ? s : new Set([...s, a])))
  }

  const activeConfig = config?.agents[active] ?? { provider: 'anthropic', model: 'unknown' }

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
        {AGENTS.map((a) => {
          const isActive = a === active
          const isRunning = running.includes(a)
          const model = config?.agents[a]?.model
          return (
            <button
              key={a}
              onClick={() => switchTo(a)}
              className={`group relative px-4 py-2.5 text-xs font-medium transition-colors flex items-center gap-2 border-b-2 ${
                isActive
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-zinc-500 hover:text-zinc-200'
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  isRunning ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-zinc-700'
                }`}
              />
              <span className={isActive ? AGENT_COLORS[a] : ''}>{a.replace('-', ' ')}</span>
              {model && (
                <span className="text-[10px] text-zinc-600 font-mono hidden group-hover:inline">
                  {model}
                </span>
              )}
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-2 px-3 text-[10px] text-zinc-500">
          <span>{running.length}/{AGENTS.length} running</span>
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
        {AGENTS.map((a) => {
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
