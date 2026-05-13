# T-049 — Inbox filter by FROM

**Repo:** `C:\Users\ADMINA1\Downloads\hi\multi-agent\Multi-Agent` (BACKUP)
**Commit:** `feat(ui): inbox filter by FROM` (8594cc7)

## Files changed
- `project/frontend/src/components/InboxPanel.tsx`

## What changed
- Parses `FROM:` from each inbox message (already exposed by `parseInbox`), derives a unique-sorted list of senders, and renders a chip row above the message list.
- Chips: `All` + one per unique sender. Active chip is highlighted; inactive chips inherit the sender's `AGENT_COLORS` color.
- Click a chip → filter messages where `msg.from === chip`. `All` resets.
- Counter `M/N` shows how many of the total messages currently pass the filter when a non-All chip is active.
- The filter row is hidden when there are no messages, and when the user has toggled the raw-markdown view (raw view shows the full file verbatim).
- Effect resets `fromFilter` to `All` when the active filter value disappears (e.g., after switching the agent tab).

## Definition-of-done
- [x] Filter chips auto-populate from unique `FROM:` values in the inbox file.
- [x] Click filter → only matching messages render.
- [x] `All` resets to full list.
- [x] `npm run build` passes.
- [x] Single commit titled `feat(ui): inbox filter by FROM`.
