// termWebgl.ts — attach xterm's GPU renderer to a terminal that is actually
// visible. The DOM renderer re-lays-out rows on every write burst; WebGL
// renders from a glyph atlas on the GPU and stays smooth under fast output.

import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

const loaded = new WeakSet<Terminal>()

// Idempotent. Falls back silently to the DOM renderer when WebGL is
// unavailable, and reverts on context loss (browser reclaims GPU contexts
// beyond ~16 per page).
export function enableWebgl(term: Terminal): void {
  if (loaded.has(term)) return
  loaded.add(term)
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      try { addon.dispose() } catch { /* back to the DOM renderer */ }
      loaded.delete(term)
    })
    term.loadAddon(addon)
  } catch {
    /* WebGL unavailable — DOM renderer stays */
  }
}
