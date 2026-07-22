# Orqon IDE — UX Backlog & Ideas

> Nguồn: UX audit 2026-07-21 (72-agent workflow, 64 finding verified). Chi tiết đầy đủ từng finding (file:line + cách fix) nằm trong claude memory: `ux-audit-2026-07-21-full.json` (key `result.confirmed`).
>
> Trạng thái: **28/64 đã fix** trên các branch `feat/11-ux` (18 — bẫy mất dữ liệu + vòng lặp agent) và `feat/12-ux2` (10 — 2 HIGH + onboarding/settings + a11y cơ bản). Còn **36** dưới đây.

---

## ✅ ĐÃ LÀM: Peek Definition ("soi hàm được gọi") — hướng B

**Trạng thái: implemented (branch `feat/12-ux2`, chưa commit).** Build + typecheck sạch; resolve verified (cold ~233ms, warm ~0ms, cross-file chính xác).

Đã dựng:
- `electron/ts-definitions.ts` — TS LanguageService trong main process (compiler API thật, không grep). Lazy init per-tsconfig scope, đọc file từ disk qua `ts.sys`, honors baseUrl/paths (alias). Nhận `liveContent` từ renderer để offset khớp buffer chưa lưu. Chỉ trả def **trong workspace** (own code + node_modules); lib.d.ts bị loại (sandbox chặn đọc ngoài root). `typescript` → `dependencies` + external trong bundler (main ESM `import ts from 'typescript'`).
- IPC `resolve-definition(rel, offset, contents?)` (main.ts) + preload + `api.ts`. Reset service khi đổi workspace root.
- `src/lib/monacoDefinition.ts` — `registerDefinitionProvider` (typescript+javascript) gọi IPC; tắt built-in TS definitions (khỏi trùng) + tắt **semantic** squiggles sai (giữ syntax). Tạo model tạm từ disk cho file chưa mở. `registerEditorOpener` bridge "Open full"/F12-cross-file → mở tab thật qua `openFileAtLine` (standalone Monaco vốn no-op).
- Wiring: `monacoSetup.ts` gọi `registerDefinitionSupport(monaco)`; IDEView `setDefinitionOpener(openFileAtLine)`.
- Animation "lặn từ dưới lên": `.peekview-widget` → `@keyframes peek-surface` (translateY 16px→0 + fade, 260ms), tôn trọng `prefers-reduced-motion`.

Tầng tương tác (mặc định Monaco, khớp yêu cầu): **Alt+F12 / chuột phải → Peek** (nổi, scroll, edit-in-place), **F12 → Go to** (mở tab), hover giữ built-in.

Còn lại (chưa làm — pha 2): edit-in-peek chưa nối vào đường save app (sửa trong peek chưa lưu ra buffer/disk); hover provider preview riêng; dispose model peek-tạm; đổi keybind nếu muốn peek là default thay vì go-to.

<details><summary>Spec gốc (giữ để tham chiếu)</summary>

### IDEA gốc: Peek Definition ("soi hàm được gọi")

**Ý tưởng (từ user):** đọc code hay cần soi định nghĩa của hàm đang được gọi mà không mất chỗ đang đứng. Chuột phải (hoặc hover) lên lời gọi hàm → hiện **cửa sổ nổi ngay tại con trỏ** show định nghĩa hàm đó; cuộn được như editor thật; sửa trực tiếp; có nút mở full để nhảy tới file. Cửa sổ dính vào chỗ vừa bấm, **không được lẹm vào góc/viewport**.

**Đây chính là "Peek Definition" của VS Code** — và Monaco (engine app dùng) ship sẵn nguyên widget nổi đó (scroll, edit-in-place, "open full", tự định vị không tràn viewport). Phần UI khó nhất **không phải tự làm**.

### Quyết định (chốt với user)
- **Hướng B — chính xác bằng TypeScript compiler API** (không dùng grep heuristic). Resolve định nghĩa 100% đúng cho `.ts/.tsx/.js/.jsx` kể cả import/alias/overload.
- **Hiệu ứng mở: nổi/lặn từ DƯỚI lên** (không phải fade mặc định của Monaco). Cần override animation của peek widget hoặc dùng overlay bọc ngoài trượt lên.
- Lý do ưu tiên: "IDE cơ bản là đánh vào UX rồi".

### Kiến trúc dự kiến
- **Main process:** một TS language service chạy trên workspace (dùng `typescript` compiler API — `createLanguageService` + một `LanguageServiceHost` đọc file từ workspace, hoặc chạy `tsserver`). IPC mới: `resolve-definition({ file, line, column }) → { uri, range }[]`.
  - Cân nhắc: khởi tạo lazy (lần peek đầu), cache program, invalidate khi file đổi. Nặng nhưng chạy trong main/worker nên không block renderer (nhớ: main process — có thể cần utilityProcess để không nghẽn IPC khi TS parse project lớn).
- **Renderer:** đăng ký `monaco.languages.registerDefinitionProvider(lang, { provideDefinition })` gọi IPC trên. Đăng ký xong → chuột phải "Peek Definition" + F12 (go to) + Alt+F12 (peek) tự hoạt động với widget native.
  - File mới gợi ý: `src/lib/monacoDefinition.ts`, đăng ký lúc editor mount (cạnh `monacoSetup.ts`).
- **Target file chưa mở:** definition provider trả URI; nếu model chưa tồn tại, tạo model tạm (path-keyed như hiện tại: `Uri.parse(rel)`) để peek render được.

### Làm theo pha
1. **Pha 1 — read-first + peek nổi từ dưới:** show định nghĩa, scroll, "Open full" nhảy sang tab thật (nơi edit/save đã chạy ngon). Hover provider preview nhẹ.
2. **Pha 2 — edit-in-peek:** nối model của peek vào đường save của app (`contentsRef` + dirty + disk). LƯU Ý bẫy: file peek có thể **chưa phải buffer app quản lý** → sửa xong không lưu nếu không wire.

### Tầng tương tác đề xuất
- **Hover** → preview nhỏ (hover provider).
- **Chuột phải / Alt+F12** → peek đầy đủ (editable, scroll, nổi từ dưới).
- **F12** → nhảy thẳng tới định nghĩa.

### Rủi ro / lưu ý
- Edge-clipping: peek native tự lo; nếu tự bọc overlay để làm animation "lặn từ dưới" thì phải tự canh không tràn (giống bài học card review trước đây).
- TS service trên project lớn có thể chậm lần đầu → lazy init + spinner + cân nhắc utilityProcess.
- `automaticLayout: true` đã bật cho editor chính; peek editor con của Monaco tự layout.

</details>

---

## 📋 Backlog còn lại (36 — sau feat/11 + feat/12)

**0 HIGH còn lại.** Tất cả bẫy mất dữ liệu + vòng lặp agent + 2 HIGH đã xong.

### MEDIUM (30) — gom theo cụm

**Chat / Agentflow (7)**
- Snap plain-text→markdown cuối stream reflow cả reply khi đang đọc → parse markdown theo từng đoạn đã hoàn chỉnh. *(đụng phần perf, cẩn thận)*
- `/compact` ghi đè transcript + session đã lưu, không undo, không khoá composer khi chạy → backup bản trước-compact + khoá input.
- Context-window trimming vô hình (hint "/compact" gửi cho model chứ không cho user) → chip inline báo "đã cắt turn cũ · [Compact]".
- Agent error render như bubble thường, không retry, bị replay lại cho model như lời của nó → item kind lỗi riêng + nút Retry + loại khỏi history.
- Review approve từng cái một: không biết "change N of run", không accept-all, không sửa/giải thích khi reject → counter + "Accept rest of run" + ô lý do reject.
- Plan không sửa được trước Approve (mọi tweak = re-plan cả vòng) → cho sửa plan trong ô preview rồi Approve chạy đúng nội dung đã sửa.
- Sub-agent work (kể cả fail) biến mất khỏi session restore; 'blocked' không phân biệt 'error' → persist card sub-agent thành text item; phân biệt blocked/error.

**Editor (4)**
- Save buffer dirty đè lên thay đổi agent vừa ghi ra đĩa → theo dõi mtime/hash, badge tab + confirm khi conflict.
- Agent line-reveal pulse bị click/gõ đầu tiên ở bất kỳ đâu giết mất → scope listener vào DOM editor + auto-fade 15-20s.
- Tab bar tràn: tab active không scroll vào view, class scroll là CSS chết → `scrollIntoView` + wheel handler + thanh scroll thật.
- Browser tab chỉ agent gọi được; đóng là kẹt, không có back/reload → palette "Open Browser" + nút Back/Reload (IPC `goBack`/`reload`).

**Explorer / Git (6)**
- Menu file tree thiếu Copy Path / Copy Relative Path / Reveal in Finder / Duplicate → dùng `shell.showItemInFolder` (chạy cả Finder + Explorer).
- Kéo-thả vào chỗ trống explorer lặng lẽ move về root → hiện drop state + toast Undo.
- Click file đã xoá (status D) trong Source Control hiện raw error làm nội dung → mở diff HEAD vs rỗng, label "(deleted)".
- Quick-open không fuzzy; palette thiếu action git/terminal/chat → thêm subsequence scorer + đăng ký thêm command.
- Inline rename/create bị bỏ khi click ngoài; nested path bị từ chối câm → commit-on-blur khi hợp lệ; cho phép "/" khi tạo.
- Push branch mới chết raw error, không có nút publish → detect no-upstream → retry `push -u origin <branch>` hoặc "Publish branch".

**Terminal / Logs (6)**
- 2 hệ "agent" (PTY resident vs sub-agent chat) chung từ vựng + 1 tab, không cầu nối → đổi tên tab + 2 section rõ ràng trong sidebar.
- Logs Viewer chỉ 15 dòng, không scrollback/search/follow → nâng lên vài trăm dòng + auto-stick bottom + filter.
- Liveness agent vô hình (chỉ thấy trong terminal); "Open PTY" mở nhầm tab → lift poll lên IDEView, chấm màu theo liveness, `setBottomTab('terminal')`.
- Agent PTY thiếu Cmd+F search (shell có) → port SearchAddon + overlay từ ShellTerminal.
- Groups panel "memory" fetch 1 lần không refresh → re-fetch mỗi 3s cho group đang mở + live.
- Kill group 1 click không hỏi (icon skull 13px) → ConfirmDialog hoặc arm 2 bước.

**Feedback (4)**
- Toast lỗi biến mất 6s + chọn text là dismiss → error sticky (duration 0), dismiss chỉ ở nút X, select-text được, nút copy.
- Cost gần như vô hình khi agent chạy → giảm poll cost khi busy + hiện cost run hiện tại cạnh "agent working…".
- Workspace scan lỗi hiện tree rỗng không báo → trả `{ok:false,error}`, toast + state "Couldn't read — Retry".
- Push/pull treo vô hạn spinner không huỷ được → timeout 60s + `GIT_TERMINAL_PROMPT=0` + toast timeout.

**Settings (1)**
- macOS window chrome kiểu Windows (traffic lights ẩn, min/max/close custom bên phải, không fullscreen) → darwin dùng traffic lights native. *(quyết định design)*

**a11y (2) — PARTIAL**
- `div` interactive bị Tab bỏ qua — mới làm session row; còn quét nốt (agent cards, các row khác) → `<button>` hoặc role/tabIndex/keydown.
- Focus rơi về `<body>` — đã fix palette-open-file + dialog-close; kiểm nốt các đường còn lại.

### LOW (6)
- Sub-agents live panel dead-end (text clamp, không mở transcript, không abort, không clear) → row bấm mở SubAgentCard + nút X + tooltip full.
- Mở recent workspace đã mất = no-op câm → toast + prune khỏi recent.
- Chat model picker liệt kê cả provider không có key → cờ `hasKey`, default model của provider có key, dim entry keyless.
- Workspace menu + session-history dropdown không đóng khi click ngoài / Escape → backdrop `fixed inset-0` + Escape handler.
- Setting animations-off + `prefers-reduced-motion` bị bỏ qua (kể cả loop vô hạn) → stamp `data-animations="off"` + CSS `animation: none`.
- **UI 100% tiếng Anh** trong khi user tiếng Việt (Discord bot đã nói tiếng Việt) → bảng string vi/en tối giản, dịch chuỗi rủi ro trước (dialog xác nhận, cảnh báo). *(item to nhất)*

---

## ✅ Đã xong (tham chiếu)
- **feat/11-ux:** diff-view edit capture, quit/switch guard, Undo/Replace-All confirm, session rename/delete fix, **sub-agent approval deadlock**, review card mọi mode, dirty-warn once + Review button, OS notify + badge, stop giữ turn/Undo, ask-error không nuốt, macOS Edit menu, git error toasts.
- **feat/12-ux2:** agent-crash terminal giữ output + Restart, keyboard Cmd+B/J/L + tab cycle + palette, no-provider setup card, provider Test + Fetch-models + price inputs, first-launch "Open a folder", ConfirmDialog focus/trap/restore, focus-visible reveals, palette focus editor, session row keyboard.
