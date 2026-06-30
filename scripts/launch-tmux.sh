#!/usr/bin/env bash
# DEPRECATED (API-only): this tmux launcher spawns CLI agents (claude/codex/
# gemini) in panes. The system is now API-only — agents run via
# scripts/agent_runtime.py launched by the Electron app. Kept for reference /
# future CLI revival. See REDESIGN_PLAN.md "CLI removal — hồi sinh tương lai".
#
# launch-tmux.sh — open a tmux session with 9 panes:
#   8 agents + 1 monitor dashboard, in a 3x3 grid.
# Layout:
# +-------------+-------------+-------------+
# |  Planner    |    Orch     |   Monitor   |   row 1
# +-------------+-------------+-------------+
# |     BE      |     FE      |    AIE      |   row 2
# +-------------+-------------+-------------+
# |  BE-rev     |   FE-rev    |   AI-rev    |   row 3
# +-------------+-------------+-------------+

set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "Error: tmux is not installed. Install: brew install tmux"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Warning: 'claude' command not found in PATH."
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required to parse agents-config.json. Install: brew install jq / apt install jq"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="multi-agent"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists. Attach with: tmux attach -t $SESSION"
  exit 1
fi

CLAUDE_FLAGS="--dangerously-skip-permissions"
CFG="$ROOT/shared/agents-config.json"

# Sync AGENT.md to CLI-specific filenames (CLAUDE.md / GEMINI.md / AGENTS.md)
"$ROOT/scripts/sync-agent-md.sh"

# Load API keys (no-op if no secrets configured yet)
# shellcheck disable=SC1091
source "$ROOT/scripts/keyring.sh"

# Build the launch command for an agent role based on its backend.kind in $CFG.
build_agent_cmd() {
  local role="$1"
  local kind
  kind=$(jq -r ".agents.\"$role\".backend.kind // \"claude-cli\"" "$CFG")
  local model
  model=$(jq -r ".agents.\"$role\".model // \"\"" "$CFG")
  case "$kind" in
    claude-cli)
      echo "claude $CLAUDE_FLAGS"
      ;;
    codex-cli)
      if [ -n "$model" ]; then
        echo "codex --model $model"
      else
        echo "codex"
      fi
      ;;
    gemini-cli)
      if [ -n "$model" ]; then
        echo "gemini --yolo --model $model"
      else
        echo "gemini --yolo"
      fi
      ;;
    api-anthropic|api-google|api-openai|lm-studio)
      echo "python3 \"$ROOT/scripts/agent_runtime.py\" --role $role"
      ;;
    *)
      echo "echo 'Unknown backend kind: $kind for role $role' && exec bash"
      ;;
  esac
}

# Use pane_id (e.g. %0, %1) instead of pane_index since tmux can renumber panes
# after splits. Capture each new pane's id with `-P -F '#{pane_id}'`.

# Build the 3x3 grid by first splitting horizontally into 3 rows, then each row into 3 columns.

# row 1 (initial pane = Planner, top-left)
tmux new-session -d -s "$SESSION" -n "agents" -c "$ROOT/agents/planner"
PLANNER=$(tmux display-message -t "$SESSION" -p '#{pane_id}')

# Split into 3 horizontal rows (each ~33% tall)
ROW2_LEFT=$(tmux split-window -v -l '67%' -P -F '#{pane_id}' -t "$PLANNER" -c "$ROOT/agents/backend-engineer")
ROW3_LEFT=$(tmux split-window -v -l '50%' -P -F '#{pane_id}' -t "$ROW2_LEFT" -c "$ROOT/agents/be-reviewer")

# row 1: Planner | Orch | Monitor
ORCH=$(tmux split-window -h -l '67%' -P -F '#{pane_id}' -t "$PLANNER" -c "$ROOT/agents/orchestrator")
MONITOR=$(tmux split-window -h -l '50%' -P -F '#{pane_id}' -t "$ORCH" -c "$ROOT")

# row 2: BE | FE | AIE
BE="$ROW2_LEFT"
FE=$(tmux split-window -h -l '67%' -P -F '#{pane_id}' -t "$BE" -c "$ROOT/agents/frontend-engineer")
AIE=$(tmux split-window -h -l '50%' -P -F '#{pane_id}' -t "$FE" -c "$ROOT/agents/ai-engineer")

# row 3: BE-rev | FE-rev | AI-rev
BEREV="$ROW3_LEFT"
FEREV=$(tmux split-window -h -l '67%' -P -F '#{pane_id}' -t "$BEREV" -c "$ROOT/agents/fe-reviewer")
AIREV=$(tmux split-window -h -l '50%' -P -F '#{pane_id}' -t "$FEREV" -c "$ROOT/agents/ai-reviewer")

# Resolve per-agent launch command from config
PLANNER_CMD=$(build_agent_cmd planner)
ORCH_CMD=$(build_agent_cmd orchestrator)
BE_CMD=$(build_agent_cmd backend-engineer)
FE_CMD=$(build_agent_cmd frontend-engineer)
AIE_CMD=$(build_agent_cmd ai-engineer)
BEREV_CMD=$(build_agent_cmd be-reviewer)
FEREV_CMD=$(build_agent_cmd fe-reviewer)
AIREV_CMD=$(build_agent_cmd ai-reviewer)

# Launch each pane (target by pane_id)
tmux send-keys -t "$MONITOR" "clear && ./scripts/monitor.sh" C-m
tmux send-keys -t "$PLANNER" "clear && echo '=== PLANNER ==='          && $PLANNER_CMD" C-m
tmux send-keys -t "$ORCH"    "clear && echo '=== ORCHESTRATOR ==='     && $ORCH_CMD" C-m
tmux send-keys -t "$BE"      "clear && echo '=== BACKEND ENGINEER ===' && $BE_CMD" C-m
tmux send-keys -t "$FE"      "clear && echo '=== FRONTEND ENGINEER ===' && $FE_CMD" C-m
tmux send-keys -t "$AIE"     "clear && echo '=== AI ENGINEER ==='      && $AIE_CMD" C-m
tmux send-keys -t "$BEREV"   "clear && echo '=== BE REVIEWER ==='      && $BEREV_CMD" C-m
tmux send-keys -t "$FEREV"   "clear && echo '=== FE REVIEWER ==='      && $FEREV_CMD" C-m
tmux send-keys -t "$AIREV"   "clear && echo '=== AI REVIEWER ==='      && $AIREV_CMD" C-m

tmux select-pane -t "$PLANNER"

cat <<INFO
Launched tmux session '$SESSION' with 9 panes (8 agents + monitor) in a 3x3 grid.

Layout:
  Row 1: Planner    | Orch        | Monitor
  Row 2: BE         | FE          | AIE
  Row 3: BE-rev     | FE-rev      | AI-rev

Tmux shortcuts:
  Ctrl-b <arrow>  switch pane
  Ctrl-b z        zoom (toggle fullscreen for current pane)
  Ctrl-b d        detach
  tmux kill-session -t $SESSION

INFO

if [ "${NO_ATTACH:-0}" = "1" ]; then
  echo "NO_ATTACH=1 — session detached, attach with: tmux attach -t $SESSION"
  exit 0
fi

echo "Attaching now..."
tmux attach -t "$SESSION"
