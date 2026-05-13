# T-077 — Docker Compose + Project README

## Files Added / Modified

```
web-ban-hang/
├── docker-compose.yml          (new) — 3 services: db, backend, frontend
├── README.md                   (new) — project-level overview & quick start
├── backend/Dockerfile          (exists from prior session) — python:3.11-slim
└── frontend/Dockerfile         (exists from prior session) — node:20-alpine → nginx
```

## docker-compose.yml

Services:

| Service | Image / Build | Port | Notes |
|---------|--------------|------|-------|
| `db` | postgres:16 | — | Volume `pgdata`, healthcheck `pg_isready` |
| `backend` | `./backend` | 8000 | `depends_on: db (healthy)`, runs `alembic upgrade head && uvicorn` |
| `frontend` | `./frontend` | 5173→80 | nginx serving built React dist |

Environment variables set via Compose:
- `DATABASE_URL=postgresql+asyncpg://shop:shoppass@db:5432/ecommerce`
- `JWT_SECRET=changeme-in-production`
- `CORS_ORIGINS=["http://localhost:5173"]`

## backend/Dockerfile

```
python:3.11-slim → pip install requirements.txt → COPY app → EXPOSE 8000
CMD: alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## frontend/Dockerfile

```
Stage 1 (builder): node:20-alpine → npm ci → npm run build
Stage 2 (serve):   nginx:alpine → copy /app/dist → SPA routing config → EXPOSE 80
```

## README.md

Sections:
- Overview (architecture diagram, tech table)
- Quick Start — Docker Compose (build → seed → open app)
- Quick Start — Local Dev (BE + FE + SQLite option)
- Features (catalog, cart, multi-coupon, orders, admin, analytics, reviews, wishlist, AI templates)
- Test Accounts (admin + 3 customers + coupon codes)
- Tech Stack (BE packages + versions, FE packages)
- Project Structure (annotated directory tree)
- Running Tests

## DoD Checklist

- [x] docker-compose.yml — db + backend + frontend services
- [x] backend/Dockerfile — works (used by CMD in compose)
- [x] frontend/Dockerfile — multi-stage node→nginx
- [x] README.md — complete, copy-paste commands runnable
- [x] SUMMARY.md at shared/artifacts/T-077/
