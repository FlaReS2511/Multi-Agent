# T-066 — FastAPI Skeleton + Auth

## File List

```
project/backend/
├── app/
│   ├── __init__.py
│   ├── main.py                  # FastAPI app, CORS middleware
│   ├── core/
│   │   ├── config.py            # Pydantic Settings (DATABASE_URL, JWT_SECRET, CORS_ORIGINS)
│   │   └── security.py          # hash_password, verify_password, create/decode JWT, oauth2_scheme
│   ├── api/
│   │   └── v1/
│   │       ├── auth.py          # /auth/register, /auth/login, /auth/me + get_current_user + require_role()
│   │       └── router.py        # APIRouter prefix /api/v1
│   ├── models/
│   │   └── user.py              # User model (id, email, hashed_password, role enum, created_at)
│   ├── schemas/
│   │   └── user.py              # UserRegister, UserLogin, UserOut, Token
│   └── db/
│       └── session.py           # async engine, AsyncSessionLocal, Base, get_db()
├── tests/
│   ├── conftest.py              # SQLite in-memory fixture, override get_db
│   └── test_auth.py             # 3 tests (register→login→me, wrong-pw, no-token)
├── requirements.txt
├── pytest.ini
└── .env.example
```

## How to Run

```bash
# 1. Copy env
cp .env.example .env
# edit DATABASE_URL / JWT_SECRET in .env

# 2. Install deps
pip install -r requirements.txt

# 3. Create DB tables (run once, or use Alembic)
python -c "
import asyncio
from app.db.session import engine, Base
import app.models  # registers models
asyncio.run(engine.begin().__aenter__().__await__())
"
# Better: use alembic for migrations in production

# 4. Start server
uvicorn app.main:app --reload

# 5. Run tests (uses SQLite in-memory, no Postgres needed)
pytest tests/ -v
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/v1/auth/register | No | Create account (returns UserOut) |
| POST | /api/v1/auth/login | No | OAuth2 password flow → JWT token |
| GET | /api/v1/auth/me | Bearer | Current user info |
| GET | /health | No | Smoke check |

## JWT Contract

- Header: `Authorization: Bearer <token>`
- Payload: `{"sub": "<user_id>", "role": "<customer|admin>", "exp": ...}`
- Algorithm: HS256, secret from `JWT_SECRET` env

## Error Shapes

```json
{"detail": "<message>"}
```

Status codes: 201 (created), 400 (bad request), 401 (unauth), 403 (forbidden), 409 (conflict), 500 (server error)

## Design Notes

- `require_role("admin")` is a FastAPI dependency factory — use as `Depends(require_role(Role.admin))`
- `get_current_user` lives in `app/api/v1/auth.py` and can be imported by downstream routers
- Tests use SQLite+aiosqlite to avoid Postgres dependency; bcrypt pinned to 4.0.1 for passlib compat
