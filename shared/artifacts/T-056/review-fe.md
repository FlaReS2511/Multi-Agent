# FE Review T-056 — extract hooks PlanComposer/App

**Date:** 2026-05-08 22:00
**Verdict:** approved

## Files reviewed
- `project/frontend/src/hooks/usePlanDraft.ts`
- `project/frontend/src/hooks/usePlanApprove.ts`
- `project/frontend/src/hooks/useTabs.ts`

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- `Status` is a proper discriminated union (6 variants with `kind` literal field) ✅
- `PlanDraftReturn` and `PlanApproveReturn` interfaces fully typed ✅
- No `any`, no unsafe casts ✅

### React patterns
- `usePlanDraft` poll: `setInterval` + `clearInterval(id)` in effect cleanup ✅
- `cancelled` flag guards against setting state after unmount ✅
- `useEffect` deps: `[titleDirty, bodyDirty, setStatus]` — correct; `setStatus` from `useState` is stable ✅
- Note: the effect restarts on every `titleDirty`/`bodyDirty` toggle (i.e., each first keystroke in title/body). This clears and reinstates the 2 s interval — slightly wasteful but harmless and not an infinite loop.
- `usePlanApprove` has no effects → no cleanup needed ✅
- `useTabs` is pure state, no effects ✅

### Async & state
- `sendPrompt`, `sendAnswers`, `approve` all set appropriate `status` before await and on error ✅
- Error messages surface via `{ kind: 'error', message }` variant ✅
- `localStorage.removeItem` in `approve` and `reset` wrapped in try/catch ✅
- `lastSeenMtimeRef` passed in as a ref; mutations in `usePlanApprove` side-step re-render correctly ✅

### Accessibility
- N/A — hooks contain no JSX.

### Security
- No `dangerouslySetInnerHTML`, no user-controlled URLs, no secrets ✅

### Build & bundle
- No new dependencies introduced ✅

### Quality
- Circular dep avoided by keeping `status`/`setStatus` in the component and threading downward — this is the correct pattern given that both hooks need to write status ✅
- `parseOpenQuestions` staying in PlanComposer is correct (pure render logic, not IPC-related) ✅
- `PlanComposer.tsx` reduced from 425 → 257 lines; `App.tsx` 247 → 240 lines ✅

## Action items (changes-requested)
None.
