#!/usr/bin/env bash
# send.sh — send a message to an agent's inbox (DB messages table).
# Usage: ./scripts/send.sh <to-agent> <from-agent> <task-id> "<message body>"
# Example: ./scripts/send.sh backend-engineer orchestrator T-001 "Create project/backend/hello.py"
#
# API-only: messages live in shared/state.db, not markdown files. This shells
# out to a tiny Python snippet using scripts/db.py.

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
PYTHON="${PYTHON_BIN:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python

"$PYTHON" - "$ROOT" "$TO" "$FROM" "$TASK" "$BODY" <<'PY'
import sys
from pathlib import Path
root, to, frm, task, body = sys.argv[1:6]
sys.path.insert(0, str(Path(root) / "scripts"))
from db import Db
db = Db(Path(root) / "shared")
mid = db.add_message(from_role=frm, to_role=to, body=body,
                     task_id=(task or None), status="unread")
db.close()
print(f"sent message id={mid} to {to} (task {task})")
PY
