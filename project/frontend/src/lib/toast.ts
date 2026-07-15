// toast.ts — tiny pub/sub toast bus (same pattern as uiSettings). Callable
// from anywhere — components, IPC callbacks, plain modules — without context:
//
//   import { toast } from '../lib/toast'
//   toast('Pushed to origin', 'success')
//
// ToastHost (mounted once in App) subscribes and renders the stack.

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
  /** ms before auto-dismiss; 0 = sticky until clicked */
  duration: number
}

let nextId = 1
let toasts: Toast[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function toast(message: string, kind: ToastKind = 'info', opts?: { duration?: number }): number {
  const t: Toast = {
    id: nextId++,
    message: String(message).slice(0, 500),
    kind,
    duration: opts?.duration ?? (kind === 'error' ? 6000 : 4000),
  }
  // Cap the stack so a burst can't fill the screen.
  toasts = [...toasts.slice(-4), t]
  emit()
  return t.id
}

export function dismissToast(id: number): void {
  const before = toasts.length
  toasts = toasts.filter((t) => t.id !== id)
  if (toasts.length !== before) emit()
}

export function getToasts(): Toast[] {
  return toasts
}

export function subscribeToasts(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
