# Review T-007 — Hello CLI (T-006)

**Reviewer:** reviewer-agent
**Date:** 2026-05-04 13:59
**Verdict:** changes-requested

## Files reviewed
- project/backend/hello.py

## Findings

### Spec compliance
- [x] `greet(name)` function returns `"Hello, {name}!"`
- [x] `__main__` CLI block prints result
- [x] Normal input works: `python3 hello.py World → Hello, World!`

### Bugs / Logic
- (bug) `hello.py:9` — No bounds check on `sys.argv`: running `python3 hello.py` with no argument raises `IndexError: list index out of range` instead of a user-friendly error or usage message. CLI should guard against missing argument.
- (minor) `hello.py:9` — Empty string arg (`python3 hello.py ""`) prints `Hello, !` — technically correct per implementation but may be unexpected. No validation for blank names.

### Tests
- No automated tests for the CLI path.
- Manual smoke test passes for normal input only.

### Security
- No security concerns for this scope.

### Style / Maintainability
- `greet()` function is clean and correct.
- Missing arg handling is the only issue.

## Action items (changes-requested)
1. Add guard in `__main__` block: if `len(sys.argv) < 2`, print a usage message (e.g., `Usage: hello.py <name>`) and exit with non-zero code instead of crashing with IndexError.
