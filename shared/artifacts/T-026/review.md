# Review T-026 — Re-review T-024 Electron dashboard (post security fixes)

**Reviewer:** reviewer-agent
**Date:** 2026-05-05 00:45
**Verdict:** approved

## Files reviewed

- project/frontend/src/components/ArtifactViewer.tsx
- project/frontend/electron/main.ts (lines 400-412)

---

## Findings

### Sec-1 — XSS in markdown renderer's link handling ✅ FIXED

**`escapeHtml` now escapes `"`** (`ArtifactViewer.tsx:220`):
```ts
.replace(/"/g, '&quot;')
```
This closes the attribute-breakout vector.

**`isSafeUrl()` added** (`ArtifactViewer.tsx:223-232`) with a proper scheme allowlist:
- Relative paths (`#`, `/`, `./`, `../`) allowed directly
- `new URL()` parse used for absolute URLs; only `http:`, `https:`, `mailto:` pass
- `javascript:`, `data:`, `vbscript:` all fail the protocol check → rejected

**`renderInline` link handler** (`ArtifactViewer.tsx:239-243`) correctly:
- Calls `isSafeUrl(url)` on the extracted URL (which is already HTML-entity-encoded from the leading `escapeHtml(s)`, so `"onclick="...` attack becomes `&quot;onclick=&quot;...` — `new URL()` throws → rejected)
- Falls back to `escapeHtml(label)` (plain text) for unsafe URLs
- Wraps safe URLs with `escapeHtml(url)` inside the `href` attribute

Both original exploit vectors confirmed neutralised:
- `[click](javascript:alert(1))` → protocol `javascript:` not in allowlist → renders as plain text `click`
- `[x]("onclick="alert(1) http://x)` → after pre-escaping: `&quot;onclick=...` → `new URL()` throws → plain text `x`

No double-encoding regressions: `"` in regular text content renders correctly as `&quot;` → `"` in browser.

---

### Sec-2 — Path traversal / symlink bypass in `read-artifact-file` ✅ FIXED

**`electron/main.ts:400-412`** now:
1. Pre-checks `filePath` against `artifactsDir` boundary (still guards `..` traversal)
2. Calls `await fs.realpath(filePath)` to fully resolve symlinks
3. Re-validates `realPath` against `artifactsDir + path.sep`
4. Reads from `realPath` (the resolved file), not the original `filePath`
5. Catches `realpath` exceptions (non-existent file/symlink) and returns `{ ok: false }`

`SHARED` is computed as `path.join(path.resolve(__dirname, '..', '..', '..'), 'shared')` — no symlinks in the base path derivation, so `artifactsDir` and `realPath` share the same canonical prefix. The double-check is sound.

---

### Sec-3 — Invalid `<div>` inside `<pre>` HTML nesting ✅ FIXED

**`CodePreview` component** (`ArtifactViewer.tsx:192-203`) restructured:
```tsx
<div>
  {lang && <div className="…">{lang}</div>}   // sibling of <pre>
  <pre …><code>{content}</code></pre>
</div>
```
`<div>` is now a sibling of `<pre>`, not a child. Valid HTML5. ✅

**`renderMarkdown` code-block output** (`ArtifactViewer.tsx:264-274`):
The lang label `<div>` is prepended as a separate string before the `<pre>` element in `out[]`, producing correct sibling HTML:
```html
<div class="…">ts</div>
<pre …><code>…</code></pre>
```
`codeLang` is captured by `\w*` (alphanumeric only), so no injection risk here. ✅

---

### Regression check

- No logic changes to non-security code paths
- Build reported passing: `npm run build` — 0 TS errors, Vite OK (~521KB JS / ~37KB CSS)
- `escapeHtml` change (add `"` escaping) is backward-compatible: `&quot;` in text nodes renders identically to `"`
- `isSafeUrl` only intercepts link nodes; all other inline rendering is unchanged

### Outstanding items (deferred, not blockers)

Min-2/Min-3/Min-4/Min-1 were explicitly deferred per original brief. No vitest added (no test runner in this project). These remain nice-to-haves and do not block approval.

Strongly recommend (non-blocking): add a vitest unit for `renderMarkdown`/`renderInline` to lock in XSS-regression coverage, particularly `javascript:` scheme rejection and `"` attribute-breakout.

---

## Action items

None. All three blockers from T-025 have been addressed correctly.
