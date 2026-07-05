// DiffReviewCard.tsx — the floating review card shown when the IDE agent (in
// review mode) proposes a Write/Edit. It renders a line-level red/green diff of
// the change and gates it behind Accept / Reject. Accept persists the change
// (the agent's tool call unblocks and applies it); Reject discards it.
//
// Unlike the inline "Ask AI" card (which slides into a text selection), this is
// a self-contained overlay: the agent may touch files that aren't open or don't
// exist yet, so there's no selection to anchor to. IDEView opens the target
// file first, then floats this card over the editor.

import { motion } from 'framer-motion'
import { Check, X, FilePlus2, FilePen } from 'lucide-react'
import { PendingChange } from '../lib/api'
import { computeLineDiff, DiffRow } from '../lib/lineDiff'
import { useMemo } from 'react'

interface Props {
  change: PendingChange
  onAccept: () => void
  onReject: () => void
  // Read-only preview (ShowDiff): no Accept/Reject, just a Dismiss button.
  readOnly?: boolean
}

export function DiffReviewCard({ change, onAccept, onReject, readOnly = false }: Props) {
  const rows = useMemo(
    () => computeLineDiff(change.before, change.after),
    [change.before, change.after],
  )
  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length

  return (
    <motion.div
      className="absolute z-40 right-4 top-4 w-[440px] max-w-[70%] rounded-lg overflow-hidden pointer-events-auto flex flex-col"
      style={{
        maxHeight: 'calc(100% - 2rem)',
        boxShadow: '0 18px 50px -8px rgba(0,0,0,.7), 0 0 0 1px rgba(63,63,70,.6)',
      }}
      initial={{ opacity: 0, y: -10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/95 border-b border-blue-500/30">
        <span className="text-blue-300">
          {change.isNew ? <FilePlus2 size={13} /> : <FilePen size={13} />}
        </span>
        <span className="text-[12px] font-semibold text-zinc-200 truncate flex-1" title={change.path}>
          {change.path}
        </span>
        <span className="text-[10px] font-mono text-emerald-400">+{added}</span>
        <span className="text-[10px] font-mono text-rose-400">-{removed}</span>
        <span className="text-[9px] uppercase tracking-wider text-zinc-500">
          {change.isNew ? 'new file' : change.kind}
        </span>
      </div>

      {/* Diff body */}
      <div className="flex-1 overflow-auto bg-[#0b0b0e] font-mono text-[11.5px] leading-[1.55] scrollbar-thin">
        <table className="w-full border-collapse">
          <tbody>
            {rows.map((row, i) => (
              <DiffLine key={i} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/95 border-t border-zinc-800">
        {readOnly ? (
          <>
            <span className="text-[10px] text-zinc-500 flex-1">Preview only — not applied</span>
            <button
              onClick={onReject}
              className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 flex items-center gap-1.5"
            >
              <X size={11} /> Dismiss
            </button>
          </>
        ) : (
          <>
            <span className="text-[10px] text-zinc-500 flex-1">Review this change before it hits disk</span>
            <button
              onClick={onReject}
              className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 flex items-center gap-1.5"
            >
              <X size={11} /> Reject
            </button>
            <button
              onClick={onAccept}
              className="px-2.5 py-1 text-[11px] font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5"
            >
              <Check size={11} /> Accept
            </button>
          </>
        )}
      </div>
    </motion.div>
  )
}

function DiffLine({ row }: { row: DiffRow }) {
  const bg =
    row.kind === 'add' ? 'bg-emerald-500/10' : row.kind === 'del' ? 'bg-rose-500/10' : ''
  const sign =
    row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const signColor =
    row.kind === 'add' ? 'text-emerald-400' : row.kind === 'del' ? 'text-rose-400' : 'text-zinc-600'
  const textColor =
    row.kind === 'add' ? 'text-emerald-200' : row.kind === 'del' ? 'text-rose-200/80' : 'text-zinc-400'
  return (
    <tr className={bg}>
      <td className="select-none text-right pr-2 pl-2 w-10 text-zinc-600 align-top">
        {row.oldNo ?? ''}
      </td>
      <td className="select-none text-right pr-2 w-10 text-zinc-600 align-top">
        {row.newNo ?? ''}
      </td>
      <td className={`select-none text-center w-4 ${signColor} align-top`}>{sign}</td>
      <td className={`pr-3 whitespace-pre-wrap break-all ${textColor}`}>{row.text || ' '}</td>
    </tr>
  )
}
