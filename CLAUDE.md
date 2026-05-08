# Multi-Agent System — Shared Context

> File này load vào MỌI agent. Mọi agent phải đọc và tuân thủ protocol bên dưới.

## Hệ thống

6 agent Claude Code chạy song song, giao tiếp qua filesystem:

```
User ─chat──▶ Planner (draft spec) ──user-approves-via-UI──▶ Orchestrator
   │                                                                │
   └─chat-direct─▶ Orchestrator ◀────────────────────────────────────┘
                       │
                       ├──▶ Backend Engineer  (Python, API, DB)
                       ├──▶ Frontend Engineer (HTML/CSS/JS, React, Tailwind)
                       ├──▶ AI Engineer       (Prompt, eval, Claude API)
                       └──▶ Reviewer/QA       (Code review, test, security)
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

**Status values:** `todo` | `in_progress` | `review` | `done` | `blocked`

**Quy tắc ghi tasks.json:**
- CHỈ Orchestrator được ghi `tasks.json`.
- Worker muốn đổi status → gửi message vào `shared/inbox/orchestrator.md`, Orchestrator update.
- Khi tạo task mới: lấy id = `T-` + zero-pad của `next_id`, tăng `next_id` thêm 1.

## Logging

Mỗi agent append vào `shared/logs/<role>.log` mỗi action lớn (đọc inbox, ghi code, gửi message, hoàn thành task), format 1 dòng:

```
[YYYY-MM-DD HH:MM] <role> <action> <detail>
```

Ví dụ: `[2026-05-04 12:15] software-engineer wrote project/backend/parsers.py for T-001`

## Turn workflow chung (mọi agent)

Mỗi khi user gõ prompt mới (kể cả "check inbox"), agent thực hiện:

1. **Đọc inbox của mình** → `shared/inbox/<role>.md`. Parse các block tách bằng `---`.
2. Xử lý message (theo role-specific workflow trong `agents/<role>/CLAUDE.md`).
3. Sau khi xử lý xong từng message: archive vào `shared/outbox/`, xoá khỏi inbox.
4. **Log** action vào `shared/logs/<role>.log`.
5. Nếu cần phản hồi → append vào inbox người nhận.

## Quy tắc quan trọng

- **Không sửa file của agent khác:** mỗi agent chỉ ghi vào folder/scope của mình. Muốn agent khác sửa → gửi message.
- **Không ghi đè artifact của task khác:** mỗi task có folder riêng `shared/artifacts/T-XXX/`.
- **Khi blocker:** không tự xoay xở quá 2 lần thử. Set status `blocked` (qua orchestrator) + giải thích trong message.
- **Time:** dùng date của hệ (`date "+%Y-%m-%d %H:%M"`) cho timestamp, không tự bịa.
