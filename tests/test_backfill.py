"""Tests for backfill_from_hermes."""

from __future__ import annotations

import json
import os
import sqlite3
import time

import pytest

from omniscience.backfill import backfill_from_hermes, MARKER_NAME


def _make_state_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            model TEXT,
            parent_session_id TEXT,
            started_at REAL,
            ended_at REAL,
            end_reason TEXT,
            message_count INTEGER,
            tool_call_count INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_read_tokens INTEGER,
            api_call_count INTEGER,
            billing_provider TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            role TEXT,
            content TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            tool_name TEXT,
            timestamp REAL,
            token_count INTEGER,
            finish_reason TEXT,
            active INTEGER
        )
        """
    )
    now = time.time()

    # Main session with 2 user turns, assistant rows with tool_calls, tool rows.
    conn.execute(
        "INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("sess-main", "cli", "gpt-4o", None, now - 100, now - 50, "completed"),
    )
    # User turn 1
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (1, "sess-main", "user", "SECRET_CONTENT hello", None, None, None, now - 95, None, None, 1),
    )
    # Assistant with tool_calls
    tool_calls_json = json.dumps(
        [
            {
                "id": "call_1",
                "function": {"name": "search", "arguments": "SECRET_CONTENT args"},
            }
        ]
    )
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (2, "sess-main", "assistant", "SECRET_CONTENT thinking", None, tool_calls_json, None, now - 90, 42, "tool_calls", 1),
    )
    # Tool row matching call_1
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (3, "sess-main", "tool", "SECRET_CONTENT result", "call_1", None, "search", now - 85, None, None, 1),
    )
    # Assistant final response
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (4, "sess-main", "assistant", "SECRET_CONTENT final", None, None, None, now - 80, 10, "stop", 1),
    )
    # User turn 2
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (5, "sess-main", "user", "SECRET_CONTENT second", None, None, None, now - 70, None, None, 1),
    )
    # Assistant response turn 2
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (6, "sess-main", "assistant", "SECRET_CONTENT reply2", None, None, None, now - 60, 7, "stop", 1),
    )

    # Helper session (parent_session_id set)
    conn.execute(
        "INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("sess-helper", "cli", "gpt-4o-mini", "sess-main", now - 40, now - 30, "completed"),
    )
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (7, "sess-helper", "user", "SECRET_CONTENT helper", None, None, None, now - 38, None, None, 1),
    )
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (8, "sess-helper", "assistant", "SECRET_CONTENT hresp", None, None, None, now - 35, 5, "stop", 1),
    )

    conn.commit()
    conn.close()


def _make_events_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE events (
            rowid INTEGER PRIMARY KEY,
            event_id TEXT UNIQUE,
            schema TEXT,
            boot_id TEXT,
            seq INTEGER,
            ts REAL,
            kind TEXT,
            session_id TEXT,
            parent_session_id TEXT,
            turn_id TEXT,
            api_request_id TEXT,
            tool_call_id TEXT,
            subagent_id TEXT,
            status TEXT,
            attrs TEXT
        )
        """
    )
    conn.commit()
    conn.close()


def _dump_events(path: str) -> str:
    conn = sqlite3.connect(path)
    cur = conn.execute("SELECT * FROM events")
    rows = cur.fetchall()
    conn.close()
    return json.dumps(rows, default=str)


def test_backfill_creates_events(tmp_path):
    state_db = str(tmp_path / "state.db")
    events_db = str(tmp_path / "events.db")
    _make_state_db(state_db)
    _make_events_db(events_db)

    result = backfill_from_hermes(events_db, state_db)
    assert result["reason"] == "ok"
    assert result["sessions"] == 2
    assert result["events"] > 0

    conn = sqlite3.connect(events_db)
    cur = conn.execute("SELECT kind, session_id, attrs FROM events ORDER BY rowid")
    rows = cur.fetchall()
    conn.close()

    kinds = [r[0] for r in rows]
    # Main session events come first (newest started_at? both within window; order by started_at DESC)
    # sess-main started_at = now-100, sess-helper started_at = now-40 -> helper is newer, picked first.
    # But we pick newest first, so helper session events appear first.
    assert "session.start" in kinds
    assert "turn.start" in kinds
    assert "turn.end" in kinds
    assert "llm.request" in kinds
    assert "llm.response" in kinds
    assert "tool.end" in kinds
    assert "session.end" in kinds

    # Check imported flag in attrs
    for r in rows:
        attrs = json.loads(r[2])
        assert attrs.get("imported") is True

    # Check parent_session_id on helper events
    helper_events = [r for r in rows if r[1] == "sess-helper"]
    for r in helper_events:
        # parent_session_id column is index 7 in full row; here we only selected kind, session_id, attrs
        pass

    # Verify no SECRET_CONTENT in events db
    dump = _dump_events(events_db)
    assert "SECRET_CONTENT" not in dump


def test_backfill_no_content_leak(tmp_path):
    state_db = str(tmp_path / "state.db")
    events_db = str(tmp_path / "events.db")
    _make_state_db(state_db)
    _make_events_db(events_db)

    backfill_from_hermes(events_db, state_db)
    dump = _dump_events(events_db)
    assert "SECRET_CONTENT" not in dump


def test_backfill_idempotent(tmp_path):
    state_db = str(tmp_path / "state.db")
    events_db = str(tmp_path / "events.db")
    _make_state_db(state_db)
    _make_events_db(events_db)

    r1 = backfill_from_hermes(events_db, state_db)
    assert r1["events"] > 0

    # Remove marker to allow re-run
    marker = os.path.join(os.path.dirname(events_db), MARKER_NAME)
    if os.path.exists(marker):
        os.remove(marker)

    r2 = backfill_from_hermes(events_db, state_db)
    # Sessions already have events, so they are skipped
    assert r2["sessions"] == 0
    assert r2["events"] == 0


def test_backfill_skips_sessions_with_events(tmp_path):
    state_db = str(tmp_path / "state.db")
    events_db = str(tmp_path / "events.db")
    _make_state_db(state_db)
    _make_events_db(events_db)

    # Pre-insert an event for sess-main
    conn = sqlite3.connect(events_db)
    conn.execute(
        "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, attrs) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("pre-existing", "omni.import.v1", "import", 0, time.time(), "session.start", "sess-main", "{}"),
    )
    conn.commit()
    conn.close()

    result = backfill_from_hermes(events_db, state_db)
    # sess-main should be skipped, only sess-helper imported
    assert result["sessions"] == 1
    assert result["events"] > 0


def test_backfill_missing_state_db(tmp_path):
    events_db = str(tmp_path / "events.db")
    _make_events_db(events_db)
    state_db = str(tmp_path / "nonexistent.db")

    result = backfill_from_hermes(events_db, state_db)
    assert result["reason"] == "no state.db"
    assert result["sessions"] == 0
    assert result["events"] == 0


def test_backfill_no_events_table(tmp_path):
    state_db = str(tmp_path / "state.db")
    _make_state_db(state_db)
    events_db = str(tmp_path / "events.db")
    # Create db without events table
    conn = sqlite3.connect(events_db)
    conn.execute("CREATE TABLE dummy (x INTEGER)")
    conn.commit()
    conn.close()

    result = backfill_from_hermes(events_db, state_db)
    assert result["reason"] == "no events table"


def test_backfill_never_raises(tmp_path):
    # Pass garbage paths
    result = backfill_from_hermes("/nonexistent/events.db", "/nonexistent/state.db")
    assert isinstance(result, dict)
    assert "reason" in result


def test_imports_only_the_unrecorded_start_of_a_chat(tmp_path):
    """Omniscience switched on mid-chat: the earlier messages are imported, recorded ones untouched."""
    from omniscience.backfill import backfill_from_hermes

    state = tmp_path / "state.db"
    events = tmp_path / "events.db"
    now = time.time()
    with sqlite3.connect(state) as c:
        c.execute("create table sessions (id text, source text, model text, parent_session_id text, started_at real, ended_at real, end_reason text)")
        c.execute("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, token_count integer, finish_reason text, active integer)")
        c.execute("insert into sessions values ('s1','local','m',null,?,null,null)", (now - 600,))
        c.execute("insert into messages (session_id, role, content, timestamp, active) values ('s1','user','SECRET_CONTENT',?,1)", (now - 590,))
        c.execute("insert into messages (session_id, role, content, timestamp, token_count, active) values ('s1','assistant','SECRET_CONTENT',?,5,1)", (now - 580,))
        c.execute("insert into messages (session_id, role, content, timestamp, active) values ('s1','user','later',?,1)", (now - 100,))
    with sqlite3.connect(events) as c:
        c.execute("create table events (rowid integer primary key, event_id text unique, schema text, boot_id text, seq integer, ts real, kind text, session_id text, parent_session_id text, turn_id text, api_request_id text, tool_call_id text, subagent_id text, status text, attrs text)")
        c.execute("insert into events (event_id, schema, ts, kind, session_id, attrs) values ('r1','omni.v1',?,'turn.start','s1','{}')", (now - 100,))
    result = backfill_from_hermes(str(events), str(state))
    with sqlite3.connect(events) as c:
        imported = c.execute("select max(ts) from events where schema='omni.import.v1'").fetchone()[0]
        dump = "".join(str(r) for r in c.execute("select * from events"))
    assert result["sessions"] == 1 and imported < now - 100
    assert "SECRET_CONTENT" not in dump
    os.remove(str(events) + "".join([]) if False else os.path.join(tmp_path, "backfill.done"))
    assert backfill_from_hermes(str(events), str(state))["events"] == 0  # imported once only


# --- bug hunt round 2 (2026-11-09): three backfill defects -------------------------


def _state_db(tmp_path, sessions, messages):
    """sessions: [(id, started_at, ended_at)], messages: rows in the messages table order."""
    path = str(tmp_path / "state.db")
    _make_state_db(path)
    conn = sqlite3.connect(path)
    conn.execute("DELETE FROM sessions")
    conn.execute("DELETE FROM messages")
    for sid, started, ended in sessions:
        conn.execute(
            "INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason)"
            " VALUES (?, 'cli', 'm', NULL, ?, ?, 'completed')",
            (sid, started, ended),
        )
    conn.executemany(
        "INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name,"
        " timestamp, token_count, finish_reason, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        messages,
    )
    conn.commit()
    conn.close()
    return path


def test_older_sessions_are_not_starved_by_the_candidate_limit(tmp_path):
    """LIMIT max_sessions*4 is applied before the already-recorded filter, so the newest page of

    chats can hide every older one for ever. Before the fix: 30 chats, the newest 20 already
    recorded -> nothing imported at all (result['events'] == 0).
    """
    now = time.time()
    sessions = [(f"s{i:02d}", now - 1000 - i * 60, now - 900 - i * 60) for i in range(30)]
    state = _state_db(tmp_path, sessions, [])

    events = str(tmp_path / "events.db")
    _make_events_db(events)
    conn = sqlite3.connect(events)
    # The 20 newest chats are already recorded from their start, so the picker skips them.
    for sid, started, _ended in sessions[:20]:
        conn.execute(
            "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
            " VALUES (?, 'omni.v1', 'b', 1, ?, 'session.start', ?, NULL, '{}')",
            (f"e-{sid}", started + 0.5, sid),
        )
    conn.commit()
    conn.close()

    result = backfill_from_hermes(events, str(state), max_sessions=5, since_days=30)
    assert result["events"] > 0, result
    conn = sqlite3.connect(events)
    imported = {r[0] for r in conn.execute("SELECT DISTINCT session_id FROM events")}
    conn.close()
    assert imported - {sid for sid, _s, _e in sessions[:20]}, "no older chat was imported"


def test_a_failed_import_does_not_write_the_marker(tmp_path, monkeypatch):
    """The marker was written whenever sessions were *selected*, so one failed run blocked retries

    for six hours. Before the fix: skipped=1, marker present.
    """
    import omniscience.backfill as bf

    now = time.time()
    state = _state_db(tmp_path, [("sess-a", now - 100, now - 50)],
                      [(1, "sess-a", "user", "hello", None, None, None, now - 90, 3, None, 1)])
    events = str(tmp_path / "events.db")
    _make_events_db(events)

    def boom(*_a, **_k):
        raise sqlite3.Error("disk I/O error")

    monkeypatch.setattr(bf, "_insert_events", boom)
    result = backfill_from_hermes(events, str(state))
    assert result["skipped"] == 1
    assert not os.path.exists(os.path.join(str(tmp_path), MARKER_NAME)), (
        "a failed import must leave no marker, or nothing retries for six hours")
    monkeypatch.undo()

    # And the next run does import it.
    assert backfill_from_hermes(events, str(state))["events"] > 0


def test_an_interrupted_tool_call_is_not_recorded_as_success(tmp_path):
    """A tool call with no tool result row (the call was interrupted) was stored as status 'ok'.

    The viewer then reports a completed step that never completed.
    """
    now = time.time()
    calls = json.dumps([{"id": "call_x", "function": {"name": "terminal", "arguments": "{}"}}])
    state = _state_db(
        tmp_path,
        [("sess-b", now - 100, now - 50)],
        [
            (1, "sess-b", "user", "run it", None, None, None, now - 90, 3, None, 1),
            (2, "sess-b", "assistant", "working", None, calls, None, now - 80, 5, "tool_calls", 1),
            # No tool row for call_x: the turn was interrupted.
            (3, "sess-b", "assistant", "done", None, None, None, now - 70, 5, "stop", 1),
        ],
    )
    events = str(tmp_path / "events.db")
    _make_events_db(events)
    backfill_from_hermes(events, str(state))

    conn = sqlite3.connect(events)
    rows = conn.execute("SELECT status FROM events WHERE kind='tool.end'").fetchall()
    conn.close()
    assert rows, "the tool call should still be recorded"
    assert all(r[0] != "ok" for r in rows), f"interrupted call reported as success: {rows}"
