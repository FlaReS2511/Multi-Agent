#!/usr/bin/env bash
# keyring.sh — export API keys as env vars before launching agent runtimes.
#
# This is sourced by launch-tmux.sh before the agent panes are spawned, so that
# python3 agent_runtime.py inherits ANTHROPIC_API_KEY / GOOGLE_API_KEY /
# OPENAI_API_KEY without any plaintext appearing in shell history or logs.
#
# Source of truth: shared/.secrets.json. Each value is base64 of an Electron
# safeStorage.encryptString() output. We invoke a tiny Node helper that runs
# inside an Electron context (via the project/frontend node_modules) to decrypt.
#
# Fallback: if Electron is not available (e.g. running on a fresh checkout
# without `npm install`), check for plaintext env vars already exported by the
# user — agent_runtime.py will pick those up directly.
#
# This script is safe to source multiple times.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$ROOT/shared/.secrets.json"
DECRYPT_HELPER="$ROOT/scripts/keyring-decrypt.js"

# Nothing to do if secrets file does not exist
if [ ! -f "$SECRETS" ]; then
  return 0 2>/dev/null || exit 0
fi

# Try Electron-backed decryption helper if present
if [ -f "$DECRYPT_HELPER" ] && command -v node >/dev/null 2>&1; then
  # The helper prints lines like:  export ANTHROPIC_API_KEY=sk-...
  # Errors go to stderr; suppressed here so a missing entry doesn't abort launch.
  exports=$(node "$DECRYPT_HELPER" 2>/dev/null || true)
  if [ -n "$exports" ]; then
    eval "$exports"
  fi
fi

# If env vars are still empty after Electron decrypt, leave them alone.
# agent_runtime.py will report "no key configured" for the affected backend
# and that agent will fail to start cleanly (better than silent confusion).

return 0 2>/dev/null || true
