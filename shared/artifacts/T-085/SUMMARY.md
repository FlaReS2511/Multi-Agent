# T-085 — Fixes from T-078 BE Review

## Files Changed

```
web-ban-hang/
├── .env.example                                    (new) — root-level env template
├── docker-compose.yml                              (modified) — env passthrough for JWT_SECRET + DB password
│
backend/
├── .env                                            (new) — dev/test env with JWT_SECRET
├── app/
│   ├── core/config.py                              (modified) — removed JWT_SECRET default
│   ├── models/orders.py                            (modified) — added coupon_codes: list JSON column
│   ├── schemas/orders.py                           (modified) — shipping_address optional, coupon_codes in OrderOut
│   ├── api/v1/
│   │   ├── checkout.py                             (modified) — all 4 business logic fixes
│   │   └── uploads.py                              (modified) — magic-bytes validation
│   └── alembic/versions/0002_order_coupon_codes.py (new)
└── tests/test_t085_fixes.py                        (new) — 8 tests
```

## Fix Map

| Issue | Severity | Fix |
|-------|----------|-----|
| 1. `Coupon.used_count` never incremented | HIGH | `checkout.py`: snapshot coupon codes onto `Order.coupon_codes`; `mock_payment_confirm` increments `used_count` for each |
| 2. Stock oversell at payment | MEDIUM | `mock_payment_confirm`: `select_for_update()` + guard `stock < qty` → raise 409 Conflict |
| 3. Coupon not re-validated at checkout | MEDIUM | `checkout()`: calls `validate_coupon()` for each applied coupon before creating Order |
| 4. `JWT_SECRET` has insecure default | MEDIUM | `config.py`: removed default, pydantic raises `ValidationError` if env var missing |
| 5. docker-compose hardcoded secrets | MEDIUM | `docker-compose.yml`: `${JWT_SECRET}`, `${POSTGRES_PASSWORD}` etc; added `.env.example` at root |
| 6. Upload trusts client `content_type` | MEDIUM | `uploads.py`: reads magic bytes, detects JPEG/PNG/WebP from file header, ignores declared MIME |

## Model Change: `Order.coupon_codes`

Added `coupon_codes: Mapped[list] = mapped_column(JSON, nullable=False, default=list)` to the `Order` model. Alembic migration `0002_order_coupon_codes.py` handles Postgres; SQLite in-memory tests pick it up via `Base.metadata.create_all`.

## Tests (8 new, covering all 6 fixes)

1. `test_coupon_used_count_increments_after_payment` — `used_count` goes from 0 → 1 after pay
2. `test_oversell_rejected_at_payment` — stock drained to 0 between checkout and pay → 409
3. `test_expired_coupon_rejected_at_checkout` — coupon expired after cart apply → 400 at checkout
4. `test_jwt_secret_no_default` — Settings field has no default value
5. `test_docker_compose_no_hardcoded_jwt_secret` — `changeme-in-production` absent; `${JWT_SECRET}` present
6. `test_upload_rejects_spoofed_content_type` — PNG mime but non-PNG bytes → 415
7. `test_upload_accepts_real_jpeg_magic` — JPEG magic bytes accepted regardless of declared type
8. `test_upload_accepts_real_png_magic` — PNG magic bytes + `octet-stream` declared type → accepted

## Results

pytest: 58/58 passed (was 50/50 before)
