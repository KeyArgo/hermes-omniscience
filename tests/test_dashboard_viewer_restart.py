"""POST /viewer/restart: the reset that does not quit Hermes.

The viewer stops when the Hermes process that started it exits, or after ten idle minutes; an
open pane then finds nothing listening. The desktop pane's recovery and the owner's Restart
viewer button both call this route: a real stop-then-start, with the owner's on/off switch still
in charge. These tests drive it with a fake launcher that records the order of the calls.
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
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_restart", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _client(module) -> TestClient:
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/omniscience")
    return TestClient(app)


def _db(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute(DDL)
        conn.execute(
            "insert into events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
            " values ('e1', 'omni.v1', 'b', 1, 1000.0, 'tool.end', 's', 'ok', '{}')"
        )
    return path


class _FakeLauncher:
    """Records stop and ensure in one list, so the order is checkable."""

    def __init__(self, stop_result=None, ensure_result=None, stop_error=None):
        self.calls = []
        self.stop_result = stop_result or {"stopped": True}
        self.ensure_result = ensure_result or {"running": True, "started": True, "reason": "started successfully"}
        self.stop_error = stop_error

    def stop_viewer(self, log_dir):
        self.calls.append(("stop", log_dir))
        if self.stop_error:
            raise self.stop_error
        return self.stop_result

    def ensure_viewer(self, db_path, *, log_dir, autostart, state_db=None):
        self.calls.append(("ensure", db_path))
        return self.ensure_result


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.delenv("OMNISCIENCE_DB", raising=False)
    monkeypatch.delenv("OMNISCIENCE_VIEWER_URL", raising=False)
    return _load(monkeypatch, tmp_path / "home")


def test_restart_stops_the_viewer_then_starts_it_again(api, tmp_path, monkeypatch):
    db = _db(tmp_path / "home" / "plugin-data" / "omniscience" / "events.db")
    (db.parent / "viewer-token").write_text("tok-fresh\n", encoding="utf-8")
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)

    body = _client(api).post("/api/plugins/omniscience/viewer/restart").json()

    # Stop first, then ensure — a restart that only ensures would leave a stuck viewer in place.
    assert [kind for kind, _ in fake.calls] == ["stop", "ensure"], fake.calls
    assert fake.calls[0][1] == os.path.dirname(os.path.realpath(db))
    assert fake.calls[1][1] == os.path.realpath(db)
    # The answer is the same shape as GET /viewer, so the pane can adopt it directly.
    assert body["token"] == "tok-fresh", body
    assert body["viewer_url"].startswith("http://127.0.0.1:8797"), body
    assert body["viewer"] == {"running": True, "reason": "started successfully"}, body


def test_restart_respects_the_owners_off_switch(api, tmp_path, monkeypatch):
    _db(tmp_path / "home" / "plugin-data" / "omniscience" / "events.db")
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)
    client = _client(api)
    assert client.post("/api/plugins/omniscience/viewer/mode", json={"enabled": False}).json() == {"enabled": False}
    fake.calls.clear()

    body = client.post("/api/plugins/omniscience/viewer/restart").json()

    # Off is a decision: the viewer is stopped (or stays stopped) and nothing is started.
    assert body["viewer"] == {"running": False, "reason": "off"}, body
    kinds = [kind for kind, _ in fake.calls]
    assert kinds[0] == "stop" and "ensure" not in kinds, fake.calls


def test_restart_still_answers_when_the_stop_fails(api, tmp_path, monkeypatch):
    """A viewer this machine cannot stop (another owner, a stale pid) must not block the start."""
    _db(tmp_path / "home" / "plugin-data" / "omniscience" / "events.db")
    fake = _FakeLauncher(stop_error=RuntimeError("not my viewer"))
    monkeypatch.setattr(api, "_launcher", lambda: fake)

    body = _client(api).post("/api/plugins/omniscience/viewer/restart").json()

    assert [kind for kind, _ in fake.calls] == ["stop", "ensure"], fake.calls
    assert body["viewer"]["running"] is True, body


def test_restart_reports_a_failed_start_without_breaking(api, tmp_path, monkeypatch):
    _db(tmp_path / "home" / "plugin-data" / "omniscience" / "events.db")
    fake = _FakeLauncher(ensure_result={"running": False, "reason": "port in use by another Omniscience viewer"})
    monkeypatch.setattr(api, "_launcher", lambda: fake)

    body = _client(api).post("/api/plugins/omniscience/viewer/restart").json()

    assert body["viewer"] == {"running": False, "reason": "port in use by another Omniscience viewer"}, body


def test_restart_without_a_recording_starts_nothing(api, monkeypatch):
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)

    body = _client(api).post("/api/plugins/omniscience/viewer/restart").json()

    assert body["viewer"]["running"] is False, body
    assert "not found" in body["viewer"]["reason"], body
    assert [kind for kind, _ in fake.calls] == ["stop"], fake.calls
