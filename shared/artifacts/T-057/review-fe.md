# FE Review T-057 — confirm dialog before destroy-agent.sh

**Date:** 2026-05-08 22:05
**Verdict:** changes-requested

## Files reviewed
- `project/frontend/electron/ipc/agents.ts` (destroy-agent handler, lines 162–183)
- `project/frontend/electron/preload.ts` (line 93)
- `project/frontend/src/lib/api.ts` (destroyAgent binding)
- `project/frontend/src/components/TerminalsView.tsx`

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- `destroyAgent` in `preload.ts` / `api.ts` returns `Promise<unknown>` (no return type annotation). Low risk since the renderer ignores the result today, but worth typing as `Promise<{ ok: boolean; error?: string }>`.

### React patterns
- `destroyConfirm` state (`string | null`) cleanly drives both button visibility and modal render ✅
- No setState in render ✅
- `setDestroyConfirm(null)` before `await destroyAgent(agent)` (line 201) is correct — prevents double-click double-submit ✅
- `onConfigChange?.()` always called after confirm regardless of IPC result — see Security/Async section.

### Async & state
- **Issue:** `destroyAgent` return value is not checked in the renderer (lines 199–205). If `destroy-agent.sh` fails (e.g. folder already gone, permission error), IPC returns `{ ok: false, error: "..." }` but the UI silently calls `onConfigChange?.()` and switches tabs. The agent may still exist in `agents-config.json` while the tab has switched away, creating confusing state. At minimum, log or surface the error.
- **Issue:** In the IPC handler (`agents.ts` lines 171–174), `agent-killed` is only emitted on success. If the script fails, the PTY is already dead but the event is never fired. The renderer's `ptyStatusDetail` poll (2 s) will eventually remove the dot, but any listener relying on `onAgentKilled` for the destroyed agent (e.g. future callers) will never receive it. Emitting the event unconditionally after PTY kill would be more correct.

### Accessibility
- **Issue (blocking):** The confirm modal `<div>` is missing `role="dialog"`, `aria-modal="true"`, and `aria-labelledby`. Screen readers will not announce it as a dialog when it opens.
- **Issue (blocking):** No focus management on modal open — keyboard focus stays behind the overlay. At minimum, auto-focus the Cancel or Destroy button when `destroyConfirm` is set (via `autoFocus` prop or `useEffect` + `ref.focus()`).
- **Issue:** No `Escape` key handler to cancel the modal. Convention for all dialogs.
- Buttons have visible text labels ✅
- No `<div onClick>` used for interactive elements ✅

### Security
- `execFile('bash', [scriptPath, instance])` passes the agent name as an array argument (not shell-interpolated) — no shell injection possible ✅
- `instance` originates from `agents-config.json` keys, not direct user text input ✅
- `execFile('bash', ...)` will silently fail on Windows (bash not in PATH by default). Pre-existing platform constraint, acceptable given the system is macOS/Linux-first.

### Build & bundle
- No new dependencies ✅
- `TerminalsView.tsx` is 243 lines (< 300 limit) ✅

### Quality
- Clone-only guard `/-\d+$/.test(active)` is correct and matches the naming convention from `clone-agent.sh` ✅
- Cancel = `setDestroyConfirm(null)` only — pure no-op, script never runs ✅
- Tab switch on destroy: `if (active === agent) switchTo('orchestrator')` ✅
- Pre-existing `window.confirm()` in `onModelChange` (line 92) is outside this task's scope.

## Action items (changes-requested)

1. `TerminalsView.tsx:185` — Add `role="dialog" aria-modal="true" aria-labelledby="destroy-dialog-title"` to the modal outer `<div>`.
2. `TerminalsView.tsx:187` — Add `id="destroy-dialog-title"` to the `<h3>`.
3. `TerminalsView.tsx:184` or modal inner div — Add `autoFocus` to the Cancel button (safe default) or use a `useEffect` ref to move focus when dialog opens.
4. `TerminalsView.tsx:184` — Add `onKeyDown` (or `useEffect` on `destroyConfirm`) to call `setDestroyConfirm(null)` on `Escape`.
5. `TerminalsView.tsx:199–205` — Check result of `destroyAgent`: if `!res.ok`, do not switch tabs / call `onConfigChange`; surface the error (console.error at minimum, toast/status if available).
6. `agents.ts:171` — Emit `agent-killed` unconditionally after PTY kill, not only on script success. Reason: PTY is already dead; event consumers should be notified regardless of whether the folder cleanup succeeded.
