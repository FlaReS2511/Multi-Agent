// discord-bot.ts — "vibecode qua Discord". A standalone Node entry spawned as a
// child process by the Electron main process (only when discord.enabled=true).
//
// Architecture (see DISCORD_BOT_DESIGN.md): the GroupCoordinator lives in the
// MAIN process, so this bot can't call it directly. Instead it uses the SQLite
// DB as a bus — it writes a `pending` group row; the coordinator (polling every
// 1s in main) picks it up, runs worker+reviewer, and updates the row. The bot
// polls the row back to report progress to Discord. No IPC with main required.
//
// Spawned as: process.execPath discord-bot.js  (ELECTRON_RUN_AS_NODE=1),
// with MULTIAGENT_KEY_DISCORD (decrypted bot token) injected in the env.

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
} from 'discord.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import * as db from './db'
import { resolveGroupParams, normalizeDiscordConfig, type DiscordConfig } from './group-params'
import { DEFAULT_ORCHESTRATION, type OrchestrationConfig } from './group-coordinator'
import { buildAdapter, type ProviderCfgLike } from './adapters'
import {
  FILE_TOOL_SPECS, runFileTool, type ToolSpec,
  previewWrite, previewEdit, applyChange,
  EXCEL_TOOL_SPECS, EXCEL_TOOL_NAMES, EXCEL_MUTATORS, runExcelTool,
} from './agent-tools'
import { EXTRA_TOOL_SPECS, EXTRA_TOOL_NAMES, runExtraTool } from './extra-tools'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const SHARED = path.join(ROOT, 'shared')

const WORKER_ROLES = ['backend-engineer', 'frontend-engineer', 'ai-engineer']
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', '.next', 'build'])
const DISCORD_MSG_LIMIT = 2000
const POLL_MS = 3000
const VIBE_TIMEOUT_MS = 15 * 60 * 1000 // matches Discord's interaction-token TTL

db.initDb(SHARED)

const token = process.env.MULTIAGENT_KEY_DISCORD || ''
if (!token) {
  console.error('[discord] no bot token (MULTIAGENT_KEY_DISCORD) — exiting')
  process.exit(1)
}

// ── config (re-read on every interaction so Settings edits take effect live) ──
interface AgentEntry { model?: string }
interface ProviderCfg extends ProviderCfgLike { models?: string[]; price_in?: number; price_out?: number }
interface FullConfig {
  agents?: Record<string, AgentEntry>
  providers?: Record<string, ProviderCfg>
  orchestration?: Partial<OrchestrationConfig>
  discord?: Partial<DiscordConfig>
}

function loadConfig(): {
  discord: DiscordConfig
  orch: OrchestrationConfig
  providers: Record<string, ProviderCfg>
  modelFor: (role: string) => string | null
} {
  let raw: FullConfig = {}
  try {
    raw = JSON.parse(fs.readFileSync(path.join(SHARED, 'agents-config.json'), 'utf-8'))
  } catch {
    /* fall through to defaults */
  }
  const agents = raw.agents ?? {}
  return {
    discord: normalizeDiscordConfig(raw.discord),
    orch: { ...DEFAULT_ORCHESTRATION, ...(raw.orchestration ?? {}) },
    providers: raw.providers ?? {},
    modelFor: (role: string) => agents[role]?.model ?? null,
  }
}

function keyEnvName(providerId: string): string {
  return 'MULTIAGENT_KEY_' + providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
}

// ── auth (fail-closed) ────────────────────────────────────────────
function isAuthorized(userId: string, channelId: string | null, cfg: DiscordConfig): boolean {
  // Empty allowlist = nobody (fail-closed, safer than fail-open).
  if (cfg.allowed_user_ids.length === 0) return false
  if (!cfg.allowed_user_ids.includes(userId)) return false
  if (cfg.allowed_channel_ids.length > 0 && (!channelId || !cfg.allowed_channel_ids.includes(channelId))) {
    return false
  }
  return true
}

// ── workspace helpers ─────────────────────────────────────────────
function workspaceRoot(): string | null {
  return db.getMeta('workspace_root')
}

// Resolve a workspace-relative path, refusing anything that escapes the root.
function resolveInWorkspace(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel || '.')
  const rootResolved = path.resolve(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null
  return abs
}

function langForFile(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'python', json: 'json',
    md: 'markdown', css: 'css', html: 'html', sh: 'bash', yml: 'yaml', yaml: 'yaml',
    sql: 'sql', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', txt: '',
  }
  return map[ext] ?? ''
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? '' : stdout)
    })
  })
}

// ── slash command registration ────────────────────────────────────
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('vibe')
      .setDescription('Tạo task + group và chạy (vibecode)')
      .addStringOption((o) => o.setName('instruction').setDescription('Việc cần làm').setRequired(true))
      .addStringOption((o) =>
        o.setName('role').setDescription('Worker role').setRequired(false)
          .addChoices(...WORKER_ROLES.map((r) => ({ name: r, value: r }))))
      .addNumberOption((o) => o.setName('budget').setDescription('Budget USD cho group (tùy chọn)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('browse').setDescription('Duyệt cây file workspace (read-only)')
      .addStringOption((o) => o.setName('path').setDescription('Đường dẫn tương đối').setRequired(false)),
    new SlashCommandBuilder()
      .setName('tasks').setDescription('Liệt kê task board')
      .addStringOption((o) => o.setName('status').setDescription('Lọc theo status').setRequired(false)),
    new SlashCommandBuilder().setName('groups').setDescription('Liệt kê group + status + cost'),
    new SlashCommandBuilder()
      .setName('kill').setDescription('Kill 1 group')
      .addStringOption((o) => o.setName('group_id').setDescription('G-xxx').setRequired(true)),
    new SlashCommandBuilder().setName('cost').setDescription('Chi phí hôm nay'),
    new SlashCommandBuilder().setName('status').setDescription('Trạng thái app/coordinator/workspace'),
    new SlashCommandBuilder().setName('agent').setDescription('Bật agent chat ở channel này (nhắn bình thường để sửa code)'),
    new SlashCommandBuilder().setName('agent-end').setDescription('Tắt agent chat ở channel này'),
    new SlashCommandBuilder().setName('compact').setDescription('Nén hội thoại của agent ở channel này'),
    new SlashCommandBuilder()
      .setName('model').setDescription('Đổi model của agent cho channel này (cùng provider)')
      .addStringOption((o) => o.setName('model').setDescription('Tên model').setRequired(true)),
    new SlashCommandBuilder().setName('models').setDescription('Danh sách model khả dụng'),
    new SlashCommandBuilder().setName('reset').setDescription('Xoá lịch sử hội thoại (agent vẫn bật)'),
    new SlashCommandBuilder().setName('stop').setDescription('Dừng lượt agent đang chạy'),
    new SlashCommandBuilder().setName('context').setDescription('Xem token + số lượt của session'),
    new SlashCommandBuilder().setName('undo').setDescription('Hoàn tác các file agent đã sửa trong session'),
    new SlashCommandBuilder().setName('plan').setDescription('Bật/tắt plan mode (khảo sát read-only rồi Approve)'),
  ].map((c) => c.toJSON())
}

async function registerCommands(appId: string, guildId: string) {
  const rest = new REST({ version: '10' }).setToken(token)
  const body = buildCommands()
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body })
    console.log(`[discord] registered ${body.length} guild commands (${guildId})`)
  } else {
    await rest.put(Routes.applicationCommands(appId), { body })
    console.log(`[discord] registered ${body.length} global commands (may take ~1h to propagate)`)
  }
}

// ── /vibe ─────────────────────────────────────────────────────────
async function handleVibe(i: ChatInputCommandInteraction) {
  const { discord, orch, modelFor } = loadConfig()
  await i.deferReply({ flags: MessageFlags.Ephemeral })

  const instruction = i.options.getString('instruction', true)
  const role = i.options.getString('role') || discord.default_worker_role
  const budget = i.options.getNumber('budget')

  let taskId: string
  let groupId: string
  try {
    taskId = db.createTask({ title: instruction, owner: role, priority: 'medium' })
    const args = resolveGroupParams(taskId, role, orch, modelFor)
    if (budget && budget > 0) args.budget_usd = budget
    groupId = db.createGroup(args)
  } catch (e) {
    await i.editReply(`❌ Không tạo được group: ${(e as Error).message}`)
    return
  }

  const warn = orch.enabled ? '' : '\n⚠️ orchestration đang TẮT — group sẽ chờ tới khi bật (Settings).'
  const killRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vibe-kill:${groupId}`).setLabel('Kill').setStyle(ButtonStyle.Danger),
  )
  await i.editReply({
    content: `🟢 Group **${groupId}** cho task **${taskId}** đang chạy…${warn}`,
    components: [killRow],
  })

  // Poll the group row and edit the message as status/cost change.
  const start = Date.now()
  let lastStatus = ''
  let lastSpent = -1
  const timer = setInterval(async () => {
    const g = db.getGroup(groupId)
    if (!g) { clearInterval(timer); return }
    const spent = db.recomputeGroupSpend(groupId)
    const terminal = g.status === 'passed' || g.status === 'failed' || g.status === 'killed'
    const changed = g.status !== lastStatus || Math.abs(spent - lastSpent) > 0.001
    if (terminal) {
      clearInterval(timer)
      const emoji = g.status === 'passed' ? '✅' : g.status === 'killed' ? '🛑' : '❌'
      const ws = workspaceRoot()
      let files = ''
      if (ws) {
        const out = await execGit(['status', '--porcelain'], ws)
        const list = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 25)
        if (list.length) files = '\n**File đổi:**\n```\n' + list.join('\n') + '\n```'
      }
      const review = db.latestGroupMemory(groupId, 'review_report')
      const reviewText = review ? '\n**Review:** ' + review.content.slice(0, 500) : ''
      try {
        await i.editReply({
          content: `${emoji} **${groupId}** → **${g.status}** · $${spent.toFixed(4)} · retries ${g.retries}${files}${reviewText}`.slice(0, 3900),
          components: [],
        })
      } catch { /* interaction token may have expired */ }
      return
    }
    if (Date.now() - start > VIBE_TIMEOUT_MS) {
      clearInterval(timer)
      try { await i.editReply({ content: `⏱️ **${groupId}** vẫn chạy (quá 15'). Xem \`/groups\`.`, components: [] }) } catch { /* ignore */ }
      return
    }
    if (changed) {
      lastStatus = g.status
      lastSpent = spent
      try {
        await i.editReply({
          content: `🟢 **${groupId}** (${taskId}) — **${g.status}** · $${spent.toFixed(4)}`,
          components: [killRow],
        })
      } catch { /* ignore */ }
    }
  }, POLL_MS)
}

async function handleVibeKill(i: ButtonInteraction) {
  const { discord } = loadConfig()
  if (!isAuthorized(i.user.id, i.channelId, discord)) {
    await i.reply({ content: 'Không có quyền.', flags: MessageFlags.Ephemeral })
    return
  }
  const groupId = i.customId.split(':')[1]
  const g = db.getGroup(groupId)
  if (!g) { await i.reply({ content: `Không thấy ${groupId}.`, flags: MessageFlags.Ephemeral }); return }
  db.updateGroupFields(groupId, { signal: 'kill' })
  await i.reply({ content: `🛑 Đã yêu cầu kill **${groupId}**.`, flags: MessageFlags.Ephemeral })
}

// ── /browse ───────────────────────────────────────────────────────
const BROWSE_PAGE = 23 // reserve slots for Up + more

function browseMenu(root: string, relDir: string, page: number): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const abs = resolveInWorkspace(root, relDir)
  if (!abs) return null
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return null }
  const dirs = entries.filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name))
  const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))
  const all = [...dirs, ...files]
  const pages = Math.max(1, Math.ceil(all.length / BROWSE_PAGE))
  const p = Math.min(Math.max(0, page), pages - 1)
  const slice = all.slice(p * BROWSE_PAGE, p * BROWSE_PAGE + BROWSE_PAGE)

  const options: { label: string; description?: string; value: string }[] = []
  if (relDir && relDir !== '.') {
    const parent = path.dirname(relDir)
    options.push({ label: '⬆️ ..', value: `dir:${parent === '.' ? '' : parent}:0` })
  }
  for (const e of slice) {
    const childRel = relDir ? `${relDir}/${e.name}` : e.name
    if (e.isDirectory()) options.push({ label: `📁 ${e.name}`.slice(0, 100), value: `dir:${childRel}:0`.slice(0, 100) })
    else options.push({ label: `📄 ${e.name}`.slice(0, 100), value: `file:${childRel}`.slice(0, 100) })
  }
  if (pages > 1) options.push({ label: `▶ trang ${p + 2 > pages ? 1 : p + 2}/${pages}`, value: `dir:${relDir}:${p + 1 >= pages ? 0 : p + 1}` })
  if (options.length === 0) return null

  const menu = new StringSelectMenuBuilder()
    .setCustomId('browse')
    .setPlaceholder(`📂 ${relDir || '/'} (${all.length} mục)`.slice(0, 150))
    .addOptions(options.slice(0, 25))
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
}

async function handleBrowse(i: ChatInputCommandInteraction) {
  const { discord } = loadConfig()
  const root = workspaceRoot()
  if (!root) { await i.reply({ content: 'Chưa đặt workspace root.', flags: MessageFlags.Ephemeral }); return }
  const rel = (i.options.getString('path') || '').replace(/^\/+/, '')
  const row = browseMenu(root, rel, 0)
  if (!row) { await i.reply({ content: `Không đọc được: ${rel || '/'}`, flags: MessageFlags.Ephemeral }); return }
  void discord
  await i.reply({ content: `📂 **${rel || '/'}**`, components: [row], flags: MessageFlags.Ephemeral })
}

async function handleBrowseSelect(i: StringSelectMenuInteraction) {
  const { discord } = loadConfig()
  if (!isAuthorized(i.user.id, i.channelId, discord)) {
    await i.reply({ content: 'Không có quyền.', flags: MessageFlags.Ephemeral }); return
  }
  const root = workspaceRoot()
  if (!root) { await i.update({ content: 'Chưa đặt workspace root.', components: [] }); return }
  const value = i.values[0]
  const [kind, ...rest] = value.split(':')

  if (kind === 'dir') {
    const page = Number(rest[rest.length - 1]) || 0
    const relDir = rest.slice(0, -1).join(':')
    const row = browseMenu(root, relDir, page)
    if (!row) { await i.update({ content: `Không đọc được: ${relDir || '/'}`, components: [] }); return }
    await i.update({ content: `📂 **${relDir || '/'}**`, components: [row] })
    return
  }

  // file:<rel>
  const rel = rest.join(':')
  const abs = resolveInWorkspace(root, rel)
  if (!abs) { await i.update({ content: '⛔ Path ngoài workspace.', components: [] }); return }
  let buf: Buffer
  try { buf = fs.readFileSync(abs) } catch { await i.update({ content: `Không đọc được: ${rel}`, components: [] }); return }

  const name = path.basename(rel)
  if (buf.length > discord.max_code_bytes) {
    await i.update({ content: `📄 **${rel}** (${buf.length} bytes) — quá lớn, gửi kèm file:`, components: [] })
    await i.followUp({ files: [new AttachmentBuilder(buf, { name })], flags: MessageFlags.Ephemeral })
    return
  }
  const lang = langForFile(name)
  const text = buf.toString('utf-8')
  const header = `📄 **${rel}**`
  await i.update({ content: header, components: [] })
  // Split into <2000-char code blocks across follow-ups.
  const fence = '```'
  const budget = DISCORD_MSG_LIMIT - lang.length - 12
  for (let pos = 0; pos < text.length; pos += budget) {
    const chunk = text.slice(pos, pos + budget)
    await i.followUp({ content: `${fence}${lang}\n${chunk}\n${fence}`, flags: MessageFlags.Ephemeral })
  }
  if (text.length === 0) await i.followUp({ content: '(file rỗng)', flags: MessageFlags.Ephemeral })
}

// ── read-only list commands ───────────────────────────────────────
async function handleTasks(i: ChatInputCommandInteraction) {
  const filter = i.options.getString('status')
  let tasks = db.getTasks().tasks
  if (filter) tasks = tasks.filter((t) => t.status === filter)
  if (tasks.length === 0) { await i.reply({ content: '(không có task)', flags: MessageFlags.Ephemeral }); return }
  const lines = tasks.slice(-25).map((t) => `\`${t.id}\` [${t.status}] ${t.owner} — ${t.title}`.slice(0, 120))
  await i.reply({ content: lines.join('\n').slice(0, 1900), flags: MessageFlags.Ephemeral })
}

async function handleGroups(i: ChatInputCommandInteraction) {
  const rows = db.getGroupsByStatus('pending', 'active', 'reviewing', 'passed', 'failed', 'killed')
  const live = rows.filter((g) => ['pending', 'active', 'reviewing'].includes(g.status))
  const show = (live.length ? live : rows.slice(-20))
  if (show.length === 0) { await i.reply({ content: '(không có group)', flags: MessageFlags.Ephemeral }); return }
  const lines = show.map((g) => {
    const spent = db.recomputeGroupSpend(g.id)
    return `\`${g.id}\` [${g.status}] ${g.worker_role || '-'} · $${spent.toFixed(3)}/$${g.budget_usd} · retry ${g.retries}`
  })
  await i.reply({ content: lines.join('\n').slice(0, 1900), flags: MessageFlags.Ephemeral })
}

async function handleKill(i: ChatInputCommandInteraction) {
  const groupId = i.options.getString('group_id', true)
  const g = db.getGroup(groupId)
  if (!g) { await i.reply({ content: `Không thấy ${groupId}.`, flags: MessageFlags.Ephemeral }); return }
  db.updateGroupFields(groupId, { signal: 'kill' })
  await i.reply({ content: `🛑 Đã yêu cầu kill **${groupId}**.`, flags: MessageFlags.Ephemeral })
}

async function handleCost(i: ChatInputCommandInteraction) {
  const day = db.nowStampLocal().slice(0, 10)
  const rows = db.usageForDay(day)
  const total = rows.reduce((s, r) => s + r.cost_usd, 0)
  const byRole = new Map<string, number>()
  for (const r of rows) byRole.set(r.role, (byRole.get(r.role) || 0) + r.cost_usd)
  const lines = [...byRole.entries()].sort((a, b) => b[1] - a[1]).map(([role, c]) => `${role}: $${c.toFixed(4)}`)
  await i.reply({
    content: `💰 **Hôm nay (${day})**: $${total.toFixed(4)}\n${lines.join('\n') || '(chưa có usage)'}`.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  })
}

async function handleStatus(i: ChatInputCommandInteraction) {
  const { orch } = loadConfig()
  const ws = workspaceRoot() || '(chưa đặt)'
  const active = db.getGroupsByStatus('active', 'reviewing').length
  const pending = db.getGroupsByStatus('pending').length
  await i.reply({
    content: `🖥️ **Status**\nWorkspace: \`${ws}\`\nOrchestration: ${orch.enabled ? 'ON' : 'OFF'}\nGroups: ${active} active · ${pending} pending`,
    flags: MessageFlags.Ephemeral,
  })
}

// ── conversational /agent mode (headless IDE agent per channel) ─────
// `/agent` activates the current channel; subsequent normal messages drive an
// agentic tool loop over the workspace (auto-apply + post diffs). `/agent-end`
// deactivates it. Reuses the shared adapters + file tools (like agent-runtime).

const MAX_AGENT_TURNS = parseInt(process.env.DISCORD_AGENT_MAX_TURNS || '20', 10)

interface AgentSession {
  messages: unknown[]
  busy: boolean
  cancel: boolean          // set by /stop, checked between turns/tools
  model?: string           // per-channel model override (same provider), /model
  planMode: boolean        // /plan: read-only investigate → PresentPlan → approve
  pendingPlan?: string     // plan awaiting the Approve button
  changed: Set<string>     // files edited this session (for /undo)
  created: Set<string>     // NEW files created this session (for /undo)
  turns: number
  tokensIn: number
  tokensOut: number
}
const agentSessions = new Map<string, AgentSession>() // channelId → session

function newSession(): AgentSession {
  return { messages: [], busy: false, cancel: false, planMode: false, changed: new Set(), created: new Set(), turns: 0, tokensIn: 0, tokensOut: 0 }
}

// Plan mode (Discord): read-only tools the agent may use while planning.
const PLAN_READONLY = new Set([
  'Read', 'Grep', 'Glob', 'ListDir', 'GetDiagnostics',
  'GitStatus', 'GitDiff', 'GitLog', 'GitBranch', 'GitConfigGet', 'GitRemoteGet',
  'GitHubAuthStatus', 'ListGitProfiles', 'ListPRs', 'ViewPR', 'ListIssues',
  'WebFetch', 'WebSearch', 'RecallNotes', 'TodoWrite', 'BashOutput', 'ReportBlocked',
])
const PRESENT_PLAN_SPEC: ToolSpec = {
  name: 'PresentPlan',
  description: 'Call ONCE when your plan is complete and final to present it for approval. Pass the full step-by-step plan as `plan` (markdown). Do NOT call it while still investigating or if you need to ask the user something.',
  input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
}

const TEXT_ATT_RE = /\.(txt|md|log|json|ya?ml|csv|ts|tsx|js|jsx|mjs|cjs|py|java|c|cc|cpp|h|hpp|go|rs|rb|php|sh|bash|zsh|html|css|scss|sql|toml|ini|env|xml|diff|patch)$/i

// Fold any text attachments on a Discord message into the prompt so the agent
// can read pasted logs/files. Binary/images are noted but not read (text model).
async function ingestAttachments(message: { attachments: { values: () => Iterable<any> } }, content: string): Promise<string> {
  const atts = [...message.attachments.values()]
  if (atts.length === 0) return content
  const parts: string[] = []
  for (const att of atts) {
    const name: string = att.name || 'file'
    const ct: string = att.contentType || ''
    const isText = ct.startsWith('text/') || ct.includes('json') || TEXT_ATT_RE.test(name)
    if (isText && att.size < 300_000) {
      try {
        const r = await fetch(att.url)
        const t = await r.text()
        parts.push(`--- attachment: ${name} ---\n${t.slice(0, 20000)}`)
      } catch {
        parts.push(`[attachment ${name} — could not fetch]`)
      }
    } else {
      parts.push(`[attachment: ${name} (${ct || 'binary'}, ${att.size} bytes) — not read; paste text if you need me to see it]`)
    }
  }
  return (content ? content + '\n\n' : '') + parts.join('\n\n')
}

const REPORT_BLOCKED_SPEC: ToolSpec = {
  name: 'ReportBlocked',
  description: 'Use ONLY when the request genuinely cannot be completed (missing prerequisites, impossible/contradictory requirements, no viable next step). Ends the turn and reports the blocker. reason is REQUIRED.',
  input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
}

// Orchestration tools (gated on orchestration.enabled): hand large/multi-step
// work to the v2 group coordinator via the DB bus, like the IDE agent.
const ORCH_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'CreateTask',
    description: 'Create a task on the shared board for a specialist agent. owner is a role like backend-engineer, frontend-engineer, ai-engineer.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, owner: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] } },
      required: ['title'],
    },
  },
  {
    name: 'CreateGroup',
    description: 'Spawn a v2 orchestration group (worker + reviewer) to autonomously complete a task. Requires an existing task_id (call CreateTask first). The user monitors it with /groups.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, worker_role: { type: 'string' } },
      required: ['task_id'],
    },
  },
]
const ORCH_TOOL_NAMES = new Set(ORCH_TOOL_SPECS.map((s) => s.name))
const TRACKED_MUTATORS = new Set(['MultiEdit', 'Move', 'Delete'])

// ── Lazy tool loading (mirror of ide-agent) ──────────────────────
const EXTRA_BY_NAME = new Map(EXTRA_TOOL_SPECS.map((s) => [s.name, s]))
function pickExtra(names: string[]): ToolSpec[] {
  return names.map((n) => EXTRA_BY_NAME.get(n)).filter((s): s is ToolSpec => !!s)
}
const TOOL_GROUPS: Record<string, ToolSpec[]> = {
  git: pickExtra(['GitStatus', 'GitDiff', 'GitLog', 'GitBranch', 'GitConfigGet', 'GitConfigSet', 'GitRemoteGet', 'GitRemoteSet', 'GitAdd', 'GitCommit', 'GitPush', 'GitPull', 'GitCheckout', 'SwitchGitAccount', 'SaveGitProfile', 'ListGitProfiles']),
  github: pickExtra(['GitHubAuthStatus', 'GitHubAuthSwitch', 'GitHubLogin', 'ListPRs', 'ViewPR', 'ListIssues', 'CreatePR', 'CommentIssue']),
  web: pickExtra(['WebFetch', 'WebSearch', 'Research']),
  memory: pickExtra(['RememberNote', 'RecallNotes']),
  background: pickExtra(['BashBackground', 'BashOutput', 'KillBash']),
  excel: EXCEL_TOOL_SPECS,
}
const GROUP_BLURBS: Record<string, string> = {
  git: 'git (status/diff/commit/push/branch/checkout/config/account)',
  github: 'github (pull requests & issues via gh)',
  web: 'web (WebFetch, WebSearch)',
  memory: 'memory (remember/recall notes)',
  background: 'background (long-running commands)',
  excel: 'excel (create/read/edit .xlsx: sheets, ranges, formulas, formatting)',
}
const LOAD_GROUP_SPEC: ToolSpec = {
  name: 'LoadToolGroup',
  description:
    'Enable an extra group of tools when the task needs them (hidden until loaded, to save context). Groups: ' +
    Object.entries(GROUP_BLURBS).map(([k, v]) => `"${k}" = ${v}`).join('; ') +
    '. Call group=<name> then use its tools. Load only what you need.',
  input_schema: { type: 'object', properties: { group: { type: 'string', enum: Object.keys(TOOL_GROUPS) } }, required: ['group'] },
}
const TODO_SPEC = EXTRA_BY_NAME.get('TodoWrite')

// Core tools sent every turn (Discord). Heavy families load via LoadToolGroup.
function coreSpecs(allowBash: boolean, orchEnabled: boolean): ToolSpec[] {
  const specs: ToolSpec[] = [...FILE_TOOL_SPECS.filter((s) => allowBash || s.name !== 'Bash')]
  if (TODO_SPEC) specs.push(TODO_SPEC)
  specs.push(REPORT_BLOCKED_SPEC, LOAD_GROUP_SPEC)
  if (orchEnabled) specs.push(...ORCH_TOOL_SPECS)
  return specs
}

// Sensitive-action approval: runExtraTool calls confirm() for gated tools; we
// post Approve/Decline buttons and resolve via the button interaction.
const pendingActions = new Map<string, (approved: boolean) => void>()
let actionCounter = 0

type DiffRow = { kind: 'context' | 'add' | 'del'; text: string }
function computeLineDiff(before: string, after: string): DiffRow[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n')
  const n = a.length, m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const rows: DiffRow[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ kind: 'context', text: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push({ kind: 'del', text: a[i] }); i++ }
    else { rows.push({ kind: 'add', text: b[j] }); j++ }
  }
  while (i < n) { rows.push({ kind: 'del', text: a[i] }); i++ }
  while (j < m) { rows.push({ kind: 'add', text: b[j] }); j++ }
  return rows
}

// Render a compact unified-ish diff as a Discord ```diff block (capped).
function renderDiff(before: string, after: string): { block: string; added: number; removed: number } {
  const rows = computeLineDiff(before, after)
  let added = 0, removed = 0
  const out: string[] = []
  for (const r of rows) {
    if (r.kind === 'add') { added++; out.push('+' + r.text) }
    else if (r.kind === 'del') { removed++; out.push('-' + r.text) }
    else out.push(' ' + r.text)
  }
  let body = out.join('\n')
  if (body.length > 1700) body = body.slice(0, 1700) + '\n… (truncated)'
  return { block: '```diff\n' + body + '\n```', added, removed }
}

function estimateCost(inTok: number, outTok: number, pc: ProviderCfg): number {
  if (pc.price_in == null && pc.price_out == null) return 0
  return (inTok / 1e6) * Number(pc.price_in ?? 0) + (outTok / 1e6) * Number(pc.price_out ?? 0)
}

// Flatten one message (OpenAI or Anthropic shape) to a plain "role: text" line
// for /compact — avoids replaying structured tool-call history to the model.
function messageToText(m: any): string {
  const role = m?.role || '?'
  let text = ''
  if (typeof m?.content === 'string') text = m.content
  else if (Array.isArray(m?.content)) {
    text = m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
    const tools = m.content.filter((b: any) => b?.type === 'tool_use').map((b: any) => `[tool ${b.name}]`).join(' ')
    if (tools) text += ' ' + tools
  }
  if (Array.isArray(m?.tool_calls)) text += ' ' + m.tool_calls.map((t: any) => `[tool ${t.function?.name}]`).join(' ')
  return text.trim() ? `${role}: ${text.trim()}` : ''
}

function agentSystemPrompt(ws: string, orchEnabled: boolean, planMode: boolean): string {
  if (planMode) {
    return [
      'You are a coding agent in PLAN MODE over Discord.',
      `Workspace root: ${ws}`,
      'You may ONLY investigate: Read, Grep, Glob, ListDir, GetDiagnostics, read-only git, WebFetch/WebSearch. Do NOT modify anything.',
      'Research the request thoroughly, then call PresentPlan with the full step-by-step plan (files to change, key decisions, how to verify).',
      'Do NOT call PresentPlan until the plan is final. Keep prose short.',
    ].join('\n')
  }
  return [
    'You are a coding agent operating on the user\'s workspace over Discord.',
    `Workspace root: ${ws}`,
    'File tools: Read, Write, Edit, MultiEdit, Grep, Glob, ListDir, Move, Delete, NotebookEdit, DownloadFile' + '. Use them to inspect and modify files directly.',
    'After editing code, run GetDiagnostics to typecheck/lint and fix any errors before finishing.',
    'Extra tool groups are NOT loaded by default (to save context): git, github (PRs/issues), web (WebFetch/WebSearch), memory (remember/recall notes), background (long commands), excel (create/read/edit .xlsx). When the task needs one, call LoadToolGroup(group) FIRST, then use its tools. Sensitive git actions ask you to approve before running.',
    'TodoWrite: post a short plan/checklist for multi-step work.',
    orchEnabled ? 'For large multi-step work, CreateTask then CreateGroup to hand it to autonomous worker+reviewer agents.' : '',
    'Make MINIMAL, targeted edits. Prefer Edit/MultiEdit over rewriting whole files with Write.',
    'File changes are auto-applied to disk and the user sees the diff in Discord — you do not need to paste code back.',
    'Keep prose short (this is a chat). Explain what you changed in one or two sentences.',
    'If the request cannot be done, call ReportBlocked with a concrete reason.',
  ].filter(Boolean).join('\n')
}

// A channel poster: plain text + a rich send (with components) that returns the
// sent Message so we can clear its buttons after a decision.
interface Post {
  text: (content: string) => Promise<unknown>
  // Returns the sent Message (typed loosely so we can .edit() off its buttons).
  rich: (content: string, components: unknown[]) => Promise<any>
}

async function runAgentTurn(post: Post, session: AgentSession, userText: string, channelId: string): Promise<void> {
  const send = post.text
  const { discord, providers, orch, modelFor } = loadConfig()
  const pc = providers[discord.agent_provider]
  if (!discord.agent_provider || !pc) { await send('⚠️ Chưa cấu hình provider/model cho agent (Settings → Discord).'); return }
  // Per-channel /model override wins over the configured default.
  const model = session.model || discord.agent_model || pc.models?.[0] || ''
  if (!model) { await send('⚠️ Chưa chọn model cho agent (Settings → Discord).'); return }
  const ws = workspaceRoot()
  if (!ws || !fs.existsSync(ws)) { await send('⚠️ Chưa mở workspace.'); return }
  const key = process.env[keyEnvName(discord.agent_provider)] || ''
  const isLocal = (pc.base_url || '').includes('localhost')
  if (!key && !isLocal) {
    await send(`⚠️ Provider **${discord.agent_provider}** chưa có API key (hoặc bot chưa nhận key mới). Vào Settings → nhập key cho provider đó rồi thử lại.`)
    return
  }

  // Plan mode = curated read-only set; normal = core + LoadToolGroup (lazy).
  let activeSpecs: ToolSpec[]
  if (session.planMode) {
    const all = [
      ...FILE_TOOL_SPECS.filter((s) => discord.allow_agent_bash || s.name !== 'Bash'),
      ...EXTRA_TOOL_SPECS, REPORT_BLOCKED_SPEC,
      ...(orch.enabled ? ORCH_TOOL_SPECS : []),
    ]
    activeSpecs = all.filter((s) => PLAN_READONLY.has(s.name))
    activeSpecs.push(PRESENT_PLAN_SPEC)
  } else {
    activeSpecs = coreSpecs(discord.allow_agent_bash, orch.enabled)
  }
  let adapter = buildAdapter(pc, key, model, activeSpecs)
  const loadedGroups = new Set<string>()
  const system = agentSystemPrompt(ws, orch.enabled, session.planMode)

  // Confirmation gate for sensitive extra tools: post buttons, await the click.
  const confirm = async (action: { tool: string; title: string; detail: string }): Promise<boolean> => {
    const actionId = `act-${++actionCounter}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`extra-ok:${actionId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`extra-no:${actionId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    )
    const msg = await post.rich(`⚠️ Agent muốn: **${action.title}**\n\`${action.detail}\``.slice(0, 1900), [row])
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (v: boolean) => { if (settled) return; settled = true; pendingActions.delete(actionId); resolve(v) }
      pendingActions.set(actionId, done)
      setTimeout(() => { if (pendingActions.has(actionId)) { done(false); try { void msg?.edit?.({ components: [] }) } catch { /* ignore */ } } }, 90_000)
    })
  }

  session.cancel = false
  session.messages.push({ role: 'user', content: userText })
  const changed = new Set<string>()

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    if (session.cancel) { session.cancel = false; await send('🛑 Đã dừng.'); return }
    let res
    try {
      res = await adapter.chat(session.messages, system)
    } catch (e) {
      await send(`❌ Lỗi provider: ${(e as Error).message}`)
      return
    }
    const { text, toolCalls, assistantMsg, usage } = res
    session.turns++
    session.tokensIn += usage.input
    session.tokensOut += usage.output
    db.addUsage({
      ts: db.nowStampLocal(), role: 'discord-agent', model,
      tokens_in: usage.input, tokens_out: usage.output,
      cost_usd: estimateCost(usage.input, usage.output, pc), task_id: null,
    })

    if (toolCalls.length === 0) {
      session.messages.push(assistantMsg)
      if (text.trim()) await send(text.slice(0, 1900))
      if (changed.size) await send(`📝 File đã đổi: ${[...changed].join(', ')}`.slice(0, 1900))
      return
    }

    const results: string[] = []
    for (const call of toolCalls) {
      if (session.cancel) { session.cancel = false; session.messages.push(assistantMsg); await send('🛑 Đã dừng.'); return }
      if (call.name === 'ReportBlocked') {
        const reason = String((call.args as { reason?: string }).reason || '').trim() || 'no reason'
        session.messages.push(assistantMsg)
        await send(`🚧 Bị chặn: ${reason}`.slice(0, 1900))
        return
      }
      if (call.name === 'PresentPlan') {
        const plan = String((call.args as { plan?: string }).plan || '').trim() || '(empty plan)'
        session.messages.push(assistantMsg)
        session.pendingPlan = plan
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`plan-approve:${channelId}`).setLabel('Approve & Run').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`plan-dismiss:${channelId}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
        )
        await post.rich(`📋 **Plan**\n${plan}`.slice(0, 1900), [row])
        return
      }
      const args = call.args as Record<string, unknown>
      let result: string
      if (call.name === 'LoadToolGroup') {
        const g = String((args as { group?: string }).group || '')
        const grp = TOOL_GROUPS[g]
        if (!grp) result = `error: unknown group "${g}". Available: ${Object.keys(TOOL_GROUPS).join(', ')}`
        else if (loadedGroups.has(g)) result = `group "${g}" already loaded`
        else {
          loadedGroups.add(g)
          activeSpecs = [...activeSpecs, ...grp]
          adapter = buildAdapter(pc, key, model, activeSpecs) // rebuild with new tools
          result = `loaded ${grp.length} ${g} tools: ${grp.map((s) => s.name).join(', ')}`
        }
        await send(`🧩 LoadToolGroup: ${g}`.slice(0, 200))
      } else if (call.name === 'Write' || call.name === 'Edit') {
        const preview = call.name === 'Write'
          ? previewWrite(ws, args as { path: string; content: string })
          : previewEdit(ws, args as { path: string; old_string: string; new_string: string; replace_all?: boolean })
        if (typeof preview === 'string') {
          result = preview
          await send(`⚠️ ${call.name} ${String(args.path || '')}: ${preview}`.slice(0, 1900))
        } else {
          applyChange(ws, preview.path, preview.after)
          changed.add(preview.path)
          session.changed.add(preview.path)
          if (preview.isNew) session.created.add(preview.path)
          const { block, added, removed } = renderDiff(preview.before, preview.after)
          const head = `${preview.isNew ? '🆕' : '✏️'} **${preview.path}** (+${added} −${removed})`
          await send(`${head}\n${block}`.slice(0, 1950))
          result = `applied: ${preview.note}`
        }
      } else if (TRACKED_MUTATORS.has(call.name)) {
        // MultiEdit / Move / Delete: apply via runFileTool but capture a diff /
        // note and record for /undo so nothing changes silently.
        result = await runTrackedMutation(ws, call.name, args, session, changed, post)
      } else if (EXCEL_TOOL_NAMES.has(call.name)) {
        const p = typeof args.path === 'string' ? args.path : ''
        const existedBefore = !!p && fs.existsSync(path.resolve(ws, p))
        try {
          const r = await runExcelTool(ws, call.name, args)
          result = r == null ? `error: unknown tool ${call.name}` : r
        } catch (e) {
          result = `error: ${(e as Error).message}`
        }
        if (!result.startsWith('error') && p && EXCEL_MUTATORS.has(call.name)) {
          changed.add(p); session.changed.add(p)
          if (!existedBefore) session.created.add(p)
        }
        await send(`📊 ${call.name} ${p}`.slice(0, 300))
      } else if (EXTRA_TOOL_NAMES.has(call.name)) {
        try {
          const r = await runExtraTool(call.name, args, {
            cwd: ws,
            confirm,
            emitTodos: (todos) => {
              const body = todos.map((t) => `${t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'} ${t.content}`).join('\n')
              void post.text(`📋 **Plan**\n${body}`.slice(0, 1900)).catch(() => {})
            },
          })
          result = r == null ? `error: unknown tool ${call.name}` : r
        } catch (e) {
          result = `error: ${(e as Error).message}`
        }
        if (call.name !== 'TodoWrite') {
          const icon = call.name.startsWith('Git') ? '🔧' : call.name.startsWith('Web') ? '🌐' : call.name.includes('Bash') ? '⚙️' : '•'
          await send(`${icon} ${call.name} → ${result.slice(0, 200)}`.slice(0, 400))
        }
      } else if (ORCH_TOOL_NAMES.has(call.name)) {
        result = await runOrchTool(call.name, args, orch, discord, modelFor, post)
      } else {
        try {
          const r = await runFileTool(ws, call.name, args)
          result = r == null ? `error: unknown tool ${call.name}` : r
        } catch (e) {
          result = `error: ${(e as Error).message}`
        }
        // Track the new file-mutating tools so /undo covers them.
        if (!result.startsWith('error') && typeof args.path === 'string') {
          if (call.name === 'NotebookEdit') { session.changed.add(args.path); changed.add(args.path) }
          else if (call.name === 'DownloadFile') { session.created.add(args.path); changed.add(args.path) }
        }
        const label = String(args.path || args.pattern || args.command || args.tool || args.url || '').slice(0, 80)
        const icon = call.name === 'Read' ? '📖' : call.name === 'Grep' ? '🔎' : call.name === 'Glob' ? '🗂️' : call.name === 'ListDir' ? '📁' : call.name === 'GetDiagnostics' ? '🩺' : call.name === 'NotebookEdit' ? '📓' : call.name === 'DownloadFile' ? '⬇️' : call.name === 'Bash' ? '⚙️' : '•'
        await send(`${icon} ${call.name} ${label}`.slice(0, 300))
      }
      results.push(result)
    }
    session.messages.push(assistantMsg)
    for (const m of adapter.toolResultsMessages(toolCalls, results)) session.messages.push(m)
  }
  await send('⏱️ Đã đạt giới hạn số bước cho lượt này.')
}

// Apply MultiEdit/Move/Delete via runFileTool, but capture a diff/note and
// record the change on the session so /undo covers it (Write/Edit already do).
async function runTrackedMutation(
  ws: string, name: string, args: Record<string, unknown>,
  session: AgentSession, changed: Set<string>, post: Post,
): Promise<string> {
  const readFile = (rel: string): string => { try { return fs.readFileSync(path.resolve(ws, rel), 'utf-8') } catch { return '' } }
  const run = async (): Promise<string> => { try { return (await runFileTool(ws, name, args)) ?? `error: unknown tool ${name}` } catch (e) { return `error: ${(e as Error).message}` } }

  if (name === 'MultiEdit') {
    const p = String(args.path || '')
    const before = readFile(p)
    const result = await run()
    if (result.startsWith('error')) { await post.text(`⚠️ MultiEdit ${p}: ${result}`.slice(0, 1900)); return result }
    session.changed.add(p); changed.add(p)
    const { block, added, removed } = renderDiff(before, readFile(p))
    await post.text(`✏️ **${p}** (+${added} −${removed})\n${block}`.slice(0, 1950))
    return result
  }
  if (name === 'Move') {
    const from = String(args.from || ''); const to = String(args.to || '')
    const result = await run()
    if (result.startsWith('error')) { await post.text(`⚠️ Move ${from}→${to}: ${result}`.slice(0, 1900)); return result }
    session.changed.add(from); session.created.add(to); changed.add(to)
    await post.text(`🔀 **${from}** → **${to}**`.slice(0, 400))
    return result
  }
  // Delete
  const p = String(args.path || '')
  const result = await run()
  if (result.startsWith('error')) { await post.text(`⚠️ Delete ${p}: ${result}`.slice(0, 1900)); return result }
  session.changed.add(p); changed.add(p) // git checkout HEAD restores it on /undo if tracked
  await post.text(`🗑️ Deleted **${p}**`.slice(0, 400))
  return result
}

// CreateTask / CreateGroup: same DB-bus path as /vibe. Gated on orchestration.
async function runOrchTool(
  name: string, args: Record<string, unknown>,
  orch: OrchestrationConfig, discord: DiscordConfig,
  modelFor: (role: string) => string | null, post: Post,
): Promise<string> {
  if (!orch.enabled) return 'error: orchestration is disabled — enable it in Settings to hand work to groups'
  if (name === 'CreateTask') {
    const title = String(args.title || '').trim()
    if (!title) return 'error: title required'
    const owner = String(args.owner || discord.default_worker_role)
    const id = db.createTask({ title, owner, priority: (args.priority as 'low' | 'medium' | 'high') || 'medium' })
    await post.text(`🗂️ Task **${id}**: ${title}`.slice(0, 400))
    return `created task ${id}`
  }
  // CreateGroup
  const taskId = String(args.task_id || '').trim()
  if (!taskId) return 'error: task_id required'
  if (!db.getTask(taskId)) return `error: task ${taskId} not found (call CreateTask first)`
  const role = String(args.worker_role || discord.default_worker_role)
  const gid = db.createGroup(resolveGroupParams(taskId, role, orch, modelFor))
  await post.text(`🚀 Group **${gid}** cho ${taskId} (theo dõi: /groups)`.slice(0, 400))
  return `created group ${gid} for ${taskId}`
}

async function handleAgentStart(i: ChatInputCommandInteraction) {
  const { discord, providers } = loadConfig()
  if (!discord.agent_provider || !providers[discord.agent_provider]) {
    await i.reply({ content: '⚠️ Chưa chọn provider/model cho agent trong Settings → Discord.', flags: MessageFlags.Ephemeral })
    return
  }
  if (!workspaceRoot()) { await i.reply({ content: '⚠️ Chưa mở workspace.', flags: MessageFlags.Ephemeral }); return }
  agentSessions.set(i.channelId, newSession())
  await i.reply('🤖 Agent đã bật ở channel này. Cứ nhắn bình thường để chat / sửa code. Gõ `/agent-end` để tắt.')
}

async function handleAgentEnd(i: ChatInputCommandInteraction) {
  const had = agentSessions.delete(i.channelId)
  await i.reply(had ? '🛑 Agent đã tắt ở channel này.' : 'Agent chưa bật ở channel này.')
}

// All the commands below operate on the active /agent session in the channel.
async function replyNoSession(i: ChatInputCommandInteraction) {
  await i.reply({ content: '⚠️ Chưa bật `/agent` ở channel này.', flags: MessageFlags.Ephemeral })
}

async function handleCompact(i: ChatInputCommandInteraction) {
  const session = agentSessions.get(i.channelId)
  if (!session) { await replyNoSession(i); return }
  if (session.messages.length === 0) { await i.reply({ content: 'Chưa có hội thoại để nén.', flags: MessageFlags.Ephemeral }); return }
  if (session.busy) { await i.reply({ content: '⏳ Đang xử lý lượt khác, thử lại sau.', flags: MessageFlags.Ephemeral }); return }
  const { discord, providers } = loadConfig()
  const pc = providers[discord.agent_provider]
  if (!pc) { await i.reply({ content: '⚠️ Chưa cấu hình provider.', flags: MessageFlags.Ephemeral }); return }
  const model = session.model || discord.agent_model || pc.models?.[0] || ''
  const key = process.env[keyEnvName(discord.agent_provider)] || ''
  await i.deferReply()
  session.busy = true
  try {
    const transcript = session.messages.map(messageToText).filter(Boolean).join('\n').slice(0, 12000)
    const adapter = buildAdapter(pc, key, model, [])
    const res = await adapter.chat(
      [{ role: 'user', content: `Summarize this coding conversation into a concise memo: the goal, key decisions, files changed, and what to do next. Output only the summary.\n\n${transcript}` }],
      'You are a concise technical summarizer.',
    )
    const summary = res.text.trim() || '(empty)'
    const n = session.messages.length
    session.messages = [{ role: 'user', content: 'Summary of earlier conversation:\n' + summary }]
    db.addUsage({
      ts: db.nowStampLocal(), role: 'discord-agent', model,
      tokens_in: res.usage.input, tokens_out: res.usage.output,
      cost_usd: estimateCost(res.usage.input, res.usage.output, pc), task_id: null,
    })
    await i.editReply(`🧭 Đã nén hội thoại (${n} tin → tóm tắt).`)
  } catch (e) {
    await i.editReply(`❌ Nén thất bại: ${(e as Error).message}`)
  } finally {
    session.busy = false
  }
}

async function handleModel(i: ChatInputCommandInteraction) {
  const session = agentSessions.get(i.channelId)
  if (!session) { await replyNoSession(i); return }
  const { discord, providers } = loadConfig()
  const pc = providers[discord.agent_provider]
  const models = pc?.models ?? []
  const wanted = i.options.getString('model', true)
  if (!models.includes(wanted)) {
    await i.reply({ content: `⚠️ Model không hợp lệ cho provider **${discord.agent_provider}**. Khả dụng: ${models.join(', ') || '(none)'}`.slice(0, 1900), flags: MessageFlags.Ephemeral })
    return
  }
  session.model = wanted
  await i.reply(`✅ Model cho channel này: **${wanted}**`)
}

async function handleModels(i: ChatInputCommandInteraction) {
  const { discord, providers } = loadConfig()
  const pc = providers[discord.agent_provider]
  const session = agentSessions.get(i.channelId)
  const active = session?.model || discord.agent_model || pc?.models?.[0] || '(none)'
  const models = pc?.models ?? []
  const list = models.map((m) => (m === active ? `• **${m}** ← đang dùng` : `• ${m}`)).join('\n')
  await i.reply({
    content: `Provider: **${discord.agent_provider || '(chưa chọn)'}**\n${list || '(không có model)'}`.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  })
}

async function handleReset(i: ChatInputCommandInteraction) {
  const session = agentSessions.get(i.channelId)
  if (!session) { await replyNoSession(i); return }
  session.messages = []
  await i.reply('🧹 Đã xoá lịch sử hội thoại (agent vẫn bật).')
}

async function handleStop(i: ChatInputCommandInteraction) {
  const session = agentSessions.get(i.channelId)
  if (!session) { await replyNoSession(i); return }
  if (!session.busy) { await i.reply({ content: 'Không có lượt nào đang chạy.', flags: MessageFlags.Ephemeral }); return }
  session.cancel = true
  await i.reply('🛑 Đang dừng lượt hiện tại…')
}

async function handleDiscordPlan(i: ChatInputCommandInteraction) {
  const session = agentSessions.get(i.channelId)
  if (!session) { await replyNoSession(i); return }
  session.planMode = !session.planMode
  session.pendingPlan = undefined
  await i.reply(session.planMode
    ? '🧭 Plan mode BẬT: agent chỉ khảo sát (read-only) rồi trình plan để bạn Approve. Gõ `/plan` lần nữa để tắt.'
    : '✅ Plan mode tắt — agent sửa file trực tiếp lại.')
}

async function handleContext(i: ChatInputCommandInteraction) {
  const session = agentSessions.get(i.channelId)
  if (!session) { await replyNoSession(i); return }
  const { discord, providers } = loadConfig()
  const model = session.model || discord.agent_model || providers[discord.agent_provider]?.models?.[0] || '(none)'
  await i.reply({
    content: `📊 **Session**\nModel: **${model}**\nLượt: ${session.turns} · tokens in/out: ${session.tokensIn}/${session.tokensOut}\nTin nhắn giữ: ${session.messages.length} · file đã đổi: ${session.changed.size}`,
    flags: MessageFlags.Ephemeral,
  })
}

async function handleUndo(i: ChatInputCommandInteraction) {
  const session = agentSessions.get(i.channelId)
  if (!session) { await replyNoSession(i); return }
  const ws = workspaceRoot()
  if (!ws) { await i.reply({ content: '⚠️ Chưa mở workspace.', flags: MessageFlags.Ephemeral }); return }
  const created = session.created
  const tracked = [...session.changed].filter((f) => !created.has(f))
  if (session.changed.size === 0) { await i.reply({ content: 'Không có file nào đã sửa trong session.', flags: MessageFlags.Ephemeral }); return }
  await i.deferReply()
  if (tracked.length) await execGit(['checkout', 'HEAD', '--', ...tracked], ws)
  let deleted = 0
  for (const f of created) {
    const abs = resolveInWorkspace(ws, f)
    if (abs) { try { fs.rmSync(abs); deleted++ } catch { /* ignore */ } }
  }
  session.changed.clear(); session.created.clear()
  await i.editReply(`↩️ Đã hoàn tác: ${tracked.length} file khôi phục, ${deleted} file mới xoá.`)
}

// ── client ────────────────────────────────────────────────────────
// GuildMessages + MessageContent are needed for conversational /agent mode
// (reading normal messages in an activated channel). MessageContent is a
// privileged intent — it must be enabled in the Discord Developer Portal.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.once('clientReady', async () => {
  const { discord } = loadConfig()
  console.log(`[discord] ready as ${client.user?.tag}`)
  try {
    await registerCommands(client.application!.id, discord.guild_id)
  } catch (e) {
    console.error('[discord] command registration failed:', (e as Error).message)
  }
})

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { discord } = loadConfig()
      if (!isAuthorized(interaction.user.id, interaction.channelId, discord)) {
        await interaction.reply({ content: '⛔ Không có quyền.', flags: MessageFlags.Ephemeral })
        return
      }
      switch (interaction.commandName) {
        case 'vibe': return void handleVibe(interaction)
        case 'browse': return void handleBrowse(interaction)
        case 'tasks': return void handleTasks(interaction)
        case 'groups': return void handleGroups(interaction)
        case 'kill': return void handleKill(interaction)
        case 'cost': return void handleCost(interaction)
        case 'status': return void handleStatus(interaction)
        case 'agent': return void handleAgentStart(interaction)
        case 'agent-end': return void handleAgentEnd(interaction)
        case 'compact': return void handleCompact(interaction)
        case 'model': return void handleModel(interaction)
        case 'models': return void handleModels(interaction)
        case 'reset': return void handleReset(interaction)
        case 'stop': return void handleStop(interaction)
        case 'context': return void handleContext(interaction)
        case 'undo': return void handleUndo(interaction)
        case 'plan': return void handleDiscordPlan(interaction)
      }
    } else if (interaction.isStringSelectMenu() && interaction.customId === 'browse') {
      return void handleBrowseSelect(interaction)
    } else if (interaction.isButton() && interaction.customId.startsWith('vibe-kill:')) {
      return void handleVibeKill(interaction)
    } else if (interaction.isButton() && (interaction.customId.startsWith('plan-approve:') || interaction.customId.startsWith('plan-dismiss:'))) {
      const { discord } = loadConfig()
      if (!isAuthorized(interaction.user.id, interaction.channelId, discord)) {
        await interaction.reply({ content: 'Không có quyền.', flags: MessageFlags.Ephemeral }); return
      }
      const approve = interaction.customId.startsWith('plan-approve:')
      const channelId = interaction.customId.split(':')[1]
      const session = agentSessions.get(channelId)
      await interaction.update({ content: approve ? '✅ Plan approved — đang chạy…' : '🚫 Đã bỏ plan.', components: [] })
      if (!session) return
      if (!approve) { session.pendingPlan = undefined; return }
      const plan = session.pendingPlan
      session.pendingPlan = undefined
      session.planMode = false // execute in normal agent mode
      if (!plan || session.busy) return
      const channel = interaction.channel
      if (!channel?.isSendable()) return
      session.busy = true
      const post: Post = { text: (c) => channel.send(c), rich: (c, comp) => channel.send({ content: c, components: comp as never }) }
      try {
        await runAgentTurn(post, session, `Implement this approved plan, following it step by step:\n\n${plan}`, channelId)
      } catch (e) {
        await post.text(`❌ ${(e as Error).message}`.slice(0, 1900)).catch(() => {})
      } finally {
        session.busy = false
      }
      return
    } else if (interaction.isButton() && (interaction.customId.startsWith('extra-ok:') || interaction.customId.startsWith('extra-no:'))) {
      const { discord } = loadConfig()
      if (!isAuthorized(interaction.user.id, interaction.channelId, discord)) {
        await interaction.reply({ content: 'Không có quyền.', flags: MessageFlags.Ephemeral }); return
      }
      const approved = interaction.customId.startsWith('extra-ok:')
      const resolver = pendingActions.get(interaction.customId.split(':')[1])
      if (resolver) resolver(approved)
      await interaction.update({ content: approved ? '✅ Approved' : '🚫 Declined', components: [] })
      return
    }
  } catch (e) {
    console.error('[discord] interaction error:', (e as Error).message)
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `Lỗi: ${(e as Error).message}`, flags: MessageFlags.Ephemeral })
      }
    } catch { /* ignore */ }
  }
})

// Conversational agent: messages in an activated channel drive the tool loop.
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return
    const session = agentSessions.get(message.channelId)
    if (!session) return
    const { discord } = loadConfig()
    if (!isAuthorized(message.author.id, message.channelId, discord)) return
    let content = (message.content || '').trim()
    content = await ingestAttachments(message, content)
    if (!content) return
    if (!message.channel.isSendable()) return
    if (session.busy) { message.react('⏳').catch(() => {}) ; return }
    session.busy = true
    const channel = message.channel
    const post: Post = {
      text: (c) => channel.send(c),
      rich: (c, components) => channel.send({ content: c, components: components as never }),
    }
    if ('sendTyping' in channel) { channel.sendTyping().catch(() => {}) }
    try {
      await runAgentTurn(post, session, content, message.channelId)
    } catch (e) {
      await post.text(`❌ ${(e as Error).message}`.slice(0, 1900)).catch(() => {})
    } finally {
      session.busy = false
    }
  } catch (e) {
    console.error('[discord] messageCreate error:', (e as Error).message)
  }
})

function shutdown() {
  try { client.destroy() } catch { /* ignore */ }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.login(token).catch((e) => {
  console.error('[discord] login failed:', (e as Error).message)
  process.exit(1)
})
