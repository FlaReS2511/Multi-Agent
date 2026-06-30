#!/usr/bin/env bash
# reset.sh — reset coordination state (DB) to empty. API-only.
# Usage: ./scripts/reset.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON_BIN:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python

echo "This will:"
echo "  - Empty tasks, messages, usage, and logs in shared/state.db"
echo "  - Reset next_id to 1"
echo "  - Clear the planner draft"
echo ""
echo "Secrets (API keys) and artifacts in shared/artifacts/ will be KEPT."
echo "Project code in $ROOT/project/ will be KEPT."
echo ""
read -p "Continue? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# Clear planner draft
DRAFT="$ROOT/agents/planner/workspace/current-draft.md"
if [ -f "$DRAFT" ]; then
  : > "$DRAFT"
fi

"$PYTHON" - "$ROOT" <<'PY'
import sys
from pathlib import Path
root = sys.argv[1]
sys.path.insert(0, str(Path(root) / "scripts"))
from db import Db
db = Db(Path(root) / "shared")
for tbl in ("tasks", "messages", "usage", "logs"):
    db.conn.execute(f"DELETE FROM {tbl}")
db.conn.execute("INSERT INTO meta (key, value) VALUES ('next_id', '1') "
                "ON CONFLICT(key) DO UPDATE SET value = '1'")
db.conn.commit()
db.close()
print("DB reset complete.")
PY
