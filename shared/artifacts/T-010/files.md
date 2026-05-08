# T-010 Artifacts

## Files created
- `/Users/tom/Downloads/test-web-seller/data/products.json` — 8 sản phẩm (áo, giày, túi, đồng hồ, nón)
- `/Users/tom/Downloads/test-web-seller/backend/app.py` — Flask API, port 8000
- `/Users/tom/Downloads/test-web-seller/backend/requirements.txt` — flask, flask-cors

## Endpoints
- GET /api/products — list all
- GET /api/products/<id> — single product (404 if missing)
- POST /api/cart/add {product_id, quantity} → {total_vnd}

## Run
```
cd /Users/tom/Downloads/test-web-seller && python3 backend/app.py
```
