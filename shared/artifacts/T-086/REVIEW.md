# FE Review T-086 — Re-review T-084 FE fixes (verify T-079 issues closed)

**Date:** 2026-05-13 22:47
**Verdict:** approved

## Build & test
- `npm run build`: **CLEAN** — tsc + vite, zero errors, zero warnings
- `vitest run`: **18/18 PASSED**
- Main bundle: **453.96 kB** minified / 126.64 kB gzip (was 995.97 kB — 54% reduction)

## T-079 checklist — all items verified closed

### P1.1 — ProductFormPage: try/catch + error UI + Retry ✅ CLOSED
`ProductFormPage.tsx:37-116`
- `loadData()` function introduced, called from `useEffect`.
- `Promise.all([listCategories(), listBrands()])` now has `.catch(() => addToast('Failed to load categories/brands.', 'error'))`.
- `getProduct(Number(id))` now has `.catch(() => setLoadError('Product not found or failed to load.'))` and `.finally(() => setLoading(false))` — loading state will always resolve.
- `loadError` state renders a styled error block with a **Retry** button (`onClick={loadData}`) — UX is complete.

### P1.2 — FilterSidebar: aria-label on Min/Max price inputs ✅ CLOSED
`FilterSidebar.tsx:124,133`
- Min price: `aria-label="Min price"` added.
- Max price: `aria-label="Max price"` added.

### P2.3 — CheckoutPage useEffect error handling ✅ CLOSED
`CheckoutPage.tsx:47-52`
- `.catch(() => addToast('Failed to load cart summary. Please refresh.', 'error'))` appended to `Promise.all`.
- `useToast` imported and used.
- Bonus: three separate `import ... from '../api/cart'` lines merged to one (P3.8 item also resolved).

### P2.4 — ProductsAdminPage: useCallback `load` ✅ CLOSED
`ProductsAdminPage.tsx:14-20`
- `load` wrapped in `useCallback(() => { ... }, [])`.
- `useEffect(() => { load() }, [load])` — dependency correctly declared.

### P2.5 — Bundle main chunk < 500 kB ✅ CLOSED
`App.tsx` — all 10 admin pages + `DetailPage` converted to `React.lazy` + per-route `<Suspense fallback={<PageSpinner />}>`.
- Main chunk: **453.96 kB** (< 500 kB threshold) ✅
- `AdminDashboardPage` (recharts): **387.78 kB** isolated lazy chunk ✅
- Each admin page ships as its own 1–11 kB chunk — first load for non-admin users carries zero admin/recharts weight.
- `PageSpinner` component renders a centred indigo spinner during lazy load — no blank flash.

### P3.6 — ListPage eslint-disable comment ✅ CLOSED
`ListPage.tsx:75-77`
```
// Intentional: depend on serialised URL string so the effect re-runs once per navigation,
// not on individual param references which would cause double-fetches on multi-filter updates.
// eslint-disable-next-line react-hooks/exhaustive-deps
```
Clear, accurate explanation for future readers.

### P3.7 — DataTable generics strengthened ✅ CLOSED
`DataTable.tsx:10,20` — component now typed as `DataTable<T extends Record<string, unknown>>`.
`ProductsAdminPage.tsx:47-58` — usage updated to `DataTable<Product & Record<string, unknown>>`, `rows` cast to `Array<Product & Record<string, unknown>>` (single cast, not double `as unknown as`). Column render functions access `r.price`, `r.stock`, `r.id`, `r.name` directly with correct inferred types — no more type escape hatches.

## No new issues found

Reviewed the diff surface introduced by T-084. No regressions or new concerns introduced:
- `ProductFormPage.tsx:65` — `useEffect` has `// eslint-disable-line react-hooks/exhaustive-deps` with `[id, isEdit]` deps. `loadData` captures `addToast` (stable via `useCallback`) — safe.
- `CheckoutPage.tsx:52` — same disable pattern; `navigate` and `addToast` are stable refs — safe.
- `DataTable.tsx:116` — `key={i}` (row index) was pre-existing; acceptable for a read-only admin table where rows are fully re-derived on each filter/sort state change.

## Summary

| Item | Status |
|------|--------|
| P1.1 ProductFormPage error handling + Retry | ✅ closed |
| P1.2 FilterSidebar aria-label | ✅ closed |
| P2.3 CheckoutPage useEffect catch | ✅ closed |
| P2.4 ProductsAdminPage useCallback | ✅ closed |
| P2.5 Bundle < 500 kB | ✅ closed (453 kB) |
| P3.6 ListPage eslint comment | ✅ closed |
| P3.7 DataTable generics | ✅ closed |
| vitest 18/18 | ✅ pass |
| npm run build clean | ✅ pass |
