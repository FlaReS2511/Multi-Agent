// ToastHost.tsx — renders the toast stack (bottom-right). Mounted once in App.
// Subscribes to the lib/toast bus; each toast auto-dismisses after its
// duration and can be dismissed by click.

import { useEffect, useSyncExternalStore } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'
import { Toast, dismissToast, getToasts, subscribeToasts } from '../lib/toast'

const KIND_STYLES: Record<Toast['kind'], { border: string; icon: JSX.Element }> = {
  info: { border: 'border-blue-500/40', icon: <Info size={14} className="text-blue-400 flex-shrink-0" /> },
  success: { border: 'border-emerald-500/40', icon: <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" /> },
  error: { border: 'border-rose-500/40', icon: <XCircle size={14} className="text-rose-400 flex-shrink-0" /> },
}

function ToastCard({ t }: { t: Toast }) {
  useEffect(() => {
    if (t.duration <= 0) return
    const timer = setTimeout(() => dismissToast(t.id), t.duration)
    return () => clearTimeout(timer)
  }, [t.id, t.duration])

  const style = KIND_STYLES[t.kind]
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onClick={() => dismissToast(t.id)}
      className={`pointer-events-auto flex items-start gap-2 max-w-sm px-3 py-2 rounded-lg bg-zinc-900/95 border ${style.border} shadow-xl cursor-pointer backdrop-blur-sm`}
    >
      {style.icon}
      <span className="text-xs text-zinc-200 leading-relaxed break-words min-w-0">{t.message}</span>
      <X size={12} className="text-zinc-600 hover:text-zinc-300 flex-shrink-0 mt-0.5" />
    </motion.div>
  )
}

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  return (
    <div className="fixed bottom-8 right-4 z-[100] flex flex-col items-end gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => <ToastCard key={t.id} t={t} />)}
      </AnimatePresence>
    </div>
  )
}
