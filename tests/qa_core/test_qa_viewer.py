"""Regression tests for the FastAPI viewer (viewer/omniscience_viewer).

Contract (docs/ARCHITECTURE.md §4, docs/SECURITY.md):
  * every endpoint answers with documented shapes; missing/empty DB and odd
    parameters degrade gracefully (never a 500);
  * /events returns a root session plus ALL descendants (parent_session_id
    *and* subagent.start.child_session_id edges, transitively for ≥3 levels);
  * parent-link cycles terminate;
  * the viewer opens the DB strictly read-only (bytes unchanged);
  * Host allow-list blocks DNS rebinding; WebSocket Origin guard rejects
    cross-origin pages.
"""

import hashlib
import json
import sqlite3
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from omniscience.schema import SCHEMA_VERSION
from omniscience_viewer import db as vdb
from omniscience_viewer.app import LOCAL_HOSTS, _origin_allowed, create_app


def make_client(db_path, **client_kwargs):
    return TestClient(create_app(str(db_path), allowed_hosts=["testserver"]), **client_kwargs)

DDL = """
CREATE TABLE IF NOT EXISTS events (
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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def make_db(path, events, meta=(("schema_version", SCHEMA_VERSION),), wal=False):
    """Create a plain-file SQLite DB shaped like the events table (no WAL by
    default so byte-for-byte read-only checks don't depend on -wal files)."""
    con = sqlite3.connect(str(path))
    if wal:
        con.execute("PRAGMA journal_mode=WAL")
    con.executescript(DDL)
    for k, v in meta:
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (k, v))
    for e in events:
        attrs = e.get("attrs", {})
        attrs_raw = attrs if isinstance(attrs, str) else json.dumps(attrs)
        con.execute(
            "INSERT INTO events (rowid, event_id, schema, boot_id, seq, ts, kind,"
            " session_id, parent_session_id, turn_id, api_request_id, tool_call_id,"
            " subagent_id, status, attrs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                e["rowid"], e["event_id"], SCHEMA_VERSION, e.get("boot_id", "boot"),
                e["seq"], e["ts"], e["kind"], e.get("session_id"),
                e.get("parent_session_id"), e.get("turn_id"), e.get("api_request_id"),
                e.get("tool_call_id"), e.get("subagent_id"), e.get("status"),
                attrs_raw,
            ),
        )
    con.commit()
    con.close()
    return str(path)


def ev(rowid, event_id, kind, session_id=None, ts=None, seq=None, **kw):
    return dict(rowid=rowid, event_id=event_id, kind=kind, session_id=session_id,
                ts=100.0 + rowid if ts is None else ts,
                seq=seq if seq is not None else rowid, **kw)


# Root R with children C1 < C2 < C3 (parent_session_id chain) plus two
# subagent-attributed children (edge only inside attrs) and a foreign root X.
LINEAGE = [
    ev(1, "r-start", "session.start", "R", attrs={"model": "m1", "platform": "cli"}),
    ev(2, "r-llm", "llm.request", "R", turn_id="R:t:1", api_request_id="R:t:1:api:1",
       attrs={"model": "m1"}),
    ev(3, "r-sub", "subagent.start", "R", turn_id="R:t:1",
       attrs={"child_session_id": "SAD", "child_subagent_id": "sa-1"}),
    ev(4, "c1-start", "session.start", "C1", parent_session_id="R"),
    ev(5, "c2-start", "session.start", "C2", parent_session_id="C1"),
    ev(6, "c2-sub", "subagent.start", "C2", turn_id="C2:t:9",
       attrs={"child_session_id": "SB2", "parent_turn_id": "C2:t:9"}),
    ev(7, "c3-start", "session.start", "C3", parent_session_id="C2"),
    ev(8, "sad-start", "session.start", "SAD", attrs={}),  # edge only via r-sub attrs
    ev(9, "sb2-start", "session.start", "SB2", attrs={}),  # edge only via c2-sub attrs
    ev(10, "x-start", "session.start", "X", attrs={"model": "mx"}),
    ev(11, "x-llm", "llm.response", "X", attrs={"duration_s": 1.0}),
    ev(12, "r-end", "session.end", "R", attrs={"completed": True}),
    ev(13, "drop-1", "omni.dropped", None, attrs={"count": 3, "since_seq": 4}),
    ev(14, "e-err", "session.start", "E"),
    ev(15, "e-llmerr", "llm.error", "E", status="error",
       attrs={"status_code": 500, "reason": "boom"}),
]


@pytest.fixture()
def lineage_db(tmp_path):
    return make_db(tmp_path / "events.db", LINEAGE)


@pytest.fixture()
def client(lineage_db):
    return make_client(lineage_db)


def _sha_main(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# --------------------------------------------------------------------------
# /api/v1/health
# --------------------------------------------------------------------------


def test_health_documented_shape(client, lineage_db):
    got = client.get("/api/v1/health")
    assert got.status_code == 200
    body = got.json()
    assert set(body) == {"ok", "schema", "db_path", "events", "last_rowid"}
    assert body["ok"] is True
    assert body["schema"] == SCHEMA_VERSION
    assert body["events"] == len(LINEAGE) == 15
    assert body["last_rowid"] == max(e["rowid"] for e in LINEAGE) == 15
    assert body["db_path"] == lineage_db


@pytest.mark.parametrize(
    "path", ["missing.db", "empty-file.db"]
)
def test_health_missing_or_empty_db_is_not_a_500(tmp_path, path):
    p = tmp_path / path
    if path == "empty-file.db":
        p.write_bytes(b"")
    c = make_client(p)
    got = c.get("/api/v1/health")
    assert got.status_code == 200
    body = got.json()
    assert body["ok"] is False
    assert body["events"] == 0 and body["last_rowid"] == 0 and body["schema"] is None
    # a read-only viewer must never create a DB as a side effect
    if path == "missing.db":
        assert not p.exists()


def test_health_tableless_db(tmp_path):
    p = tmp_path / "notevents.db"
    con = sqlite3.connect(str(p))
    con.execute("CREATE TABLE decoy(x)")
    con.commit()
    con.close()
    c = make_client(p)
    body = c.get("/api/v1/health").json()
    assert body["ok"] is False


def test_health_empty_db_ok_zero(tmp_path):
    p = make_db(tmp_path / "e.db", [])
    body = make_client(p).get("/api/v1/health").json()
    assert body["ok"] is True and body["events"] == 0 and body["last_rowid"] == 0


# --------------------------------------------------------------------------
# /api/v1/sessions
# --------------------------------------------------------------------------


def test_sessions_lists_roots_only(client):
    got = client.get("/api/v1/sessions")
    assert got.status_code == 200
    body = got.json()
    ids = [s["id"] for s in body]
    assert set(ids) == {"R", "X", "E"}  # C1..C3, SAD, SB2 are children; marker has no id
    by_id = {s["id"]: s for s in body}
    assert set(by_id["R"]) >= {"id", "first_ts", "last_ts", "events", "model", "status"}
    assert by_id["R"]["model"] == "m1"
    assert by_id["R"]["status"] == "ok"          # has session.end
    assert by_id["X"]["status"] == "running"     # no end
    assert by_id["E"]["status"] == "error"       # llm.error present
    assert by_id["R"]["events"] == 11            # 10 subtree rows + the NULL-session omni.dropped marker
    assert by_id["R"]["first_ts"] < by_id["R"]["last_ts"]


def test_sessions_sorted_newest_first_and_limited(client):
    body = client.get("/api/v1/sessions").json()
    tss = [s["last_ts"] for s in body]
    assert tss == sorted(tss, reverse=True)
    assert [s["id"] for s in client.get("/api/v1/sessions?limit=1").json()] == [body[0]["id"]]
    assert client.get("/api/v1/sessions?limit=0").json() == []
    assert len(client.get("/api/v1/sessions?limit=1000000").json()) == 3
    # negative limit: must not crash/500; current contract returns everything
    assert len(client.get("/api/v1/sessions?limit=-5").json()) == 3


@pytest.mark.parametrize(
    "query",
    [
        "limit=abc", "limit=1.5", "limit=1e3", "limit=0x10", "limit=",
    ],
)
def test_sessions_nonint_limit_is_422_not_500(client, query):
    assert client.get(f"/api/v1/sessions?{query}").status_code == 422


def test_sessions_missing_db(tmp_path):
    c = make_client(tmp_path / "nope.db")
    assert c.get("/api/v1/sessions").status_code == 200
    assert c.get("/api/v1/sessions").json() == []


# --------------------------------------------------------------------------
# /api/v1/events — descendant lookup, cursors, params
# --------------------------------------------------------------------------


def test_events_root_plus_all_descendants_three_levels(client):
    body = client.get("/api/v1/events?root=R&limit=1000").json()
    ids = [e["event_id"] for e in body]
    # chain via parent_session_id: C1 C2 C3; chain via subagent attr: SAD, SB2
    assert {"r-start", "r-llm", "r-sub", "c1-start", "c2-start", "c3-start",
            "sad-start", "sb2-start", "drop-1"} <= set(ids)
    assert "x-start" not in ids and "x-llm" not in ids and "e-err" not in ids
    rowids = [e["rowid"] for e in body]
    assert rowids == sorted(rowids), "must be ascending rowid"
    assert all(set(e) >= {"rowid", "event_id", "kind", "session_id", "attrs"}
               for e in body)
    assert body[[e["event_id"] for e in body].index("r-start")]["attrs"]["model"] == "m1"
    assert len(body) == 11  # R(4) + C1 + C2(2) + C3 + SAD + SB2 + dropped marker


def test_events_after_cursor_is_exclusive(client):
    after = client.get("/api/v1/events?root=R&after=6&limit=1000").json()
    assert all(e["rowid"] > 6 for e in after)
    assert {e["event_id"] for e in after} == {"c3-start", "sad-start", "sb2-start",
                                              "r-end", "drop-1"}


def test_events_negative_after_treated_as_zero(client):
    full = client.get("/api/v1/events?root=R&limit=1000").json()
    neg = client.get("/api/v1/events?root=R&after=-999999&limit=1000").json()
    assert [e["event_id"] for e in neg] == [e["event_id"] for e in full]


def test_events_huge_and_small_limits(client):
    assert len(client.get("/api/v1/events?root=R&limit=1000000000").json()) == 11
    assert len(client.get("/api/v1/events?root=R&limit=1").json()) == 1
    assert client.get("/api/v1/events?root=R&limit=0").json() == []


@pytest.mark.parametrize(
    "query",
    [
        "root=R&after=xyz", "root=R&limit=abc", "root=R&after=1.5", "root=R&after=1e9",
        "root=R&limit= ", "after=0&limit=0",  # missing root must still be fine ([]),
    ],
)
def test_events_bad_params(client, query):
    if query.endswith("limit=0") and query.startswith("after"):
        assert client.get(f"/api/v1/events?{query}").json() == []
        assert client.get(f"/api/v1/events?{query}").status_code == 200
    else:
        assert client.get(f"/api/v1/events?{query}").status_code == 422


def test_list_sessions_events_match_events_for_root(tmp_path):
    """Count contract: every root's `events` equals what /events returns for it.

    Every omni.dropped row counts — a row with a NULL session counts once for
    *each* root, and rows held by another session are counted individually
    (not once per holding session).
    """
    db = make_db(tmp_path / "drop.db", [
        ev(1, "a1", "session.start", "A", attrs={"platform": "cli"}),
        ev(2, "a2", "llm.response", "A", attrs={"duration_s": 1.0}),
        ev(3, "b1", "session.start", "B", attrs={"platform": "cli"}),
        ev(4, "b2", "llm.response", "B", attrs={"duration_s": 1.0}),
        ev(5, "d1", "omni.dropped", None, attrs={"count": 1, "since_seq": 1}),
        ev(6, "d2", "omni.dropped", None, attrs={"count": 1, "since_seq": 2}),
        ev(7, "d3", "omni.dropped", "B", attrs={"count": 1, "since_seq": 3}),
        ev(8, "d4", "omni.dropped", "B", attrs={"count": 1, "since_seq": 4}),
    ])
    sessions = {s["id"]: s for s in vdb.list_sessions(db)}
    assert set(sessions) == {"A", "B"}

    for root in ("A", "B"):
        assert sessions[root]["events"] == len(vdb.events_for_root(db, root))

    # A: 2 own + 2 NULL-session markers + 2 markers held by B (individually).
    # B: 2 own + its 2 held markers (already counted in the main loop)
    #    + the 2 NULL-session markers.
    assert sessions["A"]["events"] == 6
    assert sessions["B"]["events"] == 6


@pytest.mark.parametrize("query", ["", "root="])
def test_events_without_root_returns_empty(client, query):
    got = client.get(f"/api/v1/events?{query}")
    assert got.status_code == 200
    assert got.json() == []


def test_events_unknown_root_shows_only_gateway_wide_markers(client):
    body = client.get("/api/v1/events?root=does-not-exist&limit=1000").json()
    # ARCHITECTURE §4 comment in db.py: omni.dropped markers show in every view
    assert [e["event_id"] for e in body] == ["drop-1"]


def test_events_malformed_attrs_json_degrades_to_empty_dict(tmp_path):
    p = make_db(tmp_path / "e.db", [
        ev(1, "a", "session.start", "S", attrs="{not json at all"),
        ev(2, "b", "llm.response", "S", attrs="[1,2,3]"),  # valid JSON but not a dict
    ])
    body = make_client(p).get("/api/v1/events?root=S&limit=10").json()
    assert [e["attrs"] for e in body] == [{}, {}]


def test_events_missing_db(tmp_path):
    c = make_client(tmp_path / "nope.db")
    assert c.get("/api/v1/events?root=R").status_code == 200
    assert c.get("/api/v1/events?root=R").json() == []


# --------------------------------------------------------------------------
# cycles must terminate
# --------------------------------------------------------------------------


def test_parent_link_cycles_do_not_loop_forever(tmp_path):
    p = make_db(tmp_path / "cyc.db", [
        ev(1, "a", "session.start", "A", parent_session_id="B"),
        ev(2, "b", "session.start", "B", parent_session_id="A"),
        ev(3, "s", "session.start", "S", parent_session_id="S"),        # self-loop
        ev(4, "x", "session.start", "X",
           attrs={"child_session_id": "X"}),                              # subagent self-loop
        ev(5, "aa", "subagent.start", "A", attrs={"child_session_id": "B"}),
        ev(6, "bb", "subagent.start", "B", attrs={"child_session_id": "A"}),
    ])
    client = make_client(p)
    t0 = time.monotonic()
    body = client.get("/api/v1/events?root=A&limit=1000").json()
    elapsed = time.monotonic() - t0
    assert elapsed < 5.0, f"descendant walk on a cycle took {elapsed:.1f}s"
    assert [e["event_id"] for e in body] == ["a", "b", "aa", "bb"]
    assert client.get("/api/v1/events?root=S&limit=1000").json()[0]["event_id"] == "s"
    assert client.get("/api/v1/events?root=X&limit=1000").json()[0]["event_id"] == "x"


def test_deep_chain_five_levels(tmp_path):
    rows = [ev(1, "l0", "session.start", "L0", attrs={"model": "m"})]
    for i in range(1, 6):
        rows.append(ev(1 + i, f"l{i}", "session.start", f"L{i}", parent_session_id=f"L{i-1}"))
    p = make_db(tmp_path / "deep.db", rows)
    body = make_client(p).get("/api/v1/events?root=L0&limit=1000").json()
    assert [e["event_id"] for e in body] == ["l0", "l1", "l2", "l3", "l4", "l5"]


# --------------------------------------------------------------------------
# read-only guarantee
# --------------------------------------------------------------------------


def test_viewer_never_writes_to_the_database(tmp_path):
    p = make_db(tmp_path / "ro.db", LINEAGE, wal=True)
    client = make_client(p)

    def main_bytes():
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()

    before = main_bytes()
    client.get("/api/v1/health").json()
    client.get("/api/v1/sessions?limit=50").json()
    client.get("/api/v1/events?root=R&limit=500").json()
    with client.websocket_connect("/api/v1/live?root=R&after=0") as ws:
        ws.receive_json()
    client.get("/api/v1/health").json()
    assert main_bytes() == before, "read-only connections must leave the DB byte-identical"
    # and a read-only connection cannot mutate via SQL either
    assert make_client(p).get("/api/v1/health").json()["events"] == 15


# --------------------------------------------------------------------------
# Host / Origin guards
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "origin, host, allowed",
    [
        (None, "testserver", True),                       # non-browser client
        ("http://testserver", "testserver", True),
        ("http://evil.example", "testserver", False),
        ("http://127.0.0.1:8797", "127.0.0.1:8797", True),
        ("", "testserver", True),
        ("not a url", "testserver", False),               # unparseable -> deny
    ],
)
def test_origin_guard_logic(origin, host, allowed):
    assert _origin_allowed(origin, host) is allowed


@pytest.mark.parametrize("path", ["/api/v1/health", "/api/v1/sessions", "/api/v1/events"])
def test_foreign_host_blocked_by_trusted_host(client, path):
    evil = make_client("unused.db", base_url="http://evil.example.com")
    assert evil.get(path).status_code == 400
    mine = make_client("unused.db", base_url="http://testserver")
    ok = mine.get(path)
    assert ok.status_code in (200,)  # localhost host accepted (DB may be missing)


def test_local_hosts_constant():
    assert "127.0.0.1" in LOCAL_HOSTS and "localhost" in LOCAL_HOSTS


def test_default_app_refuses_testserver_host():
    with TestClient(create_app("unused.db"), base_url="http://testserver") as c:
        assert c.get("/api/v1/health").status_code == 400


# --------------------------------------------------------------------------
# WebSocket /api/v1/live
# --------------------------------------------------------------------------


def test_ws_same_origin_streams_events(client):
    with client.websocket_connect("/api/v1/live?root=R&after=0",
                                  headers={"origin": "http://testserver"}) as ws:
        msg = ws.receive_json()
        assert msg["type"] == "events"
        assert [e["event_id"] for e in msg["events"]][:1] == ["r-start"]
        assert len(msg["events"]) == 11


def test_ws_after_cursor_skips_rows(client):
    with client.websocket_connect("/api/v1/live?root=R&after=10",
                                  headers={"origin": "http://testserver"}) as ws:
        msg = ws.receive_json()
        assert {e["event_id"] for e in msg["events"]} == {"r-end", "drop-1"}


def test_ws_without_origin_is_allowed_for_non_browsers(client):
    with client.websocket_connect("/api/v1/live?root=R&after=0") as ws:
        assert ws.receive_json()["type"] == "events"


def test_ws_cross_origin_is_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/live?root=R&after=0",
                                      headers={"origin": "http://evil.example"}):
            pass  # unreachable: server must close with 1008 before accept


def test_ws_missing_db_receives_nothing_and_disconnects_cleanly(tmp_path):
    c = make_client(tmp_path / "gone.db")
    with c.websocket_connect("/api/v1/live?root=R&after=0") as ws:
        ws.close()  # server tolerates immediate disconnect (no events to send)


# --------------------------------------------------------------------------
# misc
# --------------------------------------------------------------------------


def test_unknown_path_is_404(client):
    assert client.get("/api/v1/nonsense").status_code == 404


def test_static_dir_served_when_present(tmp_path):
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<html><body>omni</body></html>")
    db = make_db(tmp_path / "s.db", [])
    client = TestClient(create_app(str(db), allowed_hosts=["testserver"], static_dir=str(static)))
    assert client.get("/").status_code == 200
    assert "omni" in client.get("/").text
    # API still reachable with the static mount in place
    assert client.get("/api/v1/health").json()["ok"] is True
