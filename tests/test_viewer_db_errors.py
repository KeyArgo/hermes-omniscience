"""Regressions for the viewer's read path: a locked database, and huge chats.

The viewer is read-only, so a writer holding the lock is normal for a moment. Before the
fix, ``list_sessions`` swallowed that error and answered ``200 []`` - the page then said
"0 conversations recorded", which is a lie a user cannot tell apart from an empty install.
"""

import sqlite3
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import db as vdb  # noqa: E402
from omniscience_viewer.app import create_app  # noqa: E402

SCHEMA = """
CREATE TABLE events (
    rowid INTEGER PRIMARY KEY,
    event_id TEXT UNIQUE NOT NULL,
    schema TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    parent_session_id TEXT,
    turn_id TEXT,
    api_request_id TEXT,
    tool_call_id TEXT,
    subagent_id TEXT,
    status TEXT,
    attrs TEXT
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""


def make_db(path, rows=1, session="s1"):
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(SCHEMA)
        for i in range(rows):
            conn.execute(
                "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
                " VALUES (?, 'omni.v1', 'boot', ?, ?, 'tool.end', ?, 'ok', '{}')",
                (f"e{i}", i, 1000.0 + i, session),
            )
        conn.execute("INSERT INTO meta VALUES ('schema_version', 'omni.v1')")
        conn.commit()
    finally:
        conn.close()
    return str(path)


def _client(db_path):
    return TestClient(create_app(str(db_path), allowed_hosts=["testserver"]))


def test_sessions_reports_a_locked_database_instead_of_zero_chats(tmp_path):
    db = make_db(tmp_path / "events.db", rows=3)
    client = _client(db)
    locker = sqlite3.connect(db, timeout=5)
    locker.execute("PRAGMA locking_mode=EXCLUSIVE")
    locker.execute("BEGIN EXCLUSIVE")
    try:
        started = time.time()
        resp = client.get("/api/v1/sessions")
        elapsed = time.time() - started
    finally:
        locker.rollback()
        locker.close()

    assert resp.status_code == 503, resp.text
    assert "locked" in resp.json()["detail"].lower(), resp.json()
    assert elapsed < 3.0, f"a locked read must fail fast, took {elapsed:.1f}s"

    # And the same call succeeds as soon as the lock is gone.
    assert client.get("/api/v1/sessions").status_code == 200


def test_missing_database_still_reads_as_empty(tmp_path):
    """No database is "nothing recorded yet" (the plugin creates the file), not an error."""
    client = _client(tmp_path / "nope.db")
    assert client.get("/api/v1/sessions").json() == []
    assert client.get("/api/v1/health").json()["ok"] is False


def test_event_tail_window_covers_a_huge_chat(tmp_path):
    """A 3000-event chat is served as its newest 2000, ascending, and pages backwards."""
    db = make_db(tmp_path / "events.db", rows=3000)
    client = _client(db)

    body = client.get("/api/v1/events", params={"root": "s1", "tail": True, "limit": 2000}).json()
    rowids = [row["rowid"] for row in body]
    assert len(rowids) == 2000
    assert rowids == list(range(1001, 3001)), "the tail window must be the newest rows, in order"

    earlier = client.get(
        "/api/v1/events",
        params={"root": "s1", "before": rowids[0], "limit": 2000},
    ).json()
    assert [row["rowid"] for row in earlier] == list(range(1, 1001))


def test_export_filename_cannot_break_out_of_its_quoted_header(tmp_path):
    """The CSV filename echoed the caller's ``root`` verbatim inside a quoted header.

    A quote in the value produced a malformed ``Content-Disposition`` (and let the caller
    choose the saved file name); a semicolon or newline would have been worse. The scope is
    now restricted to characters that need no quoting.
    """
    db = make_db(tmp_path / "events.db", rows=2)
    client = _client(db)

    for payload in ('aaaaaaa"bbb', "aaaaaaa\r\nX-Injected: yes", "aaaaaaa; filename=evil.exe"):
        resp = client.get("/api/v1/export/steps.csv", params={"root": payload})
        assert resp.status_code == 200
        disposition = resp.headers["content-disposition"]
        assert '"' not in disposition[len('attachment; filename="'):-1], disposition
        assert "injected" not in disposition.lower()
        assert disposition.endswith('.csv"'), disposition


def test_events_endpoint_reports_a_locked_database_too(tmp_path):
    """`/api/v1/events` returned 200 [] on a locked database while `/sessions` answered 503.

    An empty list renders as "this chat has no steps", which is a lie about a busy database.
    """
    db = make_db(tmp_path / "events.db", rows=3)
    client = _client(db)
    locker = sqlite3.connect(db, timeout=5)
    locker.execute("PRAGMA locking_mode=EXCLUSIVE")
    locker.execute("BEGIN EXCLUSIVE")
    try:
        resp = client.get("/api/v1/events", params={"root": "s1"})
    finally:
        locker.rollback()
        locker.close()
    assert resp.status_code == 503, resp.text
    assert "locked" in resp.json()["detail"].lower()
