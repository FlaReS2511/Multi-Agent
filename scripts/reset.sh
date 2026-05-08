#!/usr/bin/env bash
# reset.sh — xoá nội dung inbox, outbox, logs, reset tasks.json về rỗng
# Usage: ./scripts/reset.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "This will:"
echo "  - Empty all inbox files in $ROOT/shared/inbox/"
echo "  - Delete contents of $ROOT/shared/outbox/"
echo "  - Delete contents of $ROOT/shared/logs/"
echo "  - Reset $ROOT/shared/tasks.json to empty"
echo ""
echo "Artifacts in $ROOT/shared/artifacts/ will be KEPT (delete manually if needed)."
echo "Project code in $ROOT/project/ will be KEPT."
echo ""
read -p "Continue? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# Empty inbox files (keep the files themselves)
for f in "$ROOT/shared/inbox/"*.md; do
  : > "$f"
done

# Clear planner draft
DRAFT="$ROOT/agents/planner/workspace/current-draft.md"
if [ -f "$DRAFT" ]; then
  : > "$DRAFT"
fi

# Delete outbox contents (keep folder)
find "$ROOT/shared/outbox" -mindepth 1 -not -name '.gitkeep' -delete

# Delete logs (keep folder)
find "$ROOT/shared/logs" -mindepth 1 -not -name '.gitkeep' -delete

# Reset tasks.json
cat > "$ROOT/shared/tasks.json" <<'EOF'
{
  "tasks": [],
  "next_id": 1
}
EOF

echo "Reset complete."
