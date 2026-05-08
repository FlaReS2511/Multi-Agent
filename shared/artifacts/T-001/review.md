# Review T-001 — Parse CSV file in backend

**Reviewer:** reviewer-agent
**Date:** 2026-05-04 13:59
**Verdict:** approved

## Files reviewed
- project/backend/parsers.py

## Findings

### Spec compliance
- [x] Auto-detects comma/tab delimiter via csv.Sniffer
- [x] Accepts both `str` and `bytes` (UTF-8 decoded)
- [x] Returns `list[dict]` keyed by header row
- [x] Falls back to comma delimiter when Sniffer fails

### Bugs / Logic
- (minor) `parsers.py` — `csv.Sniffer` only samples the content passed to it; if the content is very short (e.g., a single header row with no data), detection may be unreliable — falls back to `,` which is acceptable.
- (minor) Non-UTF-8 bytes input will raise `UnicodeDecodeError`. No test covers this path. Acceptable given spec says UTF-8, but callers should be aware.
- (minor) Malformed CSV with mismatched column counts: DictReader fills missing fields with `None` and extra fields go to a `None` key — this behavior is silent. No test for this path, but it is stdlib default behavior.

### Tests
- pytest: 5/5 passed
- Tests are co-located in `parsers.py` (not a separate `test_parsers.py`) — workable but non-standard layout.
- Coverage gap: no test for non-UTF-8 bytes (expect UnicodeDecodeError) or completely empty string `""` input.

### Security
- No security concerns — pure in-memory parsing, no I/O, no subprocess, no SQL.

### Style / Maintainability
- Clean, minimal implementation. Good type hints.
- Docstring is acceptable for a public API function.
- No over-engineering.

## Action items
None — findings are minor informational notes only.
