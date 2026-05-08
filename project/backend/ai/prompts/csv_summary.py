"""Prompt template for summarizing CSV data via Claude API.

Output schema:
  {
    "summary"             : str       — one sentence about dataset content/purpose,
    "row_count_in_preview": int       — data rows visible in the provided content (excl. header),
    "columns"             : list[str] — column names in original order
  }

Note: `row_count_in_preview` counts only the rows present in `csv_content`.
If the caller passes a truncated preview, this will reflect preview size, not the full file.
Callers that need the total file row count must supply it separately (out of band).
"""

from string import Template

SYSTEM_PROMPT = (
    "You are a data analyst assistant. "
    "Respond ONLY with a valid JSON object — no markdown, no code fences, no extra text. "
    "Required keys:\n"
    '  "summary"             : one concise sentence describing the dataset content and purpose.\n'
    '  "row_count_in_preview": integer — number of data rows in the CSV content provided '
    "(excluding the header row). This reflects only what is in the input, not the original file size.\n"
    '  "columns"             : array of column name strings in original order.\n'
    "If the CSV is empty or has no header, set row_count_in_preview to 0 and columns to []."
)

_USER_TEMPLATE = Template(
    "Summarize the following CSV data:\n\n```csv\n$csv_content\n```"
)


def render_user_prompt(csv_content: str) -> str:
    """Return the user turn prompt with csv_content safely interpolated.

    Pass the full CSV or a representative preview. The model counts only what it sees;
    if passing a truncated preview, document the truncation in your application layer.
    """
    return _USER_TEMPLATE.substitute(csv_content=csv_content)
