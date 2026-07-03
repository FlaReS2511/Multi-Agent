// InlineAICard.tsx — the floating code-result card for the inline "Ask AI"
// feature. It appears raised above the editor, anchored to the right of the
// selection, showing the streamed/generated replacement code. On Accept it
// slides from its floating position into the selection's on-screen spot, then
// calls onArrived() so the hook can merge the text into the editor.

import { motion } from 'framer-motion'
import { Check, RotateCcw, Sparkles } from 'lucide-react'
import { InlineEditState } from './useInlineAIEdit'

interface Props {
  state: InlineEditState
  onAccept: () => void
  onArrived: () => void
  onReject: () => void
}

export function InlineAICard({ state, onAccept, onArrived, onReject }: Props) {
  if (!state.streaming && !state.hasResult) return null

  // While previewing, sit at the floating spot (raised, to the right). When
  // accepting, animate to the selection's target position and shrink/flatten.
  const floating = { top: state.cardTop, left: state.cardLeft }
  const target = { top: state.targetTop, left: state.targetLeft }

  return (
    <motion.div
      className="absolute z-40 w-[360px] max-w-[60%] rounded-lg overflow-hidden pointer-events-auto"
      style={{ boxShadow: '0 18px 50px -8px rgba(0,0,0,.7), 0 0 0 1px rgba(63,63,70,.6)' }}
      initial={{ top: floating.top, left: floating.left, opacity: 0, scale: 0.9, rotateX: 8 }}
      animate={
        state.accepting
          ? {
              top: target.top,
              left: target.left,
              opacity: [1, 1, 0],
              scale: [1, 1, 0.98],
              rotateX: 0,
              boxShadow: '0 0px 0px 0px rgba(0,0,0,0)',
            }
          : { top: floating.top, left: floating.left, opacity: 1, scale: 1, rotateX: 0 }
      }
      exit={{ opacity: 0, scale: 0.9 }}
      transition={
        state.accepting
          ? { duration: 0.5, ease: [0.22, 1, 0.36, 1], times: [0, 0.75, 1] }
          : { type: 'spring', stiffness: 320, damping: 30 }
      }
      onAnimationComplete={() => { if (state.accepting) onArrived() }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/95 border-b border-emerald-500/30">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300">
          <Sparkles size={12} />
          {state.streaming ? 'Generating…' : 'AI suggestion'}
        </span>
        {state.streaming && <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      </div>

      {/* Code body */}
      <pre className="m-0 px-3 py-2 max-h-[320px] overflow-auto bg-[#0b1f17] text-[#a7f3d0] text-[12px] leading-[1.5] font-mono whitespace-pre-wrap">
        {state.preview || ' '}
        {state.streaming && <span className="inline-block w-1.5 h-3.5 align-middle bg-emerald-400 animate-pulse ml-0.5" />}
      </pre>

      {/* Actions (hidden during the slide) */}
      {state.hasResult && !state.accepting && (
        <div className="flex items-center justify-end gap-2 px-3 py-2 bg-zinc-900/95 border-t border-zinc-800">
          <button
            onClick={onReject}
            className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5"
          >
            <RotateCcw size={11} /> Discard
          </button>
          <button
            onClick={onAccept}
            className="px-2.5 py-1 text-[11px] font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5"
          >
            <Check size={11} /> Accept & merge
          </button>
        </div>
      )}
    </motion.div>
  )
}
