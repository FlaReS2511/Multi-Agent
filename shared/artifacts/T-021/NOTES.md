# T-021 — Docker Compose + Docs Setup Notes

## Files Created

- `/Users/tom/Downloads/web-shop/docker-compose.yml`
- `/Users/tom/Downloads/web-shop/README.md`
- `/Users/tom/Downloads/web-shop/ARCHITECTURE.md`
- `/Users/tom/Downloads/web-shop/.env.example`
- `/Users/tom/Downloads/web-shop/backend/start.sh`

## Files Modified

- `/Users/tom/Downloads/web-shop/frontend/Dockerfile` — added `ARG VITE_API_URL` + `ENV VITE_API_URL=$VITE_API_URL` before `npm run build`
- `/Users/tom/Downloads/web-shop/backend/Dockerfile` — changed CMD to `/app/start.sh`, added `chmod +x` on start.sh

## Setup Steps

```bash
cd /Users/tom/Downloads/web-shop
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build
```

## Service Details

| Service | Port | Health Check |
|---------|------|--------------|
| postgres | (internal) | `pg_isready -U shop -d shopdb` |
| backend | 8000 | `GET /health` → `{"status":"ok"}` |
| frontend | 3000 | depends_on backend healthy |

## Backend Startup Sequence (in container)

1. `start.sh` runs `python -m app.seed` (idempotent — skips if admin user exists)
2. `exec uvicorn app.main:app --host 0.0.0.0 --port 8000`
3. FastAPI lifespan calls `init_db()` to create tables via SQLAlchemy

## VITE_API_URL Note

Vite bakes environment variables at build-time (not runtime). The frontend Dockerfile now accepts `ARG VITE_API_URL` so docker-compose can pass it via `build.args`. Default is `http://localhost:8000`.

For production deployments where frontend and backend are on different origins, update the compose `args.VITE_API_URL` to the backend's public URL before building.

## Seed Credentials

- Admin: `admin@shop.local` / `Admin123!`
- 12 products across 4 categories seeded on first boot

## Verify Health

```bash
# After docker compose up --build
curl http://localhost:8000/health
# → {"status":"ok"}

docker compose ps
# All 3 services should show "healthy" or "running"
```
