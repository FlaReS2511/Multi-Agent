import { useState, useEffect, useMemo } from 'react'
import { InboxSummary, AGENT_COLORS, AgentsConfig } from '../lib/api'
import { MessageComposer } from './MessageComposer'
import { AgentModelPicker } from './AgentModelPicker'
import { InboxMessageCard, parseInbox } from './InboxMessageCard'

interface Props {
  summary: InboxSummary[]
  config: AgentsConfig | null
  onConfigChange: () => void
}

export function InboxPanel({ summary, config, onConfigChange }: Props) {
  const [selected, setSelected] = useState<string>(summary[0]?.agent ?? 'orchestrator')
  const [content, setContent] = useState<string>('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [showRawAll, setShowRawAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      window.api.getInboxContent(selected).then((c) => {
        if (!cancelled) setContent(c)
      })
    }
    load()
    const interval = setInterval(load, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [selected, refreshKey])

  const messages = useMemo(() => parseInbox(content), [content])
  const currentAgentConfig = config?.agents[selected] ?? { provider: 'anthropic', model: 'unknown' }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Inbox</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowRawAll((v) => !v)}
            className="text-[10px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-zinc-900"
            title="Toggle raw markdown view for full inbox"
          >
            {showRawAll ? 'Cards' : 'Raw'}
          </button>
          <span className="text-xs text-zinc-500">
            {summary.reduce((s, x) => s + x.count, 0)} pending
          </span>
        </div>
      </div>

      <div className="flex border-b border-zinc-800 px-2 gap-1 bg-zinc-950/50 overflow-x-auto">
        {summary.map((s) => {
          const isActive = s.agent === selected
          return (
            <button
              key={s.agent}
              onClick={() => setSelected(s.agent)}
              className={`px-3 py-2 text-xs font-medium rounded-t transition-colors flex items-center gap-2 whitespace-nowrap ${
                isActive
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'
              }`}
            >
              <span className={isActive ? AGENT_COLORS[s.agent] ?? 'text-white' : ''}>
                {s.agent.replace('-', ' ')}
              </span>
              {s.count > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/20 text-amber-300 rounded font-bold">
                  {s.count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="px-4 py-2 border-b border-zinc-800/60 flex items-center justify-between bg-zinc-950/30">
        <span className={`text-xs font-medium ${AGENT_COLORS[selected] ?? 'text-zinc-300'}`}>
          {selected}
        </span>
        {config && (
          <AgentModelPicker
            agent={selected}
            current={currentAgentConfig}
            options={config.available_models}
            onChange={async (provider, model) => {
              await window.api.updateAgentModel(selected, provider, model)
              onConfigChange()
            }}
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {showRawAll ? (
          content.trim() === '' ? (
            <div className="p-8 text-center text-zinc-500 text-sm">Inbox trống.</div>
          ) : (
            <pre className="p-4 text-xs font-mono text-zinc-300 whitespace-pre-wrap">{content}</pre>
          )
        ) : messages.length === 0 ? (
          <div className="p-8 text-center text-zinc-500 text-sm">Inbox trống.</div>
        ) : (
          <div className="p-3 space-y-2">
            {messages.map((m, i) => (
              <InboxMessageCard
                key={m.id}
                msg={m}
                unread={true}
                defaultExpanded={i === 0}
              />
            ))}
          </div>
        )}
      </div>

      <MessageComposer to={selected} onSent={() => setRefreshKey((k) => k + 1)} />
    </div>
  )
}
