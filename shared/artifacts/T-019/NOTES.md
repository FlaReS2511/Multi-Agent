# T-019 Frontend Artifact Notes

## Component Tree

```
App
└── RouterProvider
    └── Layout
        ├── Header (logo, search, cart icon, theme toggle, user dropdown)
        ├── Outlet
        │   ├── HomePage (featured products + categories)
        │   ├── ProductsPage (grid + sidebar filter + search debounce + sort + pagination)
        │   ├── ProductDetailPage (gallery + info + add-to-cart + reviews)
        │   ├── CartPage (full cart view)
        │   ├── CheckoutPage (shipping form → POST /orders/checkout)
        │   ├── OrderSuccessPage (order_id display)
        │   ├── OrdersPage [ProtectedRoute]
        │   ├── LoginPage
        │   ├── SignupPage
        │   ├── ProfilePage [ProtectedRoute]
        │   ├── AdminProductsPage [AdminGuard]
        │   └── AdminOrdersPage [AdminGuard]
        ├── CartDrawer (slide-in panel from right)
        └── Toast (context provider)
```

## State Model (Zustand)

| Store | State | Persistence |
|-------|-------|-------------|
| `authStore` | `user`, `token`, `setAuth`, `clearAuth` | localStorage |
| `cartStore` | `items[]`, `addItem`, `removeItem`, `updateQty`, `clearCart`, `total`, `count` | in-memory |
| `uiStore` | `theme`, `toggleTheme`, `cartOpen`, `setCartOpen` | theme → localStorage |

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `VITE_API_URL` | `http://localhost:8000` | Backend base URL |

## Key Files

- `src/lib/api.ts` — typed `apiFetch<T>()` with auto Bearer token
- `src/lib/auth.ts` — login/signup/logout/getMe helpers
- `src/lib/store.ts` — all zustand stores
- `src/router.tsx` — react-router-dom v6 route tree
- `src/styles/index.css` — Tailwind directives + CSS custom props

## Build Verification

- `npm run build` — PASS (Vite production build, no TS errors)
- `npm run test -- --run` — 17/17 tests PASS
- `npm run dev` — starts at localhost:5173

## Files Created (47 total)

Config: package.json, tsconfig.json, vite.config.ts, tailwind.config.js, postcss.config.js, index.html, .env.example, Dockerfile, nginx.conf

Source:
- src/main.tsx, src/App.tsx, src/router.tsx
- src/lib/api.ts, src/lib/auth.ts, src/lib/store.ts
- src/styles/index.css
- 11 components: Layout, Header, Footer, ProductCard, CartDrawer, ProtectedRoute, AdminGuard, Skeleton, Toast, Pagination, ErrorBoundary
- 12 pages: HomePage, ProductsPage, ProductDetailPage, CartPage, CheckoutPage, OrderSuccessPage, OrdersPage, LoginPage, SignupPage, ProfilePage, AdminProductsPage, AdminOrdersPage

Tests (4 files, 17 tests):
- src/__tests__/setup.ts
- src/__tests__/Header.test.tsx (4 tests)
- src/__tests__/ProductCard.test.tsx (6 tests)
- src/__tests__/CartDrawer.test.tsx (4 tests)
- src/__tests__/FormValidation.test.tsx (3 tests)
