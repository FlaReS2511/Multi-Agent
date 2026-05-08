# T-031 Artifact

## Files modified
- `features/livestream/application/comment_reader.py`
- `features/livestream/application/comment_switch_service.py`

## Changes

### 1. CommentReader — TikTok branch
- `__init__(self, tiktok_client=None)` — optional inject
- `set_tiktok_client(client)` — setter for late injection
- `_read_from_tiktok()` — drains TikTokClient queue; graceful when client is None
- `read_comments(source_type="tiktok")` — routes to `_read_from_tiktok()`

### 2. run_multi_source_switch
- New method iterates `cfg.enabled_sources`, calls `run_comment_switch` per source independently
- Returns `list[dict]` (one result per source)

### 3. Hardcode source bug fix
- Lines ~216/219 in `run_comment_switch`: `source="api"` → `source=read_result.source`
- OCR-only runs now log `source="ocr_*"`, TikTok logs `source="tiktok"`, API logs `source="api"`
