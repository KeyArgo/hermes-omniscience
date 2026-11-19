"""The chat list is reused between requests, and only until the recording changes.

Every open page asks for the chat list every five seconds and building it reads every row, so a
few tabs kept the viewer busy for tens of seconds. These pin the reuse and, more importantly, that
a new step, a deleted chat and a different limit are never answered from a stale list.
"""

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import db as db_mod  # noqa: E402

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


def _db(tmp_path: Path):
    con = sqlite3.connect(str(tmp_path / "events.db"))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    con.execute("CREATE TABLE purged (session_id TEXT PRIMARY KEY, ts REAL)")
    return con


def _add(con, ts, kind, session):
    con.execute(
        "INSERT INTO events (ts, kind, session_id, attrs, turn_id) VALUES (?, ?, ?, ?, 't1')",
        (ts, kind, session, json.dumps({"model": "m"})),
    )
    con.commit()


def _ids(path):
    rows, error = db_mod.list_sessions_checked(str(path))
    assert error is None
    return sorted(r["id"] for r in rows)


def test_a_repeat_request_is_not_rebuilt(tmp_path, monkeypatch):
    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1")
    path = tmp_path / "events.db"
    assert _ids(path) == ["s1"]
    calls = []
    real = db_mod._list_sessions_uncached
    monkeypatch.setattr(db_mod, "_list_sessions_uncached", lambda *a, **k: calls.append(a) or real(*a, **k))
    assert _ids(path) == ["s1"]
    assert calls == []


def test_a_new_step_or_chat_is_seen_on_the_next_request(tmp_path):
    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1")
    path = tmp_path / "events.db"
    assert _ids(path) == ["s1"]
    _add(con, 2, "session.start", "s2")
    assert _ids(path) == ["s1", "s2"]
    rows, _ = db_mod.list_sessions_checked(str(path))
    events_before = next(r["events"] for r in rows if r["id"] == "s1")
    _add(con, 3, "tool.end", "s1")
    rows, _ = db_mod.list_sessions_checked(str(path))
    assert next(r["events"] for r in rows if r["id"] == "s1") == events_before + 1


def test_a_deleted_chat_disappears_on_the_next_request(tmp_path):
    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1")
    _add(con, 2, "session.start", "s2")
    path = tmp_path / "events.db"
    assert _ids(path) == ["s1", "s2"]
    con.execute("INSERT INTO purged VALUES ('s2', 3)")
    con.commit()
    assert _ids(path) == ["s1"]


def test_callers_get_their_own_copy(tmp_path):
    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1")
    path = str(tmp_path / "events.db")
    rows, _ = db_mod.list_sessions_checked(path)
    rows[0]["label"] = "changed by a caller"
    again, _ = db_mod.list_sessions_checked(path)
    assert "label" not in again[0]


def test_each_limit_is_kept_apart(tmp_path):
    con = _db(tmp_path)
    for i in range(3):
        _add(con, i + 1, "session.start", f"s{i}")
    path = str(tmp_path / "events.db")
    assert len(db_mod.list_sessions_checked(path, 1)[0]) == 1
    assert len(db_mod.list_sessions_checked(path, 3)[0]) == 3


def test_a_write_that_keeps_the_counts_is_still_seen(tmp_path):
    """Deleting the newest row and inserting another can leave MAX(rowid) and COUNT(*) unchanged."""
    import os
    import time

    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1")
    _add(con, 2, "session.start", "s2")
    path = tmp_path / "events.db"
    assert _ids(path) == ["s1", "s2"]
    con.execute("DELETE FROM events WHERE session_id = 's2'")
    con.execute(
        "INSERT INTO events (rowid, ts, kind, session_id, attrs, turn_id) VALUES (2, 3, 'session.start', 's3', '{}', 't1')"
    )
    con.commit()
    # Same row count and newest rowid as before; only the file itself changed.
    future = time.time() + 5
    os.utime(path, (future, future))
    assert _ids(path) == ["s1", "s3"]
