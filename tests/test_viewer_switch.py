"""The owner's viewer switch: off means no viewer process at all, recording carries on.

The switch lives in ``prefs.json`` (``"viewer": "on" | "off"``) and is read by three places: the
plugin at boot, the dashboard when the pane asks for the viewer, and the viewer's own settings
page. These tests pin the two that can start or stop a process.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_API = REPO_ROOT / "dashboard" / "plugin_api.py"


def _load(monkeypatch, hermes_home: Path):
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("OMNISCIENCE_DB", raising=False)
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_switch", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _client(module) -> TestClient:
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/omniscience")
    return TestClient(app)


def _db(module) -> Path:
    path = Path(module._db_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute("create table if not exists events (rowid integer primary key, ts real)")
    return path


def _prefs_on_disk(module) -> dict:
    prefs_mod = module._prefs()
    path = prefs_mod.path_for(str(module._db_path()))
    return json.loads(Path(path).read_text(encoding="utf-8"))


class _FakeLauncher:
    def __init__(self, running: bool = True):
        self.calls = []
        self.stop_calls = []
        self.running = running

    def ensure_viewer(self, db_path, *, log_dir, autostart, state_db=None):
        self.calls.append({"db": db_path, "log_dir": log_dir, "autostart": autostart})
        return {
            "running": self.running,
            "started": True,
            "reason": "started successfully" if self.running else "spawn failed",
        }

    def stop_viewer(self, log_dir):
        self.stop_calls.append(log_dir)
        return {"stopped": True, "reason": "stopped"}


@pytest.fixture()
def api(tmp_path, monkeypatch):
    return _load(monkeypatch, tmp_path / "home")


def test_the_switch_reads_on_by_default(api):
    assert _client(api).get("/api/plugins/omniscience/viewer/mode").json() == {"enabled": True}


def test_turning_it_off_saves_the_pref_and_stops_the_viewer(api, tmp_path, monkeypatch):
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)
    client = _client(api)

    body = client.post("/api/plugins/omniscience/viewer/mode", json={"enabled": False}).json()

    assert body == {"enabled": False}
    assert _prefs_on_disk(api)["viewer"] == "off"
    assert len(fake.stop_calls) == 1
    assert client.get("/api/plugins/omniscience/viewer/mode").json() == {"enabled": False}


def test_turning_it_back_on_does_not_start_a_viewer_by_itself(api, tmp_path, monkeypatch):
    """On means "allowed", not "running": the pane still starts it when it opens."""
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)
    client = _client(api)
    client.post("/api/plugins/omniscience/viewer/mode", json={"enabled": False})
    client.post("/api/plugins/omniscience/viewer/mode", json={"enabled": True})

    assert _prefs_on_disk(api)["viewer"] == "on"
    assert fake.calls == []
    assert client.get("/api/plugins/omniscience/viewer/mode").json() == {"enabled": True}


def test_a_body_that_is_not_a_boolean_is_rejected(api):
    client = _client(api)
    assert client.post("/api/plugins/omniscience/viewer/mode", json={"enabled": "no"}).status_code == 400
    assert client.post("/api/plugins/omniscience/viewer/mode", json={}).status_code == 400


def test_the_pane_does_not_start_the_viewer_when_the_switch_is_off(api, tmp_path, monkeypatch):
    db = _db(api)
    (db.parent / "viewer-token").write_text("tok\n", encoding="utf-8")
    prefs_mod = api._prefs()
    prefs_mod.save(
        prefs_mod.path_for(str(db)), prefs_mod.set_viewer(prefs_mod.defaults(), False)
    )
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)

    body = _client(api).get("/api/plugins/omniscience/viewer").json()

    assert fake.calls == []
    assert body["viewer"] == {"running": False, "reason": "off"}
    # A viewer started before the switch was turned off must not outlive it.
    assert fake.stop_calls == [str(db.parent)]


def test_the_pane_starts_the_viewer_when_the_switch_is_on(api, tmp_path, monkeypatch):
    db = _db(api)
    (db.parent / "viewer-token").write_text("tok\n", encoding="utf-8")
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)

    body = _client(api).get("/api/plugins/omniscience/viewer").json()

    assert len(fake.calls) == 1
    assert fake.calls[0]["autostart"] is True
    assert body["viewer"] == {"running": True, "reason": "started successfully"}


class _FakeCtx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback


def test_recording_still_writes_events_while_the_viewer_is_off(tmp_path, monkeypatch):
    """Off is about the page and its server, never about the recorder."""
    import omniscience
    from omniscience import prefs

    db = str(tmp_path / "events.db")
    monkeypatch.setenv("OMNISCIENCE_DB", db)
    ctx = _FakeCtx()
    omniscience.register(ctx)
    try:
        prefs.save(prefs.path_for(db), prefs.set_viewer(prefs.defaults(), False))
        assert prefs.viewer_enabled(prefs.load(prefs.path_for(db))) is False

        ctx.hooks["post_tool_call"](tool_name="terminal", session_id="s")
        omniscience._store.flush(timeout=5.0)

        with sqlite3.connect(db) as conn:
            count = conn.execute("select count(*) from events").fetchone()[0]
        assert count >= 1
    finally:
        omniscience._store.close()
