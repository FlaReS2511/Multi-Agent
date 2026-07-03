import { useEffect, useState, useCallback } from 'react'
import {
  colorFor,
  baseRoleOf,
  PROVIDER_KIND_LABELS,
  ProviderKind,
  ProviderBlock,
  BackendSettings,
  providerNeedsKey,
  OrchestrationConfig,
} from '../lib/api'
import { useAnimationsEnabled, setAnimationsEnabled } from '../lib/uiSettings'

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
  const animationsOn = useAnimationsEnabled()
  const [orch, setOrch] = useState<OrchestrationConfig | null>(null)

  const refresh = useCallback(async () => {
    setSettings(await window.api.getBackendSettings())
    setOrch(await window.api.orchestrationGet())
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

        {/* Orchestration (v2 group coordinator) */}
        {orch && (
          <OrchestrationSection
            orch={orch}
            onChange={async (patch) => {
              const res = await window.api.orchestrationSet(patch)
              if (res.ok) setOrch(res.orchestration)
            }}
          />
        )}

        {/* Interface */}
        <section className="px-5 pb-6 border-t border-zinc-800 pt-5">
          <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">Interface</h3>
          <label className="flex items-center justify-between gap-4 cursor-pointer group">
            <div>
              <div className="text-xs text-zinc-200 font-medium">Animations</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">
                Panel slide-in and content wind-up effects. Turn off for instant, motion-free transitions.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={animationsOn}
              onClick={() => setAnimationsEnabled(!animationsOn)}
              className={`relative w-10 h-5 rounded-full flex-shrink-0 p-0.5 flex items-center transition-colors ${
                animationsOn ? 'bg-blue-600' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`size-4 rounded-full bg-white shadow-sm transition-transform will-change-transform ${
                  animationsOn ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </label>
        </section>
      </div>
    </div>
  )
}

// ── Orchestration (v2 group coordinator) settings ──────────────

interface OrchestrationSectionProps {
  orch: OrchestrationConfig
  onChange: (patch: Partial<OrchestrationConfig>) => Promise<void>
}

const ORCH_NUM_FIELDS: { key: keyof OrchestrationConfig; label: string; hint: string }[] = [
  { key: 'max_concurrent_groups', label: 'Max concurrent groups', hint: 'Groups running at once' },
  { key: 'max_groups_per_task', label: 'Max groups per task', hint: 'Total incl. sub-groups' },
  { key: 'max_recursion_depth', label: 'Max recursion depth', hint: 'How deep sub-groups nest' },
  { key: 'budget_per_task_usd', label: 'Budget per task ($)', hint: 'Hard cap; task stops if exceeded' },
  { key: 'budget_per_group_usd', label: 'Budget per group ($)', hint: 'Hard cap per group' },
  { key: 'max_retries_per_group', label: 'Max retries per group', hint: 'worker→review→worker rounds' },
  { key: 'heartbeat_timeout_sec', label: 'Heartbeat timeout (s)', hint: 'Hung group → respawn/fail' },
]

function OrchestrationSection({ orch, onChange }: OrchestrationSectionProps) {
  return (
    <section className="px-5 pb-5 border-t border-zinc-800 pt-5">
      <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-3">
        Agent Orchestration (v2)
      </h3>

      <label className="flex items-center justify-between gap-4 cursor-pointer mb-4">
        <div>
          <div className="text-xs text-zinc-200 font-medium">Enable group coordinator</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            Spawns worker + on-demand reviewer groups per task, with hard budget and
            concurrency caps. Off by default — the classic inbox flow keeps working.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={orch.enabled}
          onClick={() => onChange({ enabled: !orch.enabled })}
          className={`relative w-10 h-5 rounded-full flex-shrink-0 p-0.5 flex items-center transition-colors ${
            orch.enabled ? 'bg-blue-600' : 'bg-zinc-700'
          }`}
        >
          <span
            className={`size-4 rounded-full bg-white shadow-sm transition-transform will-change-transform ${
              orch.enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </label>

      <div className={`grid grid-cols-2 gap-x-4 gap-y-3 ${orch.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        {ORCH_NUM_FIELDS.map((f) => (
          <NumberField
            key={f.key}
            label={f.label}
            hint={f.hint}
            value={Number(orch[f.key])}
            step={f.key.includes('usd') ? 0.5 : 1}
            onCommit={(v) => onChange({ [f.key]: v } as Partial<OrchestrationConfig>)}
          />
        ))}
      </div>

      <div className={`mt-4 ${orch.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="text-xs text-zinc-200 font-medium mb-1">Review policy</div>
        <select
          value={orch.review_policy}
          onChange={(e) => onChange({ review_policy: e.target.value })}
          className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100"
        >
          <option value="on-demand">On-demand (worker requests review)</option>
          <option value="always">Always (review every group)</option>
          <option value="never">Never (skip review, trust worker)</option>
        </select>
      </div>
    </section>
  )
}

interface NumberFieldProps {
  label: string
  hint: string
  value: number
  step: number
  onCommit: (v: number) => void
}

function NumberField({ label, hint, value, step, onCommit }: NumberFieldProps) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => { setLocal(String(value)) }, [value])
  const commit = () => {
    const n = Number(local)
    if (!Number.isNaN(n) && n !== value) onCommit(n)
    else setLocal(String(value))
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-zinc-300 font-medium">{label}</span>
      <input
        type="number"
        step={step}
        min={0}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 w-full"
      />
      <span className="text-[10px] text-zinc-600">{hint}</span>
    </label>
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

function AgentRow({ agent, providerId, model, providers, saving, onSave }: AgentRowProps) {  const [prov, setProv] = useState(providerId)
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
