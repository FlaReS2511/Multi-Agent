# Phase 1 Migration Audit — T-027

## Summary
- OLD app: /Users/tom/Downloads/ai-live/ai-livestream
- NEW app: /Users/tom/Downloads/AIO-AILivestream/manager-livestream-app/manager-livestream
- Date: 2026-05-05
- Auditor: backend-engineer agent
- Files read: 48 OLD + 47 NEW = 95 total Python source files

---

## Architecture Overview

**OLD app** is a two-process desktop application:
- **Controller** (Tkinter UI + Flask API on port 5000): OBS connection, dual-slot queue, auto-switching tick loop
- **Player** (Tkinter UI + Flask API on port 5001): PDE (Player Decision Engine), OCR, TikTok comment reader, hybrid matching

**NEW app** is a single modular Tkinter application with feature-bounded packages:
- Entry: `app.py` → `LiveShopeeManagerUI`; optional system bootstrap via `system_main.py` → `ModuleRuntime`
- Feature: **livestream** (Shopee API, comment reader, comment→video switch service, OCR runner)
- Feature: **obs** (OBSService with internal runner thread, dual-slot A/B, priority + rotate + QA queues)

---

## Diff Table

| # | Item | File (old) | File (new) | Status | Notes |
|---|------|-----------|-----------|--------|-------|
| 1 | **Main entry point — Controller UI** | `controller/ui/main_controller.py → main()` | `app.py → main()` | ✅ migrated | OLD: `MainController` (Tkinter). NEW: `LiveShopeeManagerUI` (Tkinter). Both are Tk `mainloop()` entry points. |
| 2 | **Main entry point — Player UI** | `player.py → main()` → `PlayerUI` | `app.py → main()` (unified) | ⚠️ PARTIAL | OLD had separate Player UI process (port 5001). NEW merges both concerns into one UI. Player UI with PDE text box / OCR / TikTok is absent as a standalone window. |
| 3 | **System module bootstrap / orchestration** | (none) | `system_main.py → ModuleRuntime → LivestreamModule` | ✅ migrated | NEW adds a process-level module runtime not present in OLD. `LivestreamModule.start()` spawns `app.py` as subprocess. |
| 4 | **Module base abstraction** | (none) | `modules/base.py → ModuleBase` (ABC) | ✅ migrated | New pattern. No equivalent in OLD. |
| 5 | **Controller API server (Flask)** | `controller/api_server.py` (Flask, port 5000) | No dedicated Flask server in NEW | ❌ MISSING | OLD exposed: `/receive_video`, `/receive_videos`, `/control/stop_current`, `/control/pause_switching`, `/control/resume_switching`, `/send_videos`, `/shutdown`. None of these HTTP endpoints exist in NEW. |
| 6 | **Player API server (Flask)** | `player/api_server.py` (Flask, port 5001) | No Flask server in NEW | ❌ MISSING | OLD exposed: `/update_catalog`, `/catalog`, `/pde/pause`, `/pde/resume`, `/pde/status`, `/pde/config`, `/pde/set_threshold`, `/pde/set_cooldown`, `/pde/set_max_recommendations_per_minute`, `/performance`. Entire API layer absent in NEW. |
| 7 | **Dual-slot queue: QueueManager** | `controller/queue_manager.py → QueueManager` | `features/obs/application/service.py → OBSService` (internal `_import_queue`, `_play_queue`, `_qa_queue`) | ✅ migrated | OLD: explicit `requested` + `regular` queues with slot A/B state machine. NEW: rotate + QA + priority lists inside `OBSService`. Semantically equivalent but structurally different. NEW adds QA queue concept absent in OLD. |
| 8 | **Queue state persistence (JSON)** | `controller/queue_manager.py → _write_state_file()` → `queue_state.json` | `features/obs/infrastructure/video_catalog_repository.py → OBSVideoCatalogRepository.save()` → `brand/{id}/obs/catalog.json` | ✅ migrated | Both persist queue state to JSON on every change. NEW uses brand-scoped directory structure. |
| 9 | **Queue feeder (auto-rotate from catalog)** | `controller/queue_feeder.py → RegularQueueFeeder` | `OBSService._sync_ready_queue_locked()` + `_runner_loop()` | ✅ migrated | OLD: explicit `RegularQueueFeeder` class with listener-driven refill. NEW: integrated into `_runner_loop` polling loop with round-robin `_next_index`. |
| 10 | **Task scheduler (Tk `after`)** | `controller/task_scheduler.py → TaskScheduler` | No equivalent | ❌ MISSING | OLD: wraps `root.after()` for cross-thread scheduling to Tk main thread. NEW uses `threading.Thread` + `threading.RLock` directly — no Tk-based scheduler. |
| 11 | **OBS connection wrapper** | `controller/obs_connection.py → OBSConnection` (obsws_python) | `features/obs/infrastructure/client.py → OBSWebSocketClient` | ✅ migrated | Both wrap `obsws_python.ReqClient`. OLD: richer scene-item ID cache, `switch_to()`, `get_current_playback()`. NEW: cleaner thin wrapper; slot switching logic moved into `OBSService._runner_loop()`. |
| 12 | **OBS scene item ID cache** | `OBSConnection._scene_items` dict cache | Not present | ❌ MISSING | OLD cached `(scene_name, source_name)→sceneItemId` to avoid redundant OBS requests. NEW calls `_find_scene_item_id()` on every operation (no cache). |
| 13 | **OBS source order / z-index control** | Not present in OLD | `OBSWebSocketClient.set_source_order()` | ✅ migrated | NEW adds `set_scene_item_index` for z-order control. Not in OLD. |
| 14 | **OBS auto-switch tick loop** | `MainController.update_tick()` + `_schedule_tick()` (Tkinter `after`, 500ms) | `OBSService._runner_loop()` (daemon thread, 150ms) | ✅ migrated | OLD: Tk-based polling, switches on `remaining <= SWITCH_THRESHOLD`. NEW: daemon thread, uses `nearing_end` + crossfade pre-prepare + `should_switch_now`. NEW is more precise and adds crossfade concept. |
| 15 | **OBS visibility recovery check** | `MainController._verify_slot_visibility()` (scheduled 1s + 6s after switch) | Not present | ❌ MISSING | OLD had post-switch visibility checks to recover if source accidentally hidden. NEW has no recovery watchdog. |
| 16 | **OBS crossfade / preload next slot** | `MainController._handle_preload_request()` + `QueueManager.preload_next_into()` | `OBSService._prepare_slot()` + `_reprepare_standby_if_needed()` | ✅ migrated | Both implement prepare-before-switch. NEW adds `_reprepare_standby_if_needed()` to evict standby if priority changes — OLD had a TODO comment for this. |
| 17 | **OBS skip current video** | `MainController.remote_stop_current_video()` | `OBSService.skip_current()` | ✅ migrated | OLD: "kill switch" stops automation and pauses media. NEW: `skip_current()` sets `_skip_requested` flag consumed by runner thread. |
| 18 | **OBS config persistence** | `controller/config.py` (constants, no persistence) | `features/obs/infrastructure/repository.py → OBSConfigRepository` | ✅ migrated | NEW adds brand-scoped JSON persistence for OBS host/port/password/scene/source config. OLD stored these only in Tk variables. |
| 19 | **OBS log watcher (REQUEST_RELOAD)** | `controller/logger.py → _ObsLogWatcher` | Not present | ❌ MISSING | OLD watched OBS log files for `REQUEST_RELOAD:` marker and triggered reload. Completely absent in NEW. |
| 20 | **OBS domain models** | (none — dataclasses inline) | `features/obs/domain/models.py → OBSConfig` dataclass | ✅ migrated | NEW formalizes config as dataclass with `from_dict` / `to_dict`. |
| 21 | **PDE (Player Decision Engine)** | `player/backend/pde_engine.py → PlayerDecisionEngine` | Not present | ❌ MISSING | Core comment→video matching engine completely absent in NEW. No threshold, cooldown, rate limit, or `process_input()` flow. |
| 22 | **PDE pause/resume state** | `player/services/pde_service.py → is_paused() / set_paused()` (disk-based cross-process JSON) | Not present | ❌ MISSING | OLD synced pause state via JSON file between Flask and Tk processes. No equivalent in NEW. |
| 23 | **PDE runtime config (threshold, cooldown, max RPM)** | `player/services/pde_runtime_config.py` | Not present | ❌ MISSING | OLD persisted threshold (default 0.3), cooldown (300s), max_rpm to `pde_config.json`. No equivalent in NEW. |
| 24 | **Hybrid matching algorithm** | `player/matching/hybrid_selector.py → rank_matches()` | `features/livestream/application/comment_video_mapper.py → _score()` | ⚠️ PARTIAL | OLD: 2-phase hybrid (fuzzy prefilter top-20 → rule scoring → combine_confidences). NEW: simple token overlap + phrase bonus (no fuzzy library, no confidence threshold). Much simpler but sufficient for CSV-based matching. |
| 25 | **Fuzzy matcher** | `player/matching/fuzzy_matcher.py → evaluate_fuzzy_score()` | Not present | ❌ MISSING | OLD: token-level fuzzy with rapidfuzz fallback to difflib, 0.8 similarity threshold. Absent in NEW. |
| 26 | **Rule-based matcher** | `player/matching/rule_matcher.py → evaluate_rule_score()` | `CommentVideoMapper._score()` (inline) | ⚠️ PARTIAL | OLD: weighted name (×2) + description (×1) + phrase bonus (5), normalized confidence. NEW: equivalent inline function but no weighting normalization. |
| 27 | **Confidence combiner** | `player/matching/confidence.py → combine_confidences()` | Not present | ❌ MISSING | OLD combined rule + fuzzy scores with explicit formula. Absent in NEW. |
| 28 | **Text normalizer** | `player/matching/text_normalizer.py` | `CommentVideoMapper._normalize_for_match()` (inline) | ⚠️ PARTIAL | OLD: full pipeline with accent strip, unidecode, ASCII normalize, tokenize. NEW: unicodedata NFD accent strip + regex. NEW adds mojibake repair heuristic (latin1/cp1252→utf-8). |
| 29 | **Catalog repo (player-side)** | `player/matching/catalog_repo.py → parse_catalog_items()` | Not present (replaced by CSV mapping) | ❌ MISSING | OLD: parsed JSON catalog into `CatalogEntry` typed objects. NEW uses CSV `id,name,description` format driven by `CommentVideoMapper`. |
| 30 | **MatchResult / CatalogEntry types** | `player/matching/types.py` | Not present | ❌ MISSING | OLD: dataclasses `CatalogEntry`, `MatchResult`, `RuleScore`, `FuzzyScore`. NEW has no typed match results. |
| 31 | **Catalog management (controller-side)** | `controller/services/catalog_service.py` (JSON read/write, auto-browse folder, save catalog) | `features/obs/application/service.py → import_videos_from_folder()` + `features/obs/infrastructure/video_catalog_repository.py` | ✅ migrated | Both scan folder for videos, assign IDs, persist catalog. OLD: `video_catalog.json` flat. NEW: `brand/{id}/obs/catalog.json` with schema_version + id_counter + qa_videos. |
| 32 | **Catalog management (player-side)** | `player/services/catalog_service.py → get_catalog_path(), save_catalog(), load_catalog(), iter_videos()` | Not present (subsumed into OBS feature) | ⚠️ PARTIAL | OLD player had its own `player_catalog.json`. NEW does not have a separate player-side catalog service; OBS service owns catalog. |
| 33 | **Catalog validation against CSV** | `player/services/catalog_validation_service.py`, `player/services/catalog_validation_log_service.py` | Not present | ❌ MISSING | OLD validated catalog vs CSV using name similarity threshold (90%). Absent in NEW — NEW uses CSV as the mapping source directly without validation. |
| 34 | **QA video queue** | Not present | `OBSService._qa_queue` + `import_qa_videos_from_folder()` + QA priority override | ✅ migrated | NEW adds dedicated QA video pool. Not in OLD. |
| 35 | **Video cooldown per-ID** | OLD: `PDE.cooldowns` dict (in-memory, cleared on restart) | `OBSService._mark_played_locked()` → `blocked_until` timestamp persisted in JSON | ✅ migrated | NEW persists cooldown state across restarts. OLD's in-memory cooldown was lost on restart. |
| 36 | **Priority video enqueueing** | `QueueManager.enqueue_requested()` (move to requested queue head) | `OBSService.prioritize_video_by_id()` → `_priority_ids` list | ✅ migrated | Both implement priority queue. NEW also allows QA video prioritization. |
| 37 | **OCR comment pipeline — CV (Shopee)** | `player/backend/cv_comment.py → OCRManager + CVCommentProcessor` (EasyOCR + MSS + OpenCV) | `features/livestream/application/ocr/` (Tesseract via `pytesseract`, MSS capture) | ⚠️ PARTIAL | OLD: EasyOCR (en+vi), color/black mask segmentation, blue-username extraction. NEW: Tesseract (`vie` lang), capture→preprocess→read→parse pipeline (5 separate service classes). NEW is more modular but uses different OCR engine. |
| 38 | **OCR region selector UI** | `OCRManager.select_region()` (Tkinter fullscreen overlay, drag-to-select, saves to config.json) | `CommentSwitchService.set_ocr_region()` / `get_ocr_region()` (JSON file per brand) | ⚠️ PARTIAL | OLD: interactive Tkinter overlay for selection. NEW: region must be set programmatically or via UI tab (no visible drag-select implementation found in OCR runner). |
| 39 | **OCR deduplication** | `OCRManager.is_duplicate()` (time-window + rapidfuzz/difflib similarity) | `features/livestream/application/ocr/dedupe_service.py → OCRDedupeService.is_duplicate()` | ✅ migrated | Both implement time-window dedup. NEW adds `dedupe_same_user` flag. |
| 40 | **OCR preprocessing** | `CVCommentProcessor._loop()` (color mask, black mask, 2× upscale) | `features/livestream/application/ocr/preprocess_service.py → OCRPreprocessService.process()` | ✅ migrated | Both preprocess images before OCR. NEW: Tesseract-specific preprocessing (grayscale, threshold). OLD: color/black masking for EasyOCR. |
| 41 | **OCR runner loop** | `CVCommentProcessor._loop()` (daemon thread, 50ms tick) | `features/livestream/application/ocr/runner.py → OCRRunner._run_loop()` (daemon thread, configurable `interval_seconds`) | ✅ migrated | NEW is more configurable (interval, min_confidence, dedupe_window). Pipeline is explicitly decomposed into 6 services. |
| 42 | **OCR comment logging** | `OCRManager.save_comment()` → `comment_log.json` | `features/livestream/application/ocr/log_service.py → OCRLogService.append_event()` → `brand/{id}/obs/ocr_comment_log.json` | ✅ migrated | NEW stores per-brand logs. OLD stored single global log. |
| 43 | **TikTok comment reader** | `player/backend/tiktok_comment.py → TikTokCommentManager` (TikTokLive websocket, async event loop in daemon thread) | Not present | ❌ MISSING | TikTok comment integration completely absent in NEW. |
| 44 | **Comment source type selection** | OLD: Shopee OCR (CV) + TikTok WS — both auto-send to PDE | `features/livestream/application/comment_reader.py → CommentReader.read_comments(source_type=api|ocr)` | ⚠️ PARTIAL | NEW unifies comment source under `CommentReader` with `api` (Shopee API) or `ocr` modes. TikTok absent. OCR `direct` mode is stub ("not integrated"). |
| 45 | **Comment-to-video mapping (CSV-based)** | Not present (OLD used in-memory hybrid matching) | `features/livestream/application/comment_video_mapper.py → CommentVideoMapper` | ✅ migrated | NEW uses editable CSV (`id,name,description`) for mapping. Operator fills description column with keywords. Old app used auto-matched JSON catalog. Fundamentally different UX. |
| 46 | **Comment switch orchestration** | `player/backend/pde_engine.py → PlayerDecisionEngine.process_input()` | `features/livestream/application/comment_switch_service.py → CommentSwitchService.run_comment_switch()` | ⚠️ PARTIAL | OLD: full pipeline with threshold, cooldown, rate limit, top-5 candidates. NEW: simpler CSV score match → enqueue priority. No threshold/cooldown/rate-limit in NEW. |
| 47 | **QA comment flow (STT-based)** | Not present | `CommentSwitchService.process_ocr_comment()` → `mapper.resolve_qa_video_id_from_comments()` → QA STT matching | ✅ migrated | NEW introduces QA flow: "Câu hỏi" column matched by keyword → maps to QA video by STT position. New concept absent in OLD. |
| 48 | **Scheduling / task orchestration** | `controller/task_scheduler.py → TaskScheduler` (Tk `after`) | Not present (thread-based) | ❌ MISSING | OLD scheduled all OBS operations onto Tk main thread. NEW uses daemon threads with `threading.RLock`. No Tk scheduler. |
| 49 | **Scheduler service (factory)** | `controller/services/scheduler_service.py → create_scheduler()` | Not present | ❌ MISSING | Factory wrapper absent in NEW. |
| 50 | **Remote logging (controller side)** | `controller/services/remote_log_service.py → log_remote_event()` → `remote_control_log.json` | Not present | ❌ MISSING | OLD logged all remote control events (direction, action, status, message) to JSON. Absent in NEW. |
| 51 | **Remote logging (player side)** | `player/services/remote_log_service.py → log_remote_event()` → `remote_control_log.json` | Not present | ❌ MISSING | Player-side remote log absent in NEW. |
| 52 | **Keyword history log** | `player/services/keyword_history_service.py → log_keyword_event()` → `keyword_history_log.json` (ring buffer, max 200 entries) | Not present | ❌ MISSING | PDE decision logging with top_candidates payload absent in NEW. |
| 53 | **Duplicate comment logger UI** | `player/ui/duplicate_comment_logger.py → DuplicateCommentLogger` | Not present | ❌ MISSING | OLD had special widget tracking duplicate OCR comments in Tk log box. Absent in NEW. |
| 54 | **Collapsible frame UI widget** | `player/ui/collapsible_frame.py → CollapsibleFrame` also `MainController.CollapsibleFrame` | Not present as shared component | ⚠️ PARTIAL | CollapsibleFrame defined inline in `controller/ui/main_controller.py`. NEW uses different UI structure; no CollapsibleFrame equivalent found. |
| 55 | **Controller–Player service communication** | `controller/services/player_service.py → send_to_player(), send_pde_pause(), send_pde_resume()` (HTTP calls to port 5001) | Not present | ❌ MISSING | OLD had explicit HTTP bridge between Controller and Player processes. NEW is single-process so no IPC needed — but cross-feature calls go via `features/obs/application/public_api.py`. |
| 56 | **Controller service binding** | `controller/services/controller_service.py → bind_main_controller() / get_main_controller()` | Not present | ❌ MISSING | OLD stored MainController reference so Flask routes could call Tk methods. NEW has no Flask server. |
| 57 | **Player→Controller send_all_to_controller** | `player/services/controller_service.py → send_all_to_controller()` (HTTP POST to /receive_videos) | Not present | ❌ MISSING | OLD Player UI had "Send All IDs" button that posted catalog to Controller API. Absent in NEW. |
| 58 | **Shopee API client** | Not present (OLD was OBS-only, no Shopee API) | `features/livestream/api.py → ShopeeAPIClient` (HMAC-signed requests) | ✅ migrated | NEW adds Shopee livestream API: create_session, end_session, get_comment, refresh_access_token, get_shop_info. Entirely new concept. |
| 59 | **Multi-brand support** | Not present | `features/livestream/config.py → get_brand_env_path(), list_brands(), get_active_brand(), set_active_brand()` | ✅ migrated | NEW supports multiple brands each with their own `.env` config, OBS config, and catalog. Absent in OLD. |
| 60 | **Env config persistence (.env file)** | `player/config.py → _load_environment_file()` (one .env per app) | `features/livestream/config.py → load_env() / save_config()` per-brand `.env` files in `envs/` | ✅ migrated | NEW brand-scoped, with `migrate_legacy_env()` migration helper. |
| 61 | **Logger / log handler** | `controller/logger.py → ControllerLogger` (Tk widget + stdout) | `shared/logger.py → get_logger()` (Python logging + `PASS` level) + `shared/log_handler.py` | ⚠️ PARTIAL | OLD: direct Tk widget write with timestamp. NEW: standard `logging` library with custom `PASS` level and UI handler. Thread-safe via `logging` internals. |
| 62 | **Logger service (factory)** | `controller/services/logger_service.py → create_logger()` | Not present (use `get_logger()` directly) | ⚠️ PARTIAL | OLD factory pattern not replicated; `get_logger()` called directly. |
| 63 | **Storage helpers (JSON read/write)** | Inline `json.loads/dumps` calls throughout | `shared/storage.py → read_json(), write_json()` | ✅ migrated | NEW centralizes JSON persistence into shared helpers. |
| 64 | **Message constants / error codes** | Hardcoded strings throughout | `shared/messages.py → ErrorCode enum + err()` | ✅ migrated | NEW externalizes error strings. Absent in OLD. |
| 65 | **Shared utility helpers** | `controller/utils.py` (ffprobe, OBS log dirs), `player/utils.py` (token normalization, ASCII, similarity) | `shared/helpers.py → to_num(), to_bool()` | ⚠️ PARTIAL | OLD utils: ffprobe duration probe, OBS log path discovery, token similarity. NEW helpers: only numeric/bool coercion. ffprobe, OBS log, token similarity all missing in NEW. |
| 66 | **ffprobe duration probe** | `controller/obs_connection.py → get_duration_seconds()`, `controller/utils.py → probe_duration_ms()` | Not present | ❌ MISSING | OLD used ffprobe to get media duration for switch timing. NEW relies on OBS `get_media_input_status` for cursor/duration. |
| 67 | **OBS log directory detection (platform)** | `controller/utils.py → obs_log_directories()`, `latest_obs_log()` | Not present | ❌ MISSING | Windows/macOS/Linux OBS log path detection absent in NEW. |
| 68 | **PDE runtime config (set via UI/API)** | `player/services/pde_runtime_config.py` + API endpoints `/pde/set_*` | Not present | ❌ MISSING | In-flight threshold/cooldown/max-RPM adjustment absent in NEW. |
| 69 | **Config — controller constants** | `controller/config.py` (paths, timings, OBS action strings, media kinds, file ext policy) | `features/obs/domain/models.py → OBSConfig` | ⚠️ PARTIAL | OLD: monolithic constants file. NEW: domain model. Timing constants (CHECK_INTERVAL_MS, SWITCH_THRESHOLD, etc.) not present as named constants in NEW (hardcoded in runner). |
| 70 | **Config — player constants** | `player/config.py` (PDE thresholds, OCR dedup thresholds, color HSV ranges, API port) | `features/livestream/config.py → AppConfig` | ⚠️ PARTIAL | OLD had PDE_DEFAULT_THRESHOLD, DUP_SIM_THRESHOLD, BLUE_HUE_RANGE, etc. NEW has Shopee API config. OCR and matching tuning parameters absent in NEW. |
| 71 | **debug_queue_trace.py** | `/debug_queue_trace.py` (standalone debug script, reads queue_state.json, traces queue transitions) | `smoke_pipeline.py` (structured end-to-end smoke test) | ⚠️ PARTIAL | OLD: ad-hoc debug script for queue tracing. NEW: proper smoke test covering comment→CSV→enqueue→priority→re-prepare pipeline with pass/fail reporting. |
| 72 | **Workaround: dynamic PDE module load** | `player.py → _load_pde_engine()` (loads `pde_engine.py` via importlib to avoid name collision with `player.py` itself — `#ensure_decorators_can_resolve_module`) | Not present (clean module structure) | ❌ MISSING | OLD required ugly importlib workaround because `player.py` module name collided with `player/` package. Absent in NEW (clean package layout). |
| 73 | **Workaround: dynamic OCR module load** | `player.py → _load_cv_manager()` (loads `cv_comment.py` via importlib) | Not present | ❌ MISSING | Same root cause as above. Absent in NEW. |
| 74 | **Workaround: `#fix_` prefixed blocks** | `player/api_server.py` — multiple `#fix_` comments: path logging, reload hook, catalog reload notification, safe log for Windows consoles | Addressed by clean architecture | ✅ migrated | OLD had 6 `#fix_` patches in api_server. NEW's clean module structure makes these unnecessary. |
| 75 | **Workaround: fallback PDE constructor** | `player.py → _ensure_pde()` `except TypeError: #fallback_for_older_constructor_ordering` | Not present | ❌ MISSING | OLD had try/except ladder with 3 constructor call patterns for backward compat. Clean in NEW. |
| 76 | **Workaround: Flask shutdown via GET /shutdown** | `controller/api_server.py → shutdown()` using deprecated `werkzeug.server.shutdown` | Not applicable | ❌ MISSING | OLD used Werkzeug's deprecated internal shutdown mechanism. NEW has no Flask. |
| 77 | **Workaround: werkzeug /performance log suppression** | `controller/api_server.py → NoPerformanceFilter` + `player/api_server.py → NoPerformanceFilter` | Not applicable | ❌ MISSING | Both OLD Flask servers suppressed /performance health-check log spam via custom filter. Not needed in NEW. |
| 78 | **Workaround: Windows console UnicodeEncodeError** | `player/api_server.py → _safe_log()` with buffer fallback + ASCII backslashreplace | Not present | ❌ MISSING | OLD had elaborate safe logging for non-UTF8 Windows consoles. Absent in NEW (standard Python logging handles encoding). |
| 79 | **Workaround: mojibake repair** | Not present in OLD | `comment_video_mapper.py → normalize_text()` (latin1/cp1252→utf-8 heuristic repair) | ✅ migrated | NEW adds workaround for Vietnamese mojibake from Excel-generated CSVs. |
| 80 | **Workaround: Excel CSV PermissionError** | Not present | `CommentVideoMapper.ensure_mapping_csv()` `except PermissionError: return path` | ✅ migrated | NEW handles CSV locked by Excel silently. |
| 81 | **Workaround: TODO — evict requested from regular** | `controller/queue_feeder.py` line 132: `#todo_if_a_video_id_exists_in_requested_queue_automatically_remove_it_from_regular_queue` | Implemented via `_maybe_evict_regular_preload_for_requested()` in old QueueManager | ⚠️ PARTIAL | OLD had the TODO; QueueManager had eviction logic. NEW's `_sync_ready_queue_locked()` handles priority ordering differently — no explicit eviction but priority IDs always jump to front. |
| 82 | **Workaround: OBS scheduler fallback** | `queue_service.run_on_main()`: `except Exception: _enqueue_one()` (fallback to direct call when scheduler unavailable) | Not applicable | ❌ MISSING | Pattern not needed in NEW (no Tk scheduler cross-thread issue). |
| 83 | **ENV var handling — FLASK_RUN_PORT** | `player/api_server.py → _resolve_run_port()` checks `FLASK_RUN_PORT`, `PLAYER_API_PORT`, `PORT` | Not applicable | ❌ MISSING | No Flask in NEW. |
| 84 | **Hardcoded fallback: default threshold 0.7** | `player.py → _ensure_pde()`: `threshold=0.7` hardcoded (overrides config default of 0.3) | Not present | ❌ MISSING | OLD had inconsistency: config default was 0.3 but UI initialized PDE with 0.7. Bug/workaround. |
| 85 | **Hardcoded fallback: cooldown 120s in OBSService** | Not present | `OBSService.__init__()`: `self._default_cooldown_seconds = 120` | ✅ migrated | NEW has sensible default. |
| 86 | **Env loading: .env file in player config** | `player/config.py → _load_environment_file()` (searches project root for `.env` or `env`) | `features/livestream/config.py → load_env()` (per-brand `.env` in `envs/`) | ✅ migrated | Both load `.env` style files. NEW is brand-scoped with migration helper. |
| 87 | **API: receive_video / receive_videos (enqueue by ID)** | `controller/api_server.py → /receive_video` (POST), `/receive_videos` (POST batch) | `features/obs/application/public_api.py → enqueue_priority_video()` (function call, no HTTP) | ⚠️ PARTIAL | Logic equivalent (look up video by ID, enqueue as priority). OLD exposed via HTTP. NEW is internal function call. No external HTTP API in NEW. |
| 88 | **API: pause/resume switching remotely** | `controller/api_server.py → /control/pause_switching`, `/control/resume_switching` | No equivalent | ❌ MISSING | OLD allowed remote pause/resume of auto-switch from Player UI. Absent in NEW. |
| 89 | **API: PDE pause/resume remotely** | `player/api_server.py → /pde/pause`, `/pde/resume` | No equivalent | ❌ MISSING | Controller could remotely pause PDE processing. Absent in NEW. |
| 90 | **API: update_catalog (Player receives from Controller)** | `player/api_server.py → /update_catalog` | Not present | ❌ MISSING | OLD Controller pushed catalog to Player via HTTP. NEW: same process, no HTTP push needed. |
| 91 | **Shopee get_comment API polling** | Not present | `features/livestream/service.py → get_comment()` + `CommentReader._read_from_api()` | ✅ migrated | NEW adds Shopee API comment polling. Absent in OLD. |
| 92 | **Shopee access token refresh** | Not present | `LivestreamService.refresh_access_token()` | ✅ migrated | NEW adds token refresh flow. Absent in OLD. |
| 93 | **Shopee session management** | Not present | `LivestreamService.create_session()`, `end_session()` | ✅ migrated | NEW adds full Shopee live session lifecycle. Absent in OLD. |
| 94 | **OCR file-based input** | Not present | `CommentReader._read_from_ocr_file()` (JSON or line-per-line text file) | ✅ migrated | NEW allows loading comments from pre-captured OCR output file. New capability. |
| 95 | **Per-brand data directory structure** | Not present | `features/livestream/config.py → ensure_brand_data_dir()` → `data/brands/{brand_id}/obs/` | ✅ migrated | NEW isolates all brand data. Absent in OLD. |
| 96 | **Smoke / integration test** | `debug_queue_trace.py` (queue debug script, not a test) | `smoke_pipeline.py` (structured smoke test: CSV matching, OBS queue priority, full pipeline) | ✅ migrated | NEW has much better automated test coverage for the comment→enqueue pipeline. |
| 97 | **`test/auth.py`** | Not present | `test/auth.py` (Shopee API authentication helper/test) | ✅ migrated | NEW-only — tests auth flow for Shopee API. |

---

## Summary Statistics

| Status | Count |
|--------|-------|
| ✅ migrated | 38 |
| ⚠️ PARTIAL | 20 |
| ❌ MISSING | 39 |
| **Total items** | **97** |

---

## Critical Missing Items (High Risk)

The following OLD features are **completely absent** in the NEW app and represent significant migration gaps:

1. **PDE (PlayerDecisionEngine)** — Core hybrid matching engine with threshold/cooldown/rate-limit (items 21–23, 25–27, 30, 48, 68)
2. **Flask HTTP API layer** — Both controller (port 5000) and player (port 5001) APIs gone; 14+ endpoints missing (items 5, 6, 85–90)
3. **TikTok comment reader** — Entire TikTokLive integration absent (item 43)
4. **Remote logging** — JSON audit trail for remote control events gone (items 50–51)
5. **Keyword history log** — PDE decision history ring-buffer gone (item 52)
6. **OBS log watcher** — REQUEST_RELOAD monitoring absent (item 19)
7. **Task scheduler (Tk-based)** — Cross-thread dispatch removed; NEW uses raw threads (item 10, 48)
8. **Catalog validation** — CSV vs JSON validation with fuzzy name matching absent (item 33)

## Key New Capabilities in NEW App (Not in OLD)

1. **Shopee API integration** (create/end session, get comments, token refresh)
2. **Multi-brand support** with per-brand config, data, and catalog
3. **QA video queue** with keyword-based routing via "Câu hỏi" column
4. **CSV-editable comment→video mapping** (operator-controlled vs. AI-only in OLD)
5. **ModuleRuntime** process-level orchestration
6. **Structured smoke test pipeline**
7. **Video cooldown persistence** across restarts (OLD was in-memory)
8. **OBSService re-prepare standby** when priority changes (was TODO in OLD)
