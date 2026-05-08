#!/usr/bin/env bash
# send.sh — gửi message vào inbox của một agent
# Usage: ./scripts/send.sh <to-agent> <from-agent> <task-id> "<message body>"
# Example: ./scripts/send.sh software-engineer orchestrator T-001 "Hãy tạo file project/backend/hello.py"

set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 <to-agent> <from-agent> <task-id> \"<message body>\""
  echo "Agents: orchestrator | software-engineer | ai-engineer | reviewer"
  exit 1
fi

TO="$1"
FROM="$2"
TASK="$3"
BODY="$4"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INBOX="$ROOT/shared/inbox/$TO.md"
OUTBOX_DIR="$ROOT/shared/outbox"

if [ ! -f "$INBOX" ]; then
  echo "Error: inbox file not found: $INBOX"
  echo "Valid agents: orchestrator, software-engineer, ai-engineer, reviewer"
  exit 1
fi

TS="$(date '+%Y-%m-%d %H:%M')"
DATE="$(date '+%Y-%m-%d')"

{
  echo ""
  echo "## [$TS] FROM: $FROM | TO: $TO | TASK: $TASK"
  echo ""
  echo "$BODY"
  echo ""
  echo "---"
} >> "$INBOX"

mkdir -p "$OUTBOX_DIR"
{
  echo "[$TS] $FROM -> $TO | $TASK"
  echo "$BODY" | head -c 200
  echo ""
  echo "---"
} >> "$OUTBOX_DIR/sent-$DATE.log"

echo "Sent to $TO inbox: $INBOX"
