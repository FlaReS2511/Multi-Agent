#!/usr/bin/env bash
# Double-click trong Finder → bật Electron UI + tmux session, attach ngay vào Terminal window này.

set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/tom/.local/bin:$PATH"

ROOT="$(cd "$(dirname "$0")" && pwd)"
SESSION="multi-agent"

cd "$ROOT"

echo ""
echo "════════════════════════════════════════"
echo "  Multi-Agent Dev Team — Starting up"
echo "════════════════════════════════════════"
echo ""

# 1) Electron UI
if lsof -ti:5173 >/dev/null 2>&1; then
  echo "✓ Electron UI đã chạy sẵn ở :5173"
else
  echo "▶ Khởi động Electron UI (log: /tmp/multi-agent-ui.log)..."
  ( cd "$ROOT/project/frontend" && nohup npm run dev > /tmp/multi-agent-ui.log 2>&1 & disown )
fi

# 2) tmux session — delegate to launch-tmux.sh
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "✓ tmux session '$SESSION' đã tồn tại"
else
  echo "▶ Tạo tmux session '$SESSION' (layout 3×2 + monitor, 7 panes)..."
  NO_ATTACH=1 "$ROOT/scripts/launch-tmux.sh"
fi

echo ""
echo "▶ Attaching tmux trong 2s..."
echo "  (Ctrl-b d để detach, dừng tất cả: chạy stop.command)"
sleep 2
exec tmux attach -t "$SESSION"
