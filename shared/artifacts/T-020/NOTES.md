# T-020 — AI Prompt Templates: web-shop

## Files created

| File | Purpose |
|------|---------|
| `web-shop/ai/prompts/product_description.py` | Render prompt for product description generation |
| `web-shop/ai/prompts/customer_support.py` | System prompt + message builder for support chatbot |
| `web-shop/ai/prompts/__init__.py` | Package exports |
| `web-shop/ai/__init__.py` | Top-level exports |

## Design decisions

### product_description.py
- Uses `string.Template` (dollar-sign substitution) instead of f-strings or `.format()`.
  This makes product names containing `{` or `}` safe — no KeyError.
- `generate_description()` returns `{"system": ..., "user": ...}` so the caller passes each part
  to the Anthropic API separately (best practice: system param + messages list).
- Price formatted with `f"{price:,}".replace(",", ".")` → Vietnamese style `250.000 VND`.
- System prompt instructs Claude to return raw JSON only (no code fences), schema:
  `{title, description, bullets: [3-5]}`.

### customer_support.py
- `SYSTEM_PROMPT` hardcodes behaviour rules: Vietnamese only, no hallucination,
  out-of-scope redirect to hotline/email.
- `build_messages()` injects an optional `context` dict (catalog/order info) before
  the user's question in the user turn — keeps system prompt stable for caching.
- Messages list format matches Anthropic API exactly: `[{"role": "user", "content": "..."}]`.

### Caching note
- System prompt for customer_support is ~200 tokens — below the 1024-token cache threshold.
  If the system prompt grows (e.g. full catalog injected), add
  `cache_control: {"type": "ephemeral"}` to the last stable content block.
- Recommended model: `claude-sonnet-4-6`.

## Sample output — product_description.py

```
=== USER PROMPT ===
Tạo mô tả sản phẩm cho:
- Tên sản phẩm: Áo thun {Premium} Cotton 100%
- Danh mục: Thời trang nam
- Giá: 250.000 VND
```
Braces in product name did NOT cause KeyError — template is safe. ✓

## Sample output — customer_support.py

```json
[
  {
    "role": "user",
    "content": "=== Thông tin catalog / đơn hàng liên quan ===\nproduct: Áo thun Premium Cotton\nprice_vnd: 250.000\nstock_L: 5\n=== Hết context ===\n\nÁo thun size L còn hàng không? Giá bao nhiêu?"
  }
]
```
