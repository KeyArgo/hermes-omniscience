"""The owner's failure pop-up switch: off means no repeated-failure toast, recording carries on.

The switch lives in ``prefs.json`` (``"failure_alerts": true | false``). The desktop settings
page writes it through the dashboard's ``/alerts/mode`` — the same shape as ``/viewer/mode`` —
and the notifier reads the same file on every turn. These tests pin the dashboard side.
"""

from __future__ import annotations

import importlib.util
import json
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
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_alerts", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _client(module) -> TestClient:
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/omniscience")
    return TestClient(app)


def _prefs_on_disk(module) -> dict:
    prefs_mod = module._prefs()
    path = prefs_mod.path_for(str(module._db_path()))
    return json.loads(Path(path).read_text(encoding="utf-8"))


@pytest.fixture()
def api(tmp_path, monkeypatch):
    return _load(monkeypatch, tmp_path / "home")


def test_the_switch_reads_on_by_default(api):
    assert _client(api).get("/api/plugins/omniscience/alerts/mode").json() == {"enabled": True}


def test_turning_it_off_saves_the_pref(api):
    client = _client(api)
    body = client.post("/api/plugins/omniscience/alerts/mode", json={"enabled": False}).json()

    assert body == {"enabled": False}
    assert _prefs_on_disk(api)["failure_alerts"] is False
    assert client.get("/api/plugins/omniscience/alerts/mode").json() == {"enabled": False}


def test_turning_it_off_leaves_the_other_settings_alone(api):
    client = _client(api)
    client.post("/api/plugins/omniscience/alerts/mode", json={"enabled": False})
    prefs = _prefs_on_disk(api)
    assert prefs["viewer"] == "on"
    assert prefs["digest"]["enabled"] is True


def test_turning_it_back_on(api):
    client = _client(api)
    client.post("/api/plugins/omniscience/alerts/mode", json={"enabled": False})
    client.post("/api/plugins/omniscience/alerts/mode", json={"enabled": True})
    assert _prefs_on_disk(api)["failure_alerts"] is True
    assert client.get("/api/plugins/omniscience/alerts/mode").json() == {"enabled": True}


def test_a_body_that_is_not_a_boolean_is_rejected(api):
    client = _client(api)
    assert client.post("/api/plugins/omniscience/alerts/mode", json={"enabled": "no"}).status_code == 400
    assert client.post("/api/plugins/omniscience/alerts/mode", json={}).status_code == 400


def test_the_chat_reads_the_same_switch(api):
    """One file, no second source of truth: the plugin's prefs module reads what was saved."""
    from omniscience import prefs as chat_prefs

    client = _client(api)
    client.post("/api/plugins/omniscience/alerts/mode", json={"enabled": False})
    path = chat_prefs.path_for(str(api._db_path()))
    assert chat_prefs.failure_alerts_enabled(chat_prefs.load(path)) is False
