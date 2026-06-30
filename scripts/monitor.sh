#!/usr/bin/env bash
# DEPRECATED (API-only): this terminal dashboard reads shared/inbox/*.md,
# shared/logs/*.log and tasks.json, which no longer exist — state is in
# shared/state.db and surfaced by the Electron UI. Kept for reference.
#
# monitor.sh — live dashboard hiển thị hoạt động của tất cả agent
# Usage:
#   ./scripts/monitor.sh           # Live mode (refresh 2s, dùng watch nếu có)
#   ./scripts/monitor.sh --once    # Render 1 lần rồi thoát

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED="$ROOT/shared"
AGENTS=(planner orchestrator backend-engineer frontend-engineer ai-engineer reviewer)

# ANSI colors
BOLD=$'\033[1m'
DIM=$'\033[2m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BLUE=$'\033[34m'
MAGENTA=$'\033[35m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

render() {
  clear
  printf "%s=== MULTI-AGENT MONITOR ===%s   %s\n" "$BOLD$CYAN" "$RESET" "$(date '+%Y-%m-%d %H:%M:%S')"
  printf "%sRoot:%s %s\n\n" "$DIM" "$RESET" "$ROOT"

  # ---- Tasks ----
  printf "%s── TASKS ──%s\n" "$BOLD" "$RESET"
  if [ -f "$SHARED/tasks.json" ]; then
    if command -v jq >/dev/null 2>&1; then
      local count
      count=$(jq '.tasks | length' "$SHARED/tasks.json")
      if [ "$count" = "0" ]; then
        printf "  %s(no tasks yet)%s\n" "$DIM" "$RESET"
      else
        jq -r '.tasks[] | "\(.id)|\(.status)|\(.owner)|\(.title)"' "$SHARED/tasks.json" | \
        while IFS='|' read -r id status owner title; do
          local color="$DIM"
          case "$status" in
            todo)        color="$YELLOW" ;;
            in_progress) color="$BLUE" ;;
            review)      color="$MAGENTA" ;;
            done)        color="$GREEN" ;;
            blocked)     color="$RED" ;;
          esac
          printf "  %s[%-11s]%s %-8s %-20s %s\n" "$color" "$status" "$RESET" "$id" "$owner" "$title"
        done
      fi
    else
      printf "  %s(install jq for formatted output)%s\n" "$DIM" "$RESET"
      cat "$SHARED/tasks.json" | head -20
    fi
  else
    printf "  %s(tasks.json missing)%s\n" "$RED" "$RESET"
  fi
  echo

  # ---- Inbox queue ----
  printf "%s── INBOX QUEUE ──%s\n" "$BOLD" "$RESET"
  for a in "${AGENTS[@]}"; do
    local f="$SHARED/inbox/$a.md"
    if [ -f "$f" ]; then
      # Đếm số message bằng cách đếm separator '---'
      local n
      n=$(awk '/^---$/ {c++} END {print c+0}' "$f")
      local color="$DIM"
      [ "$n" -gt 0 ] && color="$YELLOW"
      printf "  %s%-22s%s %s%2d msg%s\n" "$BOLD" "$a" "$RESET" "$color" "$n" "$RESET"
    else
      printf "  %-22s %s(no inbox)%s\n" "$a" "$RED" "$RESET"
    fi
  done
  echo

  # ---- Recent activity per agent ----
  printf "%s── RECENT ACTIVITY (last 4 lines per agent) ──%s\n" "$BOLD" "$RESET"
  for a in "${AGENTS[@]}"; do
    printf "  %s[%s]%s\n" "$CYAN" "$a" "$RESET"
    local log="$SHARED/logs/$a.log"
    if [ -f "$log" ] && [ -s "$log" ]; then
      tail -n 4 "$log" | sed 's/^/    /'
    else
      printf "    %s(no activity yet)%s\n" "$DIM" "$RESET"
    fi
  done
  echo

  # ---- Footer ----
  printf "%sCtrl-C to exit. Refresh: 2s.%s\n" "$DIM" "$RESET"
}

# Mode: --once or live
if [ "${1:-}" = "--once" ]; then
  render
  exit 0
fi

# Live loop (works without `watch` since `watch` doesn't render ANSI from functions reliably)
trap 'echo; echo "Monitor stopped."; exit 0' INT
while true; do
  render
  sleep 2
done
