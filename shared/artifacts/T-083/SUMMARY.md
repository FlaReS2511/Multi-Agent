# T-083 — Stock Movements Admin Endpoint

## Files Added / Modified

```
web-ban-hang/backend/
├── app/api/v1/inventory.py         (modified) — added StockMovementOut schema + GET /movements
└── tests/test_stock_movements.py   (new) — 3 tests
```

## Endpoint

`GET /api/v1/admin/inventory/movements`

Query params:
- `product_id` (int, optional) — filter by product
- `reason` (order_paid|admin_restock|admin_adjust, optional)
- `from` (datetime, optional) — created_at >= from
- `to` (datetime, optional) — created_at <= to
- `page` (int, default 1)
- `page_size` (int, default 50, max 200)

Response item:
```json
{
  "id": 1,
  "product_id": 42,
  "product_name": "Product Name",
  "delta": -2,
  "reason": "order_paid",
  "ref_id": 101,
  "created_at": "2026-05-13T15:00:00Z"
}
```

JOINs `products` table to include `product_name`. Sorted newest first. Guarded by `require_role(Role.admin)`.

## Tests

- `test_list_movements_empty` — returns empty list with 200
- `test_list_movements_filter_by_product` — product_id filter + product_name in response
- `test_list_movements_filter_by_reason` — reason filter returns only matching rows

## Results

pytest: 3/3 passed (50/50 total suite)
