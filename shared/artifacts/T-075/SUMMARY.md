# T-075 — FE Admin Panel (Products CRUD + Image Uploader + Orders + Coupons + Analytics)

## New Files

```
src/
├── types/admin.ts                         # AnalyticsSummary, TopProduct, DailyRevenue, Coupon, StockMovement
├── api/admin.ts                           # getAnalyticsSummary, adminCreate/Update/Delete Product/Category/Brand,
│                                          #   uploadImage, adminListCoupons/Create/Update/Delete Coupon,
│                                          #   adminListOrders/GetOrder/UpdateOrderStatus, adminRestock
├── components/admin/
│   ├── MetricCard.tsx                     # colored KPI card (indigo/green/yellow/red)
│   ├── DataTable.tsx                      # sortable + paginated + searchable generic table
│   ├── ImageUploader.tsx                  # drag-drop + mime/size validation + progress bar + preview + remove
│   └── AdminLayout.tsx                    # dark sidebar nav (Dashboard/Products/Categories/Brands/Coupons/Orders/Inventory)
├── pages/admin/
│   ├── AdminDashboardPage.tsx            # /admin — MetricCards + recharts LineChart (daily revenue) + BarChart (top products)
│   ├── ProductsAdminPage.tsx             # /admin/products — DataTable + delete + link to edit/new
│   ├── ProductFormPage.tsx               # /admin/products/new + /admin/products/:id/edit — form with ImageUploader
│   ├── CategoriesAdminPage.tsx           # /admin/categories — inline create form + tree table + delete
│   ├── BrandsAdminPage.tsx               # /admin/brands — inline create form + table + delete
│   ├── CouponsAdminPage.tsx              # /admin/coupons — create form + table + delete (with endpoint-pending fallback)
│   ├── OrdersAdminPage.tsx               # /admin/orders — DataTable + status filter dropdown
│   ├── OrderAdminDetailPage.tsx          # /admin/orders/:id — timeline + items + address + status transition buttons
│   └── InventoryAdminPage.tsx            # /admin/inventory — restock form + products stock table + movement history note
├── App.tsx                                # (updated) all 10 admin routes behind AdminRoute > AdminLayout
└── test/
    ├── DataTable.test.tsx                # renders rows, sorts asc, toggles desc
    └── ImageUploader.test.tsx           # drop zone present, preview shown, remove button present
```

## Admin Routes (all behind AdminRoute → AdminLayout sidebar)

| Path | Page |
|------|------|
| `/admin` | AdminDashboardPage (analytics) |
| `/admin/products` | ProductsAdminPage |
| `/admin/products/new` | ProductFormPage (create) |
| `/admin/products/:id/edit` | ProductFormPage (edit) |
| `/admin/categories` | CategoriesAdminPage |
| `/admin/brands` | BrandsAdminPage |
| `/admin/coupons` | CouponsAdminPage |
| `/admin/orders` | OrdersAdminPage |
| `/admin/orders/:id` | OrderAdminDetailPage |
| `/admin/inventory` | InventoryAdminPage |

## Dependencies Installed

- `recharts@^3.8.1` (LineChart + BarChart for dashboard)

## Known Endpoint Gaps (flagged in UI)

1. **Coupon admin CRUD** (`POST/PATCH/DELETE /api/v1/admin/coupons`) — T-068 only has customer-facing coupon apply/remove. CouponsAdminPage detects 404/405 and shows "endpoint pending" warning with form disabled. Recommend creating a BE task.

2. **Stock movement history** (`GET /api/v1/admin/inventory/movements`) — T-069 only has POST restock. InventoryAdminPage shows "endpoint pending" notice where history table would go.

## DoD Status

- [x] 8+ admin pages (10 routes) operational
- [x] Image uploader: drag-drop, mime validation (JPEG/PNG/WebP), size validation (5MB), progress bar, preview, remove
- [x] Analytics dashboard: recharts LineChart (daily revenue) + BarChart (top products), MetricCards
- [x] `npm run build` passes — no TS errors
- [x] `npm test` 18/18 pass (9 test files)
- [x] SUMMARY.md at shared/artifacts/T-075/
