# Multi-Agent System (Claude Code, multi-terminal)

## Context

Bạn muốn **tự build từ scratch** một hệ multi-agent để vừa học vừa dùng cho công việc software dev + AI engineer. Sau khi trao đổi:

- **Cách chạy:** mỗi agent là **một phiên Claude Code riêng trong một terminal** (không dùng Agent SDK, không dùng framework như CrewAI). Agent giao tiếp qua **filesystem shared** (inbox files, task board).
- **Kiến trúc:** Orchestrator + workers — một agent "lead" điều phối, các agent khác là chuyên môn.
- **Quy mô MVP:** 3–4 agent, design **modular** để cắm thêm role (DevOps, Researcher, MLOps...) sau.
- **Project được build BY các agent:** monorepo Python + TypeScript (do bạn đã chọn).

Mục tiêu của plan này là dựng **bộ khung** (folder, CLAUDE.md per-role, kênh giao tiếp, script launch tmux) để bạn chỉ cần mở terminal và bắt đầu thử nghiệm.

## Roles MVP (4 agent)

Chọn ra 4 role phủ được cả software dev + AI engineer, mỗi role có vai trò rõ ràng, không trùng lặp:

| # | Role | Trách nhiệm chính | Output |
|---|------|-------------------|--------|
| 1 | **Orchestrator (PM/Lead)** | Nhận yêu cầu từ user, chia task, theo dõi `tasks.json`, route message giữa các agent | Plan, task assignments, status report |
| 2 | **Software Engineer** | Viết code feature (Python backend + TS frontend), refactor, fix bug | Source code, PRs, commits |
| 3 | **AI Engineer** | Prompt engineering, chọn model, viết eval, xử lý data, integrate Claude API | Prompts, eval scripts, AI module |
| 4 | **Reviewer/QA** | Review code + AI output, viết test, security check, kiểm tra eval pass | Review notes, test files, approval/reject |

**Mở rộng sau (chưa làm trong MVP, nhưng folder structure phải hỗ trợ thêm dễ dàng):**
- `architect/` — thiết kế hệ thống trước khi engineer code
- `devops/` — CI/CD, deploy, monitoring
- `researcher/` + `doc-writer/` — nghiên cứu tech mới, viết docs
- `data-engineer/` + `mlops/` — pipeline data, model deployment

## Kiến trúc giao tiếp (file-based message passing)

Vì các Claude Code instance không share memory, dùng filesystem làm message bus:

```
shared/
├── inbox/                     # Mỗi agent có 1 inbox markdown file
│   ├── orchestrator.md
│   ├── software-engineer.md
│   ├── ai-engineer.md
│   └── reviewer.md
├── outbox/                    # Log message đã xử lý (để debug)
├── tasks.json                 # Task board chung: id, owner, status, deps
├── artifacts/                 # Code, eval results, docs sinh ra
└── logs/                      # Activity log mỗi agent append vào
```

**Protocol giao tiếp** (định nghĩa rõ trong shared `CLAUDE.md`):

- Gửi message: agent A append một block vào `shared/inbox/<agent-B>.md` theo format:
  ```
  ## [2026-05-04 11:55] FROM: orchestrator | TASK: T-003
  Vui lòng implement function parse_csv() trong workspace/parsers.py.
  Spec: ... | Deps: T-001 done | Priority: high
  ---
  ```
- Đọc message: agent kiểm tra inbox của mình mỗi khi bắt đầu turn mới (orchestrator nhắc trong CLAUDE.md per-role).
- Update task: chỉ orchestrator được ghi `tasks.json`; worker báo status qua inbox.
- Artifact: worker ghi vào `shared/artifacts/<task-id>/...`, link trong inbox reply.

## Cấu trúc thư mục đề xuất

```
/Users/tom/Downloads/multi-agent/
├── README.md                          # Hướng dẫn chạy hệ
├── CLAUDE.md                          # Context chung cho mọi agent (protocol, paths)
├── agents/
│   ├── orchestrator/
│   │   ├── CLAUDE.md                  # Role: PM/Lead, có quyền ghi tasks.json
│   │   └── workspace/                 # Notes, plans riêng của orchestrator
│   ├── software-engineer/
│   │   ├── CLAUDE.md                  # Role: full-stack dev (Python + TS)
│   │   └── workspace/
│   ├── ai-engineer/
│   │   ├── CLAUDE.md                  # Role: prompt/model/eval
│   │   └── workspace/
│   └── reviewer/
│       ├── CLAUDE.md                  # Role: code review + QA + security
│       └── workspace/
├── shared/
│   ├── inbox/{orchestrator,software-engineer,ai-engineer,reviewer}.md
│   ├── outbox/
│   ├── tasks.json
│   ├── artifacts/
│   └── logs/
├── project/                           # Codebase mà các agent đang build
│   ├── backend/                       # Python (FastAPI hoặc tuỳ chọn)
│   └── frontend/                      # TypeScript (Next.js hoặc tuỳ chọn)
└── scripts/
    ├── launch-tmux.sh                 # Mở 4 tmux panes, mỗi pane chạy claude trong agent folder
    ├── send.sh                        # Helper: ./send.sh <to-agent> "message"
    └── reset.sh                       # Xoá inbox/logs để test lại từ đầu
```

## Task breakdown cho người code (tasks rất nhỏ, làm tuần tự)

> Mỗi task là 1 bước cụ thể, làm được trong vài phút. Hoàn thành xong từng task rồi mới sang task kế tiếp. Không skip, không gộp.

### Phase A — Skeleton folder & file rỗng

- [ ] **A1.** Tạo cây thư mục với 1 lệnh:
  ```
  mkdir -p agents/{orchestrator,software-engineer,ai-engineer,reviewer}/workspace \
           shared/{inbox,outbox,artifacts,logs} \
           project/{backend,frontend} \
           scripts
  ```
- [ ] **A2.** Tạo 4 file inbox rỗng: `shared/inbox/{orchestrator,software-engineer,ai-engineer,reviewer}.md`
- [ ] **A3.** Tạo `shared/tasks.json` với nội dung: `{"tasks": [], "next_id": 1}`
- [ ] **A4.** Tạo `.gitkeep` trong `shared/outbox/`, `shared/artifacts/`, `shared/logs/`, `project/backend/`, `project/frontend/` để giữ folder.

### Phase B — Tài liệu gốc

- [ ] **B1.** Viết `README.md` (root) — chỉ gồm: tên dự án, mô tả 2 dòng, cách chạy (`./scripts/launch-tmux.sh`), sơ đồ folder tóm tắt. Tối đa ~40 dòng.
- [ ] **B2.** Viết `CLAUDE.md` (root) gồm các section:
  - Mục đích hệ + sơ đồ 4 agent
  - Path quan trọng (inbox, tasks.json, artifacts, logs)
  - **Message format chuẩn** (header `## [timestamp] FROM: x | TO: y | TASK: T-xxx` + body + `---` separator)
  - **`tasks.json` schema** (id, title, owner, status: `todo|in_progress|review|done|blocked`, deps[], created_at, updated_at)
  - Quy tắc: chỉ orchestrator ghi `tasks.json`; mọi agent append vào `shared/logs/<role>.log` mỗi action lớn.

### Phase C — CLAUDE.md từng role (4 file, mỗi file 1 task)

> Mỗi role file có cùng skeleton: **Identity → Responsibilities → Boundaries (không được làm) → Turn workflow → Message templates → Ví dụ**

- [ ] **C1.** `agents/orchestrator/CLAUDE.md`:
  - Identity: PM/Lead, là điểm vào duy nhất với user.
  - Quyền: ghi `tasks.json`, gửi inbox cho mọi agent.
  - Turn workflow: (1) đọc `shared/inbox/orchestrator.md` (2) đọc `tasks.json` (3) plan/route (4) cập nhật `tasks.json` (5) gửi inbox cho worker.
  - Cấm: tự code, tự review (đó là việc worker).
- [ ] **C2.** `agents/software-engineer/CLAUDE.md`:
  - Identity: full-stack dev (Python backend trong `project/backend/`, TS frontend trong `project/frontend/`).
  - Turn workflow: đọc inbox → pick task → code trong `project/` → log artifact path → reply orchestrator + ping reviewer.
  - Cấm: ghi `tasks.json` trực tiếp, sửa code AI engineer đã ghi (phải qua message).
- [ ] **C3.** `agents/ai-engineer/CLAUDE.md`:
  - Identity: prompt + model + eval.
  - Workspace: viết prompt template trong `project/backend/ai/`, eval scripts trong `project/backend/evals/`.
  - Turn workflow: đọc inbox → viết/tinh chỉnh prompt → chạy eval → ghi kết quả vào `shared/artifacts/<task-id>/eval.md` → reply.
  - Cấm: deploy model, sửa frontend.
- [ ] **C4.** `agents/reviewer/CLAUDE.md`:
  - Identity: code review + QA + security.
  - Quyền: read-only `project/`, ghi report vào `shared/artifacts/<task-id>/review.md`.
  - Turn workflow: đọc inbox → đọc code/eval cần review → viết review note (approve/changes-requested) → reply tác giả + orchestrator.
  - Cấm: tự sửa code (chỉ ghi feedback).

### Phase D — Scripts (3 file shell)

- [ ] **D1.** `scripts/send.sh`: nhận `<to-agent> <from-agent> <task-id> <message>`, append đúng format vào `shared/inbox/<to-agent>.md` + log vào `shared/outbox/`. Set `chmod +x`.
- [ ] **D2.** `scripts/launch-tmux.sh`: tạo tmux session `multi-agent`, split 4 panes (2×2), mỗi pane `cd agents/<role> && claude`. Set `chmod +x`. Có check `command -v tmux` đầu file.
- [ ] **D3.** `scripts/reset.sh`: hỏi xác nhận (`read -p`), xoá nội dung `shared/inbox/*.md`, `shared/outbox/*`, `shared/logs/*`, reset `tasks.json` về `{"tasks": [], "next_id": 1}`. Set `chmod +x`.

### Phase E — Smoke test thủ công

- [ ] **E1.** Chạy `./scripts/launch-tmux.sh`, xác nhận 4 panes mở, mỗi pane Claude Code load đúng CLAUDE.md role.
- [ ] **E2.** Trong pane orchestrator gõ: "Hãy giao task tạo `project/backend/hello.py` in 'hi' cho SE". Xem orchestrator có ghi `tasks.json` + gửi inbox SE không.
- [ ] **E3.** Trong pane SE gõ "check inbox" → SE đọc task → tạo file → reply.
- [ ] **E4.** Trong pane reviewer gõ "check inbox" → review → approve.
- [ ] **E5.** Quay lại orchestrator → confirm task `done` trong `tasks.json`. Nếu OK, MVP đạt.

## Workflow điển hình (để verify hệ chạy đúng)

1. User mở terminal Orchestrator, nhập: *"Build một AI feature tóm tắt CSV: backend Python parse CSV, frontend TS upload, Claude API tóm tắt."*
2. Orchestrator → tạo 3 task trong `tasks.json`, gửi inbox cho SE, AIE, Reviewer.
3. SE đọc inbox của mình → code parser + upload UI → ghi vào `project/`, reply orchestrator + ping reviewer.
4. AIE đọc inbox → viết prompt + eval → integrate vào backend → reply.
5. Reviewer review code, chạy test, viết note vào inbox SE/AIE hoặc approve qua orchestrator.
6. Orchestrator tổng kết cho user.

## Verification

- [ ] Chạy `./scripts/launch-tmux.sh` → mở 4 panes, mỗi pane Claude Code khởi động đúng folder agent, đọc đúng CLAUDE.md per-role.
- [ ] Test message passing: từ terminal orchestrator, viết message vào `shared/inbox/software-engineer.md` → SE đọc thấy ngay khi prompt "check inbox".
- [ ] Chạy thử 1 task end-to-end (ví dụ "tạo file `project/backend/hello.py` print 'hi'") đi qua orchestrator → SE → reviewer → orchestrator báo done.
- [ ] `tasks.json` được update đúng trạng thái sau từng bước.
- [ ] `shared/logs/` có log entry từ mỗi agent.

## Lưu ý / mở rộng

- **Race condition trên `tasks.json`:** chỉ orchestrator được ghi để tránh xung đột. Worker chỉ báo status qua inbox.
- **Thêm role mới:** tạo `agents/<new-role>/CLAUDE.md` + thêm `shared/inbox/<new-role>.md` + cập nhật launch script. Modular sẵn.
- **Sau MVP** có thể thay file-based bằng Redis/SQLite nếu cần concurrency cao, hoặc dùng MCP server làm message bus.
- **Quyền permission:** mỗi agent folder có thể có `.claude/settings.json` riêng để giới hạn (ví dụ Reviewer chỉ read-only project/, không được sửa code).
