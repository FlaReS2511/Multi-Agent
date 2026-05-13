# FE Review T-055 — split electron/main.ts (1213 → 96)

**Date:** 2026-05-08 22:00
**Verdict:** approved

## Files reviewed
- `project/frontend/electron/main.ts` (96 lines)
- `project/frontend/electron/shared.ts` (38 lines)
- `project/frontend/electron/services/config.ts` (76 lines)
- `project/frontend/electron/services/pty.ts` (208 lines)
- `project/frontend/electron/services/watcher.ts` (72 lines)
- `project/frontend/electron/ipc/agents.ts` (161 lines)
- `project/frontend/electron/ipc/tasks.ts` (220 lines)
- `project/frontend/electron/ipc/inbox.ts`
- `project/frontend/electron/ipc/plan.ts` (127 lines)
- `project/frontend/electron/ipc/cost.ts`
- `project/frontend/electron/ipc/logs.ts`

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- All exported interfaces typed explicitly (`PtySession`, `BackendKind`, `AgentEntry`, `BackendBlock`, etc.)
- No `any` usage observed in reviewed files.

### React patterns
- N/A — these are Electron main-process files (Node.js), not React components.

### Async & state
- `ensurePty()` uses a `spawnLocks` Map to prevent concurrent double-spawn for the same agent ✅
- `startIdleGc()` cleans up via `ptySessions.delete()` and fires `agent-killed` event ✅
- `spawnAndPing()` waits `CLI_WARMUP_MS` (5 s) before injecting "check inbox" only when freshly spawned ✅
- Inbox watcher debounce (300 ms) via `debounceTimers` Map with `clearTimeout` ✅
- `fsSync.watch()` watcher never closed on quit — acceptable; process-exit is the cleanup here.

### Accessibility
- N/A.

### Security
- API keys decrypted via `safeStorage.decryptString` and injected as env vars in child process — never persisted in plaintext ✅
- `decryptKey()` returns `''` on failure instead of throwing ✅

### Build & bundle
- `node-pty` loaded via `createRequire(import.meta.url)` — stays external, not bundled ✅
- `main.ts` is 96 lines (≤ 250 limit) ✅
- All files are below 250 lines; `pty.ts` at 208 lines is within bounds ✅

### Quality
- This is a move-only refactor; no functional logic added or removed ✅
- One minor inconsistency: `ipc/agents.ts` `get-agents-config` handler reads `agents-config.json` directly via `fs.readFile` rather than using the `readConfig()` helper from `services/config.ts`. Both paths read the same file; the handler returns raw JSON (including non-standard keys if any) while `readConfig()` returns a typed subset. Not a bug, but could be unified later.
- `plan.ts` calls `execFile('tmux', ...)` — macOS/Linux-only, silently no-ops on Windows (err branch returns early) ✅

## Action items (changes-requested)
None (minor inconsistency noted above is non-blocking).
