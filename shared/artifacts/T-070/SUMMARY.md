# T-070 — Alembic Migrations + Seed + Smoke E2E

## Files Added / Modified

```
web-ban-hang/backend/
├── alembic.ini                            (configured: SQLite default, Postgres via DATABASE_URL env)
├── alembic/
│   ├── env.py                             (async engine, reads DATABASE_URL env or alembic.ini URL)
│   └── versions/
│       └── 0001_initial_schema.py         (manual migration: all 14 tables)
├── scripts/
│   ├── __init__.py
│   └── seed.py                            (idempotent: 1 admin, 3 customers, 4 cats, 3 brands,
│                                           15 products, 3 coupons, 2 sample orders)
├── tests/
│   └── test_e2e_smoke.py                  (full happy-path: register→login→product→cart→coupon
│                                           →checkout→pay→assert paid+stock+notification)
├── requirements.txt                       (added alembic==1.13.1, jinja2==3.1.4)
└── README.md                              (install, migrate, seed, run, test)
```

## Alembic Setup

- `alembic upgrade head` uses `sqlite+aiosqlite:///ecommerce_dev.db` by default
- For Postgres: `export DATABASE_URL=postgresql+asyncpg://...` then `alembic upgrade head`
- env.py uses `asyncio.run()` + `async_engine_from_config` — works with both aiosqlite and asyncpg
- `render_as_batch=True` in context.configure for SQLite ALTER TABLE compatibility

## Seed

Run: `python -m scripts.seed`

- Checks `admin@shop.local` existence → skips if already seeded
- Creates tables via `Base.metadata.create_all` (safe for fresh DBs without Alembic)

## Smoke E2E (test_e2e_smoke.py)

Steps verified:
1. Register new user
2. Login → get JWT
3. Create product (admin role)
4. Create coupon (direct DB)
5. List products (search filter)
6. Add to cart (qty=2)
7. Apply coupon (SMOKE10 10%)
8. Check totals (600k subtotal, 60k discount, free shipping >= 500k)
9. Checkout → order_id + payment_url
10. Cart cleared post-checkout
11. Pay (mock confirm)
12. Assert order.status == paid
13. Assert Product.stock == 8 (10 - 2)
14. Assert NotificationLog with template=order_confirm exists and sent=True

## Test Results

`pytest tests/` → 41/41 passed
