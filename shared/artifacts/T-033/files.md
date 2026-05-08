# T-033 Artifact: TikTok Section + Multi-source Checkbox Group

## Files Changed

### Modified
- `features/livestream/ui/components/comment_setup_tab.py`
  - Added **Comment Sources** LabelFrame: checkboxes for `api` (default ON), `ocr`, `tiktok`
    - `get_active_sources() -> list[str]`
    - `set_active_sources(sources: list[str])`
  - Added **TikTok Live** LabelFrame:
    - `tiktok_unique_id_var: tk.StringVar` — username input
    - `tiktok_auto_reconnect_var: tk.BooleanVar` — default True
    - Connect / Disconnect buttons (wired via `on_tiktok_connect` / `on_tiktok_disconnect` callbacks)
    - Status label — updated via `set_tiktok_status(status: str)`
  - New `__init__` params: `on_tiktok_connect=None`, `on_tiktok_disconnect=None`

- `features/livestream/ui/components/action_tabs.py`
  - Added `on_tiktok_connect=None`, `on_tiktok_disconnect=None` params to `ActionTabs.__init__`
  - Passed through to `CommentSetupTab`

## Notes
- T-035 will wire `on_tiktok_connect`/`on_tiktok_disconnect` to `TikTokClient` in `main_window.py`
- `get_active_sources()` intended for use in comment processing pipeline to decide which sources to poll
