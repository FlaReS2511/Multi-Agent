# FE Review T-064 — re-review T-051 README post-fix

**Date:** 2026-05-08 22:48
**Verdict:** approved

## Files reviewed
- `README.md` (commit 45bf52a)

## Findings

### Issue 1 — broken `examples/` link
- `[examples/](./examples)` removed from line 50. Sentence now reads "the resulting code lands in `project/`." Clean removal, no dangling reference ✅

### Issue 2 — stale agent count
- Line 3: "A 6-agent" → "An 8-agent", and "Reviewer" → "three per-domain Reviewers". Now consistent with the per-domain reviewers section and the architecture diagram ✅

### Issue 3 — wrong constant / file in Troubleshooting
- Line 164: `IDLE_GC_MS in electron/main.ts` → `IDLE_KILL_MS in electron/services/pty.ts`. Matches the actual constant name and file location ✅

### Overall README state
- All required sections still present after the patch ✅
- No new broken links introduced ✅
- English consistent throughout ✅

## Action items (changes-requested)
None. All 3 issues from T-063 resolved.
