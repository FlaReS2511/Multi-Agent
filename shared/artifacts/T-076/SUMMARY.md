# T-076 — Notification Templates + Render Util (rev 2)

## Status: DONE (post ai-reviewer fixes)

## Files (in `web-ban-hang/backend/`)

| File | Purpose |
|------|---------|
| `app/ai/templates/order_confirm.md` | Order confirmation — header comment listing required vars |
| `app/ai/templates/shipping_update.md` | Shipping update — header comment listing required vars |
| `app/ai/templates/low_stock_alert.md` | Low-stock admin alert — header comment listing required vars |
| `app/ai/render.py` | `render_template(name, ctx) -> str` — Jinja2 hard-required, item validation |
| `tests/test_render.py` | 9 unit tests (5 original + 4 new) |

## Changes from ai-reviewer (T-080)

1. **[CRITICAL] Hard-require Jinja2** — removed `_render_simple` fallback entirely.
   `render.py` now does a direct top-level import; missing Jinja2 raises `ImportError` at module load time, not silently at render time. `{% for %}` in `order_confirm` works correctly.

2. **[MEDIUM] Item shape validation** — `_validate_items()` checks:
   - `items` is a `list`; raises `TypeError("'items' must be a list, got <type>")`
   - each element is a `dict` with keys `{name, qty, price}`; raises `TypeError("items[i] missing required field(s): [...]")`

3. **[MEDIUM] +4 test cases** (all pass):
   - `test_empty_items_list` — empty list renders cleanly
   - `test_special_chars_in_values` — Unicode / HTML / newlines in values
   - `test_malformed_item_dict_raises` — item missing `price` → TypeError with "price" in message
   - `test_items_not_a_list_raises` — string passed as items → TypeError with "list" in message

4. **[LOW] Template header comments** — each `.md` template now starts with a Jinja2 comment block listing all required variable names and types.

5. **[LOW] Docstring update** — `render_template` docstring now explicitly documents `autoescape=False` caveat ("plain-text channel only"), raises section, and items shape contract.

## Note on LLM
No LLM calls. To upgrade to Claude-generated content, replace the `env.get_template(...).render(...)` call in `render_template` with an Anthropic SDK call using the template as user prompt.

## Test Results
```
9 passed in 0.06s
```
