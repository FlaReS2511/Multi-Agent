# MULTI-AGENT v2 — Design Doc (Group-based, hybrid orchestration)

> Thiết kế lớp điều phối động cho Orqon. KHÔNG build lại nền — giữ SQLite làm
> message bus + memory, provider động, tool registry, PTY spawn. Xây lớp
> orchestration mới lên trên. Xem `REDESIGN_PLAN.md` cho nền tảng.

---

## 0. Hiện trạng thật (v1) — đọc trước khi sửa

Điều quan trọng nhất: **v1 KHÔNG có logic điều phối trong code.** Cụ thể:

- Mỗi agent = 1 process `agent-runtime.js --role X`. Vòng lặp của nó
  (`agent-runtime.ts` main loop): poll `db.getUnreadFor(role)` → có message thì
  chạy tool-loop tối đa `MAX_TURNS=25` → `db.markProcessed`. Hết.
- `main.ts` chỉ làm **cơ khí spawn**: pre-warm `orchestrator`+`planner`,
  lazy-spawn role khi inbox có unread (`watchInboxes`, poll 1.5s), kill sau 15
  phút idle (`startIdleGc`). Nó KHÔNG biết gì về task/group/budget/vòng đời.
- "Orchestrator" **chỉ là một LLM agent** có thêm 2 tool `CreateTask`/`UpdateTask`
  (gated `CTX_ROLE === 'orchestrator'`). Toàn bộ "điều phối" là **emergent** — nó
  làm theo `AGENT.md`, không có state machine nào ép. Không đảm bảo group đóng
  đúng, budget không cháy, hay agent treo được phát hiện.

→ v2 vá đúng lỗ hổng này: **đưa vòng đời + các trần vào code**, giữ phần quyết
định nội dung cho LLM.

---

## 1. Triết lý: HYBRID (code giữ khung, LLM lấp ruột)

Đây là quyết định load-bearing của toàn bộ v2.

| Thuộc về CODE (deterministic, ép cứng) | Thuộc về LLM (phán đoán nội dung) |
|---|---|
| Vòng đời group (state machine) | Chia task ra sao, task con là gì |
| Spawn/kill PTY worker + reviewer | Viết code / sửa code thật |
| Enforce budget $ / concurrency / retry cap | Đánh giá độ khó task (đề xuất level) |
| Load/save group memory từ DB | Review pass/fail + nội dung report |
| Định tuyến verdict → pass/fail/respawn | Viết progress_note khi bàn giao |
| Heartbeat / phát hiện treo (GĐ2) | Nội dung message giữa các agent |

Nguyên tắc: **LLM đề xuất, code định đoạt.** LLM gọi tool để phát tín hiệu
(vd `RequestReview`, `SubmitReview` verdict=pass) nhưng KHÔNG tự spawn/kill process
hay tự ép budget. Code (`GroupCoordinator` trong main process) đọc tín hiệu đó,
kiểm trần, rồi mới hành động. Vượt trần → code dừng cứng, LLM không cãi được.

---

## 2. Khái niệm cốt lõi

### Group = đơn vị làm-và-duyệt
- Một **group** gắn với **một task**. Gồm 1 **worker** + review theo yêu cầu.
- Worker code → gọi `RequestReview` → coordinator (code) spawn **reviewer** cùng
  group → reviewer gọi `SubmitReview(verdict)`.
  - `pass` → coordinator đóng group, task `done`, xóa memory.
  - `fail` → coordinator đọc report → kill worker, spawn lại worker (nạp report).
    Lặp tới khi pass hoặc chạm `max_retries_per_group`.
- Reviewer **kill sau khi duyệt** (không ngồi chờ). Worker cũng kill giữa các lần
  review. **Process tạm thời; memory bền trong DB.**

### Hai loại process (điểm khác v1)
- **Resident agents** (`planner`, `orchestrator`): giữ mô hình v1 — poll inbox,
  thường trú, pre-warmed. `orchestrator` là điểm nhận việc từ user/planner/UI.
- **Group agents** (worker, reviewer): spawn với `--group <G-id> --role <base>`.
  KHÔNG poll inbox. Chạy **một phiên** (load task + memory → tool-loop → phát tín
  hiệu → thoát 0). Coordinator quản theo group status + PID, không qua inbox.

  Lý do không dùng inbox cho group agent: nhiều instance cùng base role (vd 3
  `backend-engineer` ở 3 group) sẽ giẫm chân nhau trên `getUnreadFor(role)`.
  Group agent nhận việc qua **group memory + task**, không qua inbox.

### Level (tĩnh trước, auto sau)
- Mỗi model khai **level theo kỹ năng** trong config (không phải 1 số):
  `{ code: 3, review: 4, reasoning: 3, speed: 5 }`. TÁCH capability khỏi
  constraint (cost/speed) — không cộng gộp thành 1 điểm.
- Orchestrator (hoặc coordinator heuristic) chọn model theo độ khó + kỹ năng cần.
- **Reviewer level = worker level + offset** (mặc định +1), có trần.
- GĐ1: khai tay trong `agents-config.json`. Auto-benchmark là GĐ3.

### Spawn động + đệ quy có trần
- Coordinator spawn group theo tải, không cứng 8 agent.
- Task lớn → worker gọi `DispatchTask` đề xuất task con → coordinator tạo
  sub-group (đệ quy) nếu còn depth + budget.
- **Mọi thứ có trần cứng** (mục 5). Đệ quy dừng khi: chạm depth cap, task đủ nhỏ,
  hoặc chạm ngân sách.

---

## 3. Memory (bền theo group, sống qua kill/spawn)

Process bị kill nhưng memory KHÔNG chết theo — sống trong DB, xóa khi group đóng.

Nội dung memory chính (không lưu full mọi turn — quá tốn token):
- **`progress_note`** — worker viết ngắn trước khi báo xong / trước khi bị kill:
  "đã làm X, file Y, còn dở Z".
- **`review_report`** — reviewer viết khi fail: lỗi ở file/dòng nào, vì sao,
  hướng sửa. Đây là "bàn giao ca" chính giữa các lần spawn worker.

Khi worker spawn lại nạp: **task gốc + progress_note mới nhất + review_report mới
nhất** (nếu có). KHÔNG nạp toàn bộ lịch sử turn → gọn, rẻ, đúng trọng tâm.

Ranh giới:
- Memory **theo group**, không chia sẻ chéo group.
- Worker ↔ reviewer **cùng group** chia sẻ (reviewer cần thấy worker làm gì).
- Kết quả cuối (code thật, task done) nằm ở file + bảng `tasks`, KHÔNG ở memory.

---

## 4. Schema DB (thêm, không phá cái cũ)

Migration idempotent trong `createSchema` (CREATE TABLE IF NOT EXISTS) +
`ALTER TABLE usage ADD COLUMN group_id` bọc try/catch cho DB cũ.

```sql
CREATE TABLE IF NOT EXISTS groups (
  id             TEXT PRIMARY KEY,       -- G-001
  task_id        TEXT NOT NULL,          -- task gốc của group
  parent_group   TEXT,                   -- group cha nếu là sub-group
  depth          INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,          -- pending|active|reviewing|passed|failed|killed
  worker_role    TEXT,                   -- base role chạy worker (backend-engineer...)
  reviewer_role  TEXT,
  worker_model   TEXT,
  reviewer_model TEXT,
  level          INTEGER,
  budget_usd     REAL NOT NULL DEFAULT 0,
  spent_usd      REAL NOT NULL DEFAULT 0,
  retries        INTEGER NOT NULL DEFAULT 0,
  signal         TEXT,                   -- tín hiệu mới nhất từ agent (request_review|verdict:pass...)
  worker_pid     INTEGER,                -- PID phiên worker hiện tại (coordinator kill)
  reviewer_pid   INTEGER,
  heartbeat_at   TEXT,                   -- cập nhật mỗi turn (GĐ2 phát hiện treo)
  created_at     TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status);

CREATE TABLE IF NOT EXISTS group_memory (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id  TEXT NOT NULL,
  task_id   TEXT,
  role      TEXT,                         -- worker|reviewer
  kind      TEXT NOT NULL,                -- progress_note|review_report|summary
  content   TEXT NOT NULL,
  ts        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmem_group ON group_memory(group_id, id);

-- usage thêm cột group_id → gom chi phí theo group
ALTER TABLE usage ADD COLUMN group_id TEXT;
```

- Sau mỗi call, runtime ghi `usage.group_id`; coordinator cộng dồn vào
  `groups.spent_usd` (nguồn chân lý để enforce budget).
- `tasks` giữ nguyên (HTN parent/children vẫn dùng cho cây task).
- `signal`/`worker_pid` là **kênh code ↔ agent**: agent gọi tool → runtime ghi
  `signal` vào group row → coordinator poll thấy → hành động. Không qua inbox.

---

## 5. Giới hạn & an toàn (settings, default bảo thủ)

Lưu ở `agents-config.json` mục `orchestration`. **Mặc định bảo thủ** để không cháy
tiền lần đầu. **3 tầng chặn (tài nguyên + tiền + vòng lặp) bắt buộc từ GĐ1.**

| Cài đặt | Default | Ý nghĩa | Tầng |
|---|---|---|---|
| `enabled` | `false` | Bật lớp group coordinator (v1 vẫn chạy khi tắt) | — |
| `max_concurrent_groups` | 3 | Group active cùng lúc | Tài nguyên |
| `max_groups_per_task` | 20 | Tổng group 1 task gốc đẻ ra (kể cả đệ quy) | Tài nguyên |
| `max_recursion_depth` | 3 | Sub-group tới cấp mấy | Tài nguyên |
| `budget_per_task_usd` | 5 | Trần $ mỗi task gốc — vượt = dừng cứng | **Tiền** |
| `budget_per_group_usd` | 2 | Trần $ mỗi group | **Tiền** |
| `max_retries_per_group` | 3 | Số vòng worker→reviewer→worker | Vòng lặp |
| `reviewer_level_offset` | +1 | Reviewer cao hơn worker mấy level | Chất lượng |
| `review_policy` | `on-demand` | Review khi worker yêu cầu / task rủi ro, KHÔNG 100% | Tiền/tốc độ |

Vượt trần ngân sách → group/task dừng cứng (`killed`), báo user. `enabled=false`
mặc định: v2 KHÔNG tự chạy tới khi user bật — an toàn cho commit này.

---

## 6. Vòng đời group (state machine — CODE sở hữu)

```
pending  ──coordinator có slot──▶ active
  (spawn worker: --group G --role R, nạp task+memory)
active
  worker code, ghi progress_note (tool), heartbeat mỗi turn
  worker gọi RequestReview  → runtime set signal=request_review, worker thoát
                            → coordinator: reviewing
  worker gọi DispatchTask   → coordinator tạo sub-group (nếu còn depth+budget)
  worker thoát không tín hiệu→ coordinator: đọc progress, coi như cần review
reviewing
  (spawn reviewer: --group G --role R-reviewer, nạp task+progress)
  reviewer gọi SubmitReview(verdict):
    pass → passed  (kill agents, task=done, xóa group_memory, giải phóng slot)
    fail → ghi review_report
             retries < cap & spent < budget ?
               yes → retries++, kill+respawn worker (nạp report) → active
               no  → failed (task=blocked, báo orchestrator/user)
bất kỳ lúc nào: spent_usd > budget_per_group → killed (dừng cứng)
GĐ2: heartbeat quá N phút không đổi → treo → respawn hoặc failed
```

Coordinator là **code trong main process**, không phải LLM. Nó chỉ đọc `signal`
+ `spent_usd` + đếm slot rồi quyết. LLM chỉ đặt `signal` qua tool.

---

## 7. GroupCoordinator (main process) + tool signals

### Coordinator loop (poll ~1s, trong main.ts)
1. `groups` có `status=pending` & còn slot `max_concurrent_groups` → spawn worker.
2. Đọc `signal` của group active/reviewing:
   - `request_review` → spawn reviewer, status=reviewing, clear signal.
   - `dispatch:<json>` → tạo sub-group con (check depth/max_groups/budget), clear.
   - `verdict:pass` → close group done.
   - `verdict:fail` → respawn worker hoặc fail theo retry/budget.
3. Worker/reviewer PID đã thoát mà chưa có signal → xử lý theo status (fallback).
4. Cộng `usage.group_id` → `spent_usd`; vượt budget_per_group/ _per_task → kill.
5. GĐ2: sweep `heartbeat_at`.

### Tool mới (agent gọi, runtime ghi signal — KHÔNG tự hành động)
- **`RequestReview(summary)`** — worker: "xong phần của tôi, cần duyệt". Runtime
  ghi progress_note + set `signal=request_review`, kết thúc phiên.
- **`SubmitReview(verdict, report)`** — reviewer: verdict = `pass|fail`. fail thì
  `report` bắt buộc (ghi review_report). Set `signal=verdict:<v>`, kết thúc phiên.
- **`DispatchTask(title, note?)`** — worker: đề xuất tách task con. Runtime set
  `signal=dispatch:...`. Coordinator (code) mới là bên tạo task+sub-group.

Runtime chế độ group nhận `--group <id>`: `initDb` → đọc group row + task +
memory (progress+report mới nhất) → build 1 message tổng hợp → tool-loop → khi
gặp tool signal thì set signal + thoát; nếu hết turn không signal, tự set
`request_review` với progress hiện có. Mọi `addUsage` kèm `group_id`.

---

## 8. Lộ trình (verify từng bước, model rẻ + task nhỏ)

**GĐ1 — Group + spawn động, level TĨNH, trần đầy đủ, coordinator hybrid.**
- Schema `groups`/`group_memory`/`usage.group_id` + CRUD.
- Runtime `--group`: nạp memory, tool RequestReview/SubmitReview/DispatchTask,
  tag usage group_id.
- GroupCoordinator: pending→active→reviewing→passed/failed, enforce
  concurrency + budget + retry. `orchestration.enabled=false` mặc định.
- Level/model khai tay.
- **Verify:** 1 task → worker→review→done, chi phí gom đúng theo group, chạm trần
  thì dừng. Test bằng model flash.

**GĐ2 — Reliability + đệ quy.** Heartbeat/timeout, respawn treo, sub-group thật
(DispatchTask → depth cap), review_report loop hoàn chỉnh. ✅ ĐÃ LÀM: sweep
`heartbeat_at` (config `heartbeat_timeout_sec`, default 300s) — group không đổi
+ không có process + không có signal → respawn (trong retry cap) hoặc fail;
DispatchTask → `spawnSubGroup` (check depth + max_groups_per_task + budget).

**GĐ3 — Auto-benchmark model → level động.** (chưa làm)

**GĐ4 — UI group panel + Settings cho các trần mục 5.** ✅ ĐÃ LÀM:
`GroupsPanel.tsx` (activity-bar icon Boxes) — cây group, status, chi phí/budget,
retries, depth, memory timeline (progress_note/review_report/dispatch), kill thủ
công; `OrchestrationSection` trong BackendSettingsModal — toggle enable + 7 trần
số + review_policy. IPC: `group-create/list/kill/memory`,
`orchestration-get/set`, event `coordinator-event`.

---

## Trạng thái build (2026-07)

Đã code + build sạch (`tsc -b` + `vite build`): GĐ1 (schema groups/group_memory,
usage.group_id, runtime `--group` + 3 signal tool, GroupCoordinator state
machine + budget/concurrency/retry) + GĐ2 (heartbeat sweep + sub-group) + GĐ4
(GroupsPanel + Settings). **`orchestration.enabled=false` mặc định** — coordinator
tick no-op tới khi user bật trong Settings.

**✅ VERIFY END-TO-END THẬT (2026-07-03, VietAPI):** 1 task nhỏ → group G-001 →
worker (glm-5.2) viết file + `RequestReview` → coordinator spawn reviewer
(be-reviewer, gpt-5.5) → `SubmitReview(verdict=pass)` → group `passed`, task
`done`. Cả worker+reviewer exit code 0, usage gom đúng theo `group_id`, memory
lưu progress_note + review_report. Cũng đã xác nhận reliability: khi worker
crash lúc startup (sai key), heartbeat sweep respawn đúng số lần rồi `failed`.
- **Bài học verify:** harness phải chạy dưới Electron GUI với `app.setName('orqon')`
  + `app.setPath('userData', appData/orqon)` TRƯỚC whenReady — nếu không
  safeStorage giải mã sai key VietAPI → HTTP 401 → worker exit 1. Coordinator có
  hook debug `GROUP_CHILD_LOG` (env, mirror stdout/stderr con ra file).

---

## 9. Rủi ro & chặn

| Rủi ro | Chặn bằng |
|---|---|
| Đệ quy đốt tiền | budget_per_task + depth cap + max_groups_per_task |
| Reviewer top-tier thành nút thắt | review on-demand; reviewer = worker+offset không luôn max |
| Agent chết → task mồ côi | heartbeat + sweep respawn (GĐ2) |
| Nhiều instance cùng role giẫm inbox | group agent KHÔNG dùng inbox, quản qua group row |
| LLM "quên" đóng group | code sở hữu vòng đời; hết turn không signal → auto request_review |
| Deadlock | group độc lập, không chờ chéo; coordinator là điểm điều phối duy nhất |
| Reasoning model tốn token ẩn | max_tokens + đọc reasoning_content; theo dõi tokens |
| Provider 429 | fallback model khi 429 (GĐ1) |

---

## 10. Điểm KHÔNG làm (giữ phạm vi)

- KHÔNG build lại nền (DB bus, provider, tool registry, PTY spawn giữ nguyên).
- KHÔNG để LLM tự spawn/kill process hay tự nới budget (code sở hữu).
- KHÔNG auto-benchmark ở GĐ1.
- KHÔNG reviewer sống thường trực (spawn on-demand).
- KHÔNG chia sẻ memory chéo group.
- KHÔNG bật coordinator mặc định (enabled=false tới khi user chủ động bật).

