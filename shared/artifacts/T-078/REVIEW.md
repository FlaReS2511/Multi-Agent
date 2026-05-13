# BE Review T-078 — Aggregate Backend Review (T-066 → T-083)

**Date:** 2026-05-13 23:00
**Verdict:** changes-requested

## Files reviewed
- project/backend/app/core/config.py
- project/backend/app/core/security.py
- project/backend/app/core/pricing.py
- project/backend/app/core/notifier.py
- project/backend/app/main.py
- project/backend/app/api/v1/auth.py
- project/backend/app/api/v1/cart.py
- project/backend/app/api/v1/checkout.py
- project/backend/app/api/v1/orders.py
- project/backend/app/api/v1/products.py
- project/backend/app/api/v1/reviews.py
- project/backend/app/api/v1/analytics.py
- project/backend/app/api/v1/admin_coupons.py
- project/backend/app/api/v1/inventory.py
- project/backend/app/api/v1/uploads.py
- project/backend/app/models/ (all)
- project/backend/alembic/versions/0001_initial_schema.py
- project/backend/docker-compose.yml (root)
- project/backend/scripts/seed.py

## Findings

### Spec / API contract
- All 8 task endpoints match the spec (auth, catalog, cart, checkout, reviews, inventory, analytics, coupon admin, stock movements, docker).
- HTTP status codes are mostly correct: 200/201/204/400/401/403/404/409/422 all present.
- Pydantic Read/Create/Update schemas exist for all public-facing models.

### Validation & errors
- All input boundaries (request bodies, query params) use Pydantic models. ✅
- No catch-all `except Exception:` swallowing errors. ✅
- Error responses follow `{"detail": "..."}` convention. ✅

### Security

#### ✅ Passing
- JWT secret read from env (`JWT_SECRET` env var via pydantic-settings). ✅
- bcrypt via `passlib.context.CryptContext` (default cost 12). ✅
- CORS: origin allowlist read from `CORS_ORIGINS` env var — no wildcard in production path. ✅
- All admin write endpoints guard with `Depends(require_role(Role.admin))`. ✅
- `/orders/{order_id}` returns 403 if `order.user_id != current_user.id`. ✅
- SQLAlchemy ORM throughout — no raw f-string SQL, no injection surface. ✅
- Upload UUID filename — no path traversal. ✅
- Upload MIME allowlist + 5 MB cap. ✅

#### ⚠️ Issues
**[MEDIUM — T-066/T-067] config.py:8 — weak JWT_SECRET fallback**
`JWT_SECRET: str = "insecure-dev-secret"` is the pydantic-settings default. If the env var is absent in any deployment, all JWTs become forgeable. The default should raise, not silently fall back:
```python
JWT_SECRET: str  # no default — will raise ValidationError if missing
```

**[MEDIUM — T-077] docker-compose.yml JWT_SECRET is a placeholder**
`JWT_SECRET: changeme-in-production` is committed in plain text with a placeholder value. There is no `.env.example` warning. DB password `shoppass` is also hardcoded. Add a `.env.example` with `JWT_SECRET=` (empty) and a comment, and reference it from the README.

**[MEDIUM — T-067] uploads.py:28 — content_type from client is untrusted**
`file.content_type` is the value the HTTP client sends; it is trivially spoofable. A PNG with a `.js` or malicious payload inside will pass this check. Add a magic-bytes read (e.g., `python-magic` or manual header check):
```python
MAGIC = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG": "image/png",
         b"RIFF": "image/webp"}
```
This is already partially mitigated by UUID filenames + static serving (no exec), but the content_type header should not be trusted.

### Business logic

**[HIGH — T-068/T-082] coupon `used_count` is never incremented**
`validate_coupon()` checks `coupon.used_count >= coupon.max_uses`, but neither `checkout` nor `mock_payment_confirm` ever increments `used_count`. A coupon with `max_uses=1` can be redeemed unlimited times.

Fix in `mock_payment_confirm` (checkout.py), after the order is confirmed paid, for each coupon applied:
```python
for cc in cart_coupons_snapshot:   # snapshot before cart cleared
    coupon = await db.get(Coupon, cc.coupon_code)
    if coupon:
        coupon.used_count += 1
```
The cart coupon codes must be captured before `await db.delete(ci)` clears them in the checkout flow, or the increment must happen at payment-confirm time.

**[MEDIUM — T-068] checkout.py:100 — stock decrement silently undersells**
`prod.stock = max(0, prod.stock - oi.qty)` in `mock_payment_confirm` will set stock to 0 even if `oi.qty > prod.stock` (e.g., if two users paid concurrently). Re-check stock availability before decrementing:
```python
if prod.stock < oi.qty:
    raise HTTPException(400, detail=f"Insufficient stock for '{prod.name}'")
prod.stock -= oi.qty
```

**[MEDIUM — T-068] cart.py / checkout.py — coupon expiry not re-validated at checkout**
`validate_coupon()` is called when the user adds a coupon to the cart, but is **not** called again at checkout or payment time. A coupon that expires or hits `max_uses` after being added to cart will still apply a discount. Re-run `validate_coupon` against each applied coupon in the `checkout` endpoint before committing the order.

**[LOW — T-068] checkout.py mock_payment_confirm — no `select_for_update`**
Stock decrement reads then writes `Product.stock` without a row-level lock. Under concurrent paid confirmations for the same product, both reads return the same stock value and both writes commit, causing one decrement to be lost. Use `.with_for_update()` on the `select(Product)` query inside the payment confirm.

### Tests (pytest 50/50 passed)
- All 50 tests pass. ✅
- Happy path + error paths covered for auth, cart, checkout, catalog, reviews, uploads, stock movements. ✅
- `test_checkout_insufficient_stock` covers stock guard at checkout time. ✅
- **Gap:** No test for `used_count` incrementing after payment — this would have caught the bug above.
- **Gap:** No test for concurrent stock decrement.

### Quality
- Type hints complete on all public API functions. ✅
- No unnecessary `Any`, no un-commented `# type: ignore`. ✅
- No over-abstraction — each endpoint is direct and readable. ✅
- `analytics.py:11` imports `LOW_STOCK_THRESHOLD` from `app.models.reviews` — semantically wrong module; threshold belongs in `app.core.notifier` or `app.core.config`. Works but confusing.
- Alembic `upgrade()` and `downgrade()` cover all tables in correct dependency order. ✅
- Seed script is idempotent. ✅
- Docker compose: DB healthcheck present, `depends_on: condition: service_healthy` correct. Backend missing healthcheck entry (only DB has one). Minor.

## Action items (changes-requested)

1. **checkout.py / cart.py [HIGH]** — Increment `coupon.used_count` for each applied coupon after payment confirm succeeds. Add a test asserting `used_count` increases after a completed order.

2. **checkout.py:100 [MEDIUM]** — Replace `max(0, prod.stock - oi.qty)` with a guard that raises 400 if stock is insufficient at payment time.

3. **cart.py / checkout.py [MEDIUM]** — Re-run `validate_coupon()` inside the `checkout` endpoint (or `mock_payment_confirm`) to reject expired / exhausted coupons that slipped through.

4. **config.py:8 [MEDIUM]** — Remove the `"insecure-dev-secret"` default so pydantic raises `ValidationError` on startup if `JWT_SECRET` is missing in env.

5. **docker-compose.yml [MEDIUM]** — Replace hardcoded `JWT_SECRET: changeme-in-production` + DB password with a reference to `.env`; add `.env.example` to repo.

6. **uploads.py:28 [MEDIUM]** — Validate image magic bytes, not just the client-supplied `content_type` header.

7. **checkout.py mock_payment_confirm [LOW]** — Add `.with_for_update()` to the Product select during stock decrement.

8. **analytics.py:11 [LOW]** — Move `LOW_STOCK_THRESHOLD` import to `app.core.notifier` (where it is defined) and remove the cross-module import from `app.models.reviews`.
