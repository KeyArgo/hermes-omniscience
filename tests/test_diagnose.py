"""Tests for the "why did this run fail" diagnose() answer and its route.

Small temp DBs are built the same way tests/test_warnings_api.py builds them
(same DDL, same insert shape) so the read-only contract stays identical.
Error message TEXT is never stored (privacy design): these rows only carry
error_type / status / reason style fields.
"""

import json
import sqlite3
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "viewer"))
sys.path.insert(0, str(ROOT_DIR / "analysis"))
sys.path.insert(0, str(ROOT_DIR / "demo"))

import synth  # noqa: E402
from omniscience_viewer.app import create_app  # noqa: E402
from omniscience_viewer import diagnose  # noqa: E402

DDL = synth.DDL if hasattr(synth, "DDL") else __import__("ddl").DDL


def _make_client(db_path):
    return TestClient(create_app(str(db_path), allowed_hosts=["testserver"]))


def _write_db(path, rows):
    con = sqlite3.connect(str(path))
    try:
        con.executescript(DDL)
        con.executemany(
            "INSERT OR REPLACE INTO events(event_id,schema,boot_id,seq,ts,kind,session_id,"
            "parent_session_id,turn_id,api_request_id,tool_call_id,subagent_id,status,attrs) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        con.commit()
    finally:
        con.close()


def _row(event_id, ts, kind, session_id=None, status=None, attrs=None, seq=1):
    return (
        event_id, "omni.v1", "b1", seq, ts, kind, session_id, None, None, None, None, None,
        status, json.dumps(attrs or {}),
    )


def test_explained_first_failing_step_with_previous_ok(tmp_path):
    session = "sess-fail"
    path = tmp_path / "diag.db"
    _write_db(path, [
        _row("e-start", 1.0, "session.start", session, seq=1),
        _row("e-skill", 2.0, "tool.end", session, "ok",
             {"tool_name": "skill_view", "duration_ms": 5}, seq=2),
        _row("e-term", 3.0, "tool.end", session, "error",
             {"tool_name": "terminal", "duration_ms": 12, "error_type": "RuntimeError"}, seq=3),
    ])

    diag = diagnose.explain(str(path), session)

    assert diag["status"] == "explained"
    assert diag["failed_kind"] == "tool.end"
    assert diag["failed_tool"] == "terminal"
    assert diag["error_type"] == "RuntimeError"
    assert diag["previous_step"]["kind"] == "tool.end"
    assert diag["previous_step"]["tool"] == "skill_view"
    assert diag["previous_step"]["event_id"] == "e-skill"
    assert diag["evidence_event_ids"] == ["e-term", "e-skill"]
    assert diag["evidence_event_ids"]
    assert diag["sentence"]
    assert "terminal" in diag["sentence"]
    assert "RuntimeError" in diag["sentence"]


def test_insufficient_empty_db_or_unknown_session(tmp_path):
    empty = tmp_path / "empty.db"
    _write_db(empty, [])
    assert diagnose.explain(str(empty), "anything")["status"] == "insufficient"

    session = "sess-fail"
    filled = tmp_path / "filled.db"
    _write_db(filled, [
        _row("e-skill", 2.0, "tool.end", session, "ok",
             {"tool_name": "read_file", "duration_ms": 3}, seq=1),
    ])
    assert diagnose.explain(str(filled), "nope")["status"] == "insufficient"


def test_no_failure_when_every_step_ok(tmp_path):
    session = "sess-clean"
    rows = [
        _row("c-1", 1.0, "session.start", session, seq=1),
        _row("c-2", 2.0, "tool.end", session, "ok", {"tool_name": "read_file", "duration_ms": 4}, seq=2),
        _row("c-3", 3.0, "tool.end", session, "ok", {"tool_name": "grep", "duration_ms": 7}, seq=3),
        _row("c-4", 4.0, "session.end", session, "completed", {}, seq=4),
    ]
    path = tmp_path / "clean.db"
    _write_db(path, rows)

    diag = diagnose.explain(str(path), session)

    assert diag["status"] == "no_failure"
    assert diag["events"] == len(rows)


def test_insufficient_when_failing_step_has_no_previous_ok(tmp_path):
    session = "sess-first"
    path = tmp_path / "first.db"
    _write_db(path, [
        _row("f-1", 2.0, "tool.end", session, "error",
             {"tool_name": "terminal", "duration_ms": 9, "error_type": "TimeoutError"}, seq=1),
        _row("f-2", 3.0, "tool.end", session, "ok",
             {"tool_name": "grep", "duration_ms": 2}, seq=2),
    ])

    diag = diagnose.explain(str(path), session)

    assert diag["status"] == "insufficient"
    assert "previous_step" in diag["missing"]


def test_route_returns_same_json_and_rejects_missing_root(tmp_path):
    session = "sess-fail"
    path = tmp_path / "diag.db"
    _write_db(path, [
        _row("e-skill", 2.0, "tool.end", session, "ok",
             {"tool_name": "skill_view", "duration_ms": 5}, seq=1),
        _row("e-term", 3.0, "tool.end", session, "error",
             {"tool_name": "terminal", "duration_ms": 12, "error_type": "RuntimeError"}, seq=2),
    ])
    client = _make_client(path)

    body = client.get("/api/v1/diagnose", params={"root": session}).json()
    assert body == diagnose.explain(str(path), session)
    assert client.get("/api/v1/diagnose", params={"root": session}).status_code == 200
    assert client.get("/api/v1/diagnose").status_code == 400


def test_a_failure_after_the_first_thousand_events_is_still_found(tmp_path):
    """explain() read the FIRST 1000 events, so a long chat's failure was invisible.

    It reported "no failure" for exactly the runs worth explaining (more than 1000 steps).
    """
    import json
    import sqlite3

    from omniscience_viewer import diagnose as diag_mod

    db = tmp_path / "events.db"
    with sqlite3.connect(db) as conn:
        conn.execute(
            "create table events (rowid integer primary key, event_id text, schema text,"
            " boot_id text, seq integer, ts real, kind text, session_id text,"
            " parent_session_id text, turn_id text, api_request_id text, tool_call_id text,"
            " subagent_id text, status text, attrs text)"
        )
        rows = [(f"e{i}", "omni.v1", "b", i, 1000.0 + i, "tool.end", "chat-long", "ok", "{}")
                for i in range(1500)]
        rows.append(("bad", "omni.v1", "b", 9999, 9999.0, "tool.end", "chat-long", "error",
                     json.dumps({"tool_name": "terminal"})))
        conn.executemany(
            "insert into events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
            " values (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)

    result = diag_mod.explain(str(db), "chat-long")
    assert result["status"] == "explained", result
    assert result["failed_tool"] == "terminal"


def test_a_full_window_is_not_reported_as_no_failure(tmp_path):
    """With more events than the window, "no failure" claims more than the data shows."""
    import sqlite3

    from omniscience_viewer import diagnose as diag_mod

    db = tmp_path / "events.db"
    with sqlite3.connect(db) as conn:
        conn.execute(
            "create table events (rowid integer primary key, event_id text, schema text,"
            " boot_id text, seq integer, ts real, kind text, session_id text,"
            " parent_session_id text, turn_id text, api_request_id text, tool_call_id text,"
            " subagent_id text, status text, attrs text)"
        )
        rows = [(f"e{i}", "omni.v1", "b", i, 1000.0 + i, "tool.end", "chat-long", "ok", "{}")
                for i in range(diag_mod.DIAGNOSE_WINDOW + 500)]
        conn.executemany(
            "insert into events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
            " values (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)

    result = diag_mod.explain(str(db), "chat-long")
    assert result["status"] != "no_failure", result
