import { useEffect, useState, useCallback } from 'react'
import { TasksPanel } from './components/TasksPanel'
import { TaskInboxPanel } from './components/TaskInboxPanel'
import { LogsPanel } from './components/LogsPanel'
import { NewTaskDialog } from './components/NewTaskDialog'
import { TerminalsView } from './components/TerminalsView'
import { ArtifactViewer } from './components/ArtifactViewer'
import { PlanComposer } from './components/PlanComposer'
import { BackendSettingsModal } from './components/BackendSettingsModal'
import { CostBadge } from './components/CostBadge'
import { CostDashboardModal } from './components/CostDashboardModal'
import { Task, InboxSummary, AgentLogs, AgentsConfig, activeAgents } from './lib/api'

type View = 'dashboard' | 'plan' | 'terminals' | 'artifacts'

const POLL_MS = 2000

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [inbox, setInbox] = useState<InboxSummary[]>([])
  const [logs, setLogs] = useState<AgentLogs[]>([])
  const [config, setConfig] = useState<AgentsConfig | null>(null)
  const [, setRoot] = useState<string>('')
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [showNewTask, setShowNewTask] = useState(false)
  const [showBackendSettings, setShowBackendSettings] = useState(false)
  const [showCostDashboard, setShowCostDashboard] = useState(false)
  const [view, setView] = useState<View>('dashboard')
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

  useEffect(() => {
    window.api.getRoot().then(setRoot)
  }, [])

  const refreshConfig = useCallback(() => {
    window.api.getAgentsConfig().then(setConfig)
  }, [])

  useEffect(() => {
    refreshConfig()
  }, [refreshConfig])

  const refreshAll = useCallback(async () => {
    const [t, i, l] = await Promise.all([
      window.api.getTasks(),
      window.api.getInboxSummary(),
      window.api.getLogs(),
    ])
    setTasks(t.tasks)
    setInbox(i)
    setLogs(l)
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
    setView('artifacts')
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-200">
      {/* Header / titlebar */}
      <header
        className="h-11 flex items-center justify-between px-4 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-3 pl-16">
          <div className="size-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
          <h1 className="text-sm font-semibold tracking-wide">Multi-Agent Monitor</h1>
          <div
            className="ml-2 flex items-center bg-zinc-900 border border-zinc-800 rounded p-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <ViewTab label="Dashboard" active={view === 'dashboard'} onClick={() => setView('dashboard')} />
            <ViewTab label="Plan" active={view === 'plan'} onClick={() => setView('plan')} />
            <ViewTab label="Artifacts" active={view === 'artifacts'} onClick={() => setView('artifacts')} />
            <ViewTab label="Terminals" active={view === 'terminals'} onClick={() => setView('terminals')} />
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
          <span className="text-zinc-600 font-mono">
            {lastUpdate.toLocaleTimeString()}
          </span>
          {flash && (
            <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-emerald-500/20 text-emerald-300 animate-pulse">
              ⚡ triggered {flash.agent}
            </span>
          )}
          <button
            onClick={() => {
              const next = !autoTrigger
              window.api.setAutoTrigger(next).then((r) => setAutoTrigger(r.enabled))
            }}
            title={
              autoTrigger
                ? 'Auto-trigger ON — agent tự "check inbox" khi có message mới'
                : 'Auto-trigger OFF — phải gõ "check inbox" thủ công'
            }
            className={`px-2 py-1 text-[10px] font-medium rounded border transition-colors flex items-center gap-1.5 ${
              autoTrigger
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className={`size-1.5 rounded-full ${autoTrigger ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            Auto-trigger {autoTrigger ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={() => setShowBackendSettings(true)}
            title="Backend settings — switch each agent between Claude Code, Codex, Gemini, direct API, or LM Studio"
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
        </div>
      </header>

      {/* Main view */}
      {view === 'dashboard' && (
        <main className="flex-1 grid grid-cols-12 gap-px bg-zinc-800 overflow-hidden">
          <section className="col-span-5 bg-zinc-950 overflow-hidden">
            <TasksPanel
              tasks={tasks}
              onChanged={refreshAll}
              onOpenArtifact={openArtifact}
              selectedId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          </section>
          <section className="col-span-4 bg-zinc-950 overflow-hidden">
            <TaskInboxPanel taskId={selectedTaskId} task={selectedTask} />
          </section>
          <section className="col-span-3 bg-zinc-950 overflow-hidden">
            <LogsPanel logs={logs} agents={agents} />
          </section>
        </main>
      )}
      {view === 'plan' && (
        <main className="flex-1 overflow-hidden">
          <PlanComposer />
        </main>
      )}
      {view === 'artifacts' && (
        <main className="flex-1 overflow-hidden">
          <ArtifactViewer initialTaskId={artifactTaskId} />
        </main>
      )}
      {view === 'terminals' && (
        <main className="flex-1 overflow-hidden">
          <TerminalsView config={config} onConfigChange={refreshConfig} />
        </main>
      )}

      {/* Footer */}
      <footer className="h-6 px-3 border-t border-zinc-800 flex items-center justify-between text-[10px] text-zinc-600 bg-zinc-950">
        <span>Polling every {POLL_MS}ms</span>
        <span>Multi-Agent Dashboard v0.3</span>
      </footer>

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
    </div>
  )
}

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
        active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {label}
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
