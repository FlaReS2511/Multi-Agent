import { app, BrowserWindow, ipcMain } from 'electron'
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
const AGENTS = ['planner', 'orchestrator', 'backend-engineer', 'frontend-engineer', 'ai-engineer', 'reviewer'] as const
const PLANNER_DRAFT_PATH = path.join(ROOT, 'agents', 'planner', 'workspace', 'current-draft.md')

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
  for (const agent of AGENTS) {
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
  for (const agent of AGENTS) {
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
}

ipcMain.handle('create-task', async (_evt, input: CreateTaskInput) => {
  const tasksPath = path.join(SHARED, 'tasks.json')
  const raw = await fs.readFile(tasksPath, 'utf-8').catch(() => '{"tasks":[],"next_id":1}')
  const data = JSON.parse(raw)
  const id = `T-${String(data.next_id).padStart(3, '0')}`
  const ts = nowStamp()
  const task = {
    id,
    title: input.title,
    owner: input.owner,
    status: 'todo',
    deps: input.deps,
    priority: input.priority,
    created_at: ts,
    updated_at: ts,
  }
  data.tasks.push(task)
  data.next_id += 1
  await fs.writeFile(tasksPath, JSON.stringify(data, null, 2) + '\n')

  const inboxPath = path.join(SHARED, 'inbox', `${input.owner}.md`)
  const block = [
    '',
    `## [${ts}] FROM: ui | TO: ${input.owner} | TASK: ${id}`,
    `**Subject:** ${input.title}`,
    `**Priority:** ${input.priority}`,
    `**Deps:** ${input.deps.length > 0 ? input.deps.join(', ') : 'none'}`,
    '',
    input.description || '(no description)',
    '',
    '---',
    '',
  ].join('\n')
  await fs.appendFile(inboxPath, block)

  await fs.appendFile(
    path.join(SHARED, 'logs', 'orchestrator.log'),
    `[${ts}] ui created ${id} owner=${input.owner} priority=${input.priority}\n`
  )

  return { id, task }
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

  // Wake the Planner agent in tmux pane (best-effort)
  tmuxNotifyPlanner()

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
  const configPath = path.join(SHARED, 'agents-config.json')
  const raw = await fs.readFile(configPath, 'utf-8')
  const config = JSON.parse(raw)
  config.agents[agent] = { provider, model }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
  return { ok: true }
})

// ── PTY: spawn `claude` per agent ───────────────────────────

interface PtySession {
  proc: import('node-pty').IPty
  agent: string
  history: string  // recent output buffer for late-attaching renderers
}

const ptySessions = new Map<string, PtySession>()
const HISTORY_MAX = 50_000  // keep last ~50KB per session

function ensurePty(agent: string) {
  let s = ptySessions.get(agent)
  if (s) return s

  const cwd = path.join(ROOT, 'agents', agent)
  const claudePath = process.env.CLAUDE_BIN || '/Users/tom/.local/bin/claude'

  // Read agent config to pass --model flag
  let modelFlag: string[] = []
  try {
    const configRaw = require('node:fs').readFileSync(path.join(SHARED, 'agents-config.json'), 'utf-8')
    const config = JSON.parse(configRaw)
    const model = config.agents?.[agent]?.model
    if (model) modelFlag = ['--model', model]
  } catch {
    // config missing — use default
  }

  const proc = pty.spawn(
    claudePath,
    ['--dangerously-skip-permissions', ...modelFlag],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    }
  )

  s = { proc, agent, history: '' }
  ptySessions.set(agent, s)

  proc.onData((data) => {
    s!.history += data
    if (s!.history.length > HISTORY_MAX) {
      s!.history = s!.history.slice(-HISTORY_MAX)
    }
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

ipcMain.handle('pty-start', (_evt, agent: string) => {
  const s = ensurePty(agent)
  return { ok: true, history: s.history }
})

ipcMain.handle('pty-write', (_evt, agent: string, data: string) => {
  const s = ptySessions.get(agent)
  if (!s) return { ok: false, error: 'no session' }
  s.proc.write(data)
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

function watchInboxes() {
  const inboxDir = path.join(SHARED, 'inbox')

  // Initialize baseline state for each agent
  for (const agent of AGENTS) {
    inboxState.set(agent, readInboxState(agent))
  }

  fsSync.watch(inboxDir, (_event, filename) => {
    if (!filename || !filename.endsWith('.md')) return
    const agent = filename.replace('.md', '')
    if (!AGENTS.includes(agent as typeof AGENTS[number])) return

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

        const session = ptySessions.get(agent)
        if (session) {
          // Inject "check inbox" prompt — Claude Code will pick it up at next idle
          session.proc.write('check inbox\r')
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('auto-trigger', { agent })
          }
        }
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
  for (const agent of AGENTS) {
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
  ensurePty(agent)
  return { ok: true }
})

// ── Lifecycle ───────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  watchInboxes()
  // Eagerly spawn all 4 agents so they are ready when user opens Terminals tab
  for (const agent of AGENTS) {
    try {
      ensurePty(agent)
    } catch (err) {
      console.error(`Failed to spawn ${agent}:`, err)
    }
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
