# T-018 — Web Shop Backend API Contract

**Base URL:** `http://localhost:8000`
**Auth:** Bearer token in `Authorization: Bearer <token>` header

---

## Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/signup` | No | Register new user |
| POST | `/auth/login` | No | Login (rate limited: 5/min/IP) |
| GET | `/auth/me` | Yes | Get current user profile |

**POST /auth/signup**
```json
{ "email": "user@example.com", "password": "Password1!", "full_name": "Jane Doe" }
```
Response: `{ "access_token": "...", "token_type": "bearer", "user": { "id", "email", "full_name", "is_admin", "created_at" } }`

**POST /auth/login**
```json
{ "email": "user@example.com", "password": "Password1!" }
```
Response: same as signup

---

## Products

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/products` | No | List products with filters |
| GET | `/products/{slug}` | No | Product detail |

**GET /products** query params: `search`, `category` (slug), `price_min`, `price_max`, `page` (default 1), `size` (default 20, max 100), `sort` (price_asc|price_desc|created_at_asc|created_at_desc|name_asc)

Response:
```json
{
  "items": [{ "id", "name", "slug", "description", "price", "stock_qty", "image_url", "category": {"id","name","slug"}, "created_at" }],
  "total": 12, "page": 1, "size": 20, "pages": 1
}
```

---

## Cart

All cart endpoints require auth.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/cart` | Get cart with items + total |
| POST | `/cart/items` | Add item to cart |
| PATCH | `/cart/items/{id}` | Update item qty (qty≤0 removes) |
| DELETE | `/cart/items/{id}` | Remove item |

**POST /cart/items:** `{ "product_id": 1, "qty": 2 }`

**PATCH /cart/items/{id}:** `{ "qty": 3 }`

Cart response:
```json
{ "id": 1, "items": [{ "id", "product_id", "qty", "product": {...} }], "total": 59.98 }
```

---

## Orders

All require auth.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/orders/checkout` | Create order from cart |
| GET | `/orders` | List user's orders |
| GET | `/orders/{id}` | Order detail |

**POST /orders/checkout:**
```json
{
  "shipping_address": {
    "name": "Jane Doe",
    "street": "123 Main St",
    "city": "New York",
    "country": "US",
    "zip_code": "10001"
  }
}
```
Response: `{ "order_id": 1, "total_amount": 59.98, "status": "paid", "item_count": 2 }`

Order status values: `paid` | `shipping` | `delivered` | `cancelled`

---

## Reviews

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/products/{id}/reviews` | Yes | Post review (requires purchase) |
| GET | `/products/{id}/reviews` | No | List reviews for product |

**POST /products/{id}/reviews:** `{ "rating": 5, "body": "Great product!" }`
- Only allowed if user has an order with this product at status: paid/shipping/delivered

---

## Admin

All require admin token (`is_admin: true`).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/products` | Create product |
| PATCH | `/admin/products/{id}` | Update product |
| DELETE | `/admin/products/{id}` | Delete product |
| GET | `/admin/orders` | List all orders |
| PATCH | `/admin/orders/{id}` | Update order status |

**POST /admin/products:**
```json
{ "name": "...", "slug": "...", "description": "...", "price": 29.99, "stock_qty": 10, "image_url": "...", "category_id": 1 }
```

**PATCH /admin/orders/{id}:** `{ "status": "shipping" }`

---

## Health

`GET /health` → `{ "status": "ok" }` (no auth, used by Docker healthcheck)

---

## Notes for FE

- `UserOut` never includes `hashed_password`
- JWT tokens expire after 7 days (configurable via `JWT_EXPIRE_DAYS`)
- CORS: configured via `CORS_ORIGINS` env var (comma-separated or JSON list)
- Slug-based routing for products (not ID), e.g. `/products/wireless-headphones`
- Cart total is computed server-side from current product prices
- OrderItem stores `name_snapshot` + `price_snapshot` to freeze price at checkout time
