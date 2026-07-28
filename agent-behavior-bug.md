# Agent — hành vi lỗi quan sát được

> **Trạng thái: ĐÃ VÁ A-D + kiểm chứng xong trên app thật (2026-07-28).**
> 5/5 phép thử đạt. Quá trình thử phát hiện thêm một bug nữa (`AbortError` lọt
> thành `error`) — đã vá và thử lại. Chi tiết ở checklist cuối file.
>
> Ngày ghi: 2026-07-27. Nguồn: một phiên chạy thật — 4 `SpawnAgent` trong 1 turn
> (3 báo cancelled), rồi 2 `SpawnAgent` (cả 2 trả về đúng câu mở đầu).
> **Hai lỗi khác nhau**, không phải một.
>
> **Cập nhật 2026-07-28:** đường abort "bí ẩn" ở mục 1/3 đã tìm ra (grep trượt
> chuỗi). Thêm mục 5-6: long session tự ngắt im lặng + thiết kế thay `MAX_TURNS`.
> Phạm vi tài liệu giờ là cả IDE agent, không riêng sub-agent.
>
> Phần mô tả bug bên dưới **giữ nguyên ở thì hiện tại** làm hồ sơ nguyên nhân —
> đọc kèm checklist ở cuối để biết chỗ nào đã sửa và sửa thế nào.
>
> Liên quan: `IDE_AGENT_DESIGN.md` (thiết kế IDE agent), `MULTIAGENT_DESIGN.md`
> (lớp group v2 — hiện `enabled: false` ở `group-coordinator.ts:32`).

---

## 1. Con dùng CHUNG AbortController với cha

Đường đi đã xác nhận trong code:

- `main.ts:2121` — `spawnSubAgent` đóng gói `ac` của run cha rồi truyền
  `ac.signal` xuống `runIdeAgent` của con. Con **không có** controller riêng.
- `ide-agent.ts:671` (đầu mỗi turn) và `:803` (trước mỗi tool call) — kiểm
  `signal.aborted` → `emit({ type: 'error', error: 'cancelled' })`.
- `childEmit` (`main.ts` trong `spawnSubAgent`) — biến event đó thành
  `summary = 'error: cancelled'`, `rec.status = 'error'`.

→ **Bất cứ thứ gì abort run cha là giết sạch con đang chạy**, và chúng báo về
đúng chữ "cancelled".

Đã loại trừ: KHÔNG phải `MAX_SUBAGENTS` (`main.ts:2014` = 4). Bốn call trong
cùng một turn được dispatch tuần tự nên lần lượt thấy `running` = 0,1,2,3 — cả
bốn đều qua cửa.

**~~Còn hở, chưa giải thích được~~ — ĐÃ GIẢI (2026-07-28):** grep trượt chuỗi.
`src/` không gọi tên channel `ai-agent-cancel`, nó gọi tên method camelCase:

```
ChatPanel.tsx:986:  if (wasAgent) window.api.aiAgentCancel(reqIdRef.current)
```

Nằm trong `stop()`, và `stop()` có **5 caller**: nút Stop, `/stop` (`:1098`),
`clear()` (`:1022`), `newSession()` (`:498`), `loadSession()` (`:510`) — cộng
`ChatPanel.tsx:443`, effect theo dõi `workspaceRoot`:

```js
if (isSwitch) { if (reqIdRef.current) stop() }
```

Không có đường abort thứ hai. Vì con dùng chung signal với cha, **một lần
`stop()` giết sạch mọi con đang chạy** và chúng báo về đúng chữ "cancelled" —
khớp chính xác hiện tượng "4 SpawnAgent, 3 cancelled" ghi ở đầu file.

**Vá:** cho con một `AbortController` riêng, *link* tới cha (cha stop → chủ động
abort con) thay vì dùng chung signal.

## 2. `done` rỗng bị tính là thành công

- `spawnSubAgent` trả `summary || '(sub-agent finished without a summary)'`, với
  `summary = e.text` khi con emit `done`.
- Quan sát: con trả về đúng `"I'll map that source tree now."` → con chạy tới
  `break` ở `ide-agent.ts:780` (turn không có tool call nào), `finalText` lúc đó
  chỉ có câu mở đầu.
- `looksLikeAnnouncedAction` nudge (tối đa 2, `ide-agent.ts:762`) tồn tại đúng
  cho tình huống này → hoặc nudge không khớp câu đó, hoặc khớp mà con vẫn không
  gọi tool.
- Con **thực sự không làm gì**, chứ không phải làm rồi mất kết quả.
- `rec.status` vẫn thành `'done'`, không có timeout → nhìn từ ngoài giống thành
  công. Cha nhận câu mở đầu như thể là summary.

**Vá:** phân biệt `done` rỗng với `done` thật — con không chạy tool nào và text
ngắn thì đánh `status: 'error'` kèm lý do.

## 3. ~~Cách tìm nốt đường abort bí ẩn~~ — không còn cần

Đã xác định ở mục 1: `ChatPanel.tsx:986` trong `stop()`. Không cần thêm log dò.

Điều đáng làm thay vào đó: `stop()` hiện giết cả cây con **im lặng**. Sau khi vá
mục 1 (con có controller riêng), cha stop vẫn nên abort con — nhưng con phải báo
`reason: 'parent_stopped'` thay vì `error: 'cancelled'`, để phân biệt với lỗi thật.

## 4. Cùng một biên, lần thứ hai

Comment ở `main.ts:2149-2153` đã ghi rằng `pending_change` / `file_changed` phải
forward sang channel của cha, không thì review mode deadlock và file subagent
ghi không bao giờ reload. Cộng với mục 1 và 2: cả ba lỗi đều sinh ra ở **ranh
giới cha ↔ con**, không có cái nào là logic sai bên trong một tầng. Đáng cân
nhắc một contract chung cho việc bắc event/lifecycle qua biên này thay vì vá
từng đường một.

## 5. Long session tự ngắt — bốn lối thoát IM LẶNG

Triệu chứng user báo: job nặng, session dài, agent dừng giữa chừng, UI hiện
"Agent finished", không có lý do nào. Có **bốn** đường ra khỏi vòng lặp mà không
đường nào mang theo nguyên nhân.

**Đường 1 — cạn `MAX_TURNS` (thủ phạm chính).**

```js
for (let i = 0; i < MAX_TURNS; i++)              // ide-agent.ts:670, mặc định 30
emit({ type: 'done', text: finalText, turns })   // :1095 — KHÔNG mang lý do
```

Rơi khỏi vòng lặp → `done` y như hoàn thành bình thường. **Mỗi tool call là một
turn**: đọc 10 file + sửa 5 + chạy test đã gần hết 30. Chữa tạm: biến môi trường
`IDE_AGENT_MAX_TURNS` (đọc ở `:29`, chỉ ăn trong dev vì main process kế thừa env
từ `npm run dev`).

**Đường 2 — provider trả rỗng, `anyActivity` che mất guard.**

Prompt to → gateway drop stream → trả rỗng → retry 3 lần (`:698`) vẫn rỗng →
`toolCalls.length === 0`, không `capped`, text rỗng nên không nudge → tới guard
cuối `:776`:

```js
if (!finalText && !streamedThisTurn && !anyActivity)
```

Session dài thì `anyActivity === true` (đã chạy tool từ lâu) → guard **không**
kích hoạt → `break` → `done` với `finalText` của lượt **TRƯỚC**. Agent dừng, hiện
lại câu cũ, nhìn như xong.
**Vá:** bỏ `!anyActivity` khỏi điều kiện, hoặc tách riêng `reason: 'empty_response'`.

**Đường 3 — cạn `intentNudges`** (`:762`, cap 2) → `break` với chỉ câu dẫn nhập.
Cùng gốc với mục 2 của tài liệu này.

**Đường 4 — abort** (xem mục 1 + 3).

**Chẩn đoán nhanh không cần sửa code:** `:708` đã in sẵn mỗi lượt ra stdout của
main process — chạy bằng `npm run dev` rồi nhìn dòng cuối lúc nó ngắt.

```
[agent] turn=12 finish=stop dropped=false tools=2 textLen=340 in=48210 out=210
```

| Dòng cuối | Đường |
|---|---|
| `turn=30` | 1 — cạn MAX_TURNS |
| `textLen=0 tools=0` | 2 — provider rỗng |
| `dropped=true` | 2 — gateway đứt stream |
| `finish=length` | chạm output cap (có cảnh báo riêng) |

## 6. Trần lượt là SAI ĐƠN VỊ ĐO — thay bằng gì

Số liệu thật từ `shared/state.db`, `role='ide-agent'` (đo 2026-07-28):

- **Cost không phải ràng buộc:** $2.40 cho 1380 lượt gọi. VietAPI tính phẳng
  $0.5/Mtok — một vòng lặp chạy hoang cả buổi cũng chỉ vài đô.
- **Context không phải ràng buộc:** 99.9% số lượt có prompt < 128k. Chỉ một
  outlier 781k (claude-opus-4.8) trên tổng 1380.

Vậy `MAX_TURNS = 30` **không bảo vệ gì cả**, nó chỉ chặn đúng thứ cần chạy dài.
Nhưng vẫn còn một failure mode thật: model kẹt vòng lặp (Read → Edit → Read cùng
một file, hoặc gọi lại tool vừa lỗi). Đếm lượt là công cụ dò vòng lặp tệ — nó
phạt job tốt và job kẹt như nhau.

**Thay bằng bốn thứ:**

1. **Soft checkpoint thay hard stop.** `SOFT_CHECKPOINT = 40` → emit event cho UI
   hiện "đã 40 lượt, đang tiếp tục…", **không dừng**. `HARD_CEILING = 400` chỉ làm
   backstop chống chạy qua đêm.

2. **Dò không-tiến-triển** — đây mới là thứ thay thế thật. Đếm lượt *vô ích liên
   tiếp*, không phải tổng lượt:
   - reset streak khi: có file mutation, **hoặc** chữ ký tool
     `(name + JSON.stringify(args))` chưa từng thấy trong run
   - tăng streak khi: lặp lại chữ ký đã gọi, hoặc turn không tool nào chạy
   - `unproductiveStreak >= 8` → dừng, `reason: 'no_progress'`

   Job thật gần như không bao giờ chạm 8; vòng lặp kẹt chạm sau vài giây.

3. **Trần chi phí làm backstop, đặt cao.** Cost đã tính sẵn ở `:721`, chỉ cần cộng
   dồn trong loop. `IDE_AGENT_MAX_USD` mặc định $5. Không phải để tiết kiệm — để
   một bug vòng lặp lúc 2h sáng không chạy tới sáng.

4. **Mọi lối dừng mang `reason`.** Thêm vào event `done`:

   ```ts
   | { type: 'done'; text: string; turns: number
       reason: 'completed' | 'no_progress' | 'budget' | 'hard_ceiling'
             | 'empty_response' | 'nudge_exhausted' | 'parent_stopped' }
   ```

   ChatPanel hiện một dòng khi `reason !== 'completed'` (vd *"⚠ Dừng: không tiến
   triển sau 8 lượt"*). Đây là phần làm "tự ngắt không hiểu tại sao" biến mất hẳn.

**Phạm vi ước lượng:** ~40 dòng trong `ide-agent.ts`, một field trên
`IdeAgentEvent` (khai hai nơi: `ide-agent.ts:418` và `src/lib/api.ts:334`), một
dòng render trong `ChatPanel.tsx`. Không đụng kiến trúc.

## 7. Docx "sửa tào lao" — ba nguyên nhân, đã tái hiện và đã vá

> Ngày 2026-07-28. Không suy đoán từ code: mỗi lỗi bên dưới đều dựng thí nghiệm
> có đáp án biết trước, chạy trên app thật, rồi đọc lại XML để đối chiếu.

**7.1 — Index lệch sau chèn/xoá (nguyên nhân lớn nhất).**
Yêu cầu: chèn một dòng trước ¶1, rồi in đậm "Điều 2: Thanh toán" (¶7). Agent gọi
đúng thứ tự hợp lý `DocxOutline → DocxInsertParagraph → DocxFormatRun(7)` —
nhưng lần chèn đã đẩy mọi index từ ¶1 trở đi lên 1, nên ¶7 giờ là đoạn **trước**
mục tiêu. Kết quả đo được: `Bên A giao cho Bên B…` bị in đậm, `Điều 2` thì không.
Agent báo hoàn thành. Lỗi **cộng dồn** theo mỗi thao tác cấu trúc.
**Vá:** `structureVersion` / `outlinedVersion` trên `DocxSession`. Mọi tool định
vị bằng ¶index gọi `requireFreshOutline()` trước; `insertParagraph` /
`deleteParagraph` / `insertTable` bump version sau khi đổi. Sai thành **không
thể**, không phải "không nên".
**Đã kiểm chứng lại:** chuỗi tool thành
`DocxOutline → DocxInsertParagraph → DocxFormatRun ✗ → DocxOutline → DocxFormatRun ✓`,
và ¶8 (đúng đoạn) được in đậm.

**7.2 — Agent bỏ tool docx, dùng `Bash` + python-docx.**
Đây là nguồn của cả "hỏng format" lẫn "viewer không cập nhật":
- `para.text = …` trong python-docx **xoá sạch mọi run**. Đo trên hợp đồng thật:
  run mang `b=on, i=on, sz=26, rFonts=Times New Roman` → sau khi sửa còn `[]`.
  Đậm/nghiêng/cỡ chữ/font bay hết, lệnh vẫn báo thành công.
- `Bash` không nằm trong `DOCX_MUTATORS` nên **không phát `file_changed`** →
  viewer chỉ bắt kịp ở cuối run, giữa chừng nhìn như đứng im.

Vì sao prompt không cứu được: prompt đã ghi rõ *"NEVER unzip/edit/repack it by
hand with Bash"*, nhưng `Bash` là **core tool** luôn sẵn, còn `Docx*` phải
`LoadToolGroup` trước. Đường tắt luôn thắng lời dặn.
**Vá:** chặn `Bash` khi command vừa nhắc tới `.docx/.xlsx/.pptx` vừa khớp mẫu
ghi (`python|unzip|zip|sed|mv|rm|…` hoặc redirect vào file đó). `ls/cp/stat` vẫn
qua. **Đã kiểm chứng:** ép model dùng Bash → 3 lần bị từ chối → nó tự chuyển
sang `LoadToolGroup → DocxOutline → DocxReplaceText`.

**7.3 — `Bash` không làm mới surface nào.**
**Vá:** `Bash` thành công → phát `file_changed` với path rỗng; `onAgentFileChanged`
hiểu path rỗng là "làm mới tất cả" (`bumpOpenDocx` + `reloadOpenTextBuffers` +
`refreshWorkspace`).

**Đã loại trừ (từng nghi, đo xong thì sai):**
- Viewer không live-update: **có** update. Lần đầu tưởng hỏng là do phép so của
  người kiểm chỉ lấy 200 ký tự đầu, mà chỗ sửa nằm sau đó.
- Lệch index giữa engine và viewer: trên hợp đồng thật **91 = 91**, không lệch.
  (`bodyParagraphs` = con trực tiếp của `w:body`; `tagParagraphs` loại
  `p.closest("table")` + header/footer → hai cách đếm trùng nhau.)

**7.4 — Căn cột: đo sai, không phải "không nhìn thấy".**
Câu hỏi tự nhiên là *"agent đâu có thấy mà căn"*. Nhưng căn bằng tab stop là thứ
**kiểm chứng được bằng cấu trúc**: mọi dòng chung một tab stop + đúng một tab sau
nhãn ⇒ thẳng hàng, **miễn là không nhãn nào rộng hơn vị trí tab stop**. Vượt qua
thì tab nhảy sang mốc mặc định kế tiếp và riêng dòng đó lệch.

Chỗ tính vị trí đó đang đoán: `số ký tự × 7 + 18`, **không đọc cỡ chữ lẫn font**.
Đo bằng chính text metrics của trình duyệt cho thấy sai cả hai chiều:
`Người đại diện theo pháp luật:` ở 11pt rộng 134pt chứ không phải 228pt (thừa
~3cm), còn `Số CMND/CCCD:` ở 18pt rộng 137pt chứ không phải 109pt — **thiếu, và
thiếu mới là cái làm vỡ hàng**.

**Vá:** bảng bề rộng em cho Times New Roman + hệ số theo họ font, nhân cỡ chữ đọc
từ `w:sz` của chính run đó (dấu tiếng Việt là combining mark trong NFD nên không
cộng bề rộng — `ê` rộng đúng bằng `e`). Biên lệch ra ngoài 8% + 8pt vì thừa chỉ
xấu còn thiếu là hỏng. `DocxAlignColumns` trả về luôn số đo, và từ chối nếu bị
ghim một `position` hẹp hơn nhãn rộng nhất. `DocxInspect` báo `beforeTab≈Npt` cho
mọi đoạn có tab stop — đó là cách agent tự xác nhận mà không cần nhìn.

**Đã kiểm chứng** trên tài liệu trộn 11pt và 20pt, đối chiếu với canvas:

| nhãn | ước lượng | đo thật | lệch |
|---|---|---|---|
| `Họ và tên:` | 48pt | 49pt | −1 |
| `Số CMND/CCCD:` | 87pt | 87pt | 0 |
| `Người đại diện theo pháp luật:` | 140pt | 144pt | −4 |

Sai số ~3% và luôn lệch **thấp**, nên biên an toàn là cần chứ không thừa. Tool
chọn 162pt cho nhãn rộng nhất 144pt (dư 18pt); công thức cũ sẽ chọn 228pt. Ghim
`position: 100` bị từ chối kèm đúng con số phải dùng.

**CÒN LẠI, chưa vá:**
- `DocxReplaceText` rơi vào nhánh dự phòng (chuỗi vắt qua nhiều run) thì làm
  phẳng định dạng cả đoạn mà **câu trả về không hề khác** nhánh an toàn.
- Chưa có `replace_all`, chưa có replace toàn tài liệu — hợp đồng có placeholder
  lặp thì phải gọi tay từng ¶, rất dễ sót.
- `DocxAlignColumns` gỡ hết run rồi dựng lại chỉ với rPr của run đầu và run
  cuối → định dạng ở giữa mất.
- Chưa có: header/footer, numbering (`w:numPr`), page setup (`w:sectPr`), thao
  tác dòng/cột/merge/shading của bảng.

---

## Phụ lục — hai bug cùng họ, cũng chưa vá

Không thuộc sub-agent nhưng cùng loại "lỗi biên", ghi kèm cho khỏi thất lạc.

**Tool result bị cắt sai đầu** — `src/components/ChatPanel.tsx`:
`TOOL_RESULT_BUDGET = 800` (dòng 80, dùng ở 170), `serializeItems` cắt 1000
(dòng 205), render cắt 1000 (dòng 2239), `HISTORY_CHAR_BUDGET = 48_000` (dòng
125). Cả bốn đều `slice(0, n)` — lấy **đầu**. Với output append-only (log, tail
của `BashOutput`) thì đầu là phần vô dụng nhất → mất các lượt giữa của phiên
dài. `BashOutput` ở `extra-tools.ts:857` tail đúng (`clean.slice(-6000)`), lỗi
chỉ ở lúc dựng lại history. **Vá:** ưu tiên đuôi, hoặc giữ `head + '…' + tail`.

**Buffer editor không reload khi path không khớp chuỗi** —
`src/components/IDEView.tsx`, `onAgentFileChanged`: chỉ reload khi
`contentsRef.current.has(relPath)` khớp chính xác → miss với path tuyệt đối hoặc
NFD/NFC khác nhau (tên file có dấu). Lưới an toàn lúc run chuyển busy → idle chỉ
gọi `bumpOpenDocx()`, **file text không được hưởng**. Nặng hơn với subagent:
`spawnSubAgent` truyền `editorBridge = undefined` cho con (con không được lái
editor của user), nên `file_changed` là đường **duy nhất** để tab reload.
**Vá:** normalize NFC/NFD, fallback theo basename, và reload buffer text đang mở
khi run kết thúc — đúng như đã làm cho docx.

**Đã rút lại (không phải bug):** exit code của `Bash`. `runChild`
(`electron/agent-tools.ts`) map `err.code` đúng, có `spawnError` riêng cho
ENOENT và cờ `timedOut`. Hiện tượng "exit 0 kèm exit=127" là do command tự viết
dạng `... ; echo "exit=$?"` — shell trả exit của `echo`.

---

## Checklist vá — làm một lượt

> **ĐÓNG APP TRƯỚC.** `package.json.main` trỏ `dist-electron/main.js`; build đè
> lúc đang chạy sẽ giết phiên hiện tại. Sau khi vá: `npm run build` rồi mở lại.

Thứ tự có chủ đích: (A) là contract chung mà (B)(C) dựa lên, nên làm trước.

**A. Contract biên cha ↔ con** — `ide-agent.ts`, `main.ts` · *mục 1, 3, 4*
- [x] Con có `AbortController` riêng, link tới cha (`main.ts` `spawnSubAgent`:
      `childAc` + listener `onParentAbort`, gỡ trong `finally`). Handle giữ ở
      `subAgentAborts` — **không** nhét vào `SubAgentRec` vì record đó bị
      structured-clone sang renderer, function không clone được.
- [x] Con bị dừng báo `reason: 'parent_stopped'` / `'user_stopped'`, không còn
      `error: 'cancelled'`. Phụ thu: hết cảnh vừa hiện "⏹ Stopped." vừa "⚠ cancelled".
- [x] Danh sách forward gom vào `FORWARD_TO_PARENT` (`main.ts`), thay điều kiện viết tay

**B. Lối dừng mang lý do** — `ide-agent.ts`, `src/lib/api.ts`, `ChatPanel.tsx` · *mục 5*
- [x] `StopReason` + `reason` trên event `done`, khai **hai** nơi kèm comment chéo
- [x] Guard rỗng bỏ `!anyActivity` **và** `!finalText` → `'empty_response'`.
      `anyActivity` thành biến chết, đã gỡ hẳn (tsc `noUnusedLocals` bắt).
- [x] Cạn `intentNudges` → `'nudge_exhausted'` (trước đây rơi xuống `break`)
- [x] Con không gọi tool nào → `status: 'error'` + summary nói rõ nó chỉ nói gì.
      Dùng cờ `childRanTool` bắt từ event `tool_call`, không đoán theo độ dài text.
- [x] `STOP_REASON_NOTE` trong `api.ts`; ChatPanel + SubAgentCard cùng render từ đó

**C. Thay `MAX_TURNS`** — `ide-agent.ts` · *mục 6*
- [x] `SOFT_CHECKPOINT = 40` → event `checkpoint`, **không** dừng; ChatPanel hiện
      "N lượt · $X" cạnh "working…" (state riêng, không đẩy vào transcript)
- [x] `HARD_CEILING = 400` → `'hard_ceiling'`
- [x] `unproductive >= 8` → `'no_progress'`
- [x] Cộng dồn cost, `IDE_AGENT_MAX_USD` mặc định $5 → `'budget'`
- [x] **Ngoài checklist:** dò tiến triển so cả *fingerprint kết quả*, không chỉ
      chữ ký `(name+args)`. Thiếu cái này thì agent poll `BashOutput` chờ build
      8 lượt sẽ bị hiểu nhầm là kẹt vòng lặp — false positive rất dễ gặp.

**D. Hai bug phụ lục**
- [x] `clampMiddle()` giữ `head 30% + đuôi 70%`, thay `slice(0, n)` ở cả 3 chỗ
      thật (`HISTORY_CHAR_BUDGET` không phải chỗ thứ 4 — nó giữ newest-first,
      vốn đã đúng hướng)
- [x] `resolveOpenBuffer()`: NFC/NFD + path tuyệt đối + basename (chỉ khi duy
      nhất). `reloadOpenTextBuffers()` chạy khi run chuyển busy → idle, bỏ qua
      buffer đang dirty để không đè sửa chưa lưu của user.

**Kiểm chứng — ĐÃ CHẠY TRÊN APP THẬT (2026-07-28, model `kimi-2.7`, ~$0.36)**

Lái qua CDP (cùng cách `__real.mjs` làm), workspace sandbox 45 file `.ts`.

- [x] **Job dài** — 49 lượt, đi thẳng qua mốc 30 cũ, `checkpoint` hiện đúng ở lượt
      40 kèm chi phí và **vẫn chạy tiếp**, kết thúc tự nhiên `reason: completed`.
- [x] **Stop khi có sub-agent** — 2 sub-agent đang chạy, bấm Stop: không còn
      `⚠ cancelled`, không có `aborted`, đúng MỘT `⏹ Stopped.`, cả hai thẻ con
      không đỏ. *(Lần chạy đầu FAIL → xem bug mới bên dưới.)*
- [x] **`no_progress`** — 3 lượt, mỗi lượt một `Read` cùng path: lượt 1 tính tiến
      triển, lượt 2–3 trùng chữ ký + trùng kết quả → chạm ngưỡng, dừng đúng, hiện
      đúng dòng cảnh báo. Không chạy hết 25 vòng như prompt đòi.
- [x] **Log khớp UI** — số lượt đối chiếu qua bảng `usage`, không thấy mâu thuẫn.
- [x] **Poll `BashOutput`** — 15 lần gọi liên tiếp cùng args, ngưỡng 8, **không**
      bị chặn. Xác nhận phần so fingerprint kết quả là bắt buộc, không phải thừa.

**Bug MỚI do chính phép kiểm chứng 2 phát hiện — đã vá:**
Stop rơi đúng lúc request đang bay thì `fetch` ném `AbortError`. Chuỗi này không
khớp regex "transient" ở `:698` nên `throw` lên catch ngoài cùng → phát
`error: This operation was aborted`. Tức là dừng chủ ý vẫn hiện như sự cố, và
thẻ sub-agent vẫn đỏ. **Vá:** hoist `finalText`/`turns`/`abortReason` ra ngoài
`try`, và cho catch nhận diện abort → phát `done` với `abortReason` thay vì
`error`. Ba lần check `signal.aborted` giữa các lượt là chưa đủ — phải bịt cả
đường ném từ trong request.

**Giới hạn đã biết của `no_progress`:** bộ đếm tính theo **lượt**, không theo
**lời gọi**. Model gói N lời gọi giống hệt nhau vào một lượt (kimi-2.7 làm thế
rất hăng) thì chỉ tích một lượt vô ích. Với hình dạng kẹt thật — gọi → nhận kết
quả → gọi lại y hệt ở lượt sau — đếm theo lượt là đúng, nhưng đây là điểm mù:
để dựng lại phép thử phải ép model "gọi một lần rồi báo cáo, chờ lượt sau mới
gọi tiếp", nếu không nó gộp hết và guard không bao giờ chạm ngưỡng.

**Biến môi trường mới** (đều có mặc định, không cần set):
`IDE_AGENT_SOFT_CHECKPOINT=40` · `IDE_AGENT_MAX_TURNS=400` (giờ là trần cứng,
không còn là 30) · `IDE_AGENT_MAX_UNPRODUCTIVE=8` · `IDE_AGENT_MAX_USD=5`
