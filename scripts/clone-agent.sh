#!/usr/bin/env bash
# clone-agent.sh — create a new instance of a clonable role.
#
# Usage:
#   scripts/clone-agent.sh <base-role>
#
# Picks the next free `<base-role>-<n>` slot (n=2,3,...), copies the base
# role's AGENT.md + workspace dir, appends a config entry copied from the base,
# and runs sync-agent-md.sh so CLI-specific context filenames exist.
#
# Echoes the new instance ID on success. Exits non-zero on cap exceeded or
# invalid base. Soft cap: warns at 6+ but does not block.
#
# JSON manipulation goes through Node (guaranteed by Electron) so this works
# even on a Windows shell without jq.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <base-role>" >&2
  exit 2
fi

BASE="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/shared/agents-config.json"

CLONABLE=(backend-engineer frontend-engineer ai-engineer be-reviewer fe-reviewer ai-reviewer)
ok=0
for r in "${CLONABLE[@]}"; do [ "$r" = "$BASE" ] && ok=1; done
if [ $ok -eq 0 ]; then
  echo "error: '$BASE' is not a clonable role. Allowed: ${CLONABLE[*]}" >&2
  exit 3
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node required" >&2
  exit 4
fi
if [ ! -f "$CFG" ]; then
  echo "error: $CFG missing" >&2
  exit 5
fi

# Use Node to read config and append an entry. Echoes the new instance id.
INSTANCE=$(node -e '
  const fs = require("fs");
  const [base, cfgPath] = process.argv.slice(1);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  cfg.agents ||= {};
  let n = 2;
  while (cfg.agents[`${base}-${n}`]) n++;
  const instance = `${base}-${n}`;
  cfg.agents[instance] = JSON.parse(JSON.stringify(cfg.agents[base] || {}));
  // Soft cap warning at 6+ instances (= base + 5 clones)
  const total = Object.keys(cfg.agents).filter(k => k === base || k.startsWith(`${base}-`)).length;
  if (total >= 6) {
    console.error(`warn: ${base} already has ${total} instances; consider destroying idle clones to save RAM`);
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  process.stdout.write(instance);
' "$BASE" "$CFG")

# Copy AGENT.md + workspace from base
SRC_DIR="$ROOT/agents/$BASE"
DST_DIR="$ROOT/agents/$INSTANCE"
if [ ! -f "$SRC_DIR/AGENT.md" ]; then
  echo "error: $SRC_DIR/AGENT.md missing — base role not initialised" >&2
  exit 6
fi
mkdir -p "$DST_DIR/workspace"
cp "$SRC_DIR/AGENT.md" "$DST_DIR/AGENT.md"
echo "$BASE" > "$DST_DIR/.clone-of"

# Ensure inbox file exists
mkdir -p "$ROOT/shared/inbox"
touch "$ROOT/shared/inbox/$INSTANCE.md"

# Sync per-CLI context filenames (CLAUDE.md / GEMINI.md / AGENTS.md)
"$ROOT/scripts/sync-agent-md.sh" >/dev/null 2>&1 || true

echo "$INSTANCE"
