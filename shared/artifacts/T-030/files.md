# T-030 Artifact

## Files created
- `features/livestream/infrastructure/__init__.py` (new, empty)
- `features/livestream/infrastructure/tiktok_client.py` (new)

## Summary
`TikTokClient` ports `TikTokCommentManager` with all Tk coupling removed:
- Comment buffer: `queue.Queue` (thread-safe, no lock needed)
- Asyncio loop in daemon thread via `_run_loop()`
- All 6 public methods: `connect`, `disconnect`, `pop_comments`, `is_connected`, `set_auto_reconnect`, `on_status_change`
- `disconnect()` calls `asyncio.run_coroutine_threadsafe(...).result(timeout=5)` then joins thread with timeout=10s
- Auto-reconnect: exponential backoff (1→2→4→…≤10s), interruptible sleep checks `_stop_event` every 0.25s
- `set_auto_reconnect(False)` sets `_stop_event` immediately to abort any in-progress sleep

## Checks
- No tkinter import
- No root.after
- Syntax valid (ast.parse)
- All 6 public methods confirmed
- __init__.py present
