"""Tests for the Omniscience dashboard plugin API (plugin/omniscience/dashboard/plugin_api.py).

Loads the plugin module by path (it lives outside the package tree as a plain file, exactly
as Hermes mounts it), mounts its router on a fresh FastAPI app and exercises /health:
missing DB, populated DB, and read-only guarantees (DB bytes unchanged).
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_API = REPO_ROOT / "dashboard" / "plugin_api.py"


def _load_plugin_api(monkeypatch, hermes_home: Path):
    """Import plugin_api.py by path with HERMES_HOME pointing at a temp dir."""
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_under_test", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _make_app(module) -> TestClient:
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/omniscience")
    return TestClient(app)


DDL = """
CREATE TABLE events (
    rowid INTEGER PRIMARY KEY,
    event_id TEXT UNIQUE,
    kind TEXT,
    schema TEXT,
    ts REAL
);
INSERT INTO events (event_id, kind, schema, ts) VALUES
    ('e1', 'session.start', 'omni.v1', 1000.0),
    ('e2', 'turn.start',    'omni.v1', 1001.5),
    ('e3', 'tool.end',      'omni.v1', 1002.25);
"""


def _make_db(hermes_home: Path) -> Path:
    db_path = hermes_home / "plugin-data" / "omniscience"
    db_path.mkdir(parents=True, exist_ok=True)
    db_file = db_path / "events.db"
    conn = sqlite3.connect(db_file)
    try:
        conn.executescript(DDL)
        conn.commit()
    finally:
        conn.close()
    return db_file


def test_health_missing_db(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    client = _make_app(module)
    resp = client.get("/api/plugins/omniscience/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is False
    assert data["events"] == 0
    assert data["last_ts"] is None
    assert data["db_path"] == str(tmp_path / "plugin-data" / "omniscience" / "events.db")
    assert data["viewer_url"]  # default or env, always present


def test_health_with_rows(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    db_file = _make_db(tmp_path)
    monkeypatch.setenv("OMNISCIENCE_VIEWER_URL", "http://127.0.0.1:8797")
    client = _make_app(module)

    resp = client.get("/api/plugins/omniscience/health")
    assert resp.status_code == 200
    data = resp.json()

    assert data["ok"] is True
    assert data["events"] == 3
    assert data["last_ts"] == pytest.approx(1002.25)
    assert data["db_path"] == str(db_file)
    assert data["viewer_url"] == "http://127.0.0.1:8797"


def test_health_repeated_calls_do_not_modify_db(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    db_file = _make_db(tmp_path)
    client = _make_app(module)

    before = db_file.read_bytes()
    for _ in range(3):
        resp = client.get("/api/plugins/omniscience/health")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    after = db_file.read_bytes()

    assert before == after
    # Sanity: still exactly the seeded rows.
    conn = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    try:
        count = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    finally:
        conn.close()
    assert count == 3


def test_health_default_viewer_url(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    _make_db(tmp_path)
    monkeypatch.delenv("OMNISCIENCE_VIEWER_URL", raising=False)
    client = _make_app(module)

    data = client.get("/api/plugins/omniscience/health").json()
    assert data["viewer_url"] == "http://127.0.0.1:8797"


def test_health_reports_a_file_that_is_not_a_database(tmp_path, monkeypatch):
    """A torn or foreign events.db is the one moment the health panel is opened.

    Only ``OperationalError`` was caught, so sqlite's ``DatabaseError: file is not a database``
    escaped the endpoint as a 500 — the panel said the plugin was broken instead of saying the
    recording could not be read.
    """
    module = _load_plugin_api(monkeypatch, tmp_path)
    db_file = tmp_path / "plugin-data" / "omniscience" / "events.db"
    db_file.parent.mkdir(parents=True)
    db_file.write_bytes(b"this is not a sqlite database" * 40)
    client = _make_app(module)

    resp = client.get("/api/plugins/omniscience/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is False
    assert "query failed" in data["error"]
    assert data["events"] == 0


def test_health_survives_a_truncated_recording(tmp_path, monkeypatch):
    """A half-copied file: sqlite fails mid-read, which must not become a 500 either."""
    module = _load_plugin_api(monkeypatch, tmp_path)
    db_file = _make_db(tmp_path)
    db_file.write_bytes(db_file.read_bytes()[:60])
    client = _make_app(module)

    resp = client.get("/api/plugins/omniscience/health")
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


def test_health_counts_a_store_whose_timestamps_are_text(tmp_path, monkeypatch):
    """An imported store may hold ``ts`` as text; the count is still the answer, not a 500."""
    module = _load_plugin_api(monkeypatch, tmp_path)
    db_file = tmp_path / "plugin-data" / "omniscience" / "events.db"
    db_file.parent.mkdir(parents=True)
    conn = sqlite3.connect(db_file)
    try:
        conn.execute("CREATE TABLE events (rowid INTEGER PRIMARY KEY, kind TEXT, ts TEXT)")
        conn.execute("INSERT INTO events (kind, ts) VALUES ('turn.start', '2026-11-20T06:00:00Z')")
        conn.commit()
    finally:
        conn.close()
    client = _make_app(module)

    resp = client.get("/api/plugins/omniscience/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["events"] == 1
    assert data["last_ts"] is None


FULL_DDL = """
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
);
"""


def _make_full_db(hermes_home: Path) -> Path:
    """A recording with one step well outside the retention window and one inside it."""
    folder = hermes_home / "plugin-data" / "omniscience"
    folder.mkdir(parents=True, exist_ok=True)
    db_file = folder / "events.db"
    conn = sqlite3.connect(db_file)
    try:
        conn.executescript(FULL_DDL)
        conn.execute(
            "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
            " VALUES ('old', 'omni.v1', 'boot', 1, ?, 'llm.response', 's1', 'ok', ?)",
            (time.time() - 30 * 86400, '{"response_model": "m1", "usage": {"prompt_tokens": 100, "output_tokens": 5}}'),
        )
        conn.execute(
            "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
            " VALUES ('new', 'omni.v1', 'boot', 2, ?, 'llm.response', 's1', 'ok', ?)",
            (time.time() - 60, '{"response_model": "m1", "usage": {"prompt_tokens": 50, "output_tokens": 5}}'),
        )
        conn.commit()
    finally:
        conn.close()
    return db_file


def test_history_keep_defaults_to_30_days_and_saves_only_offered_values(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    _make_full_db(tmp_path)
    client = _make_app(module)

    first = client.get("/api/plugins/omniscience/history/keep").json()
    assert first["days"] == 30
    assert first["choices"] == [7, 30, 90, 0]

    saved = client.post("/api/plugins/omniscience/history/keep", json={"days": 7}).json()
    assert saved["days"] == 7
    assert client.get("/api/plugins/omniscience/history/keep").json()["days"] == 7

    # Only the offered windows are accepted; nothing silently becomes "delete everything".
    assert client.post("/api/plugins/omniscience/history/keep", json={"days": 12}).status_code == 400
    assert client.post("/api/plugins/omniscience/history/keep", json={"days": True}).status_code == 400
    assert client.get("/api/plugins/omniscience/history/keep").json()["days"] == 7


def test_cleanup_run_deletes_old_steps_and_reports_the_size_before_and_after(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    _make_full_db(tmp_path)
    client = _make_app(module)
    client.post("/api/plugins/omniscience/history/keep", json={"days": 7})

    data = client.post("/api/plugins/omniscience/cleanup/run").json()

    assert data["ok"] is True
    assert data["deleted"] == 1
    assert data["days_kept"] == 7
    assert isinstance(data["before_bytes"], int) and data["before_bytes"] > 0
    assert isinstance(data["after_bytes"], int)
    assert client.get("/api/plugins/omniscience/health").json()["events"] == 1


def test_cleanup_run_keeps_everything_when_the_owner_chose_forever(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    _make_full_db(tmp_path)
    client = _make_app(module)
    client.post("/api/plugins/omniscience/history/keep", json={"days": 0})

    data = client.post("/api/plugins/omniscience/cleanup/run").json()

    assert data["ok"] is True
    assert data["deleted"] == 0
    assert data["skipped"] == "forever"
    assert client.get("/api/plugins/omniscience/health").json()["events"] == 2
