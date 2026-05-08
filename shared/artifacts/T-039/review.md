# Review T-039 — Re-review T-038 fixes (A7 multi-source wire + auto_reconnect default)

**Reviewer:** reviewer-agent
**Date:** 2026-05-05 14:14
**Verdict:** approved

---

## Files reviewed

- `features/livestream/ui/main_window.py` (lines 657–677 — `_get_comment_worker`)
- `features/livestream/ui/components/comment_setup_tab.py` (line 152 — `tiktok_auto_reconnect_var`)

---

## Findings

### Fix #1 — A7 Multi-source wiring (`main_window.py:661–662`)

✅ **Verified correct.**

```python
cfg.enabled_sources = self.action_tabs.comment_setup.get_active_sources() or ["api"]
results = self.comment_switch_service.run_multi_source_switch(...)
```

- Old single-source `run_comment_switch(source_type=self.action_tabs.comment.source_var.get())` is gone from `_get_comment_worker`.
- Sources now read from `CommentSetupTab.get_active_sources()` (multi-source checkbox group).
- Fallback `or ["api"]` ensures at least one source when nothing checked — safe.
- `run_multi_source_switch` iterates `cfg.enabled_sources` and runs each source independently per tick — matches A7 spec.
- **A7 can now pass**: API+TikTok / API+OCR / OCR+TikTok / all 3 combinations are all handled.

**Regression check:** `source_var` still appears at lines 207/224 in `_snapshot_ui`/`_restore_session` — these only persist legacy UI state for the old combobox, not the execution path. Harmless; no regression.

---

### Fix #2 — `tiktok_auto_reconnect_var` default (`comment_setup_tab.py:152`)

✅ **Verified correct.**

```python
self.tiktok_auto_reconnect_var = tk.BooleanVar(value=False)
```

Default now matches `AppConfig.tiktok_auto_reconnect = False`. UI is consistent with config on first load.

---

### Spec compliance re-check

| Criterion | Status |
|-----------|--------|
| A1 TikTok connect → Connected | ✅ unchanged |
| A2 match → log source="tiktok" | ✅ unchanged |
| A3 no-match → log no_match | ✅ unchanged |
| A4 disconnect clean | ✅ unchanged |
| A5 Keyword Log auto-refresh | ✅ unchanged |
| A6 filter source/status | ✅ unchanged |
| **A7 multi-source parallel** | **✅ FIXED** |
| A8 auto-reconnect | ✅ unchanged |
| A9 brand config persist | ✅ unchanged |
| A10 OCR-only log source="ocr" | ✅ unchanged |
| A11 pip install clean | ✅ unchanged |
| A12 syntax OK | ✅ `py_compile` ALL OK |

---

### Syntax check

`python3 -m py_compile` on both fixed files: **ALL OK**

---

## Notes

The two non-critical items from T-037 remain open but were not blockers:
- `disconnect()` blocking UI thread on close (nice-to-have)
- Zero unit tests for TikTok/dedupe code (nice-to-have)

These do not affect acceptance of the feature as scoped.

---

**Feature T-037 accepted. All A1–A12 criteria met.**
