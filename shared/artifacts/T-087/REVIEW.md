# BE Review T-087 — Re-review T-085 fixes (closing T-078 issues)

**Date:** 2026-05-13 23:10
**Verdict:** approved

## Files reviewed
- project/backend/app/core/config.py
- project/backend/app/api/v1/checkout.py
- project/backend/app/api/v1/uploads.py
- project/backend/app/models/orders.py
- project/backend/alembic/versions/0002_order_coupon_codes.py
- project/backend/docker-compose.yml (root)
- project/backend/.env.example (root)
- project/backend/tests/test_t085_fixes.py

## Checklist results

### HIGH#1 — `coupon.used_count` increment ✅ FIXED
`checkout.py` now snapshots applied coupon codes into `order.coupon_codes` (new JSON column) before clearing the cart. In `mock_payment_confirm`, after order is marked paid, each code is looked up and `coupon.used_count += 1` is committed atomically with the rest of the payment transaction. `test_coupon_used_count_increments_after_payment` asserts `coupon.used_count == 1` post-payment — passes.

### MED#2 — `select_for_update` + explicit stock recheck → 409 ✅ FIXED
`mock_payment_confirm` now uses `.with_for_update()` on the `select(Product)` query and raises HTTP 409 with `"Insufficient stock"` detail when `prod.stock < oi.qty` at payment time. Replaced the silent `max(0, ...)`. `test_oversell_rejected_at_payment` drains stock to 0 in DB mid-flight and asserts 409 — passes.
> Note: `with_for_update()` is silently ignored on the in-memory SQLite test DB but works correctly on PostgreSQL in production. Accepted.

### MED#3 — Coupon re-validation at checkout ✅ FIXED
`checkout.py` now calls `validate_coupon(coupon, subtotal)` for every applied coupon immediately before creating the `Order`. Raises HTTP 400 with coupon code + error message if expired or max_uses exceeded. `test_expired_coupon_rejected_at_checkout` expires coupon after cart-apply and asserts 400 with "expired" in detail — passes.

### MED#4 — `JWT_SECRET` no default ✅ FIXED
`config.py:8` is now `JWT_SECRET: str` with no default value. Pydantic-settings will raise `ValidationError` at startup if the env var is absent. `test_jwt_secret_no_default` introspects `Settings.model_fields["JWT_SECRET"].default` and asserts `PydanticUndefined` — passes.

### MED#5 — docker-compose env passthrough + `.env.example` ✅ FIXED
`docker-compose.yml` now uses `${JWT_SECRET}`, `${POSTGRES_PASSWORD}` (required), `${POSTGRES_USER:-shop}`, `${POSTGRES_DB:-ecommerce}` throughout — no hardcoded secrets. `.env.example` exists at repo root (`web-ban-hang/.env.example`) with `JWT_SECRET=` (empty), generation hint, and all Postgres vars. `test_docker_compose_no_hardcoded_jwt_secret` asserts absence of `"changeme-in-production"` and presence of `${JWT_SECRET}` — passes.

### MED#6 — Magic-bytes image validation ✅ FIXED
`uploads.py` now has `_detect_mime(data: bytes) -> str | None` that checks actual file signatures:
- JPEG: `\xff\xd8\xff`
- PNG: `\x89PNG\r\n\x1a\n`
- WebP: `RIFF....WEBP` (4-byte RIFF header + offset-8 `WEBP` marker)

Client-supplied `file.content_type` is completely ignored for MIME determination — the extension is derived from the detected mime type. Three tests cover spoofed PNG rejection (415), real JPEG acceptance, real PNG via `application/octet-stream` — all pass.

### pytest 58/58 ✅
All 58 tests pass in 27.84s. 8 new tests in `test_t085_fixes.py` cover all 6 fixes.

### Alembic migration 0002 ✅
`0002_order_coupon_codes.py` adds `coupon_codes JSON NOT NULL server_default '[]'` to `orders` via `batch_alter_table` (SQLite-compatible). `down_revision = "0001"` chain is correct. Downgrade drops the column. Clean.

## Minor findings (non-blocking)

1. **test_t085_fixes.py:138,152** — `pytestmark = pytest.mark.asyncio` at module level applies to the two sync test functions (`test_jwt_secret_no_default`, `test_docker_compose_no_hardcoded_jwt_secret`), causing a `PytestWarning`. Tests still pass; fix by adding `@pytest.mark.no_asyncio` or removing module-level `pytestmark` and marking only the async tests individually.

2. **.env.example** `DATABASE_URL` still contains the literal `changeme` password placeholder (copied from Postgres vars). Acceptable for an example file, but could reference `${POSTGRES_PASSWORD}` for consistency.

## Action items

None blocking. Optional cleanup:
- Fix `pytestmark` scope in `test_t085_fixes.py` to suppress PytestWarnings on sync tests.
