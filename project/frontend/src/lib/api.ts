export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked'

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

export interface AgentsConfig {
  agents: Record<string, { provider: string; model: string }>
  available_models: ModelOption[]
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
      sendMessage(input: SendMessageInput): Promise<{ ok: boolean }>
      getAgentsConfig(): Promise<AgentsConfig>
      updateAgentModel(agent: string, provider: string, model: string): Promise<{ ok: boolean }>
      updateTask(id: string, changes: UpdateTaskInput): Promise<{ ok: boolean }>
      listArtifactTasks(): Promise<string[]>
      listArtifactTree(taskId: string): Promise<ArtifactNode[]>
      readArtifactFile(taskId: string, filename: string): Promise<{ ok: boolean; content: string }>
      getDraftPlan(): Promise<DraftPlan | null>
      sendToPlanner(message: string): Promise<{ ok: boolean; ts: string }>
      approvePlan(input: ApprovePlanInput): Promise<{ ok: boolean; ts: string }>
      ptyStart(agent: string): Promise<{ ok: boolean; history: string }>
      ptyWrite(agent: string, data: string): Promise<{ ok: boolean }>
      ptyResize(agent: string, cols: number, rows: number): Promise<{ ok: boolean }>
      ptyKill(agent: string): Promise<{ ok: boolean }>
      ptyRestart(agent: string): Promise<{ ok: boolean }>
      ptyStatus(): Promise<string[]>
      onPtyData(agent: string, cb: (data: string) => void): () => void
      onPtyExit(agent: string, cb: (info: { exitCode: number; signal?: number }) => void): () => void
      setAutoTrigger(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>
      getAutoTrigger(): Promise<{ enabled: boolean }>
      onAutoTrigger(cb: (info: { agent: string }) => void): () => void
    }
  }
}

export const AGENTS = ['planner', 'orchestrator', 'backend-engineer', 'frontend-engineer', 'ai-engineer', 'reviewer'] as const
export type AgentName = typeof AGENTS[number]

export const PRIORITY_STYLES: Record<Priority, { label: string; classes: string }> = {
  low:    { label: 'LOW',    classes: 'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40' },
  medium: { label: 'MED',    classes: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  high:   { label: 'HIGH',   classes: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
}

export const STATUS_STYLES: Record<TaskStatus, { label: string; classes: string }> = {
  todo:        { label: 'TODO',        classes: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  in_progress: { label: 'IN PROGRESS', classes: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  review:      { label: 'REVIEW',      classes: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30' },
  done:        { label: 'DONE',        classes: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  blocked:     { label: 'BLOCKED',     classes: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
}

export const AGENT_COLORS: Record<string, string> = {
  planner:              'text-violet-400',
  orchestrator:         'text-cyan-400',
  'backend-engineer':   'text-emerald-400',
  'frontend-engineer':  'text-sky-400',
  'ai-engineer':        'text-fuchsia-400',
  reviewer:             'text-amber-400',
}
