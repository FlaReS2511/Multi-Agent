// group-coordinator.ts — the code-owned lifecycle for v2 group orchestration.
//
// HYBRID model: this coordinator owns every REAL transition (spawn/kill, budget,
// retry, concurrency). LLM agents only set a `signal` on their group row via the
// runtime tools RequestReview / SubmitReview / DispatchTask. We poll those
// signals and act deterministically. See MULTIAGENT_DESIGN.md.
//
// Group agents run headless (child_process.spawn, not PTY): they do one session
// and exit. We track them by group row + PID. The resident planner/orchestrator
// keep their PTY inbox model in main.ts — this file does not touch them.

import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import * as db from './db'

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

export const DEFAULT_ORCHESTRATION: OrchestrationConfig = {
  enabled: false,
  max_concurrent_groups: 3,
  max_groups_per_task: 20,
  max_recursion_depth: 3,
  budget_per_task_usd: 5,
  budget_per_group_usd: 2,
  max_retries_per_group: 3,
  reviewer_level_offset: 1,
  review_policy: 'on-demand',
  reviewer_for: {},
  heartbeat_timeout_sec: 300,
}

// Dependencies injected by main.ts so this module stays decoupled from Electron.
export interface CoordinatorDeps {
  runtimePath: string           // AGENT_RUNTIME (dist-electron/agent-runtime.js)
  execPath: string              // process.execPath (Electron-as-node)
  agentsDir: string             // ROOT/agents (cwd for spawned agent)
  // Env vars (decrypted API key etc.) for a given agent role.
  envForRole: (role: string) => Promise<Record<string, string>>
  // Read the live orchestration config from agents-config.json.
  readOrchestration: () => Promise<OrchestrationConfig>
  // Model configured for a role, used to stamp the group row.
  modelForRole: (role: string) => Promise<string | null>
  // Optional notifier so the renderer can reflect group activity.
  notify?: (event: string, payload: unknown) => void
}

const POLL_MS = 1000

interface RunningProc {
  proc: ChildProcess
  groupId: string
  kind: 'worker' | 'reviewer'
}

export class GroupCoordinator {
  private deps: CoordinatorDeps
  private timer: NodeJS.Timeout | null = null
  private running = new Map<string, RunningProc>() // key: `${groupId}:${kind}`
  private ticking = false

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const { proc } of this.running.values()) {
      try { proc.kill() } catch { /* ignore */ }
    }
    this.running.clear()
  }

  // Public: create a root group for a task (called from an IPC handler / UI).
  async createGroupForTask(taskId: string, workerRole: string): Promise<string> {
    const cfg = await this.deps.readOrchestration()
    const model = await this.deps.modelForRole(workerRole)
    const reviewerRole = cfg.reviewer_for[workerRole] || null
    const reviewerModel = reviewerRole ? await this.deps.modelForRole(reviewerRole) : null
    const id = db.createGroup({
      task_id: taskId,
      worker_role: workerRole,
      reviewer_role: reviewerRole,
      worker_model: model,
      reviewer_model: reviewerModel,
      budget_usd: cfg.budget_per_group_usd,
      depth: 0,
    })
    this.log(taskId, `created group ${id} worker=${workerRole} reviewer=${reviewerRole || '-'}`)
    return id
  }

  // ── main tick ──────────────────────────────────────────────────
  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const cfg = await this.deps.readOrchestration()
      if (!cfg.enabled) return

      // 1) Reap finished child processes (proc exit is handled in onExit, this
      //    is a safety net; nothing to do here beyond it).

      // 2) Handle signals on active/reviewing groups.
      for (const g of db.getGroupsByStatus('active', 'reviewing')) {
        await this.handleSignals(g, cfg)
      }

      // 3) Enforce budgets on everything live.
      for (const g of db.getGroupsByStatus('active', 'reviewing', 'pending')) {
        if (this.overBudget(g, cfg)) {
          this.killGroup(g.id, 'budget exceeded')
        }
      }

      // 4) Start pending groups if we have concurrency headroom.
      const activeCount = db.getGroupsByStatus('active', 'reviewing').length
      let slots = Math.max(0, cfg.max_concurrent_groups - activeCount)
      if (slots > 0) {
        for (const g of db.getGroupsByStatus('pending')) {
          if (slots <= 0) break
          if (this.overBudget(g, cfg)) { this.killGroup(g.id, 'budget exceeded'); continue }
          await this.spawnWorker(g)
          slots--
        }
      }

      // 5) Heartbeat sweep: detect hung or orphaned groups.
      await this.sweepHeartbeats(cfg)
    } catch (e) {
      console.error('[coordinator] tick error:', e)
    } finally {
      this.ticking = false
    }
  }

  // Parse the "YYYY-MM-DD HH:MM" local stamp the runtime writes. Returns ms
  // since epoch, or null if unparseable.
  private parseStamp(s: string | null): number | null {
    if (!s) return null
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/)
    if (!m) return null
    const [, y, mo, d, h, mi] = m
    return new Date(+y, +mo - 1, +d, +h, +mi).getTime()
  }

  // A group is "hung" if it is active/reviewing, its heartbeat has not advanced
  // within heartbeat_timeout_sec, AND no child process is currently running for
  // it (a running process may legitimately be mid-turn on a slow model — but its
  // exit handler will re-drive the tick, so we only reap when nothing runs).
  private async sweepHeartbeats(cfg: OrchestrationConfig): Promise<void> {
    if (cfg.heartbeat_timeout_sec <= 0) return
    const now = Date.now()
    const timeoutMs = cfg.heartbeat_timeout_sec * 1000
    for (const g of db.getGroupsByStatus('active', 'reviewing')) {
      const workerRunning = this.running.has(`${g.id}:worker`)
      const reviewerRunning = this.running.has(`${g.id}:reviewer`)
      if (workerRunning || reviewerRunning) continue
      // No process running. If it has an unhandled signal, the next tick's
      // handleSignals will deal with it — skip. Only sweep truly stuck groups.
      if (g.signal) continue
      const hb = this.parseStamp(g.heartbeat_at) ?? this.parseStamp(g.updated_at)
      if (hb != null && now - hb < timeoutMs) continue
      // Stuck: no proc, no signal, heartbeat stale. Treat as a crashed session
      // and retry (respawn worker) up to the retry cap.
      const retries = g.retries + 1
      if (retries <= cfg.max_retries_per_group && !this.overBudget(g, cfg)) {
        db.updateGroupFields(g.id, { retries, status: 'active' })
        this.log(g.task_id, `group ${g.id} hung/crashed (no heartbeat), respawn worker (retry ${retries}/${cfg.max_retries_per_group})`)
        db.addGroupMemory({
          group_id: g.id, task_id: g.task_id, role: 'worker',
          kind: 'progress_note', content: '(previous session crashed or timed out before finishing — continue from the files as they are)',
        })
        await this.spawnWorker(db.getGroup(g.id)!)
      } else {
        db.updateGroupFields(g.id, { retries, status: 'failed' })
        db.updateTaskStatus(g.task_id, 'blocked')
        this.log(g.task_id, `group ${g.id} failed: hung and out of retries/budget`)
        this.deps.notify?.('group-failed', { group: g.id, task: g.task_id, reason: 'heartbeat timeout' })
      }
    }
  }

  private overBudget(g: db.GroupRow, cfg: OrchestrationConfig): boolean {
    const spent = db.recomputeGroupSpend(g.id)
    if (cfg.budget_per_group_usd > 0 && spent > cfg.budget_per_group_usd) return true
    if (cfg.budget_per_task_usd > 0) {
      const treeSpend = db.taskTreeSpend(g.task_id)
      if (treeSpend > cfg.budget_per_task_usd) return true
    }
    return false
  }

  private async handleSignals(g: db.GroupRow, cfg: OrchestrationConfig): Promise<void> {
    const signal = g.signal
    if (!signal) return
    // Only act once the process that raised it has actually exited.
    const workerRunning = this.running.has(`${g.id}:worker`)
    const reviewerRunning = this.running.has(`${g.id}:reviewer`)
    if (workerRunning || reviewerRunning) return

    if (signal === 'request_review') {
      db.updateGroupFields(g.id, { signal: null, status: 'reviewing' })
      if (!g.reviewer_role) {
        // No reviewer configured → auto-pass (on-demand review, nothing to check).
        this.closeGroupPassed(g)
      } else {
        await this.spawnReviewer(g)
      }
    } else if (signal === 'dispatch') {
      db.updateGroupFields(g.id, { signal: null })
      await this.spawnSubGroup(g, cfg)
      // After dispatching, the worker still owns the parent task; respawn it so
      // it can continue / request review of the remainder.
      await this.spawnWorker(db.getGroup(g.id)!)
    } else if (signal === 'verdict:pass') {
      db.updateGroupFields(g.id, { signal: null })
      this.closeGroupPassed(g)
    } else if (signal === 'verdict:fail') {
      db.updateGroupFields(g.id, { signal: null })
      await this.handleFail(g, cfg)
    } else if (signal.startsWith('blocked:')) {
      // Worker declared the task impossible. Fail immediately — no reviewer, no
      // retry — so it stops burning retries on something that can't be done.
      const reason = signal.slice('blocked:'.length)
      db.updateGroupFields(g.id, { signal: null, status: 'failed' })
      db.updateTaskStatus(g.task_id, 'blocked')
      this.log(g.task_id, `group ${g.id} reported blocked (no retry): ${reason}`)
      this.deps.notify?.('group-failed', { group: g.id, task: g.task_id })
    } else {
      // Unknown signal — clear it to avoid a stuck group.
      db.updateGroupFields(g.id, { signal: null })
    }
  }

  private async handleFail(g: db.GroupRow, cfg: OrchestrationConfig): Promise<void> {
    const retries = g.retries + 1
    const spent = db.recomputeGroupSpend(g.id)
    const budgetOk = cfg.budget_per_group_usd <= 0 || spent <= cfg.budget_per_group_usd
    if (retries <= cfg.max_retries_per_group && budgetOk) {
      db.updateGroupFields(g.id, { retries, status: 'active' })
      this.log(g.task_id, `group ${g.id} review failed, respawn worker (retry ${retries}/${cfg.max_retries_per_group})`)
      await this.spawnWorker(db.getGroup(g.id)!)
    } else {
      db.updateGroupFields(g.id, { retries, status: 'failed' })
      db.updateTaskStatus(g.task_id, 'blocked')
      this.log(g.task_id, `group ${g.id} failed permanently (retries=${retries}, spent=$${spent.toFixed(4)})`)
      this.deps.notify?.('group-failed', { group: g.id, task: g.task_id })
    }
  }

  private closeGroupPassed(g: db.GroupRow): void {
    db.updateGroupFields(g.id, { status: 'passed' })
    db.updateTaskStatus(g.task_id, 'done')
    this.log(g.task_id, `group ${g.id} passed → task done`)
    this.deps.notify?.('group-passed', { group: g.id, task: g.task_id })
    // Keep the row + memory for inspection; a GĐ4 UI action can purge it.
  }

  private async spawnSubGroup(parent: db.GroupRow, cfg: OrchestrationConfig): Promise<void> {
    if (parent.depth + 1 > cfg.max_recursion_depth) {
      this.log(parent.task_id, `dispatch denied: recursion depth cap (${cfg.max_recursion_depth})`)
      return
    }
    const tree = db.getGroupsForTaskTree(parent.task_id)
    if (tree.length >= cfg.max_groups_per_task) {
      this.log(parent.task_id, `dispatch denied: max_groups_per_task (${cfg.max_groups_per_task})`)
      return
    }
    const dispatch = db.latestGroupMemory(parent.id, 'dispatch')
    if (!dispatch) return
    let payload: { title?: string; note?: string } = {}
    try { payload = JSON.parse(dispatch.content) } catch { /* ignore */ }
    if (!payload.title) return

    // Sub-task is a child of the parent group's task (HTN depth cap = 2 applies).
    let childTaskId: string
    try {
      childTaskId = db.createTask({
        title: payload.title,
        owner: parent.worker_role || 'backend-engineer',
        parent_id: db.getTask(parent.task_id)?.parent_id ? undefined : parent.task_id,
      })
    } catch (e) {
      this.log(parent.task_id, `dispatch failed to create task: ${(e as Error).message}`)
      return
    }
    const model = await this.deps.modelForRole(parent.worker_role || '')
    const reviewerRole = cfg.reviewer_for[parent.worker_role || ''] || null
    const reviewerModel = reviewerRole ? await this.deps.modelForRole(reviewerRole) : null
    const subId = db.createGroup({
      task_id: childTaskId,
      worker_role: parent.worker_role || 'backend-engineer',
      reviewer_role: reviewerRole,
      worker_model: model,
      reviewer_model: reviewerModel,
      budget_usd: cfg.budget_per_group_usd,
      parent_group: parent.id,
      depth: parent.depth + 1,
    })
    if (payload.note) {
      db.addGroupMemory({
        group_id: subId, task_id: childTaskId, role: 'worker',
        kind: 'progress_note', content: `Dispatched from ${parent.id}: ${payload.note}`,
      })
    }
    this.log(parent.task_id, `dispatched sub-group ${subId} (task ${childTaskId}, depth ${parent.depth + 1})`)
  }

  // ── spawning group agents (headless one-shot) ────────────────────
  private async spawnWorker(g: db.GroupRow): Promise<void> {
    if (this.running.has(`${g.id}:worker`)) return
    db.updateGroupFields(g.id, { status: 'active' })
    db.updateTaskStatus(g.task_id, 'in_progress')
    await this.spawnAgent(g.id, g.worker_role || 'backend-engineer', 'worker')
  }

  private async spawnReviewer(g: db.GroupRow): Promise<void> {
    if (this.running.has(`${g.id}:reviewer`)) return
    const role = g.reviewer_role
    if (!role) { this.closeGroupPassed(g); return }
    await this.spawnAgent(g.id, role, 'reviewer')
  }

  private async spawnAgent(groupId: string, role: string, kind: 'worker' | 'reviewer'): Promise<void> {
    const key = `${groupId}:${kind}`
    if (this.running.has(key)) return
    const env = await this.deps.envForRole(role)
    const proc = spawn(
      this.deps.execPath,
      [this.deps.runtimePath, '--role', role, '--group', groupId, '--group-kind', kind],
      {
        cwd: this.deps.agentsDir,
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    this.running.set(key, { proc, groupId, kind })
    this.log(db.getGroup(groupId)?.task_id || '', `spawn ${kind} ${role} for ${groupId} pid=${proc.pid}`)
    this.deps.notify?.('group-spawn', { group: groupId, role, kind, pid: proc.pid })

    proc.stdout?.on('data', (d) => process.stdout.write(`[${role}#${groupId}] ${d}`))
    proc.stderr?.on('data', (d) => process.stderr.write(`[${role}#${groupId}!] ${d}`))
    // Optional: mirror child output to a file (harness/debug only).
    const childLog = process.env.GROUP_CHILD_LOG
    if (childLog) {
      const write = (tag: string) => (d: Buffer) => {
        try { fs.appendFileSync(childLog, `[${role}#${groupId}${tag}] ${d}`) } catch { /* ignore */ }
      }
      proc.stdout?.on('data', write(''))
      proc.stderr?.on('data', write('!'))
    }
    proc.on('exit', (code) => {
      this.running.delete(key)
      this.deps.notify?.('group-exit', { group: groupId, kind, code })
      // Signal is picked up on the next tick (proc no longer in running map).
    })
  }

  // Public: manually kill a group from the UI.
  killGroupManual(groupId: string, reason: string): void {
    this.killGroup(groupId, reason)
  }

  private killGroup(groupId: string, reason: string): void {
    for (const kind of ['worker', 'reviewer'] as const) {
      const rp = this.running.get(`${groupId}:${kind}`)
      if (rp) { try { rp.proc.kill() } catch { /* ignore */ } this.running.delete(`${groupId}:${kind}`) }
    }
    const g = db.getGroup(groupId)
    db.updateGroupFields(groupId, { status: 'killed', signal: null })
    if (g) {
      db.updateTaskStatus(g.task_id, 'blocked')
      this.log(g.task_id, `group ${groupId} KILLED: ${reason}`)
      this.deps.notify?.('group-killed', { group: groupId, task: g.task_id, reason })
    }
  }

  private log(taskId: string, line: string): void {
    db.addLog('coordinator', line + (taskId ? ` (task ${taskId})` : ''), db.nowStampLocal())
  }
}
