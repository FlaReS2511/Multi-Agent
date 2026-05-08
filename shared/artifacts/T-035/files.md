# T-035 Artifact: Wire TikTokClient lifecycle in main_window.py

## Files Changed

### Modified
- `features/livestream/ui/main_window.py`

## Changes

1. **Import** `TikTokClient` from `features.livestream.infrastructure.tiktok_client`

2. **`__init__`**:
   - `self.tiktok_client = TikTokClient()` — created before `_build_ui`
   - After `_build_ui`: registers `on_status_change(self._on_tiktok_status)` and injects into `comment_switch_service.reader.set_tiktok_client(tiktok_client)`
   - `root.protocol("WM_DELETE_WINDOW", self._on_closing)` — clean shutdown

3. **`_build_ui`**: passed `on_tiktok_connect=self._tiktok_connect`, `on_tiktok_disconnect=self._tiktok_disconnect` to `ActionTabs`

4. **`_load_brand_to_ui`**: calls `tiktok_client.disconnect()` at start (brand switch), then calls `_tiktok_load_brand(cfg)` at end

5. **New methods**:
   - `_on_tiktok_status(status)` — thread-safe UI update via `root.after(0, ...)`
   - `_tiktok_connect()` — reads unique_id + auto_reconnect from UI, calls `tiktok_client.connect()`
   - `_tiktok_disconnect()` — calls `tiktok_client.disconnect()`
   - `_tiktok_load_brand(cfg)` — sets unique_id/auto_reconnect vars, autostarts if `cfg.tiktok_autostart`
   - `_on_closing()` — disconnects TikTok before `root.destroy()`

## Checklist
- [x] TikTokClient init and cleanup correct lifecycle
- [x] Connect/Disconnect from UI wired end-to-end
- [x] Autostart on brand load when `tiktok_autostart=True`
- [x] Brand-switch disconnects old, reconnects for new brand
- [x] CommentReader injected with tiktok_client
- [x] App close calls disconnect (no thread leak)
- [x] Syntax valid (ast.parse)
