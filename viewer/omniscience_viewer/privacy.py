"""The privacy record: which tool runs deserve attention, and a dossier when one is flagged.

Two jobs, kept apart:

- **listing** every run that touches a person or the outside world (browser, desktop, a sweep of many
  files, a network call, an MCP server), so the strip on screen is the live view of a permanent log;
- **flagging** one of them: a self-contained file with the action, the session, the conversation
  around it and the times, so someone can investigate later without the recording still being there.

Nothing here reads or stores message text beyond what the recorder already recorded as metadata.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from typing import Any

BROWSER = re.compile(r"browser|playwright|chromium|puppeteer|selenium", re.I)
COMPUTER = re.compile(r"computer[_ -]?use|screenshot|screen_?capture|mouse_?click|key_?press|xdotool", re.I)
SWEEP = re.compile(r"(^|_|\b)grep\b|search_?files|ripgrep|glob_?search", re.I)
NETWORK = re.compile(r"web_?search|web_?extract|http|fetch|curl|wget|download", re.I)
MCP = re.compile(r"^mcp__|^mcp[.:]", re.I)

LABELS = {
    "browser": "Browser use",
    "computer": "Computer use",
    "sweep": "Wide file sweep",
    "network": "Network call",
    "mcp": "MCP server",
}
TONE = {"browser": "high", "computer": "high", "sweep": "high", "network": "low", "mcp": "low"}


def _file_count(attrs: dict[str, Any]) -> int | None:
    for key in ("files", "file_count", "files_searched", "paths_count"):
        value = attrs.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
    for key in ("paths", "files_list"):
        value = attrs.get(key)
        if isinstance(value, list):
            return len(value)
    return None


def classify(tool_name: str, attrs: dict[str, Any] | None = None) -> str | None:
    """Return the risk class of one tool run, or None when there is nothing private about it."""
    name = (tool_name or "").strip()
    if not name:
        return None
    attrs = attrs or {}
    if MCP.search(name):
        return "mcp"
    if COMPUTER.search(name):
        return "computer"
    if BROWSER.search(name):
        return "browser"
    if SWEEP.search(name):
        files = _file_count(attrs)
        if files is not None and files > 5:
            return "sweep"
        return None
    if NETWORK.search(name):
        return "network"
    return None


def _attrs(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def list_runs(db_path: str, days: float = 7) -> list[dict[str, Any]]:
    """Every privacy-relevant tool run in the window, newest first."""
    since = 0.0 if days <= 0 else time.time() - days * 86400
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return []
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(events)")}
        if not columns:
            return []
        turn_col = "turn_id" if "turn_id" in columns else "NULL AS turn_id"
        rows = con.execute(
            "SELECT event_id, ts, kind, session_id, "+turn_col+", status, attrs FROM events "
            "WHERE ts >= ? AND kind LIKE 'tool%' ORDER BY ts DESC LIMIT 5000",
            (since,),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()

    out: list[dict[str, Any]] = []
    for event_id, ts, kind, session_id, turn_id, status, raw in rows:
        attrs = _attrs(raw)
        name = str(attrs.get("tool_name") or attrs.get("tool") or attrs.get("name") or "")
        cls = classify(name, attrs)
        if not cls:
            continue
        duration = attrs.get("duration_ms")
        out.append(
            {
                "event_id": event_id,
                "ts": ts,
                "tool": name,
                "cls": cls,
                "label": LABELS[cls],
                "tone": TONE[cls],
                "session_id": session_id,
                "turn_id": turn_id,
                "status": status,
                "duration_ms": duration if isinstance(duration, (int, float)) else None,
            }
        )
    # Names last, resolved in one query: a run's chat can be renamed at any time, so the name is read
    # when the page is asked for it rather than when the step was recorded.
    # Only the store the plugin named (it sets OMNISCIENCE_STATE_DB for this process): the active
    # profile is its fact, not something to guess from ~/.hermes.
    state_db = (os.environ.get("OMNISCIENCE_STATE_DB") or "").strip()
    titles = chat_titles(state_db, {r["session_id"] for r in out if r["session_id"]}) if state_db else {}
    for run in out:
        run["chat_title"] = titles.get(run["session_id"])
    return out



def chat_titles(state_db: str, session_ids: set[str]) -> dict[str, str]:
    """Live names for the chats behind these sessions.

    Read from Hermes' own state.db at request time, never stored: a rename in the client has to show
    up on the next load, and a copy taken at record time would go stale the moment someone renames a
    chat. `title` is what the user sees; `display_name` is the fallback for sessions that predate
    titles. Anything unresolved is simply absent — the caller shows the short id instead of inventing
    a name.
    """
    if not session_ids:
        return {}
    try:
        con = sqlite3.connect("file:" + state_db + "?mode=ro", uri=True)
    except sqlite3.Error:
        return {}
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(sessions)")}
        if not columns:
            return {}
        wanted = [c for c in ("title", "display_name") if c in columns]
        if not wanted:
            return {}
        expr = "COALESCE(" + ", ".join("NULLIF(" + c + ", '')" for c in wanted) + ")"
        marks = ",".join("?" for _ in session_ids)
        rows = con.execute("SELECT id, " + expr + " FROM sessions WHERE id IN (" + marks + ")",
                           tuple(session_ids)).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        con.close()
    return {str(sid): str(name) for sid, name in rows if name}



def _flags_dir(state_dir: str) -> str:
    path = os.path.join(state_dir, "privacy-flags")
    os.makedirs(path, exist_ok=True)
    return path


def write_flag(
    db_path: str,
    state_dir: str,
    session_id: str,
    event_id: str | None = None,
    note: str = "",
    context: int = 12,
) -> dict[str, Any]:
    """Write a self-contained dossier and return its summary.

    The file carries the action, the session, the steps immediately before and after it, and the
    clock times in both forms — enough to reconstruct what happened without the recording.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(events)")}
        if not columns:
            raise ValueError("no events table")
        turn_col = "turn_id" if "turn_id" in columns else "NULL AS turn_id"
        target = None
        if event_id:
            target = con.execute(
                "SELECT event_id, ts, kind, session_id, "+turn_col+", status, attrs FROM events WHERE event_id = ?",
                (event_id,),
            ).fetchone()
        rows = con.execute(
            "SELECT event_id, ts, kind, session_id, "+turn_col+", status, attrs FROM events "
            "WHERE session_id = ? ORDER BY ts ASC",
            (session_id,),
        ).fetchall()
    finally:
        con.close()

    index = next((i for i, row in enumerate(rows) if row[0] == (target[0] if target else event_id)), None)
    if index is None:
        index = len(rows) - 1 if rows else 0
    lo = max(0, index - context)
    hi = min(len(rows), index + context + 1)
    window = [
        {
            "event_id": row[0],
            "ts": row[1],
            "at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(row[1])) if row[1] else None,
            "kind": row[2],
            "turn_id": row[4],
            "status": row[5],
            "attrs": _attrs(row[6]),
        }
        for row in rows[lo:hi]
    ]
    risky = [
        {"event_id": row[0], "ts": row[1], "tool": str(_attrs(row[6]).get("tool_name") or ""), "cls": cls}
        for row in rows
        for cls in [classify(str(_attrs(row[6]).get("tool_name") or ""), _attrs(row[6]))]
        if cls
    ]
    dossier = {
        "flagged_at": time.time(),
        "flagged_at_local": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
        "note": note,
        "session_id": session_id,
        "event_id": target[0] if target else None,
        "action": (
            {
                "event_id": target[0],
                "ts": target[1],
                "at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(target[1])) if target[1] else None,
                "kind": target[2],
                "turn_id": target[4],
                "status": target[5],
                "tool": str(_attrs(target[6]).get("tool_name") or ""),
                "attrs": _attrs(target[6]),
            }
            if target
            else None
        ),
        "session": {
            "events": len(rows),
            "first_ts": rows[0][1] if rows else None,
            "last_ts": rows[-1][1] if rows else None,
            "privacy_events": risky,
        },
        "context": window,
    }
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    safe_session = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)[:40]
    name = f"{stamp}-{safe_session}.json"
    path = os.path.join(_flags_dir(state_dir), name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(dossier, handle, indent=2, ensure_ascii=False)
    return {
        "ok": True,
        "flag": name,
        "path": path,
        "session_id": session_id,
        "event_id": target[0] if target else None,
        "privacy_events": len(risky),
        "context_steps": len(window),
    }


def list_flags(state_dir: str) -> list[dict[str, Any]]:
    directory = _flags_dir(state_dir)
    out: list[dict[str, Any]] = []
    for name in sorted(os.listdir(directory), reverse=True):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            continue
        out.append(
            {
                "file": name,
                "flagged_at": data.get("flagged_at"),
                "flagged_at_local": data.get("flagged_at_local"),
                "session_id": data.get("session_id"),
                "event_id": data.get("event_id"),
                "tool": (data.get("action") or {}).get("tool"),
                "note": data.get("note") or "",
            }
        )
    return out
