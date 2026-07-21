// ChatPanel.tsx — an in-editor coding assistant chat.
//
// Reuses the same providers/keys as the agents and the inline "Ask AI" edit.
// Streams responses token-by-token over the ai-chat IPC channel and can inject
// the currently open file (+ selection) as context so the model can reason
// about the code the user is looking at.

import { memo, useEffect, useRef, useState, ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Sparkles, Send, Square, Trash2, FileCode,
  FileText, FilePen, FilePlus2, Search, FolderSearch, Wrench, CheckCircle2, XCircle, ShieldCheck,
  TerminalSquare, ListPlus, Boxes, Undo2, AlertTriangle,
  GitBranch, GitCommitHorizontal, GitPullRequestArrow, UserCog, Globe, ListChecks, FolderTree, Trash, FileInput,
  History, Plus, Archive, Telescope, Copy, Check, ArrowDown, Pencil, AtSign,
  ChevronRight, Loader2,
} from 'lucide-react'
import { ModelOption, IdeAgentEvent, PendingChange, PendingAction, AgentTodo, AgentSessionMeta } from '../lib/api'
import { useUiSettings } from '../lib/uiSettings'

// Slash commands available in agent mode. Typing "/" pops up a filtered menu.
const AGENT_SLASH_COMMANDS: { name: string; desc: string }[] = [
  { name: '/plan', desc: 'Toggle plan mode (investigate read-only, then approve a plan)' },
  { name: '/research', desc: 'Toggle research mode (deep read-only web + code → a cited answer)' },
  { name: '/compact', desc: 'Summarize the conversation to save context' },
  { name: '/new', desc: 'Start a fresh session (clear history)' },
  { name: '/review', desc: 'Toggle review mode (approve each change)' },
  { name: '/stop', desc: 'Stop the current run' },
]

export interface ChatContext {
  path: string
  language?: string
  content: string
  selection?: string
}

interface Msg {
  role: 'user' | 'assistant'
  content: string
}

// A tool activity entry shown inline in the Agent transcript.
interface ToolEntry {
  kind: 'tool'
  callId: string
  name: string
  args: Record<string, unknown>
  result?: string
  isError?: boolean
  running: boolean
}

// A delegated child agent, rendered as a nested live card in the transcript.
interface SubAgentEntry {
  kind: 'subagent'
  childRunId: string
  label: string
  task: string
}

type AgentItem =
  | { kind: 'text'; id?: string; role: 'user' | 'assistant'; content?: string; chunks?: string[] }
  | { kind: 'reasoning'; id: string; chunks?: string[]; content?: string }
  | ToolEntry
  | SubAgentEntry

// Revealed text of an item, whether it stores whole content or streamed chunks.
function itemText(it: AgentItem): string {
  if (it.kind === 'text' || it.kind === 'reasoning') {
    if (it.chunks) return it.chunks.join('')
    return it.content ?? ''
  }
  return ''
}

// Per-tool result budget when folding tool activity into cross-turn history.
const TOOL_RESULT_BUDGET = 800

// Transcript items rendered by default; older ones sit behind "Show earlier"
// so a long session doesn't keep hundreds of markdown blocks in the DOM.
const RENDER_CAP = 150

// Some models imitate the internal tool-log format (they see prior tool
// activity in history and start pasting "[used Tool] → result" and element
// refs like [e30] straight into their visible reply). Strip those machine
// artifacts — they are never something the model should be speaking, so
// removing them is safe for real prose while cleaning up the leak and
// stopping it from compounding back into the next turn's history.
function stripToolEcho(text: string): string {
  if (!text.includes('[used ') && !/\[e\d+\]/.test(text)) return text
  return text
    .replace(/\[used [^\]\n]*\]\s*(?:→|->)?[ \t]*/g, '') // "[used BrowserClick] → "
    .replace(/\[e\d+\]\s*/g, '')                          // element refs "[e30] "
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// One-line summary of a tool call's target (path/pattern/command/…).
function toolTarget(t: ToolEntry): string {
  const a = t.args as Record<string, unknown>
  const first = a.path || a.pattern || a.command || a.url || a.query || a.branch
    || a.profile || a.from || a.title || a.task_id || a.account || a.job_id || ''
  return typeof first === 'string' ? first : ''
}

// Build the conversation history for a NEW turn, preserving what the agent
// learned in earlier turns. Text items map to their role message; tool activity
// is folded (compactly) into the assistant side so knowledge gathered by
// Read/Grep/Glob/etc. survives across turns instead of being discarded. Without
// this the agent "forgets" a folder it just scanned and re-scans on every turn.
// Approximate chars an item contributes to the history sent to the model.
function historyCost(it: AgentItem): number {
  if (it.kind === 'text') return itemText(it).length
  if (it.kind === 'tool') return 64 + Math.min(it.result?.length ?? 0, TOOL_RESULT_BUDGET)
  return 0 // reasoning is never sent
}

// Total history budget (~12k tokens). Long-lived sessions used to send their
// ENTIRE transcript every turn until the prompt overflowed the context window
// and the provider started truncating/dropping replies.
const HISTORY_CHAR_BUDGET = 48_000

function buildHistory(items: AgentItem[]): Msg[] {
  // Keep the NEWEST items that fit the budget; drop the oldest beyond it.
  let kept = items
  let trimmed = false
  let total = 0
  for (let i = items.length - 1; i >= 0; i--) {
    total += historyCost(items[i])
    if (total > HISTORY_CHAR_BUDGET) {
      kept = items.slice(i + 1)
      trimmed = true
      break
    }
  }
  const out: Msg[] = []
  // Append a line, coalescing into the previous message if it shares the role.
  // Keeps roles strictly alternating (required by Anthropic and friends).
  const push = (role: 'user' | 'assistant', line: string) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content += (last.content ? '\n' : '') + line
    else out.push({ role, content: line })
  }
  // Tool activity is fed back in the USER voice (framed as reference), NOT the
  // assistant voice — otherwise the model treats the tool-log format as its own
  // speaking style and starts pasting tool results into its replies.
  let toolBuf: string[] = []
  const flushTools = () => {
    if (!toolBuf.length) return
    push('user', 'Results of tools you ran (reference only — do NOT repeat any of this in your reply):\n' + toolBuf.join('\n'))
    toolBuf = []
  }
  for (const it of kept) {
    if (it.kind === 'text') {
      if (it.role === 'user') { flushTools(); push('user', itemText(it)) }
      else {
        const content = stripToolEcho(itemText(it))
        flushTools()
        if (content.trim()) push('assistant', content)
      }
    } else if (it.kind === 'tool') {
      const target = toolTarget(it)
      const head = `• ${it.name}${target ? ` (${target})` : ''}`
      let body = ''
      if (it.result) {
        const r = it.result.length > TOOL_RESULT_BUDGET
          ? it.result.slice(0, TOOL_RESULT_BUDGET) + ' …(truncated)'
          : it.result
        body = it.isError ? ` → error: ${r}` : ` → ${r}`
      }
      toolBuf.push(head + body)
    }
  }
  flushTools()
  if (trimmed) {
    // Tell the model (and keep roles starting with 'user' for Anthropic).
    const note = '[Earlier conversation was trimmed to fit the context window — use /compact for a full summary.]'
    if (out[0]?.role === 'user') out[0].content = `${note}\n${out[0].content}`
    else out.unshift({ role: 'user', content: note })
  }
  return out
}

// Flatten streamed `chunks` into stored `content` so a persisted transcript
// restores identically without the typewriter machinery. Drops the `running`
// flag from tool entries (a restored tool is always finished).
function serializeItems(items: AgentItem[]): AgentItem[] {
  return items
    // Sub-agent cards are live views of a finished child run; drop them on
    // persist (the SpawnAgent tool entry keeps the summary for history).
    .filter((it) => it.kind !== 'subagent')
    .map((it) => {
      if (it.kind === 'text') return { kind: 'text', role: it.role, content: itemText(it) }
      if (it.kind === 'reasoning') return { kind: 'reasoning', id: it.id, content: itemText(it) }
      // Tool results longer than the history budget are never read back
      // (buildHistory truncates, the UI shows 1000 chars) — don't store them.
      const t = it as ToolEntry
      return {
        ...t,
        running: false,
        result: t.result && t.result.length > 1000 ? t.result.slice(0, 1000) + ' …(truncated)' : t.result,
      }
    })
}

// Collapse finished streamed items (chunks[]) into plain `content` so old
// messages render as ONE static markdown block — no more per-render
// chunks.join + span soup once a reply is done.
function flattenFinished(items: AgentItem[]): AgentItem[] {
  return items.map((it) => {
    if ((it.kind === 'text' || it.kind === 'reasoning') && it.chunks) {
      if (it.kind === 'text') return { kind: 'text' as const, id: it.id, role: it.role, content: it.chunks.join('') }
      return { kind: 'reasoning' as const, id: it.id, content: it.chunks.join('') }
    }
    return it
  })
}

// Shorten a long file path for a one-line chip, keeping the tail (filename +
// nearest folders — the part that identifies the file). CSS truncate is the
// backstop for very narrow widths; this keeps the useful end visible.
function shortenPath(p: string, max = 44): string {
  if (p.length <= max) return p
  return '…' + p.slice(p.length - (max - 1))
}

// A short title derived from the first user message of a conversation.
function deriveTitle(items: AgentItem[]): string {
  const firstUser = items.find((it) => it.kind === 'text' && it.role === 'user') as
    | Extract<AgentItem, { kind: 'text' }>
    | undefined
  const t = (firstUser ? itemText(firstUser) : '').trim().replace(/\s+/g, ' ')
  if (!t) return 'New session'
  return t.length > 48 ? t.slice(0, 48) + '…' : t
}

interface Props {
  models: ModelOption[]
  // Provides the file context on demand (called at send time so it's fresh).
  getContext: () => ChatContext | null
  // Called when the agent writes/edits a file, so the editor can reload it.
  onFileChanged?: (relPath: string) => void
  // Review mode: the agent proposes a change and waits. IDEView shows the diff.
  onPendingChange?: (change: PendingChange) => void
  onChangeResolved?: (changeId: string) => void
  // Editor round-trip tools: the agent drives the editor via IDEView.
  onEditorRequest?: (
    op: 'OpenFile' | 'GetOpenEditor' | 'ShowDiff',
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result: string }>
  // When true, inner elements fade/slide in with a staggered "wind-up" after
  // the panel frame has slid open. When false, everything renders instantly.
  windup?: boolean
  // Whether the (always-mounted) panel is currently shown. Toggling false→true
  // replays the wind-up, matching the old mount-on-open behavior.
  visible?: boolean
  // Status-bar signals for the host IDE.
  onRunStateChange?: (busy: boolean) => void
  onContextUsage?: (u: { used: number; window: number } | null) => void
  // Fired when an agent run reaches a terminal state (for toast/badge when
  // the chat panel is closed).
  onRunFinished?: (info: { kind: 'done' | 'error' | 'blocked' | 'plan' }) => void
  // Workspace file list for @file mentions (relPaths).
  files?: string[]
  // Current workspace root — the panel reloads its session when this changes
  // (it stays mounted across workspace switches).
  workspaceRoot?: string
  // Fired when the agent spawns a child agent (so the host can surface the
  // live sub-agents sidebar panel).
  onSubAgentStarted?: () => void
}

// Wind-up choreography: the frame slides open first (handled by the parent),
// then children fade/rise in sequence. delayChildren waits for the slide.
const containerVariants = {
  hidden: {},
  show: {
    transition: { delayChildren: 0.18, staggerChildren: 0.07 },
  },
}
const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: 'easeOut' } },
}

// Memoized: the host keeps every prop referentially stable, so IDE-side state
// changes (typing, git polls, caret moves) no longer re-render the chat tree.
export const ChatPanel = memo(ChatPanelImpl)

function ChatPanelImpl({ models, getContext, onFileChanged, onPendingChange, onChangeResolved, onEditorRequest, windup = true, visible = true, onRunStateChange, onContextUsage, onRunFinished, files = [], workspaceRoot = '', onSubAgentStarted }: Props) {
  const { chatFontSize } = useUiSettings()
  const [mode, setMode] = useState<'ask' | 'agent'>('ask')
  // Plan mode is a toggle WITHIN agent mode (via /plan): runs read-only and
  // presents a plan to approve instead of editing directly.
  const [planMode, setPlanMode] = useState(false)
  // Research mode (/research): read-only deep investigation (web + code) → a
  // cited answer. Mutually exclusive with plan mode.
  const [researchMode, setResearchMode] = useState(false)
  // A plan awaiting the user's "Approve & Run". `explicit` = the agent called
  // PresentPlan; false = a plan run just ended with text (fallback).
  const [planApproval, setPlanApproval] = useState<{ text: string; explicit: boolean } | null>(null)
  const [planExpanded, setPlanExpanded] = useState(false)
  // Plan text stashed while a git-dirty warning is shown before running it.
  const pendingPlanRef = useRef<string | null>(null)
  const [reviewMode, setReviewMode] = useState(false)
  const [planWave, setPlanWave] = useState(false) // one-shot activation sweep
  // Files the current agent run has written (for the "Undo run" affordance).
  const runFilesRef = useRef<Set<string>>(new Set())
  const [lastRunFiles, setLastRunFiles] = useState<string[]>([])
  const [undoing, setUndoing] = useState(false)
  // Set when a run is held pending confirmation because the git tree is dirty.
  const [dirtyWarn, setDirtyWarn] = useState<{ count: number } | null>(null)
  // Context fill of the latest agent turn (prompt tokens vs the model window).
  const [ctxUsage, setCtxUsage] = useState<{ used: number; window: number } | null>(null)
  // A sensitive git/login/background action awaiting the user's approval.
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  // The agent's current run checklist (from TodoWrite).
  const [todos, setTodos] = useState<AgentTodo[]>([])
  const [messages, setMessages] = useState<Msg[]>([])
  const [agentItems, setAgentItems] = useState<AgentItem[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)

  // Host-IDE signals. onRunFinished goes through a ref so the event callback
  // registered at run start always sees the latest prop (chatOpen may change
  // mid-run in the host).
  const onRunFinishedRef = useRef(onRunFinished)
  onRunFinishedRef.current = onRunFinished
  useEffect(() => { onRunStateChange?.(streaming) }, [streaming, onRunStateChange])
  useEffect(() => { onContextUsage?.(ctxUsage) }, [ctxUsage, onContextUsage])
  // Slash-command popup (agent mode): highlighted index + Esc-dismissed flag.
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // Persistent session: id of the loaded conversation + the picker list.
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([])
  const [showSessions, setShowSessions] = useState(false)
  const sessionIdRef = useRef<number | null>(null)
  // Latest agent transcript, mirrored to a ref so async persistence sees it.
  const agentItemsRef = useRef<AgentItem[]>([])
  const [useFileContext, setUseFileContext] = useState(true)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const reqIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Typewriter: target[id] = full text received; displayed length is advanced
  // toward it by a steady rAF loop so streamed tokens reveal smoothly.
  const targetRef = useRef<Map<string, string>>(new Map())
  const shownRef = useRef<Map<string, number>>(new Map())
  const rafRef = useRef<number | null>(null)

  // Default provider/model from the first available model.
  useEffect(() => {
    if (!provider && models.length > 0) {
      setProvider(models[0].provider)
      setModel(models[0].id)
    }
  }, [models, provider])

  // Scroll pinning: auto-scroll while the user is at the bottom; once they
  // scroll up to read, streaming no longer yanks the view down. A floating ↓
  // button jumps back (and re-pins).
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const handleTranscriptScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    atBottomRef.current = near
    setAtBottom(near)
  }
  const jumpToBottom = () => {
    atBottomRef.current = true
    setAtBottom(true)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }
  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, agentItems, streaming])

  // Load the persisted review-mode preference once.
  useEffect(() => {
    window.api.ideAgentConfigGet().then((c) => setReviewMode(c.reviewMode)).catch(() => {})
  }, [])

  // Keep refs in sync so async persistence reads the latest values. When a
  // run-end handler requested persistence, do it HERE — after the final array
  // committed — instead of inside the setState updater (updaters must stay
  // pure; StrictMode double-invokes them).
  const pendingPersistRef = useRef(false)
  useEffect(() => {
    agentItemsRef.current = agentItems
    if (pendingPersistRef.current) {
      pendingPersistRef.current = false
      void persistSession(agentItems)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentItems])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // Restore the most recent session for the CURRENT workspace — on first load
  // and again whenever the workspace changes (the panel stays mounted across
  // switches; without this the old workspace's conversation bled into the new
  // one and confused the model).
  const restoredRootRef = useRef<string | null>(null)
  useEffect(() => {
    if (!workspaceRoot || restoredRootRef.current === workspaceRoot) return
    const isSwitch = restoredRootRef.current !== null
    restoredRootRef.current = workspaceRoot
    let cancelled = false
    ;(async () => {
      if (isSwitch) {
        // Workspace switched: end any in-flight run and clear the transcript
        // before loading the new workspace's latest session.
        if (reqIdRef.current) stop()
        setMessages([])
        setTodos([])
        setPlanApproval(null)
        setLastRunFiles([])
        setCtxUsage(null)
      }
      const s = await window.api.agentSessionLatest().catch(() => null)
      if (cancelled) return
      let items: AgentItem[] = []
      if (s) {
        try {
          const parsed = JSON.parse(s.items) as AgentItem[]
          if (Array.isArray(parsed)) items = parsed
        } catch { /* malformed — start clean */ }
      }
      setAgentItems(items)
      agentItemsRef.current = items
      setSessionId(s?.id ?? null)
      sessionIdRef.current = s?.id ?? null
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot])

  // Refresh the session list (for the picker dropdown).
  const refreshSessions = () => {
    window.api.agentSessionList().then(setSessions).catch(() => {})
  }
  useEffect(() => { if (showSessions) refreshSessions() }, [showSessions])

  // Persist the current transcript. Creates a session row on first save, then
  // updates it in place. Titles are derived from the opening user message.
  const persistSession = async (items: AgentItem[]) => {
    const serialized = JSON.stringify(serializeItems(items))
    const title = deriveTitle(items)
    try {
      if (sessionIdRef.current == null) {
        const res = await window.api.agentSessionCreate(title, serialized)
        if (res.ok && res.id != null) { setSessionId(res.id); sessionIdRef.current = res.id }
      } else {
        await window.api.agentSessionUpdate(sessionIdRef.current, serialized, title)
      }
    } catch { /* best-effort persistence */ }
  }

  // Start a brand-new empty session (keeps the old one saved on disk).
  const newSession = () => {
    if (streaming) stop()
    setAgentItems([])
    agentItemsRef.current = []
    setSessionId(null)
    sessionIdRef.current = null
    setTodos([])
    setShowSessions(false)
    setShowAllItems(false)
  }

  // Load a saved session into the panel.
  const loadSession = async (id: number) => {
    if (streaming) stop()
    try {
      const s = await window.api.agentSessionGet(id)
      if (!s) return
      const items = JSON.parse(s.items) as AgentItem[]
      setAgentItems(Array.isArray(items) ? items : [])
      agentItemsRef.current = Array.isArray(items) ? items : []
      setSessionId(s.id)
      sessionIdRef.current = s.id
      setMode('agent')
    } catch { /* ignore */ }
    setShowSessions(false)
    setShowAllItems(false)
  }

  const deleteSession = async (id: number) => {
    try { await window.api.agentSessionDelete(id) } catch { /* ignore */ }
    if (sessionIdRef.current === id) newSession()
    refreshSessions()
  }

  // Inline session rename (pencil in the History dropdown).
  const [renamingSession, setRenamingSession] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const commitRename = async () => {
    const id = renamingSession
    const title = renameValue.trim()
    setRenamingSession(null)
    if (id == null || !title) return
    try { await window.api.agentSessionRename(id, title) } catch { /* ignore */ }
    refreshSessions()
  }

  // /compact — summarize the whole conversation (including tool activity) into
  // one compact note that replaces the transcript. Keeps the agent's memory of
  // what happened while shrinking the context it must carry forward.
  const [compacting, setCompacting] = useState(false)
  const compact = async () => {
    if (streaming || compacting) return
    const items = agentItemsRef.current
    const hasContent = items.some((it) => it.kind === 'text' || it.kind === 'tool')
    if (!hasContent) return
    setCompacting(true)
    // Render the transcript as text for the summarizer.
    const transcript = buildHistory(items)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
    const instruction =
      'Summarize the following coding-assistant conversation into a compact but complete memory. ' +
      'Preserve: the user\'s goals and decisions, key facts learned about the codebase (files, ' +
      'structure, APIs), changes already made, and any open TODOs or next steps. Omit chit-chat. ' +
      'Write it as concise notes the assistant can rely on to continue seamlessly.\n\n' +
      '=== CONVERSATION ===\n' + transcript
    const requestId = `compact-${Date.now()}`
    let summary = ''
    await new Promise<void>((resolve) => {
      const offChunk = window.api.onAiChatChunk(requestId, (d) => { summary += d })
      const offDone = window.api.onAiChatDone(requestId, (info) => {
        offChunk(); offDone()
        if (!info.ok) summary = ''
        else if (info.text) summary = info.text
        resolve()
      })
      window.api.aiChat(requestId, {
        provider,
        model: model || undefined,
        messages: [{ role: 'user', content: instruction }],
      })
    })
    setCompacting(false)
    if (!summary.trim()) {
      setAgentItems((prev) => [...prev, { kind: 'text', role: 'assistant', content: '⚠ Compact failed — conversation unchanged.' }])
      return
    }
    const compacted: AgentItem[] = [
      { kind: 'text', role: 'user', content: '/compact — summarize the conversation so far' },
      { kind: 'text', role: 'assistant', content: `📝 Summary of earlier conversation:\n\n${summary.trim()}` },
    ]
    setAgentItems(compacted)
    agentItemsRef.current = compacted
    setTodos([])
    void persistSession(compacted)
  }

  const toggleReview = () => {
    const next = !reviewMode
    setReviewMode(next)
    window.api.ideAgentConfigSet({ reviewMode: next }).catch(() => {})
  }

  // Entering plan mode plays the activation wave once (Apple-Intelligence
  // power-on), then the persistent plan-glow carries on. Timeout is a
  // fallback in case the CSS animation never runs (e.g. animations disabled)
  // so the overlay can't get stuck.
  useEffect(() => {
    if (!planMode) return
    setPlanWave(true)
    const t = window.setTimeout(() => setPlanWave(false), 1600)
    return () => window.clearTimeout(t)
  }, [planMode])

  // Revert every file the last run wrote (git checkout tracked, delete new).
  const undoLastRun = async () => {
    if (undoing || lastRunFiles.length === 0) return
    setUndoing(true)
    try {
      const res = await window.api.workspaceGitRestoreFiles(lastRunFiles)
      lastRunFiles.forEach((f) => onFileChanged?.(f))
      setLastRunFiles([])
      const failed = res.failed ?? []
      if (!res.ok && failed.length) {
        setAgentItems((prev) => [...prev, {
          kind: 'text', role: 'assistant',
          content: `⚠ Undo could not revert: ${failed.join(', ')}`,
        }])
      }
    } catch (err) {
      setAgentItems((prev) => [...prev, { kind: 'text', role: 'assistant', content: `⚠ Undo failed: ${String(err)}` }])
    } finally {
      setUndoing(false)
    }
  }



  const providerIds = Array.from(new Set(models.map((m) => m.provider)))
  const providerModels = models.filter((m) => m.provider === provider)

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return

    const ctx = useFileContext ? getContext() : null

    // Attach @mentioned workspace files as extra context (ask mode).
    const mentionFiles: { path: string; language?: string; content: string }[] = []
    for (const rel of extractMentions(text)) {
      if (ctx && ctx.path === rel) continue // already attached as the open file
      try {
        const disk = await window.api.workspaceReadFile(rel)
        if (disk.ok) {
          mentionFiles.push({ path: rel, content: disk.content.slice(0, 12000) })
        }
      } catch { /* skip */ }
    }
    const nextMessages: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages([...nextMessages, { role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)

    const requestId = `chat-${Date.now()}`
    reqIdRef.current = requestId

    // Coalesce streamed deltas: main emits one IPC event per SSE token, and a
    // setState per token re-rendered (and re-parsed) the growing reply 30-100
    // times a second. Buffer in a ref and flush once per animation frame.
    const buf = { text: '', raf: null as number | null }
    const flush = () => {
      buf.raf = null
      const chunk = buf.text
      buf.text = ''
      if (!chunk) return
      setMessages((prev) => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = { ...last, content: last.content + chunk }
        }
        return copy
      })
    }
    const offChunk = window.api.onAiChatChunk(requestId, (delta) => {
      buf.text += delta
      if (buf.raf == null) buf.raf = requestAnimationFrame(flush)
    })
    const offDone = window.api.onAiChatDone(requestId, (info) => {
      offChunk()
      offDone()
      if (buf.raf != null) cancelAnimationFrame(buf.raf)
      flush() // drain whatever arrived after the last frame
      reqIdRef.current = null
      setStreaming(false)
      if (!info.ok && info.error) {
        setMessages((prev) => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last && last.role === 'assistant' && !last.content) {
            copy[copy.length - 1] = { ...last, content: `⚠ ${info.error}` }
          }
          return copy
        })
      }
    })

    const contextFiles = [
      ...(ctx ? [{ path: ctx.path, language: ctx.language, content: ctx.content }] : []),
      ...mentionFiles,
    ]
    window.api.aiChat(requestId, {
      provider,
      model: model || undefined,
      messages: nextMessages,
      contextFiles: contextFiles.length ? contextFiles : undefined,
      selection: ctx?.selection,
    })
  }

  // Typewriter reveal: each frame advance displayed text toward the received
  // target at a STEADY linear rate. If the backlog is large (model tubes faster
  // than we can type), skip ahead so we never lag thousands of chars behind —
  // keep only a short tail for the typewriter feel.
  // Reveal ~1 short chunk per couple frames. Each revealed slice becomes its
  // own <span> that fades dark→bright once (see .stream-chunk). Steady rate,
  // with catch-up if the model tubes text faster than we reveal.
  const CHUNK_SIZE = 4           // chars revealed per tick (small = glowier)
  const TICK_EVERY = 2           // reveal every N frames (slower, smoother glow)
  const MAX_BACKLOG = 240        // never trail more than this far behind
  const frameCtr = useRef(0)
  // The loop is driven by refs (targetRef = full text received, shownRef =
  // chars already revealed) so lag detection is SYNCHRONOUS — it does not rely
  // on React having flushed the last setState (which caused the loop to stall).
  const ensureReveal = () => {
    if (rafRef.current != null) return
    const step = () => {
      frameCtr.current++
      // Compute which ids still lag, straight from refs.
      const pending: { id: string; slice: string }[] = []
      let anyLag = false
      for (const [id, target] of targetRef.current) {
        const shown = shownRef.current.get(id) ?? 0
        if (shown >= target.length) continue
        const remaining = target.length - shown
        const catchUp = remaining > MAX_BACKLOG ? remaining - MAX_BACKLOG : 0
        const take = catchUp + Math.min(CHUNK_SIZE, remaining - catchUp)
        if (frameCtr.current % TICK_EVERY === 0) {
          pending.push({ id, slice: target.slice(shown, shown + take) })
          shownRef.current.set(id, shown + take)
          if (shown + take < target.length) anyLag = true
        } else {
          anyLag = true
        }
      }
      if (pending.length > 0) {
        setAgentItems((prev) => prev.map((it) => {
          if ((it.kind === 'text' || it.kind === 'reasoning') && it.id) {
            const p = pending.find((x) => x.id === it.id)
            if (p) return { ...it, chunks: [...(it.chunks ?? []), p.slice] }
          }
          return it
        }))
      }
      if (anyLag) rafRef.current = requestAnimationFrame(step)
      else rafRef.current = null
    }
    rafRef.current = requestAnimationFrame(step)
  }

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }, [])

  // Agent mode: run the tool-calling loop, rendering tool activity inline.
  const sendAgent = (opts?: { text?: string; planMode?: boolean; researchMode?: boolean }) => {
    const text = (opts?.text ?? input).trim()
    if (!text || streaming) return
    const usePlan = opts?.planMode ?? planMode
    const useResearch = opts?.researchMode ?? researchMode

    const ctx = useFileContext ? getContext() : null
    // Preserve tool activity from earlier turns so the agent remembers what it
    // already read/searched instead of re-scanning the folder every turn.
    const history: Msg[] = [...buildHistory(agentItems), { role: 'user', content: text }]

    setAgentItems((prev) => [...prev, { kind: 'text', role: 'user', content: text }])
    setInput('')
    setStreaming(true)

    const runId = `agent-${Date.now()}`
    reqIdRef.current = runId
    targetRef.current.clear()
    shownRef.current.clear()
    runFilesRef.current = new Set()
    setLastRunFiles([])
    setCtxUsage(null)
    setPendingAction(null)
    setTodos([])

    // Editor round-trip: main asks us to drive the editor; delegate to IDEView.
    const offEditor = window.api.onAiAgentEditorReq(runId, async (req) => {
      let resp = { requestId: req.requestId, ok: false, result: 'error: editor not available' }
      if (onEditorRequest) {
        try {
          const r = await onEditorRequest(req.op, req.args)
          resp = { requestId: req.requestId, ok: r.ok, result: r.result }
        } catch (err) {
          resp = { requestId: req.requestId, ok: false, result: `error: ${String(err)}` }
        }
      }
      window.api.aiAgentEditorRes(resp)
    })

    const off = window.api.onAiAgentEvent(runId, (e: IdeAgentEvent) => {
      if (e.type === 'reasoning' || e.type === 'token') {
        // Namespace ids by runId: turns restart at 0 every run, so a bare
        // `token-0` collided with the PREVIOUS run's bubble — new text got
        // appended into the old bubble and the real bubble froze mid-word
        // (its reveal cursor was consumed/cleared by the id collision).
        const id = `${runId}-${e.type}-${e.turn}`
        targetRef.current.set(id, (targetRef.current.get(id) ?? '') + e.delta)
        setAgentItems((prev) => {
          const idx = prev.findIndex((it) => (it.kind === 'text' || it.kind === 'reasoning') && it.id === id)
          if (idx >= 0) return prev // existing item; reveal loop grows its chunks
          const copy = [...prev]
          if (e.type === 'reasoning') copy.push({ kind: 'reasoning', id, chunks: [] })
          else copy.push({ kind: 'text', id, role: 'assistant', chunks: [] })
          return copy
        })
        ensureReveal()
        return
      }
      if (e.type === 'pending_change') { onPendingChange?.(e.change); return }
      if (e.type === 'change_resolved') { onChangeResolved?.(e.changeId); return }
      if (e.type === 'pending_action') { setPendingAction(e.action); return }
      if (e.type === 'action_resolved') { setPendingAction(null); return }
      if (e.type === 'todos') { setTodos(e.todos); return }
      if (e.type === 'context') { setCtxUsage({ used: e.used, window: e.window }); return }
      if (e.type === 'subagent_started') {
        // A child agent was delegated: render a nested live card. The plain
        // SpawnAgent tool entry is kept for history but hidden from view.
        onSubAgentStarted?.()
        setAgentItems((prev) => [...prev, { kind: 'subagent', childRunId: e.childRunId, label: e.label, task: e.task }])
        return
      }
      setAgentItems((prev) => {
        const copy = [...prev]
        if (e.type === 'tool_call') {
          copy.push({ kind: 'tool', callId: e.callId, name: e.name, args: e.args, running: true })
        } else if (e.type === 'tool_result') {
          const idx = copy.findIndex((it) => it.kind === 'tool' && it.callId === e.callId)
          if (idx >= 0) {
            const t = copy[idx] as ToolEntry
            copy[idx] = { ...t, result: e.result, isError: e.isError, running: false }
          }
        }
        return copy
      })
      if (e.type === 'file_changed') { runFilesRef.current.add(e.path); onFileChanged?.(e.path) }
      if (e.type === 'done' || e.type === 'error' || e.type === 'blocked' || e.type === 'plan') {
        onRunFinishedRef.current?.({ kind: e.type })
        off()
        offEditor()
        reqIdRef.current = null
        setStreaming(false)
        setPendingAction(null)
        // Surface an Undo affordance if the run wrote files (done or blocked).
        if (e.type !== 'error' && runFilesRef.current.size > 0) {
          setLastRunFiles(Array.from(runFilesRef.current))
        }
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
        // Plan is ready when the agent explicitly calls PresentPlan → 'plan'.
        if (e.type === 'plan' && e.plan?.trim()) setPlanApproval({ text: e.plan.trim(), explicit: true })
        // Fallback: a plan run that ended with text but never called PresentPlan
        // — offer to treat that text as the plan (clearly labeled).
        else if (e.type === 'done' && usePlan && e.text?.trim()) setPlanApproval({ text: e.text.trim(), explicit: false })
        // Snap every streaming item to its full received text — append the
        // remaining tail as one final glowing chunk, no lingering typewriter.
        // Tails MUST be computed before the setState: updaters must stay pure
        // (StrictMode double-invokes them) — advancing shownRef inside meant
        // the second invocation saw shown==target and returned the item
        // WITHOUT its tail, silently eating the end of the reply from the
        // display, the persisted session and the next turn's history.
        const tails = new Map<string, string>()
        for (const [tid, target] of targetRef.current) {
          const shown = shownRef.current.get(tid) ?? 0
          if (shown < target.length) {
            tails.set(tid, target.slice(shown))
            shownRef.current.set(tid, target.length)
          }
        }
        pendingPersistRef.current = true // persisted by the ref-sync effect after commit
        setAgentItems((prev) => {
          const copy = prev.map((it) => {
            if ((it.kind === 'text' || it.kind === 'reasoning') && it.id && tails.has(it.id)) {
              return { ...it, chunks: [...(it.chunks ?? []), tails.get(it.id) as string] }
            }
            return it
          })
          if (e.type === 'error') copy.push({ kind: 'text', role: 'assistant', content: `⚠ ${e.error}` })
          if (e.type === 'blocked') copy.push({ kind: 'text', role: 'assistant', content: `⛔ Blocked: ${e.reason}` })
          if (e.type === 'plan') copy.push({ kind: 'text', role: 'assistant', content: `📋 **Plan**\n\n${e.plan}` })
          // Snap chunks → content: finished replies render as ONE static
          // markdown block instead of a growing span list from here on.
          return flattenFinished(copy)
        })
      }
    })

    window.api.aiAgentRun(runId, {
      provider,
      model: model || undefined,
      messages: history,
      openFile: ctx ? { path: ctx.path, language: ctx.language, content: ctx.content } : undefined,
      selection: ctx?.selection,
      reviewMode,
      planMode: usePlan,
      researchMode: useResearch,
    })
  }

  // Execute an approved plan in agent mode.
  const runPlan = (plan: string) => {
    setPlanMode(false)
    sendAgent({ text: `Implement this approved plan, following it step by step:\n\n${plan}`, planMode: false })
  }
  // Approve the pending plan → (git-dirty guard, then) execute it.
  const approvePlan = async () => {
    const plan = planApproval?.text
    setPlanApproval(null)
    setPlanExpanded(false)
    if (!plan) return
    if (!reviewMode) {
      try {
        const d = await window.api.workspaceGitDirtyCount()
        if (d.ok && d.count > 0) { pendingPlanRef.current = plan; setDirtyWarn({ count: d.count }); return }
      } catch { /* proceed */ }
    }
    runPlan(plan)
  }
  // Refine: drop the approval but STAY in plan mode so the next message re-plans
  // with this plan already in context. Dismiss: cancel planning entirely.
  const refinePlan = () => { setPlanApproval(null); setPlanExpanded(false) }
  const dismissPlan = () => { setPlanApproval(null); setPlanExpanded(false); setPlanMode(false) }

  const stop = () => {
    if (pendingAction) { resolveAction(false) }
    if (reqIdRef.current) {
      if (mode !== 'ask') window.api.aiAgentCancel(reqIdRef.current)
      else window.api.aiChatCancel(reqIdRef.current)
    }
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    // Snap streaming items to whatever text has arrived so far. Tails are
    // computed outside the updater — see the identical snap in the run-end
    // handler for why (StrictMode double-invoke ate the tail).
    const tails = new Map<string, string>()
    for (const [tid, target] of targetRef.current) {
      const shown = shownRef.current.get(tid) ?? 0
      if (shown < target.length) {
        tails.set(tid, target.slice(shown))
        shownRef.current.set(tid, target.length)
      }
    }
    setAgentItems((prev) => flattenFinished(prev.map((it) => {
      if ((it.kind === 'text' || it.kind === 'reasoning') && it.id && tails.has(it.id)) {
        return { ...it, chunks: [...(it.chunks ?? []), tails.get(it.id) as string] }
      }
      return it
    })))
    setStreaming(false)
  }

  const clear = () => {
    if (streaming) stop()
    setMessages([])
    setAgentItems([])
    agentItemsRef.current = []
    // Detach from the saved session so a fresh conversation starts a new one
    // (the previous session remains on disk, reachable from history).
    setSessionId(null)
    sessionIdRef.current = null
    setTodos([])
    setShowAllItems(false)
  }

  // ── Slash-command popup (agent mode) ──────────────────────────
  const slashQuery = mode !== 'ask' && input.startsWith('/') && !input.includes(' ') ? input.toLowerCase() : ''
  const slashMatches = slashQuery
    ? AGENT_SLASH_COMMANDS
        .filter((c) => c.name.startsWith(slashQuery) || c.name.slice(1).includes(slashQuery.slice(1)))
        .sort((a, b) => Number(b.name.startsWith(slashQuery)) - Number(a.name.startsWith(slashQuery)))
    : []
  const slashOpen = slashMatches.length > 0 && !slashDismissed
  const slashSel = Math.min(slashIndex, Math.max(0, slashMatches.length - 1))
  // Reset selection/dismissal whenever the query changes.
  useEffect(() => { setSlashIndex(0); setSlashDismissed(false) }, [slashQuery])

  // ── @file mention popup ─────────────────────────────────────────
  // Typing "@token" at the end of the input opens a fuzzy file picker; picking
  // inserts "@path ". In ask mode the mentioned files are attached as context
  // at send time; in agent mode the agent Reads them itself.
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const mentionMatch = /(^|\s)@([^\s@]*)$/.exec(input)
  const mentionQuery = mentionMatch ? mentionMatch[2].toLowerCase() : null
  const mentionMatches = mentionQuery != null
    ? files
        .filter((f) => f.toLowerCase().includes(mentionQuery))
        .sort((a, b) => {
          const ab = a.split('/').pop()!.toLowerCase().startsWith(mentionQuery) ? 0 : 1
          const bb = b.split('/').pop()!.toLowerCase().startsWith(mentionQuery) ? 0 : 1
          return ab - bb || a.length - b.length
        })
        .slice(0, 8)
    : []
  const mentionOpen = mentionMatches.length > 0 && !mentionDismissed
  const mentionSel = Math.min(mentionIndex, Math.max(0, mentionMatches.length - 1))
  useEffect(() => { setMentionIndex(0); setMentionDismissed(false) }, [mentionQuery])

  const pickMention = (path: string) => {
    setInput((cur) => cur.replace(/(^|\s)@[^\s@]*$/, (_m, pre) => `${pre}@${path} `))
  }

  // Insert an "@path " mention (used by drag-drop from the file tree).
  const insertMention = (path: string) => {
    setInput((cur) => `${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}@${path} `)
  }

  // Extract mentioned workspace files from a prompt (known files only).
  const extractMentions = (text: string): string[] => {
    const known = new Set(files)
    const out: string[] = []
    for (const m of text.matchAll(/@([^\s@]+)/g)) {
      if (known.has(m[1]) && !out.includes(m[1])) out.push(m[1])
    }
    return out.slice(0, 5)
  }

  // Plan and research are mutually exclusive read-only modes.
  const togglePlan = () => { const next = !planMode; setPlanMode(next); if (next) setResearchMode(false) }
  const toggleResearch = () => { const next = !researchMode; setResearchMode(next); if (next) setPlanMode(false) }

  const runSlash = (name: string) => {
    setInput('')
    if (name === '/plan') togglePlan()
    else if (name === '/research') toggleResearch()
    else if (name === '/compact') void compact()
    else if (name === '/new') newSession()
    else if (name === '/review') toggleReview()
    else if (name === '/stop') stop()
  }

  const submit = async () => {
    // Slash commands (agent mode). Handles a fully-typed command + Enter even
    // when the popup was dismissed.
    const cmd = input.trim().toLowerCase()
    if (mode === 'agent' && AGENT_SLASH_COMMANDS.some((c) => c.name === cmd)) {
      runSlash(cmd)
      return
    }
    if (mode === 'ask') { send(); return }
    // Research mode: read-only deep dive → cited answer. No dirty check.
    if (researchMode) { sendAgent({ researchMode: true }); return }
    // Plan mode: read-only investigation → a plan to approve. No dirty check.
    if (planMode) { sendAgent({ planMode: true }); return }
    // Agent: auto-apply on a dirty tree is risky (no clean git baseline to undo
    // to). Warn once; review mode is safe (each change is gated) so skip.
    if (!reviewMode && input.trim() && !streaming) {
      try {
        const d = await window.api.workspaceGitDirtyCount()
        if (d.ok && d.count > 0) { setDirtyWarn({ count: d.count }); return }
      } catch { /* ignore — proceed */ }
    }
    sendAgent()
  }

  // Proceed with a run the user confirmed despite a dirty tree. If a plan was
  // stashed (approve → dirty), run that; otherwise a normal agent run.
  const confirmDirtyRun = () => {
    setDirtyWarn(null)
    if (pendingPlanRef.current) { const p = pendingPlanRef.current; pendingPlanRef.current = null; runPlan(p) }
    else sendAgent()
  }

  // Approve or decline a sensitive git/login/background action.
  const resolveAction = (approved: boolean) => {
    if (!pendingAction) return
    window.api.aiAgentAction(pendingAction.actionId, approved).catch(() => {})
    setPendingAction(null)
  }

  const ctxPreview = useFileContext ? getContext() : null

  // The most recent reasoning item — docked above the composer, not inline.
  let latestReasoning: Extract<AgentItem, { kind: 'reasoning' }> | undefined
  for (let i = agentItems.length - 1; i >= 0; i--) {
    const it = agentItems[i]
    if (it.kind === 'reasoning') { latestReasoning = it; break }
  }

  // Long transcripts: render only the newest RENDER_CAP items unless expanded.
  const [showAllItems, setShowAllItems] = useState(false)
  const hiddenCount = !showAllItems && agentItems.length > RENDER_CAP ? agentItems.length - RENDER_CAP : 0

  return (
    <motion.div
      className="h-full flex flex-col bg-zinc-950 relative overflow-hidden"
      style={{ '--chat-font-size': `${chatFontSize}px` } as React.CSSProperties}
      variants={windup ? containerVariants : undefined}
      initial={windup ? 'hidden' : false}
      // The panel stays mounted while hidden (so agent runs survive close);
      // dropping back to 'hidden' when invisible makes the wind-up replay on
      // every open, like the old mount-on-open behavior.
      animate={windup ? (visible ? 'show' : 'hidden') : false}
    >
      {/* Header */}
      <motion.div
        variants={windup ? itemVariants : undefined}
        className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 flex-shrink-0"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-blue-400" />
          {/* Ask / Agent mode toggle. Plan / Research / Review are toggled via
              slash commands (/plan, /research, /review); plan & research show a
              glow, and review shows the green shield badge below. */}
          <div className="relative flex rounded-md bg-zinc-900 border border-zinc-800 p-0.5">
            {(['ask', 'agent'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { if (!streaming) setMode(m) }}
                disabled={streaming}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  mode === m ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300'
                } ${streaming ? 'cursor-not-allowed' : ''}`}
                title={m === 'agent' ? 'Agent can read and modify your files' : 'Ask questions (read-only)'}
              >
                {m}
              </button>
            ))}
            {/* Review-on indicator: green shield badge above the Agent corner. */}
            {mode === 'agent' && reviewMode && (
              <span
                className="absolute -top-1.5 -right-1.5 grid place-items-center w-3.5 h-3.5 rounded-[3px] bg-emerald-500 ring-1 ring-zinc-950 shadow"
                title="Review mode on — you approve each change before it applies (/review to toggle)"
              >
                <ShieldCheck size={9} className="text-white" />
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {mode !== 'ask' && (
            <>
              <button
                onClick={compact}
                disabled={streaming || compacting || agentItems.length === 0}
                title="Compact: summarize the conversation to save context (/compact)"
                className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-600"
              >
                <Archive size={14} />
              </button>
              <button
                onClick={newSession}
                disabled={streaming}
                title="New session"
                className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30"
              >
                <Plus size={15} />
              </button>
              <div className="relative">
                <button
                  onClick={() => setShowSessions((v) => !v)}
                  title="Session history"
                  className={`text-zinc-600 hover:text-zinc-300 ${showSessions ? 'text-zinc-300' : ''}`}
                >
                  <History size={14} />
                </button>
                {showSessions && (
                  <div className="absolute right-0 top-6 z-20 w-64 max-h-72 overflow-y-auto scrollbar-thin rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl py-1">
                    {sessions.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-zinc-600">No saved sessions</div>
                    ) : (
                      sessions.map((s) => (
                        <div
                          key={s.id}
                          className={`group flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-zinc-800/60 cursor-pointer ${
                            s.id === sessionId ? 'bg-zinc-800/40' : ''
                          }`}
                          onClick={() => { if (renamingSession !== s.id) loadSession(s.id) }}
                        >
                          {renamingSession === s.id ? (
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                                else if (e.key === 'Escape') { e.preventDefault(); setRenamingSession(null) }
                                e.stopPropagation()
                              }}
                              onBlur={() => setRenamingSession(null)}
                              className="flex-1 min-w-0 px-1 py-0.5 bg-zinc-950 border border-blue-500/60 rounded text-[11px] text-zinc-100 focus:outline-none"
                            />
                          ) : (
                            <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-300">{s.title}</span>
                          )}
                          <span className="text-[9px] text-zinc-600 flex-shrink-0">{s.updated_at.slice(5, 16)}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setRenamingSession(s.id); setRenameValue(s.title) }}
                            title="Rename session"
                            className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-200 flex-shrink-0"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                            title="Delete session"
                            className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-rose-400 flex-shrink-0"
                          >
                            <Trash size={11} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          <button
            onClick={clear}
            disabled={messages.length === 0 && agentItems.length === 0}
            title="Clear conversation"
            className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-600"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </motion.div>

      {/* Messages */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      {!atBottom && (
        <button
          onClick={jumpToBottom}
          title="Jump to latest"
          className="absolute bottom-3 right-3 z-30 p-1.5 rounded-full bg-zinc-800/95 border border-zinc-600 text-zinc-300 hover:text-white hover:border-zinc-500 shadow-lg"
        >
          <ArrowDown size={13} />
        </button>
      )}
      <motion.div
        variants={windup ? itemVariants : undefined}
        ref={scrollRef}
        onScroll={handleTranscriptScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-4"
      >
        {mode === 'ask' ? (
          <>
            {messages.length === 0 && (
              <div className="text-center text-zinc-600 text-xs mt-8 leading-relaxed px-4">
                Ask about the code you're working on.<br />
                The open file is sent as context.
              </div>
            )}
            {messages.map((m, i) => (
              <MessageBubble key={i} role={m.role} content={m.content} streaming={streaming && i === messages.length - 1} />
            ))}
          </>
        ) : (
          <>
            {agentItems.length === 0 && (
              <div className="text-center text-zinc-600 text-xs mt-8 leading-relaxed px-4">
                Agent mode: describe a change and the agent will<br />
                read and edit files in your workspace directly.
              </div>
            )}
            {hiddenCount > 0 && (
              <button
                onClick={() => setShowAllItems(true)}
                className="w-full py-1.5 rounded border border-zinc-800 bg-zinc-900/40 text-[11px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
              >
                Show {hiddenCount} earlier items…
              </button>
            )}
            {agentItems.map((it, i) => {
              if (i < hiddenCount) return null
              return it.kind === 'text' ? (
                <RiseIn key={i}>
                  {it.chunks
                    ? <GlowMessage role={it.role} chunks={it.chunks} />
                    : <MessageBubble role={it.role} content={it.content ?? ''} streaming={false} />}
                </RiseIn>
              ) : it.kind === 'subagent' ? (
                <RiseIn key={i}><SubAgentCard entry={it} /></RiseIn>
              ) : it.kind === 'tool' ? (
                // The SpawnAgent tool entry is kept in state for cross-turn
                // history but shown as the richer nested SubAgentCard instead.
                it.name === 'SpawnAgent' ? null : <RiseIn key={i}><ToolActivity entry={it} /></RiseIn>
              ) : null
            })}
            {streaming && (
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 px-1">
                <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
                working…
              </div>
            )}
            {compacting && (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-400/80 px-1">
                <Archive size={11} className="animate-pulse" />
                compacting conversation…
              </div>
            )}
          </>
        )}
      </motion.div>
      </div>

      {/* Thinking dock — reasoning lives here, not in the chat flow */}
      {mode !== 'ask' && latestReasoning && (
        <ThinkingDock text={itemText(latestReasoning)} active={streaming} />
      )}

      {/* Sensitive action confirmation (git mutate / account switch / login) */}
      {pendingAction && (
        <div className="flex items-start gap-2 px-3 py-2.5 border-t border-blue-500/30 bg-blue-500/5 flex-shrink-0">
          <ShieldCheck size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold text-zinc-200">{pendingAction.title}</div>
            <div className="text-[10px] text-zinc-500 mb-1">Agent wants to run <span className="font-mono text-zinc-400">{pendingAction.tool}</span></div>
            {pendingAction.detail && (
              <pre className="text-[10px] font-mono text-zinc-300 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 whitespace-pre-wrap max-h-28 overflow-y-auto scrollbar-thin">
                {pendingAction.detail}
              </pre>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <button
                onClick={() => resolveAction(true)}
                className="text-[11px] font-medium px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white"
              >
                Approve
              </button>
              <button
                onClick={() => resolveAction(false)}
                className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Agent run checklist (TodoWrite) */}
      {mode !== 'ask' && todos.length > 0 && (
        <div className="px-3 py-2 border-t border-zinc-800 bg-zinc-900/30 flex-shrink-0 max-h-32 overflow-y-auto scrollbar-thin">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            <ListChecks size={11} /> Plan
          </div>
          <ul className="space-y-0.5">
            {todos.map((t, i) => (
              <li key={i} className="flex items-center gap-1.5 text-[11px]">
                {t.status === 'completed'
                  ? <CheckCircle2 size={11} className="text-emerald-400 flex-shrink-0" />
                  : t.status === 'in_progress'
                    ? <span className="size-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
                    : <span className="size-1.5 rounded-full border border-zinc-600 flex-shrink-0" />}
                <span className={t.status === 'completed' ? 'text-zinc-500 line-through' : 'text-zinc-300'}>
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Git-dirty warning before an auto-apply run */}
      {/* Plan-approval bar: a plan is ready — preview, then approve/refine/dismiss */}
      {planApproval && !streaming && (
        <div className="flex items-start gap-2 px-3 py-2 border-t border-blue-500/30 bg-blue-500/5 flex-shrink-0">
          <ListPlus size={13} className="text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 text-[11px] text-zinc-300 leading-relaxed">
            <div className="flex items-center justify-between gap-2">
              <span>{planApproval.explicit
                ? 'Plan ready. Approve to run it in Agent mode.'
                : 'Agent ended without PresentPlan — treat its message as the plan?'}</span>
              <button
                onClick={() => setPlanExpanded((v) => !v)}
                className="text-[10px] text-blue-300/80 hover:text-blue-200 flex-shrink-0"
              >
                {planExpanded ? 'Hide' : 'Preview'}
              </button>
            </div>
            {planExpanded && (
              <div className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap text-[11px] text-zinc-400 bg-zinc-950/60 border border-zinc-800 rounded p-2">
                {planApproval.text}
              </div>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <button
                onClick={approvePlan}
                className="text-[11px] font-medium px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white"
              >
                Approve &amp; Run
              </button>
              <button
                onClick={refinePlan}
                title="Keep plan mode on and give feedback to refine the plan"
                className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-600"
              >
                Refine
              </button>
              <button
                onClick={dismissPlan}
                title="Cancel planning (turn plan mode off)"
                className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {dirtyWarn && (
        <div className="flex items-start gap-2 px-3 py-2 border-t border-amber-500/30 bg-amber-500/5 flex-shrink-0">
          <AlertTriangle size={13} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 text-[11px] text-zinc-300 leading-relaxed">
            You have {dirtyWarn.count} uncommitted change{dirtyWarn.count > 1 ? 's' : ''}. The agent applies
            edits directly — undoing a run reverts files to their last committed state, which would also drop
            your current changes. Commit first, or turn on Review mode.
            <div className="flex items-center gap-2 mt-1.5">
              <button
                onClick={confirmDirtyRun}
                className="text-[11px] font-medium px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-500 text-white"
              >
                Run anyway
              </button>
              <button
                onClick={() => setDirtyWarn(null)}
                className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Undo-run bar: revert everything the last agent run wrote */}
      {mode === 'agent' && !streaming && lastRunFiles.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-800 bg-zinc-900/40 flex-shrink-0">
          <span className="text-[11px] text-zinc-400 flex-1">
            Agent changed {lastRunFiles.length} file{lastRunFiles.length > 1 ? 's' : ''}
          </span>
          <button
            onClick={() => setLastRunFiles([])}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5"
          >
            Dismiss
          </button>
          <button
            onClick={undoLastRun}
            disabled={undoing}
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-60"
          >
            <Undo2 size={11} /> {undoing ? 'Undoing…' : 'Undo run'}
          </button>
        </div>
      )}

      {/* Composer */}
      <motion.div
        variants={windup ? itemVariants : undefined}
        className="border-t border-zinc-800 p-2.5 flex-shrink-0 space-y-2"
      >
        {/* Context chip */}
        <button
          onClick={() => setUseFileContext((v) => !v)}
          className={`w-full min-w-0 flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono transition-colors ${
            useFileContext && ctxPreview
              ? 'bg-blue-500/10 border border-blue-500/30 text-blue-300'
              : 'bg-zinc-900 border border-zinc-800 text-zinc-600'
          }`}
          title={ctxPreview ? ctxPreview.path : 'Toggle sending the open file as context'}
        >
          <FileCode size={11} className="flex-shrink-0" />
          <span className="truncate min-w-0">
            {ctxPreview
              ? `${useFileContext ? '' : '(off) '}${shortenPath(ctxPreview.path)}${ctxPreview.selection ? ' · selection' : ''}`
              : 'No file open'}
          </span>
        </button>

        {mode !== 'ask' && ctxUsage && <ContextMeter used={ctxUsage.used} window={ctxUsage.window} />}

        <div className="relative">
          {slashOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-20 bg-zinc-900 border border-zinc-700 rounded-md shadow-xl overflow-hidden">
              <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-zinc-600 border-b border-zinc-800">Commands</div>
              {slashMatches.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); runSlash(c.name) }}
                  onMouseEnter={() => setSlashIndex(i)}
                  className={`w-full flex items-baseline gap-2 px-2 py-1.5 text-left ${i === slashSel ? 'bg-blue-600/20' : 'hover:bg-zinc-800/60'}`}
                >
                  <span className="text-xs font-mono text-blue-300">{c.name}</span>
                  <span className="text-[10px] text-zinc-500 truncate">{c.desc}</span>
                </button>
              ))}
            </div>
          )}
          {mentionOpen && !slashOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-20 bg-zinc-900 border border-zinc-700 rounded-md shadow-xl overflow-hidden">
              <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-zinc-600 border-b border-zinc-800 flex items-center gap-1">
                <AtSign size={9} /> Attach file
              </div>
              {mentionMatches.map((f, i) => (
                <button
                  key={f}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pickMention(f) }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`w-full flex items-baseline gap-2 px-2 py-1.5 text-left ${i === mentionSel ? 'bg-blue-600/20' : 'hover:bg-zinc-800/60'}`}
                >
                  <span className="text-xs font-mono text-blue-300 flex-shrink-0">{f.split('/').pop()}</span>
                  <span className="text-[10px] text-zinc-500 truncate">{f}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('text/orqon-path')) e.preventDefault() }}
            onDrop={(e) => {
              const p = e.dataTransfer.getData('text/orqon-path')
              if (p) { e.preventDefault(); insertMention(p) }
            }}
            onKeyDown={(e) => {
              if (mentionOpen && !slashOpen) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionMatches.length - 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return }
                if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickMention(mentionMatches[mentionSel]); return }
              }
              if (slashOpen) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return }
                if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
                if (e.key === 'Tab') { e.preventDefault(); setInput(slashMatches[slashSel].name + ' '); return }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runSlash(slashMatches[slashSel].name); return }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={3}
            placeholder={mode === 'agent'
              ? (researchMode
                  ? 'Ask a research question… (deep read-only web + code · /research to exit)'
                  : planMode
                    ? 'Describe the task to plan… (read-only, then a plan to approve · /plan to exit)'
                    : 'Describe a change… (Enter to run · / for commands)')
              : 'Ask anything… (Enter to send, Shift+Enter for newline)'}
            className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 resize-none focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value)
              const first = models.find((m) => m.provider === e.target.value)
              if (first) setModel(first.id)
            }}
            className="px-1.5 py-1 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-300 focus:outline-none max-w-[90px]"
          >
            {providerIds.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="flex-1 min-w-0 px-1.5 py-1 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-300 focus:outline-none"
          >
            {providerModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {streaming ? (
            <button
              onClick={stop}
              title="Stop"
              className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 flex items-center gap-1"
            >
              <Square size={11} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!input.trim()}
              title={mode === 'agent' ? (researchMode ? 'Research' : planMode ? 'Make a plan' : 'Run agent') : 'Send'}
              className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white flex items-center gap-1"
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </motion.div>

      {/* Plan-mode glow: while plan mode is ON (from /plan until it ends), an
          Apple-Intelligence-style edge glow surrounds the chat. Fades in on
          enter and DIMS OUT on exit (the wrapper animates opacity; the inner
          rim/breathe keep their own CSS animation). Clipped, no pointer. */}
      <AnimatePresence>
        {mode === 'agent' && (planMode || researchMode) && visible && (
          <motion.div
            key={planMode ? 'plan-glow' : 'research-glow'}
            className="absolute inset-0 z-30 pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: 'easeInOut' }}
          >
            <div className={planMode ? 'plan-glow' : 'research-glow'} aria-hidden="true">
              {/* Static conic gradient rotated on the compositor; the rim mask
                  lives on .glow-rim (see index.css). */}
              <div className="glow-rim"><div className="glow-spin" /></div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Plan-mode activation wave: light wraps up from the bottom edge along
          both sides while a soft wash blooms across the CENTER (the Apple
          Intelligence power-on), then both fade into the persistent
          .plan-glow above. */}
      {planWave && (
        <div
          className="absolute inset-0 z-30 pointer-events-none"
          aria-hidden="true"
          onAnimationEnd={() => setPlanWave(false)}
        >
          <div className="plan-wave" />
          <div className="plan-wave-center" />
        </div>
      )}
    </motion.div>
  )
}

const MessageBubble = memo(function MessageBubble({ role, content, streaming }: { role: 'user' | 'assistant'; content: string; streaming: boolean }) {
  const isUser = role === 'user'
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`group relative select-text max-w-[92%] min-w-0 overflow-hidden break-words rounded-lg px-3 py-2 text-xs leading-relaxed ${
          isUser
            ? 'bg-blue-600/20 border border-blue-500/30 text-zinc-100'
            : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
        }`}
      >
        <div ref={contentRef}>
          {content
            ? (isUser
                // While streaming, render plain text — re-parsing the whole
                // growing reply as markdown per frame was O(n²). One markdown
                // parse happens when the stream finishes.
                ? <div className="whitespace-pre-wrap break-words">{content}</div>
                : streaming
                  ? <div className="whitespace-pre-wrap break-words">{content}</div>
                  : <MessageContent text={content} />)
            : streaming ? (
              <span className="inline-flex gap-1 items-center text-zinc-500">
                <span className="size-1.5 rounded-full bg-zinc-500 animate-pulse" />
                thinking…
              </span>
            ) : null}
        </div>
        {streaming && content && <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-blue-400 animate-pulse" />}
        {!isUser && !streaming && content.trim() && <CopyButton getText={() => contentRef.current?.innerText || content} />}
      </div>
    </div>
  )
})

// Copy-to-clipboard button. `getText` returns the RENDERED text (innerText of
// the message), so the clipboard gets the readable version — no markdown syntax.
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(getText())
          .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })
          .catch(() => {})
      }}
      title="Copy message"
      className="absolute top-1 right-1 p-1 rounded bg-zinc-800/90 border border-zinc-700 text-zinc-400 hover:text-zinc-100 opacity-0 group-hover:opacity-100 transition-opacity"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  )
}

// Fenced code block with its own hover copy button (copies just the code).
function PreBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative group/code">
      <pre ref={preRef} {...props} />
      <button
        onClick={() => {
          const code = preRef.current?.innerText ?? ''
          navigator.clipboard.writeText(code)
            .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })
            .catch(() => {})
        }}
        title="Copy code"
        className="absolute top-1.5 right-1.5 p-1 rounded bg-zinc-800/90 border border-zinc-700 text-zinc-400 hover:text-zinc-100 opacity-0 group-hover/code:opacity-100 transition-opacity"
      >
        {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      </button>
    </div>
  )
}

// Full markdown renderer (GFM: tables, lists, code, links, headings, hr…).
// Styling lives in `.md-body` in index.css; wide tables/code scroll inside the
// bubble so nothing overflows.
const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  // Scrub any tool-log echo the model leaked into its prose (see stripToolEcho).
  const clean = stripToolEcho(text)
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
          pre: ({ node: _n, ...p }) => <PreBlock {...p} />,
        }}
      >
        {clean}
      </ReactMarkdown>
    </div>
  )
})

// A message that is STILL STREAMING (items keep `chunks` only while live —
// they're flattened to `content` when the run ends). Streams as plain text:
// re-parsing the growing reply as markdown on every reveal tick was O(n²).
// The finished message renders once through MessageBubble's markdown path.
const GlowMessage = memo(function GlowMessage({ role, chunks }: { role: 'user' | 'assistant'; chunks: string[] }) {
  const isUser = role === 'user'
  const text = chunks.join('')
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`group relative select-text max-w-[92%] min-w-0 overflow-hidden break-words whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed ${
          isUser
            ? 'bg-blue-600/20 border border-blue-500/30 text-zinc-100'
            : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
        }`}
      >
        {text}
      </div>
    </div>
  )
})

// Fade + rise-in wrapper for transcript items appearing one by one. A plain
// CSS animation (runs once on mount) — the previous framer-motion wrapper put
// hundreds of live motion components in long transcripts.
function RiseIn({ children }: { children: ReactNode }) {
  return <div className="rise-in">{children}</div>
}

// Renders text as per-word spans whose dark-dip animation is staggered by word
// index, so a dark band sweeps through the words in reading order (left→right,
// wrapping line to line) and loops. The whole band completes one pass per CYCLE.
// Codex-style shimmer: dim text with a brighter band sweeping horizontally.
// The gradient is clipped to the glyphs, so it flows smoothly at the pixel
// level (not per word). All wrapped lines share one moving band.
function ShimmerText({ text }: { text: string }) {
  return <span className="thinking-shimmer">{text}</span>
}

// A slim bar showing how full the model's context window is this turn. Turns
// amber past 75% and red past 90% so long runs get a visible warning.
function ContextMeter({ used, window }: { used: number; window: number }) {
  const pct = window > 0 ? Math.min(100, (used / window) * 100) : 0
  const color = pct >= 90 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-blue-500'
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
  return (
    <div className="flex items-center gap-1.5 px-0.5" title={`Context: ${used.toLocaleString()} / ${window.toLocaleString()} tokens`}>
      <span className="text-[9px] text-zinc-600 font-mono flex-shrink-0">ctx</span>
      <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full ${color} transition-all duration-300`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] text-zinc-500 font-mono flex-shrink-0">
        {fmt(used)}/{fmt(window)} · {pct.toFixed(0)}%
      </span>
    </div>
  )
}

// The model's reasoning ("thinking"), docked above the composer so it doesn't
// clutter the chat. Collapsed by default: shows the last couple of lines auto-
// scrolling like a ticker. Expand for the full, scrollable chain.
function ThinkingDock({ text, active }: { text: string; active: boolean }) {
  const [expanded, setExpanded] = useState(false)
  // "settled" = text has fully streamed in but the model is still thinking
  // (no new chunk for a beat). Drives the loading shimmer sweep.
  const [settled, setSettled] = useState(false)
  const tickerRef = useRef<HTMLDivElement>(null)

  // Keep the collapsed ticker pinned to the newest text as it streams.
  useEffect(() => {
    if (!expanded) tickerRef.current?.scrollTo({ top: tickerRef.current.scrollHeight })
  }, [text, expanded])

  // Whenever new reasoning text arrives, reset "settled"; if nothing new comes
  // for 700ms while still active, mark settled so the shimmer kicks in.
  useEffect(() => {
    setSettled(false)
    if (!active) return
    const t = setTimeout(() => setSettled(true), 700)
    return () => clearTimeout(t)
  }, [text.length, active])
  const shimmer = active && settled

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="border-t border-zinc-800 bg-zinc-900/40 flex-shrink-0"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
      >
        <Sparkles size={11} className={active ? 'text-violet-400 animate-pulse' : 'text-violet-400/60'} />
        <span>{active ? 'Thinking…' : 'Thought process'}</span>
        <span className="ml-auto text-zinc-600">{expanded ? 'collapse ▾' : 'expand ▴'}</span>
      </button>
      <div
        ref={tickerRef}
        className={`px-3 pb-2 text-[12.5px] leading-relaxed whitespace-pre-wrap overflow-y-auto scrollbar-thin transition-all ${
          shimmer ? '' : 'text-zinc-400'
        } ${expanded ? 'max-h-60' : 'max-h-10'}`}
        style={expanded ? undefined : { maskImage: 'linear-gradient(to bottom, transparent, black 40%)' }}
      >
        {/* Shimmer only on the small collapsed ticker — animating
            background-clip:text across the FULL expanded reasoning repainted
            a large text block every frame. */}
        {shimmer && !expanded ? <ShimmerText text={text} /> : <span>{text}</span>}
      </div>
    </motion.div>
  )
}

// Inline card for one tool call. Collapsed by default: a single summary line
// (icon + name + target). Expand to see the tool's output.
// A delegated child agent, rendered as a nested collapsible card that
// subscribes to the child's own run channel and streams its live activity.
const SubAgentCard = memo(function SubAgentCard({ entry }: { entry: SubAgentEntry }) {
  const [open, setOpen] = useState(false)
  const [tools, setTools] = useState<ToolEntry[]>([])
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'running' | 'done' | 'error' | 'blocked'>('running')

  useEffect(() => {
    // Coalesce the child's token stream into one setState per frame — a
    // setState per IPC token re-rendered this card 30+ times a second.
    const buf = { text: '', raf: null as number | null }
    const flush = () => {
      buf.raf = null
      const chunk = buf.text
      buf.text = ''
      if (chunk) setText((t) => t + chunk)
    }
    const off = window.api.onAiAgentEvent(entry.childRunId, (e: IdeAgentEvent) => {
      if (e.type === 'token') {
        buf.text += e.delta
        if (buf.raf == null) buf.raf = requestAnimationFrame(flush)
        return
      }
      if (buf.raf != null) { cancelAnimationFrame(buf.raf); flush() }
      if (e.type === 'tool_call') setTools((ts) => [...ts, { kind: 'tool', callId: e.callId, name: e.name, args: e.args, running: true }])
      else if (e.type === 'tool_result') setTools((ts) => ts.map((t) => t.callId === e.callId ? { ...t, result: e.result, isError: e.isError, running: false } : t))
      else if (e.type === 'done') { setStatus('done'); if (e.text) setText(e.text) }
      else if (e.type === 'error') { setStatus('error'); setText((t) => t + `\n⚠ ${e.error}`) }
      else if (e.type === 'blocked') { setStatus('blocked'); setText((t) => t + `\n⛔ ${e.reason}`) }
    })
    return () => {
      if (buf.raf != null) cancelAnimationFrame(buf.raf)
      off()
    }
  }, [entry.childRunId])

  const dot = status === 'running'
    ? <Loader2 size={12} className="animate-spin text-blue-400" />
    : status === 'done' ? <Check size={12} className="text-emerald-400" />
    : <XCircle size={12} className="text-rose-400" />
  const runningTools = tools.filter((t) => !t.running).length

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 text-[11px] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-violet-500/10 transition-colors"
      >
        <ChevronRight size={12} className={`text-zinc-500 transition-transform flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Boxes size={12} className="text-violet-400 flex-shrink-0" />
        <span className="font-semibold text-violet-200 truncate">{entry.label}</span>
        <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 text-zinc-500">
          {runningTools > 0 && <span className="font-mono text-[10px]">{runningTools} tool{runningTools > 1 ? 's' : ''}</span>}
          {dot}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-0.5 space-y-1.5 border-t border-violet-500/20">
          <div className="text-[10px] text-zinc-500 italic pt-1.5 whitespace-pre-wrap">{entry.task}</div>
          {tools.map((t, i) => <ToolActivity key={i} entry={t} />)}
          {text.trim() && (
            <div className="rounded bg-zinc-900/60 border border-zinc-800 px-2 py-1.5">
              {/* Plain text while streaming; parse markdown once when done. */}
              {status === 'running'
                ? <div className="whitespace-pre-wrap break-words text-xs text-zinc-300">{text}</div>
                : <MessageContent text={text} />}
            </div>
          )}
        </div>
      )}
      {!open && status !== 'running' && text.trim() && (
        <div className="px-2.5 pb-2 -mt-0.5 text-[10px] text-zinc-400 line-clamp-2">{text.trim().slice(0, 160)}</div>
      )}
    </div>
  )
})

const ToolActivity = memo(function ToolActivity({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false)
  const icon = {
    Read: <FileText size={12} />,
    Write: <FilePlus2 size={12} />,
    Edit: <FilePen size={12} />,
    MultiEdit: <FilePen size={12} />,
    Grep: <Search size={12} />,
    Glob: <FolderSearch size={12} />,
    ListDir: <FolderTree size={12} />,
    Move: <FileInput size={12} />,
    Delete: <Trash size={12} />,
    Bash: <TerminalSquare size={12} />,
    BashBackground: <TerminalSquare size={12} />,
    BashOutput: <TerminalSquare size={12} />,
    KillBash: <Square size={12} />,
    OpenFile: <FileText size={12} />,
    GetOpenEditor: <FileCode size={12} />,
    ShowDiff: <FilePen size={12} />,
    PresentPlan: <ListPlus size={12} />,
    CreateTask: <ListPlus size={12} />,
    CreateGroup: <Boxes size={12} />,
    LoadToolGroup: <Boxes size={12} />,
    TodoWrite: <ListChecks size={12} />,
    WebFetch: <Globe size={12} />,
    WebSearch: <Globe size={12} />,
    Research: <Telescope size={12} />,
    GitStatus: <GitBranch size={12} />,
    GitDiff: <GitBranch size={12} />,
    GitLog: <GitCommitHorizontal size={12} />,
    GitBranch: <GitBranch size={12} />,
    GitAdd: <GitCommitHorizontal size={12} />,
    GitCommit: <GitCommitHorizontal size={12} />,
    GitPush: <GitPullRequestArrow size={12} />,
    GitPull: <GitPullRequestArrow size={12} />,
    GitCheckout: <GitBranch size={12} />,
    GitConfigGet: <UserCog size={12} />,
    GitConfigSet: <UserCog size={12} />,
    GitRemoteGet: <GitBranch size={12} />,
    GitRemoteSet: <GitBranch size={12} />,
    SwitchGitAccount: <UserCog size={12} />,
    SaveGitProfile: <UserCog size={12} />,
    ListGitProfiles: <UserCog size={12} />,
    GitHubAuthStatus: <UserCog size={12} />,
    GitHubAuthSwitch: <UserCog size={12} />,
    GitHubLogin: <UserCog size={12} />,
  }[entry.name] ?? <Wrench size={12} />

  const p = entry.args as { path?: string; pattern?: string; command?: string; title?: string; task_id?: string; url?: string; query?: string; branch?: string; profile?: string; from?: string; account?: string }
  const target = p.path || p.pattern || p.command || p.title || p.task_id || p.url || p.query || p.branch || p.profile || p.from || p.account || ''
  const hasResult = Boolean(entry.result) && !entry.running

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 text-[11px]">
      <button
        onClick={() => hasResult && setOpen((v) => !v)}
        className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left ${hasResult ? 'hover:bg-zinc-800/40' : 'cursor-default'}`}
      >
        <span className="text-zinc-400">{icon}</span>
        <span className="font-semibold text-zinc-300">{entry.name}</span>
        {target && <span className="font-mono text-zinc-500 truncate">{target}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {hasResult && <span className="text-zinc-600 text-[9px]">{open ? '▾' : '▸'}</span>}
          {entry.running ? (
            <span className="size-1.5 rounded-full bg-blue-400 animate-pulse inline-block" />
          ) : entry.isError ? (
            <XCircle size={12} className="text-rose-400" />
          ) : (
            <CheckCircle2 size={12} className="text-emerald-400" />
          )}
        </span>
      </button>
      {open && hasResult && (
        <pre className={`px-2.5 pb-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-snug scrollbar-thin ${
          entry.isError ? 'text-rose-300/80' : 'text-zinc-500'
        }`}>
          {entry.result!.length > 1000 ? entry.result!.slice(0, 1000) + '…' : entry.result}
        </pre>
      )}
    </div>
  )
})
