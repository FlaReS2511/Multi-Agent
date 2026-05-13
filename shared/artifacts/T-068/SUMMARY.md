# T-068 — Cart, Checkout, Multi-Coupon, Mock Payment, Orders

## Files Added

```
web-ban-hang/backend/
├── app/
│   ├── models/
│   │   ├── coupon.py          Coupon (code PK, type, value, stackable, min_subtotal, expires_at, max_uses, used_count)
│   │   ├── orders.py          Cart (user_id PK), CartItem, CartCoupon, Order, OrderItem, OrderStatus enum
│   │   └── __init__.py        (updated: registers all new models)
│   ├── schemas/
│   │   ├── cart.py            CartItemAdd/Update/Out, CartOut, CouponApply, CartTotals, DiscountLine
│   │   └── orders.py          CheckoutRequest/Out, OrderOut, OrderItemOut, OrderStatusUpdate, PaymentConfirm
│   ├── core/
│   │   └── pricing.py         calc_totals(), validate_coupon() — pure business logic
│   └── api/v1/
│       ├── cart.py            Cart CRUD + coupon apply/remove + GET /cart/totals
│       ├── checkout.py        POST /checkout + POST /payments/mock/confirm
│       ├── orders.py          GET /orders, GET /orders/{id}, GET /admin/orders, PATCH /admin/orders/{id}/status
│       └── router.py          (updated)
├── tests/
│   ├── test_cart.py           5 tests
│   └── test_checkout.py       6 tests
```

## Endpoints (13 new)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/v1/cart | Customer | View cart |
| POST | /api/v1/cart/items | Customer | Add item {product_id, qty} |
| PATCH | /api/v1/cart/items/{id} | Customer | Update qty |
| DELETE | /api/v1/cart/items/{id} | Customer | Remove item |
| DELETE | /api/v1/cart | Customer | Clear cart |
| POST | /api/v1/cart/coupons | Customer | Apply coupon {code} |
| DELETE | /api/v1/cart/coupons/{code} | Customer | Remove coupon |
| GET | /api/v1/cart/totals | Customer | {subtotal, discounts[], shipping, tax, total} |
| POST | /api/v1/checkout | Customer | Create Order (pending) → {order_id, payment_url} |
| POST | /api/v1/payments/mock/confirm | Customer | Set paid + decrement stock (DB transaction) |
| GET | /api/v1/orders | Customer | Own orders |
| GET | /api/v1/orders/{id} | Customer | Own order detail (403 if not owner) |
| GET | /api/v1/admin/orders | Admin | All orders, filter ?status=... |
| PATCH | /api/v1/admin/orders/{id}/status | Admin | Update order status |

## Business Logic

### Pricing (app/core/pricing.py)
- Shipping: 30,000 cents if subtotal < 500,000 else free
- Tax: round(0.10 × (subtotal − total_discount))
- Discount cap: min(sum_of_discounts, subtotal)
- Total: (subtotal − discount) + shipping + tax

### Coupon stacking
- All applied coupons + new coupon must all have `stackable=True`
- If any is non-stackable, only one coupon allowed at a time
- Validation: expires_at, max_uses, min_subtotal_cents

### Payment + stock
- Checkout creates Order(pending), snapshots names+prices, clears cart
- Payment confirm atomically: Order.status=paid + Product.stock -= qty for each item

## Design Notes
- SQLite stores naive datetimes → `expires_at` comparison uses `.replace(tzinfo=UTC)` if naive
- `CartCoupon` is a simple join table (cart_id + coupon_code composite PK)
- Customer scoping enforced: `/orders/{id}` returns 403 if `order.user_id != current_user.id`
