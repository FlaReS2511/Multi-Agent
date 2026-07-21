import { useEffect, useState, useCallback, lazy, Suspense } from 'react'
import { X, Minus, Square, Copy } from 'lucide-react'
import { CostBadge } from './components/CostBadge'
import { IDEView } from './components/IDEView'
import { OrqonLogo } from './components/OrqonLogo'
import { ToastHost } from './components/ToastHost'
import { AgentsConfig } from './lib/api'

// Modals load as their own chunks the first time they open — neither is part
// of the first paint (BackendSettingsModal alone is ~1000 lines of source).
const BackendSettingsModal = lazy(() =>
  import('./components/BackendSettingsModal').then((m) => ({ default: m.BackendSettingsModal })))
const CostDashboardModal = lazy(() =>
  import('./components/CostDashboardModal').then((m) => ({ default: m.CostDashboardModal })))

// IDE-first shell: the IDE is the whole surface. The old multi-agent task
// board / plan / artifacts UI has been removed — the chat agent now spawns and
// manages its own sub-agents (see ChatPanel + IDEView). The underlying task
// board + group coordinator + Discord still run headless in the main process.
export default function App() {
  const [config, setConfig] = useState<AgentsConfig | null>(null)
  const [showBackendSettings, setShowBackendSettings] = useState(false)
  const [showCostDashboard, setShowCostDashboard] = useState(false)

  const refreshConfig = useCallback(() => {
    window.api.getAgentsConfig().then(setConfig)
  }, [])
  useEffect(() => { refreshConfig() }, [refreshConfig])
  // config is loaded so downstream modals reflect saved providers/models.
  void config

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-200">
      {/* Slim header / titlebar */}
      <header
        className="h-11 flex items-center justify-between px-4 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur flex-shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5">
          <OrqonLogo size={22} />
        </div>
        <div
          className="flex items-center gap-4 text-xs text-zinc-500"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <CostBadge onClick={() => setShowCostDashboard(true)} />
          <button
            onClick={() => setShowBackendSettings(true)}
            title="Backend settings — providers, models, API keys"
            className="px-2 py-1 text-[11px] font-medium rounded border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            ⚙
          </button>
          <WindowControls />
        </div>
      </header>

      {/* Body: the IDE is the whole surface. */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div className="absolute inset-0">
          <IDEView />
        </div>
      </div>

      <Suspense fallback={null}>
        {showBackendSettings && (
          <BackendSettingsModal
            open={showBackendSettings}
            onClose={() => { setShowBackendSettings(false); refreshConfig() }}
          />
        )}
        {showCostDashboard && (
          <CostDashboardModal
            open={showCostDashboard}
            onClose={() => setShowCostDashboard(false)}
          />
        )}
      </Suspense>
      <ToastHost />
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
