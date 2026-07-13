// ConfirmDialog.tsx — small shared modal replacing window.confirm and powering
// multi-choice prompts (e.g. Save & Close / Discard / Cancel). Controlled:
// render with `dialog` state or null. Esc = the last (cancel) button.

import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export interface ConfirmButton {
  label: string
  kind?: 'primary' | 'danger' | 'ghost'
  onClick: () => void
}

export interface ConfirmDialogSpec {
  title: string
  message: string
  buttons: ConfirmButton[]
}

const BTN_STYLES: Record<NonNullable<ConfirmButton['kind']>, string> = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white',
  danger: 'bg-rose-600 hover:bg-rose-500 text-white',
  ghost: 'border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-600',
}

export function ConfirmDialog({ dialog }: { dialog: ConfirmDialogSpec | null }) {
  // Esc triggers the last button (by convention the cancel/dismiss action).
  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        dialog.buttons[dialog.buttons.length - 1]?.onClick()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog])

  return (
    <AnimatePresence>
      {dialog && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
          onMouseDown={() => dialog.buttons[dialog.buttons.length - 1]?.onClick()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="w-[400px] max-w-[90vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-zinc-100 mb-1.5">{dialog.title}</div>
            <div className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">{dialog.message}</div>
            <div className="flex items-center justify-end gap-2 mt-4">
              {dialog.buttons.map((b, i) => (
                <button
                  key={i}
                  onClick={b.onClick}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${BTN_STYLES[b.kind ?? 'ghost']}`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
