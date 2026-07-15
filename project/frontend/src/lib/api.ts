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

export type GroupStatus = 'pending' | 'active' | 'reviewing' | 'passed' | 'failed' | 'killed'

// A child agent spawned by the chat agent via SpawnAgent.
export interface SubAgentInfo {
  childRunId: string
  parentRunId: string
  label: string
  task: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt: number | null
  summary: string
}

export interface GroupRow {
  id: string
  task_id: string
  parent_group: string | null
  depth: number
  status: GroupStatus
  worker_role: string | null
  reviewer_role: string | null
  worker_model: string | null
  reviewer_model: string | null
  level: number | null
  budget_usd: number
  spent_usd: number
  retries: number
  signal: string | null
  worker_pid: number | null
  reviewer_pid: number | null
  heartbeat_at: string | null
  peak_context?: number
  context_window?: number
  created_at: string
  updated_at: string
}

export interface GroupMemoryRow {
  id: number
  group_id: string
  task_id: string | null
  role: string | null
  kind: string
  content: string
  ts: string
}

export interface OrchestrationConfig {
  enabled: boolean
  max_concurrent_groups: number
  max_groups_per_task: number
  max_recursion_depth: number
  budget_per_task_usd: number
  budget_per_group_usd: number
  max_retries_per_group: number
  reviewer_level_offset: number
  review_policy: string
  reviewer_for: Record<string, string>
  heartbeat_timeout_sec: number
}

// Discord bot config (stored under `discord` in agents-config.json; the bot
// token itself lives in encrypted secrets, provider id 'discord').
export interface DiscordConfig {
  enabled: boolean
  allowed_user_ids: string[]
  allowed_channel_ids: string[]
  default_worker_role: string
  guild_id: string
  max_code_bytes: number
  agent_provider: string
  agent_model: string
  allow_agent_bash: boolean
}

export const GROUP_STATUS_STYLES: Record<GroupStatus, { label: string; classes: string }> = {
  pending:   { label: 'PENDING',   classes: 'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40' },
  active:    { label: 'ACTIVE',    classes: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  reviewing: { label: 'REVIEWING', classes: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30' },
  passed:    { label: 'PASSED',    classes: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  failed:    { label: 'FAILED',    classes: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
  killed:    { label: 'KILLED',    classes: 'bg-rose-900/30 text-rose-400 ring-rose-800/40' },
}

export interface PendingChange {
  changeId: string
  path: string
  kind: 'write' | 'edit'
  before: string
  after: string
  isNew: boolean
  note: string
}

export interface EditorRequest {
  requestId: string
  op: 'OpenFile' | 'GetOpenEditor' | 'ShowDiff'
  args: Record<string, unknown>
}
export interface EditorResponse {
  requestId: string
  ok: boolean
  result: string
}

// A sensitive action (git mutation, account switch, login, background command)
// the agent wants to run, awaiting the user's approve/decline.
export interface PendingAction {
  actionId: string
  tool: string
  title: string
  detail: string
}

export interface AgentTodo {
  content: string
  status: string
}

export interface GitProfile {
  id: number
  label: string
  user_name: string
  user_email: string
  remote_url: string | null
  gh_account: string | null
  created_at: string
}

// A saved agent conversation (persistent memory), scoped to a workspace.
export interface AgentSessionMeta {
  id: number
  workspace: string
  title: string
  updated_at: string
}

export interface AgentSessionRow extends AgentSessionMeta {
  items: string       // JSON transcript
  created_at: string
}

export type IdeAgentEvent =
  | { type: 'reasoning'; delta: string; turn: number }
  | { type: 'token'; delta: string; turn: number }
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; result: string; isError: boolean }
  | { type: 'pending_change'; change: PendingChange }
  | { type: 'change_resolved'; changeId: string; decision: 'accept' | 'reject' }
  | { type: 'pending_action'; action: PendingAction }
  | { type: 'action_resolved'; actionId: string; approved: boolean }
  | { type: 'todos'; todos: AgentTodo[] }
  | { type: 'file_changed'; path: string }
  | { type: 'context'; used: number; window: number; turn: number }
  | { type: 'blocked'; reason: string; turns: number }
  | { type: 'plan'; plan: string; turns: number }
  | { type: 'done'; text: string; turns: number }
  | { type: 'error'; error: string }
  | { type: 'subagent_started'; childRunId: string; label: string; task: string }

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
      windowMinimize(): Promise<void>
      windowMaximizeToggle(): Promise<boolean>
      windowClose(): Promise<void>
      windowIsMaximized(): Promise<boolean>
      onWindowMaximizedChanged(cb: (maximized: boolean) => void): () => void
      onAgentKilled(cb: (info: { agent: string; reason: string }) => void): () => void
      workspaceListFiles(): Promise<any[]>
      workspaceReadFile(relPath: string): Promise<{ ok: boolean; content: string }>
      workspaceWriteFile(relPath: string, content: string): Promise<{ ok: boolean; error?: string }>
      workspaceGitStatus(): Promise<{ file: string; type: string; staged?: boolean }[]>
      workspaceGitShowHead(relPath: string): Promise<{ ok: boolean; content: string }>
      workspaceGetRoot(): Promise<{ root: string; name: string; recent: string[] }>
      workspaceOpenDialog(): Promise<{ ok: boolean; root?: string; name?: string }>
      workspaceSetRoot(dir: string): Promise<{ ok: boolean; root?: string; name?: string; error?: string }>
      workspaceCreateFile(relPath: string): Promise<{ ok: boolean; error?: string }>
      workspaceCreateFolder(relPath: string): Promise<{ ok: boolean; error?: string }>
      workspaceRename(fromRel: string, toRel: string): Promise<{ ok: boolean; error?: string }>
      workspaceDelete(relPath: string): Promise<{ ok: boolean; error?: string }>
      workspaceSearch(query: string, opts?: { caseSensitive?: boolean; regex?: boolean; maxResults?: number; include?: string; exclude?: string }): Promise<{ ok: boolean; error?: string; matches: { file: string; line: number; column: number; text: string }[] }>
      workspaceReplaceInFile(relPath: string, find: string, replace: string, opts?: { regex?: boolean; caseSensitive?: boolean }): Promise<{ ok: boolean; error?: string }>
      workspaceGitBranch(): Promise<{ current: string; branches: string[] }>
      workspaceGitStage(file: string): Promise<{ ok: boolean; error?: string }>
      workspaceGitUnstage(file: string): Promise<{ ok: boolean; error?: string }>
      workspaceGitStageAll(): Promise<{ ok: boolean; error?: string }>
      workspaceGitCommit(message: string): Promise<{ ok: boolean; output?: string; error?: string }>
      workspaceGitCheckout(branch: string, create?: boolean): Promise<{ ok: boolean; error?: string }>
      workspaceGitPush(): Promise<{ ok: boolean; output?: string }>
      workspaceGitPull(): Promise<{ ok: boolean; output?: string }>
      workspaceGitDirtyCount(): Promise<{ ok: boolean; count: number }>
      workspaceGitRestoreFiles(files: string[]): Promise<{ ok: boolean; restored?: string[]; removed?: string[]; failed?: string[]; error?: string }>
      shellStart(id: string): Promise<{ ok: boolean; history?: string; error?: string }>
      shellWrite(id: string, data: string): Promise<{ ok: boolean }>
      shellResize(id: string, cols: number, rows: number): Promise<{ ok: boolean }>
      shellKill(id: string): Promise<{ ok: boolean }>
      onShellData(id: string, cb: (data: string) => void): () => void
      onShellExit(id: string, cb: (info: { exitCode: number }) => void): () => void
      aiInlineEdit(requestId: string, params: {
        provider: string; model?: string; instruction: string; selection: string
        language?: string; prefix?: string; suffix?: string
      }): Promise<{ ok: boolean; error?: string }>
      aiInlineCancel(requestId: string): Promise<{ ok: boolean }>
      onAiInlineChunk(requestId: string, cb: (delta: string) => void): () => void
      onAiInlineDone(requestId: string, cb: (info: { ok: boolean; text?: string; error?: string }) => void): () => void
      aiChat(requestId: string, params: {
        provider: string; model?: string
        messages: { role: 'user' | 'assistant'; content: string }[]
        contextFiles?: { path: string; language?: string; content: string }[]
        selection?: string
      }): Promise<{ ok: boolean; error?: string }>
      aiChatCancel(requestId: string): Promise<{ ok: boolean }>
      onAiChatChunk(requestId: string, cb: (delta: string) => void): () => void
      onAiChatDone(requestId: string, cb: (info: { ok: boolean; text?: string; error?: string }) => void): () => void
      aiAgentRun(runId: string, params: {
        provider: string; model?: string
        messages: { role: 'user' | 'assistant'; content: string }[]
        openFile?: { path: string; language?: string; content: string }
        selection?: string
        reviewMode?: boolean
        planMode?: boolean
        researchMode?: boolean
      }): Promise<{ ok: boolean; error?: string }>
      aiAgentCancel(runId: string): Promise<{ ok: boolean }>
      aiAgentReview(changeId: string, decision: 'accept' | 'reject'): Promise<{ ok: boolean }>
      aiAgentAction(actionId: string, approved: boolean): Promise<{ ok: boolean }>
      gitProfilesList(): Promise<GitProfile[]>
      gitProfileSave(input: { label: string; user_name: string; user_email: string; remote_url?: string; gh_account?: string }): Promise<{ ok: boolean; error?: string }>
      gitProfileDelete(label: string): Promise<{ ok: boolean }>
      agentSessionList(): Promise<AgentSessionMeta[]>
      agentSessionLatest(): Promise<AgentSessionRow | null>
      agentSessionGet(id: number): Promise<AgentSessionRow | null>
      agentSessionCreate(title: string, items?: string): Promise<{ ok: boolean; id?: number; error?: string }>
      agentSessionUpdate(id: number, items: string, title?: string): Promise<{ ok: boolean }>
      agentSessionRename(id: number, title: string): Promise<{ ok: boolean }>
      agentSessionDelete(id: number): Promise<{ ok: boolean }>
      onAiAgentEvent(runId: string, cb: (e: IdeAgentEvent) => void): () => void
      ideAgentConfigGet(): Promise<{ reviewMode: boolean; allowBash: boolean }>
      ideAgentConfigSet(patch: { reviewMode?: boolean; allowBash?: boolean }): Promise<{ ok: boolean; reviewMode: boolean; allowBash: boolean }>
      onAiAgentEditorReq(runId: string, cb: (req: EditorRequest) => void): () => void
      aiAgentEditorRes(resp: EditorResponse): Promise<{ ok: boolean }>
      browserSetBounds(rect: { x: number; y: number; width: number; height: number }): void
      browserSetVisible(visible: boolean): void
      browserUserNavigate(url: string): void
      browserTabClosed(): void
      onAgentBrowserShow(cb: () => void): () => void
      onBrowserUrlChanged(cb: (info: { url: string; title: string }) => void): () => void
      subagentList(): Promise<{ ok: boolean; subagents: SubAgentInfo[] }>
      onSubagentEvent(cb: (list: SubAgentInfo[]) => void): () => void
      groupCreate(input: { task_id: string; worker_role: string }): Promise<{ ok: boolean; group?: string; error?: string }>
      groupList(): Promise<{ ok: boolean; groups: GroupRow[] }>
      groupKill(groupId: string): Promise<{ ok: boolean }>
      groupMemory(groupId: string): Promise<{ ok: boolean; memory: GroupMemoryRow[] }>
      orchestrationGet(): Promise<OrchestrationConfig>
      orchestrationSet(patch: Partial<OrchestrationConfig>): Promise<{ ok: boolean; orchestration: OrchestrationConfig }>
      onCoordinatorEvent(cb: (info: { event: string; payload: unknown }) => void): () => void
      setZoomFactor(factor: number): void
      discordConfigGet(): Promise<DiscordConfig>
      discordConfigSet(patch: Partial<DiscordConfig>): Promise<{ ok: boolean; discord: DiscordConfig }>
      discordTokenStatus(): Promise<{ hasToken: boolean }>
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

// Resident agents are the always-on coordination brains (pre-warmed, inbox
// driven). Everyone else (engineers, reviewers) runs as ephemeral group
// worker/reviewer sessions under the v2 coordinator and is surfaced in the
// Groups panel, not the AI Agents tab.
export const RESIDENT_ROLES = ['planner', 'orchestrator'] as const

// True for the two always-on coordination agents. Clones of workers are never
// resident. Used to scope the AI Agents tab to just the resident brains.
export function isResidentRole(agent: string): boolean {
  return (RESIDENT_ROLES as readonly string[]).includes(baseRoleOf(agent))
}

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
