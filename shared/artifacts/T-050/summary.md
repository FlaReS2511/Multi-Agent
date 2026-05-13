# T-050: Confirm dialog before destroy-agent

## Changes (backup repo: `C:\Users\ADMINA1\Downloads\hi\multi-agent\Multi-Agent`)

### `project/frontend/electron/ipc/agents.ts`
- Added `destroy-agent` IPC handler:
  - Kills PTY session for the instance (if running)
  - Emits `agent-killed` event **unconditionally** after PTY kill (regardless of script outcome)
  - Runs `scripts/destroy-agent.sh <instance>` via `execFile('bash', ...)`
  - Returns `{ ok: boolean; error?: string }`

### `project/frontend/electron/preload.ts`
- Exposed `destroyAgent(instance)` bridging to `'destroy-agent'` IPC channel

### `project/frontend/src/lib/api.ts`
- Added `destroyAgent(instance: string): Promise<{ ok: boolean; error?: string }>` to `window.api` interface

### `project/frontend/src/components/TerminalsView.tsx`
- Added `destroyConfirm: string | null` state (drives modal)
- Added `destroyError: string | null` state (surfaces script failure)
- Added **Destroy** button — only visible when active agent matches `/-\d+$/` (clones only)
- Modal: `role="dialog" aria-modal="true" aria-labelledby="destroy-dialog-title"`; `<h3 id="destroy-dialog-title">`
- Cancel button has `autoFocus` (keyboard focus lands here on open)
- `useEffect` listens for `Escape` key when dialog is open → calls `setDestroyConfirm(null)`
- Confirm checks `res.ok`; on failure → sets `destroyError` and keeps tab/config unchanged
- Error shown as inline banner (dismissible) between tab bar and terminal area

## Commits
1. `feat(ui): confirm dialog before destroy-agent` (5553b77)
2. `fix(ui): a11y + error handling for destroy-agent confirm` (86a2ff2)

## Checklist
- [x] All destroy entry points go through the dialog
- [x] Cancel does NOT call the script
- [x] Confirm proceeds normally (kills PTY + runs destroy-agent.sh)
- [x] Destroy button only shown for clone agents (`/-\d+$/`)
- [x] Modal has role="dialog" + aria-modal + aria-labelledby + id on heading
- [x] Cancel button autoFocus + Escape key closes modal
- [x] Script failure → error banner shown, tab NOT switched, config NOT refreshed
- [x] agent-killed event emitted unconditionally after PTY kill

## Post-review fixes (fe-reviewer T-057)
All 4 issues from review addressed:
1. A11y: role/aria attrs + autoFocus on Cancel + Escape key handler
2. Silent failure: result checked, error banner on `!res.ok`
3. agent-killed event: moved before script call (emitted even if script fails)
4. Escape key: useEffect keydown listener active while dialog is open
