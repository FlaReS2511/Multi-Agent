// uiSettings.ts — lightweight, persisted UI preferences shared across the app.
//
// Currently holds a single flag: whether decorative animations (panel slide-in,
// content "windup" stagger, etc.) are enabled. Persisted to localStorage and
// exposed via a subscribable hook so every component stays in sync in realtime.

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'orqon.ui.animationsEnabled'

function read(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    // Default ON when unset.
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

let current = read()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function getAnimationsEnabled(): boolean {
  return current
}

export function setAnimationsEnabled(enabled: boolean): void {
  current = enabled
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled))
  } catch {
    /* ignore */
  }
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// React hook: re-renders the caller whenever the flag changes.
export function useAnimationsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getAnimationsEnabled, getAnimationsEnabled)
}
