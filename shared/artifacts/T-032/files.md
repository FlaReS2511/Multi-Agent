# T-032 Artifact

## Files created/modified
- `features/livestream/application/dedupe_shared.py` (new)
- `features/livestream/application/comment_switch_service.py` (modified)

## Changes

### dedupe_shared.py — CommentDedupeService
Plain-string deduper extracted from OCRDedupeService logic (same rolling time-window approach, no OCRComment dependency).
- `is_duplicate(text: str) -> bool` — returns True if same text seen within `window_seconds`
- `filter(comments: list[str]) -> list[str]` — convenience batch filter
- `reset()` — clear seen cache (for testing/session reset)
- Default window: 30 seconds

### comment_switch_service.py
- Added import for `CommentDedupeService`
- `__init__`: 3 isolated instances `_dedupe = {"api": ..., "ocr": ..., "tiktok": ...}`
- `run_comment_switch`: after read, filters comments through `_dedupe[source]` before resolve. Uses `read_result.source.split("_")[0]` to map `ocr_file`/`ocr_ui_text` → `ocr` bucket. Falls back to no dedupe if source not in map.

## Verified
- Cross-source isolation: same text passes independently through api and tiktok instances
- Duplicate in same source within window is suppressed
- filter() correctness on list with duplicates
