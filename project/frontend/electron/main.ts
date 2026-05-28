import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const pty = require('node-pty') as typeof import('node-pty')

const TMUX_SESSION = 'multi-agent'

function tmuxNotifyPlanner(): void {
  // Best-effort: if tmux session "multi-agent" exists with a Planner pane,
  // send "check inbox\r" so the tmux-side Planner agent picks up the new
  // inbox message immediately. Silent failure if tmux not running.
  execFile('tmux', ['list-panes', '-t', TMUX_SESSION, '-F', '#{pane_id} #{pane_current_path}'], (err, stdout) => {
    if (err) return
    const line = stdout.split('\n').find((l) => l.includes('agents/planner'))
    if (!line) return
    const paneId = line.split(' ')[0]
    if (!paneId) return
    execFile('tmux', ['send-keys', '-t', paneId, 'check inbox', 'Enter'], () => {
      /* ignore */
    })
  })
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Project root: 3 levels up from dist-electron/main.js
// dist-electron is at project/frontend/dist-electron, root is /Users/tom/Downloads/multi-agent
const ROOT = path.resolve(__dirname, '..', '..', '..')
const SHARED = path.join(ROOT, 'shared')
// Base roles fixed at codebase level. Runtime set may include cloned instances
// like `backend-engineer-2` whose names are runtime-only. Read via getRoles().
const BASE_ROLES = [
  'planner',
  'orchestrator',
  'backend-engineer',
  'frontend-engineer',
  'ai-engineer',
  'be-reviewer',
  'fe-reviewer',
  'ai-reviewer',
] as const
type AgentName = string

// Snapshot of currently-configured agents from shared/agents-config.json. Falls
// back to BASE_ROLES if config is unreadable. Cheap enough to call per IPC.
async function getRoles(): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(SHARED, 'agents-config.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    if (cfg && typeof cfg.agents === 'object') return Object.keys(cfg.agents)
  } catch {
    /* fall through */
  }
  return BASE_ROLES.slice()
}
const PLANNER_DRAFT_PATH = path.join(ROOT, 'agents', 'planner', 'workspace', 'current-draft.md')
const SECRETS_PATH = path.join(SHARED, '.secrets.json')
const AGENT_RUNTIME = path.join(ROOT, 'scripts', 'agent_runtime.py')

type BackendKind = 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'api-anthropic' | 'api-google' | 'api-openai' | 'lm-studio'
type SecretProvider = 'anthropic' | 'google' | 'openai'
const SECRET_PROVIDERS: SecretProvider[] = ['anthropic', 'google', 'openai']

// Lazy-spawn policy: pre-warm orchestrator + planner; spawn the rest on demand.
const PRE_WARMED_AGENTS: readonly AgentName[] = ['orchestrator', 'planner'] as const
// Kill an idle PTY after this many ms of no activity (excluding pre-warmed agents).
const IDLE_KILL_MS = 15 * 60 * 1000
// How often the GC sweep runs.
const GC_INTERVAL_MS = 60 * 1000
// After a fresh spawn, wait this long before injecting "check inbox" so the CLI
// has time to load context (CLAUDE.md/AGENT.md) and reach an interactive prompt.
const CLI_WARMUP_MS = 5000

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#09090b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

// ── IPC handlers ───────────────────────────────────────────────

ipcMain.handle('get-tasks', async () => {
  try {
    const raw = await fs.readFile(path.join(SHARED, 'tasks.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { tasks: [], next_id: 1 }
  }
})

ipcMain.handle('get-inbox-summary', async () => {
  const result: { agent: string; count: number; preview: string }[] = []
  for (const agent of await getRoles()) {
    try {
      const file = path.join(SHARED, 'inbox', `${agent}.md`)
      const content = await fs.readFile(file, 'utf-8')
      const count = (content.match(/^---$/gm) || []).length
      const preview = content.slice(0, 400)
      result.push({ agent, count, preview })
    } catch {
      result.push({ agent, count: 0, preview: '' })
    }
  }
  return result
})

ipcMain.handle('get-inbox-content', async (_evt, agent: string) => {
  try {
    const file = path.join(SHARED, 'inbox', `${agent}.md`)
    return await fs.readFile(file, 'utf-8')
  } catch {
    return ''
  }
})

ipcMain.handle('get-logs', async () => {
  const result: { agent: string; lines: string[] }[] = []
  for (const agent of await getRoles()) {
    try {
      const file = path.join(SHARED, 'logs', `${agent}.log`)
      const content = await fs.readFile(file, 'utf-8')
      const lines = content.trim().split('\n').slice(-15).filter(Boolean)
      result.push({ agent, lines })
    } catch {
      result.push({ agent, lines: [] })
    }
  }
  return result
})

ipcMain.handle('get-root', () => ROOT)

// ── Write handlers ──────────────────────────────────────────

function nowStamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface CreateTaskInput {
  title: string
  description: string
  owner: string
  priority: 'low' | 'medium' | 'high'
  deps: string[]
  parent_id?: string | null
}

interface TaskRecord {
  id: string
  title: string
  owner: string
  status: string
  deps: string[]
  priority?: 'low' | 'medium' | 'high'
  created_at: string
  updated_at: string
  artifact?: string
  parent_id?: string | null
  children?: string[]
}

const HTN_MAX_DEPTH = 2

function validateParentForChild(tasks: TaskRecord[], parent_id: string): TaskRecord {
  const parent = tasks.find((t) => t.id === parent_id)
  if (!parent) throw new Error(`parent task ${parent_id} not found`)
  if (parent.parent_id) {
    throw new Error(
      `cannot create child of ${parent_id}: parent already has parent ${parent.parent_id} (depth cap = ${HTN_MAX_DEPTH})`
    )
  }
  return parent
}

function buildInboxBlock(ts: string, owner: string, id: string, title: string,
                         priority: string, deps: string[], description: string,
                         parent_id?: string | null): string {
  return [
    '',
    `## [${ts}] FROM: ui | TO: ${owner} | TASK: ${id}` + (parent_id ? `  (child of ${parent_id})` : ''),
    `**Subject:** ${title}`,
    `**Priority:** ${priority}`,
    `**Deps:** ${deps.length > 0 ? deps.join(', ') : 'none'}`,
    parent_id ? `**Parent:** ${parent_id}` : '',
    '',
    description || '(no description)',
    '',
    '---',
    '',
  ].filter((line) => line !== '').concat(['']).join('\n')
}

ipcMain.handle('create-task', async (_evt, input: CreateTaskInput) => {
  const tasksPath = path.join(SHARED, 'tasks.json')
  const raw = await fs.readFile(tasksPath, 'utf-8').catch(() => '{"tasks":[],"next_id":1}')
  const data: { tasks: TaskRecord[]; next_id: number } = JSON.parse(raw)

  // Depth=2 enforcement: child of a child is rejected
  if (input.parent_id) {
    validateParentForChild(data.tasks, input.parent_id)
  }

  const id = `T-${String(data.next_id).padStart(3, '0')}`
  const ts = nowStamp()
  const task: TaskRecord = {
    id,
    title: input.title,
    owner: input.owner,
    status: 'todo',
    deps: input.deps,
    priority: input.priority,
    created_at: ts,
    updated_at: ts,
    parent_id: input.parent_id ?? null,
    children: [],
  }
  data.tasks.push(task)
  data.next_id += 1

  // Wire child into parent.children
  if (input.parent_id) {
    const parent = data.tasks.find((t) => t.id === input.parent_id)!
    parent.children = [...(parent.children ?? []), id]
    parent.updated_at = ts
  }

  await fs.writeFile(tasksPath, JSON.stringify(data, null, 2) + '\n')

  const inboxPath = path.join(SHARED, 'inbox', `${input.owner}.md`)
  const block = buildInboxBlock(ts, input.owner, id, input.title,
    input.priority, input.deps, input.description, input.parent_id)
  await fs.appendFile(inboxPath, block)

  await fs.appendFile(
    path.join(SHARED, 'logs', 'orchestrator.log'),
    `[${ts}] ui created ${id} owner=${input.owner} priority=${input.priority}` +
    (input.parent_id ? ` parent=${input.parent_id}` : '') + '\n'
  )

  return { id, task }
})

interface SplitSubtask {
  title: string
  description: string
  owner: string
  priority?: 'low' | 'medium' | 'high'
  deps?: string[]
}

interface SplitTaskInput {
  parent_id: string
  subtasks: SplitSubtask[]
}

ipcMain.handle('split-task', async (_evt, input: SplitTaskInput) => {
  if (!input.subtasks || input.subtasks.length === 0) {
    throw new Error('split-task requires at least one subtask')
  }
  const tasksPath = path.join(SHARED, 'tasks.json')
  const raw = await fs.readFile(tasksPath, 'utf-8').catch(() => '{"tasks":[],"next_id":1}')
  const data: { tasks: TaskRecord[]; next_id: number } = JSON.parse(raw)
  const parent = validateParentForChild(data.tasks, input.parent_id)

  const ts = nowStamp()
  const created: TaskRecord[] = []
  for (const sub of input.subtasks) {
    const id = `T-${String(data.next_id).padStart(3, '0')}`
    data.next_id += 1
    const child: TaskRecord = {
      id,
      title: sub.title,
      owner: sub.owner,
      status: 'todo',
      deps: sub.deps ?? [],
      priority: sub.priority ?? 'medium',
      created_at: ts,
      updated_at: ts,
      parent_id: parent.id,
      children: [],
    }
    data.tasks.push(child)
    created.push(child)
  }

  parent.children = [...(parent.children ?? []), ...created.map((c) => c.id)]
  parent.status = 'waiting_children'
  parent.updated_at = ts

  await fs.writeFile(tasksPath, JSON.stringify(data, null, 2) + '\n')

  // Inbox + log per child
  for (const c of created) {
    const inboxPath = path.join(SHARED, 'inbox', `${c.owner}.md`)
    const desc = input.subtasks.find((s) => s.title === c.title)?.description ?? ''
    const block = buildInboxBlock(ts, c.owner, c.id, c.title,
      c.priority ?? 'medium', c.deps, desc, parent.id)
    await fs.appendFile(inboxPath, block)
  }
  await fs.appendFile(
    path.join(SHARED, 'logs', 'orchestrator.log'),
    `[${ts}] split ${parent.id} into ${created.map((c) => c.id).join(',')}\n`
  )

  return { ok: true, parent_id: parent.id, children: created }
})

interface SendMessageInput {
  to: string
  from: string
  taskId: string
  body: string
}

ipcMain.handle('send-message', async (_evt, input: SendMessageInput) => {
  const ts = nowStamp()
  const inboxPath = path.join(SHARED, 'inbox', `${input.to}.md`)
  const block = [
    '',
    `## [${ts}] FROM: ${input.from} | TO: ${input.to} | TASK: ${input.taskId || 'T-000'}`,
    '',
    input.body,
    '',
    '---',
    '',
  ].join('\n')
  await fs.appendFile(inboxPath, block)
  return { ok: true }
})

// ── Planner draft + approve ────────────────────────────────

function parseDraft(raw: string): { title: string; body: string } {
  const trimmed = raw.replace(/^\s+/, '')
  const m = trimmed.match(/^#\s+(.+?)\s*\n+([\s\S]*)$/)
  if (m) return { title: m[1].trim(), body: m[2].trim() }
  return { title: '', body: raw.trim() }
}

ipcMain.handle('get-draft-plan', async () => {
  try {
    const stat = await fs.stat(PLANNER_DRAFT_PATH)
    const raw = await fs.readFile(PLANNER_DRAFT_PATH, 'utf-8')
    if (!raw.trim()) return null
    const { title, body } = parseDraft(raw)
    return {
      title,
      body,
      updated_at: stat.mtime.toISOString(),
    }
  } catch {
    return null
  }
})

ipcMain.handle('send-to-planner', async (_evt, message: string) => {
  const text = (message || '').trim()
  if (!text) throw new Error('Empty message')
  const ts = nowStamp()
  const block = [
    '',
    `## [${ts}] FROM: ui | TO: planner | TASK: T-000`,
    `**Subject:** plan request from user`,
    '',
    text,
    '',
    '---',
    '',
  ].join('\n')
  const inboxPath = path.join(SHARED, 'inbox', 'planner.md')
  const cur = await fs.readFile(inboxPath, 'utf-8').catch(() => '')
  const tmp = inboxPath + '.tmp'
  await fs.writeFile(tmp, cur + block)
  await fs.rename(tmp, inboxPath)
  await fs.appendFile(
    path.join(SHARED, 'logs', 'planner.log'),
    `[${ts}] ui sent prompt to planner; len=${text.length}\n`
  ).catch(() => {})

  // Best-effort tmux notify (no-op when running Electron-only)
  tmuxNotifyPlanner()

  // Explicit user intent → always wake planner regardless of the auto-trigger
  // toggle. spawnAndPing is idempotent and handles cold-spawn warm-up.
  spawnAndPing('planner').catch((err) =>
    console.error('[send-to-planner] spawnAndPing(planner) failed:', err),
  )

  return { ok: true, ts }
})

interface ApprovePlanInput {
  title: string
  body: string
}

ipcMain.handle('approve-plan', async (_evt, input: ApprovePlanInput) => {
  const title = (input.title || '').trim()
  const body = (input.body || '').trim()
  if (!title) throw new Error('Title is required')
  if (!body) throw new Error('Body is required')

  const ts = nowStamp()
  const block = [
    '',
    `## [${ts}] FROM: planner | TO: orchestrator | TASK: T-000`,
    `**Subject:** ${title}`,
    `**Priority:** medium`,
    `**Deps:** none`,
    '',
    body,
    '',
    '---',
    '',
  ].join('\n')

  // Atomic-ish append: read, concat, write tmp, rename
  const inboxPath = path.join(SHARED, 'inbox', 'orchestrator.md')
  const cur = await fs.readFile(inboxPath, 'utf-8').catch(() => '')
  const tmp = inboxPath + '.tmp'
  await fs.writeFile(tmp, cur + block)
  await fs.rename(tmp, inboxPath)

  // Clear draft (write empty)
  await fs.writeFile(PLANNER_DRAFT_PATH, '').catch(async () => {
    // Ensure parent dir exists, then retry
    await fs.mkdir(path.dirname(PLANNER_DRAFT_PATH), { recursive: true })
    await fs.writeFile(PLANNER_DRAFT_PATH, '')
  })

  // Log
  await fs.appendFile(
    path.join(SHARED, 'logs', 'planner.log'),
    `[${ts}] planner approved-by-user → orchestrator inbox; subject="${title}"\n`
  ).catch(() => {})

  // Wake orchestrator immediately on user approval, independent of auto-trigger.
  spawnAndPing('orchestrator').catch((err) =>
    console.error('[approve-plan] spawnAndPing(orchestrator) failed:', err),
  )

  return { ok: true, ts }
})

ipcMain.handle('get-agents-config', async () => {
  const configPath = path.join(SHARED, 'agents-config.json')
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { agents: {}, available_models: [] }
  }
})

ipcMain.handle('update-agent-model', async (_evt, agent: string, provider: string, model: string) => {
  // Legacy handler — keeps root provider/model in sync with backend.model
  const configPath = path.join(SHARED, 'agents-config.json')
  const raw = await fs.readFile(configPath, 'utf-8')
  const config = JSON.parse(raw)
  const existing = config.agents[agent] ?? {}
  const backend = existing.backend ? { ...existing.backend, model } : { kind: 'claude-cli', model }
  config.agents[agent] = { ...existing, backend, provider, model }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
  return { ok: true }
})

// ── Backend settings (per-agent backend kind + per-provider keys) ────────

async function readConfig(): Promise<{ agents: Record<string, AgentEntry>, available_models: unknown[] }> {
  try {
    return JSON.parse(await fs.readFile(path.join(SHARED, 'agents-config.json'), 'utf-8'))
  } catch {
    return { agents: {}, available_models: [] }
  }
}

interface BackendBlock {
  kind: BackendKind
  base_url?: string
  model?: string
}
interface AgentEntry {
  backend?: BackendBlock
  provider?: string
  model?: string
}

async function writeConfig(config: { agents: Record<string, AgentEntry>; available_models: unknown[] }) {
  await fs.writeFile(path.join(SHARED, 'agents-config.json'), JSON.stringify(config, null, 2) + '\n')
}

async function readSecrets(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(SECRETS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

async function writeSecrets(obj: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(SECRETS_PATH), { recursive: true })
  await fs.writeFile(SECRETS_PATH, JSON.stringify(obj, null, 2) + '\n')
}

function decryptKey(b64: string): string {
  if (!b64) return ''
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return ''
  }
}

ipcMain.handle('get-backend-settings', async () => {
  const config = await readConfig()
  const secrets = await readSecrets()
  const keys = SECRET_PROVIDERS.reduce((acc, p) => {
    acc[p] = Boolean(secrets[p])
    return acc
  }, {} as Record<SecretProvider, boolean>)
  return {
    agents: config.agents,
    available_models: config.available_models,
    keys,
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
  }
})

ipcMain.handle('set-agent-backend', async (_evt, input: {
  agent: string
  kind: BackendKind
  model?: string
  base_url?: string
}) => {
  const { agent, kind, model, base_url } = input
  const config = await readConfig()
  const existing = config.agents[agent] ?? {}
  const backend: BackendBlock = { kind }
  if (base_url) backend.base_url = base_url
  if (model) backend.model = model
  // Mirror provider/model at the root for legacy consumers (InboxPanel etc).
  const provider = providerForBackend(kind)
  const next: AgentEntry = { ...existing, backend, provider }
  if (model) next.model = model
  config.agents[agent] = next
  await writeConfig(config)
  return { ok: true }
})

ipcMain.handle('set-provider-key', async (_evt, input: { provider: SecretProvider, apiKey: string }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'safeStorage encryption not available on this platform' }
  }
  const secrets = await readSecrets()
  if (!input.apiKey) {
    delete secrets[input.provider]
  } else {
    const encrypted = safeStorage.encryptString(input.apiKey)
    secrets[input.provider] = encrypted.toString('base64')
  }
  await writeSecrets(secrets)
  return { ok: true }
})

ipcMain.handle('clear-provider-key', async (_evt, provider: SecretProvider) => {
  const secrets = await readSecrets()
  delete secrets[provider]
  await writeSecrets(secrets)
  return { ok: true }
})

// Helpers for PTY dispatch
function providerForBackend(kind: BackendKind): string {
  switch (kind) {
    case 'claude-cli':
    case 'api-anthropic': return 'anthropic'
    case 'codex-cli':
    case 'api-openai':    return 'openai'
    case 'gemini-cli':
    case 'api-google':    return 'google'
    case 'lm-studio':     return 'local'
  }
}

function envVarForBackend(kind: BackendKind): string | null {
  switch (kind) {
    case 'api-anthropic': return 'ANTHROPIC_API_KEY'
    case 'api-google':    return 'GOOGLE_API_KEY'
    case 'api-openai':
    case 'lm-studio':     return 'OPENAI_API_KEY'
    default:              return null
  }
}

function resolveBin(name: string): string {
  const overrideKey = `${name.toUpperCase().replace(/-/g, '_')}_BIN`
  const override = process.env[overrideKey]
  if (override) return override
  if (process.platform !== 'win32') return name
  // Windows: try common extensions in PATH order. claude is .exe, npm shims are .cmd.
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
  const dirs = (process.env.PATH || '').split(path.delimiter)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase())
      if (fsSync.existsSync(candidate)) return candidate
    }
  }
  return name + '.cmd' // fallback
}

interface PtyCommand {
  cmd: string
  args: string[]
  envExtra: Record<string, string>
}

async function buildPtyCommand(agent: string): Promise<PtyCommand> {
  const config = await readConfig()
  const entry = config.agents[agent] ?? {}
  const backend = entry.backend ?? { kind: 'claude-cli' as BackendKind }
  const kind = backend.kind
  const model = backend.model ?? entry.model

  // Provide API key via env for runtimes that need it
  const envExtra: Record<string, string> = {}
  const envName = envVarForBackend(kind)
  if (envName) {
    const provider = providerForBackend(kind)
    if (provider !== 'local') {
      const secrets = await readSecrets()
      const decoded = decryptKey(secrets[provider] ?? '')
      if (decoded) envExtra[envName] = decoded
    } else {
      // LM Studio: SDK requires non-empty key, server doesn't validate by default
      envExtra[envName] = 'lm-studio'
    }
  }

  switch (kind) {
    case 'claude-cli':
      return {
        cmd: resolveBin('claude'),
        args: ['--dangerously-skip-permissions', ...(model ? ['--model', model] : [])],
        envExtra,
      }
    case 'codex-cli':
      return { cmd: resolveBin('codex'), args: model ? ['--model', model] : [], envExtra }
    case 'gemini-cli':
      return { cmd: resolveBin('gemini'), args: ['--yolo', ...(model ? ['--model', model] : [])], envExtra }
    case 'api-anthropic':
    case 'api-google':
    case 'api-openai':
    case 'lm-studio':
      return { cmd: resolveBin('python3'), args: [AGENT_RUNTIME, '--role', agent], envExtra }
  }
}

// ── PTY: spawn an agent backend per role ───────────────────

interface PtySession {
  proc: import('node-pty').IPty
  agent: string
  history: string           // recent output buffer for late-attaching renderers
  lastActivityAt: number    // millis; bumped on inbox event, proc.onData, pty-write
  spawnedAt: number         // millis; for warm-up gating + diagnostics
}

const ptySessions = new Map<string, PtySession>()
const HISTORY_MAX = 50_000  // keep last ~50KB per session

// In-flight spawn promises so two concurrent ensurePty() calls don't double-spawn.
const spawnLocks = new Map<string, Promise<PtySession>>()

async function ensurePty(agent: string): Promise<PtySession> {
  const existing = ptySessions.get(agent)
  if (existing) return existing
  const inflight = spawnLocks.get(agent)
  if (inflight) return inflight
  const p = doSpawn(agent)
  spawnLocks.set(agent, p)
  try {
    return await p
  } finally {
    spawnLocks.delete(agent)
  }
}

async function doSpawn(agent: string): Promise<PtySession> {
  const cwd = path.join(ROOT, 'agents', agent)

  // Make sure CLI-specific copies of AGENT.md exist before spawning the CLI
  syncAgentMdSafe(agent)

  const { cmd, args, envExtra } = await buildPtyCommand(agent)

  const proc = pty.spawn(
    cmd,
    args,
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, ...envExtra, TERM: 'xterm-256color' },
    }
  )

  const now = Date.now()
  const s: PtySession = {
    proc, agent, history: '',
    lastActivityAt: now,
    spawnedAt: now,
  }
  ptySessions.set(agent, s)

  proc.onData((data) => {
    s.history += data
    if (s.history.length > HISTORY_MAX) {
      s.history = s.history.slice(-HISTORY_MAX)
    }
    s.lastActivityAt = Date.now()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-data:${agent}`, data)
    }
  })

  proc.onExit(({ exitCode, signal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-exit:${agent}`, { exitCode, signal })
    }
    ptySessions.delete(agent)
  })

  return s
}

// Spawn-if-needed and inject "check inbox" once the CLI is past warm-up. Used
// by the inbox watcher when a new message arrives for an agent that may not be
// running yet.
async function spawnAndPing(agent: string): Promise<void> {
  const wasRunning = ptySessions.has(agent)
  const s = await ensurePty(agent)
  if (!wasRunning) {
    await new Promise((r) => setTimeout(r, CLI_WARMUP_MS))
  }
  s.proc.write('check inbox\r')
  s.lastActivityAt = Date.now()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auto-trigger', { agent })
  }
}

// Idle GC: kill agents that have been silent for too long.
function startIdleGc() {
  const preWarmed = new Set<string>(PRE_WARMED_AGENTS)
  setInterval(() => {
    const now = Date.now()
    for (const [agent, s] of ptySessions) {
      if (preWarmed.has(agent)) continue
      if (now - s.lastActivityAt > IDLE_KILL_MS) {
        try { s.proc.kill() } catch { /* ignore */ }
        ptySessions.delete(agent)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent-killed', { agent, reason: 'idle' })
        }
      }
    }
  }, GC_INTERVAL_MS)
}

// Copy agents/<role>/AGENT.md to CLAUDE.md / GEMINI.md / AGENTS.md so that whichever
// CLI we launch can auto-load its expected context filename. Silent on failure.
function syncAgentMdSafe(agent: string): void {
  try {
    const dir = path.join(ROOT, 'agents', agent)
    const src = path.join(dir, 'AGENT.md')
    if (!fsSync.existsSync(src)) return
    const buf = fsSync.readFileSync(src)
    for (const name of ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md']) {
      try { fsSync.writeFileSync(path.join(dir, name), buf) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

ipcMain.handle('pty-start', async (_evt, agent: string) => {
  const s = await ensurePty(agent)
  return { ok: true, history: s.history }
})

// pty-attach: read-only attach. Returns existing session's history without
// spawning. Renderer uses this when a tab is opened so just clicking around
// does not eagerly spawn an agent.
ipcMain.handle('pty-attach', (_evt, agent: string) => {
  const s = ptySessions.get(agent)
  if (!s) return { alive: false, history: '' }
  return { alive: true, history: s.history }
})

// ── Cost summary (parsed from shared/logs/*.log) ─────────────

interface CostBucket {
  usd: number
  tokens_in: number
  tokens_out: number
}
interface CostSummary {
  today: CostBucket
  by_agent: { agent: string; usd: number; tokens_in: number; tokens_out: number }[]
  by_task: { task_id: string; usd: number; tokens_in: number; tokens_out: number }[]
  by_hour_today: { hour: number; usd: number }[]
  date: string
  pricing_as_of: string
}

const COST_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})\]\s+(\S+)\s+usage\s+model=\S+\s+in=(\d+)\s+out=(\d+)\s+cost=\$([\d.]+)(?:\s+task=(\S+))?/

ipcMain.handle('get-cost-summary', async (): Promise<CostSummary> => {
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const summary: CostSummary = {
    today: { usd: 0, tokens_in: 0, tokens_out: 0 },
    by_agent: [],
    by_task: [],
    by_hour_today: Array.from({ length: 24 }, (_, h) => ({ hour: h, usd: 0 })),
    date: todayStr,
    pricing_as_of: '2026-05',
  }
  const byAgent = new Map<string, CostBucket>()
  const byTask = new Map<string, CostBucket>()
  const logsDir = path.join(SHARED, 'logs')
  let entries: string[] = []
  try {
    entries = (await fs.readdir(logsDir)).filter((f) => f.endsWith('.log'))
  } catch {
    return summary
  }
  for (const filename of entries) {
    let content: string
    try {
      content = await fs.readFile(path.join(logsDir, filename), 'utf-8')
    } catch {
      continue
    }
    // Tail the last 1MB only, in case logs grow large
    if (content.length > 1_000_000) content = content.slice(-1_000_000)
    for (const raw of content.split('\n')) {
      const m = COST_LINE_RE.exec(raw)
      if (!m) continue
      const [, date, hh, , agent, inS, outS, costS, taskId] = m
      if (date !== todayStr) continue
      const tIn = parseInt(inS, 10) || 0
      const tOut = parseInt(outS, 10) || 0
      const usd = parseFloat(costS) || 0
      summary.today.usd += usd
      summary.today.tokens_in += tIn
      summary.today.tokens_out += tOut
      const hour = parseInt(hh, 10) || 0
      summary.by_hour_today[hour].usd += usd
      const agentBucket = byAgent.get(agent) ?? { usd: 0, tokens_in: 0, tokens_out: 0 }
      agentBucket.usd += usd
      agentBucket.tokens_in += tIn
      agentBucket.tokens_out += tOut
      byAgent.set(agent, agentBucket)
      if (taskId) {
        const taskBucket = byTask.get(taskId) ?? { usd: 0, tokens_in: 0, tokens_out: 0 }
        taskBucket.usd += usd
        taskBucket.tokens_in += tIn
        taskBucket.tokens_out += tOut
        byTask.set(taskId, taskBucket)
      }
    }
  }
  summary.by_agent = Array.from(byAgent.entries())
    .map(([agent, b]) => ({ agent, ...b }))
    .sort((a, b) => b.usd - a.usd)
  summary.by_task = Array.from(byTask.entries())
    .map(([task_id, b]) => ({ task_id, ...b }))
    .sort((a, b) => b.usd - a.usd)
  return summary
})

// ── Task thread (inbox + outbox messages filtered by task ID) ──

interface TaskThreadEntry {
  ts: string
  from: string
  to: string
  task_id: string
  subject?: string
  body: string
  source: 'inbox' | 'outbox'
  source_file: string
}

const MSG_HEADER_RE = /^##\s*\[([^\]]+)\]\s+FROM:\s*(\S+)\s*\|\s*TO:\s*(\S+)\s*\|\s*TASK:\s*([^\s(]+)/

function parseMessageBlocks(content: string, source: 'inbox' | 'outbox', sourceFile: string, taskId: string): TaskThreadEntry[] {
  const out: TaskThreadEntry[] = []
  const blocks = content.split(/^---\s*$/m)
  for (const raw of blocks) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const lines = trimmed.split('\n')
    const headerIdx = lines.findIndex((l) => MSG_HEADER_RE.test(l))
    if (headerIdx === -1) continue
    const m = MSG_HEADER_RE.exec(lines[headerIdx])
    if (!m) continue
    const [, ts, from, to, blockTaskId] = m
    if (blockTaskId !== taskId) continue
    let subject: string | undefined
    const subjectLine = lines.slice(headerIdx + 1, headerIdx + 6).find((l) => /^\*\*Subject:\*\*/i.test(l))
    if (subjectLine) {
      subject = subjectLine.replace(/^\*\*Subject:\*\*\s*/i, '').trim()
    }
    // Body = everything after the metadata block (Subject/Priority/Deps lines)
    let bodyStart = headerIdx + 1
    while (bodyStart < lines.length && /^\*\*\w+:\*\*/.test(lines[bodyStart])) bodyStart++
    while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart++
    const body = lines.slice(bodyStart).join('\n').trim()
    out.push({ ts, from, to, task_id: blockTaskId, subject, body, source, source_file: sourceFile })
  }
  return out
}

ipcMain.handle('get-task-thread', async (_evt, taskId: string): Promise<TaskThreadEntry[]> => {
  const out: TaskThreadEntry[] = []
  for (const dir of ['inbox', 'outbox'] as const) {
    const dirPath = path.join(SHARED, dir)
    let entries: string[]
    try {
      entries = (await fs.readdir(dirPath)).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const filename of entries) {
      let content: string
      try {
        content = await fs.readFile(path.join(dirPath, filename), 'utf-8')
      } catch {
        continue
      }
      out.push(...parseMessageBlocks(content, dir, filename, taskId))
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return out
})

ipcMain.handle('pty-write', (_evt, agent: string, data: string) => {
  const s = ptySessions.get(agent)
  if (!s) return { ok: false, error: 'no session' }
  s.proc.write(data)
  s.lastActivityAt = Date.now()
  return { ok: true }
})

ipcMain.handle('pty-resize', (_evt, agent: string, cols: number, rows: number) => {
  const s = ptySessions.get(agent)
  if (!s) return { ok: false }
  try {
    s.proc.resize(cols, rows)
  } catch {
    /* ignore */
  }
  return { ok: true }
})

ipcMain.handle('pty-kill', (_evt, agent: string) => {
  const s = ptySessions.get(agent)
  if (!s) return { ok: false }
  s.proc.kill()
  ptySessions.delete(agent)
  return { ok: true }
})

ipcMain.handle('pty-status', () => {
  return Array.from(ptySessions.keys())
})

ipcMain.handle('pty-status-detail', () => {
  const preWarmed = new Set<string>(PRE_WARMED_AGENTS)
  const now = Date.now()
  return Array.from(ptySessions.entries()).map(([agent, s]) => ({
    agent,
    alive: true,
    idle_seconds: Math.floor((now - s.lastActivityAt) / 1000),
    spawned_at: s.spawnedAt,
    pre_warmed: preWarmed.has(agent),
  }))
})

app.on('before-quit', () => {
  for (const s of ptySessions.values()) {
    try {
      s.proc.kill()
    } catch {
      /* ignore */
    }
  }
})

// ── Inbox watcher: auto-prompt agent when new message arrives ─

interface InboxState {
  size: number
  sepCount: number
}
const inboxState = new Map<string, InboxState>()
const debounceTimers = new Map<string, NodeJS.Timeout>()
let autoTriggerEnabled = true

function readInboxState(agent: string): InboxState {
  try {
    const file = path.join(SHARED, 'inbox', `${agent}.md`)
    const content = fsSync.readFileSync(file, 'utf-8')
    const sepCount = (content.match(/^---$/gm) || []).length
    return { size: content.length, sepCount }
  } catch {
    return { size: 0, sepCount: 0 }
  }
}

async function watchInboxes() {
  const inboxDir = path.join(SHARED, 'inbox')

  // Initialize baseline state for each currently-configured agent. New clones
  // added later will simply have an implicit baseline of {size:0, sepCount:0}.
  for (const agent of await getRoles()) {
    inboxState.set(agent, readInboxState(agent))
  }

  fsSync.watch(inboxDir, (_event, filename) => {
    if (!filename || !filename.endsWith('.md')) return
    const agent = filename.replace('.md', '')
    // Permissive: accept any <agent>.md filename. Clones spawned by the
    // orchestrator add new files here that the static role list doesn't know about.

    // Debounce: file watcher fires multiple times for one write
    const existing = debounceTimers.get(agent)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      agent,
      setTimeout(() => {
        debounceTimers.delete(agent)
        const newState = readInboxState(agent)
        const prev = inboxState.get(agent) ?? { size: 0, sepCount: 0 }
        inboxState.set(agent, newState)

        // Only trigger when a NEW message was added (size + separator count both grew)
        const isNewMessage =
          newState.size > prev.size && newState.sepCount > prev.sepCount

        if (!isNewMessage || !autoTriggerEnabled) return

        // Lazy-spawn: ensures the PTY exists, waits for warm-up if newly spawned,
        // then injects "check inbox". Errors are swallowed so a missing CLI for one
        // agent does not break the watcher for others.
        spawnAndPing(agent).catch((err) => {
          console.error(`[inbox-watch] spawnAndPing(${agent}) failed:`, err)
        })
      }, 300)
    )
  })
}

ipcMain.handle('set-auto-trigger', (_evt, enabled: boolean) => {
  autoTriggerEnabled = enabled
  return { ok: true, enabled }
})

ipcMain.handle('get-auto-trigger', () => ({ enabled: autoTriggerEnabled }))

// ── Artifact handlers ───────────────────────────────────────────

ipcMain.handle('list-artifact-tasks', async () => {
  const dir = path.join(SHARED, 'artifacts')
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
})

ipcMain.handle('list-artifact-tree', async (_evt, taskId: string) => {
  const dir = path.join(SHARED, 'artifacts', taskId)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return []
  }
})

ipcMain.handle('read-artifact-file', async (_evt, taskId: string, filename: string) => {
  const artifactsDir = path.resolve(path.join(SHARED, 'artifacts'))
  const filePath = path.resolve(path.join(SHARED, 'artifacts', taskId, filename))
  if (!filePath.startsWith(artifactsDir + path.sep)) return { ok: false, content: '' }
  try {
    const realPath = await fs.realpath(filePath)
    if (!realPath.startsWith(artifactsDir + path.sep)) return { ok: false, content: '' }
    const content = await fs.readFile(realPath, 'utf-8')
    return { ok: true, content }
  } catch {
    return { ok: false, content: '' }
  }
})

// ── Workspace & Git IDE handlers ─────────────────────────────

async function scanDir(currentDir: string): Promise<any[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  const list: any[] = []
  for (const e of entries) {
    const name = e.name
    // Exclude noise and hidden folders (except .gitignore or similar files if needed, but skip dot-folders)
    if ((name.startsWith('.') && e.isDirectory()) || name === 'node_modules' || name === 'dist' || name === 'dist-electron' || name === 'outbox' || name === 'logs') {
      continue
    }
    const fullPath = path.join(currentDir, name)
    const relPath = path.relative(ROOT, fullPath)
    if (e.isDirectory()) {
      const children = await scanDir(fullPath)
      list.push({ name, relPath, isDir: true, children })
    } else {
      list.push({ name, relPath, isDir: false })
    }
  }
  // Sort folders first, then files alphabetically
  list.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return list
}

ipcMain.handle('workspace-list-files', async () => {
  try {
    return await scanDir(ROOT)
  } catch (err) {
    console.error('Failed to scan workspace:', err)
    return []
  }
})

ipcMain.handle('workspace-read-file', async (_evt, relPath: string) => {
  const absPath = path.resolve(ROOT, relPath)
  if (!absPath.startsWith(ROOT + path.sep) && absPath !== ROOT) {
    return { ok: false, content: 'Access denied: path is outside project root' }
  }
  try {
    const content = await fs.readFile(absPath, 'utf-8')
    return { ok: true, content }
  } catch (err: any) {
    return { ok: false, content: err.message }
  }
})

ipcMain.handle('workspace-write-file', async (_evt, relPath: string, content: string) => {
  const absPath = path.resolve(ROOT, relPath)
  if (!absPath.startsWith(ROOT + path.sep)) {
    return { ok: false, error: 'Access denied: path is outside project root' }
  }
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('workspace-git-status', async () => {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd: ROOT }, (err, stdout) => {
      if (err) {
        resolve([])
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean)
      const changes = lines.map((line) => {
        const type = line.slice(0, 2).trim() // e.g. 'M', 'A', '??', 'D'
        // Git might quote filenames with special chars
        const file = line.slice(3).trim().replace(/^"|"$/g, '')
        return { file, type }
      })
      resolve(changes)
    })
  })
})

ipcMain.handle('workspace-git-show-head', async (_evt, relPath: string) => {
  return new Promise((resolve) => {
    const gitPath = relPath.replace(/\\/g, '/')
    execFile('git', ['show', `HEAD:${gitPath}`], { cwd: ROOT }, (err, stdout) => {
      if (err) {
        // Return empty content if file is not in HEAD (new untracked file)
        resolve({ ok: true, content: '' })
      } else {
        resolve({ ok: true, content: stdout })
      }
    })
  })
})

// ── Task update ─────────────────────────────────────────────────


ipcMain.handle('update-task', async (_evt, id: string, changes: { deps?: string[]; priority?: 'low' | 'medium' | 'high' }) => {
  const tasksPath = path.join(SHARED, 'tasks.json')
  try {
    const raw = await fs.readFile(tasksPath, 'utf-8')
    const data = JSON.parse(raw)
    const task = data.tasks.find((t: { id: string }) => t.id === id)
    if (!task) return { ok: false }
    if (changes.deps !== undefined) task.deps = changes.deps
    if (changes.priority !== undefined) task.priority = changes.priority
    task.updated_at = nowStamp()
    await fs.writeFile(tasksPath, JSON.stringify(data, null, 2) + '\n')
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

// ── All logs (no line limit) ────────────────────────────────────

ipcMain.handle('get-all-logs', async () => {
  const result: { agent: string; lines: string[] }[] = []
  for (const agent of await getRoles()) {
    try {
      const file = path.join(SHARED, 'logs', `${agent}.log`)
      const content = await fs.readFile(file, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      result.push({ agent, lines })
    } catch {
      result.push({ agent, lines: [] })
    }
  }
  return result
})

// ── PTY restart ─────────────────────────────────────────────────

ipcMain.handle('pty-restart', async (_evt, agent: string) => {
  const s = ptySessions.get(agent)
  if (s) {
    try { s.proc.kill() } catch { /* ignore */ }
    ptySessions.delete(agent)
  }
  await new Promise((r) => setTimeout(r, 500))
  await ensurePty(agent)
  return { ok: true }
})

// ── Lifecycle ───────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow()
  // Ensure runtime directories exist (gitignored, may not be present on fresh checkout
  // or after scripts/reset.sh). Without these, fsSync.watch() in watchInboxes() throws
  // ENOENT and aborts the rest of this handler — meaning no pre-warm and no idle GC.
  for (const sub of ['inbox', 'outbox', 'logs', 'artifacts']) {
    try {
      await fs.mkdir(path.join(SHARED, sub), { recursive: true })
    } catch (err) {
      console.error(`Failed to mkdir shared/${sub}:`, err)
    }
  }
  try {
    await watchInboxes()
  } catch (err) {
    console.error('Failed to start inbox watcher:', err)
  }
  // Pre-warm only the entry-point agents (orchestrator + planner). The other 6
  // agents spawn on demand: when a message arrives in their inbox, or when the
  // user opens their Terminals tab. Idle agents are killed by startIdleGc().
  for (const agent of PRE_WARMED_AGENTS) {
    try {
      await ensurePty(agent)
    } catch (err) {
      console.error(`Failed to pre-warm ${agent}:`, err)
    }
  }
  startIdleGc()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
