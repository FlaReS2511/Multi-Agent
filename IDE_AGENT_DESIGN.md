# IDE AGENT — Design Doc (agentic coding trong editor)

> Cho model trong IDE **tự tay đọc/ghi file + sửa editor** thay vì chỉ stream chữ.
> Lý do hiện tại chat/inline "không ghi được": phía sau chúng là `streamChat`/
> `streamInlineEdit` — chỉ trả text, KHÔNG có tool-calling loop. Doc này thêm một
> **IDE agent** = tool loop (như agent-runtime) + truy cập editor đang mở.

---

## 0. Vì sao hiện tại không ghi được (chẩn đoán)

- **ChatPanel** → `streamChat` (ai-client.ts:146): stream token ra bong bóng chat.
  Model "nói" code nhưng không có tay để ghi file.
- **Inline edit** → `streamInlineEdit`: trả text thay vùng chọn, user tự Accept.
- Cả hai **không có tool loop** → model không gọi được Write/Edit/OpenFile.
- Ngược lại `agent-runtime.ts` (group worker) CÓ tool loop + file tools thật,
  nhưng chạy headless trong child process → không nối vào editor đang xem.

→ IDE agent = ghép **tool loop của agent-runtime** + **stream tương tác + truy cập
editor của chat**, chạy trong main process.

---

## 1. Quyết định kiến trúc (đã chốt)

| Vấn đề | Chốt | Hệ quả |
|---|---|---|
| Ghi file thế nào | **Auto-apply + toggle "review changes"** | Mặc định ghi thẳng; bật review thì mỗi Write/Edit hiện diff chờ Accept |
| Chạy ở đâu | **Electron main process**, stream về renderer | Tái dùng adapter fetch; tool editor round-trip qua IPC; realtime |
| Tool nào | **Full kit + spawn group** | Read/Write/Edit/Grep/Glob/Bash + OpenFile/ShowDiff + CreateTask/CreateGroup |
| UI | **Nâng ChatPanel → Ask / Agent mode** | Ask = streamChat cũ; Agent = tool loop; toggle trên panel |

---

## 2. Luồng tổng thể

```
ChatPanel (Agent mode) ──ai-agent-run──▶ [Electron main: runIdeAgent()]
   │  messages + open file + selection + workspace_root                │
   │                                                                    │
   │◀── ai-agent-event: token | tool_call | tool_result | ─────────────┤
   │       apply_diff(needs approval) | done | error                    │
   │                                                                    │  tool loop:
   │  (review mode) user Accept/Reject ──ai-agent-approve──▶            │   adapter.chat()
   │                                                                    │   → thực thi tool
   ▼                                                                    ▼   → lặp tới hết tool
 editor cập nhật (fs write → file-tree/editor reload;
   hoặc ShowDiff → InlineAICard-style diff chờ duyệt)
```

- 1 "run" = 1 lần user gửi prompt ở Agent mode. Main giữ state của run (id, abort,
  messages, pending approvals). Nhiều run tuần tự; không chạy song song trong 1 panel.
- Stream 2 loại sự kiện: **token** (assistant đang nói) + **tool activity** (đang
  gọi tool gì, kết quả). UI render cả hai để user thấy agent "suy nghĩ + hành động".

---

## 3. Tool kit của IDE agent

Tái dùng phần lớn từ agent-runtime, chia 3 nhóm:

### a) File tools (fs, cwd = workspace_root) — như agent-runtime
`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`.
- `Write`/`Edit`: đây là chỗ khác biệt lớn — xem mục 4 (apply mode).
- `Bash`: có (full kit đã chốt). **Cảnh báo an toàn:** chạy lệnh tùy ý trên máy.
  Gate sau `agent.allow_bash` (Settings, mặc định TẮT) — bật mới cho dùng.

### b) Editor tools (mới, round-trip IPC về renderer)
- `OpenFile(path, line?)` — mở file trong editor (như user click file tree).
- `ShowDiff(path, newContent)` — hiện diff (dùng DiffEditor có sẵn) để user xem.
- `GetOpenEditor()` — trả path + nội dung + selection của tab đang mở.
Những tool này KHÔNG dùng fs trực tiếp; main gửi IPC xuống renderer, renderer
thao tác Monaco rồi trả kết quả (round-trip qua promise theo `callId`).

### c) Orchestration tools (spawn group — full kit đã chốt)
- `CreateTask(title, owner, priority?)` — như orchestrator.
- `CreateGroup(task_id, worker_role)` — đẩy việc lớn sang v2 coordinator (chạy
  worker+reviewer headless). IDE agent thành "orchestrator mặt tiền": việc nhỏ tự
  làm bằng file tools, việc lớn/đa bước thì spawn group rồi báo user theo dõi ở
  Groups panel.
- Gate: chỉ bật khi `orchestration.enabled` (nếu tắt, tool trả lỗi gợi ý bật).

---

## 4. Apply mode: auto-apply + toggle review (quyết định lớn nhất)

Setting `agent.apply_mode`: `'auto'` (mặc định) | `'review'`.

### auto (mặc định)
- `Write`/`Edit` → ghi thẳng fs → main gửi `file-changed` → renderer reload file
  tree + editor nếu file đang mở. Agent chạy liền không chờ.
- Nhanh, giống Cursor agent mode. **Undo = git** (nên nhắc user commit trước khi
  chạy agent lớn; có thể surface cảnh báo nếu working tree bẩn nhiều).

### review
- `Write`/`Edit` KHÔNG ghi ngay. Main:
  1. Tính newContent, gửi `apply_diff` event (path + old + new) → renderer hiện
     diff (tái dùng InlineAICard / DiffEditor).
  2. Tool call "treo" (pending approval, lưu theo `callId`), agent loop DỪNG chờ.
  3. User Accept → `ai-agent-approve(callId, true)` → main ghi fs → trả tool_result
     "applied" → agent tiếp tục. Reject → tool_result "rejected by user" → agent
     biết và tự điều chỉnh.
- An toàn tối đa, user kiểm từng thay đổi. Đánh đổi: chậm khi nhiều file.

Toggle đặt ở: **ChatPanel header (nút Auto/Review)** + mirror trong Settings. Lưu
qua `uiSettings.ts` (localStorage) cho nhanh, đọc lúc bắt đầu run.

---

## 5. Thực thi (main process)

File mới `electron/ide-agent.ts`:
- `runIdeAgent(params, emit, approvalGate, signal)`:
  - Dựng adapter (tái dùng OpenAIAdapter/AnthropicAdapter — cân nhắc trích chung
    từ agent-runtime ra `electron/adapters.ts` để 3 nơi dùng: agent-runtime,
    ide-agent, [ai-client]).
  - System prompt IDE-agent (khác group worker): "bạn ở trong IDE, có editor đang
    mở, ưu tiên sửa tối thiểu, giải thích ngắn khi cần". Kèm open file + selection.
  - Loop `MAX_TURNS` (config riêng, vd 30): `adapter.chat()` → nếu có tool_calls,
    thực thi từng cái, emit tool_call + tool_result → push lại vào messages → lặp.
    Không tool → emit done.
  - Token streaming: adapter cần chế độ stream cho phần text (hiện agent-runtime
    adapter chạy non-stream). → thêm biến thể stream hoặc emit text sau mỗi turn.
    (GĐ1 có thể non-stream text cho đơn giản, chỉ stream "tool activity".)
- Usage/cost: ghi bảng `usage` với role ảo `ide-agent` (không group_id) để hiện
  trong cost dashboard.

### IPC (main.ts)
- `ai-agent-run(runId, params)` → khởi động run, trả {ok}.
- `ai-agent-cancel(runId)` → abort.
- `ai-agent-approve(runId, callId, accept)` → giải quyết pending apply.
- Event kênh `ai-agent-event:<runId>`: `{type: token|tool_call|tool_result|
  apply_diff|open_file|done|error, ...}`.
- Editor round-trip: `ai-agent-editor-req:<runId>` (main→renderer) +
  `ai-agent-editor-res` (renderer→main) theo callId cho OpenFile/ShowDiff/
  GetOpenEditor.

---

## 6. UI: ChatPanel Ask / Agent mode

Nâng `ChatPanel.tsx` (không tạo panel mới):
- Toggle **Ask | Agent** ở header. Ask = `streamChat` hiện tại (giữ nguyên).
- Agent mode:
  - Gửi → `ai-agent-run`. Render dòng thời gian: bong bóng assistant (token) xen
    **thẻ tool** ("📖 Read src/x.ts", "✏️ Edit src/y.ts (+12 −3)", "⚙️ Bash npm test").
  - Nút Auto/Review + nút Stop (abort).
  - review mode: thẻ apply hiện **nút Accept/Reject** + link mở diff trong editor.
  - Kết thúc: tóm tắt (số file đổi, tool đã chạy).
- Context tự đưa: open file + selection (đã có `getChatContext`), thêm
  workspace_root.

---

## 7. Lộ trình (verify từng bước)

**GĐ1 — Agent loop + file tools + auto-apply, non-stream text.**
- `ide-agent.ts` + IPC + ChatPanel Agent toggle.
- Tools: Read/Write/Edit/Grep/Glob (chưa Bash, chưa editor tools, chưa group).
- apply_mode=auto: ghi fs → renderer reload.
- **Verify:** "sửa hàm X trong file đang mở thêm log" → agent Read → Edit → file
  đổi thật, editor reload. Cost ghi vào usage.

**GĐ2 — Editor tools + review mode.**
- OpenFile/ShowDiff/GetOpenEditor round-trip IPC.
- apply_mode=review: diff + Accept/Reject gate. Toggle header + Settings.

**GĐ3 — Bash + orchestration tools.**
- Bash sau `allow_bash` (mặc định off).
- CreateTask/CreateGroup (gate orchestration.enabled) → spawn group cho việc lớn.

**GĐ4 — Streaming text + polish.**
- Stream token realtime (adapter stream variant).
- Cảnh báo git-dirty trước run lớn; nút "undo run" (git checkout các file đã đổi).

---

## 8. Rủi ro & chặn

| Rủi ro | Chặn bằng |
|---|---|
| Agent sửa hỏng code thật | apply_mode=review; git là undo; cảnh báo dirty tree |
| Bash chạy lệnh nguy hiểm | `allow_bash` mặc định TẮT; chỉ bật thủ công |
| Vòng lặp tool vô hạn / đốt tiền | MAX_TURNS cap; nút Stop; ghi cost realtime |
| Write ngoài workspace | resolve path phải trong workspace_root, reject `..` |
| Editor tool khi không có tab mở | tool trả trạng thái rõ, agent tự xử |
| Adapter trùng lặp 3 nơi | trích `electron/adapters.ts` dùng chung |
| Xung đột với group worker | IDE agent role ảo riêng; không đụng group lifecycle |

---

## 9. Điểm KHÔNG làm (giữ phạm vi)

- KHÔNG thay `streamChat`/`streamInlineEdit` — Ask mode + inline edit giữ nguyên.
- KHÔNG chạy nhiều agent run song song trong 1 panel.
- KHÔNG bật Bash / group tools mặc định (gate riêng).
- KHÔNG auto-commit; undo là git thủ công (GĐ4 mới có nút undo run).
- KHÔNG build lại adapter/provider — tái dùng, chỉ trích ra chung.

---

## 10. Sub-agent — bug đã quan sát

Hành vi lỗi thật của `SpawnAgent` (con dùng chung AbortController với cha;
`done` rỗng bị tính là thành công) ghi riêng ở **`agent-behavior-bug.md`**.
Chưa vá.
