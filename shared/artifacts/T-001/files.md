# T-001 Artifacts

## Files created/modified
- `project/backend/parsers.py` — `parse_csv()` implementation + 5 inline unit tests

## Notes
- Auto-detects comma vs tab delimiter via `csv.Sniffer`; explicit override available
- Accepts both `str` and `bytes` (UTF-8 decoded automatically)
- Returns `list[dict]` keyed by CSV header row
