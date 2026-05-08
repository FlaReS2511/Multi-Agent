#!/usr/bin/env bash
# Double-click → kill tmux session + Electron UI.

export PATH="/opt/homebrew/bin:/Users/tom/.local/bin:$PATH"

SESSION="multi-agent"

echo ""
echo "════════════════════════════════════════"
echo "  Multi-Agent Dev Team — Stopping"
echo "════════════════════════════════════════"
echo ""

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "✓ tmux session '$SESSION' đã kill"
else
  echo "✓ tmux session không chạy"
fi

PIDS=$(lsof -ti:5173 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  pkill -f "multi-agent/project/frontend" 2>/dev/null || true
  kill $PIDS 2>/dev/null || true
  echo "✓ Electron UI đã kill"
else
  echo "✓ Electron UI không chạy"
fi

echo ""
echo "Đóng cửa sổ này khi sẵn sàng."
read -n 1 -s -r -p "Nhấn phím bất kỳ để thoát..."
echo ""
