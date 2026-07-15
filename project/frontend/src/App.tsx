import { useEffect, useState, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ListTodo, ClipboardList, Package, X, Minus, Square, Copy } from 'lucide-react'
import { TasksPanel } from './components/TasksPanel'
import { TaskInboxPanel } from './components/TaskInboxPanel'
import { NewTaskDialog } from './components/NewTaskDialog'
import { ArtifactViewer } from './components/ArtifactViewer'
import { PlanComposer } from './components/PlanComposer'
import { BackendSettingsModal } from './components/BackendSettingsModal'
import { CostBadge } from './components/CostBadge'
import { CostDashboardModal } from './components/CostDashboardModal'
import { IDEView } from './components/IDEView'
import { OrqonLogo } from './components/OrqonLogo'
import { ToastHost } from './components/ToastHost'
import { useAnimationsEnabled } from './lib/uiSettings'
import { Task, InboxSummary, AgentsConfig, activeAgents } from './lib/api'

// IDE-first shell: the IDE is always the base layer. Multi-agent functions
// (Tasks, Plan, Artifacts) open as a right-side slide-in panel so switching
// between them never unmounts the editor or loses its state.
type AgentPanel = 'tasks' | 'plan' | 'artifacts' | null

const POLL_MS = 2000

// Wind-up: panel content elements rise/fade in after the panel slides open.
const PANEL_ITEM = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [inbox, setInbox] = useState<InboxSummary[]>([])
  const [config, setConfig] = useState<AgentsConfig | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [showNewTask, setShowNewTask] = useState(false)
  const [showBackendSettings, setShowBackendSettings] = useState(false)
  const [showCostDashboard, setShowCostDashboard] = useState(false)
  const [panel, setPanel] = useState<AgentPanel>(null)
  const animationsOn = useAnimationsEnabled()
  const [autoTrigger, setAutoTrigger] = useState(true)
  const [lastTriggered, setLastTriggered] = useState<{ agent: string; ts: number } | null>(null)
  const [artifactTaskId, setArtifactTaskId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null
  const agents = activeAgents(config)

  useEffect(() => {
    window.api.getAutoTrigger().then((r) => setAutoTrigger(r.enabled))
    return window.api.onAutoTrigger(({ agent }) => {
      setLastTriggered({ agent, ts: Date.now() })
    })
  }, [])

  const flash =
    lastTriggered && Date.now() - lastTriggered.ts < 3000 ? lastTriggered : null

  const refreshConfig = useCallback(() => {
    window.api.getAgentsConfig().then(setConfig)
  }, [])

  useEffect(() => { refreshConfig() }, [refreshConfig])

  const refreshAll = useCallback(async () => {
    const [t, i] = await Promise.all([
      window.api.getTasks(),
      window.api.getInboxSummary(),
    ])
    setTasks(t.tasks)
    setInbox(i)
    setLastUpdate(new Date())
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      await refreshAll()
    }
    tick()
    const interval = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [refreshAll])

  const totalInbox = inbox.reduce((s, x) => s + x.count, 0)
  const inProgressCount = tasks.filter((t) => t.status === 'in_progress').length
  const blockedCount = tasks.filter((t) => t.status === 'blocked').length

  const openArtifact = (taskId: string) => {
    setArtifactTaskId(taskId)
    setPanel('artifacts')
  }

  const togglePanel = (p: Exclude<AgentPanel, null>) =>
    setPanel((cur) => (cur === p ? null : p))

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-200">
      {/* Slim header / titlebar */}
      <header
        className="h-11 flex items-center justify-between px-4 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur flex-shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5">
          <OrqonLogo size={22} />
          <div
            className="ml-2 flex items-center bg-zinc-900 border border-zinc-800 rounded p-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <PanelTab label="Tasks" icon={<ListTodo size={13} />} active={panel === 'tasks'} onClick={() => togglePanel('tasks')} badge={totalInbox} />
            <PanelTab label="Plan" icon={<ClipboardList size={13} />} active={panel === 'plan'} onClick={() => togglePanel('plan')} />
            <PanelTab label="Artifacts" icon={<Package size={13} />} active={panel === 'artifacts'} onClick={() => togglePanel('artifacts')} />
          </div>
        </div>
        <div
          className="flex items-center gap-4 text-xs text-zinc-500"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Stat label="In progress" value={inProgressCount} color="text-blue-300" />
          <Stat label="Inbox" value={totalInbox} color="text-amber-300" />
          {blockedCount > 0 && <Stat label="Blocked" value={blockedCount} color="text-rose-300" />}
          <CostBadge onClick={() => setShowCostDashboard(true)} />
          <span className="text-zinc-600 font-mono">{lastUpdate.toLocaleTimeString()}</span>
          {flash && (
            <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-emerald-500/20 text-emerald-300 animate-pulse">
              ⚡ {flash.agent}
            </span>
          )}
          <button
            onClick={() => {
              const next = !autoTrigger
              window.api.setAutoTrigger(next).then((r) => setAutoTrigger(r.enabled))
            }}
            title={autoTrigger ? 'Auto-trigger ON' : 'Auto-trigger OFF'}
            className={`px-2 py-1 text-[10px] font-medium rounded border transition-colors flex items-center gap-1.5 ${
              autoTrigger
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className={`size-1.5 rounded-full ${autoTrigger ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            Auto {autoTrigger ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={() => setShowBackendSettings(true)}
            title="Backend settings — providers, models, API keys"
            className="px-2 py-1 text-[11px] font-medium rounded border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            ⚙
          </button>
          <button
            onClick={() => setShowNewTask(true)}
            className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors flex items-center gap-1.5"
          >
            <span className="text-base leading-none">+</span> New Task
          </button>
          <WindowControls />
        </div>
      </header>

      {/* Body: IDE base layer + slide-in agent panel */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {/* IDE always mounted */}
        <div className="absolute inset-0">
          <IDEView />
        </div>

        {/* Right-side agent panel */}
        <AnimatePresence>
          {panel && (
            <>
              <motion.div
                className="absolute inset-0 bg-black/40 z-20"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: animationsOn ? 0.15 : 0 }}
                onClick={() => setPanel(null)}
              />
              <motion.aside
                className="absolute top-0 right-0 bottom-0 w-[680px] max-w-[92vw] z-30 bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col"
                initial={animationsOn ? { x: '100%' } : false}
                animate={{ x: 0 }}
                exit={animationsOn ? { x: '100%' } : { opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 34 }}
                variants={animationsOn ? { hidden: {}, show: { transition: { delayChildren: 0.18, staggerChildren: 0.08 } } } : undefined}
              >
                <motion.div
                  variants={animationsOn ? PANEL_ITEM : undefined}
                  initial={animationsOn ? 'hidden' : false}
                  animate={animationsOn ? 'show' : false}
                  className="h-10 flex items-center justify-between px-4 border-b border-zinc-800 flex-shrink-0"
                >
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                    {panel === 'tasks' && 'Tasks'}
                    {panel === 'plan' && 'Plan Composer'}
                    {panel === 'artifacts' && 'Artifacts'}
                  </span>
                  <button onClick={() => setPanel(null)} className="text-zinc-500 hover:text-zinc-200">
                    <X size={16} />
                  </button>
                </motion.div>
                <motion.div
                  variants={animationsOn ? PANEL_ITEM : undefined}
                  initial={animationsOn ? 'hidden' : false}
                  animate={animationsOn ? 'show' : false}
                  className="flex-1 min-h-0 overflow-hidden"
                >
                  {panel === 'tasks' && (
                    <div className="h-full flex flex-col">
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <TasksPanel
                          tasks={tasks}
                          onChanged={refreshAll}
                          onOpenArtifact={openArtifact}
                          selectedId={selectedTaskId}
                          onSelectTask={setSelectedTaskId}
                        />
                      </div>
                      <div className="h-[45%] min-h-0 border-t border-zinc-800 overflow-hidden">
                        <TaskInboxPanel taskId={selectedTaskId} task={selectedTask} />
                      </div>
                    </div>
                  )}
                  {panel === 'plan' && <PlanComposer />}
                  {panel === 'artifacts' && <ArtifactViewer initialTaskId={artifactTaskId} />}
                </motion.div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* (Footer replaced by the live StatusBar inside IDEView.) */}

      <NewTaskDialog
        open={showNewTask}
        onClose={() => setShowNewTask(false)}
        onCreated={refreshAll}
        existingTasks={tasks}
        agents={agents}
      />
      <BackendSettingsModal
        open={showBackendSettings}
        onClose={() => { setShowBackendSettings(false); refreshConfig() }}
      />
      <CostDashboardModal
        open={showCostDashboard}
        onClose={() => setShowCostDashboard(false)}
      />
      <ToastHost />
    </div>
  )
}

function PanelTab({ label, icon, active, onClick, badge }: {
  label: string; icon: React.ReactNode; active: boolean; onClick: () => void; badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 relative ${
        active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {icon}
      {label}
      {badge != null && badge > 0 && (
        <span className="ml-0.5 px-1 min-w-4 text-center rounded-full bg-amber-500/80 text-zinc-950 text-[9px] font-bold">
          {badge}
        </span>
      )}
    </button>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="uppercase tracking-wider text-[10px] text-zinc-500">{label}</span>
      <span className={`font-mono font-semibold ${color}`}>{value}</span>
    </div>
  )
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.api.windowIsMaximized().then(setMaximized).catch(() => {})
    const off = window.api.onWindowMaximizedChanged(setMaximized)
    return off
  }, [])

  return (
    <div
      className="flex items-center -mr-4"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        onClick={() => window.api.windowMinimize()}
        title="Minimize"
        className="w-11 h-11 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70 transition-colors"
      >
        <Minus size={15} />
      </button>
      <button
        onClick={() => window.api.windowMaximizeToggle().then(setMaximized)}
        title={maximized ? 'Restore' : 'Maximize'}
        className="w-11 h-11 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70 transition-colors"
      >
        {maximized ? <Copy size={12} className="-scale-x-100" /> : <Square size={12} />}
      </button>
      <button
        onClick={() => window.api.windowClose()}
        title="Close"
        className="w-11 h-11 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-red-600 transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  )
}
