import React, { useState, useCallback } from 'react'
import {
  GitBranch,
  GitCommit,
  ArrowUp,
  ArrowDown,
  Plus,
  Minus,
  Check,
  RefreshCw,
  Undo2,
} from 'lucide-react'
import { toast } from '../lib/toast'

interface StatusEntry {
  file: string
  type: string
  staged?: boolean
}

interface Props {
  /** Git status + branch come from the HOST's single 2s poll — this panel
      used to run its own duplicate 3s polling loop (3 more git spawns/3s). */
  status: StatusEntry[]
  branch: { current: string; branches: string[] }
  onOpenFile: (file: string) => void
  onChanged?: () => void
  /** Discard a file's working-tree changes (confirmed by the host). */
  onDiscard?: (file: string) => void
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function dirname(p: string): string {
  const parts = p.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

function badgeClasses(type: string): string {
  const t = type.trim().toUpperCase()
  if (t === 'A' || t === '??') return 'text-emerald-400'
  if (t === 'D') return 'text-rose-400'
  if (t === 'M') return 'text-amber-400'
  return 'text-zinc-400'
}

function truncate(s: string, n = 200): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

export const GitPanel = React.memo(function GitPanel({ status, branch, onOpenFile, onChanged, onDiscard }: Props) {
  const [branchOpen, setBranchOpen] = useState(false)
  const [newBranchMode, setNewBranchMode] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [opStatus, setOpStatus] = useState<string | null>(null)

  // After a mutation the host re-fetches status/branch and the new props
  // arrive on the next render.
  const afterMutation = useCallback(async () => {
    onChanged?.()
  }, [onChanged])

  const staged = status.filter((s) => s.staged === true)
  const unstaged = status.filter((s) => s.staged !== true)

  const checkout = async (name: string, create = false) => {
    setNewBranchName('')
    const res = await window.api.workspaceGitCheckout(name, create)
    if (!res.ok) {
      // Keep the dropdown open so the user sees they are still on the old
      // branch; surface why (dirty tree, conflicts…) instead of failing mute.
      setOpStatus(res.error || 'Checkout failed')
      toast(res.error || `Could not switch to ${name}`, 'error')
      return
    }
    setBranchOpen(false)
    setNewBranchMode(false)
    await afterMutation()
  }

  const commit = async () => {
    if (!commitMsg.trim() || staged.length === 0) return
    setCommitting(true)
    try {
      const res = await window.api.workspaceGitCommit(commitMsg.trim())
      if (res.ok) {
        setCommitMsg('')
        setOpStatus(res.output ? truncate(res.output) : 'Committed')
        toast('Committed', 'success')
        await afterMutation()
      } else {
        setOpStatus(res.error || 'Commit failed')
        toast(res.error || 'Commit failed', 'error')
      }
    } finally {
      setCommitting(false)
    }
  }

  const pull = async () => {
    setPulling(true)
    try {
      const res = await window.api.workspaceGitPull()
      setOpStatus(res.output ? truncate(res.output) : res.ok ? 'Pulled' : 'Pull failed')
      if (res.ok) toast('Pulled', 'success')
      else toast(res.output ? truncate(res.output, 200) : 'Pull failed', 'error')
      await afterMutation()
    } finally {
      setPulling(false)
    }
  }

  const push = async () => {
    setPushing(true)
    try {
      const res = await window.api.workspaceGitPush()
      setOpStatus(res.output ? truncate(res.output) : res.ok ? 'Pushed' : 'Push failed')
      if (res.ok) toast('Pushed', 'success')
      else toast(res.output ? truncate(res.output, 200) : 'Push failed', 'error')
    } finally {
      setPushing(false)
    }
  }

  // Stage/unstage report their errors instead of failing silently (a common
  // one: staging a path git can't add). afterMutation always refreshes so the
  // panel reflects reality even on partial success.
  const stage = async (file: string) => {
    const res = await window.api.workspaceGitStage(file)
    if (!res.ok) toast(res.error || `Could not stage ${file}`, 'error')
    await afterMutation()
  }

  const unstage = async (file: string) => {
    const res = await window.api.workspaceGitUnstage(file)
    if (!res.ok) toast(res.error || `Could not unstage ${file}`, 'error')
    await afterMutation()
  }

  const stageAll = async () => {
    const res = await window.api.workspaceGitStageAll()
    if (!res.ok) toast(res.error || 'Could not stage changes', 'error')
    await afterMutation()
  }

  const renderItem = (entry: StatusEntry, isStaged: boolean) => (
    <div
      key={`${isStaged ? 's' : 'u'}:${entry.file}`}
      className="group flex items-center gap-2 px-2 py-0.5 hover:bg-zinc-800/60"
    >
      <button
        onClick={() => onOpenFile(entry.file)}
        className="flex-1 flex items-baseline gap-1.5 min-w-0 text-left"
      >
        <span className="truncate text-zinc-200">{basename(entry.file)}</span>
        <span className="truncate text-[10px] text-zinc-600">
          {dirname(entry.file)}
        </span>
      </button>
      {!isStaged && onDiscard && (
        <button
          onClick={() => onDiscard(entry.file)}
          title="Discard changes"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 text-zinc-400 hover:text-rose-400 shrink-0"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        onClick={() => (isStaged ? unstage(entry.file) : stage(entry.file))}
        title={isStaged ? 'Unstage' : 'Stage'}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 text-zinc-400 hover:text-white shrink-0"
      >
        {isStaged ? (
          <Minus className="w-3.5 h-3.5" />
        ) : (
          <Plus className="w-3.5 h-3.5" />
        )}
      </button>
      <span
        className={`shrink-0 w-5 text-center font-mono text-[10px] ${badgeClasses(
          entry.type,
        )}`}
      >
        {entry.type.trim().toUpperCase()}
      </span>
    </div>
  )

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-xs text-zinc-300">
      <div className="p-2 border-b border-zinc-800 space-y-2">
        <div className="flex items-center gap-1">
          <div className="relative flex-1 min-w-0">
            <button
              onClick={() => setBranchOpen((v) => !v)}
              className="flex items-center gap-1.5 max-w-full text-zinc-200 hover:text-white"
              title="Switch branch"
            >
              <GitBranch className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <span className="truncate">{branch.current || '—'}</span>
            </button>

            {branchOpen && (
              <div className="absolute z-20 mt-1 left-0 w-56 max-h-64 overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
                {branch.branches.map((b) => (
                  <button
                    key={b}
                    onClick={() => checkout(b)}
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-zinc-800"
                  >
                    {b === branch.current && (
                      <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                    )}
                    <span
                      className={
                        b === branch.current ? 'text-white' : 'text-zinc-300'
                      }
                    >
                      {b}
                    </span>
                  </button>
                ))}
                <div className="border-t border-zinc-800 mt-1 pt-1">
                  {newBranchMode ? (
                    <div className="px-2 py-1">
                      <input
                        type="text"
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        autoFocus
                        placeholder="branch name"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newBranchName.trim())
                            checkout(newBranchName.trim(), true)
                          else if (e.key === 'Escape') setNewBranchMode(false)
                        }}
                        className="w-full px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewBranchMode(true)}
                      className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-zinc-400 hover:bg-zinc-800 hover:text-white"
                    >
                      <Plus className="w-3 h-3 shrink-0" />
                      New branch...
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={pull}
            disabled={pulling}
            title="Pull"
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:text-zinc-700"
          >
            {pulling ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowDown className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={push}
            disabled={pushing}
            title="Push"
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:text-zinc-700"
          >
            {pushing ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowUp className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {opStatus && (
          <div className="text-[10px] font-mono text-zinc-500 whitespace-pre-wrap break-words">
            {opStatus}
          </div>
        )}

        <div>
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={2}
            placeholder="Message (commit staged changes)"
            className="w-full px-2 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 resize-y"
          />
          <button
            onClick={commit}
            disabled={committing || !commitMsg.trim() || staged.length === 0}
            className="mt-1 w-full flex items-center justify-center gap-1.5 px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors"
          >
            {committing ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <GitCommit className="w-3.5 h-3.5" />
            )}
            Commit
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {staged.length > 0 && (
          <div className="mb-2">
            <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Staged Changes ({staged.length})
            </div>
            {staged.map((e) => renderItem(e, true))}
          </div>
        )}

        <div>
          <div className="flex items-center px-2 py-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Changes ({unstaged.length})
            </span>
            {unstaged.length > 0 && (
              <button
                onClick={stageAll}
                title="Stage All"
                className="ml-auto text-zinc-500 hover:text-white"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {unstaged.map((e) => renderItem(e, false))}
        </div>

        {status.length === 0 && (
          <div className="p-3 text-zinc-600">No changes</div>
        )}
      </div>
    </div>
  )
})
