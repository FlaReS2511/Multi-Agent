# FE Review T-079 — Aggregate FE Review (T-071 – T-075)

**Date:** 2026-05-13 22:40
**Verdict:** changes-requested

## Files reviewed
- src/App.tsx
- src/store/auth.ts, cart.ts, wishlist.ts
- src/api/client.ts
- src/hooks/useDebounce.ts
- src/context/ToastContext.tsx
- src/components/Layout.tsx
- src/components/ProtectedRoute.tsx, AdminRoute.tsx
- src/components/ui/ErrorBoundary.tsx
- src/components/catalog/FilterSidebar.tsx, ProductCard.tsx, SearchBox.tsx, Pagination.tsx
- src/components/admin/AdminLayout.tsx, DataTable.tsx, ImageUploader.tsx, MetricCard.tsx
- src/components/cart/CartItemRow.tsx, CouponChip.tsx, CouponInput.tsx, TotalsBreakdown.tsx
- src/pages/LoginPage.tsx, RegisterPage.tsx, AccountPage.tsx, NotFoundPage.tsx
- src/pages/HomePage.tsx, ListPage.tsx, DetailPage.tsx, CategoryPage.tsx
- src/pages/CartPage.tsx, CheckoutPage.tsx, PaymentMockPage.tsx, OrderSuccessPage.tsx
- src/pages/OrderHistoryPage.tsx, OrderDetailPage.tsx, WishlistPage.tsx
- src/pages/admin/AdminDashboardPage.tsx, ProductsAdminPage.tsx, ProductFormPage.tsx
- src/pages/admin/OrdersAdminPage.tsx, OrderAdminDetailPage.tsx, InventoryAdminPage.tsx
- src/pages/admin/CategoriesAdminPage.tsx, BrandsAdminPage.tsx, CouponsAdminPage.tsx

---

## Findings

### Type safety (tsc result)
- **tsc --noEmit: CLEAN** — `npm run build` (which runs `tsc -b`) passes with zero errors.
- `src/pages/admin/ProductsAdminPage.tsx:58-60` — `rows={products as unknown as Record<string, unknown>[]}` and `row as unknown as Product` are double `as unknown` escape-hatch casts. This indicates DataTable's generic parameter is typed as `Record<string, unknown>` rather than a proper generic `<T>`. The casts are safe here but mask future type errors when columns change.
- `src/pages/CheckoutPage.tsx:3-5` — Three separate named imports from `../api/cart` on three lines. Minor style; should be one import statement.
- No `any` types found.

### React patterns
- `src/pages/ListPage.tsx:75-76` — `eslint-disable-next-line react-hooks/exhaustive-deps` suppresses the exhaustive-deps rule on `[params.toString()]`. This is a deliberate optimization (subscribing to serialised URL state rather than individual params) and is functionally correct. The disable comment should include a brief explanation of why — without it, future readers may remove it thinking it's a mistake.
- `src/pages/admin/ProductsAdminPage.tsx:14,20` — `const load = () => { ... }` defined inside the component, then used as `useEffect(load, [])`. `load` captures `addToast` from closure. Because `addToast` is stable (memoized via `useCallback` in `ToastContext`), this is safe in practice but the pattern looks fragile; `load` should either be moved outside the component or wrapped in `useCallback`.

### Async & state
- **Missing `.catch()` on initial data fetches (ProductFormPage)**:
  - `src/pages/admin/ProductFormPage.tsx:38-43` — `Promise.all([listCategories(), listBrands()]).then(...)` has no `.catch()`. If the request fails, `categories` and `brands` silently stay empty; the user sees no error.
  - `src/pages/admin/ProductFormPage.tsx:44-49` — `getProduct(Number(id)).then(...)` has no `.catch()`. If the product fetch fails (invalid ID, network error), `loading` stays `true` forever and the page is permanently blank.
- `src/pages/CheckoutPage.tsx:useEffect` — `Promise.all([getCart(), getTotals()])` has no `.catch()`. A network failure silently leaves `cart` and `totals` null with no error message.
- No AbortController cleanup on `useEffect` fetches in `ListPage.tsx` and `DetailPage.tsx`. React 18 suppresses the unmount setState warning, but requests continue running after navigation. Not blocking but should be noted.

### Accessibility
- **Price filter inputs missing labels** (FilterSidebar.tsx): The Min/Max price `<input type="number">` fields use only `placeholder="Min"` / `placeholder="Max"`. `placeholder` is not a label substitute; screen readers and form assistants will announce these as unlabeled. Each needs either a wrapping `<label>` or `aria-label`.
- **Mobile filter drawer close button** (`ListPage.tsx:119`) — the close button reads `✕ Close` with no `aria-label`. The `✕` character may be announced as "multiplication sign" by some screen readers. Recommend `aria-label="Close filters"`.
- Everything else checks out: hamburger button has `aria-label` + `aria-expanded`, ImageUploader drop zone has `role="button"` + `tabIndex={0}` + `aria-label` + `onKeyDown`, progress bar has correct ARIA attributes, all form inputs have associated `<label>`, Toast container has `aria-live="polite"`.

### Security
- No `dangerouslySetInnerHTML` usage anywhere in the codebase.
- No API keys or secrets in the bundle; API base URL is via `VITE_API_URL` env var.
- `api/client.ts` — Axios interceptor reads token from `localStorage` per request. Token is also persisted via Zustand `persist` middleware. Acceptable for this project scope (noted per task instructions).
- `DetailPage.tsx:96` — external placeholder image URL uses `encodeURIComponent(product.name)` — correctly sanitised.
- No external links requiring `rel="noreferrer noopener"` were found in reviewed files.

### Build & bundle
- `npm run build`: **PASSES** — `tsc -b && vite build` completes successfully.
- **⚠️ Bundle size warning**: single chunk is `995.97 kB` minified (`286 kB` gzipped), exceeding Vite's 500 kB threshold. `recharts` (~300 kB) and the admin pages are the primary contributors. All admin routes are loaded eagerly. No `React.lazy` / `dynamic import()` is used anywhere.
  - Fix: lazy-load admin routes and recharts via `React.lazy` + `Suspense`. This is straightforward — `App.tsx` admin route block maps cleanly to a dynamic boundary.
- CSS bundle: `22.46 kB` gzip — within acceptable range.

### Vitest
- **18/18 tests PASSED** — all test files in `src/test/` pass.

---

## Action items (changes-requested)

### P1 — Must fix before merge

1. **`src/pages/admin/ProductFormPage.tsx:38-49`** — Add `.catch()` to both `Promise.all([listCategories(), listBrands()])` and `getProduct(Number(id))`. The product fetch must handle failure: set an error state and render an error message (or redirect to 404), not loop forever in loading state.

   ```tsx
   getProduct(Number(id))
     .then((p) => { /* ... */ })
     .catch(() => { /* setError('Product not found'); setLoading(false) */ })
   ```

2. **`src/components/catalog/FilterSidebar.tsx` — Min/Max price inputs** — Replace `placeholder`-only labels with proper `<label>` elements or `aria-label` attributes.

   ```tsx
   <input
     type="number"
     aria-label="Minimum price"
     placeholder="Min"
     ...
   />
   ```

### P2 — Should fix

3. **`src/pages/CheckoutPage.tsx:useEffect`** — Add `.catch()` to `Promise.all([getCart(), getTotals()])` and surface an error state so the user knows if the cart summary failed to load.

4. **`src/pages/admin/ProductsAdminPage.tsx:14`** — Wrap `load` in `useCallback` or move it to module scope, and add it to the `useEffect` dependency array. Current pattern relies on implicit closure stability that is easy to break.

   ```tsx
   const load = useCallback(() => {
     listProducts({ page_size: '200' })
       .then((p) => setProducts(p.items))
       .finally(() => setLoading(false))
   }, [])

   useEffect(() => { load() }, [load])
   ```

5. **Bundle size** — Code-split admin routes and recharts. Suggested change in `App.tsx`:

   ```tsx
   const AdminDashboardPage = React.lazy(() => import('./pages/admin/AdminDashboardPage'))
   // ... (all admin pages)
   ```

   Wrap admin `<Route>` block in `<Suspense fallback={<LoadingSpinner />}>`.

### P3 — Nice to have

6. **`src/pages/ListPage.tsx:75`** — Add an explanatory comment next to the `eslint-disable` line:
   ```tsx
   // Intentional: depend on serialised URL string so the effect runs once per navigation, not on individual param references
   // eslint-disable-next-line react-hooks/exhaustive-deps
   ```

7. **`src/pages/admin/ProductsAdminPage.tsx:58`** — Improve DataTable generics so `rows` can accept `T[]` directly without the `as unknown as` escape hatch.

8. **`src/pages/CheckoutPage.tsx:3-5`** — Merge three `import ... from '../api/cart'` lines into one.

9. **`ListPage.tsx:119`** — Add `aria-label="Close filters"` to the mobile drawer close button.

---

## Known gaps (per spec — not counted as findings)
- `CouponsAdminPage` shows "endpoint pending" — awaiting BE T-082.
- `InventoryAdminPage` has no movement history — awaiting BE T-083.
