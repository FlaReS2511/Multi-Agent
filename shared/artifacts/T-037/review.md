# Review T-037 — manager-livestream: TikTok + multi-source + keyword log

**Reviewer:** reviewer-agent
**Date:** 2026-05-05 14:11
**Verdict:** changes-requested

---

## Files reviewed

- `features/livestream/config.py`
- `features/livestream/infrastructure/tiktok_client.py`
- `features/livestream/infrastructure/__init__.py`
- `features/livestream/application/comment_reader.py`
- `features/livestream/application/comment_switch_service.py`
- `features/livestream/application/dedupe_shared.py`
- `features/livestream/ui/components/comment_setup_tab.py`
- `features/livestream/ui/components/keyword_log_tab.py`
- `features/livestream/ui/components/action_tabs.py`
- `features/livestream/ui/main_window.py`
- `requirements.txt`

---

## Findings

### Spec compliance

- [x] A1 — `TikTokClient.connect()` → thread + asyncio loop → `ConnectEvent` → `_STATUS_CONNECTED`. Status callback marshaled to UI via `root.after(0, ...)`. **OK**
- [x] A2 — TikTok comments go through `CommentReader._read_from_tiktok()` → `CommentSwitchService.run_comment_switch()` → mapper → `_log_match_decision(source="tiktok", status="matched")`. **OK**
- [x] A3 — No-match path: `_log_match_decision(source=..., status="no_match")`. **OK**
- [x] A4 — `disconnect()` sets `_stop_event`, calls `asyncio.run_coroutine_threadsafe(client.disconnect())`, then `thread.join(timeout=10)`. Thread is daemon so no leak if join times out. **OK** (see minor issue below)
- [x] A5 — `KeywordLogTab` auto-refresh every 2s (`_AUTO_REFRESH_MS = 2000`) only when tab visible. Brand switch calls `on_brand_changed()`. **OK**
- [x] A6 — Filter by source/status via Combobox + `_apply_filters()`. **OK**
- [✗] **A7 — Multi-source: WIRING GAP (see Bugs section)**
- [x] A8 — Auto-reconnect: `_connect_with_reconnect()` loops with exponential backoff (1s→2s→…→10s). `set_auto_reconnect(False)` sets `_stop_event`. **OK**
- [x] A9 — Brand config persisted to `envs/<brand_id>.env` via `save_brand_config()`. Config restored on restart via `load_brand_config()`. **OK**
- [x] A10 — OCR-only logs `source="ocr"` via `_log_match_decision`. **OK**
- [x] A11 — `pip install -r requirements.txt` clean. `TikTokLive==6.6.5` already installed. All deps satisfied. **PASS**
- [~] A12 — Smoke test not run (no live TikTok stream available); static + syntax analysis pass for all files. `python3 -m py_compile` **ALL OK**

---

### Bugs / Logic

#### [CRITICAL] A7 Multi-source not wired end-to-end — `main_window.py:661`

`_get_comment_worker()` calls `run_comment_switch(source_type=self.action_tabs.comment.source_var.get())` — a **single-source** combobox with values `["api", "ocr"]` (TikTok not even in the list). The multi-source checkbox group in `CommentSetupTab` (`get_active_sources()`) and the `run_multi_source_switch()` method are both implemented but **never connected**.

The fix requires `_get_comment_worker` to read `self.action_tabs.comment_setup.get_active_sources()`, build a merged `AppConfig.enabled_sources`, then call `run_multi_source_switch(...)` instead of `run_comment_switch(...)`. Until this is wired, A7 cannot pass.

**File:** `features/livestream/ui/main_window.py:657–677`

#### [MINOR] `disconnect()` blocks UI thread on close — `tiktok_client.py:69–86`

`disconnect()` calls `asyncio.run_coroutine_threadsafe(...).result(timeout=5)` then `thread.join(timeout=10)` — total up to 15 seconds blocking the caller. `_on_closing()` calls this from the UI thread (main_window.py:651), causing the window to freeze for up to 15 seconds on close.

Suggest: call `tiktok_client.disconnect()` in a background thread in `_on_closing`, or use `.result(timeout=2)` + best-effort approach since the thread is daemonized.

#### [MINOR] Race on `_loop`/`_client` attributes — `tiktok_client.py:71`

`disconnect()` reads `self._loop` and `self._client` without a lock. If `disconnect()` is called right after `connect()` before `_run_loop()` sets `self._loop`, the coroutine dispatch is skipped silently. The `_stop_event.set()` still terminates the loop, so the behavior is correct but not guaranteed to close cleanly every time. A `threading.Lock` guarding `_loop`/`_client` assignment would harden this.

#### [MINOR] UI default mismatch — `comment_setup_tab.py:152`

`tiktok_auto_reconnect_var` initializes to `True` in the widget constructor, but `AppConfig.tiktok_auto_reconnect` defaults to `False`. On first launch (no saved config), the checkbox appears checked before `_tiktok_load_brand(cfg)` corrects it. This is a cosmetic race but could confuse users if they immediately click Connect before brand loads.

Fix: change `tk.BooleanVar(value=True)` → `tk.BooleanVar(value=False)` at `comment_setup_tab.py:152`.

---

### Tests

- **pytest:** No test files found anywhere in the project for any of the new files.
- **Unit coverage gap:** `CommentDedupeService`, `TikTokClient`, `CommentReader._read_from_tiktok`, `_log_match_decision`, and `KeywordLogTab.refresh()` all have zero test coverage.
- For A4 thread-leak check: no mock test provided. `TikTokClient` is designed to be testable (injectable client), but no test harness exists.

---

### Security

- [x] `_safe_brand_id()` correctly sanitizes to alphanumeric + `-_`, preventing path traversal when constructing `.env` file paths.
- [x] `subprocess.Popen(["open", path])` uses list form (not `shell=True`) — safe against command injection.
- [x] No hardcoded secrets.
- [x] TikTok unique_id is stripped and normalized before use.
- [x] Log entries cap at 200 via `append_json_log(max_entries=200)` — no unbounded growth.
- [~] Credentials (`ACCESS_TOKEN`, `PARTNER_KEY`) are stored in plaintext `.env` files — expected for this tool type, but no file-permission enforcement in code.

---

### Style / Maintainability

- Code is clean, well-organized, and consistent across files.
- `CommentSwitchService.__init__` uses `# type: ignore[attr-defined]` for `.passed()` method — suggests `get_logger` returns a non-standard logger type. Low risk, cosmetic.
- `dedupe_shared.py` is thread-unsafe (`_seen` dict), but in current usage only one thread calls `run_comment_switch` at a time (unless user clicks rapidly). Acceptable for now.

---

## Action items (changes-requested)

1. **[CRITICAL — A7]** Wire `CommentSetupTab.get_active_sources()` into `_get_comment_worker` in `main_window.py`. Replace single-source `run_comment_switch` call with `run_multi_source_switch` using `enabled_sources` from the UI checkbox group. **Owner: Backend/Frontend Engineer (main_window.py is UI-side orchestration)**
2. **[MINOR]** Fix `tiktok_auto_reconnect_var` default from `True` → `False` in `comment_setup_tab.py:152`.
3. **[NICE-TO-HAVE]** Wrap `tiktok_client.disconnect()` in background thread inside `_on_closing()` to avoid UI freeze on window close.
4. **[NICE-TO-HAVE]** Add at minimum a smoke unit test for `CommentDedupeService.filter()` and `TikTokClient.connect/disconnect` lifecycle with a mocked `TikTokLiveClient`.
