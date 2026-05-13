# T-074 — FE Order History + Wishlist + UX Polish

## New / Modified Files

```
src/
├── types/order.ts                         # Order, OrderItem (status union type)
├── types/wishlist.ts                      # WishlistItem
├── api/orders.ts                          # listOrders, getOrder
├── api/wishlist.ts                        # listWishlist, addToWishlist, removeFromWishlist
├── store/wishlist.ts                      # zustand: items, ids Set, fetch/add/remove/toggle
├── context/ToastContext.tsx              # ToastProvider + useToast + ToastContainer (queue, max 3, top-right)
├── components/ui/
│   └── ErrorBoundary.tsx                 # class component, getDerivedStateFromError, Reload button fallback
├── components/order/
│   ├── OrderStatusBadge.tsx              # colored pill (pending/paid/shipped/delivered/cancelled)
│   └── StatusTimeline.tsx               # 4-step progress bar with ✓ marks
├── components/catalog/ProductCard.tsx    # (updated) wishlist ❤️/🤍 toggle button for auth users
├── components/Layout.tsx                  # (updated) mobile hamburger + slide-down drawer; NavLink; Wishlist+Orders links
├── pages/
│   ├── OrderHistoryPage.tsx              # /orders — list with skeleton, empty state
│   ├── OrderDetailPage.tsx              # /orders/:id — timeline + items + address + Reorder button
│   ├── WishlistPage.tsx                  # /wishlist — grid with Add to cart + remove
│   └── NotFoundPage.tsx                 # /* fallback — 404 with Back to home
├── pages/DetailPage.tsx                   # (updated) wishlist toggle button beside Add to cart
├── main.tsx                               # (updated) wrapped with <ErrorBoundary> + <ToastProvider>
├── App.tsx                                # (updated) 4 new protected routes + NotFoundPage * fallback
└── test/
    ├── ErrorBoundary.test.tsx            # renders fallback on throw, renders children normally
    └── ToastQueue.test.tsx              # queue shows multiple toasts, manual dismiss works
```

## Routes Added

| Path | Page | Guard |
|------|------|-------|
| `/orders` | OrderHistoryPage | Protected |
| `/orders/:id` | OrderDetailPage | Protected |
| `/wishlist` | WishlistPage | Protected |
| `/*` | NotFoundPage | Public |

## UX Polish Summary

- **ErrorBoundary** wraps entire app — catches render errors, shows friendly fallback + Reload button
- **Toast queue** (ToastContext): max 3 simultaneous, auto-dismiss 4s, manual ×, `success`/`error`/`info` colors, top-right position, `aria-live` region
- **Loading skeletons** on OrderHistoryPage, OrderDetailPage, WishlistPage (reuses `LoadingSkeleton`)
- **Mobile hamburger** in Layout: slide-down drawer on small screens, hidden on md+
- **404 page** via `<Route path="*">` fallback
- **Wishlist heart** in ProductCard (authenticated users) and DetailPage sidebar

## DoD Status

- [x] All pages work (OrderHistory, OrderDetail, Wishlist, 404)
- [x] Loading skeletons on 3+ pages (History, Detail, Wishlist)
- [x] ErrorBoundary catches + shows reload fallback (tested)
- [x] Mobile hamburger drawer (Layout updated)
- [x] `npm run build` passes — no TS errors
- [x] `npm test` 12/12 pass (7 test files)
- [x] SUMMARY.md at shared/artifacts/T-074/

## Notes

- T-069 artifact not found — wishlist endpoints assumed as per task brief (`GET/POST/DELETE /api/v1/wishlist/:product_id`). Confirm with BE when T-069 lands.
- `useToast` hook exported from `ToastContext.tsx` — OrderDetailPage (Reorder), WishlistPage (Add to cart) use it.
