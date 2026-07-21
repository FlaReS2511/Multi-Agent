import React, { useEffect, useState, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import '../lib/monacoSetup' // local Monaco + workers (no CDN) — before <Editor>
import Editor, { DiffEditor } from '@monaco-editor/react'
import {
  FolderTree,
  GitBranch,
  Globe,
  MessagesSquare,
  Terminal as TerminalIcon,
  Save,
  Split,
  Eye,
  ChevronDown,
  ChevronUp,
  X,
  RefreshCw,
  Layout,
  Cpu,
  ArrowRight,
  Search as SearchIcon,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Boxes,
  Crosshair,
  ChevronsDownUp,
} from 'lucide-react'
import { IDEFileTree } from './IDEFileTree'
import { AgentTerminal } from './AgentTerminal'
import { ShellTerminal } from './ShellTerminal'
import { InlineAIPrompt } from './InlineAIPrompt'
import { InlineAICard } from './InlineAICard'
import { CommandPalette, Command } from './CommandPalette'
import { ChatPanel } from './ChatPanel'
import { DiffReviewCard } from './DiffReviewCard'
import { ConfirmDialog, ConfirmDialogSpec } from './ConfirmDialog'
import { StatusBar } from './StatusBar'
import { OrqonLogo } from './OrqonLogo'
import { useAnimationsEnabled, useUiSettings, setUiSetting } from '../lib/uiSettings'
import { toast } from '../lib/toast'
import { computeLineDiff } from '../lib/lineDiff'
import { useInlineAIEdit } from './useInlineAIEdit'
import { activeAgents, AgentsConfig, colorFor, ModelOption, isResidentRole, PendingChange } from '../lib/api'

// Sidebar panels that aren't part of the first paint load as their own
// chunks — the explorer is the default view; git/search/groups/agents come
// in on demand.
const SearchPanel = lazy(() => import('./SearchPanel').then((m) => ({ default: m.SearchPanel })))
const GitPanel = lazy(() => import('./GitPanel').then((m) => ({ default: m.GitPanel })))
const GroupsPanel = lazy(() => import('./GroupsPanel').then((m) => ({ default: m.GroupsPanel })))
const AgentsLivePanel = lazy(() => import('./AgentsLivePanel').then((m) => ({ default: m.AgentsLivePanel })))

// Sentinel tab id for the embedded agent browser (not a file on disk).
const BROWSER_TAB = 'orqon://browser'

interface FileNode {
  name: string
  relPath: string
  isDir: boolean
  children?: FileNode[]
}

interface GitChange {
  file: string
  type: string
  staged?: boolean
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'py':
      return 'python'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
      return 'markdown'
    case 'sh':
      return 'shell'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}

// Wind-up: sidebar content sections rise/fade in after the panel slides open.
const SIDEBAR_CONTAINER = {
  hidden: {},
  show: { transition: { delayChildren: 0.14, staggerChildren: 0.06 } },
}
const SIDEBAR_ITEM = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.26, ease: 'easeOut' } },
}

export function IDEView() {
  // Sidebar State
  const [activeSidebar, setActiveSidebar] = useState<'explorer' | 'search' | 'git' | 'agents' | 'groups'>('explorer')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  // Resizable chat panel width (drag the left edge), persisted.
  const [chatWidth, setChatWidth] = useState(() => {
    const v = Number(localStorage.getItem('orqon.chatWidth'))
    return v >= 280 && v <= 900 ? v : 360
  })
  const draggingChatRef = useRef(false)
  const startChatResize = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingChatRef.current = true
    const startX = e.clientX
    const startW = chatWidth
    let latest = startW
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(900, Math.max(280, startW + (startX - ev.clientX)))
      setChatWidth(latest)
    }
    const onUp = () => {
      draggingChatRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('orqon.chatWidth', String(latest))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const animationsOn = useAnimationsEnabled()
  const ui = useUiSettings()

  // Whole-app zoom (persisted). Applied on mount and whenever it changes.
  useEffect(() => {
    try { window.api.setZoomFactor?.(ui.zoom) } catch { /* ignore */ }
  }, [ui.zoom])
  // Minimap is hidden while a side panel animates its width (it flickers on
  // frame-by-frame relayout) and restored once the animation settles.
  const [minimapOn, setMinimapOn] = useState(true)

  // Workspace root
  const [workspaceName, setWorkspaceName] = useState<string>('')
  const [workspaceRootPath, setWorkspaceRootPath] = useState<string>('')
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([])
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false)

  // Files & Git State
  const [files, setFiles] = useState<FileNode[]>([])
  const [gitChanges, setGitChanges] = useState<GitChange[]>([])
  const [loadingWorkspace, setLoadingWorkspace] = useState(false)
  const [gitBranch, setGitBranch] = useState<{ current: string; branches: string[] }>({ current: '', branches: [] })

  // Status-bar signals (cursor position lives inside StatusBar itself — a
  // caret move must not re-render the whole IDE)
  const [agentBusy, setAgentBusy] = useState(false)
  const [chatCtxUsage, setChatCtxUsage] = useState<{ used: number; window: number } | null>(null)
  // Chat badge: an agent run finished while the chat panel was closed.
  const [chatUnread, setChatUnread] = useState(false)

  // Editor Tabs State
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  // Recently closed tabs (Cmd+Shift+T reopens), newest last.
  const closedTabsRef = useRef<string[]>([])
  // Tab currently being drag-reordered.
  const dragTabRef = useRef<string | null>(null)
  // Shared confirm dialog (dirty-close, deletes, discards).
  const [dialog, setDialog] = useState<ConfirmDialogSpec | null>(null)

  // File Contents — live buffers live OUTSIDE React state so a keystroke never
  // re-renders the whole IDE (Monaco runs uncontrolled via path+defaultValue,
  // one model per open file). Consumers that must re-render when a buffer is
  // REPLACED from outside the editor (open / live-reload / discard / agent
  // write) key off `bufferEpoch`.
  const contentsRef = useRef(new Map<string, string>())
  const originalsRef = useRef(new Map<string, string>())
  const [, setBufferEpoch] = useState(0)
  const bumpBuffers = useCallback(() => setBufferEpoch((n) => n + 1), [])
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({})
  // Ref mirrors so stable callbacks can read live state without depending on it.
  const dirtyRef = useRef(dirtyFiles)
  useEffect(() => { dirtyRef.current = dirtyFiles }, [dirtyFiles])
  const openTabsRef = useRef<string[]>([])
  useEffect(() => { openTabsRef.current = openTabs }, [openTabs])
  const gitChangesRef = useRef<GitChange[]>([])
  useEffect(() => { gitChangesRef.current = gitChanges }, [gitChanges])

  // Editor View Configuration
  const [diffMode, setDiffMode] = useState(false)
  const [renderSideBySide, setRenderSideBySide] = useState(false) // default inline diff (green/red lines)

  // Bottom dock panel state
  const [isBottomOpen, setIsBottomOpen] = useState(true)
  const [bottomTab, setBottomTab] = useState<'terminal' | 'shell' | 'logs'>('terminal')
  // Resizable dock height (drag the top edge), persisted.
  const [dockHeight, setDockHeight] = useState(() => {
    const v = Number(localStorage.getItem('orqon.dockHeight'))
    return v >= 120 && v <= 800 ? v : 256
  })
  const [draggingDock, setDraggingDock] = useState(false)
  const startDockResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDraggingDock(true)
    const startY = e.clientY
    const startH = dockHeight
    let latest = startH
    const maxH = Math.round(window.innerHeight * 0.7)
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(maxH, Math.max(120, startH + (startY - ev.clientY)))
      setDockHeight(latest)
    }
    const onUp = () => {
      setDraggingDock(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('orqon.dockHeight', String(latest))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Multiple user shells (tabs in the dock). All stay mounted (hidden when
  // inactive) so their buffers survive switching.
  const [shells, setShells] = useState<{ id: string; name: string }[]>([{ id: 'shell-1', name: 'shell 1' }])
  const [activeShell, setActiveShell] = useState('shell-1')
  const shellCounterRef = useRef(1)
  const [renamingShell, setRenamingShell] = useState<string | null>(null)
  const [shellNameDraft, setShellNameDraft] = useState('')

  const addShell = () => {
    const n = ++shellCounterRef.current
    const id = `shell-${n}`
    setShells((prev) => [...prev, { id, name: `shell ${n}` }])
    setActiveShell(id)
    setBottomTab('shell')
    setIsBottomOpen(true)
  }

  const closeShell = (id: string) => {
    window.api.shellKill(id).catch(() => {})
    setShells((prev) => {
      const next = prev.filter((s) => s.id !== id)
      if (activeShell === id && next.length) setActiveShell(next[next.length - 1].id)
      return next
    })
  }
  const [selectedAgent, setSelectedAgent] = useState<string>('orchestrator')
  const [agentsConfig, setAgentsConfig] = useState<AgentsConfig | null>(null)
  const [agentLogs, setAgentLogs] = useState<Record<string, string[]>>({})

  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  // Bumped when the (normal) Monaco editor mounts, so effects that need the
  // editor instance re-run.
  const [editorReady, setEditorReady] = useState(0)
  // The pulsing "agent revealed this line" decoration; cleared on any click/key.
  const revealDecoRef = useRef<any>(null)
  // Git gutter decorations (added/modified/deleted vs HEAD) for the active tab.
  const gitGutterRef = useRef<any>(null)
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])

  // Replace a buffer from OUTSIDE the editor (live-reload, agent write,
  // discard, restore). Updates the ref AND the Monaco model if one exists for
  // that path (the Editor `path` prop keys models by relPath).
  const setBufferText = useCallback((rel: string, text: string) => {
    contentsRef.current.set(rel, text)
    const mon = monacoRef.current
    if (mon) {
      try {
        const model = mon.editor.getModel(mon.Uri.parse(rel))
        if (model && model.getValue() !== text) model.setValue(text)
      } catch { /* model not created yet — defaultValue reads the ref */ }
    }
    bumpBuffers()
  }, [bumpBuffers])

  // Drop the Monaco model for a path (tab close / rename / workspace switch)
  // so models don't accumulate and a reopen re-reads from disk. Deferred a
  // tick: the mounted <Editor> may still be attached to this model right now —
  // React swaps its `path` on the commit that follows the state update.
  const disposeModel = useCallback((rel: string) => {
    setTimeout(() => {
      try { monacoRef.current?.editor.getModel(monacoRef.current.Uri.parse(rel))?.dispose() } catch { /* ignore */ }
    }, 0)
  }, [])

  // Keep the editor sized in lockstep with the side-panel width animation, and
  // fade the minimap out/in instead of hard-toggling it. The minimap is a
  // Monaco-managed canvas, so we animate its DOM node's opacity directly, then
  // actually remove/re-add it via the `minimapOn` option so it never repaints
  // (flickers) mid-resize.
  const layoutRaf = useRef<number | null>(null)
  const minimapHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const getMinimapNode = (): HTMLElement | null => {
    try { return editorRef.current?.getDomNode()?.querySelector('.minimap') ?? null }
    catch { return null }
  }

  const startLayoutSync = useCallback(() => {
    // Fade the minimap out, then remove it.
    if (minimapHideTimer.current) clearTimeout(minimapHideTimer.current)
    const node = getMinimapNode()
    if (node) {
      // ease-out so opacity drops fast on the first frames — otherwise the
      // minimap stays near-opaque while layout() resizes it → brief flicker.
      node.style.transition = 'opacity 140ms ease-out'
      node.style.opacity = '0'
      node.style.pointerEvents = 'none'
      minimapHideTimer.current = setTimeout(() => setMinimapOn(false), 140)
    } else {
      setMinimapOn(false)
    }

    if (layoutRaf.current != null) return
    const tick = () => {
      try { editorRef.current?.layout() } catch { /* ignore */ }
      layoutRaf.current = requestAnimationFrame(tick)
    }
    layoutRaf.current = requestAnimationFrame(tick)
  }, [])

  const stopLayoutSync = useCallback(() => {
    if (layoutRaf.current != null) { cancelAnimationFrame(layoutRaf.current); layoutRaf.current = null }
    // One final layout to settle at the exact end width, then surface the minimap.
    try { editorRef.current?.layout() } catch { /* ignore */ }
    if (minimapHideTimer.current) { clearTimeout(minimapHideTimer.current); minimapHideTimer.current = null }
    setMinimapOn(true)
  }, [])

  // When the minimap is re-enabled, Monaco recreates its node at rest; start it
  // hidden and fade it back in on the next frame.
  useEffect(() => {
    if (!minimapOn) return
    let raf1 = 0, raf2 = 0
    raf1 = requestAnimationFrame(() => {
      const node = getMinimapNode()
      if (!node) return
      node.style.transition = 'none'
      node.style.opacity = '0'
      // Force a reflow so the starting state sticks before we transition.
      void node.offsetHeight
      raf2 = requestAnimationFrame(() => {
        node.style.transition = 'opacity 240ms ease-out'
        node.style.opacity = '1'
        node.style.pointerEvents = ''
      })
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [minimapOn])

  // Inline "Ask AI" edit controller, bound to the active file's language.
  const inlineAI = useInlineAIEdit(editorRef, monacoRef, detectLanguage(activeTab || ''))

  // Snapshot of the current editor context for the chat panel (called fresh
  // at send time so the model always sees the latest file + selection).
  const getChatContext = useCallback(() => {
    if (!activeTab || activeTab === BROWSER_TAB) return null
    const content = contentsRef.current.get(activeTab) ?? ''
    let selection: string | undefined
    const editor = editorRef.current
    if (editor) {
      const sel = editor.getSelection()
      if (sel && !sel.isEmpty()) {
        selection = editor.getModel()?.getValueInRange(sel) || undefined
      }
    }
    return {
      path: activeTab,
      language: detectLanguage(activeTab),
      content,
      selection,
    }
  }, [activeTab])

  // Git status/branch fetch shared by the 2s poll, refreshWorkspace and the
  // GitPanel. Compare-before-set: an unchanged poll causes ZERO re-renders.
  const refreshGitInfo = useCallback(async () => {
    try {
      const [changes, b] = await Promise.all([
        window.api.workspaceGitStatus(),
        window.api.workspaceGitBranch().catch(() => ({ current: '', branches: [] as string[] })),
      ])
      setGitChanges((prev) => (JSON.stringify(prev) === JSON.stringify(changes) ? prev : changes))
      setGitBranch((prev) => (JSON.stringify(prev) === JSON.stringify(b) ? prev : b))
    } catch { /* not a repo */ }
  }, [])

  // Scan workspace files
  const refreshWorkspace = useCallback(async () => {
    setLoadingWorkspace(true)
    try {
      const allFiles = await window.api.workspaceListFiles()
      setFiles((prev) => (JSON.stringify(prev) === JSON.stringify(allFiles) ? prev : allFiles))
      await refreshGitInfo()
    } catch (err) {
      console.error('Failed to load workspace files:', err)
    } finally {
      setLoadingWorkspace(false)
    }
  }, [refreshGitInfo])

  // Load workspace root info. Returns the root path (session-restore key).
  const loadWorkspaceInfo = useCallback(async (): Promise<string> => {
    const info = await window.api.workspaceGetRoot()
    setWorkspaceName(info.name)
    setWorkspaceRootPath(info.root)
    setRecentWorkspaces(info.recent ?? [])
    return info.root
  }, [])

  // ── Session restore (per-workspace) ─────────────────────────
  // Open tabs + layout are persisted per workspace root so a restart (or a
  // workspace switch) puts the IDE back exactly where it was.
  interface WorkspaceSession {
    openTabs: string[]
    activeTab: string | null
    activeSidebar: typeof activeSidebar
    isSidebarOpen: boolean
    chatOpen: boolean
    bottomTab: typeof bottomTab
    isBottomOpen: boolean
  }
  // Gate persisting until the initial restore ran, so an early render doesn't
  // overwrite the saved session with empty state.
  const sessionReadyRef = useRef(false)

  const restoreSession = useCallback(async (root: string) => {
    try {
      const raw = localStorage.getItem('orqon.session.' + root)
      if (!raw) return
      const s = JSON.parse(raw) as Partial<WorkspaceSession>
      if (s.activeSidebar) setActiveSidebar(s.activeSidebar)
      if (typeof s.isSidebarOpen === 'boolean') setIsSidebarOpen(s.isSidebarOpen)
      if (typeof s.chatOpen === 'boolean') setChatOpen(s.chatOpen)
      if (s.bottomTab) setBottomTab(s.bottomTab)
      if (typeof s.isBottomOpen === 'boolean') setIsBottomOpen(s.isBottomOpen)
      // Reopen tabs that still exist on disk — all in parallel (this used to
      // load tabs one by one, each with its own git subprocess, before paint).
      const entries = await Promise.all((s.openTabs ?? []).map(async (t) => {
        try {
          const disk = await window.api.workspaceReadFile(t)
          if (!disk.ok) return null
          const head = await window.api.workspaceGitShowHead(t).catch(() => ({ ok: false, content: '' }))
          return { t, content: disk.content, head: head.ok ? head.content : '' }
        } catch { return null }
      }))
      const tabs: string[] = []
      for (const e of entries) {
        if (!e) continue
        tabs.push(e.t)
        contentsRef.current.set(e.t, e.content)
        originalsRef.current.set(e.t, e.head)
      }
      bumpBuffers()
      if (tabs.length) {
        setOpenTabs(tabs)
        setActiveTab(s.activeTab && tabs.includes(s.activeTab) ? s.activeTab : tabs[tabs.length - 1])
      }
    } catch { /* corrupted session — start clean */ }
  }, [bumpBuffers])

  // Switch to a different workspace folder, then reset editor state and
  // restore that workspace's own session.
  const switchWorkspace = useCallback(async (dir?: string) => {
    const res = dir
      ? await window.api.workspaceSetRoot(dir)
      : await window.api.workspaceOpenDialog()
    if (!res.ok) return
    setShowWorkspaceMenu(false)
    setOpenTabs([])
    setActiveTab(null)
    for (const rel of Array.from(contentsRef.current.keys())) disposeModel(rel)
    contentsRef.current.clear()
    originalsRef.current.clear()
    bumpBuffers()
    setDirtyFiles({})
    closedTabsRef.current = []
    const root = await loadWorkspaceInfo()
    await refreshWorkspace()
    if (root) await restoreSession(root)
  }, [loadWorkspaceInfo, restoreSession, refreshWorkspace, disposeModel, bumpBuffers])

  // Load agents config to get the list of active agents
  useEffect(() => {
    window.api.getAgentsConfig().then((cfg) => {
      setAgentsConfig(cfg)
      setAvailableModels(cfg.available_models ?? [])
    })
    loadWorkspaceInfo().then(async (root) => {
      if (root && !sessionReadyRef.current) {
        await restoreSession(root)
        sessionReadyRef.current = true
      }
    })
    refreshWorkspace()
  }, [refreshWorkspace, loadWorkspaceInfo, restoreSession])

  // Persist the session (debounced) whenever layout/tabs change.
  useEffect(() => {
    if (!workspaceRootPath || !sessionReadyRef.current) return
    const timer = setTimeout(() => {
      const s: WorkspaceSession = { openTabs, activeTab, activeSidebar, isSidebarOpen, chatOpen, bottomTab, isBottomOpen }
      try { localStorage.setItem('orqon.session.' + workspaceRootPath, JSON.stringify(s)) } catch { /* ignore */ }
    }, 400)
    return () => clearTimeout(timer)
  }, [workspaceRootPath, openTabs, activeTab, activeSidebar, isSidebarOpen, chatOpen, bottomTab, isBottomOpen])

  // Window title reflects the workspace.
  useEffect(() => {
    document.title = workspaceName ? `${workspaceName} — Orqon` : 'Orqon'
  }, [workspaceName])

  // Get active agents list
  const agentsList = activeAgents(agentsConfig)
  // The AI Agents tab shows only resident coordination agents (planner,
  // orchestrator). Engineers/reviewers run as ephemeral group sessions and live
  // in the Groups panel instead. The bottom-dock PTY dropdown still uses the
  // full agentsList so a resident agent's terminal stays reachable.
  const residentAgents = agentsList.filter(isResidentRole)

  // Periodically refresh Git status/branch (+ agent logs only while a surface
  // that shows them is visible). Skips entirely while the window is hidden;
  // compare-before-set keeps an unchanged poll completely render-free.
  const logsVisible = (isBottomOpen && bottomTab === 'logs') || (isSidebarOpen && activeSidebar === 'agents')
  useEffect(() => {
    const tick = async () => {
      if (document.hidden) return
      await refreshGitInfo()
      if (logsVisible) {
        const allLogs = await window.api.getLogs()
        const logMap: Record<string, string[]> = {}
        for (const entry of allLogs) {
          logMap[entry.agent] = entry.lines
        }
        setAgentLogs((prev) => (JSON.stringify(prev) === JSON.stringify(logMap) ? prev : logMap))
      }
    }

    tick()
    const i = setInterval(tick, 2000)
    return () => clearInterval(i)
  }, [refreshGitInfo, logsVisible])

  // Toast orchestration group outcomes (passed/failed/killed).
  useEffect(() => {
    return window.api.onCoordinatorEvent(({ event, payload }) => {
      const p = payload as { group?: string; task?: string; reason?: string }
      if (event === 'group-passed') toast(`Group ${p.group} passed — task ${p.task} done`, 'success')
      else if (event === 'group-failed') toast(`Group ${p.group} failed${p.reason ? `: ${p.reason}` : ''}`, 'error')
      else if (event === 'group-killed') toast(`Group ${p.group} killed${p.reason ? `: ${p.reason}` : ''}`, 'info')
    })
  }, [])

  // Live-reload logic when AI modifies files on disk. Depends only on the
  // active tab — the old deps on fileContents/dirtyFiles rebuilt this interval
  // on every keystroke; live values are read from refs instead.
  useEffect(() => {
    if (!activeTab || activeTab === BROWSER_TAB) return
    const rel = activeTab

    const checkFileOnDisk = async () => {
      if (document.hidden) return
      try {
        const diskFile = await window.api.workspaceReadFile(rel)
        if (!diskFile.ok) return

        // If the disk content changed and the user has no unsaved edits,
        // reload live — this is how agent writes appear as they happen.
        if (diskFile.content !== contentsRef.current.get(rel) && !dirtyRef.current[rel]) {
          setBufferText(rel, diskFile.content)
          // Re-fetch the HEAD baseline in case the agent committed.
          const originalFile = await window.api.workspaceGitShowHead(rel)
          if (originalFile.ok) {
            originalsRef.current.set(rel, originalFile.content)
            bumpBuffers()
          }
        }
      } catch (err) {
        console.error('Failed to live-reload file:', err)
      }
    }

    const timer = setInterval(checkFileOnDisk, 2000)
    return () => clearInterval(timer)
  }, [activeTab, setBufferText, bumpBuffers])

  // ── Git gutter: mark added/modified/deleted lines vs HEAD ──────────
  // Driven by Monaco's own content-change event (debounced) instead of React
  // state — the old version re-ran on every keystroke via its fileContents
  // dep. computeLineDiff trims the common prefix/suffix, so the LCS cost is
  // proportional to the edited region, not the file.
  useEffect(() => {
    const ed = editorRef.current
    const mon = monacoRef.current
    if (!ed || !mon || !activeTab || activeTab === BROWSER_TAB || diffMode) {
      try { gitGutterRef.current?.clear() } catch { /* ignore */ }
      return
    }
    const rel = activeTab
    let timer: ReturnType<typeof setTimeout> | null = null
    const last = { before: '', after: '', painted: false }

    const recompute = () => {
      const before = originalsRef.current.get(rel)
      const after = contentsRef.current.get(rel)
      if (last.painted && before === last.before && after === last.after) return
      last.before = before ?? ''
      last.after = after ?? ''
      last.painted = true
      try { gitGutterRef.current?.clear() } catch { /* ignore */ }
      if (before == null || after == null || before === after) return
      const rows = computeLineDiff(before, after)
      const decos: { range: unknown; options: Record<string, unknown> }[] = []
      let i = 0
      while (i < rows.length) {
        if (rows[i].kind === 'context') { i++; continue }
        // Hunk: consecutive non-context rows.
        const addLines: number[] = []
        let delCount = 0
        while (i < rows.length && rows[i].kind !== 'context') {
          if (rows[i].kind === 'add' && rows[i].newNo) addLines.push(rows[i].newNo!)
          else if (rows[i].kind === 'del') delCount++
          i++
        }
        if (addLines.length > 0) {
          const cls = delCount > 0 ? 'git-gutter-mod' : 'git-gutter-add'
          // Compress consecutive line numbers into ranges.
          let start = addLines[0]
          let prev = addLines[0]
          for (let k = 1; k <= addLines.length; k++) {
            const cur = addLines[k]
            if (cur !== prev + 1) {
              decos.push({ range: new mon.Range(start, 1, prev, 1), options: { linesDecorationsClassName: cls } })
              start = cur
            }
            prev = cur
          }
        } else if (delCount > 0) {
          // Deletion-only hunk: mark the line where content was removed.
          const line = rows[i]?.newNo ?? Math.max(1, after.split('\n').length)
          decos.push({ range: new mon.Range(line, 1, line, 1), options: { linesDecorationsClassName: 'git-gutter-del' } })
        }
      }
      if (decos.length) gitGutterRef.current = ed.createDecorationsCollection(decos)
    }

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(recompute, 400)
    }
    schedule() // initial paint for this tab
    const sub = ed.onDidChangeModelContent(schedule)
    return () => {
      if (timer) clearTimeout(timer)
      try { sub.dispose() } catch { /* ignore */ }
    }
  }, [activeTab, diffMode, editorReady])

  // Discard a file's uncommitted changes (Git panel) after confirmation.
  const handleDiscardFile = useCallback((file: string) => {
    setDialog({
      title: `Discard changes in "${file.split('/').pop()}"?`,
      message: `${file}\n\nThe file will be restored to its last committed state (untracked files are deleted).`,
      buttons: [
        {
          label: 'Discard', kind: 'danger',
          onClick: async () => {
            setDialog(null)
            const res = await window.api.workspaceGitRestoreFiles([file])
            if (res.ok) {
              toast(`Discarded changes in ${file.split('/').pop()}`, 'success')
              // Reload the buffer if it's open.
              const disk = await window.api.workspaceReadFile(file)
              if (disk.ok) {
                setBufferText(file, disk.content)
                setDirtyFiles((p) => ({ ...p, [file]: false }))
              } else {
                // Untracked file was deleted by the restore.
                setOpenTabs((tabs) => tabs.filter((t) => t !== file))
                setActiveTab((t) => (t === file ? null : t))
              }
              await refreshWorkspace()
            } else {
              toast(res.failed?.length ? `Could not discard: ${res.failed.join(', ')}` : 'Discard failed', 'error')
            }
          },
        },
        { label: 'Cancel', onClick: () => setDialog(null) },
      ],
    })
  }, [refreshWorkspace])

  // Handle open a file. Stable identity (reads live state from refs) so the
  // memoized tree/palette/panels that receive it don't re-render for nothing.
  const openFile = useCallback(async (relPath: string) => {
    // If not already in tabs, load content + HEAD baseline (in parallel), then add it
    if (!openTabsRef.current.includes(relPath)) {
      const [diskFile, originalFile] = await Promise.all([
        window.api.workspaceReadFile(relPath),
        window.api.workspaceGitShowHead(relPath).catch(() => ({ ok: false, content: '' })),
      ])
      contentsRef.current.set(relPath, diskFile.ok ? diskFile.content : `Failed to load file: ${diskFile.content}`)
      originalsRef.current.set(relPath, originalFile.ok ? originalFile.content : '')
      bumpBuffers()
      setOpenTabs((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]))
    }

    setActiveTab(relPath)

    // Automatically enable diff mode if the file is modified in git (added/modified)
    setDiffMode(gitChangesRef.current.some((c) => c.file === relPath))
  }, [bumpBuffers])

  // Open a file and jump the editor to a specific line/column (search results).
  const openFileAtLine = useCallback(async (relPath: string, line: number, column: number) => {
    await openFile(relPath)
    setDiffMode(false)
    // Give Monaco a tick to mount/switch models before revealing.
    setTimeout(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: Math.max(1, column) })
      editor.focus()
    }, 120)
  }, [openFile])

  // Called when the IDE agent writes/edits a file. Re-read it from disk if it's
  // open so the editor reflects the agent's change, and refresh tree + git.
  const onAgentFileChanged = useCallback(async (relPath: string) => {
    if (contentsRef.current.has(relPath)) {
      const disk = await window.api.workspaceReadFile(relPath)
      if (disk.ok) setBufferText(relPath, disk.content)
    }
    refreshWorkspace()
  }, [setBufferText, refreshWorkspace])

  // ── Agent review mode: pending change awaiting the user's verdict ─────
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null)

  const onPendingChange = useCallback((change: PendingChange) => {
    // Bring the target file into view so the user reviews it in context. For a
    // brand-new file there's nothing on disk yet; open a preview tab anyway so
    // the card floats over a sensible spot.
    setPendingChange(change)
    if (change.isNew) {
      setOpenTabs((prev) => (prev.includes(change.path) ? prev : [...prev, change.path]))
      if (!contentsRef.current.has(change.path)) {
        contentsRef.current.set(change.path, change.before)
        originalsRef.current.set(change.path, '')
        bumpBuffers()
      }
      setActiveTab(change.path)
      setDiffMode(false)
    } else {
      openFile(change.path)
    }
  }, [openFile, bumpBuffers])

  const resolvePending = useCallback((decision: 'accept' | 'reject') => {
    const change = pendingChange
    if (!change) return
    window.api.aiAgentReview(change.changeId, decision).catch(() => {})
    setPendingChange(null)
    // The agent emits file_changed on accept, which triggers onAgentFileChanged
    // and reloads the content live — no extra reload needed here.
  }, [pendingChange])

  // Clear the card if the run ends/aborts while a change is still on screen.
  const onChangeResolved = useCallback((changeId: string) => {
    setPendingChange((cur) => (cur && cur.changeId === changeId ? null : cur))
  }, [])

  // ── Editor round-trip tools (OpenFile / GetOpenEditor / ShowDiff) ─────
  // A read-only diff the agent asked to display (ShowDiff). Dismiss-only.
  const [previewDiff, setPreviewDiff] = useState<PendingChange | null>(null)

  // Remove the pulsing reveal highlight + its dismiss listeners.
  const clearReveal = useCallback(() => {
    if (revealDecoRef.current) { try { revealDecoRef.current.clear() } catch { /* ignore */ } revealDecoRef.current = null }
    window.removeEventListener('mousedown', clearReveal)
    window.removeEventListener('keydown', clearReveal)
  }, [])
  useEffect(() => () => clearReveal(), [clearReveal])

  const onEditorRequest = useCallback(async (
    op: 'OpenFile' | 'GetOpenEditor' | 'ShowDiff',
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result: string }> => {
    try {
      if (op === 'OpenFile') {
        const rel = String(args.path ?? '')
        if (!rel) return { ok: false, result: 'error: path required' }
        await openFile(rel)
        const line = typeof args.line === 'number' ? args.line : undefined
        if (line) {
          // openFile only sets state — Monaco hasn't swapped to the new file's
          // model yet, so revealing now scrolls the wrong (old) content. Wait
          // for the model to actually load `line` lines, THEN center + pulse.
          const reveal = (tries = 0) => {
            const ed = editorRef.current
            const mon = monacoRef.current
            if (!ed || !mon) return
            const model = ed.getModel?.()
            if ((!model || model.getLineCount() < line) && tries < 25) {
              setTimeout(() => reveal(tries + 1), 40)
              return
            }
            try {
              ed.revealLineInCenter(line)
              ed.setPosition({ lineNumber: line, column: 1 })
              ed.focus()
              // Pulse the target line (bright↔dim, like a warning). Keeps pulsing
              // until the user clicks or types anywhere.
              clearReveal() // drop any previous reveal first
              revealDecoRef.current = ed.createDecorationsCollection([{
                range: new mon.Range(line, 1, line, 1),
                options: { isWholeLine: true, className: 'agent-reveal-line', linesDecorationsClassName: 'agent-reveal-gutter' },
              }])
              window.addEventListener('mousedown', clearReveal)
              window.addEventListener('keydown', clearReveal)
            } catch { /* ignore */ }
          }
          requestAnimationFrame(() => reveal())
        }
        return { ok: true, result: `opened ${rel}${line ? ` at line ${line}` : ''}` }
      }
      if (op === 'GetOpenEditor') {
        const ctx = getChatContext()
        if (!ctx) return { ok: true, result: 'no file is open in the editor' }
        const body = ctx.content.length > 12000 ? ctx.content.slice(0, 12000) + '\n… (truncated)' : ctx.content
        let out = `open file: ${ctx.path}\n\n${body}`
        if (ctx.selection) out += `\n\n--- current selection ---\n${ctx.selection.slice(0, 4000)}`
        return { ok: true, result: out }
      }
      if (op === 'ShowDiff') {
        const rel = String(args.path ?? '')
        const newContent = String(args.new_content ?? '')
        if (!rel) return { ok: false, result: 'error: path required' }
        const disk = await window.api.workspaceReadFile(rel)
        const before = disk.ok ? disk.content : ''
        await openFile(rel)
        setPreviewDiff({
          changeId: `preview-${Date.now()}`,
          path: rel, kind: 'edit', before, after: newContent,
          isNew: !disk.ok, note: 'preview (not applied)',
        })
        return { ok: true, result: `showing diff for ${rel} (not applied — use Write/Edit to apply)` }
      }
      return { ok: false, result: `error: unknown editor op ${op}` }
    } catch (e) {
      return { ok: false, result: `error: ${(e as Error).message || e}` }
    }
  }, [getChatContext, openFile, clearReveal])

  // Stable ChatPanel callbacks (the panel is React.memo'd — inline closures
  // here would defeat it and re-render the heaviest child on every render).
  const chatOpenRef = useRef(chatOpen)
  useEffect(() => { chatOpenRef.current = chatOpen }, [chatOpen])
  const onSubAgentStarted = useCallback(() => { setActiveSidebar('agents'); setIsSidebarOpen(true) }, [])
  const onChatRunFinished = useCallback((info: { kind: 'done' | 'error' | 'blocked' | 'plan' }) => {
    if (chatOpenRef.current) return
    setChatUnread(true)
    if (info.kind === 'done') toast('Agent finished', 'success')
    else if (info.kind === 'plan') toast('Plan ready for review', 'info')
    else if (info.kind === 'blocked') toast('Agent blocked — see chat', 'error')
    else toast('Agent run failed — see chat', 'error')
  }, [])

  // Flatten the file tree into relative paths for quick-open.
  const flatFiles = useMemo(() => {
    const out: string[] = []
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.isDir) { if (n.children) walk(n.children) }
        else out.push(n.relPath)
      }
    }
    walk(files)
    return out
  }, [files])

  // Command palette / quick-open state.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files'>('files')

  // ── Embedded agent browser tab ──────────────────────────────────
  // The page itself is a WebContentsView owned by MAIN (a webview guest is
  // invisible to playwright over CDP); this component reserves a placeholder
  // rect for it and streams the bounds. `orqon://browser` is a sentinel entry
  // in the normal tab list.
  const [browserUrl, setBrowserUrl] = useState('')
  const [browserAddr, setBrowserAddr] = useState('') // editable address bar text
  const browserHostRef = useRef<HTMLDivElement>(null)
  useEffect(() => window.api.onAgentBrowserShow(() => {
    setOpenTabs((tabs) => (tabs.includes(BROWSER_TAB) ? tabs : [...tabs, BROWSER_TAB]))
    setActiveTab(BROWSER_TAB)
  }), [])
  useEffect(() => window.api.onBrowserUrlChanged(({ url }) => {
    setBrowserUrl(url)
    setBrowserAddr(url.startsWith('about:blank') ? '' : url)
  }), [])
  // Stream the placeholder rect to main. Sidebar/chat slides shift layout
  // without resize events, so poll while the tab is active.
  useEffect(() => {
    if (activeTab !== BROWSER_TAB) { window.api.browserSetVisible(false); return }
    let last = ''
    const sync = () => {
      const el = browserHostRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
      if (key !== last && r.width > 0) {
        last = key
        window.api.browserSetBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
      }
    }
    sync()
    window.api.browserSetVisible(true)
    const iv = window.setInterval(sync, 250)
    window.addEventListener('resize', sync)
    return () => {
      window.clearInterval(iv)
      window.removeEventListener('resize', sync)
      window.api.browserSetVisible(false)
    }
  }, [activeTab])

  // Close a tab unconditionally (dirty state already resolved by the caller).
  const doCloseTab = (relPath: string) => {
    if (relPath === BROWSER_TAB) window.api.browserTabClosed()
    const nextTabs = openTabs.filter((t) => t !== relPath)
    setOpenTabs(nextTabs)
    if (activeTab === relPath) {
      setActiveTab(nextTabs.length > 0 ? nextTabs[nextTabs.length - 1] : null)
    }
    if (relPath !== BROWSER_TAB) {
      closedTabsRef.current = [...closedTabsRef.current.filter((t) => t !== relPath), relPath].slice(-10)
      // Drop the buffer + its Monaco model so a later reopen re-reads from disk
      // cleanly and closed-tab models don't pile up in memory.
      contentsRef.current.delete(relPath)
      originalsRef.current.delete(relPath)
      disposeModel(relPath)
    }
    // Drop the dirty flag so a later reopen re-reads from disk cleanly.
    setDirtyFiles((prev) => {
      const next = { ...prev }
      delete next[relPath]
      return next
    })
  }

  // Close a tab, guarding unsaved changes with a Save / Discard / Cancel dialog.
  const requestCloseTab = (relPath: string) => {
    if (!dirtyFiles[relPath]) { doCloseTab(relPath); return }
    const name = relPath.split('/').pop()
    setDialog({
      title: `Close "${name}"?`,
      message: 'This file has unsaved changes.',
      buttons: [
        {
          label: 'Save & Close', kind: 'primary',
          onClick: async () => {
            setDialog(null)
            if (await saveFile(relPath)) doCloseTab(relPath)
          },
        },
        {
          label: 'Discard', kind: 'danger',
          onClick: () => { setDialog(null); doCloseTab(relPath) },
        },
        { label: 'Cancel', onClick: () => setDialog(null) },
      ],
    })
  }

  // Reopen the most recently closed tab (Cmd+Shift+T).
  const reopenClosedTab = () => {
    const relPath = closedTabsRef.current.pop()
    if (relPath) openFile(relPath)
  }

  // Handle file edit inside Editor. Only the FIRST keystroke flips the dirty
  // flag — after that the updater returns the same object and React bails, so
  // typing causes zero re-renders of the IDE tree.
  const handleEditorChange = (value: string | undefined) => {
    if (!activeTab || value === undefined) return
    contentsRef.current.set(activeTab, value)
    setDirtyFiles((prev) => (prev[activeTab] ? prev : { ...prev, [activeTab]: true }))
  }

  // Save one file (any tab, not just the active one).
  const saveFile = async (relPath: string): Promise<boolean> => {
    const content = contentsRef.current.get(relPath) ?? ''
    const res = await window.api.workspaceWriteFile(relPath, content)
    if (res.ok) {
      setDirtyFiles((prev) => ({ ...prev, [relPath]: false }))
      // A save never changes the file TREE — only refresh git status. (The
      // full recursive workspace rescan here was pure waste on every Cmd+S.)
      refreshGitInfo()
      return true
    }
    toast(`Save failed: ${res.error}`, 'error')
    return false
  }

  const saveActiveFile = async () => {
    if (!activeTab || !dirtyFiles[activeTab]) return
    await saveFile(activeTab)
  }

  // Save every dirty tab (Save All button / Cmd+Alt+S).
  const dirtyCount = openTabs.filter((t) => dirtyFiles[t]).length
  const saveAllFiles = async () => {
    for (const t of openTabs) {
      if (dirtyFiles[t]) await saveFile(t)
    }
  }

  // ── File operations (inline create / rename / move / delete) ──────────────
  // Inline-create request forwarded to the tree (input row appears in place).
  const [createReq, setCreateReq] = useState<{ parentDir: string; isDir: boolean; nonce: number } | null>(null)
  const [revealNonce, setRevealNonce] = useState(0)
  const [collapseNonce, setCollapseNonce] = useState(0)

  // Header buttons / palette: open the inline-create input in the explorer.
  const createFilePrompt = useCallback((parentDir: string) => {
    setActiveSidebar('explorer'); setIsSidebarOpen(true)
    setCreateReq({ parentDir, isDir: false, nonce: Date.now() })
  }, [])

  const createFolderPrompt = useCallback((parentDir: string) => {
    setActiveSidebar('explorer'); setIsSidebarOpen(true)
    setCreateReq({ parentDir, isDir: true, nonce: Date.now() })
  }, [])

  const handleCreateCommit = useCallback(async (parentDir: string, name: string, isDir: boolean) => {
    const rel = parentDir ? `${parentDir}/${name}` : name
    const res = isDir
      ? await window.api.workspaceCreateFolder(rel)
      : await window.api.workspaceCreateFile(rel)
    if (!res.ok) { toast(res.error || 'Create failed', 'error'); return }
    await refreshWorkspace()
    if (!isDir) openFile(rel)
  }, [refreshWorkspace])

  // Rename a file/folder (or move it via toRel override) and fix open tabs.
  const applyRename = useCallback(async (relPath: string, toRel: string) => {
    const res = await window.api.workspaceRename(relPath, toRel)
    if (!res.ok) { toast(res.error || 'Rename failed', 'error'); return }
    // Update any open tab pointing at the renamed file or inside the folder.
    const remap = (t: string) =>
      t === relPath ? toRel : t.startsWith(relPath + '/') ? toRel + t.slice(relPath.length) : t
    setOpenTabs((tabs) => tabs.map(remap))
    setActiveTab((t) => (t ? remap(t) : t))
    const remapBuffers = (m: Map<string, string>) => {
      for (const [k, v] of Array.from(m.entries())) {
        const nk = remap(k)
        if (nk !== k) { m.delete(k); m.set(nk, v); disposeModel(k) }
      }
    }
    remapBuffers(contentsRef.current)
    remapBuffers(originalsRef.current)
    bumpBuffers()
    setDirtyFiles((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [remap(k), v])))
    await refreshWorkspace()
  }, [refreshWorkspace, disposeModel, bumpBuffers])

  const handleRenameCommit = useCallback(async (relPath: string, newName: string) => {
    const parts = relPath.split('/')
    parts[parts.length - 1] = newName
    await applyRename(relPath, parts.join('/'))
  }, [applyRename])

  // Drag-drop move into a directory ('' = workspace root).
  const handleMove = useCallback(async (fromRel: string, toDir: string) => {
    const base = fromRel.split('/').pop()!
    await applyRename(fromRel, toDir ? `${toDir}/${base}` : base)
  }, [applyRename])

  const deletePrompt = useCallback((relPath: string) => {
    setDialog({
      title: `Delete "${relPath.split('/').pop()}"?`,
      message: `${relPath}\n\nThis cannot be undone.`,
      buttons: [
        {
          label: 'Delete', kind: 'danger',
          onClick: async () => {
            setDialog(null)
            const res = await window.api.workspaceDelete(relPath)
            if (!res.ok) { toast(res.error || 'Delete failed', 'error'); return }
            setOpenTabs((tabs) => tabs.filter((t) => t !== relPath && !t.startsWith(relPath + '/')))
            setActiveTab((t) => (t === relPath || t?.startsWith(relPath + '/') ? null : t))
            await refreshWorkspace()
          },
        },
        { label: 'Cancel', onClick: () => setDialog(null) },
      ],
    })
  }, [refreshWorkspace])

  // Keyboard shortcuts: save / save-all, close / reopen tab, palette, search.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.altKey && e.code === 'KeyS') {
        // Cmd+Alt+S — Save All (e.code: macOS Alt+S types 'ß' in e.key)
        e.preventDefault()
        saveAllFiles()
      } else if (mod && e.key === 's') {
        e.preventDefault()
        saveActiveFile()
      } else if (mod && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        // Cmd+W — close active tab (app menu is null, so this is ours)
        e.preventDefault()
        if (activeTab) requestCloseTab(activeTab)
      } else if (mod && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault()
        reopenClosedTab()
      } else if (mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        setPaletteMode('commands'); setPaletteOpen(true)
      } else if (mod && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        setPaletteMode('files'); setPaletteOpen(true)
      } else if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        setActiveSidebar('search'); setIsSidebarOpen(true)
      } else if (mod && (e.key === '=' || e.key === '+')) {
        // Cmd+= — zoom in
        e.preventDefault()
        setUiSetting('zoom', Math.min(1.5, Math.round((ui.zoom + 0.1) * 10) / 10))
      } else if (mod && e.key === '-') {
        e.preventDefault()
        setUiSetting('zoom', Math.max(0.5, Math.round((ui.zoom - 0.1) * 10) / 10))
      } else if (mod && e.key === '0') {
        e.preventDefault()
        setUiSetting('zoom', 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, dirtyFiles, openTabs, ui.zoom])

  // Commands for the palette. Intentionally NOT memoized: the actions close
  // over live editor state (activeTab, dirtyFiles, …) and a memo made "File:
  // Save" run against stale state.
  const paletteCommands: Command[] = [
    { id: 'save', label: 'File: Save', hint: 'Ctrl+S', run: () => saveActiveFile() },
    { id: 'saveall', label: 'File: Save All', hint: 'Ctrl+Alt+S', run: () => saveAllFiles() },
    { id: 'closetab', label: 'File: Close Tab', hint: 'Ctrl+W', run: () => { if (activeTab) requestCloseTab(activeTab) } },
    { id: 'reopentab', label: 'File: Reopen Closed Tab', hint: 'Ctrl+Shift+T', run: () => reopenClosedTab() },
    { id: 'newfile', label: 'File: New File', run: () => createFilePrompt('') },
    { id: 'newfolder', label: 'File: New Folder', run: () => createFolderPrompt('') },
    { id: 'openfolder', label: 'Workspace: Open Folder…', run: () => switchWorkspace() },
    { id: 'search', label: 'Search: Find in Files', hint: 'Ctrl+Shift+F', run: () => { setActiveSidebar('search'); setIsSidebarOpen(true) } },
    { id: 'git', label: 'View: Source Control', run: () => { setActiveSidebar('git'); setIsSidebarOpen(true) } },
    { id: 'explorer', label: 'View: Explorer', run: () => { setActiveSidebar('explorer'); setIsSidebarOpen(true) } },
    { id: 'refresh', label: 'Workspace: Refresh', run: () => refreshWorkspace() },
    { id: 'quickopen', label: 'Go to File…', hint: 'Ctrl+P', run: () => { setPaletteMode('files'); setPaletteOpen(true) } },
  ]


  // Custom theme initialization for Monaco
  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor
    monacoRef.current = monaco
    setEditorReady((n) => n + 1)
    // (Caret tracking lives in StatusBar — a caret move re-renders only it.)
    // Set custom HSL dark theme values
    monaco.editor.defineTheme('vscode-dark-harmony', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
        { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
        { token: 'string', foreground: 'ce9178' },
        { token: 'number', foreground: 'b5cea8' },
        { token: 'regexp', foreground: 'd16969' },
        { token: 'type', foreground: '4ec9b0' },
        { token: 'class', foreground: '4ec9b0' },
        { token: 'function', foreground: 'dcdcaa' },
      ],
      colors: {
        'editor.background': '#09090b', // zinc-950
        'editor.foreground': '#e4e4e7', // zinc-200
        'editor.lineHighlightBackground': '#18181b', // zinc-900
        'editorCursor.foreground': '#a1a1aa', // zinc-400
        'editorLineNumber.foreground': '#3f3f46', // zinc-700
        'editorLineNumber.activeForeground': '#a1a1aa', // zinc-400
        'editor.selectionBackground': '#264f78',
        'minimap.background': '#09090b',
      },
    })
    monaco.editor.setTheme('vscode-dark-harmony')
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-200 overflow-hidden select-none font-sans">
    <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* 1. Icon-only Activity Bar */}
      <nav className="w-12 border-r border-zinc-800 bg-zinc-950 flex flex-col items-center py-3 gap-6 flex-shrink-0">
        <ActivityButton
          icon={<FolderTree size={20} />}
          label="Explorer"
          active={activeSidebar === 'explorer' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'explorer' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('explorer')
              setIsSidebarOpen(true)
            }
          }}
        />
        <ActivityButton
          icon={<SearchIcon size={20} />}
          label="Search (Ctrl+Shift+F)"
          active={activeSidebar === 'search' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'search' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('search')
              setIsSidebarOpen(true)
            }
          }}
        />
        <ActivityButton
          icon={
            <div className="relative">
              <GitBranch size={20} />
              {gitChanges.length > 0 && (
                <span className="absolute -top-1 -right-1 size-3.5 bg-amber-500 text-zinc-950 rounded-full text-[9px] font-bold flex items-center justify-center animate-pulse scale-90">
                  {gitChanges.length}
                </span>
              )}
            </div>
          }
          label="Source Control"
          active={activeSidebar === 'git' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'git' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('git')
              setIsSidebarOpen(true)
            }
          }}
        />
        <ActivityButton
          icon={<Cpu size={20} />}
          label="AI Agents"
          active={activeSidebar === 'agents' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'agents' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('agents')
              setIsSidebarOpen(true)
            }
          }}
        />
        <ActivityButton
          icon={<Boxes size={20} />}
          label="Agent Groups"
          active={activeSidebar === 'groups' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'groups' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('groups')
              setIsSidebarOpen(true)
            }
          }}
        />
        <div className="mt-auto flex flex-col gap-4">
          <div className="relative">
            <ActivityButton
              icon={<MessagesSquare size={20} />}
              label="AI Chat"
              active={chatOpen}
              onClick={() => { setChatOpen((v) => !v); setChatUnread(false) }}
            />
            {/* Unread badge: an agent run finished while the chat was closed. */}
            {chatUnread && !chatOpen && (
              <span className="absolute top-0 right-0.5 size-2 rounded-full bg-emerald-400 ring-2 ring-zinc-950 animate-pulse" />
            )}
          </div>
          <ActivityButton
            icon={<RefreshCw size={18} className={loadingWorkspace ? 'animate-spin text-blue-400' : ''} />}
            label="Refresh Workspace"
            active={false}
            onClick={refreshWorkspace}
          />
        </div>
      </nav>

      {/* 2. Expandable Sidebar Panel — animates its width so the editor shrinks
          smoothly with it (no instant black gap). Inner content is fixed-width
          and clipped by overflow-hidden, so it doesn't reflow during the width
          animation. */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.aside
            className="border-r border-zinc-800 bg-zinc-950/40 backdrop-blur-md flex-shrink-0 overflow-hidden"
            initial={animationsOn ? { width: 0 } : false}
            animate={{ width: 256 }}
            exit={{ width: 0 }}
            transition={{ duration: 0.26, ease: 'easeInOut' }}
            onAnimationStart={startLayoutSync}
            onAnimationComplete={stopLayoutSync}
          >
            <motion.div
              key={activeSidebar}
              className="w-64 h-full flex flex-col"
              variants={animationsOn ? SIDEBAR_CONTAINER : undefined}
              initial={animationsOn ? 'hidden' : false}
              animate={animationsOn ? 'show' : false}
            >
          {/* Workspace selector bar */}
          <motion.div
            variants={animationsOn ? SIDEBAR_ITEM : undefined}
            initial={animationsOn ? 'hidden' : false}
            animate={animationsOn ? 'show' : false}
            className="relative h-8 px-2 border-b border-zinc-800 flex items-center gap-1 bg-zinc-950/60"
          >
            <button
              onClick={() => setShowWorkspaceMenu((v) => !v)}
              className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-xs font-semibold text-zinc-200 hover:text-white truncate"
              title={workspaceName}
            >
              <FolderOpen size={13} className="text-zinc-500 flex-shrink-0" />
              <span className="truncate">{workspaceName || 'workspace'}</span>
              <ChevronDown size={12} className="text-zinc-600 flex-shrink-0" />
            </button>
            {showWorkspaceMenu && (
              <div className="absolute z-30 left-2 top-8 w-60 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1">
                <button
                  onClick={() => switchWorkspace()}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2"
                >
                  <FolderOpen size={12} /> Open Folder…
                </button>
                {recentWorkspaces.length > 0 && (
                  <div className="border-t border-zinc-800 mt-1 pt-1">
                    <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-zinc-600">Recent</div>
                    {recentWorkspaces.map((d) => (
                      <button
                        key={d}
                        onClick={() => switchWorkspace(d)}
                        className="w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 truncate"
                        title={d}
                      >
                        {d.split(/[\\/]/).pop()}
                        <span className="text-zinc-600 ml-1 text-[10px]">{d}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </motion.div>

          {/* Header */}
          <motion.div
            variants={animationsOn ? SIDEBAR_ITEM : undefined}
            initial={animationsOn ? 'hidden' : false}
            animate={animationsOn ? 'show' : false}
            className="h-9 px-3 border-b border-zinc-800 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-zinc-400"
          >
            <span>
              {activeSidebar === 'explorer' && 'Explorer'}
              {activeSidebar === 'search' && 'Search'}
              {activeSidebar === 'git' && 'Source Control'}
              {activeSidebar === 'agents' && 'AI Agents'}
              {activeSidebar === 'groups' && 'Agent Groups'}
            </span>
            <div className="flex items-center gap-1">
              {activeSidebar === 'explorer' && (
                <>
                  <button onClick={() => createFilePrompt('')} title="New File" className="text-zinc-500 hover:text-zinc-200 p-0.5">
                    <FilePlus size={13} />
                  </button>
                  <button onClick={() => createFolderPrompt('')} title="New Folder" className="text-zinc-500 hover:text-zinc-200 p-0.5">
                    <FolderPlus size={13} />
                  </button>
                  <button onClick={() => setRevealNonce((n) => n + 1)} title="Reveal Active File" className="text-zinc-500 hover:text-zinc-200 p-0.5">
                    <Crosshair size={12} />
                  </button>
                  <button onClick={() => setCollapseNonce((n) => n + 1)} title="Collapse All" className="text-zinc-500 hover:text-zinc-200 p-0.5">
                    <ChevronsDownUp size={12} />
                  </button>
                  <button onClick={refreshWorkspace} title="Refresh" className="text-zinc-500 hover:text-zinc-200 p-0.5">
                    <RefreshCw size={12} className={loadingWorkspace ? 'animate-spin text-blue-400' : ''} />
                  </button>
                </>
              )}
              <button
                onClick={() => setIsSidebarOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 p-0.5 rounded transition-colors"
              >
                <Layout size={14} />
              </button>
            </div>
          </motion.div>

          {/* Content */}
          <motion.div
            variants={animationsOn ? SIDEBAR_ITEM : undefined}
            initial={animationsOn ? 'hidden' : false}
            animate={animationsOn ? 'show' : false}
            className={`flex-1 overflow-y-auto scrollbar-thin ${activeSidebar === 'search' || activeSidebar === 'git' ? '' : 'p-2'}`}
          >
            <Suspense fallback={null}>
            {activeSidebar === 'explorer' && (
              <IDEFileTree
                files={files}
                selectedFile={activeTab}
                onSelectFile={openFile}
                gitChanges={gitChanges}
                onRenameCommit={handleRenameCommit}
                onDelete={deletePrompt}
                onCreateCommit={handleCreateCommit}
                onMove={handleMove}
                createRequest={createReq}
                revealNonce={revealNonce}
                collapseNonce={collapseNonce}
              />
            )}

            {activeSidebar === 'search' && (
              <SearchPanel onOpenResult={openFileAtLine} />
            )}

            {activeSidebar === 'git' && (
              <GitPanel
                status={gitChanges}
                branch={gitBranch}
                onOpenFile={openFile}
                onChanged={refreshWorkspace}
                onDiscard={handleDiscardFile}
              />
            )}

            {activeSidebar === 'agents' && (
              <div className="flex flex-col gap-3 p-1">
                {/* Live child agents the chat agent delegated to (SpawnAgent). */}
                <AgentsLivePanel />
                {residentAgents.map((agent) => (
                  <div
                    key={agent}
                    onClick={() => {
                      setSelectedAgent(agent)
                      setIsBottomOpen(true)
                    }}
                    className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                      selectedAgent === agent && isBottomOpen
                        ? 'bg-zinc-900 border-zinc-700 shadow-md ring-1 ring-zinc-700/50'
                        : 'bg-zinc-900/40 border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900/60'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-semibold font-mono ${colorFor(agent)}`}>
                        {agent}
                      </span>
                      <span className="size-1.5 rounded-full bg-zinc-600" />
                    </div>
                    <div className="text-[10px] text-zinc-500 flex items-center justify-between">
                      <span>Logs: {agentLogs[agent]?.length || 0} lines</span>
                      <span className="font-mono text-zinc-400 hover:text-white flex items-center gap-0.5">
                        Open PTY <ArrowRight size={10} />
                      </span>
                    </div>
                  </div>
                ))}
                <div className="mt-1 px-2 py-2 rounded-lg border border-dashed border-zinc-800/80 text-[10px] text-zinc-500 leading-relaxed">
                  Engineers and reviewers now run as ephemeral worker/reviewer
                  sessions. See the <span className="text-zinc-300">Agent Groups</span> tab
                  to watch them work.
                </div>
              </div>
            )}

            {activeSidebar === 'groups' && (
              <GroupsPanel windup={animationsOn} />
            )}
            </Suspense>
          </motion.div>
            </motion.div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* 3. Editor & Terminal Dashboard Workspace */}
      <section className="flex-1 flex flex-col overflow-hidden bg-zinc-950">
        
        {/* Tab Bar Header */}
        <div className="h-10 border-b border-zinc-800 bg-zinc-950/60 backdrop-blur flex items-center justify-between px-2 flex-shrink-0 overflow-x-auto select-none">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 max-w-full">
            {openTabs.map((tab) => {
              const isActive = activeTab === tab
              const isDirty = dirtyFiles[tab]
              const hasGit = gitChanges.some((c) => c.file === tab)
              
              let tabColor = 'border-transparent text-zinc-500 bg-transparent hover:bg-zinc-900/40 hover:text-zinc-300'
              if (isActive) {
                tabColor = 'border-blue-500 text-white bg-zinc-900/60 shadow-inner'
              } else if (hasGit) {
                tabColor = 'border-transparent text-amber-500/80 bg-transparent hover:bg-zinc-900/40'
              }

              return (
                <div
                  key={tab}
                  draggable
                  onDragStart={() => { dragTabRef.current = tab }}
                  onDragEnd={() => { dragTabRef.current = null }}
                  onDragOver={(e) => {
                    // Live-reorder: as the dragged tab passes over another, swap positions.
                    e.preventDefault()
                    const from = dragTabRef.current
                    if (!from || from === tab) return
                    setOpenTabs((tabs) => {
                      const next = tabs.filter((t) => t !== from)
                      next.splice(next.indexOf(tab), 0, from)
                      return next
                    })
                  }}
                  onClick={() => (tab === BROWSER_TAB ? setActiveTab(tab) : openFile(tab))}
                  onAuxClick={(e) => {
                    // Middle-click closes (through the dirty guard).
                    if (e.button === 1) { e.preventDefault(); requestCloseTab(tab) }
                  }}
                  className={`group/tab h-8 px-3 border-b-2 flex items-center gap-2 cursor-pointer transition-all text-xs font-mono select-none rounded-t ${tabColor}`}
                >
                  {tab === BROWSER_TAB ? (
                    <span className="flex items-center gap-1.5 truncate max-w-[160px]">
                      <Globe size={11} className="text-sky-400 flex-shrink-0" />
                      {(() => { try { return new URL(browserUrl).host || 'Browser' } catch { return 'Browser' } })()}
                    </span>
                  ) : (
                    <span className="truncate max-w-[140px]">{tab.split('/').pop()}</span>
                  )}

                  {/* Dirty dot swaps to an X on hover so dirty tabs stay closable. */}
                  {isDirty && (
                    <span className="size-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0 group-hover/tab:hidden" />
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); requestCloseTab(tab) }}
                    title="Close (Cmd+W)"
                    className={`text-zinc-600 hover:text-zinc-300 p-0.5 rounded-full flex-shrink-0 transition-colors ${
                      isDirty ? 'hidden group-hover/tab:block' : ''
                    }`}
                  >
                    <X size={10} />
                  </button>
                </div>
              )
            })}

            {openTabs.length === 0 && (
              <span className="text-xs text-zinc-600 font-mono px-3">No files open</span>
            )}
          </div>

          {/* Action Bar (Top Right Toolbar) */}
          {activeTab && activeTab !== BROWSER_TAB && (
            <div className="flex items-center gap-1.5 flex-shrink-0 pl-4 border-l border-zinc-800/80">
              {/* Save Button */}
              <button
                onClick={saveActiveFile}
                disabled={!dirtyFiles[activeTab]}
                title="Save (Cmd+S)"
                className={`p-1.5 rounded flex items-center justify-center transition-all ${
                  dirtyFiles[activeTab]
                    ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-500/10'
                    : 'text-zinc-600 bg-zinc-900/40 border border-zinc-800 cursor-not-allowed'
                }`}
              >
                <Save size={14} />
              </button>

              {/* Save All (visible when more than one tab is dirty) */}
              {dirtyCount > 1 && (
                <button
                  onClick={saveAllFiles}
                  title="Save All (Cmd+Alt+S)"
                  className="px-2 py-1.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-all flex items-center gap-1"
                >
                  <Save size={13} />
                  <span className="text-[10px] font-semibold">All ({dirtyCount})</span>
                </button>
              )}

              {/* Diff Toggle Button */}
              <button
                onClick={() => setDiffMode(!diffMode)}
                title={diffMode ? 'Switch to Normal Editor' : 'Switch to Diff Highlight View'}
                className={`p-1.5 rounded border transition-all flex items-center gap-1 ${
                  diffMode
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                <Eye size={14} />
                <span className="text-[10px] font-semibold hidden md:inline">Diff View</span>
              </button>

              {/* Split screen diff vs inline diff (only visible when in diffMode) */}
              {diffMode && (
                <button
                  onClick={() => setRenderSideBySide(!renderSideBySide)}
                  title={renderSideBySide ? 'Switch to Inline Diff' : 'Switch to Side-by-Side Split Diff'}
                  className="p-1.5 rounded border border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800 transition-all flex items-center gap-1"
                >
                  <Split size={14} className={renderSideBySide ? '' : 'rotate-90'} />
                  <span className="text-[10px] font-semibold hidden md:inline">
                    {renderSideBySide ? 'Side' : 'Inline'}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Editor Main Content Area */}
        <div className="flex-1 min-h-0 relative overflow-hidden flex flex-col bg-zinc-950">
          {/* Embedded agent browser: address bar + placeholder rect that the
              main-process WebContentsView is positioned over. */}
          {activeTab === BROWSER_TAB && (
            <div className="absolute inset-0 flex flex-col">
              <div className="h-9 border-b border-zinc-800 bg-zinc-950/80 flex items-center gap-2 px-3 flex-shrink-0">
                <Globe size={12} className="text-zinc-500 flex-shrink-0" />
                <input
                  value={browserAddr}
                  onChange={(e) => setBrowserAddr(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && browserAddr.trim()) window.api.browserUserNavigate(browserAddr.trim())
                  }}
                  placeholder="Enter a URL and press Enter…"
                  spellCheck={false}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono text-zinc-300 outline-none focus:border-blue-500/50"
                />
              </div>
              <div ref={browserHostRef} className="flex-1 bg-zinc-950" />
            </div>
          )}
          {activeTab && activeTab !== BROWSER_TAB ? (
            <div className="absolute inset-0 flex flex-col">
              {diffMode ? (
                <div className="flex-1 w-full overflow-hidden relative">
                  <DiffEditor
                    height="100%"
                    language={detectLanguage(activeTab)}
                    original={originalsRef.current.get(activeTab) || ''}
                    modified={contentsRef.current.get(activeTab) || ''}
                    theme="vscode-dark-harmony"
                    options={{
                      renderSideBySide,
                      originalEditable: false,
                      readOnly: false,
                      fontSize: ui.editorFontSize,
                      lineHeight: 1.5,
                      fontFamily: 'ui-monospace, SF Mono, JetBrains Mono, Consolas, monospace',
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: ui.wordWrap ? 'on' : 'off',
                    }}
                  />
                </div>
              ) : (
                <div className="flex-1 w-full overflow-hidden relative">
                  <Editor
                    height="100%"
                    // Uncontrolled: `path` keys one model per open file (its
                    // undo stack survives tab switches) and defaultValue seeds
                    // it from the live buffer. No `value` prop — a controlled
                    // Monaco re-diffed the whole document every render.
                    path={activeTab}
                    language={detectLanguage(activeTab)}
                    defaultValue={contentsRef.current.get(activeTab) || ''}
                    onChange={handleEditorChange}
                    onMount={handleEditorDidMount}
                    theme="vscode-dark-harmony"
                    options={{
                      fontSize: ui.editorFontSize,
                      lineHeight: 1.5,
                      fontFamily: 'ui-monospace, SF Mono, JetBrains Mono, Consolas, monospace',
                      // minimapOn = the flicker-avoidance toggle during panel
                      // animations; ui.minimap = the user's persisted setting.
                      minimap: { enabled: minimapOn && ui.minimap },
                      scrollBeyondLastLine: false,
                      wordWrap: ui.wordWrap ? 'on' : 'off',
                      tabSize: 4,
                      insertSpaces: true,
                    }}
                  />
                  <AnimatePresence>
                    {inlineAI.state.open && (
                      <InlineAIPrompt
                        state={inlineAI.state}
                        models={availableModels}
                        onGenerate={inlineAI.generate}
                        onReject={inlineAI.reject}
                      />
                    )}
                    {(inlineAI.state.streaming || inlineAI.state.hasResult) && (
                      <InlineAICard
                        state={inlineAI.state}
                        onAccept={inlineAI.accept}
                        onArrived={inlineAI.finishMerge}
                        onReject={inlineAI.reject}
                      />
                    )}
                    {pendingChange && pendingChange.path === activeTab && (
                      <DiffReviewCard
                        change={pendingChange}
                        onAccept={() => resolvePending('accept')}
                        onReject={() => resolvePending('reject')}
                      />
                    )}
                    {!pendingChange && previewDiff && previewDiff.path === activeTab && (
                      <DiffReviewCard
                        change={previewDiff}
                        readOnly
                        onAccept={() => setPreviewDiff(null)}
                        onReject={() => setPreviewDiff(null)}
                      />
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>
          ) : !activeTab ? (
            <div className="relative flex-1 flex flex-col items-center justify-center text-zinc-500 select-none bg-zinc-950 overflow-hidden">
              {/* Debossed logo watermark */}
              <OrqonLogo
                mono
                size={275}
                className="absolute text-zinc-700/45 pointer-events-none"
                style={{ transform: 'translateY(52px)' }}
              />

              <div className="relative flex flex-col items-center px-10 py-8">
                <p className="text-lg font-semibold tracking-wide text-zinc-300">Orqon</p>
                <p className="text-xs text-zinc-600 mt-1 max-w-sm text-center leading-relaxed">
                  Open a workspace to begin orchestrating AI agents across your codebase.
                </p>

                <div className="mt-8 grid grid-cols-[auto_auto] gap-x-4 gap-y-2 text-[11px] text-zinc-600 border-t border-zinc-800/70 pt-5">
                  <span className="text-right text-zinc-500">Command Palette</span>
                  <span><Kbd>Ctrl</Kbd> <Kbd>Shift</Kbd> <Kbd>P</Kbd></span>
                  <span className="text-right text-zinc-500">Open File</span>
                  <span><Kbd>Ctrl</Kbd> <Kbd>P</Kbd></span>
                  <span className="text-right text-zinc-500">Search Workspace</span>
                  <span><Kbd>Ctrl</Kbd> <Kbd>Shift</Kbd> <Kbd>F</Kbd></span>
                  <span className="text-right text-zinc-500">Save Changes</span>
                  <span><Kbd>Ctrl</Kbd> <Kbd>S</Kbd></span>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* 4. Collapsible Integrated Agent Dock (Terminal & Logs) — height is
            drag-resizable from its top edge and persisted. */}
        <div
          className={`relative flex flex-col border-t border-zinc-800 bg-zinc-950/80 backdrop-blur-md flex-shrink-0 ${
            draggingDock ? '' : 'transition-all duration-300'
          }`}
          style={{ height: isBottomOpen ? dockHeight : 32 }}
        >
          {/* Drag handle: resize the dock from its top edge. */}
          {isBottomOpen && (
            <div
              onMouseDown={startDockResize}
              className="absolute -top-0.5 left-0 right-0 h-1.5 z-20 cursor-row-resize hover:bg-blue-500/50 transition-colors"
              title="Drag to resize"
            />
          )}
          {/* Header Panel Control */}
          <div
            onClick={() => setIsBottomOpen(!isBottomOpen)}
            className="h-8 px-3 border-b border-zinc-900 bg-zinc-950 flex items-center justify-between cursor-pointer select-none text-zinc-500 hover:text-zinc-300"
          >
            <div className="flex items-center gap-4 text-xs font-semibold tracking-wide" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setBottomTab('terminal')
                  setIsBottomOpen(true)
                }}
                className={`py-1 px-2 rounded-md transition-all ${
                  bottomTab === 'terminal' && isBottomOpen ? 'text-white bg-zinc-800 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="flex items-center gap-1">
                  <TerminalIcon size={12} />
                  Agent Live Terminal ({selectedAgent})
                </span>
              </button>

              <button
                onClick={() => {
                  setBottomTab('shell')
                  setIsBottomOpen(true)
                }}
                className={`py-1 px-2 rounded-md transition-all ${
                  bottomTab === 'shell' && isBottomOpen ? 'text-white bg-zinc-800 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="flex items-center gap-1">
                  <TerminalIcon size={12} />
                  Shell
                </span>
              </button>

              {/* Shell tabs: switch / rename (double-click) / close / add */}
              {bottomTab === 'shell' && isBottomOpen && (
                <div className="flex items-center gap-1 pl-1 border-l border-zinc-800">
                  {shells.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => setActiveShell(s.id)}
                      onDoubleClick={() => { setRenamingShell(s.id); setShellNameDraft(s.name) }}
                      className={`group/shell flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer ${
                        s.id === activeShell ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {renamingShell === s.id ? (
                        <input
                          autoFocus
                          value={shellNameDraft}
                          onChange={(e) => setShellNameDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const name = shellNameDraft.trim()
                              if (name) setShells((prev) => prev.map((x) => (x.id === s.id ? { ...x, name } : x)))
                              setRenamingShell(null)
                            } else if (e.key === 'Escape') setRenamingShell(null)
                            e.stopPropagation()
                          }}
                          onBlur={() => setRenamingShell(null)}
                          className="w-16 px-1 bg-zinc-950 border border-blue-500/60 rounded text-[10px] text-zinc-100 focus:outline-none"
                        />
                      ) : (
                        <span>{s.name}</span>
                      )}
                      {shells.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); closeShell(s.id) }}
                          className="opacity-0 group-hover/shell:opacity-100 text-zinc-600 hover:text-rose-400"
                        >
                          <X size={9} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={addShell}
                    title="New terminal"
                    className="px-1 text-zinc-500 hover:text-zinc-200 text-xs leading-none"
                  >
                    +
                  </button>
                </div>
              )}

              <button
                onClick={() => {
                  setBottomTab('logs')
                  setIsBottomOpen(true)
                }}
                className={`py-1 px-2 rounded-md transition-all ${
                  bottomTab === 'logs' && isBottomOpen ? 'text-white bg-zinc-800 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="flex items-center gap-1">
                  <Eye size={12} />
                  Logs Viewer
                </span>
              </button>
            </div>

            <div className="flex items-center gap-3">
              {/* Agent Selector Dropdown */}
              <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold font-mono">Agent:</span>
                <select
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-[10px] font-mono px-2 py-0.5 rounded focus:outline-none focus:border-zinc-600 select-none cursor-pointer"
                >
                  {agentsList.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                </select>
              </div>
              
              {isBottomOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </div>
          </div>

          {/* Bottom Dock Workspace Content */}
          {isBottomOpen && (
            <div className="flex-1 min-h-0 relative bg-zinc-950 overflow-hidden">
              {bottomTab === 'terminal' ? (
                <div className="h-full w-full relative">
                  <AgentTerminal key={selectedAgent} agent={selectedAgent} active={isBottomOpen && bottomTab === 'terminal'} />
                </div>
              ) : bottomTab === 'shell' ? (
                <div className="h-full w-full relative">
                  {shells.map((s) => (
                    <div
                      key={s.id}
                      className="absolute inset-0"
                      style={{ display: s.id === activeShell ? 'block' : 'none' }}
                    >
                      <ShellTerminal id={s.id} active={isBottomOpen && bottomTab === 'shell' && s.id === activeShell} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-full w-full bg-zinc-950 p-2 overflow-y-auto font-mono text-[11px] text-zinc-400 select-text scrollbar-thin">
                  {agentLogs[selectedAgent] && agentLogs[selectedAgent].length > 0 ? (
                    agentLogs[selectedAgent].map((line, idx) => (
                      <div key={idx} className="hover:bg-zinc-900/60 py-0.5 px-2 border-l border-zinc-800">
                        {line}
                      </div>
                    ))
                  ) : (
                    <div className="h-full flex items-center justify-center text-zinc-600 italic">
                      No logs recorded for {selectedAgent} in this session.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

      </section>

      {/* AI Chat side panel — animates its width so the editor (flex-1) shrinks
          smoothly alongside it. The inner content keeps a fixed width and is
          clipped by overflow-hidden, so it never reflows/repaints while the
          outer width animates (that clipping is what stops Monaco flicker). */}
      {/* Always mounted (like the sidebar) so an in-flight agent run keeps
          streaming when the user closes/reopens the chat — only the width
          animates to 0. */}
      <motion.aside
        className="relative border-l border-zinc-800 bg-zinc-950 flex-shrink-0 overflow-hidden"
        initial={false}
        animate={{ width: chatOpen ? chatWidth : 0 }}
        transition={{ duration: draggingChatRef.current ? 0 : 0.26, ease: 'easeInOut' }}
        onAnimationStart={startLayoutSync}
        onAnimationComplete={stopLayoutSync}
      >
        {/* Drag handle: resize the chat panel from its left edge. */}
        <div
          onMouseDown={startChatResize}
          className="absolute left-0 top-0 h-full w-1.5 z-20 cursor-col-resize hover:bg-blue-500/50 transition-colors"
          title="Drag to resize"
        />
        <div style={{ width: chatWidth }} className="h-full">
          <ChatPanel
            models={availableModels}
            getContext={getChatContext}
            onFileChanged={onAgentFileChanged}
            onPendingChange={onPendingChange}
            onChangeResolved={onChangeResolved}
            onEditorRequest={onEditorRequest}
            windup={animationsOn}
            visible={chatOpen}
            files={flatFiles}
            workspaceRoot={workspaceRootPath}
            onRunStateChange={setAgentBusy}
            onContextUsage={setChatCtxUsage}
            onSubAgentStarted={onSubAgentStarted}
            onRunFinished={onChatRunFinished}
          />
        </div>
      </motion.aside>
    </div>

      {/* Status bar spans the full window width below all panels. */}
      <StatusBar
        branch={gitBranch.current}
        dirtyCount={dirtyCount}
        workspaceName={workspaceName}
        editorRef={editorRef}
        editorEpoch={editorReady}
        editorActive={Boolean(activeTab && activeTab !== BROWSER_TAB)}
        language={activeTab && activeTab !== BROWSER_TAB ? detectLanguage(activeTab) : ''}
        agentBusy={agentBusy}
        ctxUsage={chatCtxUsage}
      />

      <CommandPalette
        open={paletteOpen}
        mode={paletteMode}
        commands={paletteCommands}
        files={flatFiles}
        onClose={() => setPaletteOpen(false)}
        onOpenFile={openFile}
      />

      <ConfirmDialog dialog={dialog} />
    </div>
  )
}

interface ActivityButtonProps {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}

function ActivityButton({ icon, label, active, onClick }: ActivityButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`size-10 rounded-lg flex items-center justify-center transition-all ${
        active
          ? 'bg-zinc-800 text-white shadow-inner scale-105 border border-zinc-700/50'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
      }`}
    >
      {icon}
    </button>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block min-w-[20px] text-center px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-[10px] font-mono text-zinc-400">
      {children}
    </kbd>
  )
}
