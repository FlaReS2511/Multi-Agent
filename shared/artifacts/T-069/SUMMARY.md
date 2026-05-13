# T-069 — Reviews, Wishlist, Inventory, Notifier, Analytics

## Files Added / Modified

```
web-ban-hang/backend/
├── app/
│   ├── models/
│   │   ├── reviews.py         Review, Wishlist, StockMovement, NotificationLog (+ enums)
│   │   └── __init__.py        (updated)
│   ├── schemas/
│   │   └── reviews.py         ReviewCreate/Out, WishlistItemOut, RestockRequest, AnalyticsSummary, TopProduct
│   ├── core/
│   │   └── notifier.py        notify() — renders template, writes NotificationLog (mock, no real transport)
│   └── api/v1/
│       ├── reviews.py         GET/POST /products/{id}/reviews, DELETE /reviews/{id}
│       ├── wishlist.py        GET/POST/DELETE /wishlist/{product_id}
│       ├── inventory.py       POST /admin/inventory/restock
│       ├── analytics.py       GET /admin/analytics/summary
│       ├── checkout.py        (updated: notify order_confirm + low_stock_alert on payment)
│       ├── orders.py          (updated: notify shipping_update on status→shipped)
│       └── router.py          (updated)
├── tests/
│   └── test_reviews.py        6 tests
```

## New Endpoints (8)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/v1/products/{id}/reviews | No | List reviews for product |
| POST | /api/v1/products/{id}/reviews | Customer | Create review (verified purchase only) |
| DELETE | /api/v1/reviews/{id} | Author or Admin | Delete review |
| GET | /api/v1/wishlist | Customer | List own wishlist |
| POST | /api/v1/wishlist/{product_id} | Customer | Add to wishlist |
| DELETE | /api/v1/wishlist/{product_id} | Customer | Remove from wishlist |
| POST | /api/v1/admin/inventory/restock | Admin | Restock → StockMovement + update stock |
| GET | /api/v1/admin/analytics/summary | Admin | 30-day revenue, orders, top products, low stock |

## Verified Purchase Gate

`POST /products/{id}/reviews` checks that the requesting user has an Order in status `paid|shipped|delivered` containing an `OrderItem` with that product_id. Returns 403 otherwise.

## Notifier Wiring

| Event | Template | Channel |
|-------|----------|---------|
| `payments/mock/confirm` → paid | `order_confirm` | email |
| `admin/orders/{id}/status` → shipped | `shipping_update` | email |
| Product.stock < 5 (after payment/restock) | `low_stock_alert` | admin_internal |

All logged to `NotificationLog` table with `sent=True` (render succeeded) or `sent=False`.

## Analytics (30-day window)

- Revenue: `SUM(Order.total_cents)` where status in [paid, shipped, delivered] and created_at ≥ now−30d
- Top products: aggregated from `OrderItem` in same window, sorted by units DESC, top 10
- Low stock count: `Product.stock < 5 AND is_active=True`

## Design Notes

- `LOW_STOCK_THRESHOLD = 5` defined in `app/models/reviews.py` and imported by `notifier.py` and `inventory.py`
- `StockMovement` records every delta: `order_paid` (payment confirm), `admin_restock` (restock endpoint)
- Notifier does `render_template()` to validate context before writing log; sets `sent=False` on render failure
