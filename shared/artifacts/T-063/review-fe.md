# FE Review T-063 — merge README.draft.md into README.md (T-051)

**Date:** 2026-05-08 22:45
**Verdict:** changes-requested

## Files reviewed
- `README.md` (commit b69cb25, HEAD state)
- `README.draft.md` — verified absent from disk and not in git tree (`git show HEAD:README.draft.md` → path does not exist) ✅

## Findings

### README.draft.md deleted
- `README.draft.md` does not exist on disk and is not committed in HEAD ✅
- Note: commit `b69cb25` only shows `README.md` modified; `README.draft.md` was absent before this commit (never committed to backup repo). Functionally correct — only one README exists.

### Language
- English throughout ✅
- Prose is clear and well-structured ✅
- Minor: one section uses "Không có message từ X" as a Vietnamese UI string reference — that is a code-level UI string, not a README prose issue; acceptable.

### Sections checklist
- Overview: ✅ (intro + "Why I built this" + "How it works")
- Architecture diagram (ASCII): ✅ (lines 22–32)
- Quick start: ✅ ("Run it" section covers both Electron `npm run dev` and `./scripts/launch-tmux.sh`)
- Agent roles + clone policy: ✅ (diagram, dynamic scaling section lines 131–135, singleton caveat)
- Message protocol (inbox format + tasks.json schema + HTN): ✅ (lines 62–119)
- Troubleshooting: ✅ (lines 147–168, covers spawn failures, warm-up, safeStorage, idle GC, chmod)
- Tests (`cd scripts && pytest`): ✅ (lines 199–203)

### Optional new-feature references
- Cost dashboard: ✅ mentioned (lines 128–129)
- Status pill / inbox filter / destroy confirm: not mentioned — optional per checklist, acceptable.

### Broken markdown links / code fences ← issues found

**Issue 1 (blocking): `[examples/](./examples)` — directory does not exist.**
Line 50: `See [examples/](./examples) for past runs.`
`ls ./examples` → MISSING. This link will 404 on GitHub. Either create the `examples/` directory with a placeholder, or change the text to remove the dead link (e.g., `_(examples coming soon)_`).

**Issue 2 (non-blocking): Intro agent count is stale.**
Line 3: "A 6-agent orchestration system" lists "Planner, Orchestrator, Backend, Frontend, AI Engineer, and Reviewer". Since T-eeca4f1 the system has 8 agents (3 workers + 3 per-domain reviewers + orchestrator + planner). The body correctly describes this (per-domain reviewers section, lines 121–123), but the lede contradicts it. Suggest "8-agent" or just drop the count.

**Issue 3 (non-blocking): Wrong constant name and file in Troubleshooting.**
Line 164: "edit `IDLE_GC_MS` in `electron/main.ts`."
The actual constant is `IDLE_KILL_MS` in `electron/services/pty.ts` (line 17). Both the name and the file path are wrong. Should read: "edit `IDLE_KILL_MS` in `electron/services/pty.ts`."

**Code fences:** all opened and closed correctly ✅
**`[CLAUDE.md](./CLAUDE.md)` link:** file exists ✅
**`./scripts/launch-tmux.sh` reference:** script exists ✅

## Action items (changes-requested)

1. `README.md:50` — Remove or fix the `[examples/](./examples)` link. The `examples/` directory does not exist. Options: create `examples/README.md` placeholder, or replace with `_(examples coming soon)_`.
2. `README.md:3` — Update "A 6-agent" to "An 8-agent" (or drop the count) to match the actual 8-agent topology now that per-domain reviewers replaced the single Reviewer.
3. `README.md:164` — Correct constant reference: `IDLE_GC_MS` → `IDLE_KILL_MS`, `electron/main.ts` → `electron/services/pty.ts`.
