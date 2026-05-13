# T-084 — FE Review Fixes (P1 + P2 + P3)

## Fix mapping

### P1 — Must fix

| Issue | File | Fix |
|-------|------|-----|
| 1 | `src/pages/admin/ProductFormPage.tsx` | Extracted `loadData()` function; wrapped both `Promise.all([listCategories, listBrands])` and `getProduct(id)` in `.catch()`. Added `loadError` state. On error: renders error message + **Retry** button that re-calls `loadData()`. `loading` always resolves to `false` via `.finally()`. |
| 2 | `src/components/catalog/FilterSidebar.tsx` | Added `aria-label="Min price"` and `aria-label="Max price"` to the two price `<input type="number">` fields. |

### P2 — Should fix

| Issue | File | Fix |
|-------|------|-----|
| 3 | `src/pages/CheckoutPage.tsx` | Added `.catch(() => addToast('Failed to load cart summary. Please refresh.', 'error'))` to `Promise.all([getCart(), getTotals()])`. Also imported `useToast`. Also merged the three separate `import ... from '../api/cart'` lines into one. |
| 4 | `src/pages/admin/ProductsAdminPage.tsx` | Wrapped `load` in `useCallback(…, [])`. Changed `useEffect(load, [])` → `useEffect(() => { load() }, [load])`. |
| 5 | `src/App.tsx` + `src/pages/DetailPage.tsx` | Converted all 10 admin page imports and `DetailPage` import to `React.lazy` dynamic imports. Added `<Suspense fallback={<PageSpinner />}>` wrapper on each lazy route element. Result: recharts (387 kB) now isolated in `AdminDashboardPage` chunk; main chunk **453 kB** (was 995 kB). |

### P3 — Nice to have (both done)

| Issue | File | Fix |
|-------|------|-----|
| 6 | `src/pages/ListPage.tsx` | Added two-line explanatory comment above `eslint-disable-next-line react-hooks/exhaustive-deps` explaining the intentional URL-string dependency. |
| 7 | `src/pages/admin/ProductsAdminPage.tsx` | Changed `rows={products as unknown as Record<string, unknown>[]}` → `rows={products as Array<Product & Record<string, unknown>>}`. Used `<DataTable<Product & Record<string, unknown>>` explicit generic. Removed all `as number` casts in `render` callbacks. Removed `const p = row as unknown as Product` in `actions`. |

## Bundle size

| Chunk | Before | After |
|-------|--------|-------|
| `index-*.js` (main) | 995.97 kB | **453.96 kB** ✅ |
| `AdminDashboardPage-*.js` | (bundled in main) | 387.78 kB (lazy, loads only for admin) |

## DoD

- [x] All P1 fixes applied
- [x] All P2 fixes applied
- [x] P3 fixes applied (both #6 and #7)
- [x] `npm run build` passes — no TS errors
- [x] Main chunk 453 kB < 500 kB threshold
- [x] `npm test` 18/18 pass (9 test files)
