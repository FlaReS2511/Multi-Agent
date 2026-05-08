# Review T-025 — Electron dashboard upgrade (T-024)

**Reviewer:** reviewer-agent
**Date:** 2026-05-05 00:31
**Verdict:** changes-requested

## Files reviewed

NEW:
- project/frontend/src/components/TaskFilterTabs.tsx
- project/frontend/src/components/TaskDetailPanel.tsx
- project/frontend/src/components/InboxMessageCard.tsx
- project/frontend/src/components/ArtifactViewer.tsx
- project/frontend/src/components/LogSearchBar.tsx
- project/frontend/src/components/RestartAgentButton.tsx

UPDATED:
- project/frontend/src/components/TasksPanel.tsx
- project/frontend/src/components/InboxPanel.tsx
- project/frontend/src/components/LogsPanel.tsx
- project/frontend/src/components/TerminalsView.tsx
- project/frontend/src/App.tsx
- project/frontend/src/lib/api.ts
- project/frontend/electron/preload.ts
- project/frontend/electron/main.ts

## Build / Definition of Done

| Item | Status | Notes |
|------|--------|-------|
| `npm run build` (tsc -b + vite build) | ✅ | 0 TS errors, 45 modules transformed |
| Bundle size | ✅ | 521.52 KB JS / 37.67 KB CSS (matches FE claim) |
| No new deps added | ✅ | dependencies unchanged (xterm only) |
| TaskFilterTabs counts/click | ✅ | TaskFilterTabs.tsx:21-29 + TasksPanel.tsx:13-19 |
| TaskDetailPanel priority/deps/Open Artifacts → | ✅ | TaskDetailPanel.tsx:79-159 wires `onOpenArtifact(task.id)` |
| InboxPanel cards via `parseInbox()` | ✅ | InboxMessageCard.tsx:18-63 splits on `^---$` |
| Raw/Cards toggle (global) + per-card raw toggle | ✅ | InboxPanel.tsx:43-47 + InboxMessageCard.tsx:122-128 |
| ArtifactViewer 3-pane + md/code preview | ✅ | ArtifactViewer.tsx |
| LogsPanel search + agent chips + JSON/CSV export | ✅ | LogsPanel.tsx + LogSearchBar.tsx |
| TerminalsView restart button + confirm-restart on model change | ✅ | TerminalsView.tsx:32-40 |
| preload.ts exposes new methods, contextIsolation | ✅ | preload.ts (contextIsolation:true, nodeIntegration:false in main.ts:30-31) |
| main.ts update-task / create-task persist `priority` | ✅ | main.ts:125 (create), 422 (update) |
| read-artifact-file path traversal guard | ⚠️ | Resolved-prefix check works for `..` and absolute, but does NOT resolve symlinks (see Sec-2) |

## Findings

### 🔴 Blocker

**Sec-1 — XSS in markdown renderer's link handling** — `ArtifactViewer.tsx:213-227`

`escapeHtml()` only escapes `&`, `<`, `>`. It does NOT escape `"`. Then `renderInline()` substitutes the captured URL into an `href="$2"` attribute:

```ts
out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
  '<a href="$2" class="text-blue-400 underline">$1</a>')
```

Two concrete exploits an attacker (or compromised agent) can drop into any `shared/artifacts/T-XXX/*.md` file:

1. `[click](javascript:alert(1))` → renders to `<a href="javascript:alert(1)" …>click</a>`. Click fires arbitrary JS.
2. `[x]("onclick="alert(1) http://x)` → URL contains a `"` which breaks out of the attribute, producing `<a href="" onclick="alert(1) http://x" …>` — XSS without user click in some browser parsers, definitely on hover/click.

Because the renderer mounts via `dangerouslySetInnerHTML` (line 208) in an Electron renderer that has `window.api` exposed via contextBridge, an XSS can call `ptyWrite`, `sendMessage`, `updateTask`, `ptyRestart` etc. Any agent that writes to `shared/artifacts/` (which all of them do by design) becomes a vector for full dashboard takeover.

**Fix:**
- Escape `"` (and ideally `'`) in `escapeHtml` (add `.replace(/"/g, '&quot;').replace(/'/g, '&#39;')`).
- Reject/strip `javascript:`, `data:`, `vbscript:` schemes in URL — allow only `http(s):`, `mailto:`, `#anchor`, relative paths. If invalid, render as plain text.

Suggested patch in `renderInline`:

```ts
const safeUrl = (u: string) => {
  const trimmed = u.trim()
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed
  return '#'   // or empty; never javascript:/data:/vbscript:
}
out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
  (_m, label, url) =>
    `<a href="${escapeHtml(safeUrl(url)).replace(/"/g, '&quot;')}" class="text-blue-400 underline">${label}</a>`)
```

(`label` is already escaped because the whole `out` was escaped before this replace, so leaving it as `$1` / capture is fine.)

### 🟡 Major

**Sec-2 — Path traversal guard does not handle symlinks** — `electron/main.ts:400-410`

```ts
const filePath = path.resolve(path.join(SHARED, 'artifacts', taskId, filename))
if (!filePath.startsWith(artifactsDir + path.sep)) return { ok: false, content: '' }
```

`path.resolve` collapses `..` (correctly defeats `taskId='..'` and `filename='../../x'`) but does NOT follow symlinks. An agent that drops `shared/artifacts/T-XXX/secret -> /etc/passwd` would cause this handler to read the symlink target. The threat model is admittedly low (agents already have FS write), but as a defense-in-depth fix:

```ts
const real = await fs.realpath(filePath).catch(() => null)
if (!real || !real.startsWith(artifactsDir + path.sep)) return { ok: false, content: '' }
const content = await fs.readFile(real, 'utf-8')
```

**Sec-3 — Markdown renderer order-of-operations bug for code-block lang label** — `ArtifactViewer.tsx:247-254`

```ts
out.push(`<pre …><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
if (codeLang) {
  out[out.length - 1] = `<div …>${codeLang}</div>` + out[out.length - 1]
}
```

Two issues:
1. `codeLang` is captured by `\w*` (regex line 264), so values are safe alnum; but even so, putting a `<div>` before the `<pre>` (rather than inside or alongside) yields a fragmented DOM where the lang label visually appears just after the previous block. Cosmetic but inconsistent.
2. Bigger: a `<div>` rendered inside a `<pre>` (CodePreview component, lines 192-201) is invalid nesting — React will warn in dev and HTML5 disallows it. Move the lang label out of the `<pre>`:
   ```tsx
   <div className="flex flex-col">
     {lang && <div className="…">{lang}</div>}
     <pre className="…"><code>{content}</code></pre>
   </div>
   ```

### 🟢 Minor / nit

**Min-1 — `parseInbox` separator counting also fires on markdown horizontal rules in message bodies** — `InboxMessageCard.tsx:20`

`content.split(/^---\s*$/m)` will split a body that legitimately contains a `---` line (e.g., a markdown HR or YAML frontmatter inside the message body) into two parsed messages. Inbox summary count in `main.ts:62` has the same issue. Low risk because our message protocol forbids body content containing `---`, but worth flagging — could lead to ghost message cards.

**Min-2 — Unread badge is always `unread={true}`** — `InboxPanel.tsx:113`

Every parsed card renders the amber dot + ring. FE notes acknowledge this. Per spec "chưa archive = unread" the visual conveys nothing because all messages currently in inbox are by definition not archived; the badge becomes pure decoration. Recommend dropping the prop or computing it against `outbox/<receiver>-*.md` to mark previously-seen messages.

**Min-3 — Confirm-then-restart leaves config and PTY out of sync if user declines** — `TerminalsView.tsx:32-40`

```ts
await window.api.updateAgentModel(active, provider, model)   // persisted
onConfigChange?.()
if (confirm(`Restart agent ${active} with new model "${model}"?`)) {
  await window.api.ptyRestart(active)
}
```

If user picks a new model and clicks Cancel, agents-config.json now says "claude-haiku-4-5" but the running PTY is still on the old model. FE's note acknowledges "takes effect on next manual restart" — fine as a design choice, but the model dropdown will visually show the new model while the actual session uses the old one, which is confusing.

Two acceptable fixes:
- Reverse the order: prompt FIRST, only persist + restart if user confirms; rollback dropdown if cancelled.
- Or surface a "model pending restart" badge so the discrepancy is visible.

**Min-4 — `ArtifactViewer` Files panel is single-level** — `ArtifactViewer.tsx:124-143`

Subdirectories show with the 📁 icon and `disabled={n.isDir}`. They cannot be expanded. Spec says "browse tree" — current impl is one level only. T-024 artifacts are flat, so no immediate impact, but a task with nested folders (e.g. `web-shop/backend/...`) would be unbrowsable. Consider recursive `listArtifactTree` (returning a real tree) or a click-to-cd-into-dir pattern.

**Min-5 — `read-artifact-file` accepts only `taskId + filename`, not nested paths** — `electron/main.ts:400`

Tied to Min-4. Even if the UI gained nested browsing, the IPC signature can't address `subdir/file.md`. Will need to take a relative path (and the path-traversal guard already supports it correctly via `path.resolve`).

**Min-6 — `LogsPanel.highlight` only highlights first match per line** — `LogsPanel.tsx:137-149`

If a log line contains `wrote` twice and the user searches `wrote`, only the first occurrence gets the `<mark>`. Cosmetic.

**Min-7 — `triggerDownload` may revoke ObjectURL too early on slow disks** — `LogsPanel.tsx:163-172`

`setTimeout(..., 1000)` is usually enough but is a race. Consider `revokeObjectURL` after the click event has settled (`a.addEventListener('click', () => …)`) or just leave it (memory cost is trivial for short-lived window).

**Min-8 — Header regex requires single-space `FROM:`** — `InboxMessageCard.tsx:16`

`HEADER_RE` expects `FROM: x | TO: y | TASK: z`. If a message inserts double spaces (`FROM:  x`), `[^|]+?` still matches, but the trim picks up trailing space. Currently fine because all generators use single-space. Consider tightening with `\s+` if needed.

**Min-9 — `InboxPanel` cards always default-expand the first card** — `InboxPanel.tsx:114`

`defaultExpanded={i === 0}` is reasonable but means switching agents loses state. Acceptable.

**Min-10 — `priority` field rendered fine for old tasks (no priority)** — verified ✅
TasksPanel.tsx:47 uses `t.priority ? PRIORITY_STYLES[t.priority] : null`; TaskDetailPanel.tsx:13 uses `task.priority ?? 'medium'`. No crash. Pre-existing tasks (T-001..T-023) lack `priority` and render correctly.

**Min-11 — `TasksPanel` sets `selectedId=null` on row re-click but onClose also clears it** — minor redundancy, harmless.

### Tests

- `npm run build` (tsc -b + vite build): ✅ 0 errors. Bundle 521.52 KB JS, 37.67 KB CSS — matches FE claim.
- `npm test`: not run — no vitest suite present in this Electron app project (only the `web-shop` frontend has vitest). Manual verification by Reviewer not possible without launching Electron in a GUI session.
- No automated regression coverage for: `parseInbox` (parsing/edge cases), `renderMarkdown` (XSS regression, formatting), path traversal guard. **Strongly recommend adding** at minimum a vitest unit for the markdown sanitizer once Sec-1 is fixed, and one for `parseInbox` to lock in current behavior.

### Spec compliance summary

All 11 Definition-of-Done bullets from the orchestrator brief are visually/structurally implemented; only path-traversal needs hardening (Sec-2). The FE notes in `files.md` honestly disclose every gap (Min-2/Min-3/Min-4) — none are blockers, but Sec-1 is a blocker because the renderer mounts arbitrary md from disk into the privileged Electron renderer context.

### Style / Maintainability

- TypeScript is strict, no `any` introduced. Good.
- `parseInbox` is exported, testable. Good.
- Inline markdown renderer (~85 LoC) is small and dependency-free as planned. Good — once XSS is fixed.
- Some duplication between `InboxPanel` raw view and per-card raw toggle, fine.
- `flushList()` only handles `<ul>`; if/when ordered lists are added, will need refactor.

## Action items (for changes-requested)

1. **(Blocker, Sec-1)** Sanitize markdown links in `ArtifactViewer.tsx`:
   - Escape `"` in `escapeHtml`.
   - Validate URL scheme, reject `javascript:` / `data:` / `vbscript:`.
   - Add a vitest unit (e.g. `ArtifactViewer.test.ts`) that asserts `[x](javascript:alert(1))` does not produce an `href` starting with `javascript:`.
2. **(Major, Sec-2)** In `electron/main.ts:400` `read-artifact-file` handler, replace the prefix-check with a `fs.realpath(filePath)` check (or fall through to `lstat` rejection of symlinks).
3. **(Major, Sec-3)** Move the codeblock lang label out of `<pre>` in `MarkdownPreview` / `CodePreview` to fix invalid HTML nesting.
4. **(Minor, Min-3)** In `TerminalsView.onModelChange`, prompt to restart **before** persisting, or visibly mark model as "pending restart" until PTY actually restarts.
5. **(Nit, Min-2)** Either drop the `unread` prop from `InboxMessageCard` until you have a real read/unread signal, or compute it from outbox/<receiver>-*.md.
6. **(Nice-to-have, Min-4/Min-5)** Make `ArtifactViewer` tree recursive + extend `read-artifact-file` IPC to take a relative path.

Once 1-3 are addressed, ready to re-review.
