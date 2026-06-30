import { useEffect, useState, useCallback } from 'react'
import {
  colorFor,
  baseRoleOf,
  PROVIDER_KIND_LABELS,
  ProviderKind,
  ProviderBlock,
  BackendSettings,
  providerNeedsKey,
} from '../lib/api'

const PROVIDER_KINDS: ProviderKind[] = ['openai-compatible', 'anthropic', 'openai', 'google']

interface Props {
  open: boolean
  onClose: () => void
}

export function BackendSettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<BackendSettings | null>(null)
  const [savingAgent, setSavingAgent] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string>('')

  const refresh = useCallback(async () => {
    setSettings(await window.api.getBackendSettings())
  }, [])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !settings) return null

  const providerIds = Object.keys(settings.providers)
  const restartAgent = async (agent: string) => {
    try { await window.api.ptyRestart(agent) } catch { /* ignore */ }
  }

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
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-100">Backend Settings</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">×</button>
        </div>

        {!settings.safeStorageAvailable && (
          <div className="mx-5 mt-4 px-3 py-2 text-xs rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">
            OS keychain encryption not available — API key fields are disabled.
          </div>
        )}
        {error && (
          <div className="mx-5 mt-4 px-3 py-2 text-xs rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">
            {error}
          </div>
        )}

        {/* Per-agent provider + model */}
        <section className="p-5">
          <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">Per-agent model</h3>
          <div className="text-[11px] text-zinc-500 mb-3">
            Each agent runs via an API provider. Pick a provider and one of its models.
          </div>
          <div className="grid grid-cols-[120px_160px_1fr_auto] gap-2 text-[10px] uppercase tracking-wider text-zinc-500 px-1 pb-2 border-b border-zinc-800">
            <span>Agent</span><span>Provider</span><span>Model</span><span></span>
          </div>
          {Object.keys(settings.agents).sort((a, b) => {
            const ba = baseRoleOf(a); const bb = baseRoleOf(b)
            if (ba !== bb) return ba.localeCompare(bb)
            return a.localeCompare(b, undefined, { numeric: true })
          }).map((agent) => (
            <AgentRow
              key={agent}
              agent={agent}
              providerId={settings.agents[agent]?.provider ?? ''}
              model={settings.agents[agent]?.model ?? ''}
              providers={settings.providers}
              saving={savingAgent === agent}
              onSave={async (provider, model) => {
                setSavingAgent(agent)
                setError('')
                try {
                  await window.api.setAgentBackend({ agent, provider, model })
                  await refresh()
                  await restartAgent(agent)
                } catch (e) {
                  setError(`Failed to save ${agent}: ${(e as Error).message}`)
                } finally {
                  setSavingAgent(null)
                }
              }}
            />
          ))}
        </section>

        {/* Providers */}
        <section className="px-5 pb-5 border-t border-zinc-800 pt-5">
          <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">Providers & API Keys</h3>
          <div className="text-[11px] text-zinc-500 mb-3">
            Add any OpenAI-compatible gateway (VietAPI, OpenRouter, vLLM, Azure, a local LM Studio) or a first-party provider. Keys are encrypted via the OS keychain.
          </div>
          {providerIds.map((pid) => (
            <ProviderRow
              key={pid}
              id={pid}
              provider={settings.providers[pid]}
              hasKey={settings.keys[pid]}
              disabled={!settings.safeStorageAvailable}
              saving={savingKey === pid}
              onSaveKey={async (apiKey) => {
                setSavingKey(pid)
                setError('')
                try {
                  const result = await window.api.setProviderKey({ provider: pid, apiKey })
                  if (!result.ok) setError(result.error || 'failed to save key')
                  await refresh()
                } finally {
                  setSavingKey(null)
                }
              }}
              onClearKey={async () => {
                setSavingKey(pid)
                try { await window.api.clearProviderKey(pid); await refresh() }
                finally { setSavingKey(null) }
              }}
              onSaveModels={async (models) => {
                await window.api.setProvider({
                  id: pid,
                  kind: settings.providers[pid].kind,
                  name: settings.providers[pid].name,
                  base_url: settings.providers[pid].base_url,
                  models,
                })
                await refresh()
              }}
              onDelete={async () => {
                await window.api.deleteProvider(pid)
                await refresh()
              }}
            />
          ))}
          <AddProvider
            onAdd={async (input) => {
              setError('')
              const result = await window.api.setProvider(input)
              if (!result.ok) setError(result.error || 'failed to add provider')
              await refresh()
            }}
          />
        </section>
      </div>
    </div>
  )
}

interface AgentRowProps {
  agent: string
  providerId: string
  model: string
  providers: Record<string, ProviderBlock>
  saving: boolean
  onSave: (provider: string, model?: string) => Promise<void>
}

function AgentRow({ agent, providerId, model, providers, saving, onSave }: AgentRowProps) {
  const [prov, setProv] = useState(providerId)
  const [mdl, setMdl] = useState(model)

  useEffect(() => { setProv(providerId); setMdl(model) }, [providerId, model])

  const dirty = prov !== providerId || mdl !== model
  const models = providers[prov]?.models ?? []

  return (
    <div className="grid grid-cols-[120px_160px_1fr_auto] gap-2 items-center py-2 border-b border-zinc-800/60">
      <span className={`text-xs font-medium ${colorFor(agent)}`}>{agent}</span>
      <select
        value={prov}
        onChange={(e) => { setProv(e.target.value); setMdl('') }}
        className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100"
      >
        <option value="">(none)</option>
        {Object.keys(providers).map((pid) => (
          <option key={pid} value={pid}>{providers[pid].name ?? pid}</option>
        ))}
      </select>
      <select
        value={mdl}
        onChange={(e) => setMdl(e.target.value)}
        className="flex-1 min-w-0 px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100"
      >
        <option value="">(default)</option>
        {models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <button
        onClick={() => onSave(prov, mdl || undefined)}
        disabled={!dirty || saving}
        className="px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
      >
        {saving ? '…' : dirty ? 'Save' : 'Saved'}
      </button>
    </div>
  )
}

interface ProviderRowProps {
  id: string
  provider: ProviderBlock
  hasKey: boolean
  disabled: boolean
  saving: boolean
  onSaveKey: (apiKey: string) => Promise<void>
  onClearKey: () => Promise<void>
  onSaveModels: (models: string[]) => Promise<void>
  onDelete: () => Promise<void>
}

function ProviderRow({ id, provider, hasKey, disabled, saving, onSaveKey, onClearKey, onSaveModels, onDelete }: ProviderRowProps) {
  const [value, setValue] = useState('')
  const [modelsText, setModelsText] = useState((provider.models ?? []).join(', '))
  const [expanded, setExpanded] = useState(false)
  const needsKey = providerNeedsKey(provider.kind, provider.base_url)
  const dirtyModels = modelsText !== (provider.models ?? []).join(', ')

  useEffect(() => { setModelsText((provider.models ?? []).join(', ')) }, [provider.models])

  return (
    <div className="py-2 border-b border-zinc-800/60">
      <div className="grid grid-cols-[140px_1fr_auto_auto] gap-2 items-center">
        <div className="flex flex-col">
          <span className="text-xs text-zinc-200 font-medium">{provider.name ?? id}</span>
          <span className="text-[10px] text-zinc-600">{PROVIDER_KIND_LABELS[provider.kind]}</span>
        </div>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            !needsKey ? 'no key needed (local)'
              : hasKey ? '••••••••  (key on file — type to replace)'
                : `Enter ${id} API key`
          }
          disabled={disabled || !needsKey}
          className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 disabled:opacity-40"
        />
        <button
          onClick={async () => { await onSaveKey(value); setValue('') }}
          disabled={!value || saving || disabled || !needsKey}
          className="px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
        >
          {saving ? '…' : 'Save'}
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
        >
          {expanded ? '▴' : '▾'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 pl-[148px] pr-1 flex flex-col gap-2">
          {provider.base_url && (
            <div className="text-[10px] text-zinc-500 font-mono">base_url: {provider.base_url}</div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={modelsText}
              onChange={(e) => setModelsText(e.target.value)}
              placeholder="comma-separated model ids"
              className="flex-1 px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600"
            />
            <button
              onClick={() => onSaveModels(modelsText.split(',').map((s) => s.trim()).filter(Boolean))}
              disabled={!dirtyModels}
              className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white"
            >
              Save models
            </button>
            <button
              onClick={onClearKey}
              disabled={!hasKey || disabled}
              className="px-3 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 disabled:opacity-30"
            >
              Clear key
            </button>
            <button
              onClick={onDelete}
              className="px-3 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-rose-300 hover:border-rose-500/50"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AddProvider({ onAdd }: { onAdd: (input: { id: string; kind: ProviderKind; name?: string; base_url?: string; models?: string[] }) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ProviderKind>('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState('')

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 px-3 py-1.5 text-xs font-medium rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors"
      >
        + Add provider
      </button>
    )
  }

  const needsUrl = kind === 'openai-compatible'
  const canAdd = id.trim() && (!needsUrl || baseUrl.trim())

  return (
    <div className="mt-3 p-3 rounded border border-zinc-700 bg-zinc-950/60 flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="provider id (e.g. openrouter)"
          className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="display name (optional)"
          className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600" />
      </div>
      <div className="flex items-center gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}
          className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100">
          {PROVIDER_KINDS.map((k) => (
            <option key={k} value={k}>{PROVIDER_KIND_LABELS[k]}</option>
          ))}
        </select>
        {needsUrl && (
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1"
            className="flex-1 px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600" />
        )}
      </div>
      <input value={models} onChange={(e) => setModels(e.target.value)} placeholder="comma-separated model ids"
        className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600" />
      <div className="flex items-center gap-2">
        <button
          onClick={async () => {
            await onAdd({
              id: id.trim(),
              kind,
              name: name.trim() || undefined,
              base_url: needsUrl ? baseUrl.trim() : undefined,
              models: models.split(',').map((s) => s.trim()).filter(Boolean),
            })
            setOpen(false); setId(''); setName(''); setBaseUrl(''); setModels('')
          }}
          disabled={!canAdd}
          className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white"
        >
          Add
        </button>
        <button onClick={() => setOpen(false)} className="px-3 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
      </div>
    </div>
  )
}
