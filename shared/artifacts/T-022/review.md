# Review T-022 — Web Shop Full-Stack MVP (Unified Review)

**Reviewer:** reviewer-agent
**Date:** 2026-05-04 14:48
**Verdict:** changes-requested

---

## Files Reviewed

### Backend (T-018)
- `backend/app/main.py`, `config.py`, `database.py`, `models.py`, `schemas.py`
- `backend/app/auth.py`, `limiter.py`, `seed.py`
- `backend/app/routers/auth.py`, `products.py`, `cart.py`, `orders.py`, `reviews.py`, `admin.py`
- `backend/tests/conftest.py`, `test_auth.py`, `test_cart.py`, `test_orders.py`, `test_products.py`

### Frontend (T-019)
- `frontend/src/lib/api.ts`, `auth.ts`, `store.ts`
- `frontend/src/components/AdminGuard.tsx`, `ProtectedRoute.tsx`, `CartDrawer.tsx`, `Header.tsx`
- `frontend/src/pages/LoginPage.tsx`, `SignupPage.tsx`, `AdminProductsPage.tsx`
- All 4 test files

### AI Prompts (T-020)
- `ai/prompts/product_description.py`
- `ai/prompts/customer_support.py`
- `ai/prompts/__init__.py`

### Docker + Docs (T-021)
- `docker-compose.yml`, `README.md`, `ARCHITECTURE.md`, `.env.example`
- `backend/start.sh`, `backend/Dockerfile`, `frontend/Dockerfile`

---

## Tests

### Backend
```
pytest --cov=app: 21/21 passed — Duration 2.40s
```

| Module | Coverage |
|--------|----------|
| app/auth.py | 80% |
| app/config.py | 100% |
| app/routers/auth.py | 100% |
| app/routers/cart.py | 85% |
| app/routers/orders.py | 94% |
| app/routers/products.py | 94% |
| app/routers/admin.py | 38% |
| app/routers/reviews.py | 40% |
| **TOTAL** | **80%** |

### Frontend
```
vitest --run: 17/17 passed — Duration 1.09s
npm run build: SUCCESS (1 warning: chunk 502 kB > 500 kB soft limit)
```

---

## Findings

### Spec Compliance
- [✓] Auth (signup/login/me) matches API contract
- [✓] Products list/filter/search/pagination matches spec
- [✓] Cart CRUD matches spec
- [✓] Checkout / orders flow implemented correctly
- [✓] Reviews require prior purchase — correctly enforced
- [✓] Admin product CRUD and order status update present
- [✓] Health endpoint at GET /health
- [✓] Docker Compose — 3 services (postgres, backend, frontend)
- [✓] README: tech stack, quick start, local dev, run tests, credentials, AI usage, decisions, roadmap
- [✓] ARCHITECTURE.md: ER diagram (mermaid) + system diagram + auth flow + request lifecycle
- [✗] Admin panel inaccessible — see BLOCKING BUG #1 below

---

### BLOCKING Bugs

#### BUG-1 (CRITICAL): Admin panel always redirects — FE User type mismatch with BE contract

**File:** `frontend/src/lib/store.ts:11` + `frontend/src/components/AdminGuard.tsx:5`

**Problem:** The FE `User` interface declares `role: 'customer' | 'admin'` but the backend
`UserOut` schema returns `is_admin: boolean`. Since TypeScript types are erased at runtime,
`data.user.role` is always `undefined` — the backend never sends a `role` field.

`AdminGuard` checks:
```ts
if (!user || user.role !== 'admin') return <Navigate to="/" replace />
```
Because `user.role` is always `undefined`, this condition is always `true`, so every admin user
is silently redirected away from `/admin/*`. **The admin panel is completely inaccessible.**

**Fix option A** (minimal change — recommended):
In `frontend/src/lib/store.ts`, change `User` interface:
```ts
export interface User {
  id: number
  email: string
  full_name: string
  is_admin: boolean   // ← rename from role to match BE contract
  created_at: string
}
```
And update `AdminGuard`:
```ts
if (!user || !user.is_admin) return <Navigate to="/" replace />
```

**Fix option B**: Keep `role` field in User, but add a mapping in `auth.ts` responses:
```ts
const mapped: User = { ...data.user, role: data.user.is_admin ? 'admin' : 'customer' }
```

---

#### BUG-2 (HIGH): Stock not decremented on checkout

**File:** `backend/app/routers/orders.py:31-43`

`stock_qty` is tracked in the `Product` model but is never decremented when an order is
placed. A product with `stock_qty=0` can be ordered unlimited times. Overselling is possible.

**Fix:** Add stock decrement inside the checkout loop:
```python
for item in cart.items:
    if not item.product:
        continue
    if item.product.stock_qty < item.qty:
        raise HTTPException(status_code=400, detail=f"Insufficient stock for {item.product.name}")
    item.product.stock_qty -= item.qty
    # ... rest of order item creation
```

---

### Minor Issues (non-blocking for MVP)

#### ISSUE-3: Wrong return type annotation on `generate_description`

**File:** `ai/prompts/product_description.py:44`

Function signature says `-> str` but actually returns `dict`:
```python
def generate_description(name: str, category: str, price: int) -> str:  # ← wrong
    ...
    return {"system": SYSTEM_PROMPT, "user": user_prompt}   # ← returns dict
```

**Fix:** Change `-> str` to `-> dict`.

---

#### ISSUE-4: `OrderStatusUpdate.status` has no enum validation

**File:** `backend/app/schemas.py:194-195`

Admin can set any arbitrary string as order status (e.g., "hacked", "deleted"). Should be:
```python
from typing import Literal

class OrderStatusUpdate(BaseModel):
    status: Literal["paid", "shipping", "delivered", "cancelled"]
```

---

#### ISSUE-5: `CartItemCreate.qty` — no positive validation

**File:** `backend/app/routers/cart.py:47` / `backend/app/schemas.py:99`

`qty` has no `ge=1` constraint. A client could POST `{"product_id": 1, "qty": 0}` or
`{"product_id": 1, "qty": -5}` and these would be silently added to cart.

**Fix:** Add `qty: int = Field(1, ge=1)` to `CartItemCreate`.

---

### AI Prompt Deviation Decision

**Decision: APPROVE — keep `dict` return from `generate_description`.**

The AIE's rationale is correct: returning `{system, user}` as separate strings is the proper
Anthropic API pattern (system param vs messages list). The contract change from `-> str` is
justified because passing a joined string to the API would be incorrect. However, fix the type
annotation (ISSUE-3) to avoid confusion.

---

### Security Checks

| Check | Status | Notes |
|-------|--------|-------|
| CORS from env only | ✅ PASS | `settings.CORS_ORIGINS` via `pydantic-settings`, docker-compose passes JSON string which pydantic parses correctly |
| Password ≥ 8 chars (BE) | ✅ PASS | `schemas.py:13-17` field_validator enforces |
| Password ≥ 8 chars (FE) | ✅ PASS | `SignupPage.tsx:25` client-side validation |
| Rate limit `/auth/login` | ✅ PASS | `@limiter.limit("5/minute")` on login endpoint |
| `hashed_password` not in responses | ✅ PASS | `UserOut` schema only has `id, email, full_name, is_admin, created_at` |
| JWT_SECRET from env | ✅ PASS | `config.py` reads from env; docker-compose uses `${JWT_SECRET:-change-me-in-production}` |
| SQL injection | ✅ PASS | All queries use SQLAlchemy ORM — zero raw SQL with string formatting |
| No secrets hardcoded in FE | ✅ PASS | Only `VITE_API_URL` env var, no API keys |
| Admin auth enforced | ✅ PASS (BE) / ⚠️ BROKEN (FE) | BE correctly checks `is_admin`. FE AdminGuard broken (BUG-1) |

---

### Style / Maintainability

- Backend code is clean, consistent, well-structured. FastAPI best practices followed.
- Frontend components are modular. Zustand stores are well-organized.
- Tech deviations (bcrypt direct, StaticPool, lifespan) are all reasonable and documented.
- Bundle size warning (502 kB) is acceptable for MVP — defer code-splitting to later.
- Admin (38%) and reviews (40%) routers lack test coverage — acceptable for MVP scope, but
  reviews router has no tests at all for an important business rule (purchase-gated reviews).

---

## Definition of Done Checklist (T-017)

| Item | Status | Notes |
|------|--------|-------|
| `docker compose up --build` → 3 services healthy | ✅ | Services defined correctly, healthchecks present |
| http://localhost:3000 → homepage loads products | ✅ | FE build passes, nginx serves correctly |
| Signup + login flow works | ✅ | 21 BE tests + FE tests pass |
| Add to cart → checkout → order created | ✅ | Tested in pytest (test_checkout_and_order_list) |
| Admin login → /admin/products CRUD | ❌ BLOCKED | AdminGuard always redirects (BUG-1) |
| pytest ≥ 15 pass, coverage ≥ 70% | ✅ | 21/21 pass, 80% coverage |
| README: install + run + tests + docker | ✅ | Comprehensive README |
| ARCHITECTURE.md: ER + architecture diagram | ✅ | Both diagrams present and correct |

---

## Action Items (Required Before Approval)

1. **[FE] Fix `User` interface type mismatch with BE `is_admin`** — `store.ts:11` and `AdminGuard.tsx:5`. Admin panel is completely inaccessible without this fix.
2. **[BE] Decrement `product.stock_qty` on checkout** — `routers/orders.py:31-43`. Also validate sufficient stock before creating order.

Optional (recommended but not blocking):
3. **[AI] Fix `generate_description` return type annotation** — `product_description.py:44`, change `-> str` to `-> dict`.
4. **[BE] Add enum validation to `OrderStatusUpdate.status`** — `schemas.py:195`.
5. **[BE] Add `ge=1` to `CartItemCreate.qty`** — `schemas.py:99`.
