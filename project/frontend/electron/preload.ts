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
  }) => ipcRenderer.invoke('create-task', input),
  sendMessage: (input: {
    to: string
    from: string
    taskId: string
    body: string
  }) => ipcRenderer.invoke('send-message', input),
  getAgentsConfig: () => ipcRenderer.invoke('get-agents-config'),
  updateAgentModel: (agent: string, provider: string, model: string) =>
    ipcRenderer.invoke('update-agent-model', agent, provider, model),
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
  ptyWrite: (agent: string, data: string) => ipcRenderer.invoke('pty-write', agent, data),
  ptyResize: (agent: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-resize', agent, cols, rows),
  ptyKill: (agent: string) => ipcRenderer.invoke('pty-kill', agent),
  ptyRestart: (agent: string) => ipcRenderer.invoke('pty-restart', agent),
  ptyStatus: () => ipcRenderer.invoke('pty-status'),
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
