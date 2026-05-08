# Refactor toàn repo Multi-Agent (backup) — gọn module, tách monolith, README gộp, +pytest

[GOAL] Refactor cấu trúc + code repo backup tại `C:\Users\ADMINA1\Downloads\hi\multi-agent\Multi-Agent` để gọn, dễ đọc, dễ mở rộng, KHÔNG đổi behavior người dùng thấy. Sau refactor: mọi flow hiện có (spawn agent, plan→approve→orchestrator, inbox, tasks, terminals, cost dashboard) chạy y nguyên; có 5 UI polish nhỏ; có pytest cho runtime; README gộp 1 file. User review trên backup, OK thì tự merge sang repo chính.

[CONTEXT]
- Target: `C:\Users\ADMINA1\Downloads\hi\multi-agent\Multi-Agent` (BACKUP). Repo chính = `Downloads\multi-agent\Multi-Agent` (chỗ planner đang chạy) — KHÔNG đụng.
- User flow: Claude làm trên backup → user review → user tự merge vào chính.
- Cấu trúc backup giống chính:
  - `agents/<role>/` — 8 role (planner, orchestrator, BE/FE/AIE engineer + BE/FE/AI reviewer) + folder `reviewer/` legacy → **GIỮ làm reference, không xoá**.
  - `project/backend/` — chỉ `hello.py`, `parsers.py`, `ai/`. Demo, không refactor.
  - `project/frontend/` — Electron+React+Vite+TS. 19 component, App.tsx 247, **electron/main.ts 1213 dòng (monolith)**, preload.ts 97.
  - `scripts/` — **agent_runtime.py 547 dòng**, clone-agent.sh, destroy-agent.sh, launch-tmux.sh, keyring.sh, monitor.sh, reset.sh, send.sh, sync-agent-md.sh.
  - `shared/` — inbox/, outbox/, logs/, artifacts/, agents-config.json, tasks.json.
  - Doc: `README.md` (cũ) + `README.draft.md` (mới EN) → **gộp**.
- Hotspot: electron/main.ts (B), agent_runtime.py (C), PlanComposer/App hooks (D), README (G).

[SCOPE]
**A. Cleanup nhẹ (giữ legacy reviewer)**
- Xoá `__pycache__/`, `.bak`, file tmp.
- Verify (grep) `agents/reviewer/` không còn được runtime tham chiếu — nếu có ref thì comment kèm `# legacy ref` để khỏi vỡ; KHÔNG xoá folder (user yêu cầu giữ làm ref).
- Update `.gitignore` nếu thiếu `__pycache__`, `node_modules`, `dist-electron`, `.DS_Store`.

**B. Tách `electron/main.ts` (1213 → ~200 entry + modules)**
- `electron/ipc/agents.ts` — spawn/restart/kill/list/model picker.
- `electron/ipc/tasks.ts` — tasks.json (create/split/update-status/list).
- `electron/ipc/inbox.ts` — read/append/clear inbox + outbox archive.
- `electron/ipc/plan.ts` — Plan Composer approve flow.
- `electron/ipc/cost.ts` — cost tracking aggregate.
- `electron/ipc/logs.ts` — tail/search log files.
- `electron/services/pty.ts` — node-pty + idle GC + 15min kill.
- `electron/services/watcher.ts` — chokidar wrapper.
- `electron/main.ts` — chỉ app.whenReady, BrowserWindow, register modules.
- Move-only, không đổi logic. Smoke test sau move.

**C. Tách `scripts/agent_runtime.py` (547 → ~150 entry + package)**
- `scripts/runtime/__init__.py`
- `scripts/runtime/spawner.py` — spawn CLI per backend (claude/codex/gemini/api/lmstudio).
- `scripts/runtime/idle.py` — idle tracker + 15min GC.
- `scripts/runtime/keyring_io.py` — wrapper qua `keyring.sh`.
- `scripts/runtime/dispatch.py` — chọn backend per-agent từ `shared/agents-config.json`.
- `scripts/agent_runtime.py` — thin entrypoint CLI (giữ y argv/exit code).

**D. Frontend tách hooks**
- `PlanComposer.tsx` (424) → `usePlanDraft` (poll + write) + `usePlanApprove` (IPC).
- `App.tsx` (247) → `useTabs` + `useGlobalShortcuts` nếu inline state.
- Component focus render. Không đổi UI.

**E. UI polish (5 cái, làm hết, mỗi cái 1 PR)**
- E1. Status pill cho mỗi tab agent (idle/running/error) — badge nhỏ cạnh tên tab, đọc từ runtime state.
- E2. Quick "Approve & Send" floating button trong Plan Composer khi scroll dài.
- E3. Cost dashboard: thêm tổng day/week/month + per-backend chart đơn giản (recharts hoặc inline SVG, không bump major dep).
- E4. Inbox filter theo `FROM:` để dễ trace conversation.
- E5. Confirm dialog trước khi gọi `destroy-agent.sh`.

**F. Pytest cho `scripts/runtime/*`** (sau khi C xong)
- `scripts/tests/test_dispatch.py` — load agents-config.json mock → assert backend selection.
- `scripts/tests/test_idle.py` — fake clock → assert idle threshold trigger.
- `scripts/tests/test_spawner.py` — mock subprocess → assert đúng argv per backend.
- `scripts/tests/test_keyring_io.py` — mock keyring.sh → assert get/set/delete.
- `scripts/requirements.txt` đã có pytest? nếu không, append `pytest`.
- Doc 1 dòng trong README: `cd scripts && pytest`.

**G. README gộp**
- Merge `README.draft.md` (EN, mới) vào `README.md` chính. Xoá `README.draft.md`.
- Đảm bảo có: overview, architecture diagram, quick start (start.command), agent roles, message protocol, troubleshooting.
- Ngôn ngữ: EN (theo draft mới).

Không làm:
- Không xoá `agents/reviewer/` legacy.
- Không đổi protocol inbox / `tasks.json` schema.
- Không đổi spawn/idle policy (pre-warm 2, lazy 6, idle 15m).
- Không bump major dep (Electron, React, Vite).
- Không refactor `project/backend/hello.py` (demo).
- Không đụng repo chính `Downloads\multi-agent\Multi-Agent`.

[CONSTRAINTS]
- Mọi work làm trên BACKUP `Downloads\hi\multi-agent\Multi-Agent`.
- Mỗi sub-task = 1 PR/commit độc lập, có thể merge riêng.
- Smoke test bắt buộc sau B, C, D, mỗi E*: `npm run dev` + click qua Planner/Orchestrator/Tasks/Terminals/Plan tab + spawn 1 worker.
- Pytest (F) phải pass trước khi đóng F.
- Path public bất biến: `shared/inbox/<role>.md`, `shared/tasks.json`, `agents/<role>/AGENT.md`.

[ACCEPTANCE]
- `electron/main.ts` ≤ 250 dòng.
- `scripts/agent_runtime.py` ≤ 200 dòng.
- `agents/reviewer/` vẫn còn (user yêu cầu giữ).
- App khởi động → planner+orchestrator spawn → chat OK.
- User idea → planner draft → Plan Composer approve → orchestrator nhận → OK.
- New Task Dialog → tasks.json update → OK.
- Mở tab BE/FE/AIE → spawn fresh + nhận "check inbox" trong 5s → OK.
- Idle 15 phút → 6 worker bị kill, planner+orchestrator sống → OK.
- Cost dashboard hiển thị + có total day/week/month + chart → OK.
- Status pill hiển thị trên mỗi tab agent.
- Plan Composer có floating Approve button khi scroll.
- Inbox lọc được theo FROM.
- Destroy agent có confirm.
- `cd scripts && pytest` → all green.
- 1 file `README.md` (EN), không còn `README.draft.md`.

[DELIVERABLES]
PR/commit độc lập trên branch backup:
- A. `chore: cleanup pycache + gitignore tweaks`
- B. `refactor(electron): split main.ts into ipc/* and services/*`
- C. `refactor(scripts): split agent_runtime.py into runtime/ package`
- D. `refactor(frontend): extract hooks from PlanComposer + App`
- E1. `feat(ui): agent status pill on tabs`
- E2. `feat(ui): floating Approve button in Plan Composer`
- E3. `feat(ui): cost dashboard totals + per-backend chart`
- E4. `feat(ui): inbox filter by FROM`
- E5. `feat(ui): confirm dialog before destroy-agent`
- F. `test(scripts): pytest suite for runtime/*`
- G. `docs: merge README.draft into README, EN`

Mỗi PR kèm: diff summary, smoke checklist, before/after line count.

**Suggested execution order & deps:**
1. A (cleanup) — no dep.
2. B (electron split) — no dep.
3. C (scripts split) — no dep.
4. F (pytest) — depends on C.
5. D (frontend hooks) — no dep, có thể song song với B.
6. E1..E5 — depends on D (hooks sạch rồi mới chèn UI mới gọn).
7. G (README) — cuối cùng, sau khi feature E xong để doc đúng.

Owner gợi ý:
- A, G → **frontend-engineer** (file FE + docs).
- B, D, E1..E5 → **frontend-engineer**.
- C, F → **backend-engineer** (Python).
- Mỗi PR cần **be-reviewer** hoặc **fe-reviewer** review tương ứng.

Hãy plan trước (tách sub-task, gán owner, deps), trình bày plan cho tôi confirm rồi mới ghi tasks.json và gửi inbox. Đừng fan-out luôn.
