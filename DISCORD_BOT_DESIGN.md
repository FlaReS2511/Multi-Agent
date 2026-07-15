# DISCORD BOT — Design Doc (vibecode qua Discord)

> Điều khiển Orqon từ Discord: gõ lệnh → tạo task → spawn group (worker+reviewer)
> → nhận progress + kết quả về Discord. Duyệt cây file của workspace ngay trong
> Discord. KHÔNG build lại nền — tái dùng DB bus + GroupCoordinator + config đã có.

---

## 0. Bối cảnh & ràng buộc

- **Blast radius lớn:** bot two-way = ai nhắn đúng chỗ là chạy agent viết code +
  đốt tiền API trên máy user. → **auth (owner allowlist) là bắt buộc**, không phải
  tùy chọn. Mọi interaction check `user.id ∈ allowlist` TRƯỚC khi làm gì.
- **Chỉ chạy khi app mở:** bot là child process do Electron main spawn (giống
  `agent-runtime`). App tắt → bot offline. Chấp nhận được cho giai đoạn này.
- **Trạng thái nền đã có:** SQLite bus (`state.db`), GroupCoordinator (main
  process, poll 1s), `groupCreate`/`createTask` (db helpers), secrets qua
  safeStorage, `agents-config.json` cho config tĩnh. Xem MULTIAGENT_DESIGN.md.

---

## 1. Kiến trúc: bot child ↔ DB bus ↔ coordinator

Điểm mấu chốt: **GroupCoordinator sống trong Electron MAIN process.** Bot là
process RIÊNG → KHÔNG gọi thẳng `coordinator.createGroupForTask()` được. Giải
pháp: **dùng DB làm bus** (đúng pattern đã có cho agent).

```
Discord user ──/vibe──▶ [discord-bot.ts child process]
                             │  1. auth check (user.id ∈ allowlist)
                             │  2. db.createTask(owner=worker)
                             │  3. db.createGroup(...) status=pending
                             ▼
                    shared/state.db  (bus)
                             ▲
                             │  coordinator (MAIN) poll 1s thấy pending group
                             │  → spawn worker → review → passed/failed
                             ▼
[discord-bot.ts] poll group status + cost ──▶ edit/reply message về Discord
```

- Bot **không** cần IPC với main. Nó ghi intent vào DB, coordinator (đang chạy
  sẵn trong main) tự nhặt. Bot poll ngược group row để báo progress.
- Bot đọc filesystem workspace trực tiếp (có `workspace_root` trong `meta`) cho
  lệnh `/browse` — không cần qua main.
- **Tái dùng logic tạo group:** trích `resolveGroupParams(taskId, workerRole,
  cfg)` (reviewer_for lookup + model + budget) thành helper dùng chung cho cả
  main IPC (`group-create`) lẫn bot, để không lệch logic.

### Spawn (main.ts)
Giống agent-runtime: `process.execPath` + `ELECTRON_RUN_AS_NODE=1` +
`dist-electron/discord-bot.js`, inject `MULTIAGENT_KEY_DISCORD` (bot token giải
mã từ secrets). Chỉ spawn khi `discord.enabled=true`. Bot crash → main respawn
(backoff). App quit → kill bot.

---

## 2. Auth & config

Lưu trong `agents-config.json` mục `discord` (Settings UI ghi — GĐ3):

```json
"discord": {
  "enabled": false,
  "allowed_user_ids": ["111111111111111111", "222222222222222222"],
  "allowed_channel_ids": [],
  "default_worker_role": "backend-engineer",
  "guild_id": "",
  "max_code_bytes": 15000
}
```

- **`allowed_user_ids`**: allowlist nhiều Discord ID (bạn muốn nhiều người). RỖNG
  = KHÔNG AI dùng được (fail-closed, an toàn hơn fail-open).
- **`allowed_channel_ids`**: rỗng = mọi channel bot thấy; có giá trị = chỉ những
  channel đó. Khuyến nghị set để tránh lộ ra channel công khai.
- Bot token: **KHÔNG** để trong config file. Cất ở bảng `secrets` provider
  `discord` (safeStorage encrypt), giống API key. Settings UI nhập.
- Mọi lệnh: `if (!allowed_user_ids.includes(i.user.id)) return ephemeral("Không
  có quyền")`. Guild_id để register slash command theo 1 server (nhanh, không
  chờ global propagate ~1h).

---

## 3. Slash commands (Discord application commands)

Đăng ký qua REST khi bot ready (guild-scoped cho nhanh). Danh sách:

| Lệnh | Tham số | Việc |
|---|---|---|
| `/vibe` | `instruction` (bắt buộc), `role?` (chọn worker), `budget?` | Tạo task + group, chạy, báo progress + kết quả |
| `/browse` | `path?` (mặc định gốc workspace) | Hiện cây file dạng select menu, điều hướng vào, chọn file → hiện code |
| `/tasks` | `status?` | List task board (gọn) |
| `/groups` | — | List group active + status + cost |
| `/kill` | `group_id` | Kill 1 group (owner-only) |
| `/cost` | — | Chi phí hôm nay + theo group |
| `/status` | — | App/coordinator/workspace hiện tại |

Tất cả reply **ephemeral** mặc định (chỉ người gõ thấy) trừ khi cần share.

### `/vibe` flow (mạch chính)
1. Auth check.
2. `defer()` (reply "đang xử lý", có 15 phút để follow-up).
3. `db.createTask({ title: instruction, owner: role || default_worker_role,
   priority: 'medium' })`.
4. `resolveGroupParams` → `db.createGroup(... status='pending')`.
5. Reply: "🟢 Group **G-xxx** đã tạo cho task T-yyy. Đang chạy…" (kèm nút Kill).
6. **Poll loop** (mỗi 3s, tái dùng `coordinator-event` không được vì khác process
   → poll DB group row): khi status đổi → edit message. Trạng thái:
   `pending→active` (worker chạy), `reviewing` (reviewer soi),
   `passed`/`failed`/`killed` (chốt).
7. Kết thúc: message cuối = status + cost ($) + số retry + **danh sách file đã
   đổi** (git diff --name-status trong workspace) + trích review_report.

### `/browse` flow (cây file → code)
Discord không có widget cây thật → dùng **String Select Menu** điều hướng:
1. Auth check. Đọc `workspace_root` từ meta.
2. Liệt kê entries của `path` hiện tại (dir trước, file sau; bỏ `.git`,
   `node_modules`, `dist`…). Render 1 select menu (Discord cap 25 option/menu →
   phân trang nếu quá).
3. Chọn **dir** → edit message, đi vào dir đó (breadcrumb + nút ⬆️ Up).
4. Chọn **file** → đọc file:
   - ≤ `max_code_bytes` → hiện trong code block (```lang), split nếu > 2000 char
     (giới hạn message Discord) thành nhiều message hoặc dùng ```.
   - > cap → gửi dưới dạng **file attachment** (Discord tự cho tải).
5. Nút "📋 Copy path", "↩ Back".
- **Chặn path traversal:** resolve path phải nằm TRONG workspace_root, reject `..`
  thoát ra ngoài. Đọc-only, không cho sửa qua Discord (GĐ này).

---

## 4. Progress reporting (poll-based, cross-process)

Bot ở process khác nên không nghe được `coordinator-event` của main. Cách:
- Sau khi tạo group, bot giữ map `{ groupId → discordMessage }`.
- Vòng poll (mỗi 3s) đọc `db.getGroup(id)` + `db.recomputeGroupSpend`/cost.
  Status đổi hoặc cost nhảy đáng kể → `message.edit(...)`.
- Group vào terminal (`passed|failed|killed`) → message cuối + gỡ khỏi map.
- Timeout cứng phía bot (vd 15 phút) → ngừng poll, báo "vẫn chạy, xem /groups".
- Nhiều group song song → nhiều message độc lập, mỗi cái poll riêng.

---

## 5. Secrets & khởi động

- Token: `set-provider-key` reuse với provider id `discord` (đã có safeStorage
  path). Main giải mã → env `MULTIAGENT_KEY_DISCORD` khi spawn bot.
- Bot dùng `discord.js` v14 (`GatewayIntentBits.Guilds` đủ cho slash commands +
  components; KHÔNG cần MessageContent intent → ít quyền, an toàn hơn).
- Đăng ký slash command guild-scoped lúc `ClientReady`.
- `discord.enabled=false` mặc định → main KHÔNG spawn bot tới khi user bật.

---

## 6. Lộ trình (verify từng bước)

**GĐ1 — Bot skeleton + auth + `/vibe` + progress.**
- `discord-bot.ts` child, spawn từ main khi enabled + có token.
- discord.js connect, đăng ký slash guild-scoped, auth allowlist.
- `/vibe` → createTask + createGroup(pending) → poll → progress + kết quả cuối
  (status + cost + file đổi).
- **Verify:** gõ `/vibe tạo file X` từ Discord (ID trong allowlist) → group chạy
  → Discord nhận "passed" + cost. ID lạ → bị chặn.

**GĐ2 — `/browse` cây file + hiện code.**
- Select menu điều hướng dir, chọn file → code block / attachment.
- Chặn path traversal, filter thư mục rác, phân trang > 25 entry.

**GĐ3 — Settings UI + lệnh phụ.**
- Section "Discord" trong BackendSettingsModal: toggle enable, nhập token
  (safeStorage), thêm/xóa allowed user IDs + channel IDs, default worker role.
- `/tasks` `/groups` `/kill` `/cost` `/status`.

**GĐ4 — Polish.**
- Nút Kill/Retry ngay trên message progress.
- (Tùy) trả code diff đính kèm cho `/vibe`.

---

## 7. Rủi ro & chặn

| Rủi ro | Chặn bằng |
|---|---|
| Người lạ chạy code/đốt tiền | allowlist user ID; rỗng = fail-closed; channel allowlist |
| Token lộ | safeStorage encrypt, không để trong config file / git |
| `/browse` đọc file ngoài workspace | resolve + kiểm nằm trong workspace_root, reject `..` |
| Đốt tiền qua `/vibe` | budget_per_group/task của coordinator (đã có) + `/kill` |
| Bot crash treo app | child process cô lập, main respawn có backoff |
| MessageContent intent (quyền rộng) | KHÔNG dùng; chỉ slash + components |
| Message > 2000 char | split hoặc gửi file attachment |
| Slash command chờ global ~1h | register guild-scoped (guild_id) |

---

## 8. Điểm KHÔNG làm (giữ phạm vi)

- KHÔNG cho SỬA file qua Discord ở các GĐ này (browse = đọc-only).
- KHÔNG chạy bot khi app tắt (không daemon/service).
- KHÔNG bật bot mặc định (enabled=false tới khi user cấu hình).
- KHÔNG dùng message-content trigger (chỉ slash command) → hẹp quyền, rõ ràng.
- KHÔNG để bot gọi coordinator trực tiếp (qua DB bus).
