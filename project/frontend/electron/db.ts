// db.ts — SQLite data layer for the Electron main process.
//
// Single source of truth for all dynamic state: tasks, messages (replacing the
// old markdown inbox/outbox), usage (replacing cost-parsed-from-logs), and
// encrypted provider secrets. The static `shared/agents-config.json` stays a
// file (hand-editable, version-controlled).
//
// WAL mode lets the Electron process and the Python agent_runtime.py read/write
// concurrently. Both open the same shared/state.db.

import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

export interface TaskRow {
  id: string
  title: string
  owner: string
  status: string
  priority?: 'low' | 'medium' | 'high'
  deps: string[]
  parent_id?: string | null
  children?: string[]
  artifact?: string
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: number
  ts: string
  from_role: string
  to_role: string
  task_id: string | null
  subject: string | null
  priority: string | null
  deps: string | null
  body: string
  status: 'unread' | 'processed'
  processed_at: string | null
}

export interface UsageRow {
  id: number
  ts: string
  role: string
  model: string | null
  tokens_in: number
  tokens_out: number
  cost_usd: number
  task_id: string | null
}

let db: Database.Database | null = null

export function initDb(sharedDir: string): Database.Database {
  if (db) return db
  fs.mkdirSync(sharedDir, { recursive: true })
  const dbPath = path.join(sharedDir, 'state.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  createSchema(db)
  ensureMeta(db)
  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('db not initialized — call initDb() first')
  return db
}

function createSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      owner       TEXT NOT NULL,
      status      TEXT NOT NULL,
      priority    TEXT,
      deps        TEXT NOT NULL DEFAULT '[]',
      parent_id   TEXT,
      children    TEXT NOT NULL DEFAULT '[]',
      artifact    TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      from_role    TEXT NOT NULL,
      to_role      TEXT NOT NULL,
      task_id      TEXT,
      subject      TEXT,
      priority     TEXT,
      deps         TEXT,
      body         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'unread',
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_role, status);
    CREATE INDEX IF NOT EXISTS idx_msg_task ON messages(task_id);

    CREATE TABLE IF NOT EXISTS usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      role        TEXT NOT NULL,
      model       TEXT,
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      cost_usd    REAL NOT NULL DEFAULT 0,
      task_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts    TEXT NOT NULL,
      role  TEXT NOT NULL,
      line  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_role ON logs(role, id);

    CREATE TABLE IF NOT EXISTS secrets (
      provider TEXT PRIMARY KEY,
      enc_key  TEXT NOT NULL
    );
  `)
}

function ensureMeta(d: Database.Database): void {
  const row = d.prepare(`SELECT value FROM meta WHERE key = 'next_id'`).get() as
    | { value: string }
    | undefined
  if (!row) {
    d.prepare(`INSERT INTO meta (key, value) VALUES ('next_id', '1')`).run()
  }
}

// ── meta / id allocation ────────────────────────────────────────

export function getNextId(): number {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = 'next_id'`).get() as
    | { value: string }
    | undefined
  return row ? parseInt(row.value, 10) || 1 : 1
}

export function setNextId(n: number): void {
  getDb()
    .prepare(`INSERT INTO meta (key, value) VALUES ('next_id', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(n))
}

// ── tasks ────────────────────────────────────────────────────────

function rowToTask(r: any): TaskRow {
  return {
    id: r.id,
    title: r.title,
    owner: r.owner,
    status: r.status,
    priority: r.priority ?? undefined,
    deps: safeJsonArray(r.deps),
    parent_id: r.parent_id ?? null,
    children: safeJsonArray(r.children),
    artifact: r.artifact ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

function safeJsonArray(s: unknown): string[] {
  if (typeof s !== 'string' || !s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function getTasks(): { tasks: TaskRow[]; next_id: number } {
  const rows = getDb().prepare(`SELECT * FROM tasks ORDER BY id`).all()
  return { tasks: rows.map(rowToTask), next_id: getNextId() }
}

export function getTask(id: string): TaskRow | null {
  const r = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id)
  return r ? rowToTask(r) : null
}

export function insertTask(t: TaskRow): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, owner, status, priority, deps, parent_id, children, artifact, created_at, updated_at)
       VALUES (@id, @title, @owner, @status, @priority, @deps, @parent_id, @children, @artifact, @created_at, @updated_at)`
    )
    .run({
      id: t.id,
      title: t.title,
      owner: t.owner,
      status: t.status,
      priority: t.priority ?? null,
      deps: JSON.stringify(t.deps ?? []),
      parent_id: t.parent_id ?? null,
      children: JSON.stringify(t.children ?? []),
      artifact: t.artifact ?? null,
      created_at: t.created_at,
      updated_at: t.updated_at,
    })
}

export function updateTaskFields(
  id: string,
  fields: Partial<Pick<TaskRow, 'status' | 'priority' | 'deps' | 'children' | 'artifact' | 'updated_at'>>
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (fields.status !== undefined) { sets.push('status = @status'); params.status = fields.status }
  if (fields.priority !== undefined) { sets.push('priority = @priority'); params.priority = fields.priority }
  if (fields.deps !== undefined) { sets.push('deps = @deps'); params.deps = JSON.stringify(fields.deps) }
  if (fields.children !== undefined) { sets.push('children = @children'); params.children = JSON.stringify(fields.children) }
  if (fields.artifact !== undefined) { sets.push('artifact = @artifact'); params.artifact = fields.artifact }
  if (fields.updated_at !== undefined) { sets.push('updated_at = @updated_at'); params.updated_at = fields.updated_at }
  if (sets.length === 0) return
  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

// Run a function inside a transaction (for create-task / split-task atomicity).
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)()
}

// ── messages (replaces inbox/outbox markdown) ───────────────────

export interface AddMessageInput {
  ts: string
  from_role: string
  to_role: string
  task_id?: string | null
  subject?: string | null
  priority?: string | null
  deps?: string | null
  body: string
  status?: 'unread' | 'processed'
  processed_at?: string | null
}

export function addMessage(m: AddMessageInput): number {
  const info = getDb()
    .prepare(
      `INSERT INTO messages (ts, from_role, to_role, task_id, subject, priority, deps, body, status, processed_at)
       VALUES (@ts, @from_role, @to_role, @task_id, @subject, @priority, @deps, @body, @status, @processed_at)`
    )
    .run({
      ts: m.ts,
      from_role: m.from_role,
      to_role: m.to_role,
      task_id: m.task_id ?? null,
      subject: m.subject ?? null,
      priority: m.priority ?? null,
      deps: m.deps ?? null,
      body: m.body,
      status: m.status ?? 'unread',
      processed_at: m.processed_at ?? null,
    })
  return Number(info.lastInsertRowid)
}

export function getMessagesFor(role: string): MessageRow[] {
  return getDb()
    .prepare(`SELECT * FROM messages WHERE to_role = ? ORDER BY id`)
    .all(role) as MessageRow[]
}

export function getUnreadFor(role: string): MessageRow[] {
  return getDb()
    .prepare(`SELECT * FROM messages WHERE to_role = ? AND status = 'unread' ORDER BY id`)
    .all(role) as MessageRow[]
}

export function unreadCount(role: string): number {
  const r = getDb()
    .prepare(`SELECT count(*) AS n FROM messages WHERE to_role = ? AND status = 'unread'`)
    .get(role) as { n: number }
  return r.n
}

export function markProcessed(id: number, processedAt: string): void {
  getDb()
    .prepare(`UPDATE messages SET status = 'processed', processed_at = ? WHERE id = ?`)
    .run(processedAt, id)
}

export function getThread(taskId: string): MessageRow[] {
  return getDb()
    .prepare(`SELECT * FROM messages WHERE task_id = ? ORDER BY id`)
    .all(taskId) as MessageRow[]
}

// All distinct roles that have ever appeared as a message recipient. Used to
// build inbox summaries without a hardcoded role list.
export function distinctRecipients(): string[] {
  const rows = getDb().prepare(`SELECT DISTINCT to_role FROM messages`).all() as { to_role: string }[]
  return rows.map((r) => r.to_role)
}

// ── usage (replaces cost-from-log regex) ─────────────────────────

export interface AddUsageInput {
  ts: string
  role: string
  model?: string | null
  tokens_in: number
  tokens_out: number
  cost_usd: number
  task_id?: string | null
}

export function addUsage(u: AddUsageInput): void {
  getDb()
    .prepare(
      `INSERT INTO usage (ts, role, model, tokens_in, tokens_out, cost_usd, task_id)
       VALUES (@ts, @role, @model, @tokens_in, @tokens_out, @cost_usd, @task_id)`
    )
    .run({
      ts: u.ts,
      role: u.role,
      model: u.model ?? null,
      tokens_in: u.tokens_in,
      tokens_out: u.tokens_out,
      cost_usd: u.cost_usd,
      task_id: u.task_id ?? null,
    })
}

// Usage rows whose ts starts with the given YYYY-MM-DD prefix.
export function usageForDay(dayPrefix: string): UsageRow[] {
  return getDb()
    .prepare(`SELECT * FROM usage WHERE ts LIKE ? ORDER BY id`)
    .all(dayPrefix + '%') as UsageRow[]
}

// ── secrets (replaces .secrets.json) ─────────────────────────────

export function getSecret(provider: string): string | null {
  const r = getDb().prepare(`SELECT enc_key FROM secrets WHERE provider = ?`).get(provider) as
    | { enc_key: string }
    | undefined
  return r ? r.enc_key : null
}

export function setSecret(provider: string, encKey: string): void {
  getDb()
    .prepare(`INSERT INTO secrets (provider, enc_key) VALUES (?, ?)
              ON CONFLICT(provider) DO UPDATE SET enc_key = excluded.enc_key`)
    .run(provider, encKey)
}

export function deleteSecret(provider: string): void {
  getDb().prepare(`DELETE FROM secrets WHERE provider = ?`).run(provider)
}

export function listSecretProviders(): string[] {
  const rows = getDb().prepare(`SELECT provider FROM secrets`).all() as { provider: string }[]
  return rows.map((r) => r.provider)
}

// ── logs (activity narration; replaces shared/logs/*.log) ────────

export function addLog(role: string, line: string, ts: string): void {
  getDb().prepare(`INSERT INTO logs (ts, role, line) VALUES (?, ?, ?)`).run(ts, role, line)
}

export function recentLogs(role: string, limit: number): string[] {
  const rows = getDb()
    .prepare(`SELECT ts, line FROM logs WHERE role = ? ORDER BY id DESC LIMIT ?`)
    .all(role, limit) as { ts: string; line: string }[]
  return rows.reverse().map((r) => `[${r.ts}] ${r.line}`)
}

export function allLogs(role: string): string[] {
  const rows = getDb()
    .prepare(`SELECT ts, line FROM logs WHERE role = ? ORDER BY id`)
    .all(role) as { ts: string; line: string }[]
  return rows.map((r) => `[${r.ts}] ${r.line}`)
}
