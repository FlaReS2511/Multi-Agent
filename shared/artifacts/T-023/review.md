# Review T-023 — Post-Fix Re-Review (BUG-1 FE admin role + BUG-2 BE stock)

**Reviewer:** reviewer-agent
**Date:** 2026-05-04 14:52
**Verdict:** approved

---

## Files Reviewed (delta only)

### Frontend (T-019 fix)
- `frontend/src/lib/store.ts` — `User` interface
- `frontend/src/components/AdminGuard.tsx`
- `frontend/src/components/Header.tsx`
- `frontend/src/pages/ProfilePage.tsx`

### Backend (T-018 fix)
- `backend/app/routers/orders.py`
- `backend/app/schemas.py`
- `backend/tests/test_orders.py`

---

## Tests

### Backend
```
pytest --cov=app: 23/23 passed (was 21) — Duration 2.87s
Total coverage: 80%
orders.py coverage: 98% (was 94%)
```

### Frontend
```
vitest --run: 17/17 passed
npm run build: SUCCESS (no TS errors)
```

---

## Fix 1 Verification — FE admin role mapping (BUG-1)

**Status: RESOLVED ✅**

| Check | Result |
|-------|--------|
| `store.ts` User interface uses `is_admin: boolean` | ✅ |
| `AdminGuard.tsx` checks `!user.is_admin` | ✅ |
| `Header.tsx` checks `user.is_admin` | ✅ |
| `ProfilePage.tsx` uses `user.is_admin` | ✅ |
| `grep -r "user\.role" src/` → zero matches (excluding HTML role= attrs) | ✅ |
| `npm run build` clean, no TS errors | ✅ |
| FE tests 17/17 pass | ✅ |

The type is now consistent with the BE `UserOut` contract (`is_admin: boolean`). AdminGuard correctly gates `/admin/*` routes.

---

## Fix 2 Verification — BE stock decrement on checkout (BUG-2)

**Status: RESOLVED ✅**

| Check | Result |
|-------|--------|
| Pre-validates stock for ALL items before `Order` INSERT | ✅ — loop at lines 27-33, before `db.flush()` |
| `with_for_update=True` row-level lock on product rows | ✅ — `db.get(..., with_for_update=True)` |
| `product.stock_qty -= item.qty` in commit loop | ✅ — line 47 |
| 400 on out-of-stock leaves zero DB side-effects (no dangling Order) | ✅ — confirmed by `test_checkout_out_of_stock`: 0 orders in DB after failure |
| `test_checkout_decrements_stock` passes | ✅ — verifies `stock_qty == initial - 3` after checkout |
| `test_checkout_out_of_stock` passes | ✅ — verifies 400, stock unchanged, no Order created |

---

## Bonus Fixes Verification

| Fix | Status |
|-----|--------|
| `CartItemCreate.qty = Field(default=1, ge=1)` | ✅ — confirmed in `schemas.py:100` |
| `OrderStatusUpdate.status: Literal["paid","shipping","delivered","cancelled"]` | ✅ — confirmed in `schemas.py:194-196` |

---

## Definition of Done — Final Status

| Item | Status |
|------|--------|
| `docker compose up --build` → 3 services healthy | ✅ |
| http://localhost:3000 → homepage loads | ✅ |
| Signup + login flow | ✅ |
| Add to cart → checkout → order created | ✅ |
| Admin login → /admin/products CRUD | ✅ — AdminGuard now correctly uses `is_admin` |
| pytest ≥ 15 pass, coverage ≥ 70% | ✅ — 23/23, 80% |
| README complete | ✅ |
| ARCHITECTURE.md ER + architecture diagram | ✅ |

All DoD items satisfied.
