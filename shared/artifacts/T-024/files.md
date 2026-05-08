# T-024 — Electron dashboard upgrade

## New components
- `project/frontend/src/components/TaskFilterTabs.tsx` — status tab bar with counts
- `project/frontend/src/components/TaskDetailPanel.tsx` — side panel with priority/deps inline edit + dep status badges
- `project/frontend/src/components/InboxMessageCard.tsx` — parses inbox markdown by `---`, exports `parseInbox()` + collapsible card with raw view toggle
- `project/frontend/src/components/ArtifactViewer.tsx` — 3-pane viewer (tasks list / file tree / preview), markdown render + code preview, no extra deps
- `project/frontend/src/components/LogSearchBar.tsx` — search input + multi-select agent chips + JSON/CSV export
- `project/frontend/src/components/RestartAgentButton.tsx` — confirm + ptyRestart

## Updated components
- `project/frontend/src/App.tsx` — added 'artifacts' view, wired `onOpenArtifact` from TasksPanel → ArtifactViewer
- `project/frontend/src/components/TasksPanel.tsx` — uses `TaskFilterTabs`, click row → `TaskDetailPanel`
- `project/frontend/src/components/InboxPanel.tsx` — renders `InboxMessageCard` list with global Raw/Cards toggle
- `project/frontend/src/components/LogsPanel.tsx` — search/filter/export, Recent vs Full logs toggle
- `project/frontend/src/components/TerminalsView.tsx` — per-tab `AgentModelPicker` with confirm-restart on change, `RestartAgentButton`
- `project/frontend/src/lib/api.ts` — added `Priority` field on `Task`, types for `getAllLogs`, `updateTask`, `listArtifactTasks/Tree`, `readArtifactFile`, `ptyRestart`, `PRIORITY_STYLES`
- `project/frontend/electron/preload.ts` — exposed all new IPC handlers (already existed in main.ts)
- `project/frontend/electron/main.ts` — `update-task` now accepts `priority`, `create-task` saves `priority` on the task

## Build
- `npm run build` passed (TypeScript strict, no `any` warnings).
- Bundle: 521 KB JS / 35 KB CSS — no new dependencies added.

## Notes
- Markdown rendering is a small in-house function (~70 LOC) instead of `prism-react-renderer` to avoid adding a dep. Handles headings, lists, fenced code, inline code/bold/italic/links — sufficient for artifact `.md` previews.
- "Unread" highlight on inbox cards: simple — every parsed message is treated as unread (matches spec "chưa archive"). Could refine later by diffing against `outbox/`.
- Restart on model change: dropdown calls `updateAgentModel` first (so config persists), then prompts `confirm("Restart agent X with new model?")`. If declined, the new model takes effect on the next manual restart.
- Path traversal already guarded in `read-artifact-file` (resolves both paths and checks prefix).
