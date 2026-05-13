# T-073 — FE Cart + Checkout + Mock Payment

## New / Modified Files

```
src/
├── types/cart.ts                          # CartItem, Cart, CartTotals, DiscountLine, CheckoutRequest/Out, Order
├── api/cart.ts                            # getCart, addItem, updateItem, removeItem, clearCart,
│                                          #   applyCoupon, removeCoupon, getTotals, checkout, payMock
├── store/cart.ts                          # zustand cart store (fetch, addItem, updateItem, removeItem,
│                                          #   applyCoupon, removeCoupon, clear) — refetches totals after mutation
├── components/cart/
│   ├── CartItemRow.tsx                    # image, name, qty stepper (+/-), line total, remove ×
│   ├── CouponChip.tsx                     # code + formatted discount chip with remove ×
│   ├── CouponInput.tsx                    # text input + Apply button, inline error
│   ├── TotalsBreakdown.tsx               # subtotal, per-coupon discounts, shipping (Free if 0), tax, total
│   └── AddressForm.tsx                    # 8-field shipping form (grid, required validation)
├── pages/
│   ├── CartPage.tsx                       # /cart — item list + coupon chips + input + totals sidebar + Checkout link
│   ├── CheckoutPage.tsx                   # /checkout — AddressForm + readonly summary + Place order → navigate to payment_url
│   ├── PaymentMockPage.tsx               # /pay/mock/:order_id — fake card form (visual only) → payMock API → /orders/:id/success
│   └── OrderSuccessPage.tsx              # /orders/:id/success — confirmation screen with order ID
├── pages/DetailPage.tsx                   # (updated) Add to cart wired — uses cartStore.addItem, redirects to /login if unauth
├── components/Layout.tsx                  # (updated) Added 🛒 Cart link for authenticated users
├── App.tsx                                # (updated) 4 new protected routes: /cart, /checkout, /pay/mock/:order_id, /orders/:id/success
└── test/
    ├── CouponChip.test.tsx               # renders code+amount, calls onRemove
    └── TotalsBreakdown.test.tsx          # renders all line items, Free shipping, discount
```

## Flow

```
DetailPage [Add to cart] → CartPage → CheckoutPage → PaymentMockPage → OrderSuccessPage
```

## API Endpoints Used

| Function | Method | Path |
|----------|--------|------|
| getCart | GET | /api/v1/cart |
| addItem | POST | /api/v1/cart/items |
| updateItem | PATCH | /api/v1/cart/items/:id |
| removeItem | DELETE | /api/v1/cart/items/:id |
| applyCoupon | POST | /api/v1/cart/coupons |
| removeCoupon | DELETE | /api/v1/cart/coupons/:code |
| getTotals | GET | /api/v1/cart/totals |
| checkout | POST | /api/v1/checkout |
| payMock | POST | /api/v1/payments/mock/confirm |

## DoD Status

- [x] Full flow: add to cart → cart → checkout → pay → success
- [x] Multi-coupon UI: add/remove chips with discount amounts
- [x] Totals refresh after every mutation (addItem, updateItem, removeItem, applyCoupon, removeCoupon)
- [x] `npm run build` passes — no TS errors
- [x] `npm test` passes — 8 tests across 5 files
- [x] SUMMARY.md at shared/artifacts/T-073/
