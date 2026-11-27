import hashlib
import json
import sqlite3
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "viewer"))
sys.path.insert(0, str(ROOT_DIR / "demo"))

import synth  # noqa: E402
from omniscience_viewer.app import create_app  # noqa: E402


@pytest.fixture()
def demo_db(tmp_path):
    path = tmp_path / "events.db"
    synth.write_db(str(path), synth.build_events())
    return path


@pytest.fixture()
def client(demo_db):
    return _make_client(demo_db)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _make_client(db_path, **kwargs):
    return TestClient(create_app(str(db_path), allowed_hosts=["testserver"]), **kwargs)


def _insert_live_row(path: Path) -> None:
    con = sqlite3.connect(path)
    try:
        con.execute(
            "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, "
            "parent_session_id, turn_id, api_request_id, tool_call_id, subagent_id, "
            "status, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "test-live-row-1",
                "omni.v1",
                "test-boot",
                9999,
                time.time(),
                "tool.end",
                synth.ROOT,
                None,
                synth.T2,
                None,
                "call_live_1",
                None,
                "ok",
                json.dumps({"tool_name": "terminal", "duration_ms": 5}),
            ),
        )
        con.commit()
    finally:
        con.close()


def test_health_counts(client, demo_db):
    events = synth.build_events()
    body = client.get("/api/v1/health").json()

    assert body["ok"] is True
    assert body["schema"] == "omni.v1"
    assert body["db_path"] == str(demo_db)
    assert body["events"] == len(events)
    assert body["last_rowid"] == len(events)


def test_health_missing_db(tmp_path):
    client = _make_client(tmp_path / "nope.db")
    body = client.get("/api/v1/health").json()
    assert body["ok"] is False
    assert body["events"] == 0
    assert body["last_rowid"] == 0
    assert client.get("/api/v1/sessions").json() == []
    assert client.get("/api/v1/events", params={"root": "x"}).json() == []


def test_session_event_counts_include_descendants(client):
    """The session list's count must match /events for that root: helper-agent
    (descendant) events belong to the root, not a hidden child row."""
    body = client.get("/api/v1/sessions", params={"limit": 10}).json()
    by_id = {session["id"]: session for session in body}
    assert synth.CHILD not in by_id

    events = client.get("/api/v1/events", params={"root": synth.ROOT}).json()
    # gateway-wide omni.dropped markers carry no session id and render in every
    # view; the session count attributes them to each root as well.
    assert by_id[synth.ROOT]["events"] == len(events)
    assert by_id[synth.ROOT]["events"] > 0

    # a session with no descendants still matches exactly
    events_b = client.get("/api/v1/events", params={"root": synth.ROOT2}).json()
    assert by_id[synth.ROOT2]["events"] == len(events_b)


def test_sessions_are_roots_only(client):
    body = client.get("/api/v1/sessions", params={"limit": 10}).json()
    ids = {session["id"] for session in body}

    assert ids == {synth.ROOT, synth.ROOT2}
    assert synth.CHILD not in ids

    by_id = {session["id"]: session for session in body}
    # The failure in this fixture is an error followed by a successful retry inside the same chat,
    # so the chat's verdict is "finished": status follows the latest turn, not the worst moment.
    # tests/test_session_status.py pins both directions.
    assert by_id[synth.ROOT]["status"] == "ok"
    assert by_id[synth.ROOT2]["status"] == "ok"
    assert by_id[synth.ROOT]["model"] == synth.MODEL
    assert by_id[synth.ROOT2]["model"] == synth.MODEL_B
    assert by_id[synth.ROOT]["events"] > 0
    assert by_id[synth.ROOT]["first_ts"] <= by_id[synth.ROOT]["last_ts"]


def test_events_include_descendants(client):
    body = client.get("/api/v1/events", params={"root": synth.ROOT}).json()

    session_ids = {event["session_id"] for event in body}
    assert synth.ROOT in session_ids
    assert synth.CHILD in session_ids
    assert synth.ROOT2 not in session_ids

    rowids = [event["rowid"] for event in body]
    assert rowids == sorted(rowids)
    assert all(isinstance(event["attrs"], dict) for event in body)

    child_rows = [event for event in body if event["session_id"] == synth.CHILD]
    assert child_rows
    assert all(event["parent_session_id"] == synth.ROOT for event in child_rows)


def test_after_cursor_and_limit(client):
    all_events = client.get("/api/v1/events", params={"root": synth.ROOT}).json()
    assert len(all_events) > 5

    cursor = all_events[5]["rowid"]
    later = client.get(
        "/api/v1/events", params={"root": synth.ROOT, "after": cursor}
    ).json()
    assert later
    assert all(event["rowid"] > cursor for event in later)
    assert [event["rowid"] for event in later] == [
        event["rowid"] for event in all_events if event["rowid"] > cursor
    ]

    limited = client.get(
        "/api/v1/events", params={"root": synth.ROOT, "limit": 3}
    ).json()
    assert len(limited) == 3
    assert limited == all_events[:3]


def test_live_websocket_delivers_new_rows(demo_db):
    app = create_app(str(demo_db))
    client = _make_client(demo_db)
    existing = client.get("/api/v1/events", params={"root": synth.ROOT}).json()
    cursor = existing[-1]["rowid"]

    with client.websocket_connect(
        f"/api/v1/live?root={synth.ROOT}&after={cursor}"
    ) as websocket:
        _insert_live_row(demo_db)
        started = time.monotonic()
        message = websocket.receive_json()
        elapsed = time.monotonic() - started

    assert elapsed < 2.0
    assert message["type"] == "events"
    assert any(event["event_id"] == "test-live-row-1" for event in message["events"])
    assert all(event["rowid"] > cursor for event in message["events"])


def test_api_does_not_modify_database(demo_db):
    before = _sha(demo_db)
    with _make_client(demo_db) as client:
        client.get("/api/v1/health")
        client.get("/api/v1/sessions", params={"limit": 10})
        client.get("/api/v1/events", params={"root": synth.ROOT})
        client.get("/api/v1/events", params={"root": synth.CHILD})
    after = _sha(demo_db)

    assert before == after
    assert not Path(str(demo_db) + "-wal").exists()
    assert not Path(str(demo_db) + "-shm").exists()


def test_rejects_foreign_host_header(demo_db):
    c = TestClient(create_app(str(demo_db)), base_url="http://evil.example")
    assert c.get("/api/v1/health").status_code == 400


def test_default_app_refuses_unknown_host(demo_db):
    with TestClient(create_app(str(demo_db)), base_url="http://testserver") as c:
        assert c.get("/api/v1/health").status_code == 400
    with _make_client(demo_db) as c:
        assert c.get("/api/v1/health").status_code == 200


def test_websocket_rejects_cross_origin(client):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/live?root=x", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()


def test_drop_markers_visible_in_every_root(tmp_path):
    db = tmp_path / "d.db"
    con = sqlite3.connect(db)
    con.executescript(synth.DDL if hasattr(synth, "DDL") else __import__("ddl").DDL)
    con.execute("INSERT INTO events(event_id,schema,boot_id,seq,ts,kind,session_id,attrs) "
                "VALUES('a','omni.v1','b',1,1.0,'session.start','root','{}')")
    con.execute("INSERT INTO events(event_id,schema,boot_id,seq,ts,kind,session_id,attrs) "
                "VALUES('d','omni.v1','b',2,2.0,'omni.dropped',NULL,'{\"count\": 3}')")
    con.commit(); con.close()
    kinds = [e["kind"] for e in _make_client(db).get("/api/v1/events?root=root").json()]
    assert kinds == ["session.start", "omni.dropped"]


def test_tail_and_before_page_without_gaps(demo_db):
    from omniscience_viewer.db import events_for_root
    all_rows = events_for_root(str(demo_db), synth.ROOT)
    newest = events_for_root(str(demo_db), synth.ROOT, limit=3, tail=True)
    older = events_for_root(str(demo_db), synth.ROOT, before=newest[0]['rowid'], limit=3)
    assert newest == all_rows[-3:]
    assert older == all_rows[-6:-3]
    assert events_for_root(str(demo_db), synth.ROOT, before=1, limit=3) == []
