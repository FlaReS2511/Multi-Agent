# Review T-015 — T-002 csv_summary prompt design

**Reviewer:** reviewer-agent
**Date:** 2026-05-04 14:08
**Verdict:** changes-requested

## Files reviewed
- project/backend/ai/__init__.py (empty — OK)
- project/backend/ai/prompts/__init__.py (empty — OK)
- project/backend/ai/prompts/csv_summary.py

## Findings

### Spec compliance
- [x] Prompt rõ ràng, output schema có đủ types (str, int, list[str])
- [x] JSON-only constraint: "respond ONLY with a valid JSON object — no markdown, no extra text"
- [x] Edge case empty/no-header được cover trong SYSTEM_PROMPT: "set row_count to 0 and columns to []"
- [✗] `row_count` semantic ambiguous — xem Bugs/Logic bên dưới

### Bugs / Logic
- (issue) `csv_summary.py:12,32` — **`row_count` semantic conflict:** SYSTEM_PROMPT vừa nói "When given a CSV preview" (dòng đầu) vừa yêu cầu "total number of data rows (excluding header)". Nếu caller truyền preview cắt ngắn (e.g., 50 dòng đầu của 10,000-dòng file), Claude sẽ đếm 50, không phải 10,000 — nhưng field name `row_count` ngụ ý total. Caller bị mislead.

  **Hai cách fix (chọn một):**
  1. Đổi SYSTEM_PROMPT thành "number of data rows in the provided content (excluding header)" và rename field thành `row_count_in_preview` — honest về scope.
  2. Yêu cầu caller luôn truyền full CSV, đổi param name `csv_preview` → `csv_content`.

### Tests
- No automated tests cho `render_user_prompt()` — acceptable cho scope prompt-design task.
- Đã verify thủ công: Template substitution an toàn với `{`, `}`, `$` trong CSV data (Template không re-process giá trị đã substitute).

### Security / Injection
- [x] `string.Template.substitute(csv_preview=...)` an toàn với CSV chứa `{`/`}` — không giống f-string.
- [x] CSV chứa `$` cũng an toàn — Template không xử lý `$` trong substituted value, chỉ xử lý trong template string gốc.
- [x] Không có hardcoded secret, không có API call thật.

### AI output quality notes
- JSON-only constraint đủ mạnh cho claude-sonnet-4-6. Tuy nhiên có thể gia cố thêm: "Do not wrap the JSON in markdown code fences." để phòng model mới / fine-tuned variant.
- Cache ephemeral trên SYSTEM_PROMPT: đúng strategy — SYSTEM_PROMPT static, user turn thay đổi mỗi request.
- Model claude-sonnet-4-6: phù hợp cho structured output task.

### Style / Maintainability
- Clean, minimal. Module docstring đầy đủ.
- `_USER_TEMPLATE` private (underscore) — đúng convention.

## Action items (changes-requested)
1. Giải quyết ambiguity của `row_count`: hoặc clarify trong SYSTEM_PROMPT rằng count chỉ tính rows trong content được cung cấp, hoặc rename param để đảm bảo caller truyền full CSV.
