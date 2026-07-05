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
  group_id?: string | null
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

    CREATE TABLE IF NOT EXISTS groups (
      id             TEXT PRIMARY KEY,
      task_id        TEXT NOT NULL,
      parent_group   TEXT,
      depth          INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL,
      worker_role    TEXT,
      reviewer_role  TEXT,
      worker_model   TEXT,
      reviewer_model TEXT,
      level          INTEGER,
      budget_usd     REAL NOT NULL DEFAULT 0,
      spent_usd      REAL NOT NULL DEFAULT 0,
      retries        INTEGER NOT NULL DEFAULT 0,
      signal         TEXT,
      worker_pid     INTEGER,
      reviewer_pid   INTEGER,
      heartbeat_at   TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status);
    CREATE INDEX IF NOT EXISTS idx_groups_task ON groups(task_id);

    CREATE TABLE IF NOT EXISTS group_memory (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id  TEXT NOT NULL,
      task_id   TEXT,
      role      TEXT,
      kind      TEXT NOT NULL,
      content   TEXT NOT NULL,
      ts        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmem_group ON group_memory(group_id, id);
  `)

  // Migration: add usage.group_id for cost attribution per group. Older DBs
  // created before v2 lack this column; ADD COLUMN is a no-op-safe try/catch.
  try {
    d.exec(`ALTER TABLE usage ADD COLUMN group_id TEXT`)
  } catch {
    // column already exists — ignore
  }
  // Migration: peak context (max prompt tokens seen in a session) + its window,
  // so the Groups panel can show how full each group's context got.
  try { d.exec(`ALTER TABLE groups ADD COLUMN peak_context INTEGER NOT NULL DEFAULT 0`) } catch { /* exists */ }
  try { d.exec(`ALTER TABLE groups ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0`) } catch { /* exists */ }
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

// Generic meta key/value (used for workspace root, recent folders, etc).
export function getMeta(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value)
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
  group_id?: string | null
}

export function addUsage(u: AddUsageInput): void {
  getDb()
    .prepare(
      `INSERT INTO usage (ts, role, model, tokens_in, tokens_out, cost_usd, task_id, group_id)
       VALUES (@ts, @role, @model, @tokens_in, @tokens_out, @cost_usd, @task_id, @group_id)`
    )
    .run({
      ts: u.ts,
      role: u.role,
      model: u.model ?? null,
      tokens_in: u.tokens_in,
      tokens_out: u.tokens_out,
      cost_usd: u.cost_usd,
      task_id: u.task_id ?? null,
      group_id: u.group_id ?? null,
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

// ── high-level task helpers (shared by main process + agent runtime) ─────
//
// These mirror the create/update logic that used to live only in the Electron
// IPC handlers and in the Python runtime, so the TS agent runtime can create
// and transition tasks through the exact same code path (single source of
// truth for id allocation + HTN depth validation).

const HTN_MAX_DEPTH = 2

export function nowStampLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface CreateTaskArgs {
  title: string
  owner: string
  priority?: 'low' | 'medium' | 'high'
  deps?: string[]
  parent_id?: string | null
}

// Allocate the next T-XXX id, insert the task, wire it into its parent (if any),
// all inside one transaction. Returns the new id. Throws on HTN depth violation.
export function createTask(args: CreateTaskArgs): string {
  const ts = nowStampLocal()
  return transaction(() => {
    if (args.parent_id) {
      const parent = getTask(args.parent_id)
      if (!parent) throw new Error(`parent task ${args.parent_id} not found`)
      if (parent.parent_id) {
        throw new Error(
          `cannot create child of ${args.parent_id}: it already has a parent (depth cap = ${HTN_MAX_DEPTH})`
        )
      }
    }
    const nextId = getNextId()
    const id = `T-${String(nextId).padStart(3, '0')}`
    insertTask({
      id,
      title: args.title,
      owner: args.owner,
      status: 'todo',
      priority: args.priority ?? 'medium',
      deps: args.deps ?? [],
      parent_id: args.parent_id ?? null,
      children: [],
      created_at: ts,
      updated_at: ts,
    })
    setNextId(nextId + 1)
    if (args.parent_id) {
      const parent = getTask(args.parent_id)!
      updateTaskFields(args.parent_id, {
        children: [...(parent.children ?? []), id],
        updated_at: ts,
      })
    }
    return id
  })
}

const VALID_STATUSES = new Set([
  'todo', 'in_progress', 'review', 'done', 'blocked', 'waiting_children',
])

// Update a task's status (+ optional artifact). Returns false if not found or
// the status is invalid.
export function updateTaskStatus(id: string, status: string, artifact?: string | null): boolean {
  if (!VALID_STATUSES.has(status)) return false
  const task = getTask(id)
  if (!task) return false
  updateTaskFields(id, {
    status,
    artifact: artifact ?? undefined,
    updated_at: nowStampLocal(),
  })
  return true
}

// ── groups (v2 orchestration) ────────────────────────────────────
//
// A group is the code-owned unit of work-and-review bound to one task. The
// GroupCoordinator in the main process owns the lifecycle; agents only set the
// `signal` column (via runtime tools) to request transitions. Group agents do
// NOT use the inbox — the coordinator tracks them by group row + PID.

export type GroupStatus =
  | 'pending'
  | 'active'
  | 'reviewing'
  | 'passed'
  | 'failed'
  | 'killed'

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
  peak_context: number
  context_window: number
  created_at: string
  updated_at: string
}

export interface CreateGroupArgs {
  task_id: string
  worker_role: string
  reviewer_role?: string | null
  worker_model?: string | null
  reviewer_model?: string | null
  level?: number | null
  budget_usd?: number
  parent_group?: string | null
  depth?: number
}

// Allocate the next G-XXX id (separate counter in meta) and insert a pending
// group. Returns the new id.
export function createGroup(args: CreateGroupArgs): string {
  const ts = nowStampLocal()
  return transaction(() => {
    const row = getDb().prepare(`SELECT value FROM meta WHERE key = 'next_group_id'`).get() as
      | { value: string }
      | undefined
    const n = row ? parseInt(row.value, 10) || 1 : 1
    const id = `G-${String(n).padStart(3, '0')}`
    getDb()
      .prepare(
        `INSERT INTO groups (id, task_id, parent_group, depth, status, worker_role,
           reviewer_role, worker_model, reviewer_model, level, budget_usd, spent_usd,
           retries, signal, worker_pid, reviewer_pid, heartbeat_at, created_at, updated_at)
         VALUES (@id, @task_id, @parent_group, @depth, 'pending', @worker_role,
           @reviewer_role, @worker_model, @reviewer_model, @level, @budget_usd, 0,
           0, NULL, NULL, NULL, NULL, @ts, @ts)`
      )
      .run({
        id,
        task_id: args.task_id,
        parent_group: args.parent_group ?? null,
        depth: args.depth ?? 0,
        worker_role: args.worker_role,
        reviewer_role: args.reviewer_role ?? null,
        worker_model: args.worker_model ?? null,
        reviewer_model: args.reviewer_model ?? null,
        level: args.level ?? null,
        budget_usd: args.budget_usd ?? 0,
        ts,
      })
    getDb()
      .prepare(`INSERT INTO meta (key, value) VALUES ('next_group_id', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(n + 1))
    return id
  })
}

export function getGroup(id: string): GroupRow | null {
  const r = getDb().prepare(`SELECT * FROM groups WHERE id = ?`).get(id) as GroupRow | undefined
  return r ?? null
}

export function getGroupsByStatus(...statuses: GroupStatus[]): GroupRow[] {
  if (statuses.length === 0) return []
  const placeholders = statuses.map(() => '?').join(',')
  return getDb()
    .prepare(`SELECT * FROM groups WHERE status IN (${placeholders}) ORDER BY id`)
    .all(...statuses) as GroupRow[]
}

// Groups that descend from a given root task (for max_groups_per_task counting).
export function getGroupsForTaskTree(rootTaskId: string): GroupRow[] {
  return getDb()
    .prepare(`SELECT * FROM groups WHERE task_id = ? ORDER BY id`)
    .all(rootTaskId) as GroupRow[]
}

export function updateGroupFields(
  id: string,
  fields: Partial<
    Pick<
      GroupRow,
      | 'status'
      | 'signal'
      | 'worker_pid'
      | 'reviewer_pid'
      | 'worker_model'
      | 'reviewer_model'
      | 'reviewer_role'
      | 'retries'
      | 'spent_usd'
      | 'heartbeat_at'
      | 'level'
      | 'peak_context'
      | 'context_window'
    >
  >
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    sets.push(`${k} = @${k}`)
    params[k] = v
  }
  if (sets.length === 0) return
  sets.push('updated_at = @updated_at')
  params.updated_at = nowStampLocal()
  getDb().prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

// Recompute spent_usd from the usage table for one group. Returns the new total.
export function recomputeGroupSpend(id: string): number {
  const r = getDb()
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE group_id = ?`)
    .get(id) as { s: number }
  const spent = r.s || 0
  getDb()
    .prepare(`UPDATE groups SET spent_usd = ?, updated_at = ? WHERE id = ?`)
    .run(spent, nowStampLocal(), id)
  return spent
}

// Total spend across every group in a task tree (root budget enforcement).
export function taskTreeSpend(rootTaskId: string): number {
  const r = getDb()
    .prepare(
      `SELECT COALESCE(SUM(u.cost_usd), 0) AS s FROM usage u
       JOIN groups g ON u.group_id = g.id WHERE g.task_id = ?`
    )
    .get(rootTaskId) as { s: number }
  return r.s || 0
}

export function deleteGroup(id: string): void {
  transaction(() => {
    getDb().prepare(`DELETE FROM group_memory WHERE group_id = ?`).run(id)
    getDb().prepare(`DELETE FROM groups WHERE id = ?`).run(id)
  })
}

// ── group_memory ────────────────────────────────────────────────

export interface GroupMemoryRow {
  id: number
  group_id: string
  task_id: string | null
  role: string | null
  kind: string
  content: string
  ts: string
}

export function addGroupMemory(m: {
  group_id: string
  task_id?: string | null
  role?: string | null
  kind: string
  content: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO group_memory (group_id, task_id, role, kind, content, ts)
       VALUES (@group_id, @task_id, @role, @kind, @content, @ts)`
    )
    .run({
      group_id: m.group_id,
      task_id: m.task_id ?? null,
      role: m.role ?? null,
      kind: m.kind,
      content: m.content,
      ts: nowStampLocal(),
    })
}

// Latest memory entry of a given kind for a group (progress_note / review_report).
export function latestGroupMemory(groupId: string, kind: string): GroupMemoryRow | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM group_memory WHERE group_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`
    )
    .get(groupId, kind) as GroupMemoryRow | undefined
  return r ?? null
}

export function allGroupMemory(groupId: string): GroupMemoryRow[] {
  return getDb()
    .prepare(`SELECT * FROM group_memory WHERE group_id = ? ORDER BY id`)
    .all(groupId) as GroupMemoryRow[]
}
