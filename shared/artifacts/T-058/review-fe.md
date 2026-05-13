# FE Review T-058 — re-review T-050 post-fix (4 issues từ T-057)

**Date:** 2026-05-08 22:07
**Verdict:** approved

## Files reviewed
- `project/frontend/electron/ipc/agents.ts` (commit 86a2ff2, lines 165–183)
- `project/frontend/src/components/TerminalsView.tsx` (commit 86a2ff2, full diff)

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- `destroyAgent` in preload/api still returns `Promise<any>` (via `ipcRenderer.invoke`). The fix accesses `res.ok` / `res.error` correctly at runtime; TypeScript accepts it because `any` absorbs property access. Non-blocking — typing it as `Promise<{ ok: boolean; error?: string }>` in preload would be a clean follow-up.

### Issue 1 — Modal a11y (role, aria, focus)
- `role="dialog"` added to inner `<div>` ✅
- `aria-modal="true"` added ✅
- `aria-labelledby="destroy-dialog-title"` added ✅
- `id="destroy-dialog-title"` added to `<h3>` ✅
- `autoFocus` on Cancel button — focus lands on the safe action when dialog opens ✅

### Issue 2 — Escape key closes modal
- `useEffect` added with `if (!destroyConfirm) return` guard — listener only attached when dialog is open ✅
- `document.addEventListener('keydown', onKey)` + `removeEventListener` in cleanup ✅
- Effect dep `[destroyConfirm]` is correct; no stale closure risk ✅

### Issue 3 — destroyAgent result check
- `const res = await window.api.destroyAgent(agent)` — result now captured ✅
- `if (!res.ok)` → `setDestroyError(res.error ?? 'unknown error')` + `return` — no tab switch, no `onConfigChange` call on failure ✅
- Error banner rendered above modal layer with dismiss button ✅
- `destroyError` content is from script stderr (internal), not user input — no XSS concern in Electron's contextIsolation context ✅

### Issue 4 — agent-killed event unconditional
- Event emit moved before `return new Promise(...)` — fires immediately after PTY kill, regardless of script outcome ✅
- Duplicate emit on success path removed ✅

### React patterns
- No setState in render ✅
- `setDestroyConfirm(null)` before `await destroyAgent(agent)` prevents double-submit ✅
- `destroyError` state cleared on dismiss — no stale banner ✅

### Async & state
- All original async concerns from T-057 resolved ✅

### Accessibility
- All original a11y concerns from T-057 resolved ✅
- Note: no explicit focus trap (Tab can escape modal). Acceptable for this UI; full trap would require a library or more wiring.

### Security
- No new concerns introduced ✅

### Build & bundle
- No new dependencies ✅
- `TerminalsView.tsx` 43 lines added, still well under 300 line limit ✅

## Action items (changes-requested)
None. All 4 issues from T-057 fully addressed.
