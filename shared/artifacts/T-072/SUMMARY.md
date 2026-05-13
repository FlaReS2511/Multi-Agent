# T-072 — FE Catalog (Home + ListPage + DetailPage + CategoryPage)

## New Files

```
src/
├── types/catalog.ts                      # Product, Category, Brand, ProductPage, ProductFilters
├── api/products.ts                       # listProducts, getProduct, listCategories, listBrands
├── hooks/useDebounce.ts                  # generic debounce hook (default 300ms)
├── components/catalog/
│   ├── ProductCard.tsx                   # image, name, brand, price, stock badge, link to detail
│   ├── FilterSidebar.tsx                 # category radio tree + brand multi-checkbox + price range + in-stock
│   ├── Pagination.tsx                    # page buttons with ellipsis
│   ├── SearchBox.tsx                     # debounced search input
│   ├── Breadcrumbs.tsx                   # nav breadcrumb with aria
│   ├── EmptyState.tsx                    # empty results with reset button
│   └── LoadingSkeleton.tsx               # animated pulse grid (12 or 20 items)
├── pages/
│   ├── HomePage.tsx                      # hero + category tiles + newest products grid
│   ├── ListPage.tsx                      # products grid + sidebar filters + search + sort + pagination
│   ├── DetailPage.tsx                    # product image, specs table, stock badge, Add-to-cart (T-073 placeholder)
│   └── CategoryPage.tsx                  # pre-filters by category slug, wraps ListPage
└── test/
    ├── ProductCard.test.tsx              # renders name+price, out-of-stock badge
    └── FilterURL.test.tsx               # sort changes value, empty state shows
```

## Routes Added

| Path | Page |
|------|------|
| `/` | HomePage (updated) |
| `/products` | ListPage |
| `/products/:id` | DetailPage |
| `/categories/:slug` | CategoryPage |

## API Mapping (T-067 contract)

| Function | Endpoint | Params |
|----------|----------|--------|
| `listProducts` | GET /api/v1/products | category, brand, q, min_price, max_price, in_stock, sort, page, page_size |
| `getProduct` | GET /api/v1/products/:id | — |
| `listCategories` | GET /api/v1/categories | — |
| `listBrands` | GET /api/v1/brands | — |

**⚠️ Param name discrepancy:** T-072 brief used `category_id`/`brand_id` but T-067 implementation uses `category`/`brand`. Using T-067 (actual BE implementation).

**Price encoding:** UI shows USD dollars; API expects/returns cents. `listProducts` multiplies input dollars × 100 before sending.

## DoD Status

- [x] All pages render and navigate correctly
- [x] Filter + search + sort + pagination sync to URL via `useSearchParams`
- [x] Mobile filter drawer (lg:hidden)
- [x] `npm run build` passes — no TS errors
- [x] `npm test` passes — 5 tests across 3 files
- [x] SUMMARY.md at shared/artifacts/T-072/
