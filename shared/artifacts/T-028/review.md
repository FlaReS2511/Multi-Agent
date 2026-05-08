# Review T-028 — Migration audit T-027 (phase1 diff + phase2 code fixes)

**Reviewer:** reviewer-agent
**Date:** 2026-05-05 11:45
**Verdict:** approved

## Files reviewed

Phase 2 code (4 migrated items):
- `features/obs/infrastructure/client.py` — scene item ID cache + `get_source_visibility()`
- `features/obs/application/service.py` — visibility watchdog, `_log_event()`, runner wiring
- `shared/storage.py` — `append_json_log()` helper
- `features/livestream/application/comment_switch_service.py` — `_log_match_decision()` + call sites

Audit artifacts:
- `shared/artifacts/T-027/phase1_diff.md` — 97-item table (spot-checked)
- `shared/artifacts/T-027/summary.md` — phase 2 summary + flagged items

---

## Findings

### Spec compliance

- [x] 4 migrated items implemented
- [x] Phase1 diff table covers 97 items (38 migrated + 4 phase2 = 42 total, 25+3 cannot-migrate, 4 flagged, 6 partial, 17 workarounds-removed)
- [x] All "flagged for human review" items accurately described
- [x] No regressions detected

---

### Item #12 — OBS scene item ID cache ✅

`OBSWebSocketClient.__init__` (`client.py:29`) adds:
```python
self._scene_item_cache: dict[tuple[str, str], int] = {}
```

`_find_scene_item_id` (`client.py:97-115`) checks cache before calling `get_scene_item_list` — faithful port of OLD `OBSConnection._scene_items`. Cache is cleared on `disconnect()` (`client.py:51`). Type-safe (`int(scene_item_id)` enforced). No race conditions — cache is only accessed from OBS call sites which are all serialized through the runner thread or synchronized UI calls.

`get_source_visibility()` (`client.py:117-131`) is a new helper needed by the watchdog. It intentionally bypasses the cache (always re-queries `get_scene_item_list`) because it needs *current* visibility state, not a cached item ID. Correct design.

**No issues.**

---

### Item #15 — OBS visibility recovery watchdog ✅

`_pending_vis_checks: list[tuple[float, str]]` added to `__init__` (`service.py:41`). After each `_play_to_slot()` call, it is set to exactly `[(now+1.0, slot), (now+6.0, slot)]` (`service.py:472`) — matches OLD's 1s + 6s schedule.

`_runner_loop` (`service.py:579-584`) drains due checks and calls `_verify_slot_visibility` only for the currently active slot. This correctly skips stale checks after a further slot swap.

`_verify_slot_visibility` (`service.py:474-492`):
- Only recovers when `enabled is False` (confirmed hidden), not on `None` (query failed) — avoids false recovery
- Logs recovery success and failure to `event_log.json`
- Faithful to OLD `MainController._verify_slot_visibility()` logic

**Minor edge case (non-blocking):** `_play_to_slot` overwrites `_pending_vis_checks` entirely — if called twice in rapid succession (e.g., skip triggers immediate re-play), pending checks for the previous call are lost. In practice this is harmless: after a skip the new slot is active and the old pending checks would have been filtered by the `check_slot == self._active_slot` guard anyway. Not a regression.

---

### Items #50, #51 — Remote event logging (`append_json_log`) ✅

`shared/storage.py:27-42`:
```python
def append_json_log(path: Path, record: dict, *, max_entries: int = 500) -> None:
```
- `ensure_parent(path)` creates `brand/{id}/obs/` dir if missing ✅
- Reads existing entries, appends, truncates to tail (ring buffer) ✅
- Only catches `OSError` and logs it — does not suppress non-IO exceptions ✅
- `path.write_text(json.dumps(..., ensure_ascii=False, indent=2))` — atomic-ish (write replaces file). Not transactional but acceptable for a debug log.

`_log_event()` in `service.py:48-60`:
- Uses lazy `from features.livestream.config import ensure_brand_data_dir` import inside the method — avoids circular import at module load time (obs.service → livestream.config ← livestream.comment_switch_service → features.obs). Correct pattern. ✅
- Events wired: `runner_start` / `runner_stop` (`service.py:556, 565`), `skip_current` (`service.py:334`), `visibility_recovered` / `visibility_recover_failed` (`service.py:489, 492`) — covers all meaningful OBS control events

OLD schema had `direction, action, status, message`; NEW uses `action, status, message` (no `direction` field). This simplification is intentional and consistent with the single-process redesign.

---

### Item #52 — Match decision logging ✅

`_log_match_decision()` in `comment_switch_service.py:16-31`:
- Writes to `brand/{id}/obs/keyword_history_log.json`
- Ring buffer of 200 matches OLD `keyword_history_service.py` cap ✅
- Records: `timestamp` (UTC ISO), `keyword`, `source`, `status`, `reason`, `video_id` (optional) ✅
- `video_id` cast to `str` when present — safe against int IDs ✅

Call sites:
- `process_ocr_comment`: logs both `no_match` and `matched` paths ✅
- `run_comment_switch`: logs both paths using first-3-comments as `keyword` field ✅

OLD also logged `top_candidates` (PDE output). Absent in NEW — correct, since there's no PDE and no ranked candidates. The log faithfully captures what NEW's simpler matching model produces.

---

### Imports / dependency check ✅

```
shared.storage.append_json_log          → exists (storage.py:27)
features.livestream.config.ensure_brand_data_dir → exists (config.py:84)
```

All imports verified present in the codebase. No missing modules.

---

### Spot-check: "cannot migrate" decisions (sample of 10)

| Item | Decision | Correct? |
|------|----------|---------|
| #5, #6 (Flask API servers) | Cannot migrate — NEW is single-process | ✅ |
| #10, #48, #49 (Tk scheduler) | Cannot migrate — NEW uses daemon threads | ✅ |
| #21-23 (PDE engine) | Cannot migrate — intentional replacement by CSV matching | ✅ |
| #43 (TikTok reader) | Cannot migrate — Shopee-only product decision | ✅ |
| #55-57 (HTTP IPC) | Cannot migrate — single-process, public_api.py instead | ✅ |
| #72-73 (importlib hacks) | Not needed — clean package layout eliminates root cause | ✅ |
| #76-78 (Flask shutdown / werkzeug) | Not needed — no Flask in NEW | ✅ |
| #66 (ffprobe) | Replaced by OBS `get_media_input_status` | ✅ (note below) |
| #84 (0.7 threshold bug) | Not applicable — no PDE in NEW | ✅ |

**Note on #65-67 categorization (non-blocking):** Item #66 (ffprobe) is grouped under "flagged for human review" but the summary's own explanation says it's "not needed." This is a minor inconsistency in categorization — the item is effectively resolved by the OBS-native approach. Recommend reclassifying to "cannot migrate (replaced by OBS native API)" in a future cleanup, but it doesn't affect correctness.

---

### Flagged for human review — accuracy check ✅

| Item | Description in summary | Accurate? |
|------|----------------------|----------|
| #19 (OBS log watcher) | Platform-specific log path discovery, complex setup | ✅ — `obs_log_directories()` was in `controller/utils.py`; no equivalent in NEW |
| #36 (OCR drag-select UI) | Interactive Tkinter overlay, no insertion point | ✅ — `OCRRunner` has `set_ocr_region()` but no interactive selection UI |
| #24, #26 (hybrid matching) | `rapidfuzz` dependency + design decision needed | ✅ — NEW's `_score()` is token overlap only; no fuzzy library |
| #65-67 (ffprobe, OBS log, token similarity) | ffprobe replaced; OBS log pending; token similarity needs fuzzy | ✅ |

All 4 flagged items are accurately described and genuinely require human decision before proceeding.

---

### Tests

- `pytest`: not run — no pytest suite present for this project (standalone Tkinter app, not the web-shop backend)
- Code review is the primary verification mechanism
- Build/import sanity: all imports resolve; `append_json_log` and `ensure_brand_data_dir` both confirmed present

---

### Style / Maintainability

- Migration comment annotations (`# migrated from old-app: ...`) are informative and correctly located
- `append_json_log` is appropriately generic (both event_log and keyword_history_log use it) — good reuse
- Ring buffer via tail-slice (`entries[-max_entries:]`) is simple and correct
- Lazy import in `_log_event` is intentional for circular import avoidance — acceptable pattern

---

## Action items

None. All 4 migrated items are correct and faithful to the OLD app. Flagged items are accurately described and ready for human decision. No regressions introduced.
