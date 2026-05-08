import csv
import io
from typing import Union


def parse_csv(content: Union[str, bytes], delimiter: str | None = None) -> list[dict]:
    """Parse CSV content (UTF-8) with auto-detected or explicit delimiter.

    Supports comma and tab delimiters. Returns a list of dicts keyed by header row.
    """
    if isinstance(content, bytes):
        content = content.decode("utf-8")

    if delimiter is None:
        sniffer = csv.Sniffer()
        try:
            delimiter = sniffer.sniff(content, delimiters=",\t").delimiter
        except csv.Error:
            delimiter = ","

    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
    return [dict(row) for row in reader]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_parse_csv_comma():
    data = "name,age\nAlice,30\nBob,25"
    result = parse_csv(data)
    assert result == [{"name": "Alice", "age": "30"}, {"name": "Bob", "age": "25"}]


def test_parse_csv_tab():
    data = "name\tage\nAlice\t30\nBob\t25"
    result = parse_csv(data)
    assert result == [{"name": "Alice", "age": "30"}, {"name": "Bob", "age": "25"}]


def test_parse_csv_bytes():
    data = b"name,age\nAlice,30"
    result = parse_csv(data)
    assert result == [{"name": "Alice", "age": "30"}]


def test_parse_csv_explicit_delimiter():
    data = "name,age\nAlice,30"
    result = parse_csv(data, delimiter=",")
    assert result == [{"name": "Alice", "age": "30"}]


def test_parse_csv_empty():
    result = parse_csv("name,age\n")
    assert result == []
