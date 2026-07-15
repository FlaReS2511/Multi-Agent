import React, { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw, Skull, ChevronRight, ChevronDown, DollarSign, Layers, Gauge } from 'lucide-react'
import {
  GroupRow,
  GroupMemoryRow,
  GROUP_STATUS_STYLES,
  colorFor,
} from '../lib/api'

// GroupsPanel — v2 orchestration monitor. Shows the live group tree (worker +
// on-demand reviewer per task), status, cost vs budget, retries, and per-group
// memory (progress notes / review reports). Manual kill per group.

interface GroupsPanelProps {
  windup?: boolean
}

const CONTAINER = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
}
const ITEM = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: 'easeOut' } },
}

export function GroupsPanel({ windup }: GroupsPanelProps) {
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [memory, setMemory] = useState<Record<string, GroupMemoryRow[]>>({})
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.groupList()
      if (res.ok) setGroups(res.groups)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const off = window.api.onCoordinatorEvent(() => refresh())
    const t = setInterval(refresh, 3000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  const toggleExpand = useCallback(async (groupId: string) => {
    setExpanded((e) => ({ ...e, [groupId]: !e[groupId] }))
    if (!memory[groupId]) {
      const res = await window.api.groupMemory(groupId)
      if (res.ok) setMemory((m) => ({ ...m, [groupId]: res.memory }))
    }
  }, [memory])

  const kill = useCallback(async (groupId: string) => {
    await window.api.groupKill(groupId)
    refresh()
  }, [refresh])

  // Order roots first, children grouped under parents.
  const roots = groups.filter((g) => !g.parent_group)
  const childrenOf = (id: string) => groups.filter((g) => g.parent_group === id)

  const renderGroup = (g: GroupRow, depth: number): React.ReactNode => {
    const style = GROUP_STATUS_STYLES[g.status]
    const isOpen = expanded[g.id]
    const kids = childrenOf(g.id)
    const live = g.status === 'active' || g.status === 'reviewing' || g.status === 'pending'
    const overBudget = g.budget_usd > 0 && g.spent_usd > g.budget_usd
    return (
      <motion.div
        key={g.id}
        variants={windup ? ITEM : undefined}
        className="flex flex-col"
        style={{ marginLeft: depth * 12 }}
      >
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 hover:border-zinc-700 transition-colors">
          <div className="flex items-center gap-2 px-2.5 py-2">
            <button
              onClick={() => toggleExpand(g.id)}
              className="text-zinc-500 hover:text-zinc-200 p-0.5"
            >
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <span className="font-mono text-xs font-semibold text-zinc-300">{g.id}</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ring-1 ${style.classes}`}>
              {style.label}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">{g.task_id}</span>
            {live && (
              <button
                onClick={() => kill(g.id)}
                title="Kill group"
                className="ml-auto text-zinc-600 hover:text-rose-400 p-0.5"
              >
                <Skull size={13} />
              </button>
            )}
          </div>
          <div className="px-2.5 pb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
            {g.worker_role && (
              <span className={`font-mono ${colorFor(g.worker_role)}`}>
                w: {g.worker_role}
              </span>
            )}
            {g.reviewer_role && (
              <span className={`font-mono ${colorFor(g.reviewer_role)}`}>
                r: {g.reviewer_role}
              </span>
            )}
            <span className={`flex items-center gap-0.5 font-mono ${overBudget ? 'text-rose-400' : 'text-zinc-400'}`}>
              <DollarSign size={9} />
              {g.spent_usd.toFixed(4)}
              {g.budget_usd > 0 && <span className="text-zinc-600">/{g.budget_usd}</span>}
            </span>
            {g.retries > 0 && <span className="text-amber-400 font-mono">retry {g.retries}</span>}
            {g.depth > 0 && (
              <span className="flex items-center gap-0.5 text-zinc-500 font-mono">
                <Layers size={9} />
                {g.depth}
              </span>
            )}
            {g.peak_context != null && g.peak_context > 0 && g.context_window ? (() => {
              const pct = Math.min(100, (g.peak_context / g.context_window) * 100)
              const col = pct >= 90 ? 'text-rose-400' : pct >= 75 ? 'text-amber-400' : 'text-zinc-500'
              return (
                <span className={`flex items-center gap-0.5 font-mono ${col}`} title={`Peak context: ${g.peak_context.toLocaleString()} / ${g.context_window.toLocaleString()} tokens`}>
                  <Gauge size={9} />
                  {pct.toFixed(0)}%
                </span>
              )
            })() : null}
          </div>
          {isOpen && (
            <div className="px-2.5 pb-2.5 border-t border-zinc-800/60 pt-2 flex flex-col gap-2">
              {(memory[g.id] ?? []).length === 0 && (
                <span className="text-[10px] text-zinc-600 italic">no memory yet</span>
              )}
              {(memory[g.id] ?? []).map((m) => (
                <div key={m.id} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider">
                    <span
                      className={
                        m.kind === 'review_report'
                          ? 'text-fuchsia-400 font-semibold'
                          : m.kind === 'dispatch'
                            ? 'text-cyan-400 font-semibold'
                            : 'text-blue-400 font-semibold'
                      }
                    >
                      {m.kind}
                    </span>
                    {m.role && <span className="text-zinc-600">{m.role}</span>}
                    <span className="text-zinc-700 ml-auto font-mono">{m.ts}</span>
                  </div>
                  <pre className="text-[10px] text-zinc-400 whitespace-pre-wrap font-mono leading-snug bg-zinc-950/50 rounded p-1.5 max-h-40 overflow-y-auto scrollbar-thin">
                    {m.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
        {kids.map((k) => renderGroup(k, depth + 1))}
      </motion.div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[10px] text-zinc-500">
          {groups.length === 0 ? 'no groups' : `${groups.length} group${groups.length > 1 ? 's' : ''}`}
        </span>
        <button
          onClick={refresh}
          title="Refresh"
          className="text-zinc-500 hover:text-zinc-200 p-0.5"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin text-blue-400' : ''} />
        </button>
      </div>
      {groups.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-4">
          <p className="text-[11px] text-zinc-600 leading-relaxed">
            No active groups. Enable orchestration in Settings and dispatch a task to
            spawn a worker + reviewer group.
          </p>
        </div>
      ) : (
        <motion.div
          variants={windup ? CONTAINER : undefined}
          initial={windup ? 'hidden' : false}
          animate={windup ? 'show' : false}
          className="flex flex-col gap-2"
        >
          {roots.map((g) => renderGroup(g, 0))}
        </motion.div>
      )}
    </div>
  )
}
