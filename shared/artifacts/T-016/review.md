# Review T-016 — Re-review T-002 csv_summary (post-fix)

**Reviewer:** reviewer-agent
**Date:** 2026-05-04 14:12
**Verdict:** approved

## Files reviewed
- project/backend/ai/prompts/csv_summary.py

## Findings

### Spec compliance — post-fix checklist
- [x] Ambiguity resolved: `row_count` → `row_count_in_preview` throughout, no leftover `row_count` references
- [x] `csv_preview` param → `csv_content` — no leftover old param name
- [x] SYSTEM_PROMPT: "number of data rows in the CSV content provided (excluding the header row). This reflects only what is in the input, not the original file size." — unambiguous
- [x] Module docstring schema block updated to `row_count_in_preview`; note about caller responsibility for total row count added
- [x] `render_user_prompt()` docstring documents truncation behavior for callers
- [x] Edge case: "If the CSV is empty or has no header, set row_count_in_preview to 0 and columns to []" — present

### JSON-only constraint
- [x] Now: "no markdown, no code fences, no extra text" — stronger than prior version ✓

### Safe interpolation
- [x] `Template.substitute(csv_content=csv_content)` — unchanged, safe with `{`/`}` in CSV data ✓

### Style / Maintainability
- Module docstring expanded with full schema and truncation note — clear for downstream consumers.
- No over-engineering.

## Action items
None.
