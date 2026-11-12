"""The dashboard's viewer-link endpoint, and the health paths that are easy to get wrong.

`tests/test_dashboard.py` covers /health on a missing and a populated database. These cover the
rest of the surface: the key handoff, the locked-database answer, the override precedence and the
read-only guarantee when the path contains characters that a URI treats specially.
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

DDL = (
    "create table events (rowid integer primary key, event_id text, schema text, boot_id text,"
    " seq integer, ts real, kind text, session_id text, parent_session_id text, turn_id text,"
    " api_request_id text, tool_call_id text, subagent_id text, status text, attrs text)"
)


def _load(monkeypatch, hermes_home: Path):
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_links", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _client(module) -> TestClient:
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/omniscience")
    return TestClient(app)


def _db(path: Path, rows: int = 2) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute(DDL)
        conn.executemany(
            "insert into events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
            " values (?, 'omni.v1', 'b', ?, ?, 'tool.end', 's', 'ok', '{}')",
            [(f"e{i}", i, 1000.0 + i) for i in range(rows)],
        )
    return path


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.delenv("OMNISCIENCE_DB", raising=False)
    monkeypatch.delenv("OMNISCIENCE_VIEWER_URL", raising=False)
    return _load(monkeypatch, tmp_path / "home")


def test_viewer_link_hands_over_the_key_beside_the_database(api, tmp_path):
    db = _db(tmp_path / "home" / "plugin-data" / "omniscience" / "events.db")
    (db.parent / "viewer-token").write_text("  tok-abc  \n", encoding="utf-8")

    body = _client(api).get("/api/plugins/omniscience/viewer").json()
    assert body["token"] == "tok-abc", body      # stripped, not the raw file
    assert body["viewer_url"].startswith("http://127.0.0.1:8797"), body


def test_viewer_link_reads_the_key_next_to_the_real_file_when_the_folder_is_a_link(api, tmp_path):
    """A profile folder can hold only a symlink to the shared database.

    The key is written beside the real file, so reading beside the link found nothing and the
    dashboard page opened a viewer it could not talk to.
    """
    real = _db(tmp_path / "shared" / "events.db")
    (real.parent / "viewer-token").write_text("tok-real\n", encoding="utf-8")
    linked_dir = tmp_path / "home" / "plugin-data" / "omniscience"
    linked_dir.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(real.parent, linked_dir)

    body = _client(api).get("/api/plugins/omniscience/viewer").json()
    assert body["token"] == "tok-real", body


def test_viewer_link_says_null_when_there_is_no_key(api):
    _db(tmp_path_db := Path(api._db_path()))
    body = _client(api).get("/api/plugins/omniscience/viewer").json()
    assert body["token"] is None, body
    assert tmp_path_db.exists()


def test_health_reports_a_locked_database_instead_of_zero_events(api, tmp_path):
    """A busy database is not an empty one; the answer must not read like a healthy zero."""
    db = _db(tmp_path / "home" / "plugin-data" / "omniscience" / "events.db", rows=3)
    blocker = sqlite3.connect(db, timeout=0)
    try:
        blocker.execute("PRAGMA locking_mode=EXCLUSIVE")
        blocker.execute("BEGIN EXCLUSIVE")
        body = _client(api).get("/api/plugins/omniscience/health").json()
    finally:
        blocker.rollback()
        blocker.close()
    assert body["ok"] is False, body
    assert "query failed" in body["error"], body


def test_health_says_so_when_the_database_is_missing(api):
    body = _client(api).get("/api/plugins/omniscience/health").json()
    assert body["ok"] is False and body["error"] == "event database not found", body
    assert body["events"] == 0


def test_the_override_wins_over_the_profile_folder(api, tmp_path, monkeypatch):
    override = _db(tmp_path / "elsewhere" / "events.db", rows=5)
    monkeypatch.setenv("OMNISCIENCE_DB", str(override))
    body = _client(api).get("/api/plugins/omniscience/health").json()
    assert body["ok"] is True and body["events"] == 5, body
    assert body["db_path"] == str(override)


@pytest.mark.skipif(sys.platform == "win32", reason="'?' is not allowed in a Windows file name")
def test_a_database_name_with_uri_characters_still_opens(api, tmp_path, monkeypatch):
    """`?` and `#` end a URI; passed through raw they truncate the path."""
    odd = _db(tmp_path / "odd" / "events?#1.db", rows=4)
    monkeypatch.setenv("OMNISCIENCE_DB", str(odd))
    body = _client(api).get("/api/plugins/omniscience/health").json()
    assert body["ok"] is True and body["events"] == 4, body


def test_a_viewer_url_that_is_only_spaces_falls_back_to_the_default(api, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_VIEWER_URL", "   ")
    body = _client(api).get("/api/plugins/omniscience/viewer").json()
    assert body["viewer_url"] == "http://127.0.0.1:8797", body


def test_a_viewer_url_override_is_used_as_given(api, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_VIEWER_URL", "http://127.0.0.1:9999/")
    body = _client(api).get("/api/plugins/omniscience/viewer").json()
    assert body["viewer_url"] == "http://127.0.0.1:9999/", body


def test_reading_health_never_creates_the_database(api, tmp_path):
    """mode=ro, or a health check would create an empty store and hide the real problem."""
    target = tmp_path / "home" / "plugin-data" / "omniscience" / "events.db"
    _client(api).get("/api/plugins/omniscience/health")
    assert not target.exists()
