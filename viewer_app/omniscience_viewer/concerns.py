"""Concerns: the privacy-relevant calls and the repeated failures in a window, counted.

The Concerns page is a summary, so this module never returns one row per event. It returns groups —
"browser use, 14 times, three chats" — because a person reads the page to decide whether anything
needs attention, not to audit every call. The Privacy page is where the individual rows live.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from . import privacy

LABEL = {
    "browser": "Browser use",
    "computer": "Computer use",
    "sweep": "Wide file sweeps",
    "network": "Network calls",
    "mcp": "MCP servers",
}


def _attrs(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
            return value if isinstance(value, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _group(rows: list[dict[str, Any]], key, seed) -> list[dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = key(row)
        entry = out.get(name)
        if entry is None:
            entry = seed(row)
            entry["count"] = 0
            entry["sessions"] = set()
            out[name] = entry
        entry["count"] += 1
        if row.get("session_id"):
            entry["sessions"].add(row["session_id"])
        ts = row.get("ts")
        if isinstance(ts, (int, float)):
            entry["first_ts"] = ts if entry.get("first_ts") is None else min(entry["first_ts"], ts)
            entry["last_ts"] = ts if entry.get("last_ts") is None else max(entry["last_ts"], ts)
    items = []
    for entry in out.values():
        entry["sessions"] = len(entry["sessions"])
        items.append(entry)
    items.sort(key=lambda item: (-item["count"], -(item.get("last_ts") or 0)))
    return items


def build_concerns(db_path: str, days: float = 1, now: float | None = None) -> dict[str, Any]:
    now = now if now is not None else time.time()
    since = 0.0 if days <= 0 else now - days * 86400

    # list_runs measures its window against the wall clock; this function is given its own "now",
    # so the window is applied here too and a test can move the clock without editing the database.
    runs = [run for run in privacy.list_runs(db_path, days if days > 0 else 3650.0) if run["ts"] >= since]
    privacy_items = _group(
        runs,
        key=lambda row: row.get("cls") or "",
        seed=lambda row: {
            "kind": "privacy",
            "cls": row.get("cls"),
            "label": LABEL.get(row.get("cls") or "", row.get("label") or "Call"),
            "tone": row.get("tone", "low"),
            "tools": set(),
        },
    )
    # Collect the tools per class without carrying sets into JSON.
    tools_by_class: dict[str, set[str]] = {}
    for run in runs:
        tools_by_class.setdefault(run.get("cls") or "", set()).add(run.get("tool") or "")
    for item in privacy_items:
        item["tools"] = sorted(tools_by_class.get(item["cls"] or "", set()))[:4]

    failures: list[dict[str, Any]] = []
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = con.execute(
                # Only steps that ran, and only statuses that mean "this went wrong". A session
                # ending is recorded as 'completed', which is a fact about the chat, not a failure.
                "SELECT ts, kind, session_id, status, attrs FROM events "
                "WHERE ts >= ? AND status IS NOT NULL "
                "AND (kind LIKE 'tool%' OR kind LIKE 'llm%') "
                "AND status NOT IN ('ok', 'running', 'completed', 'success', 'done', 'finished', "
                "'started', 'pending', 'streaming') "
                "ORDER BY ts DESC LIMIT 4000",
                (since,),
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        rows = []

    for ts, kind, session_id, status, raw in rows:
        attrs = _attrs(raw)
        failures.append(
            {
                "ts": ts,
                "kind": kind,
                "session_id": session_id,
                "status": status,
                "tool": attrs.get("tool_name") or attrs.get("tool") or (kind.split(".")[0] if kind else ""),
                "error_type": attrs.get("error_type") or attrs.get("error") or status,
            }
        )

    failure_items = _group(
        failures,
        key=lambda row: f"{row.get('tool')}|{row.get('error_type')}",
        seed=lambda row: {
            "kind": "failure",
            "cls": "failure",
            "label": f"{row.get('tool') or 'step'} · {row.get('error_type') or row.get('status') or 'failed'}",
            "tone": "high",
            "tool": row.get("tool"),
            "error_type": row.get("error_type"),
        },
    )

    items = failure_items + privacy_items
    return {
        "days": days,
        "since": since,
        "generated_at": now,
        "items": items,
        "counts": {
            "privacy": sum(item["count"] for item in privacy_items),
            "failures": sum(item["count"] for item in failure_items),
        },
    }
