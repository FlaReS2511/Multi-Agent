# REDESIGN PLAN

> Kế hoạch tái cấu trúc: (A) bỏ lưu data chắp vá → SQLite làm nguồn sự thật,
> (B) provider động hỗ trợ custom API (VietAPI + provider lớn), (C) UI redesign
> IDE-first với inline AI edit. Backend làm trước, UI làm sau.
>
> **Định hướng hiện tại: API-ONLY.** Không dùng CLI agent (Claude Code/Codex/
> Gemini qua PTY) nữa. Mọi agent chạy qua provider API. Phần CLI được gỡ nhưng
> note lại đầy đủ ở mục "CLI removal — hồi sinh tương lai" cuối file để sau này
> thêm lại dễ.

## Quyết định đã chốt

- **Storage**: SQLite (`shared/state.db`) là nguồn sự thật duy nhất. Driver
  `better-sqlite3` cho Electron (rebuild qua `@electron/rebuild` đã có sẵn),
  `sqlite3` stdlib cho Python. Bật `PRAGMA journal_mode=WAL` để 2 process
  (Electron + python runtime) đọc/ghi đồng thời an toàn.
- **API-only (không CLI)**: KHÔNG còn markdown bridge. Mọi agent đọc/ghi DB
  thẳng qua `agent_runtime.py`. Inbox/outbox markdown bị bỏ hẳn (chỉ giữ migration
  1 lần từ dữ liệu cũ). PTY vẫn dùng để chạy `agent_runtime.py` (xem output), nhưng
  không còn nhánh spawn `claude`/`codex`/`gemini`.
- **Custom API**: provider động kiểu opencode — mỗi provider khai `kind`,
  `base_url`, `models[]`. Không giới hạn VietAPI; cắm được mọi OpenAI-compatible
  và provider lớn (Anthropic/OpenAI/Google).
- **UI**: app mở thẳng IDE làm nền. Multi-agent (Dashboard/Plan/Artifacts/Cost/
  Terminals) gộp vào activity bar TRÁI sẵn có của IDE, mở thành panel trượt. Bỏ
  tab ngang + bỏ kiểu `view===x` unmount/mount.
- **Inline AI edit**: tô đen vùng code → widget "Ask AI" nổi cạnh → cửa sổ gen
  (framer-motion fade/scale) → stream từ provider qua IPC → Monaco view zone đẩy
  code nhường chỗ, code mới slide vào → Accept = merge + diff highlight.
- **Animation**: thêm `framer-motion` cho cửa sổ nổi; Monaco view zone + CSS cho
  phần đẩy code.

---

## PHASE 1 — SQLite foundation

### 1.1 Schema (`shared/state.db`)
```sql
PRAGMA journal_mode=WAL;

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,        -- T-001
  title       TEXT NOT NULL,
  owner       TEXT NOT NULL,
  status      TEXT NOT NULL,           -- todo|in_progress|review|done|blocked|waiting_children
  priority    TEXT,                    -- low|medium|high
  deps        TEXT NOT NULL DEFAULT '[]',   -- JSON array
  parent_id   TEXT,
  children    TEXT NOT NULL DEFAULT '[]',   -- JSON array
  artifact    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE messages (              -- thay inbox + outbox
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  from_role   TEXT NOT NULL,
  to_role     TEXT NOT NULL,
  task_id     TEXT,
  subject     TEXT,
  priority    TEXT,
  deps        TEXT,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unread',  -- unread|processed
  processed_at TEXT
);
CREATE INDEX idx_msg_to ON messages(to_role, status);
CREATE INDEX idx_msg_task ON messages(task_id);

CREATE TABLE usage (                 -- thay cost-from-log regex
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  role        TEXT NOT NULL,
  model       TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  task_id     TEXT
);
CREATE INDEX idx_usage_ts ON usage(ts);

CREATE TABLE meta (                  -- next_id và các counter
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE secrets (               -- thay .secrets.json
  provider  TEXT PRIMARY KEY,        -- id provider (vietapi, anthropic, ...)
  enc_key   TEXT NOT NULL            -- base64 safeStorage
);
```
> `agents-config.json` GIỮ là file (config tĩnh, người sửa tay được, version
> control friendly). Chỉ state động (tasks/messages/usage/secrets) vào DB.

### 1.2 `project/frontend/electron/db.ts`
- Mở DB singleton, `PRAGMA journal_mode=WAL`, `busy_timeout=5000`.
- Tạo schema nếu chưa có (idempotent `CREATE TABLE IF NOT EXISTS`).
- Helper: `getTasks/createTask/splitTask/updateTask`, `addMessage/
  getUnread/markProcessed/getTaskThread`, `addUsage/getCostSummary`,
  `getSecret/setSecret/deleteSecret`.

### 1.3 `scripts/db.py`
- Mirror helper cho Python runtime: `unread_messages(role)`,
  `mark_processed(id)`, `add_message(...)`, `add_usage(...)`.
- Cùng path `shared/state.db`, WAL, `busy_timeout`.

### 1.4 `scripts/migrate-to-sqlite.py` (chạy 1 lần, idempotent)
- Backup `tasks.json`, `inbox/*`, `outbox/*`, `logs/*`, `.secrets.json` →
  `shared/.backup/<timestamp>/`.
- `tasks.json` (94 task) → bảng `tasks` + `meta.next_id`.
- Parse outbox/inbox blocks (regex hiện có) → `messages` (outbox=processed,
  inbox=unread).
- Parse `logs/*.log` dòng `usage ...` → `usage`.
- `.secrets.json` → `secrets`.
- **Verify**: `SELECT count(*) FROM tasks` == 94.

---

## PHASE 2 — IPC handlers chuyển sang DB (giữ shape)

Giữ NGUYÊN tên IPC + shape trả về để renderer/api.ts không phải sửa. Đổi ruột:

| IPC | Cũ | Mới |
|---|---|---|
| `get-tasks` | đọc tasks.json | `db.getTasks()` |
| `create-task` / `split-task` / `update-task` | rw tasks.json + append md | transaction trên `tasks` + `db.addMessage` |
| `get-inbox-summary` / `get-inbox-content` | đọc md | query `messages` |
| `send-message` / `send-to-planner` / `approve-plan` | append md | `db.addMessage` (DB thẳng, không còn md) |
| `get-cost-summary` | regex log | `SELECT ... GROUP BY` trên `usage` |
| `get-task-thread` | parse md | query `messages WHERE task_id=?` |
| `get-backend-settings` / `set-provider-key` / `clear-provider-key` | .secrets.json | bảng `secrets` |
| inbox watcher | fsSync.watch + size/sep heuristic | poll/notify `count(*) WHERE status='unread'` thay đổi → spawnAndPing |

**Verify mỗi bước**: `npm run build` (tsc) pass + UI hiển thị task/cost/inbox như cũ.

---

## PHASE 3 — Provider động + custom API + dọn keyring

### 3.1 `agents-config.json` cấu trúc mới
```jsonc
{
  "providers": {
    "vietapi": {
      "kind": "openai-compatible",
      "name": "VietAPI",
      "base_url": "https://api.vietapi.tech/v1",
      "models": ["claude-opus-4.8", "deepseek-v4-pro", "glm-5.2", "gpt-5.5"]
    },
    "anthropic": { "kind": "anthropic", "name": "Anthropic",
                   "models": ["claude-opus-4-7","claude-sonnet-4-6"] },
    "openai":    { "kind": "openai",    "name": "OpenAI", "models": ["gpt-5"] },
    "google":    { "kind": "google",    "name": "Google", "models": ["gemini-2.5-pro"] },
    "lmstudio":  { "kind": "openai-compatible", "name": "LM Studio",
                   "base_url": "http://localhost:1234/v1", "models": [] }
  },
  "agents": {
    "orchestrator": { "backend": { "mode": "api" },
                      "provider": "anthropic", "model": "claude-opus-4-7" },
    "backend-engineer": { "backend": { "mode": "api" },
                          "provider": "vietapi", "model": "claude-opus-4.8" }
  }
}
```
- `backend.mode`: hiện chỉ `api` (CLI đã gỡ — xem mục cuối file). Trường `mode`
  vẫn giữ để tương lai thêm lại `cli` không phải đổi schema.
- `available_models` SINH RA từ `providers[].models` (bỏ list cứng).

### 3.2 `agent_runtime.py`
- `build_adapter(provider_cfg, model)`: theo `provider_cfg.kind`:
  - `anthropic` → `AnthropicAdapter`
  - `google` → `GoogleAdapter`
  - `openai` / `openai-compatible` → `OpenAIAdapter(model, base_url=provider_cfg.base_url)`
- Key lấy từ env `MULTIAGENT_KEY_<PROVIDER_UPPER>` (Electron/keyring inject).
- Pricing: model lạ → cost 0; cho khai `price_in`/`price_out` optional trong
  provider config nếu muốn tính.
- Log usage → `db.add_usage(...)` thay vì chỉ append log text.

### 3.3 Secrets & keyring
- Key per provider-id trong bảng `secrets` (mã hóa safeStorage).
- `main.ts buildPtyCommand`: chỉ còn 1 nhánh — spawn `python agent_runtime.py
  --role <role>`, inject `MULTIAGENT_KEY_<PROVIDER>` từ DB.
- Bỏ `scripts/keyring.sh` + nhu cầu `keyring-decrypt.js` (tmux path). Electron
  inject key trực tiếp khi spawn PTY nên không cần helper decrypt riêng.

### 3.4 UI BackendSettingsModal
- Đọc danh sách provider động từ config. Cho phép THÊM provider mới (name +
  base_url + kind + models). Key nhập per provider-id. Bỏ dropdown chọn CLI/Codex/
  Gemini — chỉ còn chọn provider + model.

**Verify**: thêm VietAPI, set 1 agent dùng `vietapi/claude-opus-4.8`, chạy
`agent_runtime.py --role backend-engineer` thử 1 message → có usage row trong DB.

---

## PHASE 4 — Gỡ CLI (API-only cleanup)

Thay vì làm markdown bridge, gỡ hẳn nhánh CLI vì không dùng nữa. Mọi điểm gỡ
được note ở mục "CLI removal" cuối file để hồi sinh tương lai.

- `main.ts`:
  - `BackendKind` thu về provider-driven; bỏ `claude-cli`/`codex-cli`/`gemini-cli`.
  - `buildPtyCommand` chỉ còn nhánh python `agent_runtime.py`.
  - Bỏ `syncAgentMdSafe` + việc copy `CLAUDE.md`/`GEMINI.md`/`AGENTS.md`.
  - Bỏ `tmuxNotifyPlanner` và mọi tham chiếu tmux.
  - Bỏ export markdown inbox; watcher chỉ theo DB.
- `agent_runtime.py`: chỉ đọc/ghi DB (đã làm ở Phase 1-3), bỏ logic inbox md.
- Scripts: bỏ/đánh dấu deprecated `launch-tmux.sh`, `keyring.sh`,
  `sync-agent-md.sh`, `monitor.sh`, `send.sh` (đều CLI/tmux-centric).
- Gitignore: bỏ entry `agents/*/CLAUDE.md|GEMINI.md|AGENTS.md` (không sinh nữa).

**Verify**: app chạy API-only, agent nhận task qua DB, không còn file md sinh ra.

---

## PHASE 5 — UI shell redesign (IDE-first)

### 5.1 App.tsx
- Bỏ `type View` + 5 ViewTab + khối `view===x`. App render `<IDEView/>` toàn màn.
- State global (tasks/inbox/logs/config polling) đẩy vào context để IDE panel dùng.

### 5.2 IDEView activity bar (trái) — thêm icon agent
Hiện có: Explorer / Git / Agents. Thêm:
- **Tasks** (kanban/list — TasksPanel + TaskInboxPanel)
- **Plan** (PlanComposer)
- **Artifacts** (ArtifactViewer)
- **Cost** (CostDashboard inline thay vì modal)
Mỗi icon mở panel trong sidebar trái (luôn mounted, ẩn/hiện bằng transform —
không unmount → giữ state, animate mượt). Terminals giữ ở bottom dock sẵn có.

### 5.3 Header
- Gọn lại: status dot, cost badge, auto-trigger toggle, settings, New Task.
- Bỏ tab ngang.

**Verify**: `npm run build` pass; mở app vào thẳng IDE; mỗi panel agent mở/đóng
mượt, không mất state.

---

## PHASE 6 — Inline AI edit (tô đen → gen → slide merge)

### 6.1 Bắt selection + widget nổi
- Monaco `onDidChangeCursorSelection`: khi có vùng chọn không rỗng, hiện
  **content widget** "Ask AI" (✦) neo cuối selection, tự theo scroll.

### 6.2 Cửa sổ prompt (framer-motion)
- Click widget → overlay panel cạnh vùng chọn, fade + scale-in.
- Ô nhập yêu cầu + chọn provider/model (từ config động) + nút Generate.

### 6.3 Stream gen
- IPC mới `ai-inline-edit({ provider, model, selection, instruction, context })`
  → main gọi provider (OpenAI-compatible/Anthropic/...) → stream token về
  renderer qua event `ai-inline-chunk`.
- Hiển thị code mới trong cửa sổ nổi, cập nhật theo stream.

### 6.4 Slide merge bằng view zone
- Accept → tạo Monaco **view zone** ngay dưới vùng chọn: animate height tăng
  (code dưới trượt xuống nhường chỗ), code mới slide vào view zone.
- Sau animation: ghi vào model (`executeEdits`), gỡ view zone, áp **diff
  decoration** xanh cho dòng mới (fade dần).
- Reject → cửa sổ scale-out, view zone co lại, code về như cũ.

### 6.5 IPC + provider client
- Tách 1 module `electron/ai-client.ts` dùng chung với agent_runtime logic
  (cùng provider config). Hỗ trợ streaming cho cả OpenAI-compatible và Anthropic.

**Verify**: tô 1 hàm → Ask AI → nhập "thêm docstring" → stream ra → Accept →
code mới slide vào đúng chỗ, diff xanh; Reject phục hồi nguyên trạng.

---

## Thứ tự & rollback
1. Phase 1-4 (backend) trước, từng phase verify `npm run build` + smoke test.
2. Phase 5-6 (UI) sau.
3. Mỗi phase 1 commit riêng (khi user yêu cầu commit). Backup file cũ ở
   `shared/.backup/` để rollback storage nếu cần.

---

## CLI removal — hồi sinh tương lai

> Thời điểm hiện tại: **API-only**. CLI agent (Claude Code / Codex / Gemini qua
> PTY) bị gỡ để code gọn. Khi cần thêm lại, đây là checklist đầy đủ những chỗ đã
> đụng — tìm theo marker `CLI-REVIVE` trong code (sẽ để comment ở mỗi chỗ gỡ).

**Đã gỡ / cần khôi phục khi thêm lại CLI:**

1. **`shared/agents-config.json`** — thêm lại `backend.mode = "cli"` + field
   `cli` (`claude`/`codex`/`gemini`). Schema đã chừa sẵn `mode` nên không phá DB.

2. **`project/frontend/electron/main.ts`**
   - `BackendKind`: thêm lại `claude-cli`/`codex-cli`/`gemini-cli`.
   - `buildPtyCommand`: thêm lại nhánh `resolveBin('claude'|'codex'|'gemini')`
     với flags (`--dangerously-skip-permissions`, `--yolo`, `--model`).
   - `syncAgentMdSafe` + copy `CLAUDE.md`/`GEMINI.md`/`AGENTS.md`: khôi phục.
   - `tmuxNotifyPlanner` + tmux integration: khôi phục nếu cần tmux mode.
   - Markdown bridge: khi có CLI agent, cần export DB→`inbox/<role>.md` và
     import block CLI mới ghi → DB (xem mô tả "Phase 4 markdown bridge" trong
     git history của file plan này — đã bị thay bằng API-only cleanup).

3. **Scripts** (đã deprecated, không xóa hẳn để tham khảo):
   - `launch-tmux.sh`, `monitor.sh`, `send.sh` — tmux 3x3 launcher.
   - `keyring.sh` + cần tạo `keyring-decrypt.js` — export key cho tmux panes.
   - `sync-agent-md.sh` — copy AGENT.md → CLAUDE.md/GEMINI.md/AGENTS.md.

4. **`.gitignore`** — thêm lại ignore `agents/*/CLAUDE.md|GEMINI.md|AGENTS.md`.

5. **UI BackendSettingsModal** — thêm lại dropdown chọn CLI backend kind bên
   cạnh provider/model.

**Pricing note**: model VietAPI/custom mặc định `cost_usd = 0` (gateway tự tính
tiền). Nếu muốn dashboard ước tính, khai `price_in`/`price_out` (USD/Mtok) trong
provider config — `estimate_cost_usd` trong `agent_runtime.py` đọc field này.
