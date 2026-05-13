# AI Review T-081 — Re-review T-076 post-fix (rev 2)

**Date:** 2026-05-13 22:07
**Verdict:** approved

## Artifacts reviewed
- `backend/app/ai/render.py`
- `backend/app/ai/templates/order_confirm.md`
- `backend/app/ai/templates/shipping_update.md`
- `backend/app/ai/templates/low_stock_alert.md`
- `backend/tests/test_render.py`

---

## Verification of T-080 action items

### #1 — Jinja2 hard-required, fallback removed ✅
`_render_simple` and the `try/except ImportError` guard are fully removed. `from jinja2 import ...` is now a top-level hard import — missing Jinja2 raises `ImportError` at module load time, which is the correct fail-fast behavior. `{% for item in items %}` in `order_confirm.md` works correctly.

### #2 — `_validate_items()` raises TypeError with field name ✅
`_validate_items` (lines 17–25) checks: (a) `items` is a list, (b) each element is a dict, (c) each dict contains `{name, qty, price}`. Error messages include the index and sorted missing field names. Called unconditionally when `"items"` is in ctx. Clear and correct.

### #3 — 4 new edge-case tests ✅
- `test_empty_items_list` — empty list renders without error ✅
- `test_special_chars_in_values` — HTML entities, Unicode, emoji, newlines in values ✅
- `test_malformed_item_dict_raises` — missing `price` → `TypeError` containing `"price"` ✅
- `test_items_not_a_list_raises` — non-list → `TypeError` containing `"list"` ✅

Note: "fallback path" test from T-080 was replaced with "non-list items" — appropriate since the fallback was removed.

### #4 — Variable contract headers in all 3 templates ✅
All three `.md` files now open with a Jinja2 comment `{# Required vars: ... #}` listing each variable and its expected type. Contract is discoverable without reading the full template body.

### #5 — `render_template` docstring documents autoescape + Raises ✅
Docstring explicitly states "Plain-text channel only — do NOT use for HTML/email body rendered in a browser. autoescape is disabled; values are inserted verbatim." Raises section lists KeyError, TypeError, and TemplateNotFound.

Minor nit (non-blocking): the Raises section says `RuntimeError: If Jinja2 is not installed` — the actual exception would be `ImportError` at module import time, not a RuntimeError at call time. The behavior is correct (fail-fast); the docstring label is slightly off. Not a blocker for approval.

---

## Findings

### Prompt design
N/A — no LLM.

### Injection / safety
`autoescape=False` is now documented. Plain-text channel constraint is explicit in the docstring. Jinja2 variable substitution remains injection-safe (ctx values are not re-parsed as template source).

### Output structure
All previous structural issues resolved. `_validate_items` provides typed schema validation with informative error messages for the one structured argument. Missing top-level vars still raise `KeyError` via `UndefinedError` wrapping — clear and correct.

### Eval coverage (9/9 samples — 5 original + 4 new)
All 9 tests pass per AIE report. Edge cases now cover the meaningful failure modes: missing top-level var, unknown template, empty list, special chars, malformed dict, non-list type.

### Caching
N/A — no LLM.

### Cost & latency
No change — pure in-process rendering, zero cost, sub-millisecond latency. Appropriate.

---

## Action items
None. The single non-blocking nit (docstring says RuntimeError instead of ImportError) does not warrant a request-changes cycle.
