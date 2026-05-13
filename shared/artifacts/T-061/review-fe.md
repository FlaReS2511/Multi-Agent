# FE Review T-061 — cost dashboard day/week/month totals + per-backend chart (T-048)

**Date:** 2026-05-08 22:40
**Verdict:** approved

## Files reviewed
- `project/frontend/electron/ipc/cost.ts` (commit 1ee3a11)
- `project/frontend/src/components/CostDashboardModal.tsx`
- `project/frontend/src/lib/api.ts`

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- `npm run build` → **exit 0** ✅ (tsc-b + vite build both pass)
- `CostSummary` interface extended with `week`, `month`, `by_backend` ✅
- `BACKEND_COLORS: Record<string, string>` exported from `api.ts` — fallback `?? '#a1a1aa'` in component for unknown keys ✅

### React patterns
- `Totals` and `ByBackend` are pure sub-components with no side effects ✅
- No new hooks, no useEffect needed for derived chart data ✅
- Inline SVG segments computed from props directly — correct, no state needed ✅

### Async & state
- Rolling window logic in `cost.ts`: `weekStart = today - 6` (7 days inclusive), `monthStart = today - 29` (30 days inclusive) ✅
- Date range filter uses lexicographic string comparison on `YYYY-MM-DD` format — valid for ISO date strings ✅
- `by_agent` / `by_task` remain today-only (matching existing widget semantics) ✅
- `by_backend` rolls up full 30-day window — consistent with chart title "last 30d" ✅
- `emptyBucket()` / `addToBucket()` helpers eliminate duplicate mutation patterns ✅

### Accessibility
- SVG pie segments include `<title>` tooltip: `"backend: $X.XXXX"` — screen readers and hover tooltips ✅
- Legend uses `<ul>/<li>` list structure ✅
- Color is not the only differentiator: backend name label + percentage shown in legend ✅

### Security
- No user input rendered as HTML ✅
- Model names from log files are internal strings; `modelToBackend` returns one of 5 fixed strings regardless of input ✅

### Build & bundle
- `npm run build` passes ✅
- No new npm dependencies — pie chart is pure SVG math ✅
- Pre-existing bundle size warning (812 kB > 500 kB) is not introduced by this change ✅

### Quality
- `modelToBackend` covers all expected prefixes: `claude`, `gpt`/`o\d`/`codex` → `codex`, `gemini`, `local`/`/`/`lmstudio` → `lmstudio`, catch-all `api` ✅
- Full-circle edge case (`frac >= 1`) uses the standard double-arc workaround — SVG `A` cannot draw from a point to itself ✅
- Empty state guard: returns early with a placeholder when `rows.length === 0 || total <= 0` ✅
- Minor non-blocking: floating-point accumulation means the last pie segment's end angle may differ very slightly from exactly `2π`, leaving a sub-pixel seam. Cosmetic only; no data correctness impact.

## Action items (changes-requested)
None.
