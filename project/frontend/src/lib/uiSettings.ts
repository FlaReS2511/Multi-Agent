// uiSettings.ts — lightweight, persisted UI preferences shared across the app.
//
// A small multi-key settings store (animations, editor font size, word wrap,
// minimap, chat font size, UI zoom). Persisted to localStorage as one JSON
// blob and exposed via subscribable hooks so every component stays in sync in
// realtime. Backward-compatible exports for the original single animations
// flag are kept so older call-sites don't need to change.

import { useSyncExternalStore } from 'react'

export interface UiSettings {
  animationsEnabled: boolean
  editorFontSize: number   // Monaco font size (px)
  chatFontSize: number     // chat / markdown body font size (px)
  wordWrap: boolean        // Monaco word wrap
  minimap: boolean         // Monaco minimap
  zoom: number             // whole-app zoom factor (1 = 100%)
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  animationsEnabled: true,
  editorFontSize: 13,
  chatFontSize: 12,
  wordWrap: true, // matches the editor's original hardcoded 'on'
  minimap: true,
  zoom: 1,
}

const STORAGE_KEY = 'orqon.ui.settings'
// Pre-store single-flag key we migrate from (kept in sync for safety).
const LEGACY_ANIM_KEY = 'orqon.ui.animationsEnabled'

function read(): UiSettings {
  const out = { ...DEFAULT_UI_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiSettings>
      for (const k of Object.keys(out) as (keyof UiSettings)[]) {
        const v = parsed[k]
        if (typeof v === typeof out[k]) (out as Record<string, unknown>)[k] = v
      }
    } else {
      // Migrate the legacy animations flag once.
      const legacy = localStorage.getItem(LEGACY_ANIM_KEY)
      if (legacy !== null) out.animationsEnabled = legacy === 'true'
    }
  } catch {
    /* defaults */
  }
  return out
}

let current: UiSettings = read()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
    localStorage.setItem(LEGACY_ANIM_KEY, String(current.animationsEnabled))
  } catch {
    /* ignore */
  }
}

export function getUiSettings(): UiSettings {
  return current
}

export function setUiSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): void {
  if (current[key] === value) return
  current = { ...current, [key]: value }
  persist()
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// React hook: re-renders the caller whenever ANY setting changes. The store
// object is replaced immutably, so referential equality works per snapshot.
export function useUiSettings(): UiSettings {
  return useSyncExternalStore(subscribe, getUiSettings, getUiSettings)
}

// ── Backward-compatible single-flag API (animations) ─────────────

export function getAnimationsEnabled(): boolean {
  return current.animationsEnabled
}

export function setAnimationsEnabled(enabled: boolean): void {
  setUiSetting('animationsEnabled', enabled)
}

export function useAnimationsEnabled(): boolean {
  return useUiSettings().animationsEnabled
}
