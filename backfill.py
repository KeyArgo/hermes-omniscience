"""Backfill Omniscience events from Hermes state.db (metadata only)."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import time
from typing import Any, Optional

log = logging.getLogger("omniscience")


MARKER_NAME = "backfill.done"
MARKER_MAX_AGE_S = 6 * 3600
SCHEMA = "omni.import.v1"
BOOT_ID = "import"


def _sha256_32(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:32]


def _marker_path(events_db: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(events_db)), MARKER_NAME)


def _marker_is_fresh(events_db: str) -> bool:
    p = _marker_path(events_db)
    try:
        if not os.path.exists(p):
            return False
        mtime = os.path.getmtime(p)
        return (time.time() - mtime) < MARKER_MAX_AGE_S
    except OSError:
        return False


def _write_marker(events_db: str) -> None:
    p = _marker_path(events_db)
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write(str(time.time()))
    except OSError:
        # Without the marker the import runs again next time; harmless, but never silent.
        log.debug("omniscience: could not write the history-import marker", exc_info=True)


def _open_ro(db_path: str) -> sqlite3.Connection:
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _open_rw(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10)
    conn.execute("PRAGMA busy_timeout=10000")
    conn.row_factory = sqlite3.Row
    return conn


def _events_table_exists(conn: sqlite3.Connection) -> bool:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    )
    return cur.fetchone() is not None


def _session_has_events(conn: sqlite3.Connection, session_id: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM events WHERE session_id = ? LIMIT 1", (session_id,)
    )
    return cur.fetchone() is not None


def _first_recorded_ts(conn: sqlite3.Connection, session_id: str) -> Optional[float]:
    row = conn.execute(
        "SELECT MIN(ts) FROM events WHERE session_id = ? AND (schema IS NULL OR schema != 'omni.import.v1')",
        (session_id,),
    ).fetchone()
    return float(row[0]) if row and row[0] is not None else None


def _session_has_import(conn: sqlite3.Connection, session_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM events WHERE session_id = ? AND schema = 'omni.import.v1' LIMIT 1", (session_id,)
    ).fetchone() is not None


def _pick_sessions(
    state_conn: sqlite3.Connection,
    events_conn: sqlite3.Connection,
    max_sessions: int,
    since_days: int,
) -> list[sqlite3.Row]:
    cutoff = time.time() - since_days * 86400
    picked: list[sqlite3.Row] = []
    # Read the chat list in pages: a single ``LIMIT max_sessions * 4`` applied before the
    # already-recorded filter meant the newest few chats could hide every older one for ever
    # (they are usually the ones that already have events). Paging keeps each query bounded
    # and lets the scan reach the older chats.
    page = 200
    offset = 0
    while len(picked) < max_sessions:
        rows = state_conn.execute(
            """
            SELECT id, source, model, parent_session_id, started_at, ended_at,
                   end_reason
            FROM sessions
            WHERE started_at >= ?
            ORDER BY started_at DESC
            LIMIT ? OFFSET ?
            """,
            (cutoff, page, offset),
        ).fetchall()
        if not rows:
            break
        for row in rows:
            sid = row["id"]
            if sid is None:
                continue
            if _session_has_events(events_conn, sid):
                # Recorded, but maybe only from part-way through (Omniscience switched on mid-chat):
                # import the earlier part once.
                first = _first_recorded_ts(events_conn, sid)
                started = row["started_at"]
                if first is None or started is None or first - started < 5 or _session_has_import(events_conn, sid):
                    continue
            picked.append(row)
            if len(picked) >= max_sessions:
                break
        offset += page
    return picked


def _load_messages(state_conn: sqlite3.Connection, session_id: str) -> list[sqlite3.Row]:
    cur = state_conn.execute(
        """
        SELECT id, session_id, role, tool_call_id, tool_calls, tool_name,
               timestamp, token_count, finish_reason, active
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC
        """,
        (session_id,),
    )
    return list(cur)


def _parse_tool_calls(raw: Optional[str]) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        call_id = item.get("id")
        fn = item.get("function")
        name = None
        if isinstance(fn, dict):
            name = fn.get("name")
        if call_id is None or name is None:
            continue
        out.append({"id": str(call_id), "name": str(name)})
    return out


def _build_events_for_session(
    session_row: sqlite3.Row,
    messages: list[sqlite3.Row],
) -> list[dict[str, Any]]:
    session_id = str(session_row["id"])
    parent_session_id = session_row["parent_session_id"]
    model = session_row["model"]
    source = session_row["source"]
    started_at = session_row["started_at"]
    ended_at = session_row["ended_at"]
    end_reason = session_row["end_reason"]

    events: list[dict[str, Any]] = []
    counter = 0

    def add(kind: str, ts: Optional[float], attrs: dict[str, Any], **extra: Any) -> None:
        nonlocal counter
        attrs = dict(attrs)
        attrs["imported"] = True
        event_id = _sha256_32(f"import|{session_id}|{kind}|{counter}")
        rec: dict[str, Any] = {
            "event_id": event_id,
            "schema": SCHEMA,
            "boot_id": BOOT_ID,
            "seq": counter,
            "ts": ts,
            "kind": kind,
            "session_id": session_id,
            "parent_session_id": parent_session_id,
            "turn_id": None,
            "api_request_id": None,
            "tool_call_id": None,
            "subagent_id": None,
            "status": None,
            "attrs": json.dumps(attrs, sort_keys=True),
        }
        for k, v in extra.items():
            rec[k] = v
        events.append(rec)
        counter += 1

    add("session.start", started_at, {"model": model, "platform": source})

    # Index tool rows by tool_call_id for matching.
    tool_rows_by_id: dict[str, sqlite3.Row] = {}
    for m in messages:
        if m["role"] == "tool" and m["tool_call_id"] is not None:
            tool_rows_by_id[str(m["tool_call_id"])] = m

    # Determine turn boundaries: user messages start turns.
    user_indices = [i for i, m in enumerate(messages) if m["role"] == "user" and m["active"] == 1]

    # For each user message, turn ends at last message before next user message.
    for ui_pos, ui in enumerate(user_indices):
        user_msg = messages[ui]
        turn_id = f"import-{user_msg['id']}"
        turn_start_ts = user_msg["timestamp"]
        if ui_pos + 1 < len(user_indices):
            next_ui = user_indices[ui_pos + 1]
            # last message before next user message
            end_idx = next_ui - 1
        else:
            end_idx = len(messages) - 1
        turn_end_ts = messages[end_idx]["timestamp"] if end_idx >= 0 else turn_start_ts

        add("turn.start", turn_start_ts, {}, turn_id=turn_id)

        # Process messages in this turn range (ui+1 .. end_idx) for assistant/tool.
        for j in range(ui + 1, end_idx + 1):
            m = messages[j]
            if m["role"] == "assistant":
                mid = m["id"]
                api_request_id = f"import-{mid}"
                add(
                    "llm.request",
                    m["timestamp"],
                    {"model": model},
                    api_request_id=api_request_id,
                    turn_id=turn_id,
                )
                resp_attrs: dict[str, Any] = {}
                if m["token_count"] is not None:
                    resp_attrs["usage"] = {"output_tokens": m["token_count"]}
                if m["finish_reason"] is not None:
                    resp_attrs["finish_reason"] = m["finish_reason"]
                add(
                    "llm.response",
                    m["timestamp"],
                    resp_attrs,
                    api_request_id=api_request_id,
                    turn_id=turn_id,
                    status="ok",
                )
                # Tool calls from this assistant row.
                calls = _parse_tool_calls(m["tool_calls"])
                for call in calls:
                    call_id = call["id"]
                    tool_name = call["name"]
                    tool_row = tool_rows_by_id.get(call_id)
                    # No result row means the call never came back (interrupted or killed).
                    # Recording that as "ok" is a claim the data does not support.
                    status = "ok" if tool_row is not None else "interrupted"
                    tool_ts = tool_row["timestamp"] if tool_row is not None else m["timestamp"]
                    add(
                        "tool.end",
                        tool_ts,
                        {"tool_name": tool_name},
                        tool_call_id=call_id,
                        turn_id=turn_id,
                        status=status,
                    )

        add("turn.end", turn_end_ts, {}, turn_id=turn_id)

    if ended_at is not None:
        add("session.end", ended_at, {"end_reason": end_reason})

    return events


def _insert_events(events_conn: sqlite3.Connection, events: list[dict[str, Any]]) -> int:
    if not events:
        return 0
    inserted = 0
    for ev in events:
        cur = events_conn.execute(
            """
            INSERT OR IGNORE INTO events (
                event_id, schema, boot_id, seq, ts, kind, session_id,
                parent_session_id, turn_id, api_request_id, tool_call_id,
                subagent_id, status, attrs
            ) VALUES (
                :event_id, :schema, :boot_id, :seq, :ts, :kind, :session_id,
                :parent_session_id, :turn_id, :api_request_id, :tool_call_id,
                :subagent_id, :status, :attrs
            )
            """,
            ev,
        )
        inserted += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    return inserted


def backfill_from_hermes(
    events_db: str,
    state_db: str,
    *,
    max_sessions: int = 500,
    since_days: int = 30,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "sessions": 0,
        "events": 0,
        "skipped": 0,
        "reason": "ok",
    }
    try:
        if _marker_is_fresh(events_db):
            result["reason"] = "marker fresh"
            return result

        if not os.path.exists(state_db):
            result["reason"] = "no state.db"
            return result

        if not os.path.exists(events_db):
            result["reason"] = "no events db"
            return result

        events_conn = _open_rw(events_db)
        try:
            if not _events_table_exists(events_conn):
                result["reason"] = "no events table"
                return result

            state_conn = _open_ro(state_db)
            try:
                sessions = _pick_sessions(state_conn, events_conn, max_sessions, since_days)
                result["sessions"] = len(sessions)

                total_events = 0
                for srow in sessions:
                    sid = str(srow["id"])
                    messages = _load_messages(state_conn, sid)
                    first = _first_recorded_ts(events_conn, sid)
                    if first is not None:
                        # Only the part before recording began; the rest is already recorded.
                        messages = [m for m in messages if m["timestamp"] is not None and m["timestamp"] < first]
                    events = _build_events_for_session(srow, messages)
                    if first is not None:
                        events = [e for e in events if e.get("kind") != "session.end"]
                    try:
                        events_conn.execute("BEGIN")
                        n = _insert_events(events_conn, events)
                        events_conn.execute("COMMIT")
                        total_events += n
                    except sqlite3.Error:
                        try:
                            events_conn.execute("ROLLBACK")
                        except sqlite3.Error:
                            pass
                        result["skipped"] += 1

                result["events"] = total_events
            finally:
                state_conn.close()
        finally:
            events_conn.close()

        # A marker written after a failed import suppresses every retry for MARKER_MAX_AGE_S,
        # so it may only record a run that actually got its rows in. Inserts are idempotent
        # (event ids are unique), so a retry costs nothing.
        if result["skipped"] == 0 and (result["sessions"] > 0 or result["events"] > 0):
            _write_marker(events_db)

        return result
    except Exception as exc:  # noqa: BLE001 - never raise
        result["reason"] = f"error: {type(exc).__name__}: {exc}"
        return result
