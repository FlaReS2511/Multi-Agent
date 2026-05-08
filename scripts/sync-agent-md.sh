#!/usr/bin/env bash
# sync-agent-md.sh — copy agents/<role>/AGENT.md to CLAUDE.md/GEMINI.md/AGENTS.md
# so each CLI (Claude Code, Gemini CLI, Codex CLI) can auto-load its expected
# context filename. AGENT.md is the canonical source; the three copies are
# regenerated on each launch and gitignored.
#
# Roles are derived dynamically from `shared/agents-config.json` keys so that
# clones added by `scripts/clone-agent.sh` get synced automatically. Falls back
# to a fixed list if Node or the config file is unavailable.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/shared/agents-config.json"

ROLES=()
if command -v node >/dev/null 2>&1 && [ -f "$CFG" ]; then
  while IFS= read -r role; do
    ROLES+=("$role")
  done < <(node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    for (const k of Object.keys(cfg.agents || {})) console.log(k);
  " "$CFG")
fi

if [ "${#ROLES[@]}" -eq 0 ]; then
  echo "warn: falling back to default role list (config missing or node unavailable)" >&2
  ROLES=(planner orchestrator backend-engineer frontend-engineer ai-engineer be-reviewer fe-reviewer ai-reviewer)
fi

for role in "${ROLES[@]}"; do
  src="$ROOT/agents/$role/AGENT.md"
  if [ ! -f "$src" ]; then
    echo "warn: $src missing, skipping $role" >&2
    continue
  fi
  cp "$src" "$ROOT/agents/$role/CLAUDE.md"
  cp "$src" "$ROOT/agents/$role/GEMINI.md"
  cp "$src" "$ROOT/agents/$role/AGENTS.md"
done

echo "Synced AGENT.md -> CLAUDE.md/GEMINI.md/AGENTS.md for ${#ROLES[@]} roles"
