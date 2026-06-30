#!/usr/bin/env python3
"""db.py — SQLite data layer for the Python agent runtime.

Mirrors project/frontend/electron/db.ts. Both the Electron main process and this
runtime open the same shared/state.db in WAL mode so they can read/write
concurrently. DB is the single source of truth (API-only; no markdown inbox).
"""

from __future__ import annotations

import json
import sqlite3
import datetime as dt
from pathlib import Path
from typing import Any, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  owner       TEXT NOT NULL,
  status      TEXT NOT NULL,
  priority    TEXT,
  deps        TEXT NOT NULL DEFAULT '[]',
  parent_id   TEXT,
  children    TEXT NOT NULL DEFAULT '[]',
  artifact    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  from_role    TEXT NOT NULL,
  to_role      TEXT NOT NULL,
  task_id      TEXT,
  subject      TEXT,
  priority     TEXT,
  deps         TEXT,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unread',
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_role, status);
CREATE INDEX IF NOT EXISTS idx_msg_task ON messages(task_id);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  role        TEXT NOT NULL,
  model       TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  task_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    TEXT NOT NULL,
  role  TEXT NOT NULL,
  line  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_role ON logs(role, id);

CREATE TABLE IF NOT EXISTS secrets (
  provider TEXT PRIMARY KEY,
  enc_key  TEXT NOT NULL
);
"""


def _now() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


class Db:
    """Thin wrapper over a sqlite3 connection to shared/state.db."""

    def __init__(self, shared_dir: Path):
        shared_dir.mkdir(parents=True, exist_ok=True)
        self.path = shared_dir / "state.db"
        self.conn = sqlite3.connect(str(self.path), timeout=5.0)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self.conn.executescript(SCHEMA)
        self._ensure_meta()

    def _ensure_meta(self) -> None:
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key = 'next_id'"
        ).fetchone()
        if row is None:
            self.conn.execute(
                "INSERT INTO meta (key, value) VALUES ('next_id', '1')"
            )
            self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ── messages ────────────────────────────────────────────────

    def unread_messages(self, role: str) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM messages WHERE to_role = ? AND status = 'unread' ORDER BY id",
            (role,),
        ).fetchall()

    def unread_count(self, role: str) -> int:
        row = self.conn.execute(
            "SELECT count(*) AS n FROM messages WHERE to_role = ? AND status = 'unread'",
            (role,),
        ).fetchone()
        return int(row["n"]) if row else 0

    def add_message(
        self,
        *,
        from_role: str,
        to_role: str,
        body: str,
        task_id: Optional[str] = None,
        subject: Optional[str] = None,
        priority: Optional[str] = None,
        deps: Optional[str] = None,
        status: str = "unread",
        ts: Optional[str] = None,
    ) -> int:
        cur = self.conn.execute(
            """INSERT INTO messages
               (ts, from_role, to_role, task_id, subject, priority, deps, body, status, processed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)""",
            (ts or _now(), from_role, to_role, task_id, subject, priority, deps, body, status),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def mark_processed(self, message_id: int, ts: Optional[str] = None) -> None:
        self.conn.execute(
            "UPDATE messages SET status = 'processed', processed_at = ? WHERE id = ?",
            (ts or _now(), message_id),
        )
        self.conn.commit()

    # ── usage ────────────────────────────────────────────────────

    def add_usage(
        self,
        *,
        role: str,
        model: Optional[str],
        tokens_in: int,
        tokens_out: int,
        cost_usd: float,
        task_id: Optional[str] = None,
        ts: Optional[str] = None,
    ) -> None:
        self.conn.execute(
            """INSERT INTO usage (ts, role, model, tokens_in, tokens_out, cost_usd, task_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (ts or _now(), role, model, tokens_in, tokens_out, cost_usd, task_id),
        )
        self.conn.commit()

    # ── tasks (read mostly; orchestrator writes via Electron IPC) ─

    def get_task(self, task_id: str) -> Optional[dict[str, Any]]:
        row = self.conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            return None
        d = dict(row)
        d["deps"] = json.loads(d.get("deps") or "[]")
        d["children"] = json.loads(d.get("children") or "[]")
        return d

    def list_tasks(self) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM tasks ORDER BY id").fetchall()
        out = []
        for row in rows:
            d = dict(row)
            d["deps"] = json.loads(d.get("deps") or "[]")
            d["children"] = json.loads(d.get("children") or "[]")
            out.append(d)
        return out

    def _next_id(self) -> int:
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key = 'next_id'"
        ).fetchone()
        return int(row["value"]) if row else 1

    def _set_next_id(self, n: int) -> None:
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES ('next_id', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(n),),
        )

    def create_task(
        self,
        *,
        title: str,
        owner: str,
        priority: str = "medium",
        deps: Optional[list[str]] = None,
        parent_id: Optional[str] = None,
    ) -> str:
        """Allocate a T-XXX id, insert the task, and wire it into a parent if
        given (HTN depth cap = 2). Returns the new task id."""
        if parent_id:
            parent = self.get_task(parent_id)
            if parent is None:
                raise ValueError(f"parent task {parent_id} not found")
            if parent.get("parent_id"):
                raise ValueError(
                    f"cannot create child of {parent_id}: depth cap = 2"
                )
        nid = self._next_id()
        task_id = f"T-{nid:03d}"
        ts = _now()
        self.conn.execute(
            """INSERT INTO tasks
               (id, title, owner, status, priority, deps, parent_id, children, artifact, created_at, updated_at)
               VALUES (?, ?, ?, 'todo', ?, ?, ?, '[]', NULL, ?, ?)""",
            (task_id, title, owner, priority, json.dumps(deps or []), parent_id, ts, ts),
        )
        self._set_next_id(nid + 1)
        if parent_id:
            parent = self.get_task(parent_id)
            children = parent["children"] + [task_id]
            self.conn.execute(
                "UPDATE tasks SET children = ?, status = 'waiting_children', updated_at = ? WHERE id = ?",
                (json.dumps(children), ts, parent_id),
            )
        self.conn.commit()
        return task_id

    def update_task_status(self, task_id: str, status: str,
                           artifact: Optional[str] = None) -> bool:
        task = self.get_task(task_id)
        if task is None:
            return False
        ts = _now()
        if artifact is not None:
            self.conn.execute(
                "UPDATE tasks SET status = ?, artifact = ?, updated_at = ? WHERE id = ?",
                (status, artifact, ts, task_id),
            )
        else:
            self.conn.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                (status, ts, task_id),
            )
        self.conn.commit()
        return True

    # ── secrets ──────────────────────────────────────────────────

    def get_secret(self, provider: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT enc_key FROM secrets WHERE provider = ?", (provider,)
        ).fetchone()
        return row["enc_key"] if row else None

    # ── logs (activity narration) ────────────────────────────────

    def add_log(self, role: str, line: str, ts: Optional[str] = None) -> None:
        self.conn.execute(
            "INSERT INTO logs (ts, role, line) VALUES (?, ?, ?)",
            (ts or _now(), role, line),
        )
        self.conn.commit()
