# T-048 — Cost dashboard: day/week/month totals + per-backend chart

**Repo:** `C:\Users\ADMINA1\Downloads\hi\multi-agent\Multi-Agent` (BACKUP)
**Commit:** `feat(ui): cost dashboard totals + per-backend chart` (1ee3a11)

## Files changed
- `project/frontend/electron/ipc/cost.ts`
- `project/frontend/src/components/CostDashboardModal.tsx`
- `project/frontend/src/lib/api.ts`

## What changed
1. **IPC `get-cost-summary`** now also returns `week` (rolling 7d) and `month` (rolling 30d) buckets in addition to `today`, plus a `by_backend` aggregation rolled up over the last 30 days. Regex now captures `model=` so cost lines can be bucketed.
2. **Backend bucketing** is derived from the model prefix: `claude-*` → claude, `gpt-*`/`o\d`/`codex` → codex, `gemini-*` → gemini, anything containing `/` or `local`/`lmstudio` → lmstudio, else `api`. CLI-backed agents (claude-cli/codex-cli/gemini-cli) don't log usage so they don't appear — same as existing semantics.
3. **Dashboard UI** gains:
   - A "Totals (rolling)" section with three number cards (Day / Week / Month).
   - A "By backend (last 30d)" pie chart (inline SVG, no new deps) with a 2-column legend showing `$amount (xx.x%)` per backend. Colors come from a new `BACKEND_COLORS` map exported from `lib/api.ts`.

## Definition-of-done
- [x] 3 totals (day/week/month) computed correctly from timestamp filter (string compare on YYYY-MM-DD).
- [x] Pie chart renders with legend and per-segment hover tooltip.
- [x] No major dep bumps — chart is hand-rolled inline SVG.
- [x] `npm run build` passes (tsc -b && vite build, 50 modules).
- [x] Single commit titled `feat(ui): cost dashboard totals + per-backend chart`.

## Smoke test plan
With cost.log entries spanning multiple models, confirm the pie segments split by `claude` / `codex` / `gemini` / `lmstudio` proportionally and the day/week/month totals strictly increase from left to right.
