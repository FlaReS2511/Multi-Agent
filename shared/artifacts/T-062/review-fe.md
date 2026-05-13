# FE Review T-062 — inbox filter by FROM (T-049)

**Date:** 2026-05-08 22:40
**Verdict:** approved

## Files reviewed
- `project/frontend/src/components/InboxPanel.tsx` (commit 8594cc7)

## Findings

### Type safety (tsc result)
- `tsc --noEmit` → **0 errors** ✅
- `npm run build` → **exit 0** ✅
- `fromFilter: string` / `fromOptions: string[]` — straightforward string types, no issues ✅

### React patterns
- `fromOptions` memoized from `messages` — no unnecessary recomputation ✅
- `visibleMessages` memoized from `messages` + `fromFilter` ✅
- Auto-reset via `useEffect([fromOptions, fromFilter])`: when agent tab switches, `selected` changes → content reloads → `messages` changes → `fromOptions` changes → effect fires → `fromFilter` resets to `'All'`. Correct causal chain ✅
- Effect returns `undefined` — no cleanup needed (just a state set) ✅
- `fromOptions` uses `Set` + `Array.from(...).sort()` — deduped and alphabetically sorted ✅
- `if (m.from)` guard in `fromOptions` derivation — safe against messages with missing `from` field ✅

### Async & state
- Filter is purely derived client-side from already-fetched `content` — no new IPC calls ✅
- `refreshKey` + `selected` continue to drive content refresh as before ✅

### Accessibility
- Filter chips use `<button>` elements ✅
- Active chip has `bg-zinc-100 text-zinc-900` — high contrast, visually distinct ✅
- Agent-colored `fromFilter` chips: color used as enhancement, not sole identifier (label text always present) ✅
- "From" label prefix (`<span>`) provides context for the chip group; could benefit from `aria-label` on the chip container for screen readers, but non-blocking ✅

### Security
- `fromFilter` is derived from parsed inbox `m.from` values — internal data, not user-typed input ✅
- Count badge `{visibleMessages.length}/{messages.length}` renders numbers only ✅

### Build & bundle
- No new dependencies ✅
- Change is additive — existing `messages` render path now uses `visibleMessages` ✅

### Quality
- Hidden in raw view: `!showRawAll && fromOptions.length > 0` guard ✅ — chips invisible when viewing raw markdown
- Count badge appears only when filter is active (`fromFilter !== 'All'`) ✅
- Empty state distinguishes "Inbox trống." (no messages at all) from "Không có message từ {X}." (filtered out) ✅
- `key={m.id}` on `InboxMessageCard` — pre-existing stable key, not changed ✅

## Action items (changes-requested)
None.
