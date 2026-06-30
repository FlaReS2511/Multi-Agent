#!/usr/bin/env python3
"""migrate-to-sqlite.py — one-time migration from the old file-based storage to
shared/state.db.

Imports:
  - shared/tasks.json            -> tasks table + meta.next_id
  - shared/outbox/*.md           -> messages (status=processed)
  - shared/inbox/*.md            -> messages (status=unread)
  - shared/logs/*.log usage lines -> usage table
  - shared/.secrets.json         -> secrets table

Idempotent-ish: backs up the old files into shared/.backup/<timestamp>/ first,
and skips importing into a table that already has rows (so re-running won't
duplicate). Run once after the schema lands.

Usage:  python migrate-to-sqlite.py [--root <repo-root>]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import Db  # noqa: E402

MSG_HEADER_RE = re.compile(
    r"^##\s*\[([^\]]+)\]\s+FROM:\s*(\S+)\s*\|\s*TO:\s*(\S+)\s*\|\s*TASK:\s*([^\s(]+)"
)
SUBJECT_RE = re.compile(r"^\*\*Subject:\*\*\s*(.*)$", re.IGNORECASE)
PRIORITY_RE = re.compile(r"^\*\*Priority:\*\*\s*(.*)$", re.IGNORECASE)
DEPS_RE = re.compile(r"^\*\*Deps:\*\*\s*(.*)$", re.IGNORECASE)
META_LINE_RE = re.compile(r"^\*\*\w+:\*\*")
USAGE_LINE_RE = re.compile(
    r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s+(\S+)\s+usage\s+model=(\S+)\s+"
    r"in=(\d+)\s+out=(\d+)\s+cost=\$([\d.]+)(?:\s+task=(\S+))?"
)


def backup_old_files(shared: Path, root: Path) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = shared / ".backup" / stamp
    backup_dir.mkdir(parents=True, exist_ok=True)
    for rel in ["tasks.json", ".secrets.json"]:
        src = shared / rel
        if src.exists():
            shutil.copy2(src, backup_dir / rel)
    for sub in ["inbox", "outbox", "logs"]:
        src = shared / sub
        if src.exists():
            shutil.copytree(src, backup_dir / sub, dirs_exist_ok=True)
    return backup_dir


def migrate_tasks(db: Db, shared: Path) -> int:
    existing = db.conn.execute("SELECT count(*) AS n FROM tasks").fetchone()["n"]
    if existing:
        print(f"  tasks: skip (already {existing} rows)")
        return 0
    tasks_file = shared / "tasks.json"
    if not tasks_file.exists():
        print("  tasks: no tasks.json")
        return 0
    data = json.loads(tasks_file.read_text(encoding="utf-8"))
    tasks = data.get("tasks", [])
    for t in tasks:
        db.conn.execute(
            """INSERT INTO tasks
               (id, title, owner, status, priority, deps, parent_id, children, artifact, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                t["id"],
                t.get("title", ""),
                t.get("owner", ""),
                t.get("status", "todo"),
                t.get("priority"),
                json.dumps(t.get("deps", [])),
                t.get("parent_id"),
                json.dumps(t.get("children", [])),
                t.get("artifact"),
                t.get("created_at", ""),
                t.get("updated_at", ""),
            ),
        )
    next_id = int(data.get("next_id", len(tasks) + 1))
    db.conn.execute(
        "INSERT INTO meta (key, value) VALUES ('next_id', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(next_id),),
    )
    db.conn.commit()
    print(f"  tasks: imported {len(tasks)} rows, next_id={next_id}")
    return len(tasks)


def parse_message_blocks(content: str, status: str) -> list[dict]:
    out: list[dict] = []
    blocks = re.split(r"^---\s*$", content, flags=re.MULTILINE)
    for raw in blocks:
        trimmed = raw.strip()
        if not trimmed:
            continue
        lines = trimmed.split("\n")
        header_idx = next((i for i, l in enumerate(lines) if MSG_HEADER_RE.match(l)), -1)
        if header_idx == -1:
            continue
        m = MSG_HEADER_RE.match(lines[header_idx])
        if not m:
            continue
        ts, frm, to, task_id = m.group(1), m.group(2), m.group(3), m.group(4)
        subject = priority = deps = None
        body_start = header_idx + 1
        for j in range(header_idx + 1, min(header_idx + 8, len(lines))):
            line = lines[j]
            sm = SUBJECT_RE.match(line)
            pm = PRIORITY_RE.match(line)
            dm = DEPS_RE.match(line)
            if sm:
                subject = sm.group(1).strip()
            elif pm:
                priority = pm.group(1).strip()
            elif dm:
                deps = dm.group(1).strip()
            if META_LINE_RE.match(line):
                body_start = j + 1
        while body_start < len(lines) and lines[body_start].strip() == "":
            body_start += 1
        body = "\n".join(lines[body_start:]).strip()
        out.append({
            "ts": ts, "from_role": frm, "to_role": to,
            "task_id": None if task_id in ("T-000", "") else task_id,
            "subject": subject, "priority": priority, "deps": deps,
            "body": body, "status": status,
        })
    return out


def migrate_messages(db: Db, shared: Path) -> int:
    existing = db.conn.execute("SELECT count(*) AS n FROM messages").fetchone()["n"]
    if existing:
        print(f"  messages: skip (already {existing} rows)")
        return 0
    total = 0
    for sub, status in [("outbox", "processed"), ("inbox", "unread")]:
        d = shared / sub
        if not d.exists():
            continue
        for f in sorted(d.glob("*.md")):
            try:
                content = f.read_text(encoding="utf-8")
            except Exception:
                continue
            for msg in parse_message_blocks(content, status):
                db.add_message(
                    from_role=msg["from_role"], to_role=msg["to_role"],
                    body=msg["body"], task_id=msg["task_id"],
                    subject=msg["subject"], priority=msg["priority"],
                    deps=msg["deps"], status=msg["status"], ts=msg["ts"],
                )
                total += 1
    print(f"  messages: imported {total} rows")
    return total


def migrate_usage(db: Db, shared: Path) -> int:
    existing = db.conn.execute("SELECT count(*) AS n FROM usage").fetchone()["n"]
    if existing:
        print(f"  usage: skip (already {existing} rows)")
        return 0
    logs = shared / "logs"
    if not logs.exists():
        print("  usage: no logs dir")
        return 0
    total = 0
    for f in sorted(logs.glob("*.log")):
        try:
            content = f.read_text(encoding="utf-8")
        except Exception:
            continue
        for line in content.splitlines():
            m = USAGE_LINE_RE.match(line)
            if not m:
                continue
            ts, role, model, tin, tout, cost, task = m.groups()
            db.add_usage(
                role=role, model=model, tokens_in=int(tin), tokens_out=int(tout),
                cost_usd=float(cost), task_id=task, ts=ts,
            )
            total += 1
    print(f"  usage: imported {total} rows")
    return total


def migrate_secrets(db: Db, shared: Path) -> int:
    existing = db.conn.execute("SELECT count(*) AS n FROM secrets").fetchone()["n"]
    if existing:
        print(f"  secrets: skip (already {existing} rows)")
        return 0
    sf = shared / ".secrets.json"
    if not sf.exists():
        print("  secrets: no .secrets.json")
        return 0
    try:
        data = json.loads(sf.read_text(encoding="utf-8"))
    except Exception:
        print("  secrets: parse failed")
        return 0
    total = 0
    for provider, enc in data.items():
        if provider.startswith("_") or not enc:
            continue
        db.conn.execute(
            "INSERT INTO secrets (provider, enc_key) VALUES (?, ?) "
            "ON CONFLICT(provider) DO UPDATE SET enc_key = excluded.enc_key",
            (provider, enc),
        )
        total += 1
    db.conn.commit()
    print(f"  secrets: imported {total} rows")
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    args = ap.parse_args()
    root = Path(args.root).resolve()
    shared = root / "shared"

    print(f"Migrating storage under {shared}")
    backup_dir = backup_old_files(shared, root)
    print(f"  backup: {backup_dir}")

    db = Db(shared)
    try:
        migrate_tasks(db, shared)
        migrate_messages(db, shared)
        migrate_usage(db, shared)
        migrate_secrets(db, shared)
        # Verify
        n_tasks = db.conn.execute("SELECT count(*) AS n FROM tasks").fetchone()["n"]
        n_msgs = db.conn.execute("SELECT count(*) AS n FROM messages").fetchone()["n"]
        n_usage = db.conn.execute("SELECT count(*) AS n FROM usage").fetchone()["n"]
        print(f"Done. tasks={n_tasks} messages={n_msgs} usage={n_usage}")
        print(f"DB at {db.path}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
