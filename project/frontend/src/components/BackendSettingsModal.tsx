import { useEffect, useState, useCallback } from 'react'
import {
  colorFor,
  baseRoleOf,
  BACKEND_KIND_LABELS,
  BackendKind,
  BackendSettings,
  ModelOption,
  SecretProvider,
  backendKindToProvider,
  backendNeedsKey,
} from '../lib/api'

const BACKEND_KINDS: BackendKind[] = [
  'claude-cli', 'codex-cli', 'gemini-cli',
  'api-anthropic', 'api-google', 'api-openai', 'lm-studio',
]

const PROVIDERS: SecretProvider[] = ['anthropic', 'google', 'openai']

interface Props {
  open: boolean
  onClose: () => void
}

export function BackendSettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<BackendSettings | null>(null)
  const [savingAgent, setSavingAgent] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<SecretProvider | null>(null)
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

  const restartAgent = async (agent: string) => {
    try { await window.api.ptyRestart(agent) } catch { /* ignore */ }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[820px] max-w-[95vw] max-h-[90vh] overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between sticky top-0 bg-zinc-900 z-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-100">Backend Settings</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">×</button>
        </div>

        {!settings.safeStorageAvailable && (
          <div className="mx-5 mt-4 px-3 py-2 text-xs rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">
            OS keychain encryption not available — API key fields are disabled. Try a different OS or install a keyring.
          </div>
        )}
        {error && (
          <div className="mx-5 mt-4 px-3 py-2 text-xs rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">
            {error}
          </div>
        )}

        <section className="p-5">
          <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">Per-agent backend</h3>
          <div className="text-[11px] text-zinc-500 mb-3">
            CLI is the default. Switch an agent to API mode only when you want it to call a provider directly with the keys below.
          </div>
          <div className="grid grid-cols-[120px_180px_1fr_auto_auto] gap-2 text-[10px] uppercase tracking-wider text-zinc-500 px-1 pb-2 border-b border-zinc-800">
            <span>Agent</span><span>Backend</span><span>Model / endpoint</span><span></span><span></span>
          </div>
          {Object.keys(settings.agents).sort((a, b) => {
            const ba = baseRoleOf(a); const bb = baseRoleOf(b)
            if (ba !== bb) return ba.localeCompare(bb)
            return a.localeCompare(b, undefined, { numeric: true })
          }).map((agent) => (
            <AgentRow
              key={agent}
              agent={agent}
              entry={settings.agents[agent]}
              models={settings.available_models}
              saving={savingAgent === agent}
              onSave={async (kind, model, base_url) => {
                setSavingAgent(agent)
                setError('')
                try {
                  await window.api.setAgentBackend({ agent, kind, model, base_url })
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

        <section className="px-5 pb-5 border-t border-zinc-800 pt-5">
          <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">API Keys</h3>
          <div className="text-[11px] text-zinc-500 mb-3">
            One key per provider, shared across any agent set to API mode for that provider. Keys are encrypted via OS keychain (Electron safeStorage) before being written to <code className="text-zinc-400">shared/.secrets.json</code>.
          </div>
          {PROVIDERS.map((p) => (
            <KeyRow
              key={p}
              provider={p}
              hasKey={settings.keys[p]}
              disabled={!settings.safeStorageAvailable}
              saving={savingKey === p}
              onSave={async (apiKey) => {
                setSavingKey(p)
                setError('')
                try {
                  const result = await window.api.setProviderKey({ provider: p, apiKey })
                  if (!result.ok) setError(result.error || 'failed to save key')
                  await refresh()
                } finally {
                  setSavingKey(null)
                }
              }}
              onClear={async () => {
                setSavingKey(p)
                try { await window.api.clearProviderKey(p); await refresh() }
                finally { setSavingKey(null) }
              }}
            />
          ))}
        </section>
      </div>
    </div>
  )
}

interface AgentRowProps {
  agent: string
  entry: { backend?: { kind: BackendKind; model?: string; base_url?: string }; model?: string } | undefined
  models: ModelOption[]
  saving: boolean
  onSave: (kind: BackendKind, model?: string, base_url?: string) => Promise<void>
}

function AgentRow({ agent, entry, models, saving, onSave }: AgentRowProps) {
  const initialKind = entry?.backend?.kind ?? 'claude-cli'
  const initialModel = entry?.backend?.model ?? entry?.model ?? ''
  const initialUrl = entry?.backend?.base_url ?? 'http://localhost:1234/v1'
  const [kind, setKind] = useState<BackendKind>(initialKind)
  const [model, setModel] = useState<string>(initialModel)
  const [baseUrl, setBaseUrl] = useState<string>(initialUrl)

  useEffect(() => {
    setKind(initialKind); setModel(initialModel); setBaseUrl(initialUrl)
  }, [initialKind, initialModel, initialUrl])

  const dirty = kind !== initialKind || model !== initialModel || baseUrl !== initialUrl
  const provider = backendKindToProvider(kind)
  const filteredModels = models.filter((m) => m.provider === provider)

  return (
    <div className="grid grid-cols-[120px_180px_1fr_auto_auto] gap-2 items-center py-2 border-b border-zinc-800/60">
      <span className={`text-xs font-medium ${colorFor(agent)}`}>{agent}</span>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as BackendKind)}
        className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100"
      >
        {BACKEND_KINDS.map((k) => (
          <option key={k} value={k}>{BACKEND_KIND_LABELS[k]}</option>
        ))}
      </select>
      <div className="flex items-center gap-2">
        {kind === 'lm-studio' && (
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:1234/v1"
            className="flex-1 min-w-0 px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600"
          />
        )}
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100"
        >
          <option value="">(default)</option>
          {filteredModels.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => onSave(kind, model || undefined, kind === 'lm-studio' ? baseUrl : undefined)}
        disabled={!dirty || saving}
        className="px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
      >
        {saving ? '…' : dirty ? 'Save' : 'Saved'}
      </button>
      <span className="text-[10px] text-zinc-600 w-16 text-right">
        {backendNeedsKey(kind) ? 'needs key' : ''}
      </span>
    </div>
  )
}

interface KeyRowProps {
  provider: SecretProvider
  hasKey: boolean
  disabled: boolean
  saving: boolean
  onSave: (apiKey: string) => Promise<void>
  onClear: () => Promise<void>
}

function KeyRow({ provider, hasKey, disabled, saving, onSave, onClear }: KeyRowProps) {
  const [value, setValue] = useState<string>('')
  const dirty = value.length > 0

  return (
    <div className="grid grid-cols-[120px_1fr_auto_auto] gap-2 items-center py-2 border-b border-zinc-800/60">
      <span className="text-xs text-zinc-300 capitalize">{provider}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={hasKey ? '••••••••  (key on file — type to replace)' : `Enter ${provider} API key`}
        disabled={disabled}
        className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 disabled:opacity-50"
      />
      <button
        onClick={async () => { await onSave(value); setValue('') }}
        disabled={!dirty || saving || disabled}
        className="px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
      >
        {saving ? '…' : 'Save'}
      </button>
      <button
        onClick={onClear}
        disabled={!hasKey || saving || disabled}
        className="px-3 py-1 text-xs font-medium rounded border border-zinc-700 text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 disabled:opacity-30 transition-colors"
      >
        Clear
      </button>
    </div>
  )
}
