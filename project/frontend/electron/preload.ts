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

  // Real shell terminals (user shell in workspace root)
  shellStart: (id: string) => ipcRenderer.invoke('shell-start', id),
  shellWrite: (id: string, data: string) => ipcRenderer.invoke('shell-write', id, data),
  shellResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('shell-resize', id, cols, rows),
  shellKill: (id: string) => ipcRenderer.invoke('shell-kill', id),
  onShellData: (id: string, cb: (data: string) => void) => {
    const channel = `shell-data:${id}`
    const listener = (_e: unknown, data: string) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onShellExit: (id: string, cb: (info: { exitCode: number }) => void) => {
    const channel = `shell-exit:${id}`
    const listener = (_e: unknown, info: { exitCode: number }) => cb(info)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  workspaceListFiles: () => ipcRenderer.invoke('workspace-list-files'),
  workspaceReadFile: (relPath: string) => ipcRenderer.invoke('workspace-read-file', relPath),
  workspaceWriteFile: (relPath: string, content: string) => ipcRenderer.invoke('workspace-write-file', relPath, content),
  workspaceGitStatus: () => ipcRenderer.invoke('workspace-git-status'),
  workspaceGitShowHead: (relPath: string) => ipcRenderer.invoke('workspace-git-show-head', relPath),

  // Workspace root / folder selection
  workspaceGetRoot: () => ipcRenderer.invoke('workspace-get-root'),
  workspaceOpenDialog: () => ipcRenderer.invoke('workspace-open-dialog'),
  workspaceSetRoot: (dir: string) => ipcRenderer.invoke('workspace-set-root', dir),

  // File operations
  workspaceCreateFile: (relPath: string) => ipcRenderer.invoke('workspace-create-file', relPath),
  workspaceCreateFolder: (relPath: string) => ipcRenderer.invoke('workspace-create-folder', relPath),
  workspaceRename: (fromRel: string, toRel: string) => ipcRenderer.invoke('workspace-rename', fromRel, toRel),
  workspaceDelete: (relPath: string) => ipcRenderer.invoke('workspace-delete', relPath),

  // Search
  workspaceSearch: (query: string, opts?: { caseSensitive?: boolean; regex?: boolean; maxResults?: number }) =>
    ipcRenderer.invoke('workspace-search', query, opts),
  workspaceReplaceInFile: (relPath: string, find: string, replace: string, opts?: { regex?: boolean; caseSensitive?: boolean }) =>
    ipcRenderer.invoke('workspace-replace-in-file', relPath, find, replace, opts),

  // Git (full)
  workspaceGitBranch: () => ipcRenderer.invoke('workspace-git-branch'),
  workspaceGitStage: (file: string) => ipcRenderer.invoke('workspace-git-stage', file),
  workspaceGitUnstage: (file: string) => ipcRenderer.invoke('workspace-git-unstage', file),
  workspaceGitStageAll: () => ipcRenderer.invoke('workspace-git-stage-all'),
  workspaceGitCommit: (message: string) => ipcRenderer.invoke('workspace-git-commit', message),
  workspaceGitCheckout: (branch: string, create?: boolean) => ipcRenderer.invoke('workspace-git-checkout', branch, create),
  workspaceGitPush: () => ipcRenderer.invoke('workspace-git-push'),
  workspaceGitPull: () => ipcRenderer.invoke('workspace-git-pull'),
  workspaceGitDirtyCount: () => ipcRenderer.invoke('workspace-git-dirty-count'),
  workspaceGitRestoreFiles: (files: string[]) => ipcRenderer.invoke('workspace-git-restore-files', files),

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

  // AI chat (streaming coding assistant)
  aiChat: (requestId: string, params: {
    provider: string; model?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    contextFiles?: { path: string; language?: string; content: string }[]
    selection?: string
  }) => ipcRenderer.invoke('ai-chat', requestId, params),
  aiChatCancel: (requestId: string) => ipcRenderer.invoke('ai-chat-cancel', requestId),
  onAiChatChunk: (requestId: string, cb: (delta: string) => void) => {
    const channel = `ai-chat-chunk:${requestId}`
    const listener = (_e: unknown, delta: string) => cb(delta)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onAiChatDone: (requestId: string, cb: (info: { ok: boolean; text?: string; error?: string }) => void) => {
    const channel = `ai-chat-done:${requestId}`
    const listener = (_e: unknown, info: { ok: boolean; text?: string; error?: string }) => cb(info)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  // IDE agent (tool-calling loop)
  aiAgentRun: (runId: string, params: {
    provider: string; model?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    openFile?: { path: string; language?: string; content: string }
    selection?: string
    reviewMode?: boolean
    planMode?: boolean
    researchMode?: boolean
  }) => ipcRenderer.invoke('ai-agent-run', runId, params),
  aiAgentCancel: (runId: string) => ipcRenderer.invoke('ai-agent-cancel', runId),
  aiAgentReview: (changeId: string, decision: 'accept' | 'reject') =>
    ipcRenderer.invoke('ai-agent-review', changeId, decision),
  aiAgentAction: (actionId: string, approved: boolean) =>
    ipcRenderer.invoke('ai-agent-action', actionId, approved),

  // Git account profiles (for the agent's SwitchGitAccount)
  gitProfilesList: () => ipcRenderer.invoke('git-profiles-list'),
  gitProfileSave: (input: {
    label: string; user_name: string; user_email: string; remote_url?: string; gh_account?: string
  }) => ipcRenderer.invoke('git-profile-save', input),
  gitProfileDelete: (label: string) => ipcRenderer.invoke('git-profile-delete', label),

  // Agent chat sessions (persistent memory)
  agentSessionList: () => ipcRenderer.invoke('agent-session-list'),
  agentSessionLatest: () => ipcRenderer.invoke('agent-session-latest'),
  agentSessionGet: (id: number) => ipcRenderer.invoke('agent-session-get', id),
  agentSessionCreate: (title: string, items?: string) => ipcRenderer.invoke('agent-session-create', title, items),
  agentSessionUpdate: (id: number, items: string, title?: string) => ipcRenderer.invoke('agent-session-update', id, items, title),
  agentSessionRename: (id: number, title: string) => ipcRenderer.invoke('agent-session-rename', id, title),
  agentSessionDelete: (id: number) => ipcRenderer.invoke('agent-session-delete', id),
  onAiAgentEvent: (runId: string, cb: (e: unknown) => void) => {
    const channel = `ai-agent-event:${runId}`
    const listener = (_e: unknown, ev: unknown) => cb(ev)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  ideAgentConfigGet: () => ipcRenderer.invoke('ide-agent-config-get'),
  ideAgentConfigSet: (patch: { reviewMode?: boolean; allowBash?: boolean }) =>
    ipcRenderer.invoke('ide-agent-config-set', patch),
  // Editor round-trip tools: main asks the renderer to drive Monaco.
  onAiAgentEditorReq: (runId: string, cb: (req: unknown) => void) => {
    const channel = `ai-agent-editor-req:${runId}`
    const listener = (_e: unknown, req: unknown) => cb(req)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  aiAgentEditorRes: (resp: { requestId: string; ok: boolean; result: string }) =>
    ipcRenderer.invoke('ai-agent-editor-res', resp),
  setAutoTrigger: (enabled: boolean) => ipcRenderer.invoke('set-auto-trigger', enabled),
  getAutoTrigger: () => ipcRenderer.invoke('get-auto-trigger'),
  onAutoTrigger: (cb: (info: { agent: string }) => void) => {
    const listener = (_e: unknown, info: { agent: string }) => cb(info)
    ipcRenderer.on('auto-trigger', listener)
    return () => ipcRenderer.removeListener('auto-trigger', listener)
  },

  // Group orchestration (v2)
  groupCreate: (input: { task_id: string; worker_role: string }) =>
    ipcRenderer.invoke('group-create', input),
  groupList: () => ipcRenderer.invoke('group-list'),
  groupKill: (groupId: string) => ipcRenderer.invoke('group-kill', groupId),
  groupMemory: (groupId: string) => ipcRenderer.invoke('group-memory', groupId),
  orchestrationGet: () => ipcRenderer.invoke('orchestration-get'),
  orchestrationSet: (patch: Record<string, unknown>) => ipcRenderer.invoke('orchestration-set', patch),

  // Discord bot config (token stored via setProviderKey with provider 'discord')
  discordConfigGet: () => ipcRenderer.invoke('discord-config-get'),
  discordConfigSet: (patch: Record<string, unknown>) => ipcRenderer.invoke('discord-config-set', patch),
  discordTokenStatus: () => ipcRenderer.invoke('discord-token-status'),
  onCoordinatorEvent: (cb: (info: { event: string; payload: unknown }) => void) => {
    const listener = (_e: unknown, info: { event: string; payload: unknown }) => cb(info)
    ipcRenderer.on('coordinator-event', listener)
    return () => ipcRenderer.removeListener('coordinator-event', listener)
  },

  // Window controls (custom title bar)
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximizeToggle: (): Promise<boolean> => ipcRenderer.invoke('window-maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('window-is-maximized'),
  onWindowMaximizedChanged: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window-maximized-changed', listener)
    return () => ipcRenderer.removeListener('window-maximized-changed', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
