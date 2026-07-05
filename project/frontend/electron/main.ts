import { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import * as db from './db'
import { streamInlineEdit, stripCodeFence, streamChat, InlineEditParams, ChatParams } from './ai-client'
import { GroupCoordinator, DEFAULT_ORCHESTRATION, OrchestrationConfig } from './group-coordinator'
import { runIdeAgent, IdeAgentParams, IdeAgentEvent, PendingChange, ReviewDecision } from './ide-agent'
const require = createRequire(import.meta.url)
// node-pty is a native module that must be rebuilt for Electron. If it failed
// to build (e.g. missing VS Build Tools on Windows), load it lazily so the app
// still boots — only agent-terminal spawning is disabled until it's available.
let pty: typeof import('node-pty') | null = null
try {
  pty = require('node-pty') as typeof import('node-pty')
} catch (err) {
  console.error('[node-pty] native module unavailable — agent terminals disabled:', err)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Project root: 3 levels up from dist-electron/main.js
// dist-electron is at project/frontend/dist-electron, root is /Users/tom/Downloads/multi-agent
const ROOT = path.resolve(__dirname, '..', '..', '..')
const SHARED = path.join(ROOT, 'shared')

// Initialize the SQLite source of truth (shared/state.db). All dynamic state
// (tasks, messages, usage, secrets) lives here; agents-config.json stays a file.
db.initDb(SHARED)

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
// The agent runtime is now a Node/TS entry built alongside the main process.
// It runs as a child process via Electron's own Node (ELECTRON_RUN_AS_NODE=1).
const AGENT_RUNTIME = path.join(__dirname, 'agent-runtime.js')

// Provider id is any string key under config.providers (e.g. 'vietapi',
// 'anthropic'). Secrets are keyed by provider id.
type SecretProvider = string

// Lazy-spawn policy: pre-warm orchestrator + planner; spawn the rest on demand.
const PRE_WARMED_AGENTS: readonly AgentName[] = ['orchestrator', 'planner'] as const
// Kill an idle PTY after this many ms of no activity (excluding pre-warmed agents).
const IDLE_KILL_MS = 15 * 60 * 1000
// How often the GC sweep runs.
const GC_INTERVAL_MS = 60 * 1000

let mainWindow: BrowserWindow | null = null

function createWindow() {
  // Remove the default application menu (File/Edit/View/Window/Help) entirely.
  Menu.setApplicationMenu(null)

  // Window/taskbar icon. In dev, __dirname is dist-electron; the build/ folder
  // sits next to it under project/frontend. Prefer .ico on Windows.
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const iconPath = path.join(__dirname, '..', 'build', iconName)
  const icon = fsSync.existsSync(iconPath) ? iconPath : undefined

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#09090b',
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximized-changed', false))

  // Toggle DevTools on demand (F12 / Ctrl+Shift+I) since it no longer auto-opens.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    const f12 = input.key === 'F12'
    const ctrlShiftI = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'
    if (f12 || ctrlShiftI) {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
    // DevTools stays closed by default — when open, Chromium paints a
    // viewport-size (px) overlay on every window resize. Set OPEN_DEVTOOLS=1
    // to enable it (or press F12 / Ctrl+Shift+I at runtime).
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

// ── IPC handlers ───────────────────────────────────────────────

// Window controls (custom title bar)
ipcMain.handle('window-minimize', () => {
  mainWindow?.minimize()
})
ipcMain.handle('window-maximize-toggle', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
    return false
  }
  mainWindow.maximize()
  return true
})
ipcMain.handle('window-close', () => {
  mainWindow?.close()
})
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false)

ipcMain.handle('get-tasks', async () => {
  return db.getTasks()
})

ipcMain.handle('get-inbox-summary', async () => {
  const result: { agent: string; count: number; preview: string }[] = []
  for (const agent of await getRoles()) {
    const msgs = db.getUnreadFor(agent)
    const preview = msgs.length > 0 ? msgs[0].body.slice(0, 400) : ''
    result.push({ agent, count: msgs.length, preview })
  }
  return result
})

ipcMain.handle('get-inbox-content', async (_evt, agent: string) => {
  // Render unread messages back into the legacy markdown shape so existing
  // renderer components keep working without changes.
  const msgs = db.getUnreadFor(agent)
  return msgs.map(messageToMarkdown).join('\n')
})

ipcMain.handle('get-logs', async () => {
  const result: { agent: string; lines: string[] }[] = []
  for (const agent of await getRoles()) {
    result.push({ agent, lines: db.recentLogs(agent, 15) })
  }
  return result
})

ipcMain.handle('get-root', () => ROOT)

// Render a DB message row back into the legacy markdown block shape, so that
// renderer components built around the old inbox format keep working unchanged.
function messageToMarkdown(m: db.MessageRow): string {
  const lines = [
    '',
    `## [${m.ts}] FROM: ${m.from_role} | TO: ${m.to_role} | TASK: ${m.task_id || 'T-000'}`,
  ]
  if (m.subject) lines.push(`**Subject:** ${m.subject}`)
  if (m.priority) lines.push(`**Priority:** ${m.priority}`)
  if (m.deps) lines.push(`**Deps:** ${m.deps}`)
  lines.push('', m.body, '', '---', '')
  return lines.join('\n')
}

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

const HTN_MAX_DEPTH = 2

function validateParentForChild(parent_id: string): db.TaskRow {
  const parent = db.getTask(parent_id)
  if (!parent) throw new Error(`parent task ${parent_id} not found`)
  if (parent.parent_id) {
    throw new Error(
      `cannot create child of ${parent_id}: parent already has parent ${parent.parent_id} (depth cap = ${HTN_MAX_DEPTH})`
    )
  }
  return parent
}

ipcMain.handle('create-task', async (_evt, input: CreateTaskInput) => {
  const ts = nowStamp()
  const result = db.transaction(() => {
    if (input.parent_id) validateParentForChild(input.parent_id)

    const nextId = db.getNextId()
    const id = `T-${String(nextId).padStart(3, '0')}`
    const task: db.TaskRow = {
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
    db.insertTask(task)
    db.setNextId(nextId + 1)

    // Wire child into parent.children
    if (input.parent_id) {
      const parent = db.getTask(input.parent_id)!
      db.updateTaskFields(input.parent_id, {
        children: [...(parent.children ?? []), id],
        updated_at: ts,
      })
    }

    // Message to the owner (replaces inbox markdown append)
    db.addMessage({
      ts,
      from_role: 'ui',
      to_role: input.owner,
      task_id: id,
      subject: input.title,
      priority: input.priority,
      deps: input.deps.length > 0 ? input.deps.join(', ') : 'none',
      body: input.description || '(no description)',
      status: 'unread',
    })

    db.addLog(
      'orchestrator',
      `ui created ${id} owner=${input.owner} priority=${input.priority}` +
        (input.parent_id ? ` parent=${input.parent_id}` : ''),
      ts
    )
    return { id, task }
  })
  return result
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
  const ts = nowStamp()
  return db.transaction(() => {
    const parent = validateParentForChild(input.parent_id)

    const created: db.TaskRow[] = []
    for (const sub of input.subtasks) {
      const nextId = db.getNextId()
      const id = `T-${String(nextId).padStart(3, '0')}`
      db.setNextId(nextId + 1)
      const child: db.TaskRow = {
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
      db.insertTask(child)
      created.push(child)
    }

    db.updateTaskFields(parent.id, {
      children: [...(parent.children ?? []), ...created.map((c) => c.id)],
      status: 'waiting_children',
      updated_at: ts,
    })

    for (const c of created) {
      const desc = input.subtasks.find((s) => s.title === c.title)?.description ?? ''
      db.addMessage({
        ts,
        from_role: 'ui',
        to_role: c.owner,
        task_id: c.id,
        subject: c.title,
        priority: c.priority ?? 'medium',
        deps: (c.deps ?? []).length > 0 ? c.deps!.join(', ') : 'none',
        body: desc || '(no description)',
        status: 'unread',
      })
    }
    db.addLog('orchestrator', `split ${parent.id} into ${created.map((c) => c.id).join(',')}`, ts)

    return { ok: true, parent_id: parent.id, children: created }
  })
})

interface SendMessageInput {
  to: string
  from: string
  taskId: string
  body: string
}

ipcMain.handle('send-message', async (_evt, input: SendMessageInput) => {
  const ts = nowStamp()
  db.addMessage({
    ts,
    from_role: input.from,
    to_role: input.to,
    task_id: input.taskId || null,
    body: input.body,
    status: 'unread',
  })
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
  db.addMessage({
    ts,
    from_role: 'ui',
    to_role: 'planner',
    task_id: null,
    subject: 'plan request from user',
    body: text,
    status: 'unread',
  })
  db.addLog('planner', `ui sent prompt to planner; len=${text.length}`, ts)

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
  db.addMessage({
    ts,
    from_role: 'planner',
    to_role: 'orchestrator',
    task_id: null,
    subject: title,
    priority: 'medium',
    deps: 'none',
    body,
    status: 'unread',
  })

  // Clear draft (write empty)
  await fs.writeFile(PLANNER_DRAFT_PATH, '').catch(async () => {
    // Ensure parent dir exists, then retry
    await fs.mkdir(path.dirname(PLANNER_DRAFT_PATH), { recursive: true })
    await fs.writeFile(PLANNER_DRAFT_PATH, '')
  })

  db.addLog('planner', `planner approved-by-user → orchestrator inbox; subject="${title}"`, ts)

  // Wake orchestrator immediately on user approval, independent of auto-trigger.
  spawnAndPing('orchestrator').catch((err) =>
    console.error('[approve-plan] spawnAndPing(orchestrator) failed:', err),
  )

  return { ok: true, ts }
})

ipcMain.handle('get-agents-config', async () => {
  const config = await readConfig()
  // Synthesize available_models from the dynamic providers map so existing
  // renderer code (model pickers) keeps working.
  return { ...config, available_models: deriveAvailableModels(config) }
})

ipcMain.handle('update-agent-model', async (_evt, agent: string, provider: string, model: string) => {
  const config = await readConfig()
  const existing = config.agents[agent] ?? {}
  config.agents[agent] = { ...existing, backend: { mode: 'api' }, provider, model }
  await writeConfig(config)
  return { ok: true }
})

// ── Backend settings (per-agent provider/model + per-provider keys) ──────

interface ProviderBlock {
  kind: string
  name?: string
  base_url?: string
  models?: string[]
  price_in?: number
  price_out?: number
}
interface AgentEntry {
  backend?: { mode?: string }
  provider?: string
  model?: string
}
interface FullConfig {
  providers?: Record<string, ProviderBlock>
  agents: Record<string, AgentEntry>
  available_models?: unknown[]
  orchestration?: Partial<OrchestrationConfig>
}

// Build the flat model list the renderer expects from the providers map.
function deriveAvailableModels(config: FullConfig): { provider: string; id: string; label: string; tier: string }[] {
  const out: { provider: string; id: string; label: string; tier: string }[] = []
  for (const [pid, p] of Object.entries(config.providers ?? {})) {
    for (const m of p.models ?? []) {
      out.push({ provider: pid, id: m, label: m, tier: p.name ?? pid })
    }
  }
  return out
}

async function readConfig(): Promise<FullConfig> {
  try {
    return JSON.parse(await fs.readFile(path.join(SHARED, 'agents-config.json'), 'utf-8'))
  } catch {
    return { agents: {}, providers: {} }
  }
}

async function writeConfig(config: FullConfig) {
  await fs.writeFile(path.join(SHARED, 'agents-config.json'), JSON.stringify(config, null, 2) + '\n')
}

async function readSecrets(): Promise<Record<string, string>> {
  // Secrets live in the DB (secrets table), keyed by provider id.
  const out: Record<string, string> = {}
  for (const p of db.listSecretProviders()) {
    const v = db.getSecret(p)
    if (v) out[p] = v
  }
  return out
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
  // One boolean per provider id: does an API key exist?
  const keys: Record<string, boolean> = {}
  for (const pid of Object.keys(config.providers ?? {})) {
    keys[pid] = Boolean(secrets[pid])
  }
  return {
    agents: config.agents,
    providers: config.providers ?? {},
    available_models: deriveAvailableModels(config),
    keys,
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
  }
})

// Set an agent's provider + model (API-only). base_url lives on the provider,
// not the agent, so it's not accepted here anymore.
ipcMain.handle('set-agent-backend', async (_evt, input: {
  agent: string
  provider: string
  model?: string
}) => {
  const { agent, provider, model } = input
  const config = await readConfig()
  const existing = config.agents[agent] ?? {}
  const next: AgentEntry = { ...existing, backend: { mode: 'api' }, provider }
  if (model) next.model = model
  config.agents[agent] = next
  await writeConfig(config)
  return { ok: true }
})

// Add or update a provider definition (custom OpenAI-compatible gateways, etc).
ipcMain.handle('set-provider', async (_evt, input: {
  id: string
  kind: string
  name?: string
  base_url?: string
  models?: string[]
}) => {
  const { id, kind, name, base_url, models } = input
  if (!id) return { ok: false, error: 'provider id required' }
  const config = await readConfig()
  config.providers = config.providers ?? {}
  const existing = config.providers[id] ?? { kind }
  config.providers[id] = {
    ...existing,
    kind,
    name: name ?? existing.name,
    base_url: base_url ?? existing.base_url,
    models: models ?? existing.models ?? [],
  }
  await writeConfig(config)
  return { ok: true }
})

ipcMain.handle('delete-provider', async (_evt, id: string) => {
  const config = await readConfig()
  if (config.providers) delete config.providers[id]
  await writeConfig(config)
  db.deleteSecret(id)
  return { ok: true }
})

ipcMain.handle('set-provider-key', async (_evt, input: { provider: SecretProvider, apiKey: string }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'safeStorage encryption not available on this platform' }
  }
  if (!input.apiKey) {
    db.deleteSecret(input.provider)
  } else {
    const encrypted = safeStorage.encryptString(input.apiKey)
    db.setSecret(input.provider, encrypted.toString('base64'))
  }
  return { ok: true }
})

ipcMain.handle('clear-provider-key', async (_evt, provider: SecretProvider) => {
  db.deleteSecret(provider)
  return { ok: true }
})

// ── PTY dispatch (API-only) ─────────────────────────────────
// CLI-REVIVE: CLI backends (claude/codex/gemini) were removed for the API-only
// phase. To bring them back, restore the kind-based branch in buildPtyCommand,
// the providerForBackend/envVarForBackend helpers, and resolveBin('claude'|...).
// See REDESIGN_PLAN.md "CLI removal — hồi sinh tương lai".

interface ProviderCfg {
  kind: string
  name?: string
  base_url?: string
  models?: string[]
  price_in?: number
  price_out?: number
}

// Env var name the agent runtime expects for a given provider id.
//   'vietapi'   -> MULTIAGENT_KEY_VIETAPI
//   'lm-studio' -> MULTIAGENT_KEY_LM_STUDIO
function keyEnvName(providerId: string): string {
  return 'MULTIAGENT_KEY_' + providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
}

function resolveBin(name: string): string {
  const overrideKey = `${name.toUpperCase().replace(/-/g, '_')}_BIN`
  const override = process.env[overrideKey]
  if (override) return override
  if (process.platform !== 'win32') return name
  // Windows: try common extensions in PATH order.
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
  const dirs = (process.env.PATH || '').split(path.delimiter)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase())
      if (fsSync.existsSync(candidate)) return candidate
    }
  }
  return name
}

interface PtyCommand {
  cmd: string
  args: string[]
  envExtra: Record<string, string>
}

async function buildPtyCommand(agent: string): Promise<PtyCommand> {
  const config = await readConfig()
  const entry = config.agents[agent] ?? {}
  const providers: Record<string, ProviderCfg> =
    (config as { providers?: Record<string, ProviderCfg> }).providers ?? {}
  const providerId = (entry as { provider?: string }).provider ?? ''
  const providerCfg = providers[providerId]

  // Inject the decrypted API key for this provider as MULTIAGENT_KEY_<PROVIDER>.
  const envExtra: Record<string, string> = {}
  if (providerId) {
    const enc = db.getSecret(providerId)
    const decoded = enc ? decryptKey(enc) : ''
    if (decoded) {
      envExtra[keyEnvName(providerId)] = decoded
    } else if (providerCfg?.kind === 'openai-compatible' && providerCfg.base_url?.includes('localhost')) {
      // Local server (LM Studio): SDK needs a non-empty key, server ignores it.
      envExtra[keyEnvName(providerId)] = 'no-key'
    }
  }

  return {
    cmd: process.execPath,
    args: [AGENT_RUNTIME, '--role', agent],
    envExtra: { ...envExtra, ELECTRON_RUN_AS_NODE: '1' },
  }
}

// ── Group coordinator (v2 orchestration) ─────────────────────────
// Reuses the same decrypted-key env logic as buildPtyCommand, but the
// coordinator spawns headless one-shot group agents instead of PTY sessions.

async function envForRole(role: string): Promise<Record<string, string>> {
  const config = await readConfig()
  const entry = config.agents[role] ?? {}
  const providers: Record<string, ProviderCfg> =
    (config as { providers?: Record<string, ProviderCfg> }).providers ?? {}
  const providerId = (entry as { provider?: string }).provider ?? ''
  const providerCfg = providers[providerId]
  const env: Record<string, string> = {}
  if (providerId) {
    const enc = db.getSecret(providerId)
    const decoded = enc ? decryptKey(enc) : ''
    if (decoded) {
      env[keyEnvName(providerId)] = decoded
    } else if (providerCfg?.kind === 'openai-compatible' && providerCfg.base_url?.includes('localhost')) {
      env[keyEnvName(providerId)] = 'no-key'
    }
  }
  return env
}

async function readOrchestration(): Promise<OrchestrationConfig> {
  const config = await readConfig()
  return { ...DEFAULT_ORCHESTRATION, ...(config.orchestration ?? {}) }
}

async function modelForRole(role: string): Promise<string | null> {
  const config = await readConfig()
  return config.agents[role]?.model ?? null
}

const coordinator = new GroupCoordinator({
  runtimePath: AGENT_RUNTIME,
  execPath: process.execPath,
  agentsDir: path.join(ROOT, 'agents'),
  envForRole,
  readOrchestration,
  modelForRole,
  notify: (event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('coordinator-event', { event, payload })
    }
  },
})

// IPC: create a group for an existing task (UI / orchestrator-triggered).
ipcMain.handle('group-create', async (_evt, input: { task_id: string; worker_role: string }) => {
  try {
    const id = await coordinator.createGroupForTask(input.task_id, input.worker_role)
    return { ok: true, group: id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

// IPC: list groups (optionally by status) for the group panel (GĐ4).
ipcMain.handle('group-list', () => {
  const rows = db.getGroupsByStatus('pending', 'active', 'reviewing', 'passed', 'failed', 'killed')
  return { ok: true, groups: rows }
})

// IPC: read orchestration settings.
ipcMain.handle('orchestration-get', async () => {
  return await readOrchestration()
})

// IPC: update orchestration settings (merged into agents-config.json).
ipcMain.handle('orchestration-set', async (_evt, patch: Partial<OrchestrationConfig>) => {
  const config = await readConfig()
  const current = { ...DEFAULT_ORCHESTRATION, ...(config.orchestration ?? {}) }
  config.orchestration = { ...current, ...patch }
  await writeConfig(config)
  return { ok: true, orchestration: config.orchestration }
})

// IPC: manually kill a group (GĐ4 panel action).
ipcMain.handle('group-kill', (_evt, groupId: string) => {
  coordinator.killGroupManual(groupId, 'killed by user')
  return { ok: true }
})

// IPC: read a group's memory timeline (progress notes / review reports).
ipcMain.handle('group-memory', (_evt, groupId: string) => {
  return { ok: true, memory: db.allGroupMemory(groupId) }
})

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

  if (!pty) {
    throw new Error('node-pty unavailable — cannot spawn agent runtime. Rebuild node-pty for Electron.')
  }

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

// Ensure the agent's runtime process is running. The runtime polls the
// DB for unread messages on its own, so we no longer inject "check inbox" — we
// just make sure the process exists. The auto-trigger event is kept so the UI
// can flash which agent woke up.
async function spawnAndPing(agent: string): Promise<void> {
  await ensurePty(agent)
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

// ── Cost summary (aggregated from the usage table) ───────────

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
  for (const u of db.usageForDay(todayStr)) {
    const tIn = u.tokens_in || 0
    const tOut = u.tokens_out || 0
    const usd = u.cost_usd || 0
    summary.today.usd += usd
    summary.today.tokens_in += tIn
    summary.today.tokens_out += tOut
    // ts shape: "YYYY-MM-DD HH:MM"
    const hour = parseInt(u.ts.slice(11, 13), 10) || 0
    if (summary.by_hour_today[hour]) summary.by_hour_today[hour].usd += usd
    const agentBucket = byAgent.get(u.role) ?? { usd: 0, tokens_in: 0, tokens_out: 0 }
    agentBucket.usd += usd
    agentBucket.tokens_in += tIn
    agentBucket.tokens_out += tOut
    byAgent.set(u.role, agentBucket)
    if (u.task_id) {
      const taskBucket = byTask.get(u.task_id) ?? { usd: 0, tokens_in: 0, tokens_out: 0 }
      taskBucket.usd += usd
      taskBucket.tokens_in += tIn
      taskBucket.tokens_out += tOut
      byTask.set(u.task_id, taskBucket)
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

// ── Task thread (messages filtered by task ID) ──

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

ipcMain.handle('get-task-thread', async (_evt, taskId: string): Promise<TaskThreadEntry[]> => {
  // unread → inbox, processed → outbox, preserving the renderer's source labels.
  const out: TaskThreadEntry[] = db.getThread(taskId).map((m) => ({
    ts: m.ts,
    from: m.from_role,
    to: m.to_role,
    task_id: m.task_id ?? taskId,
    subject: m.subject ?? undefined,
    body: m.body,
    source: (m.status === 'processed' ? 'outbox' : 'inbox') as 'inbox' | 'outbox',
    source_file: `${m.to_role}.md`,
  }))
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
  for (const s of shellSessions.values()) {
    try { s.proc.kill() } catch { /* ignore */ }
  }
})

// ── Real shell terminals (for the user: npm/git/python) ──────
// Separate from agent PTYs. Keyed by an arbitrary shell id from the renderer.
// Spawns the platform shell in the current workspace root.

interface ShellSession {
  proc: import('node-pty').IPty
  history: string
}
const shellSessions = new Map<string, ShellSession>()

function shellCommand(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    // Prefer PowerShell 7 if present, else Windows PowerShell.
    const pwsh = resolveBin('pwsh')
    return { cmd: pwsh, args: [] }
  }
  return { cmd: process.env.SHELL || '/bin/bash', args: [] }
}

ipcMain.handle('shell-start', (_evt, id: string) => {
  if (!pty) return { ok: false, error: 'node-pty unavailable' }
  let s = shellSessions.get(id)
  if (!s) {
    const { cmd, args } = shellCommand()
    const proc = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 24,
      cwd: workspaceRoot,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
    s = { proc, history: '' }
    shellSessions.set(id, s)
    proc.onData((data) => {
      s!.history += data
      if (s!.history.length > HISTORY_MAX) s!.history = s!.history.slice(-HISTORY_MAX)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`shell-data:${id}`, data)
      }
    })
    proc.onExit(({ exitCode }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`shell-exit:${id}`, { exitCode })
      }
      shellSessions.delete(id)
    })
  }
  return { ok: true, history: s.history }
})

ipcMain.handle('shell-write', (_evt, id: string, data: string) => {
  const s = shellSessions.get(id)
  if (!s) return { ok: false }
  s.proc.write(data)
  return { ok: true }
})

ipcMain.handle('shell-resize', (_evt, id: string, cols: number, rows: number) => {
  const s = shellSessions.get(id)
  if (!s) return { ok: false }
  try { s.proc.resize(cols, rows) } catch { /* ignore */ }
  return { ok: true }
})

ipcMain.handle('shell-kill', (_evt, id: string) => {
  const s = shellSessions.get(id)
  if (s) { try { s.proc.kill() } catch { /* ignore */ } shellSessions.delete(id) }
  return { ok: true }
})

// ── Inbox watcher: auto-prompt agent when new message arrives ─
//
// API-only: messages live in the DB, not markdown files. We poll unread counts
// per agent; when an agent's unread count grows, lazily spawn its runtime and
// ping it. This replaces the old fsSync.watch on shared/inbox/*.md.

const unreadBaseline = new Map<string, number>()
let autoTriggerEnabled = true
const INBOX_POLL_MS = 1500

async function watchInboxes() {
  // Seed baselines for currently-configured agents so we only react to growth.
  for (const agent of await getRoles()) {
    unreadBaseline.set(agent, db.unreadCount(agent))
  }

  setInterval(async () => {
    if (!autoTriggerEnabled) return
    let roles: string[]
    try {
      roles = await getRoles()
    } catch {
      return
    }
    // Include any role that already has unread messages even if not in config
    // (e.g. clones), via the DB's recipient list.
    const allRoles = new Set<string>([...roles, ...db.distinctRecipients()])
    for (const agent of allRoles) {
      const count = db.unreadCount(agent)
      const prev = unreadBaseline.get(agent) ?? 0
      unreadBaseline.set(agent, count)
      if (count > prev) {
        spawnAndPing(agent).catch((err) => {
          console.error(`[inbox-watch] spawnAndPing(${agent}) failed:`, err)
        })
      }
    }
  }, INBOX_POLL_MS)
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

// The workspace root is dynamic: defaults to the project ROOT, but the user can
// open any folder. Persisted in the DB (meta.workspace_root) + a recent list.
let workspaceRoot: string = ROOT
try {
  const saved = db.getMeta('workspace_root')
  if (saved && fsSync.existsSync(saved)) workspaceRoot = saved
} catch { /* use ROOT */ }

function getRecentWorkspaces(): string[] {
  try {
    const raw = db.getMeta('recent_workspaces')
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function pushRecentWorkspace(dir: string): void {
  const recent = getRecentWorkspaces().filter((d) => d !== dir)
  recent.unshift(dir)
  db.setMeta('recent_workspaces', JSON.stringify(recent.slice(0, 10)))
}

function setWorkspaceRoot(dir: string): void {
  workspaceRoot = dir
  db.setMeta('workspace_root', dir)
  pushRecentWorkspace(dir)
}

// Resolve a workspace-relative path to an absolute path, guarding against
// escaping the workspace root.
function resolveInWorkspace(relPath: string): string | null {
  const abs = path.resolve(workspaceRoot, relPath)
  if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + path.sep)) return null
  return abs
}

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.git', 'venv', '.venv', '__pycache__', '.vite'])

async function scanDir(currentDir: string): Promise<any[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  const list: any[] = []
  for (const e of entries) {
    const name = e.name
    if (IGNORED_DIRS.has(name)) continue
    const fullPath = path.join(currentDir, name)
    const relPath = path.relative(workspaceRoot, fullPath)
    if (e.isDirectory()) {
      const children = await scanDir(fullPath)
      list.push({ name, relPath, isDir: true, children })
    } else {
      list.push({ name, relPath, isDir: false })
    }
  }
  list.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return list
}

ipcMain.handle('workspace-get-root', () => ({
  root: workspaceRoot,
  name: path.basename(workspaceRoot),
  recent: getRecentWorkspaces(),
}))

ipcMain.handle('workspace-open-dialog', async () => {
  if (!mainWindow) return { ok: false }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder as Workspace',
    properties: ['openDirectory'],
    defaultPath: workspaceRoot,
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: false }
  setWorkspaceRoot(result.filePaths[0])
  return { ok: true, root: workspaceRoot, name: path.basename(workspaceRoot) }
})

ipcMain.handle('workspace-set-root', async (_evt, dir: string) => {
  if (!fsSync.existsSync(dir)) return { ok: false, error: 'folder not found' }
  setWorkspaceRoot(dir)
  return { ok: true, root: workspaceRoot, name: path.basename(workspaceRoot) }
})

ipcMain.handle('workspace-list-files', async () => {
  try {
    return await scanDir(workspaceRoot)
  } catch (err) {
    console.error('Failed to scan workspace:', err)
    return []
  }
})

ipcMain.handle('workspace-read-file', async (_evt, relPath: string) => {
  const absPath = resolveInWorkspace(relPath)
  if (!absPath) return { ok: false, content: 'Access denied: path is outside workspace root' }
  try {
    const content = await fs.readFile(absPath, 'utf-8')
    return { ok: true, content }
  } catch (err: any) {
    return { ok: false, content: err.message }
  }
})

ipcMain.handle('workspace-write-file', async (_evt, relPath: string, content: string) => {
  const absPath = resolveInWorkspace(relPath)
  if (!absPath) return { ok: false, error: 'Access denied: path is outside workspace root' }
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

// ── File operations (create / rename / delete / mkdir) ───────

ipcMain.handle('workspace-create-file', async (_evt, relPath: string) => {
  const absPath = resolveInWorkspace(relPath)
  if (!absPath) return { ok: false, error: 'path outside workspace' }
  try {
    if (fsSync.existsSync(absPath)) return { ok: false, error: 'file already exists' }
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, '', 'utf-8')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('workspace-create-folder', async (_evt, relPath: string) => {
  const absPath = resolveInWorkspace(relPath)
  if (!absPath) return { ok: false, error: 'path outside workspace' }
  try {
    await fs.mkdir(absPath, { recursive: true })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('workspace-rename', async (_evt, fromRel: string, toRel: string) => {
  const from = resolveInWorkspace(fromRel)
  const to = resolveInWorkspace(toRel)
  if (!from || !to) return { ok: false, error: 'path outside workspace' }
  try {
    if (fsSync.existsSync(to)) return { ok: false, error: 'target already exists' }
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('workspace-delete', async (_evt, relPath: string) => {
  const absPath = resolveInWorkspace(relPath)
  if (!absPath || absPath === workspaceRoot) return { ok: false, error: 'invalid path' }
  try {
    await fs.rm(absPath, { recursive: true, force: true })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

// ── Project-wide search (ripgrep with a JS fallback) ─────────

interface SearchMatch { file: string; line: number; column: number; text: string }

ipcMain.handle('workspace-search', async (_evt, query: string, opts?: { caseSensitive?: boolean; regex?: boolean; maxResults?: number }) => {
  const max = opts?.maxResults ?? 500
  if (!query) return { ok: true, matches: [] as SearchMatch[] }
  return await new Promise((resolve) => {
    const args = ['--no-heading', '--line-number', '--column', '--color', 'never']
    if (!opts?.caseSensitive) args.push('-i')
    if (!opts?.regex) args.push('--fixed-strings')
    args.push('--max-count', '50', query, '.')
    execFile('rg', args, { cwd: workspaceRoot, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      // rg exits 1 when no matches — not an error for us.
      if (err && (err as any).code !== 1 && !stdout) {
        // Fallback: no ripgrep. Return a hint; JS fallback is expensive, skip for now.
        resolve({ ok: false, error: 'ripgrep (rg) not found', matches: [] })
        return
      }
      const matches: SearchMatch[] = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        // format: relpath:line:col:text
        const m = line.match(/^(.*?):(\d+):(\d+):(.*)$/)
        if (!m) continue
        matches.push({
          file: m[1].replace(/\\/g, '/'),
          line: parseInt(m[2], 10),
          column: parseInt(m[3], 10),
          text: m[4].slice(0, 400),
        })
        if (matches.length >= max) break
      }
      resolve({ ok: true, matches })
    })
  })
})

// Replace all occurrences of `find` with `replace` in a single file.
ipcMain.handle('workspace-replace-in-file', async (_evt, relPath: string, find: string, replace: string, opts?: { regex?: boolean; caseSensitive?: boolean }) => {
  const absPath = resolveInWorkspace(relPath)
  if (!absPath) return { ok: false, error: 'path outside workspace' }
  try {
    const content = await fs.readFile(absPath, 'utf-8')
    let next: string
    if (opts?.regex) {
      const re = new RegExp(find, opts.caseSensitive ? 'g' : 'gi')
      next = content.replace(re, replace)
    } else if (opts?.caseSensitive) {
      next = content.split(find).join(replace)
    } else {
      const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      next = content.replace(re, replace)
    }
    await fs.writeFile(absPath, next, 'utf-8')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

// ── Git (status + diff base + stage/commit/branch/push/pull) ──

function gitExec(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: workspaceRoot, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

ipcMain.handle('workspace-git-status', async () => {
  const { ok, stdout } = await gitExec(['status', '--porcelain'])
  if (!ok) return []
  const lines = stdout.trim().split('\n').filter(Boolean)
  return lines.map((line) => {
    const type = line.slice(0, 2).trim()
    const file = line.slice(3).trim().replace(/^"|"$/g, '')
    return { file, type, staged: line[0] !== ' ' && line[0] !== '?' }
  })
})

ipcMain.handle('workspace-git-show-head', async (_evt, relPath: string) => {
  const gitPath = relPath.replace(/\\/g, '/')
  const { ok, stdout } = await gitExec(['show', `HEAD:${gitPath}`])
  return { ok: true, content: ok ? stdout : '' }
})

ipcMain.handle('workspace-git-branch', async () => {
  const cur = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'])
  const all = await gitExec(['branch', '--format=%(refname:short)'])
  return {
    current: cur.ok ? cur.stdout.trim() : '',
    branches: all.ok ? all.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [],
  }
})

ipcMain.handle('workspace-git-stage', async (_evt, file: string) => {
  const { ok, stderr } = await gitExec(['add', '--', file])
  return { ok, error: ok ? undefined : stderr }
})

ipcMain.handle('workspace-git-unstage', async (_evt, file: string) => {
  const { ok, stderr } = await gitExec(['restore', '--staged', '--', file])
  return { ok, error: ok ? undefined : stderr }
})

ipcMain.handle('workspace-git-stage-all', async () => {
  const { ok, stderr } = await gitExec(['add', '-A'])
  return { ok, error: ok ? undefined : stderr }
})

ipcMain.handle('workspace-git-commit', async (_evt, message: string) => {
  if (!message?.trim()) return { ok: false, error: 'commit message required' }
  const { ok, stdout, stderr } = await gitExec(['commit', '-m', message])
  return { ok, output: stdout, error: ok ? undefined : (stderr || stdout) }
})

ipcMain.handle('workspace-git-checkout', async (_evt, branch: string, create?: boolean) => {
  const args = create ? ['checkout', '-b', branch] : ['checkout', branch]
  const { ok, stderr } = await gitExec(args)
  return { ok, error: ok ? undefined : stderr }
})

ipcMain.handle('workspace-git-push', async () => {
  const { ok, stdout, stderr } = await gitExec(['push'])
  return { ok, output: stdout + stderr }
})

ipcMain.handle('workspace-git-pull', async () => {
  const { ok, stdout, stderr } = await gitExec(['pull'])
  return { ok, output: stdout + stderr }
})

// ── Task update ─────────────────────────────────────────────────


ipcMain.handle('update-task', async (_evt, id: string, changes: { deps?: string[]; priority?: 'low' | 'medium' | 'high' }) => {
  const task = db.getTask(id)
  if (!task) return { ok: false }
  db.updateTaskFields(id, {
    deps: changes.deps !== undefined ? changes.deps : undefined,
    priority: changes.priority !== undefined ? changes.priority : undefined,
    updated_at: nowStamp(),
  })
  return { ok: true }
})

// ── All logs (no line limit) ────────────────────────────────────

ipcMain.handle('get-all-logs', async () => {
  const result: { agent: string; lines: string[] }[] = []
  for (const agent of await getRoles()) {
    result.push({ agent, lines: db.allLogs(agent) })
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

// ── Inline AI edit (streaming) ───────────────────────────────
// Renderer calls 'ai-inline-edit' with a requestId; deltas stream back on
// 'ai-inline-chunk:<requestId>' and the final/err arrives on
// 'ai-inline-done:<requestId>'. 'ai-inline-cancel' aborts an in-flight request.

const inlineEditAborts = new Map<string, AbortController>()

ipcMain.handle('ai-inline-edit', async (_evt, requestId: string, params: InlineEditParams) => {
  const ac = new AbortController()
  inlineEditAborts.set(requestId, ac)
  const send = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload)
    }
  }
  try {
    const full = await streamInlineEdit(
      SHARED,
      params,
      decryptKey,
      (delta) => send(`ai-inline-chunk:${requestId}`, delta),
      ac.signal,
    )
    send(`ai-inline-done:${requestId}`, { ok: true, text: stripCodeFence(full) })
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message || String(e)
    send(`ai-inline-done:${requestId}`, { ok: false, error: msg })
    return { ok: false, error: msg }
  } finally {
    inlineEditAborts.delete(requestId)
  }
})

ipcMain.handle('ai-inline-cancel', (_evt, requestId: string) => {
  const ac = inlineEditAborts.get(requestId)
  if (ac) ac.abort()
  inlineEditAborts.delete(requestId)
  return { ok: true }
})

// ── AI chat (streaming coding assistant) ─────────────────────
// Same streaming contract as inline edit, keyed by requestId.

const chatAborts = new Map<string, AbortController>()

ipcMain.handle('ai-chat', async (_evt, requestId: string, params: ChatParams) => {
  const ac = new AbortController()
  chatAborts.set(requestId, ac)
  const send = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload)
    }
  }
  try {
    const full = await streamChat(
      SHARED,
      params,
      decryptKey,
      (delta) => send(`ai-chat-chunk:${requestId}`, delta),
      ac.signal,
    )
    send(`ai-chat-done:${requestId}`, { ok: true, text: full })
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message || String(e)
    send(`ai-chat-done:${requestId}`, { ok: false, error: msg })
    return { ok: false, error: msg }
  } finally {
    chatAborts.delete(requestId)
  }
})

ipcMain.handle('ai-chat-cancel', (_evt, requestId: string) => {
  const ac = chatAborts.get(requestId)
  if (ac) ac.abort()
  chatAborts.delete(requestId)
  return { ok: true }
})

// ── IDE agent (tool-calling loop, streams tool activity) ─────
// Unlike ai-chat (text only), this lets the model read/modify the workspace via
// the shared agent tools. Events stream on ai-agent-event:<runId>.

const agentAborts = new Map<string, AbortController>()
// changeId → resolver, so the renderer's accept/reject can unblock the agent.
const pendingReviews = new Map<string, (d: ReviewDecision) => void>()

ipcMain.handle('ai-agent-run', async (_evt, runId: string, params: IdeAgentParams) => {
  const ac = new AbortController()
  agentAborts.set(runId, ac)
  const emit = (e: IdeAgentEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`ai-agent-event:${runId}`, e)
    }
  }
  // Held until the renderer replies via ai-agent-review. Aborting the run
  // auto-rejects any outstanding change so the loop can unwind.
  const requestReview = (change: PendingChange): Promise<ReviewDecision> =>
    new Promise((resolve) => {
      if (ac.signal.aborted) { resolve('reject'); return }
      const onAbort = () => { pendingReviews.delete(change.changeId); resolve('reject') }
      ac.signal.addEventListener('abort', onAbort, { once: true })
      pendingReviews.set(change.changeId, (d) => {
        ac.signal.removeEventListener('abort', onAbort)
        pendingReviews.delete(change.changeId)
        resolve(d)
      })
    })
  try {
    await runIdeAgent(SHARED, params, decryptKey, emit, ac.signal, requestReview)
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message || String(e)
    emit({ type: 'error', error: msg })
    return { ok: false, error: msg }
  } finally {
    agentAborts.delete(runId)
  }
})

ipcMain.handle('ai-agent-review', (_evt, changeId: string, decision: ReviewDecision) => {
  const resolve = pendingReviews.get(changeId)
  if (resolve) resolve(decision)
  return { ok: true }
})

ipcMain.handle('ai-agent-cancel', (_evt, runId: string) => {
  const ac = agentAborts.get(runId)
  if (ac) ac.abort()
  agentAborts.delete(runId)
  return { ok: true }
})

// IDE-agent config (currently just reviewMode) persisted in meta.
ipcMain.handle('ide-agent-config-get', () => {
  const raw = db.getMeta('ide_agent_config')
  const cfg = raw ? JSON.parse(raw) : {}
  return { reviewMode: Boolean(cfg.reviewMode) }
})

ipcMain.handle('ide-agent-config-set', (_evt, patch: { reviewMode?: boolean }) => {
  const raw = db.getMeta('ide_agent_config')
  const cfg = raw ? JSON.parse(raw) : {}
  const next = { ...cfg, ...patch }
  db.setMeta('ide_agent_config', JSON.stringify(next))
  return { ok: true, reviewMode: Boolean(next.reviewMode) }
})

// ── Lifecycle ───────────────────────────────────────────────

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.orqon.ide')
  createWindow()
  // Ensure the artifacts dir exists (gitignored; agents write task outputs here).
  // Coordination state (tasks/messages/usage/logs) lives in the DB, not files.
  try {
    await fs.mkdir(path.join(SHARED, 'artifacts'), { recursive: true })
  } catch (err) {
    console.error('Failed to mkdir shared/artifacts:', err)
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
  // Group coordinator polls for group signals. It is a no-op each tick unless
  // orchestration.enabled is true in agents-config.json, so this is safe to
  // always start.
  coordinator.start()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
