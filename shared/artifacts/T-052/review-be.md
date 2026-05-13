# BE Review T-052 — Split scripts/agent_runtime.py into runtime/ package

**Date:** 2026-05-08 21:45
**Verdict:** approved

## Files reviewed
- scripts/agent_runtime.py (74 lines — entrypoint)
- scripts/runtime/__init__.py
- scripts/runtime/keyring_io.py
- scripts/runtime/idle.py
- scripts/runtime/spawner.py
- scripts/runtime/dispatch.py

**Repo reviewed:** `C:\Users\ADMINA1\Downloads\hi\multi-agent\Multi-Agent` (BACKUP)

---

## Findings

### Spec / API contract
- `agent_runtime.py` is 74 lines ✅ (well under 200 limit).
- `--role` argv and `sys.exit()` error paths unchanged ✅.
- Module map matches spec exactly: `runtime/{keyring_io,idle,spawner,dispatch}.py` + `__init__.py` ✅.

### Circular deps
- Import chain is one-directional: `agent_runtime` → `runtime.{keyring_io, spawner, dispatch, idle}`. Within the package: `dispatch` → `keyring_io`, `idle` → `keyring_io`. No circular deps ✅.

### Validation & errors
- `idle.py:34` — outer `except Exception` catches handler errors, logs them, then continues the poll loop. Does not swallow silently ✅.
- `dispatch.py:158` — per-tool `except Exception` returns error string to the agent rather than crashing. Acceptable ✅.
- `dispatch.py:105` — `tool_grep` fallback loop: `except Exception: continue` silently skips unreadable files. Minor: worth adding a `pass` comment or logging at debug level, but not blocking.

### Security
- **Path traversal:** `tool_read`, `tool_write`, `tool_edit` (dispatch.py:39,52,60) resolve paths via `(Path.cwd() / path).resolve()` but do **not** assert the resolved path stays under a permitted prefix. An LLM acting on a prompt-injected message could read or write arbitrary files on the host. This is a **pre-existing design choice** (agent is trusted to run commands), not introduced by T-043, and the `tool_bash` shell gives equivalent power. No action required for this PR, but the surface is worth documenting in a future hardening ticket.
- **Secrets:** all API keys read from env vars ✅. No hardcoded credentials found.
- **SQL / CORS / Auth:** not applicable (no HTTP server, no DB in this module).

### Tests (pytest)
- No pytest suite exists yet for `scripts/runtime/` — tracked as T-045.
- `ast.parse()` clean (per BE summary) — no syntax errors ✅.
- Cannot run `pytest` against this code at review time; approving on the basis that T-045 is a tracked follow-up and this is a move-only refactor with no logic changes.

### Quality
- Module responsibilities are cleanly separated (I/O, adapters, tools, loop) ✅.
- `adapter` and `handle_fn` parameters in `idle.py:19` and `dispatch.py:125` lack type annotations. Acceptable for an internal script; no `Any` imports present so mypy would infer `Unknown`. Low priority.
- `build_adapter` raises `ValueError` for unknown kind with a clear message ✅.
- No over-abstraction; the split is proportionate to the original 547-line file.

---

## Action items (changes-requested)
_None — approved as-is. Optional follow-ups (non-blocking):_

1. `dispatch.py:105` — add a comment to the bare `except Exception: continue` explaining silent-skip intent.
2. `idle.py:19`, `dispatch.py:125` — add `Protocol` or `Any` type hints for `adapter` / `handle_fn` if mypy is added to CI (T-045).
3. Future ticket: add path-prefix guard to `tool_read/write/edit` for defense-in-depth against prompt injection.
