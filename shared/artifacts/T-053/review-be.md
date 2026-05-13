# BE Review T-053 — Pytest suite for scripts/runtime/*

**Date:** 2026-05-08 21:50
**Verdict:** approved

## Files reviewed
- scripts/tests/test_dispatch.py (15 tests)
- scripts/tests/test_idle.py (4 tests — note: T-045 summary listed 4, inbox listed 4 ✅)
- scripts/tests/test_keyring_io.py (6 tests)
- scripts/tests/test_spawner.py (10 tests)
- scripts/conftest.py

## Pytest run (verified independently)
```
35 passed in 0.14s
```
All 35 tests pass ✅.

---

## Findings

### Mock correctness
- **subprocess / Bash:** `tool_bash` tests hit a real subprocess (`echo hello_from_bash`) — no mock. This is intentional and acceptable; `echo` is a safe, deterministic command. ✅
- **SDK imports (anthropic, openai, google.genai):** mocked via `monkeypatch.setitem(sys.modules, ...)` in each test that instantiates an adapter. No real API keys needed ✅.
- **SHARED path:** `monkeypatch.setattr(kio, "SHARED", tmp_path)` applied as `autouse` fixture in every module that touches the filesystem ✅. `idle.py` tests also patch `idle_mod.SHARED` to cover the local import ✅.
- **time.sleep:** patched via `monkeypatch.setattr(idle_mod, "time", MagicMock(sleep=fake_sleep))` in all `run_loop` tests ✅. Loop never blocks.
- **agents-config.json:** not read from disk — `test_build_adapter_selects_per_agent_config` constructs config inline and simulates the `agent_runtime.py` loading logic ✅.

### Assertion quality
- No `assert True` or placeholder assertions found.
- Cost tests assert numeric values with tolerance (`abs(cost - 18.0) < 0.001`) ✅.
- Outbox/log tests assert file existence + string content ✅.
- `test_handle_message_extracts_task_id` reads the log file and checks `task=T-099` ✅ — meaningful end-to-end verification of the task-attribution feature.
- `test_read_new_inbox_handles_truncation` covers the edge case of stale offset > file size ✅.
- `test_build_adapter_unknown_kind_raises` uses `pytest.raises(ValueError, match=...)` — meaningful ✅.

### Coverage (4 runtime modules)
| Module | Tests hitting it |
|--------|-----------------|
| `runtime/dispatch.py` | test_dispatch.py (15) + indirectly via handle_message |
| `runtime/idle.py` | test_idle.py (4) |
| `runtime/keyring_io.py` | test_keyring_io.py (6) + autouse patches in dispatch/idle tests |
| `runtime/spawner.py` | test_spawner.py (10) |

All 4 modules covered ✅. Happy path + error path covered per module:
- dispatch: `tool_edit` missing-string error path ✅, unknown model cost → 0 ✅.
- idle: empty inbox (no dispatch), message-after-idle, KeyboardInterrupt exit ✅.
- keyring_io: missing file → `("", 0)`, truncation reset ✅.
- spawner: unknown kind → `ValueError` ✅.

### Minor observations (non-blocking)
1. `test_tool_bash_returns_output` hits a real subprocess (`echo`). Acceptable for a portable, read-only command, but worth noting in case the suite runs in an environment where shell is restricted.
2. `test_idle.py` has a blank line at line 41 (double blank between imports and first test block). Cosmetic only.
3. No `conftest.py`-level autouse fixture for `SHARED` — each module declares its own. Consistent and explicit ✅ (avoids cross-module coupling).

---

## Action items (changes-requested)
_None — approved as-is._
