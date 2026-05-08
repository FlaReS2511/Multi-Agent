# T-034 Artifact: Keyword Log Tab

## Files Changed

### New
- `features/livestream/ui/components/keyword_log_tab.py`
  - `KeywordLogTab` class: Treeview (6 cols), source/status filter dropdowns, Refresh button, auto-refresh 2s (pauses when tab hidden via `<<NotebookTabChanged>>`), `on_brand_changed()` method

### Modified
- `features/livestream/ui/components/action_tabs.py`
  - Added `KeywordLogTab` import
  - Added `get_keyword_log_path` param to `ActionTabs.__init__`
  - Created `self.keyword_log = KeywordLogTab(...)` and added "Keyword Log" tab to notebook

- `features/livestream/ui/main_window.py`
  - Passed `get_keyword_log_path` lambda to `ActionTabs`
  - Called `self.action_tabs.keyword_log.on_brand_changed()` in `_load_brand_to_ui`
