# Multi-Agent Dev Team

Hệ multi-agent gồm 4 agent Claude Code chạy song song trong 4 terminal khác nhau, giao tiếp qua filesystem để cùng build software + AI feature.

## Roles

| Role | Nhiệm vụ |
|------|----------|
| **Orchestrator** | PM/Lead — nhận yêu cầu user, chia task, điều phối |
| **Backend Engineer** | Python: API server, business logic, DB |
| **Frontend Engineer** | HTML/CSS/JS, React, Tailwind, UI components |
| **AI Engineer** | Prompt engineering, model, eval |
| **Reviewer/QA** | Code review, test, security |

## Cách chạy

```bash
./scripts/launch-tmux.sh         # Mở tmux 5 panes: 4 agent (2x2) + monitor CLI
./scripts/monitor.sh             # Live CLI dashboard (terminal)
./scripts/send.sh <to> <from> <task-id> "<message>"   # Gửi message vào inbox
./scripts/reset.sh               # Xoá inbox/logs/tasks.json để test lại
```

### Desktop UI (Electron)

Dashboard đẹp hơn dạng desktop app:

```bash
cd project/frontend
npm install        # Lần đầu (~250MB, đa phần là Electron binary)
npm run dev        # Mở cửa sổ Electron, hot-reload khi sửa React
```

App đọc trực tiếp `shared/tasks.json`, `shared/inbox/*.md`, `shared/logs/*.log`. Polling 2s.

User nói chuyện với Orchestrator (pane 0). Các agent tự đọc inbox của mình mỗi turn. Monitor pane (dưới) hiển thị live: tasks status, inbox queue, recent activity.

**Tmux shortcuts:**
- `Ctrl-b <arrow>` — chuyển pane
- `Ctrl-b z` — zoom pane đang focus (fullscreen toggle)
- `Ctrl-b d` — detach (giữ session chạy nền)

## Folder

```
agents/<role>/         # CLAUDE.md per-role + workspace/ (notes riêng)
shared/                # inbox/, outbox/, tasks.json, artifacts/, logs/
project/               # Codebase mà agent build (backend Python, frontend TS)
scripts/               # send.sh, launch-tmux.sh, reset.sh
PLAN.md                # Plan gốc của hệ
```

Xem `CLAUDE.md` ở root để hiểu protocol giao tiếp + format message.
