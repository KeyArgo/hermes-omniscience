"""Tests for GET /api/v1/warnings on a small real DB."""

import json
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "viewer"))
sys.path.insert(0, str(ROOT_DIR / "analysis"))
sys.path.insert(0, str(ROOT_DIR / "demo"))

import synth  # noqa: E402
from omniscience_viewer.app import create_app  # noqa: E402

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


@pytest.fixture()
def warnings_db(tmp_path):
    """Small DB: repeated tool failures + a clean session, one root each."""

    def sid(name):
        return f"sess-{name}"

    root_fail = sid("fail")
    root_clean = sid("clean")
    rows = [
        # failing session: three bash errors (repeated_tool_failure)
        _row("f-ss", 1.0, "session.start", root_fail),
        _row("f-t1", 1.5, "tool.end", root_fail, "error", {"tool_name": "bash"}, 2),
        _row("f-t2", 2.0, "tool.end", root_fail, "error", {"tool_name": "bash"}, 3),
        _row("f-t3", 2.5, "tool.end", root_fail, "error", {"tool_name": "bash"}, 4),
        _row("f-se", 3.0, "session.end", root_fail, "completed", {}, 5),
        # slow inference + token spike in the clean session? keep clean truly clean
        _row("c-ss", 1.0, "session.start", root_clean, seq=6),
        _row("c-t1", 1.5, "tool.end", root_clean, "ok", {"tool_name": "read"}, 7),
        _row("c-se", 2.0, "session.end", root_clean, "completed", {}, 8),
    ]
    path = tmp_path / "warn.db"
    _write_db(path, rows)
    return path, root_fail, root_clean


def test_warnings_endpoint_explains_rule(warnings_db):
    path, root_fail, _root_clean = warnings_db
    body = _make_client(path).get("/api/v1/warnings", params={"root": root_fail}).json()

    assert isinstance(body, list) and body
    entry = body[0]
    assert set(entry.keys()) == {
        "title", "what_happened", "what_it_means", "what_to_do", "severity", "event_ids", "session_id"
    }
    assert "bash" in entry["what_happened"]
    assert "3" in entry["what_happened"]
    assert "repeated_tool_failure" not in json.dumps(entry)
    assert entry["event_ids"] == ["f-t1", "f-t2", "f-t3"]


def test_warnings_no_warnings_root_returns_empty(warnings_db):
    path, _root_fail, root_clean = warnings_db
    body = _make_client(path).get("/api/v1/warnings", params={"root": root_clean}).json()
    assert body == []


def test_warnings_missing_root_returns_empty(warnings_db):
    path, _a, _b = warnings_db
    body = _make_client(path).get("/api/v1/warnings", params={"root": "nope"}).json()
    assert body == []


def test_warnings_missing_root_param_returns_empty(warnings_db):
    path, _a, _b = warnings_db
    body = _make_client(path).get("/api/v1/warnings").json()
    assert body == []


def test_warnings_missing_db_returns_empty_not_crash(tmp_path):
    client = _make_client(tmp_path / "nope.db")
    assert client.get("/api/v1/warnings", params={"root": "x"}).json() == []
    assert client.get("/api/v1/warnings").status_code == 200


def test_warnings_never_mutates_db(warnings_db):
    path, root_fail, root_clean = warnings_db
    before = path.read_bytes()
    client = _make_client(path)
    client.get("/api/v1/warnings", params={"root": root_fail})
    client.get("/api/v1/warnings", params={"root": root_clean})
    client.get("/api/v1/warnings")
    assert path.read_bytes() == before
    assert not Path(str(path) + "-wal").exists()
    assert not Path(str(path) + "-shm").exists()


def test_warnings_matches_rules_detect(warnings_db):
    sys.path.insert(0, str(ROOT_DIR / "analysis"))
    from omniscience_analysis import detect
    from omniscience_viewer import db as db_mod

    path, root_fail, root_clean = warnings_db
    client = _make_client(path)
    for root in (root_fail, root_clean):
        expected = len(detect(db_mod.events_for_root(str(path), root)))
        got = client.get("/api/v1/warnings", params={"root": root}).json()
        assert len(got) == expected
