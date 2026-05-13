# T-067 — Catalog API (Product / Category / Brand + Image Upload)

## Files Added / Modified

```
web-ban-hang/backend/
├── app/
│   ├── models/
│   │   ├── __init__.py          (updated: registers Category, Brand, Product)
│   │   └── catalog.py           (NEW: Category, Brand, Product SQLAlchemy models)
│   ├── schemas/
│   │   └── catalog.py           (NEW: Create/Update/Out schemas + CategoryTree + ProductPage)
│   ├── api/v1/
│   │   ├── products.py          (NEW: 5 endpoints — list/filter/paginate + CRUD)
│   │   ├── categories.py        (NEW: 5 endpoints — tree list + CRUD)
│   │   ├── brands.py            (NEW: 5 endpoints — list + CRUD)
│   │   ├── uploads.py           (NEW: POST /uploads/image — multipart, mime+size validation)
│   │   └── router.py            (updated: includes all 4 new routers)
│   └── main.py                  (updated: StaticFiles mount at /static/uploads)
├── tests/
│   ├── test_catalog.py          (NEW: 7 tests)
│   └── test_uploads.py          (NEW: 4 tests)
```

## Endpoints (15 total)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/v1/products | No | List + filter + paginate + sort |
| GET | /api/v1/products/{id} | No | Single product |
| POST | /api/v1/products | Admin | Create product |
| PATCH | /api/v1/products/{id} | Admin | Update product |
| DELETE | /api/v1/products/{id} | Admin | Delete product |
| GET | /api/v1/categories | No | Tree of categories (nested children) |
| GET | /api/v1/categories/{id} | No | Single category |
| POST | /api/v1/categories | Admin | Create category |
| PATCH | /api/v1/categories/{id} | Admin | Update category |
| DELETE | /api/v1/categories/{id} | Admin | Delete category |
| GET | /api/v1/brands | No | List brands |
| GET | /api/v1/brands/{id} | No | Single brand |
| POST | /api/v1/brands | Admin | Create brand |
| PATCH | /api/v1/brands/{id} | Admin | Update brand |
| DELETE | /api/v1/brands/{id} | Admin | Delete brand |
| POST | /api/v1/uploads/image | Admin | Upload image → {url} |

## Product List Filters

`GET /api/v1/products?category=<id>&brand=<id>&q=<text>&min_price=<cents>&max_price=<cents>&in_stock=true&page=1&page_size=20&sort=price_asc|price_desc|newest`

## Image Upload

- Accepts: `image/jpeg`, `image/png`, `image/webp`
- Max size: 5 MB
- Saved to: `web-ban-hang/backend/uploads/<uuid>.<ext>`
- Served at: `/static/uploads/<uuid>.<ext>`
- No path traversal: UUID filename, write_bytes, no user input in path

## Design Notes

- Category tree built in Python from flat list (avoids async lazy-load issue with SQLAlchemy relationships in Pydantic)
- `require_role(Role.admin)` dep from T-066 used for all write endpoints
- Tests use `db_session` fixture to promote users to admin (avoids separate DB connection issue with in-memory SQLite)
