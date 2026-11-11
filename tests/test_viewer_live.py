"""Regression tests for the /api/v1/live websocket feed.

Run from the repo root: ``pytest tests/test_viewer_live.py``.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from fastapi.testclient import TestClient  # noqa: E402

from omniscience_viewer.app import create_app  # noqa: E402
from omniscience_viewer import db as db_mod  # noqa: E402


SCHEMA = """
CREATE TABLE events (
    rowid INTEGER PRIMARY KEY,
    event_id TEXT,
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


def _make_db(tmp_path: Path) -> str:
    path = str(tmp_path / "events.db")
    con = sqlite3.connect(path)
    con.execute(SCHEMA)
    con.commit()
    con.close()
    return path


def _insert(path: str, **cols) -> int:
    allowed = {
        "event_id", "schema", "boot_id", "seq", "ts", "kind", "session_id",
        "parent_session_id", "turn_id", "api_request_id", "tool_call_id",
        "subagent_id", "status", "attrs",
    }
    names = [c for c in cols if c in allowed]
    sql = f"INSERT INTO events ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})"
    con = sqlite3.connect(path)
    try:
        cur = con.execute(sql, [cols[c] for c in names])
        con.commit()
        return int(cur.lastrowid)
    finally:
        con.close()


def _collect_messages(client: TestClient, ws_url: str, want: int, timeout: float = 5.0) -> list[dict]:
    """Open the websocket and collect *want* messages (heartbeats excluded)."""
    messages: list[dict] = []
    deadline = time.monotonic() + timeout
    with client.websocket_connect(ws_url) as ws:
        while len(messages) < want and time.monotonic() < deadline:
            try:
                msg = ws.receive_json(timeout=0.5) if hasattr(ws, "receive_json") else json.loads(ws.receive())
            except Exception:
                continue
            if msg.get("type") == "heartbeat":
                continue
            messages.append(msg)
    return messages


def test_late_helper_rows_backfilled(tmp_path):
    path = _make_db(tmp_path)
    root = "sess-root"

    # Helper's own events are written FIRST, with no link row yet.
    _insert(path, kind="llm.request", session_id="sess-child", ts=1.0,
            attrs=json.dumps({"model": "m"}))
    _insert(path, kind="llm.response", session_id="sess-child", ts=1.1)
    child_rowids = {1, 2}

    app = create_app(path)
    client = TestClient(app, base_url="http://127.0.0.1")
    url = "/api/v1/live?root=sess-root&after=0"

    # Start the feed; the link (subagent.start with child_session_id) appears
    # only afterwards, so the child rows are already <= cursor by then.
    received: list[dict] = []
    started = threading.Event()

    def run() -> None:
        with TestClient(app, base_url="http://127.0.0.1") as c:
            with c.websocket_connect(url, headers={"host": "127.0.0.1"}) as ws:
                started.set()
                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline:
                    try:
                        msg = ws.receive_json() if hasattr(ws, "receive_json") else json.loads(ws.receive())
                    except Exception:
                        break
                    if msg.get("type") == "heartbeat":
                        continue
                    received.append(msg)
                    if any(m.get("type") == "events" and
                           any(e["rowid"] in child_rowids for e in m["events"])
                           for m in received):
                        break

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert started.wait(5)

    time.sleep(0.6)  # let a couple of polls run with cursor past the child rows
    _insert(path, kind="subagent.start", session_id=root, ts=2.0,
            attrs=json.dumps({"child_session_id": "sess-child"}))

    thread.join(timeout=6.0)

    event_rows: list[int] = []
    for msg in received:
        if msg.get("type") == "events":
            event_rows.extend(e["rowid"] for e in msg["events"])
    assert 1 in event_rows and 2 in event_rows, f"child rows missing: {received}"


def test_db_error_then_recovered(tmp_path, monkeypatch):
    # This test is about the state machine, not the cadence: it breaks the database for 0.6 s,
    # which a production interval of 1.0 s may simply not sample. Poll fast so the outage is
    # always observed, and leave the shipped interval alone.
    from omniscience_viewer import app as app_mod

    monkeypatch.setattr(app_mod, "POLL_INTERVAL_S", 0.05)
    path = _make_db(tmp_path)
    root = "sess-r"
    _insert(path, kind="session.start", session_id=root, ts=1.0)

    app = create_app(path)
    client = TestClient(app, base_url="http://127.0.0.1")

    received: list[dict] = []
    started = threading.Event()

    def run() -> None:
        with TestClient(app, base_url="http://127.0.0.1") as c:
            with c.websocket_connect("/api/v1/live?root=sess-r&after=0",
                                     headers={"host": "127.0.0.1"}) as ws:
                started.set()
                saw_error = saw_recovered = False
                deadline = time.monotonic() + 10.0
                while time.monotonic() < deadline and not (saw_error and saw_recovered):
                    try:
                        msg = ws.receive_json() if hasattr(ws, "receive_json") else json.loads(ws.receive())
                    except Exception:
                        continue
                    if msg.get("type") == "heartbeat":
                        continue
                    received.append(msg)
                    saw_error = saw_error or msg.get("type") == "error"
                    saw_recovered = saw_recovered or msg.get("type") == "recovered"

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert started.wait(5)

    time.sleep(0.4)
    # Break the DB: rename it away so mode=ro opens fail.
    broken = str(path) + ".away"
    Path(path).rename(broken)

    # CHANGED (test, not implementation): the original test never restored the
    # DB, so "recovered" could never be observed -- the feed stays broken
    # forever and the assertion on "recovered" fails by construction. Restore
    # the DB shortly after breaking it so the loop can announce recovery, as
    # the task's scenario (error while broken, recovered once it works again)
    # requires a transient failure, not a permanent one.
    time.sleep(0.6)
    Path(broken).rename(path)

    thread.join(timeout=12.0)

    types = [m.get("type") for m in received]
    assert "error" in types
    assert "recovered" in types


def test_late_helper_larger_than_a_page_is_fully_backfilled(tmp_path):
    """A helper linked after the feed passed its history was silently missing from the live view.

    Two defects, both data loss for the viewer: the link row (subagent.start) never named the
    helper, so nothing asked for rows that sit before the cursor (0 of 1200 delivered), and the
    backfill query was capped at one 1000-row page with no way to read the next one.
    """
    path = _make_db(tmp_path)
    root = "sess-root"
    child = "sess-child"
    helper_rows = 1200

    # The helper's history exists before anything links it to the root.
    for i in range(helper_rows):
        _insert(path, kind="tool.end", session_id=child, ts=1.0 + i / 1000.0,
                status="ok", attrs="{}")
    # Root activity after it pushes the feed's cursor past every helper row.
    for i in range(5):
        _insert(path, kind="tool.end", session_id=root, ts=5.0 + i, status="ok", attrs="{}")

    app = create_app(path)
    url = "/api/v1/live?root=sess-root&after=0"
    received: list[dict] = []
    started = threading.Event()

    def run() -> None:
        with TestClient(app, base_url="http://127.0.0.1") as c:
            with c.websocket_connect(url, headers={"host": "127.0.0.1"}) as ws:
                started.set()
                deadline = time.monotonic() + 12.0
                while time.monotonic() < deadline:
                    try:
                        msg = ws.receive_json() if hasattr(ws, "receive_json") else json.loads(ws.receive())
                    except Exception:
                        break
                    if msg.get("type") == "heartbeat":
                        continue
                    received.append(msg)
                    rows = {e["rowid"] for m in received if m.get("type") == "events" for e in m["events"]}
                    if len(rows & set(range(1, helper_rows + 1))) >= helper_rows:
                        break

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert started.wait(5)

    time.sleep(0.8)  # let the cursor move past the helper rows
    _insert(path, kind="subagent.start", session_id=root, ts=9.0,
            attrs=json.dumps({"child_session_id": child}))

    thread.join(timeout=14.0)

    delivered = {e["rowid"] for m in received if m.get("type") == "events" for e in m["events"]}
    missing = sorted(set(range(1, helper_rows + 1)) - delivered)
    assert not missing, f"{len(missing)} helper events never reached the live view: {missing[:5]}..."


def _live_rows(app, url, want_rowids, timeout=14.0):
    """Run the live feed and return every delivered rowid, stopping once want_rowids is covered."""
    received: list[dict] = []
    started = threading.Event()

    def run() -> None:
        with TestClient(app, base_url="http://127.0.0.1") as c:
            with c.websocket_connect(url, headers={"host": "127.0.0.1"}) as ws:
                started.set()
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    try:
                        msg = ws.receive_json() if hasattr(ws, "receive_json") else json.loads(ws.receive())
                    except Exception:
                        break
                    if msg.get("type") == "heartbeat":
                        continue
                    received.append(msg)
                    got = {e["rowid"] for m in received if m.get("type") == "events" for e in m["events"]}
                    if want_rowids <= got:
                        break

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, started, received


def test_a_helper_of_a_helper_is_backfilled_too(tmp_path):
    """The backfill followed only the links in the current poll page, one level deep.

    A grandchild whose history also predates the cursor was never asked for, so a nested
    subagent's earlier events never reached the live view.
    """
    path = _make_db(tmp_path)
    root, mid, grand = "sess-root", "sess-mid", "sess-grand"
    grand_rows = list(range(1, 6))
    # The grandchild's history, and the mid helper's own rows (including its link to the
    # grandchild) - all of it exists before anything links the mid helper to the root.
    for i in range(5):
        _insert(path, kind="tool.end", session_id=grand, parent_session_id=mid,
                ts=1.0 + i / 10.0, status="ok", attrs="{}")
    mid_rows = [
        _insert(path, kind="tool.end", session_id=mid, ts=1.7, status="ok", attrs="{}"),
        _insert(path, kind="subagent.start", session_id=mid, ts=1.8,
                attrs=json.dumps({"child_session_id": grand})),
    ]
    # Root activity after it all, so every helper row sits before the cursor.
    for i in range(3):
        _insert(path, kind="tool.end", session_id=root, ts=5.0 + i, status="ok", attrs="{}")

    app = create_app(path)
    thread, started, received = _live_rows(
        app, "/api/v1/live?root=sess-root&after=0", set(grand_rows) | set(mid_rows))
    assert started.wait(5)
    time.sleep(0.8)  # let the cursor move past the helper rows
    # Only now does the root reveal the mid helper.
    _insert(path, kind="subagent.start", session_id=root, ts=9.0,
            attrs=json.dumps({"child_session_id": mid}))
    thread.join(timeout=14.0)

    delivered = {e["rowid"] for m in received if m.get("type") == "events" for e in m["events"]}
    missing = [r for r in grand_rows if r not in delivered]
    assert not missing, f"grandchild events never reached the live view: {missing}"


def test_history_is_retried_after_a_failed_backfill(tmp_path):
    """A failed backfill still marked the helper as seen, so its history was lost for ever."""
    path = _make_db(tmp_path)
    root, child = "sess-root", "sess-child"
    child_rows = [1, 2, 3]
    for i, _ in enumerate(child_rows):
        _insert(path, kind="tool.end", session_id=child, ts=1.0 + i / 10.0, status="ok", attrs="{}")
    for i in range(3):
        _insert(path, kind="tool.end", session_id=root, ts=5.0 + i, status="ok", attrs="{}")

    app = create_app(path)
    from omniscience_viewer import db as db_mod

    calls = {"n": 0}
    real = db_mod.events_for_sessions_checked

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return [], "database is locked"      # a read that lost the race, not an exception
        return real(*a, **k)

    db_mod.events_for_sessions_checked = flaky
    try:
        thread, started, received = _live_rows(
            app, "/api/v1/live?root=sess-root&after=0", set(child_rows))
        assert started.wait(5)
        time.sleep(0.8)
        _insert(path, kind="subagent.start", session_id=root, ts=9.0,
                attrs=json.dumps({"child_session_id": child}))
        thread.join(timeout=14.0)
    finally:
        db_mod.events_for_sessions_checked = real

    delivered = {e["rowid"] for m in received if m.get("type") == "events" for e in m["events"]}
    assert set(child_rows) <= delivered, f"history was never retried: {sorted(delivered)}"


def test_collect_backfill_reports_a_busy_read_instead_of_an_empty_page(tmp_path, monkeypatch):
    """`events_for_sessions` returns [] on a sqlite error, so a lock in the middle of a backfill
    looked like "this helper has no history" and the ids were marked seen for good."""
    from omniscience_viewer import app as app_mod

    monkeypatch.setattr(
        db_mod, "events_for_sessions_checked", lambda *a, **k: ([], "database is locked")
    )
    with pytest.raises(RuntimeError):
        app_mod._collect_backfill(str(tmp_path / "events.db"), ["sess-child"], 10)
