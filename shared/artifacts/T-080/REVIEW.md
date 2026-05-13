# AI Review T-080 — Notification Templates (order/shipping/low-stock + render util)

**Date:** 2026-05-13 22:02
**Verdict:** changes-requested

## Artifacts reviewed
- `backend/app/ai/templates/order_confirm.md`
- `backend/app/ai/templates/shipping_update.md`
- `backend/app/ai/templates/low_stock_alert.md`
- `backend/app/ai/render.py`
- `backend/tests/test_render.py`

---

## Findings

### Prompt design
N/A — pure Jinja2 templating, no LLM calls. Choice is appropriate for transactional notifications (deterministic, low-latency, zero cost per render). The module docstring notes a future Claude upgrade path, which is reasonable.

### Injection / safety
- `autoescape=False` in Jinja2 is acceptable **only** if output stays plain text / markdown. If the rendered string is ever embedded in an HTML email body, all user-supplied vars (e.g. `customer_name`, `shipping_address`, `product_name`) are potential XSS vectors. There is no documentation stating "output is plain text only." This constraint needs to be explicit.
- Jinja2 variable substitution (`{{ var }}`) does **not** allow template-injection — ctx values are not re-parsed as Jinja2 source, so this path is safe.
- The regex fallback `_render_simple` calls `str(ctx[key])` with no escaping — same risk as above if output is HTML.

### Output structure
- **Critical bug — fallback renderer breaks `order_confirm`:** `_render_simple` only handles `{{ var }}` patterns via regex. It does NOT process `{% for item in items %} ... {% endfor %}` block tags. When Jinja2 is not installed, `order_confirm.md` renders with the raw `{% for %}` / `{% endfor %}` text visible and no items expanded. The other two templates (`shipping_update`, `low_stock_alert`) have no block tags so they work fine in fallback mode.
- No type validation for structured variables. `items` in `order_confirm` must be a list of dicts with keys `name`, `qty`, `price`. Passing `items=None`, `items={}`, or dicts with missing keys produces cryptic Jinja2 errors (e.g. `jinja2.exceptions.UndefinedError: 'dict object' has no attribute 'name'`) instead of a clear schema error.

### Eval coverage (5/5 samples, happy-path only)
- `test_order_confirm_renders` — happy path ✅
- `test_shipping_update_renders` — happy path ✅
- `test_low_stock_alert_renders` — happy path ✅
- `test_missing_variable_raises` — missing top-level var ✅
- `test_unknown_template_raises` — bad template name ✅

**Missing edge cases:**
1. Empty `items` list in `order_confirm` — should render gracefully (no items section), not raise.
2. Special chars / HTML in vars (`<script>`, `"`, `&`) — should document safe/unsafe usage.
3. `items` list with malformed dicts (missing `name`/`qty`/`price`) — should raise a clear error.
4. `_render_simple` fallback path is never tested — all 5 tests run under Jinja2. The critical fallback bug (point above) is therefore invisible in CI.

### Caching
N/A — no LLM calls, no prompt caching needed.

### Cost & latency
Pure in-process string rendering. Zero external cost, sub-millisecond latency. Appropriate choice confirmed.

---

## Action items (changes-requested)

1. **`render.py:33` — `_render_simple` critical bug:** Fallback renderer silently passes for templates with `{% %}` block tags but produces broken output. Either (a) raise `RuntimeError("Jinja2 required for templates with block tags")` when the source contains `{%`, or (b) make Jinja2 a hard dependency and remove the fallback entirely.

2. **`render.py:25` — document `autoescape=False`:** Add a comment: `# Plain-text / markdown output only — do not inject rendered output into HTML without escaping.`

3. **`render.py:52` — add type validation for `items`:** Before calling `_render_with_jinja` / `_render_simple`, validate that `items` (when present) is a list of dicts containing the required keys. A small Pydantic model or a manual check with a clear `TypeError` is sufficient.

4. **`test_render.py` — add edge case tests:**
   - Empty `items=[]` in order_confirm → assert rendered without item rows, no exception.
   - Special chars in `customer_name` (e.g. `"<Alice & Bob>"`) → assert renders without raising.
   - Malformed item dict missing `name` → assert raises with informative error.
   - Test `_render_simple` directly (mock `_JINJA_AVAILABLE = False` or import the function directly) to cover fallback path.

5. **All templates — add variable contract header:** Add a comment block at the top of each `.md` file listing required variables and their types, e.g.:
   ```
   {# Variables: order_id: str, customer_name: str, items: list[{name, qty, price}], total: str, shipping_address: str #}
   ```
   This makes the contract discoverable without reading the full template.
