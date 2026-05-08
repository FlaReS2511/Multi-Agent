# T-029 Artifact

## Files changed
- `/Users/tom/Downloads/AIO-AILivestream/manager-livestream-app/manager-livestream/features/livestream/config.py`

## Summary
Added 4 new fields to `AppConfig`:
- `enabled_sources: list[str]` — parsed from `COMMENT_SOURCES` comma-list env (default `["api"]`)
- `tiktok_unique_id: str` — from `TIKTOK_UNIQUE_ID` (default `""`)
- `tiktok_auto_reconnect: bool` — from `TIKTOK_AUTO_RECONNECT` via `to_bool` (default `False`)
- `tiktok_autostart: bool` — from `TIKTOK_AUTOSTART` via `to_bool` (default `False`)

Migration loader: if `COMMENT_SOURCES` absent but `SOURCE_TYPE` present, converts to `enabled_sources=[SOURCE_TYPE]` with a warning log.
`to_env_string` updated to serialize all 4 new fields.

## Tests
7 inline assertions passed (defaults, multi-source parse, bool fields, legacy migration, COMMENT_SOURCES priority, existing fields, round-trip).
