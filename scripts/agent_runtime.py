#!/usr/bin/env python3
"""agent_runtime.py — runs one multi-agent role using a non-CLI backend.

Reads `agents/<role>/AGENT.md` as the system prompt, polls
`shared/inbox/<role>.md` for new messages, and dispatches each message to the
configured LLM with a Read/Write/Edit/Bash/Grep/Glob tool kit.

Backends supported (selected via shared/agents-config.json):
  api-anthropic  — Anthropic SDK
  api-google     — google-genai SDK
  api-openai     — openai SDK
  lm-studio      — openai SDK with custom base_url

Usage:  python3 agent_runtime.py --role <role>

API keys are read from env vars (ANTHROPIC_API_KEY, GOOGLE_API_KEY,
OPENAI_API_KEY). scripts/keyring.sh is responsible for exporting them
before this script starts.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
SHARED = ROOT / "shared"
AGENTS = ROOT / "agents"

POLL_INTERVAL = 2.0
MAX_TURNS = 25
BASH_TIMEOUT = 120

# USD per million tokens, (input_rate, output_rate). As of 2026-05; update when prices change.
PRICING_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-opus-4-7":    (15.00, 75.00),
    "claude-sonnet-4-6":  ( 3.00, 15.00),
    "claude-haiku-4-5":   ( 0.80,  4.00),
    "gpt-5":              ( 1.25, 10.00),
    "gpt-5-codex":        (10.00, 30.00),
    "gpt-5-mini":         ( 0.25,  2.00),
    "gemini-2.5-pro":     ( 1.25, 10.00),
    "gemini-2.5-flash":   ( 0.30,  2.50),
    "lm-studio-local":    ( 0.00,  0.00),
}


def estimate_cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    in_rate, out_rate = PRICING_USD_PER_MTOK.get(model, (0.0, 0.0))
    return (tokens_in * in_rate + tokens_out * out_rate) / 1_000_000


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def tool_read(path: str, limit: int | None = None, offset: int = 0, **_) -> str:
    p = (Path.cwd() / path).resolve()
    text = p.read_text(encoding="utf-8")
    if limit is None and offset == 0:
        return text
    lines = text.splitlines()
    if offset:
        lines = lines[offset:]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


def tool_write(path: str, content: str, **_) -> str:
    p = (Path.cwd() / path).resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"wrote {len(content)} chars to {path}"


def tool_edit(path: str, old_string: str, new_string: str,
              replace_all: bool = False, **_) -> str:
    p = (Path.cwd() / path).resolve()
    text = p.read_text(encoding="utf-8")
    if old_string not in text:
        return f"error: old_string not found in {path}"
    occurrences = text.count(old_string)
    if not replace_all and occurrences > 1:
        return (f"error: old_string occurs {occurrences} times in {path}; "
                f"add more context or set replace_all=true")
    new = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
    p.write_text(new, encoding="utf-8")
    return f"edited {path} ({occurrences if replace_all else 1} replacement(s))"


def tool_bash(command: str, **_) -> str:
    try:
        result = subprocess.run(
            command, shell=True, cwd=str(Path.cwd()),
            capture_output=True, text=True, timeout=BASH_TIMEOUT,
        )
        out = (result.stdout or "") + (result.stderr or "")
        return f"exit {result.returncode}\n{out[-4000:]}"
    except subprocess.TimeoutExpired:
        return f"error: command timed out after {BASH_TIMEOUT}s"


def tool_grep(pattern: str, path: str = ".", glob: str = "", **_) -> str:
    try:
        cmd = ["rg", "--no-heading", "-n", pattern, path]
        if glob:
            cmd += ["--glob", glob]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return (result.stdout or "no matches")[:4000]
    except FileNotFoundError:
        rx = re.compile(pattern)
        out: list[str] = []
        for fp in Path(path).rglob("*"):
            if not fp.is_file():
                continue
            try:
                for i, line in enumerate(fp.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                    if rx.search(line):
                        out.append(f"{fp}:{i}:{line}")
                        if len(out) >= 200:
                            return "\n".join(out)[:4000]
            except Exception:
                continue
        return "\n".join(out)[:4000] or "no matches"


def tool_glob(pattern: str, **_) -> str:
    matches = sorted(str(p) for p in Path.cwd().glob(pattern))
    return "\n".join(matches[:200]) or "no matches"


TOOLS = {
    "Read": tool_read, "Write": tool_write, "Edit": tool_edit,
    "Bash": tool_bash, "Grep": tool_grep, "Glob": tool_glob,
}

TOOL_SPECS = [
    {
        "name": "Read",
        "description": "Read a file. Cwd is the agent's role directory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "limit": {"type": "integer"},
                "offset": {"type": "integer"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "Write",
        "description": "Write content to a file (creates parent dirs, overwrites).",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "Edit",
        "description": "Replace old_string with new_string in path. Use replace_all=true for multi-occurrence.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    {
        "name": "Bash",
        "description": "Run a shell command in cwd with a 120s timeout. Returns exit code + last 4KB of output.",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
    {
        "name": "Grep",
        "description": "Recursively search a regex pattern under path (uses ripgrep when available).",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "glob": {"type": "string"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "Glob",
        "description": "List files matching a glob pattern relative to cwd.",
        "input_schema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}},
            "required": ["pattern"],
        },
    },
]


# ---------------------------------------------------------------------------
# Provider adapters
# ---------------------------------------------------------------------------


class AnthropicAdapter:
    def __init__(self, model: str):
        from anthropic import Anthropic
        self.client = Anthropic()
        self.model = model
        self.tools = [
            {"name": s["name"], "description": s["description"], "input_schema": s["input_schema"]}
            for s in TOOL_SPECS
        ]

    def chat(self, messages, system):
        resp = self.client.messages.create(
            model=self.model, max_tokens=8192, system=system,
            tools=self.tools, messages=messages,
        )
        text_parts: list[str] = []
        tool_calls: list[dict] = []
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append({"id": block.id, "name": block.name, "args": block.input})
        assistant_msg = {"role": "assistant", "content": [b.model_dump() for b in resp.content]}
        usage = {
            "input": getattr(resp.usage, "input_tokens", 0) or 0,
            "output": getattr(resp.usage, "output_tokens", 0) or 0,
        }
        return "\n".join(text_parts), tool_calls, assistant_msg, usage

    def tool_results_message(self, tool_calls, results):
        return {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": tc["id"], "content": str(res)}
                for tc, res in zip(tool_calls, results)
            ],
        }


class GoogleAdapter:
    def __init__(self, model: str):
        from google import genai
        from google.genai import types
        self._types = types
        self.client = genai.Client()
        self.model = model
        decls = [types.FunctionDeclaration(
            name=s["name"], description=s["description"], parameters=s["input_schema"],
        ) for s in TOOL_SPECS]
        self.tools = [types.Tool(function_declarations=decls)]

    def _to_content(self, m):
        types = self._types
        role = "user" if m["role"] == "user" else ("user" if m["role"] == "tool" else "model")
        content = m["content"]
        if isinstance(content, str):
            return types.Content(role=role, parts=[types.Part.from_text(text=content)])
        parts = []
        for item in content or []:
            kind = item.get("type") if isinstance(item, dict) else None
            if kind == "function_call":
                parts.append(types.Part.from_function_call(name=item["name"], args=item.get("args", {})))
            elif kind == "function_response":
                parts.append(types.Part.from_function_response(name=item["name"], response={"result": item.get("response", "")}))
            elif kind == "text":
                parts.append(types.Part.from_text(text=item.get("text", "")))
            else:
                parts.append(types.Part.from_text(text=str(item)))
        return types.Content(role=role, parts=parts)

    def chat(self, messages, system):
        types = self._types
        contents = [self._to_content(m) for m in messages]
        resp = self.client.models.generate_content(
            model=self.model, contents=contents,
            config=types.GenerateContentConfig(system_instruction=system, tools=self.tools),
        )
        text_parts: list[str] = []
        tool_calls: list[dict] = []
        assistant_parts: list[dict] = []
        for cand in resp.candidates or []:
            for part in cand.content.parts or []:
                fc = getattr(part, "function_call", None)
                if fc and fc.name:
                    args = dict(fc.args) if fc.args else {}
                    tc_id = f"{fc.name}_{len(tool_calls)}"
                    tool_calls.append({"id": tc_id, "name": fc.name, "args": args})
                    assistant_parts.append({"type": "function_call", "name": fc.name, "args": args})
                elif getattr(part, "text", None):
                    text_parts.append(part.text)
                    assistant_parts.append({"type": "text", "text": part.text})
        usage = {"input": 0, "output": 0}
        meta = getattr(resp, "usage_metadata", None)
        if meta is not None:
            usage["input"] = getattr(meta, "prompt_token_count", 0) or 0
            usage["output"] = getattr(meta, "candidates_token_count", 0) or 0
        return "\n".join(text_parts), tool_calls, {"role": "assistant", "content": assistant_parts}, usage

    def tool_results_message(self, tool_calls, results):
        return {
            "role": "tool",
            "content": [
                {"type": "function_response", "name": tc["name"], "response": str(res)}
                for tc, res in zip(tool_calls, results)
            ],
        }


class OpenAIAdapter:
    """Used by api-openai (real OpenAI) and lm-studio (custom base_url)."""

    def __init__(self, model: str, base_url: str | None = None):
        from openai import OpenAI
        kwargs: dict = {}
        if base_url:
            kwargs["base_url"] = base_url
            kwargs["api_key"] = os.environ.get("OPENAI_API_KEY") or "lm-studio"
        self.client = OpenAI(**kwargs)
        self.model = model
        self.tools = [
            {
                "type": "function",
                "function": {
                    "name": s["name"], "description": s["description"], "parameters": s["input_schema"],
                },
            }
            for s in TOOL_SPECS
        ]

    def chat(self, messages, system):
        msgs = [{"role": "system", "content": system}] + list(messages)
        resp = self.client.chat.completions.create(
            model=self.model, messages=msgs, tools=self.tools, tool_choice="auto",
        )
        msg = resp.choices[0].message
        tool_calls: list[dict] = []
        if msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls.append({
                    "id": tc.id, "name": tc.function.name,
                    "args": json.loads(tc.function.arguments or "{}"),
                })
        text = msg.content or ""
        assistant_msg: dict = {"role": "assistant", "content": text}
        if tool_calls:
            assistant_msg["tool_calls"] = [
                {
                    "id": tc["id"], "type": "function",
                    "function": {"name": tc["name"], "arguments": json.dumps(tc["args"])},
                }
                for tc in tool_calls
            ]
        usage = {"input": 0, "output": 0}
        if resp.usage is not None:
            usage["input"] = getattr(resp.usage, "prompt_tokens", 0) or 0
            usage["output"] = getattr(resp.usage, "completion_tokens", 0) or 0
        return text, tool_calls, assistant_msg, usage

    def tool_results_message(self, tool_calls, results):
        return [
            {"role": "tool", "tool_call_id": tc["id"], "content": str(res)}
            for tc, res in zip(tool_calls, results)
        ]


# ---------------------------------------------------------------------------
# Inbox / outbox / log
# ---------------------------------------------------------------------------


def now() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def append_log(role: str, message: str) -> None:
    log = SHARED / "logs" / f"{role}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as f:
        f.write(f"[{now()}] {role} {message}\n")


def archive_to_outbox(role: str, content: str) -> None:
    today = dt.datetime.now().strftime("%Y-%m-%d")
    outbox = SHARED / "outbox" / f"{role}-{today}.md"
    outbox.parent.mkdir(parents=True, exist_ok=True)
    with outbox.open("a", encoding="utf-8") as f:
        f.write(content.rstrip() + "\n\n")


def read_new_inbox(role: str, last_offset: int) -> tuple[str, int]:
    inbox = SHARED / "inbox" / f"{role}.md"
    if not inbox.exists():
        return "", 0
    size = inbox.stat().st_size
    if size < last_offset:
        last_offset = 0  # truncated/reset
    if size == last_offset:
        return "", last_offset
    with inbox.open("rb") as f:
        f.seek(last_offset)
        new_bytes = f.read()
    return new_bytes.decode("utf-8", errors="replace"), size


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def build_adapter(backend: dict):
    kind = backend.get("kind")
    model = backend.get("model") or ""
    if kind == "api-anthropic":
        return AnthropicAdapter(model or "claude-sonnet-4-6")
    if kind == "api-google":
        return GoogleAdapter(model or "gemini-2.5-pro")
    if kind == "api-openai":
        return OpenAIAdapter(model or "gpt-5")
    if kind == "lm-studio":
        return OpenAIAdapter(model or "lm-studio-local",
                             base_url=backend.get("base_url", "http://localhost:1234/v1"))
    raise ValueError(f"agent_runtime.py does not handle backend kind: {kind!r}")


def handle_message(role: str, adapter, system_prompt: str, message: str) -> None:
    messages: list[dict] = [{"role": "user", "content": message}]
    final_text = ""
    model = getattr(adapter, "model", "unknown")
    total_in = 0
    total_out = 0
    turns = 0
    # Extract task ID from the inbox message header so cost logs are attributable
    # per task. Empty string if message has no TASK: header.
    task_match = re.search(r"TASK:\s*(T-\d+)", message)
    task_id = task_match.group(1) if task_match else ""
    task_field = f" task={task_id}" if task_id else ""
    for _ in range(MAX_TURNS):
        text, tool_calls, assistant_msg, usage = adapter.chat(messages, system_prompt)
        turns += 1
        in_t = int(usage.get("input", 0) or 0)
        out_t = int(usage.get("output", 0) or 0)
        total_in += in_t
        total_out += out_t
        cost = estimate_cost_usd(model, in_t, out_t)
        append_log(role, f"usage model={model} in={in_t} out={out_t} cost=${cost:.4f}{task_field}")
        if text:
            final_text = text
        if not tool_calls:
            break
        results = []
        for call in tool_calls:
            fn = TOOLS.get(call["name"])
            if fn is None:
                results.append(f"error: unknown tool {call['name']}")
                continue
            try:
                results.append(fn(**call["args"]))
            except Exception as e:
                results.append(f"error: {type(e).__name__}: {e}")
            append_log(role, f"tool_call {call['name']}")
        messages.append(assistant_msg)
        result_msg = adapter.tool_results_message(tool_calls, results)
        if isinstance(result_msg, list):
            messages.extend(result_msg)
        else:
            messages.append(result_msg)
    archive_to_outbox(role, message)
    total_cost = estimate_cost_usd(model, total_in, total_out)
    append_log(role, f"message_done turns={turns} total_in={total_in} total_out={total_out} total_cost=${total_cost:.4f}{task_field}")
    if final_text:
        print(f"[{role}] response: {final_text[:240]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", required=True)
    args = ap.parse_args()
    role = args.role

    agent_dir = AGENTS / role
    if not agent_dir.exists():
        sys.exit(f"agent dir not found: {agent_dir}")
    os.chdir(agent_dir)

    cfg = json.loads((SHARED / "agents-config.json").read_text(encoding="utf-8"))
    agent_cfg = cfg["agents"].get(role)
    if not agent_cfg:
        sys.exit(f"no config for role {role}")
    backend = dict(agent_cfg.get("backend", {}))
    if "model" not in backend and agent_cfg.get("model"):
        backend["model"] = agent_cfg["model"]

    adapter = build_adapter(backend)

    agent_md = agent_dir / "AGENT.md"
    if not agent_md.exists():
        sys.exit(f"AGENT.md missing in {agent_dir}")
    system_prompt = agent_md.read_text(encoding="utf-8")

    print(f"[{role}] runtime started: backend={backend.get('kind')} model={backend.get('model')}")
    append_log(role, f"runtime_start backend={backend.get('kind')} model={backend.get('model')}")

    inbox = SHARED / "inbox" / f"{role}.md"
    last_offset = inbox.stat().st_size if inbox.exists() else 0

    try:
        while True:
            new_text, last_offset = read_new_inbox(role, last_offset)
            if not new_text.strip():
                time.sleep(POLL_INTERVAL)
                continue
            print(f"[{role}] new inbox content ({len(new_text)} chars)")
            append_log(role, f"inbox_received {len(new_text)} chars")
            try:
                handle_message(role, adapter, system_prompt, new_text)
            except Exception as e:
                print(f"[{role}] error handling message: {e}", file=sys.stderr)
                append_log(role, f"error {type(e).__name__}: {e}")
    except KeyboardInterrupt:
        print(f"\n[{role}] runtime stopped")
        append_log(role, "runtime_stop")


if __name__ == "__main__":
    main()
