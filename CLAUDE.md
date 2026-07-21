# Multi-Agent System — Shared Context

> File này load vào MỌI agent. Mọi agent phải đọc và tuân thủ protocol bên dưới.

> **KIẾN TRÚC HIỆN TẠI (v0.4): API-ONLY + SQLite.**
> - State động (tasks, messages/inbox, usage, logs, secrets) sống trong **`shared/state.db`** (SQLite), KHÔNG còn ở file markdown/JSON. `shared/agents-config.json` vẫn là file (config tĩnh).
> - Agent chạy qua **API provider** (`project/frontend/electron/agent-runtime.ts`, được Electron spawn dưới dạng `agent-runtime.js` — bản Python `scripts/agent_runtime.py` cũ đã xoá), không còn CLI (Claude Code/Codex/Gemini). Provider khai động trong `agents-config.json` → `providers` (kind + base_url + models). Cắm được VietAPI và mọi OpenAI-compatible/Anthropic/OpenAI/Google.
> - Agent giao tiếp bằng **tools** do runtime cấp: `SendMessage`, `ListTasks`, `CreateTask`/`UpdateTask` (orchestrator only) — KHÔNG đọc/ghi file inbox/tasks.json bằng tay.
> - Phần mô tả file-based bên dưới giữ lại cho bối cảnh lịch sử; chỗ nào nói "ghi `shared/inbox/*.md`" hay "ghi `tasks.json`" nay thay bằng tool tương ứng. Xem `REDESIGN_PLAN.md`.

## Hệ thống

8 agent chạy song song, điều phối qua **SQLite (`shared/state.db`)**. Mỗi agent chạy bằng một API provider chọn per-agent qua `shared/agents-config.json` (provider + model). UI là Electron app (`project/frontend`).

Agents:
- `planner`, `orchestrator` — coordination (pre-warmed)
- `backend-engineer`, `frontend-engineer`, `ai-engineer` — workers (lazy spawn)
- `be-reviewer`, `fe-reviewer`, `ai-reviewer` — per-domain reviewers (lazy spawn)

**Spawn policy:** chỉ `orchestrator` + `planner` spawn lúc Electron khởi động. 6 agent còn lại spawn khi (a) inbox của họ có message mới, hoặc (b) user mở tab Terminals của họ. PTY bị kill sau 15 phút idle (pre-warmed agent miễn). Sau 5 giây spawn fresh, runtime gửi "check inbox" để CLI có thời gian load context.

```
User ─chat──▶ Planner (draft spec) ──user-approves-via-UI──▶ Orchestrator
   │                                                                │
   └─chat-direct─▶ Orchestrator ◀────────────────────────────────────┘
                       │
                       ├──▶ Backend Engineer  (Python, API, DB)
                       ├──▶ Frontend Engineer (HTML/CSS/JS, React, Tailwind)
                       ├──▶ AI Engineer       (Prompt, eval, model wiring)
                       ├──▶ BE Reviewer       (Python review, pytest, security)
                       ├──▶ FE Reviewer       (TypeScript review, a11y, build)
                       └──▶ AI Reviewer       (prompt review, eval, schema)
```

- **Planner** đối thoại với user để build spec, ghi vào `agents/planner/workspace/current-draft.md`. KHÔNG tự gửi inbox. User bấm Approve trong Electron Plan Composer → UI ghi message vào inbox Orchestrator.
- **Orchestrator** là điểm điều phối duy nhất. Nhận request từ user (chat trực tiếp), Planner (qua UI approve), hoặc UI New Task. Là agent duy nhất ghi `tasks.json`.
- Workers (BE, FE, AIE, Reviewer) chỉ giao tiếp với nhau qua Orchestrator.
- Phân chia: BE phụ trách Python/server, FE phụ trách UI client. Không overlap.

## Path quan trọng (absolute)

| Path | Mục đích |
|------|----------|
| `/Users/tom/Downloads/multi-agent/shared/inbox/<role>.md` | Inbox của mỗi agent (gồm `planner.md`, `orchestrator.md`, 4 worker) |
| `/Users/tom/Downloads/multi-agent/shared/outbox/` | Log message đã xử lý |
| `/Users/tom/Downloads/multi-agent/shared/tasks.json` | Task board (chỉ Orchestrator ghi) |
| `/Users/tom/Downloads/multi-agent/shared/artifacts/<task-id>/` | Output cụ thể của task (code link, eval, review) |
| `/Users/tom/Downloads/multi-agent/shared/logs/<role>.log` | Activity log riêng từng agent |
| `/Users/tom/Downloads/multi-agent/agents/planner/workspace/current-draft.md` | Draft spec Planner đang viết, UI poll file này |
| `/Users/tom/Downloads/multi-agent/project/` | Codebase đang được build (backend Python, frontend TS) |

## Message format (inbox)

Mỗi message là một block markdown, append vào cuối inbox file của người nhận. Format BẮT BUỘC:

```
## [YYYY-MM-DD HH:MM] FROM: <sender> | TO: <receiver> | TASK: T-XXX
**Subject:** <1 dòng tóm tắt>
**Priority:** low | medium | high
**Deps:** T-YYY done | none

<Nội dung chi tiết, có thể nhiều dòng. Link đến artifact nếu có.>

---
```

- `T-XXX` là id từ `tasks.json`. Nếu chưa có id (message khởi tạo), dùng `T-000`.
- Sau `---` là kết thúc 1 message. Đọc inbox = đọc các block tách bằng `---`.
- **Sau khi xử lý xong 1 message:** copy block đó vào `shared/outbox/<receiver>-YYYY-MM-DD.md` rồi xoá khỏi inbox để tránh xử lý lại.

## `tasks.json` schema

```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "Parse CSV in backend",
      "owner": "software-engineer",
      "status": "todo",
      "deps": [],
      "created_at": "2026-05-04 12:00",
      "updated_at": "2026-05-04 12:00",
      "artifact": "shared/artifacts/T-001/"
    }
  ],
  "next_id": 2
}
```

**Status values:** `todo` | `in_progress` | `review` | `done` | `blocked` | `waiting_children`

**HTN fields (depth cap = 2):**
- `parent_id: string | null` — null cho root task. Nếu có giá trị, task này là child của task đó.
- `children: string[]` — list ID của children. Rỗng cho leaf hoặc task chưa split.
- Status `waiting_children` áp dụng cho parent task đang chờ tất cả children done. Khi tất cả children = `done`, Orchestrator flip parent → `review` hoặc `done`.
- Hard cap: child không được có children. IPC `create-task` / `split-task` reject grandchild.

**Quy tắc ghi tasks.json:**
- CHỈ Orchestrator được ghi `tasks.json`.
- Worker muốn đổi status → gửi message vào `shared/inbox/orchestrator.md`, Orchestrator update.
- Khi tạo task mới: lấy id = `T-` + zero-pad của `next_id`, tăng `next_id` thêm 1.
- Khi split task: dùng IPC `split-task` (qua Electron) hoặc ghi tay parent.children + children's parent_id. Set parent.status = `waiting_children`.

## Logging

Mỗi agent append vào `shared/logs/<role>.log` mỗi action lớn (đọc inbox, ghi code, gửi message, hoàn thành task), format 1 dòng:

```
[YYYY-MM-DD HH:MM] <role> <action> <detail>
```

Ví dụ: `[2026-05-04 12:15] software-engineer wrote project/backend/parsers.py for T-001`

## Turn workflow chung (mọi agent)

Mỗi khi user gõ prompt mới (kể cả "check inbox"), agent thực hiện:

1. **Đọc inbox của mình** → `shared/inbox/<role>.md`. Parse các block tách bằng `---`.
2. Xử lý message (theo role-specific workflow trong `agents/<role>/AGENT.md` — file context canonical, được launcher copy ra `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` cho từng CLI).
3. Sau khi xử lý xong từng message: archive vào `shared/outbox/`, xoá khỏi inbox.
4. **Log** action vào `shared/logs/<role>.log`.
5. Nếu cần phản hồi → append vào inbox người nhận.

## Quy tắc quan trọng

- **Không sửa file của agent khác:** mỗi agent chỉ ghi vào folder/scope của mình. Muốn agent khác sửa → gửi message.
- **Không ghi đè artifact của task khác:** mỗi task có folder riêng `shared/artifacts/T-XXX/`.
- **Khi blocker:** không tự xoay xở quá 2 lần thử. Set status `blocked` (qua orchestrator) + giải thích trong message.
- **Time:** dùng date của hệ (`date "+%Y-%m-%d %H:%M"`) cho timestamp, không tự bịa.
