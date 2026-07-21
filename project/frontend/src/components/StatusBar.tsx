// StatusBar.tsx — the IDE's live status strip (replaces the old static App
// footer): branch, dirty count, workspace on the left; agent activity, context
// fill, cursor position and language on the right.
//
// The caret position is tracked HERE (subscribed straight to the Monaco
// editor) rather than in IDEView state — a caret move re-renders only this
// 6px strip, not the whole IDE.

import { useEffect, useState } from 'react'
import { GitBranch, FolderOpen, Sparkles } from 'lucide-react'

export interface StatusBarProps {
  branch: string
  dirtyCount: number
  workspaceName: string
  /** Live Monaco editor instance (IDEView's editorRef). */
  editorRef: React.MutableRefObject<any>
  /** Bumped when a (new) editor mounts, so the subscription re-attaches. */
  editorEpoch: number
  /** Whether a file editor is showing (false → no cursor readout). */
  editorActive: boolean
  language: string
  agentBusy: boolean
  ctxUsage: { used: number; window: number } | null
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

export function StatusBar({ branch, dirtyCount, workspaceName, editorRef, editorEpoch, editorActive, language, agentBusy, ctxUsage }: StatusBarProps) {
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null)

  useEffect(() => {
    if (!editorActive) { setCursor(null); return }
    const ed = editorRef.current
    if (!ed) { setCursor(null); return }
    try {
      const pos = ed.getPosition?.()
      if (pos) setCursor({ line: pos.lineNumber, col: pos.column })
      const sub = ed.onDidChangeCursorPosition((e: any) => {
        setCursor({ line: e.position.lineNumber, col: e.position.column })
      })
      return () => { try { sub.dispose() } catch { /* editor already disposed */ } }
    } catch { setCursor(null) }
  }, [editorRef, editorEpoch, editorActive])

  const pct = ctxUsage && ctxUsage.window > 0 ? Math.min(100, Math.round((ctxUsage.used / ctxUsage.window) * 100)) : null
  const pctColor = pct == null ? '' : pct >= 90 ? 'bg-rose-400' : pct >= 75 ? 'bg-amber-400' : 'bg-blue-400'

  return (
    <div className="h-6 px-3 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between text-[10px] text-zinc-500 flex-shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0">
        {branch && (
          <span className="flex items-center gap-1 text-zinc-400">
            <GitBranch size={10} />
            <span className="truncate max-w-[160px] font-mono">{branch}</span>
          </span>
        )}
        {dirtyCount > 0 && (
          <span className="flex items-center gap-1 text-blue-300">
            <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
            {dirtyCount} unsaved
          </span>
        )}
        {workspaceName && (
          <span className="flex items-center gap-1 truncate">
            <FolderOpen size={10} />
            <span className="truncate max-w-[220px]">{workspaceName}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {agentBusy && (
          <span className="flex items-center gap-1 text-blue-300">
            <Sparkles size={10} className="animate-pulse" />
            agent working…
          </span>
        )}
        {pct != null && ctxUsage && (
          <span className="flex items-center gap-1.5" title={`Agent context: ${fmtK(ctxUsage.used)} / ${fmtK(ctxUsage.window)} tokens`}>
            <span className="w-14 h-1 rounded-full bg-zinc-800 overflow-hidden">
              <span className={`block h-full ${pctColor}`} style={{ width: `${pct}%` }} />
            </span>
            <span className="font-mono">{pct}%</span>
          </span>
        )}
        {editorActive && cursor && (
          <span className="font-mono text-zinc-400">Ln {cursor.line}, Col {cursor.col}</span>
        )}
        {language && <span className="uppercase tracking-wider">{language}</span>}
        <span className="text-zinc-600">Orqon v1-dirty</span>
      </div>
    </div>
  )
}
