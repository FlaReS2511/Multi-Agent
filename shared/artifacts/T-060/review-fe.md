# FE Review T-060 — floating Approve button in Plan Composer (T-047)

**Date:** 2026-05-08 22:10
**Verdict:** approved

## Files reviewed
- `project/frontend/src/components/PlanComposer.tsx` (commit 044c634, +25 lines / -3 lines)

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- No new types introduced; `showFloat: boolean` inferred correctly ✅

### React patterns
- `handleScroll` wrapped in `useCallback([])` — deps empty is correct since it only closes over `scrollRef` (stable ref object) and `setShowFloat` (stable dispatch) ✅
- `scrollRef` attached to the `overflow-y-auto` div; `onScroll` wired directly — no polling, event-driven ✅
- `showFloat` resets naturally when the user scrolls back up (handler fires on every scroll event) ✅
- No effect needed for scroll — direct event handler is the right pattern here ✅

### Async & state
- Floating button calls `approve` from `usePlanApprove` — same action as the header button, no duplication of logic ✅
- Button guarded by `showFloat && canApprove`: only visible when scrolled past threshold AND action is valid ✅
- `canApprove` from hook already accounts for empty title/body and in-progress status ✅

### Accessibility
- `<button>` element with visible text "Approve & Send →" ✅
- `↑` decorative icon without `aria-hidden` — screen reader reads "↑ Approve & Send →". The arrow character is announced as "up arrow", slightly redundant but not harmful. Minor non-blocking.
- Button is in natural tab order when visible; keyboard users can reach it ✅
- No `disabled` attribute — button is conditionally rendered (not shown) rather than disabled. Acceptable pattern.

### Security
- No user input rendered as HTML ✅
- `approve` calls `window.api.approvePlan` with the existing title/body — no new data paths ✅

### Build & bundle
- No new dependencies (`useCallback` already imported) ✅
- `FLOAT_THRESHOLD = 200` as a named constant — readable and easy to tune ✅

### Quality
- `relative` added to outer container to anchor the `absolute` positioned button ✅
- `bottom-16` (64px) clears the footer (≈52px) — no overlap ✅
- `pointer-events-auto` on wrapper div is defensive but harmless ✅
- PlanComposer.tsx line count: was 257 (post T-044 refactor), now 282 — still under 300 limit ✅

## Action items (changes-requested)
None.
