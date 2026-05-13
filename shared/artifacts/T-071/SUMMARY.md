# T-071 — Frontend Skeleton: Vite + React + TS + Tailwind + Auth UI

## File List

```
C:\Users\ADMINA1\Downloads\web-ban-hang\frontend\
├── .env.example                          # VITE_API_URL=http://localhost:8000
├── vite.config.ts                        # vitest/config, jsdom env
├── tailwind.config.js                    # content: src/**/*.{ts,tsx}
├── tsconfig.app.json                     # types: vite/client, vitest/globals
├── package.json                          # + test script (vitest run)
└── src/
    ├── index.css                         # @tailwind base/components/utilities
    ├── main.tsx                          # StrictMode + createRoot
    ├── App.tsx                           # BrowserRouter + Routes
    ├── api/
    │   └── client.ts                     # axios, base URL from VITE_API_URL, JWT interceptor
    ├── store/
    │   └── auth.ts                       # zustand + persist: user, token, login/register/logout/fetchMe
    ├── components/
    │   ├── Layout.tsx                     # header + role-aware nav + <Outlet/>
    │   ├── ProtectedRoute.tsx            # redirect /login if no token
    │   ├── AdminRoute.tsx                # redirect / if role != admin
    │   └── Toast.tsx                     # auto-dismiss toast (error|success)
    ├── pages/
    │   ├── LoginPage.tsx                 # email+password form, client-side validation, server error toast
    │   ├── RegisterPage.tsx              # same + redirects to /login on success
    │   ├── HomePage.tsx                  # placeholder
    │   ├── AccountPage.tsx               # shows user email/role/id (protected)
    │   └── AdminPage.tsx                 # admin placeholder (admin-only)
    └── test/
        ├── setup.ts                      # @testing-library/jest-dom import
        └── Layout.test.tsx               # smoke test: Layout renders site name
```

## Routes

| Path | Guard | Component |
|------|-------|-----------|
| `/` | public | HomePage |
| `/login` | public | LoginPage |
| `/register` | public | RegisterPage |
| `/account` | ProtectedRoute (token) | AccountPage |
| `/admin` | AdminRoute (role=admin) | AdminPage |

## Nav Behaviour

- **Unauthenticated:** Home | Login | Register
- **Customer:** Home | Account | Logout
- **Admin:** Home | Account | Admin | Logout

## API Endpoints Used

| Method | Path | When |
|--------|------|------|
| POST | /api/v1/auth/login | login() — OAuth2 form |
| POST | /api/v1/auth/register | register() |
| GET | /api/v1/auth/me | after login to load user |

## DoD Status

- [x] `npm run build` passes — no TS errors
- [x] `npm test` passes — 1 vitest smoke test
- [x] Auth store persists token via zustand/persist
- [x] Protected/Admin routes redirect correctly
- [x] Client-side validation: email regex + password ≥8 chars
- [x] Server error displayed via Toast
