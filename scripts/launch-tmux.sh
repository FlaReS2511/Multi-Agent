#!/usr/bin/env bash
# launch-tmux.sh — mở tmux session 7 panes:
#   6 agent panes (3×2 grid) + 1 monitor dashboard ở dưới
# Layout:
# +---------+---------+---------+
# | Planner | Orch    | Review  |   row 1
# +---------+---------+---------+
# |   BE    |   FE    |  AIE    |   row 2
# +---------+---------+---------+
# |   Monitor (full width)      |   row 3
# +-----------------------------+

set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "Error: tmux is not installed. Install: brew install tmux"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Warning: 'claude' command not found in PATH."
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="multi-agent"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists. Attach with: tmux attach -t $SESSION"
  exit 1
fi

CLAUDE_FLAGS="--dangerously-skip-permissions"

# Use pane_id (e.g. %0, %1) instead of pane_index since tmux can renumber panes
# after splits. Capture each new pane's id with `-P -F '#{pane_id}'`.

# Start with Planner pane (default pane from new-session)
tmux new-session -d -s "$SESSION" -n "agents" -c "$ROOT/agents/planner"
PLANNER=$(tmux display-message -t "$SESSION" -p '#{pane_id}')

# Split off monitor pane at the bottom (28%) — full width
MONITOR=$(tmux split-window -v -l '28%' -P -F '#{pane_id}' -t "$PLANNER" -c "$ROOT")

# Split planner pane vertically → row 2 (BE area, below planner)
BE=$(tmux split-window -v -P -F '#{pane_id}' -t "$PLANNER" -c "$ROOT/agents/backend-engineer")

# Row 1: split planner horizontally twice → Planner | Orch | Reviewer (3 cột bằng nhau ~33% mỗi cột)
# First split: Planner shrinks to 33%, Orch takes 67% of remaining
ORCH=$(tmux split-window -h -l '67%' -P -F '#{pane_id}' -t "$PLANNER" -c "$ROOT/agents/orchestrator")
# Second split: Orch shrinks to 50% of its 67%, Reviewer takes 50% → both end at 33%
REVIEWER=$(tmux split-window -h -l '50%' -P -F '#{pane_id}' -t "$ORCH" -c "$ROOT/agents/reviewer")

# Row 2: same logic
FE=$(tmux split-window -h -l '67%' -P -F '#{pane_id}' -t "$BE" -c "$ROOT/agents/frontend-engineer")
AIE=$(tmux split-window -h -l '50%' -P -F '#{pane_id}' -t "$FE" -c "$ROOT/agents/ai-engineer")

# Launch monitor + claude in each agent pane (target by pane_id, immune to renumber)
tmux send-keys -t "$MONITOR"  "clear && ./scripts/monitor.sh" C-m
tmux send-keys -t "$PLANNER"  "clear && echo '=== PLANNER ==='          && claude $CLAUDE_FLAGS" C-m
tmux send-keys -t "$ORCH"     "clear && echo '=== ORCHESTRATOR ==='     && claude $CLAUDE_FLAGS" C-m
tmux send-keys -t "$REVIEWER" "clear && echo '=== REVIEWER ==='         && claude $CLAUDE_FLAGS" C-m
tmux send-keys -t "$BE"       "clear && echo '=== BACKEND ENGINEER ===' && claude $CLAUDE_FLAGS" C-m
tmux send-keys -t "$FE"       "clear && echo '=== FRONTEND ENGINEER ===' && claude $CLAUDE_FLAGS" C-m
tmux send-keys -t "$AIE"      "clear && echo '=== AI ENGINEER ==='      && claude $CLAUDE_FLAGS" C-m

tmux select-pane -t "$PLANNER"

# Show pane id → role map so user can reference (and for debugging)
PLANNER_IDX=$(tmux display-message -t "$PLANNER" -p '#{pane_index}')
ORCH_IDX=$(tmux display-message -t "$ORCH" -p '#{pane_index}')
REVIEWER_IDX=$(tmux display-message -t "$REVIEWER" -p '#{pane_index}')
BE_IDX=$(tmux display-message -t "$BE" -p '#{pane_index}')
FE_IDX=$(tmux display-message -t "$FE" -p '#{pane_index}')
AIE_IDX=$(tmux display-message -t "$AIE" -p '#{pane_index}')
MONITOR_IDX=$(tmux display-message -t "$MONITOR" -p '#{pane_index}')

cat <<INFO
Launched tmux session '$SESSION' with 7 panes (6 agents + monitor).

Layout (actual pane indices):
  Row 1: Planner ($PLANNER_IDX) | Orch ($ORCH_IDX) | Reviewer ($REVIEWER_IDX)
  Row 2: BE      ($BE_IDX) | FE   ($FE_IDX) | AIE      ($AIE_IDX)
  Row 3: Monitor ($MONITOR_IDX, full width)

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
