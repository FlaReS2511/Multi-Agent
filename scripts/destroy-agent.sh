#!/usr/bin/env bash
# destroy-agent.sh — remove a cloned agent instance.
#
# Usage:
#   scripts/destroy-agent.sh <instance-id>
#
# Refuses to destroy a base role (one without `-<n>` suffix or one not
# marked as a clone via `.clone-of` file). Removes config entry, agent dir,
# inbox/log/outbox traces. Caller is responsible for ensuring no in-flight
# tasks reference this instance.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <instance-id>" >&2
  exit 2
fi

INSTANCE="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/shared/agents-config.json"
DIR="$ROOT/agents/$INSTANCE"

# Refuse to destroy unless this is a clone
if [ ! -f "$DIR/.clone-of" ]; then
  echo "error: '$INSTANCE' is not marked as a clone (missing .clone-of file). Refusing to destroy." >&2
  exit 3
fi

if [[ ! "$INSTANCE" =~ -[0-9]+$ ]]; then
  echo "error: '$INSTANCE' does not match clone naming `<base>-<n>`. Refusing." >&2
  exit 4
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node required" >&2
  exit 5
fi

# Remove config entry via Node
if [ -f "$CFG" ]; then
  node -e '
    const fs = require("fs");
    const [id, cfgPath] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    if (cfg.agents) delete cfg.agents[id];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  ' "$INSTANCE" "$CFG"
fi

# Remove instance dir + inbox + log + dated outbox files
rm -rf "$DIR"
rm -f "$ROOT/shared/inbox/$INSTANCE.md"
rm -f "$ROOT/shared/logs/$INSTANCE.log"
rm -f "$ROOT/shared/outbox/$INSTANCE-"*.md 2>/dev/null || true

echo "destroyed $INSTANCE"
