export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked' | 'waiting_children'

export type Priority = 'low' | 'medium' | 'high'

export interface Task {
  id: string
  title: string
  owner: string
  status: TaskStatus
  deps: string[]
  created_at: string
  updated_at: string
  artifact?: string
  priority?: Priority
  parent_id?: string | null
  children?: string[]
}

export interface TasksFile {
  tasks: Task[]
  next_id: number
}

export interface InboxSummary {
  agent: string
  count: number
  preview: string
}

export interface AgentLogs {
  agent: string
  lines: string[]
}

export interface CreateTaskInput {
  title: string
  description: string
  owner: string
  priority: Priority
  deps: string[]
  parent_id?: string | null
}

export interface SplitSubtask {
  title: string
  description: string
  owner: string
  priority?: Priority
  deps?: string[]
}

export interface SplitTaskInput {
  parent_id: string
  subtasks: SplitSubtask[]
}

export interface SendMessageInput {
  to: string
  from: string
  taskId: string
  body: string
}

export interface ModelOption {
  provider: string
  id: string
  label: string
  tier: string
}

// API-only: providers are dynamic. A provider declares a `kind` and, for
// OpenAI-compatible gateways (VietAPI, LM Studio, OpenRouter, ...), a base_url.
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'openai-compatible'

export interface ProviderBlock {
  kind: ProviderKind
  name?: string
  base_url?: string
  models?: string[]
  price_in?: number
  price_out?: number
}

// Secrets are keyed by provider id (any string).
export type SecretProvider = string

export interface AgentEntry {
  backend?: { mode?: string }
  provider?: string
  model?: string
}

export interface AgentsConfig {
  providers?: Record<string, ProviderBlock>
  agents: Record<string, AgentEntry>
  available_models: ModelOption[]
}

export interface BackendSettings {
  agents: Record<string, AgentEntry>
  providers: Record<string, ProviderBlock>
  available_models: ModelOption[]
  keys: Record<string, boolean>
  safeStorageAvailable: boolean
}

export interface SetAgentBackendInput {
  agent: string
  provider: string
  model?: string
}

export interface SetProviderInput {
  id: string
  kind: ProviderKind
  name?: string
  base_url?: string
  models?: string[]
}

export interface SetProviderKeyInput {
  provider: SecretProvider
  apiKey: string
}

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  'anthropic':         'Anthropic API',
  'openai':            'OpenAI API',
  'google':            'Google API',
  'openai-compatible': 'OpenAI-compatible (custom)',
}

// Whether a provider kind requires an API key. Only local OpenAI-compatible
// servers (LM Studio etc.) can run keyless.
export function providerNeedsKey(kind: ProviderKind, baseUrl?: string): boolean {
  if (kind === 'openai-compatible' && baseUrl && baseUrl.includes('localhost')) return false
  return true
}

export interface ArtifactNode {
  name: string
  isDir: boolean
}

export interface UpdateTaskInput {
  deps?: string[]
  priority?: Priority
}

export interface DraftPlan {
  title: string
  body: string
  updated_at: string
}

export interface ApprovePlanInput {
  title: string
  body: string
}

export interface PtySessionDetail {
  agent: string
  alive: boolean
  idle_seconds: number
  spawned_at: number
  pre_warmed: boolean
}

export interface CostBucket {
  usd: number
  tokens_in: number
  tokens_out: number
}

export interface CostSummary {
  today: CostBucket
  by_agent: ({ agent: string } & CostBucket)[]
  by_task: ({ task_id: string } & CostBucket)[]
  by_hour_today: { hour: number; usd: number }[]
  date: string
  pricing_as_of: string
}

export interface TaskThreadEntry {
  ts: string
  from: string
  to: string
  task_id: string
  subject?: string
  body: string
  source: 'inbox' | 'outbox'
  source_file: string
}

declare global {
  interface Window {
    api: {
      getTasks(): Promise<TasksFile>
      getInboxSummary(): Promise<InboxSummary[]>
      getInboxContent(agent: string): Promise<string>
      getLogs(): Promise<AgentLogs[]>
      getAllLogs(): Promise<AgentLogs[]>
      getRoot(): Promise<string>
      createTask(input: CreateTaskInput): Promise<{ id: string; task: Task }>
      splitTask(input: SplitTaskInput): Promise<{ ok: boolean; parent_id: string; children: Task[] }>
      sendMessage(input: SendMessageInput): Promise<{ ok: boolean }>
      getAgentsConfig(): Promise<AgentsConfig>
      updateAgentModel(agent: string, provider: string, model: string): Promise<{ ok: boolean }>
      getBackendSettings(): Promise<BackendSettings>
      setAgentBackend(input: SetAgentBackendInput): Promise<{ ok: boolean }>
      setProvider(input: SetProviderInput): Promise<{ ok: boolean; error?: string }>
      deleteProvider(id: string): Promise<{ ok: boolean }>
      setProviderKey(input: SetProviderKeyInput): Promise<{ ok: boolean; error?: string }>
      clearProviderKey(provider: SecretProvider): Promise<{ ok: boolean }>
      updateTask(id: string, changes: UpdateTaskInput): Promise<{ ok: boolean }>
      listArtifactTasks(): Promise<string[]>
      listArtifactTree(taskId: string): Promise<ArtifactNode[]>
      readArtifactFile(taskId: string, filename: string): Promise<{ ok: boolean; content: string }>
      getDraftPlan(): Promise<DraftPlan | null>
      sendToPlanner(message: string): Promise<{ ok: boolean; ts: string }>
      approvePlan(input: ApprovePlanInput): Promise<{ ok: boolean; ts: string }>
      ptyStart(agent: string): Promise<{ ok: boolean; history: string }>
      ptyAttach(agent: string): Promise<{ alive: boolean; history: string }>
      getCostSummary(): Promise<CostSummary>
      getTaskThread(taskId: string): Promise<TaskThreadEntry[]>
      ptyWrite(agent: string, data: string): Promise<{ ok: boolean }>
      ptyResize(agent: string, cols: number, rows: number): Promise<{ ok: boolean }>
      ptyKill(agent: string): Promise<{ ok: boolean }>
      ptyRestart(agent: string): Promise<{ ok: boolean }>
      ptyStatus(): Promise<string[]>
      ptyStatusDetail(): Promise<PtySessionDetail[]>
      onPtyData(agent: string, cb: (data: string) => void): () => void
      onPtyExit(agent: string, cb: (info: { exitCode: number; signal?: number }) => void): () => void
      setAutoTrigger(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>
      getAutoTrigger(): Promise<{ enabled: boolean }>
      onAutoTrigger(cb: (info: { agent: string }) => void): () => void
      onAgentKilled(cb: (info: { agent: string; reason: string }) => void): () => void
      workspaceListFiles(): Promise<any[]>
      workspaceReadFile(relPath: string): Promise<{ ok: boolean; content: string }>
      workspaceWriteFile(relPath: string, content: string): Promise<{ ok: boolean; error?: string }>
      workspaceGitStatus(): Promise<{ file: string; type: string }[]>
      workspaceGitShowHead(relPath: string): Promise<{ ok: boolean; content: string }>
      aiInlineEdit(requestId: string, params: {
        provider: string; model?: string; instruction: string; selection: string
        language?: string; prefix?: string; suffix?: string
      }): Promise<{ ok: boolean; error?: string }>
      aiInlineCancel(requestId: string): Promise<{ ok: boolean }>
      onAiInlineChunk(requestId: string, cb: (delta: string) => void): () => void
      onAiInlineDone(requestId: string, cb: (info: { ok: boolean; text?: string; error?: string }) => void): () => void
    }
  }
}

// Base roles are fixed at codebase level. Runtime agent set may include
// dynamically created clones (e.g. `backend-engineer-2`) whose names are not
// part of this union. Treat AgentName as `string` outside of the base list.
export const BASE_ROLES = [
  'planner',
  'orchestrator',
  'backend-engineer',
  'frontend-engineer',
  'ai-engineer',
  'be-reviewer',
  'fe-reviewer',
  'ai-reviewer',
] as const
// Roles that may be cloned into multiple instances (excludes singletons).
export const CLONABLE_ROLES = [
  'backend-engineer',
  'frontend-engineer',
  'ai-engineer',
  'be-reviewer',
  'fe-reviewer',
  'ai-reviewer',
] as const

// Backward-compat alias. Components that still hardcode the agent list use this.
// New code should call activeAgents(config) for the runtime-derived set.
export const AGENTS = BASE_ROLES
export type AgentName = string

// Strip the trailing `-N` suffix from a clone instance to recover its base role.
//   baseRoleOf('backend-engineer-2') === 'backend-engineer'
//   baseRoleOf('orchestrator')        === 'orchestrator'
export function baseRoleOf(agent: string): string {
  return agent.replace(/-\d+$/, '')
}

// Resolve agent → tab color. Clones inherit their base role's color.
export function colorFor(agent: string): string {
  return AGENT_COLORS[agent] ?? AGENT_COLORS[baseRoleOf(agent)] ?? 'text-zinc-300'
}

// Runtime agent list, derived from agents-config.json. Falls back to BASE_ROLES
// if the config has not loaded yet.
export function activeAgents(config: AgentsConfig | null): string[] {
  if (!config || !config.agents) return BASE_ROLES.slice()
  return Object.keys(config.agents).sort((a, b) => {
    // Group clones with their base, sort base first then numeric suffix
    const ba = baseRoleOf(a)
    const bb = baseRoleOf(b)
    if (ba !== bb) return ba.localeCompare(bb)
    return a.localeCompare(b, undefined, { numeric: true })
  })
}

export const PRIORITY_STYLES: Record<Priority, { label: string; classes: string }> = {
  low:    { label: 'LOW',    classes: 'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40' },
  medium: { label: 'MED',    classes: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  high:   { label: 'HIGH',   classes: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
}

export const STATUS_STYLES: Record<TaskStatus, { label: string; classes: string }> = {
  todo:             { label: 'TODO',     classes: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  in_progress:      { label: 'IN PROGRESS', classes: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  review:           { label: 'REVIEW',   classes: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30' },
  done:             { label: 'DONE',     classes: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  blocked:          { label: 'BLOCKED',  classes: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
  waiting_children: { label: 'WAITING',  classes: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30' },
}

export const AGENT_COLORS: Record<string, string> = {
  planner:              'text-violet-400',
  orchestrator:         'text-cyan-400',
  'backend-engineer':   'text-emerald-400',
  'frontend-engineer':  'text-sky-400',
  'ai-engineer':        'text-fuchsia-400',
  'be-reviewer':        'text-amber-400',
  'fe-reviewer':        'text-orange-400',
  'ai-reviewer':        'text-yellow-400',
}
