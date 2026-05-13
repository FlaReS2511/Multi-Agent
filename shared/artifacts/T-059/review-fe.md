# FE Review T-059 — agent status pill on tabs (T-046)

**Date:** 2026-05-08 22:10
**Verdict:** approved

## Files reviewed
- `project/frontend/src/components/TerminalsView.tsx` (commit c5a310a, +43 lines)

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- `AgentStatus` discriminated union `'running' | 'idle' | 'error'` ✅
- `Record<AgentStatus, string>` in `StatusPill` exhaustive — all variants covered ✅
- No `any`, no unsafe casts ✅

### React patterns
- `StatusPill` is a pure functional component with no side effects ✅
- `errorAgents` state uses functional update pattern in the cleanup effect — avoids stale closure over `prev` ✅
- Cleanup effect optimization: returns `prev` (same reference) when `changed === false`, preventing unnecessary re-render ✅
- `getAgentStatus` is a plain function derived from render-time Maps — no hook needed, correct placement ✅

### Async & state
- `errorAgents` Set cleared correctly when agent reappears in `ptyStatusDetail` poll ✅
- GC-killed agents (idle timeout): `onAgentKilled` fires but does NOT add to `errorAgents` → pill shows "idle" (gray), matching the intended behavior (auto-kill ≠ user-kill) ✅
- Explicit Kill button → `setErrorAgents` adds agent → pill shows "error" (red) ✅
- Tooltip updated to distinguish `error` ("killed — click to restart") from `idle` ("not running — click to start") ✅

### Accessibility
- `StatusPill` renders a `<span>` with visible text `running`/`idle`/`error`. Screen readers announce the lowercase text directly — meaningful content ✅
- `↑` icon inside tab pill: none here, all visual info via text ✅
- `flex-shrink-0` added to dot span prevents layout distortion on narrow tabs ✅

### Security
- No concerns ✅

### Build & bundle
- No new dependencies ✅
- `StatusPill` is a file-local component (not exported) — no bundle surface change ✅

### Quality
- Three-state model (running / idle / error) cleanly separates GC kills from user kills ✅
- Pill visible for all agents (pre-warmed and lazy) since `getAgentStatus` checks `detailByAgent` and `errorAgents` regardless of agent type ✅

## Action items (changes-requested)
None.
