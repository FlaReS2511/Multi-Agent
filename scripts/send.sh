#!/usr/bin/env bash
# send.sh — send a message to an agent's inbox (DB messages table).
# Usage: ./scripts/send.sh <to-agent> <from-agent> <task-id> "<message body>"
# Example: ./scripts/send.sh backend-engineer orchestrator T-001 "Create project/backend/hello.py"
#
# API-only: messages live in shared/state.db. Inserts directly via the sqlite3
# CLI (no Python dependency).

set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 <to-agent> <from-agent> <task-id> \"<message body>\""
  exit 1
fi

TO="$1"
FROM="$2"
TASK="$3"
BODY="$4"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/shared/state.db"
TS="$(date "+%Y-%m-%d %H:%M")"

command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 CLI is required" >&2; exit 1; }

# SQL-escape: double any single quotes.
esc() { printf "%s" "$1" | sed "s/'/''/g"; }

MID=$(sqlite3 "$DB" "
  INSERT INTO messages (ts, from_role, to_role, task_id, body, status)
  VALUES ('$(esc "$TS")', '$(esc "$FROM")', '$(esc "$TO")',
          NULLIF('$(esc "$TASK")', ''), '$(esc "$BODY")', 'unread');
  SELECT last_insert_rowid();")

echo "sent message id=$MID to $TO (task ${TASK:-none})"
