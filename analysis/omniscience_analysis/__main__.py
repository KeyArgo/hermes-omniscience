"""CLI: python -m omniscience_analysis --db PATH [--root SID] -> JSON findings.

Opens the events database strictly read-only (sqlite URI mode=ro).
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import urllib.request
from dataclasses import asdict
from pathlib import Path

from .rules import Config, detect

_EVENT_COLUMNS = (
    "event_id",
    "schema",
    "boot_id",
    "seq",
    "ts",
    "kind",
    "session_id",
    "parent_session_id",
    "turn_id",
    "api_request_id",
    "tool_call_id",
    "subagent_id",
    "status",
    "attrs",
)


def load_events(db_path: str, root: str | None = None) -> list:
    """Read events from a SQLite file read-only; optional root-session filter."""
    uri = "file:" + urllib.request.pathname2url(str(Path(db_path).resolve())) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        cur = con.execute("SELECT rowid AS __rowid, * FROM events ORDER BY rowid")
        names = [d[0] for d in cur.description]
        rows = [dict(zip(names, r)) for r in cur.fetchall()]
    finally:
        con.close()

    events = []
    for row in rows:
        event = {k: row.get(k) for k in _EVENT_COLUMNS if k in row}
        event["rowid"] = row.get("__rowid")
        events.append(event)

    if root is not None:
        events = _filter_root(events, root)
    return events


def _filter_root(events: list, root: str) -> list:
    parent_of: dict = {}
    for e in events:
        sid = e.get("session_id")
        parent = e.get("parent_session_id")
        if sid and parent:
            parent_of.setdefault(sid, parent)
        if e.get("kind") == "subagent.start":
            attrs = e.get("attrs")
            if isinstance(attrs, str):
                try:
                    attrs = json.loads(attrs)
                except (ValueError, TypeError):
                    attrs = {}
            child = attrs.get("child_session_id") if isinstance(attrs, dict) else None
            if sid and child:
                parent_of.setdefault(child, sid)

    wanted = {root}
    frontier = [root]
    while frontier:
        current = frontier.pop()
        for child, parent in parent_of.items():
            if parent == current and child not in wanted:
                wanted.add(child)
                frontier.append(child)

    return [e for e in events if e.get("session_id") in wanted]


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="omniscience_analysis",
        description="Deterministic anomaly detection over omni.v1 events (read-only).",
    )
    parser.add_argument("--db", required=True, help="path to events.db")
    parser.add_argument("--root", default=None, help="restrict to this root session and descendants")
    args = parser.parse_args(argv)

    if not Path(args.db).is_file():
        print(f"error: no such file: {args.db}", file=sys.stderr)
        return 2

    try:
        events = load_events(args.db, args.root)
    except sqlite3.Error as exc:
        print(f"error: cannot read database: {exc}", file=sys.stderr)
        return 2

    findings = detect(events, Config())
    print(json.dumps([asdict(f) for f in findings], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
