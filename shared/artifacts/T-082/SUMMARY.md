# T-082 — Admin Coupon CRUD Endpoints

## Files Added / Modified

```
web-ban-hang/backend/
├── app/schemas/coupon.py                    (new) — CouponOut, CouponCreate, CouponUpdate
├── app/api/v1/admin_coupons.py              (new) — 4 admin endpoints
├── app/api/v1/router.py                     (modified) — registered admin_coupons_router
└── tests/test_admin_coupons.py             (new) — 6 tests
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/coupons` | List coupons, filter=active\|expired\|all |
| POST | `/api/v1/admin/coupons` | Create coupon (409 on duplicate code) |
| PATCH | `/api/v1/admin/coupons/{code}` | Partial update |
| DELETE | `/api/v1/admin/coupons/{code}` | Delete if used_count=0; else 409 |

All endpoints guarded by `require_role(Role.admin)`.

## Tests

- `test_create_and_list_coupon` — create + verify in list
- `test_duplicate_coupon_returns_409` — duplicate code rejected
- `test_update_coupon` — PATCH value field
- `test_delete_unused_coupon` — 204 on unused
- `test_delete_used_coupon_returns_409` — conflict when used_count > 0
- `test_filter_active_vs_expired` — active/expired filter logic

## Results

pytest: 6/6 passed (50/50 total suite)
