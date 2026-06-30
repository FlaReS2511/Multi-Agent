import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  getInboxSummary: () => ipcRenderer.invoke('get-inbox-summary'),
  getInboxContent: (agent: string) => ipcRenderer.invoke('get-inbox-content', agent),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  getRoot: () => ipcRenderer.invoke('get-root'),
  createTask: (input: {
    title: string
    description: string
    owner: string
    priority: 'low' | 'medium' | 'high'
    deps: string[]
    parent_id?: string | null
  }) => ipcRenderer.invoke('create-task', input),
  splitTask: (input: {
    parent_id: string
    subtasks: {
      title: string
      description: string
      owner: string
      priority?: 'low' | 'medium' | 'high'
      deps?: string[]
    }[]
  }) => ipcRenderer.invoke('split-task', input),
  sendMessage: (input: {
    to: string
    from: string
    taskId: string
    body: string
  }) => ipcRenderer.invoke('send-message', input),
  getAgentsConfig: () => ipcRenderer.invoke('get-agents-config'),
  updateAgentModel: (agent: string, provider: string, model: string) =>
    ipcRenderer.invoke('update-agent-model', agent, provider, model),
  getBackendSettings: () => ipcRenderer.invoke('get-backend-settings'),
  setAgentBackend: (input: { agent: string; provider: string; model?: string }) =>
    ipcRenderer.invoke('set-agent-backend', input),
  setProvider: (input: { id: string; kind: string; name?: string; base_url?: string; models?: string[] }) =>
    ipcRenderer.invoke('set-provider', input),
  deleteProvider: (id: string) => ipcRenderer.invoke('delete-provider', id),
  setProviderKey: (input: { provider: string; apiKey: string }) =>
    ipcRenderer.invoke('set-provider-key', input),
  clearProviderKey: (provider: string) =>
    ipcRenderer.invoke('clear-provider-key', provider),
  getAllLogs: () => ipcRenderer.invoke('get-all-logs'),
  updateTask: (id: string, changes: { deps?: string[]; priority?: 'low' | 'medium' | 'high' }) =>
    ipcRenderer.invoke('update-task', id, changes),
  listArtifactTasks: () => ipcRenderer.invoke('list-artifact-tasks'),
  listArtifactTree: (taskId: string) => ipcRenderer.invoke('list-artifact-tree', taskId),
  readArtifactFile: (taskId: string, filename: string) =>
    ipcRenderer.invoke('read-artifact-file', taskId, filename),

  // Planner draft + approve
  getDraftPlan: () => ipcRenderer.invoke('get-draft-plan'),
  sendToPlanner: (message: string) => ipcRenderer.invoke('send-to-planner', message),
  approvePlan: (input: { title: string; body: string }) =>
    ipcRenderer.invoke('approve-plan', input),

  // PTY
  ptyStart: (agent: string) => ipcRenderer.invoke('pty-start', agent),
  ptyAttach: (agent: string) => ipcRenderer.invoke('pty-attach', agent),
  getCostSummary: () => ipcRenderer.invoke('get-cost-summary'),
  getTaskThread: (taskId: string) => ipcRenderer.invoke('get-task-thread', taskId),
  ptyWrite: (agent: string, data: string) => ipcRenderer.invoke('pty-write', agent, data),
  ptyResize: (agent: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-resize', agent, cols, rows),
  ptyKill: (agent: string) => ipcRenderer.invoke('pty-kill', agent),
  ptyRestart: (agent: string) => ipcRenderer.invoke('pty-restart', agent),
  ptyStatus: () => ipcRenderer.invoke('pty-status'),
  ptyStatusDetail: () => ipcRenderer.invoke('pty-status-detail'),
  onAgentKilled: (cb: (info: { agent: string; reason: string }) => void) => {
    const listener = (_e: unknown, info: { agent: string; reason: string }) => cb(info)
    ipcRenderer.on('agent-killed', listener)
    return () => ipcRenderer.removeListener('agent-killed', listener)
  },
  onPtyData: (agent: string, cb: (data: string) => void) => {
    const channel = `pty-data:${agent}`
    const listener = (_e: unknown, data: string) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onPtyExit: (agent: string, cb: (info: { exitCode: number; signal?: number }) => void) => {
    const channel = `pty-exit:${agent}`
    const listener = (_e: unknown, info: { exitCode: number; signal?: number }) => cb(info)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  workspaceListFiles: () => ipcRenderer.invoke('workspace-list-files'),
  workspaceReadFile: (relPath: string) => ipcRenderer.invoke('workspace-read-file', relPath),
  workspaceWriteFile: (relPath: string, content: string) => ipcRenderer.invoke('workspace-write-file', relPath, content),
  workspaceGitStatus: () => ipcRenderer.invoke('workspace-git-status'),
  workspaceGitShowHead: (relPath: string) => ipcRenderer.invoke('workspace-git-show-head', relPath),

  // Inline AI edit (streaming)
  aiInlineEdit: (requestId: string, params: {
    provider: string; model?: string; instruction: string; selection: string
    language?: string; prefix?: string; suffix?: string
  }) => ipcRenderer.invoke('ai-inline-edit', requestId, params),
  aiInlineCancel: (requestId: string) => ipcRenderer.invoke('ai-inline-cancel', requestId),
  onAiInlineChunk: (requestId: string, cb: (delta: string) => void) => {
    const channel = `ai-inline-chunk:${requestId}`
    const listener = (_e: unknown, delta: string) => cb(delta)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onAiInlineDone: (requestId: string, cb: (info: { ok: boolean; text?: string; error?: string }) => void) => {
    const channel = `ai-inline-done:${requestId}`
    const listener = (_e: unknown, info: { ok: boolean; text?: string; error?: string }) => cb(info)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  setAutoTrigger: (enabled: boolean) => ipcRenderer.invoke('set-auto-trigger', enabled),
  getAutoTrigger: () => ipcRenderer.invoke('get-auto-trigger'),
  onAutoTrigger: (cb: (info: { agent: string }) => void) => {
    const listener = (_e: unknown, info: { agent: string }) => cb(info)
    ipcRenderer.on('auto-trigger', listener)
    return () => ipcRenderer.removeListener('auto-trigger', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
