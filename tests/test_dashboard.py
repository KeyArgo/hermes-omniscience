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
