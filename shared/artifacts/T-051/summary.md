# T-051 Summary — README merge

**Status:** done

## What was done

- Merged `README.draft.md` (English) into `README.md` in backup repo `C:\Users\ADMINA1\Downloads\hi\multi-agent\Multi-Agent`.
- Added missing sections to satisfy completion criteria:
  - **Message protocol** — inline inbox block format + `tasks.json` schema with HTN fields.
  - **Troubleshooting** — agent spawn failures, safeStorage key issues, idle GC tuning, clone script permissions.
  - **Tests** — `cd scripts && pytest` instruction with scope note.
- All existing draft sections retained (Overview, Architecture, Quick start, Design decisions, Backends, HTN, Per-domain reviewers, Cost logging, Dynamic scaling, Task workspace, Lazy spawn/GC, Roadmap, Stack, Status).
- `README.draft.md` deleted (was untracked, removed from disk).
- Commit: `docs: merge README.draft into README, EN` — hash `b69cb25`.

## Files changed

- `README.md` — full rewrite from draft + added sections
- `README.draft.md` — deleted

## Post-review fixes (fe-reviewer rejection)

Three issues fixed in a follow-up commit (`45bf52a`):

1. **(blocking)** Removed broken `[examples/](./examples)` link — folder does not exist; replaced with plain text.
2. **(non-blocking)** Fixed agent count: "6-agent" → "8-agent" (planner + orchestrator + 3 engineers + 3 reviewers) in opening description.
3. **(non-blocking)** Fixed idle GC constant reference: `IDLE_GC_MS` in `electron/main.ts` → `IDLE_KILL_MS` in `electron/services/pty.ts` (correct after T-042 refactor).

Commit: `docs: fix README link + agent count + idle constant ref` — hash `45bf52a`.
