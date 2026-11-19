import os
import sys
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "viewer"))
sys.path.insert(0, str(ROOT_DIR / "demo"))

from omniscience_viewer.__main__ import main, resolve_db_path  # noqa: E402


def test_missing_db_exits_2_with_stderr(capsys):
    assert main(["--db", "/nope/x.db"]) == 2
    err = capsys.readouterr().err
    assert err.splitlines()[0] == "omniscience-viewer: no events database at /nope/x.db"
    assert len(err.splitlines()) >= 2


def test_resolve_db_path_env():
    assert resolve_db_path(None, {"OMNISCIENCE_DB": "/a.db"}) == ("/a.db", "OMNISCIENCE_DB")


def test_resolve_db_path_hermes_home():
    assert resolve_db_path(None, {"HERMES_HOME": "/h"}) == (
        os.path.join("/h", "plugin-data", "omniscience", "events.db"),
        "HERMES_HOME default",
    )


def test_demo_serves_synthetic_db(monkeypatch):
    calls = []

    class FakeServer:
        def __init__(self, config):
            self.config = config
            calls.append(self)

        def run(self):
            pass

    monkeypatch.setattr(uvicorn, "Server", FakeServer)

    assert main(["--demo"]) == 0
    assert len(calls) == 1
    app = calls[0].config.app

    with TestClient(app, base_url="http://127.0.0.1") as client:
        body = client.get("/api/v1/health").json()

    db_path = body["db_path"]
    assert os.path.isfile(db_path)
    assert body["events"] > 0


def test_the_server_can_be_asked_to_exit(monkeypatch):
    """The idle watcher stops the server through its own should_exit, nothing harsher."""
    calls = []

    class FakeServer:
        should_exit = False

        def __init__(self, config):
            self.config = config
            calls.append(self)

        def run(self):
            assert self.config.app.state.request_exit() is None
            assert self.should_exit is True

    monkeypatch.setattr(uvicorn, "Server", FakeServer)

    assert main(["--demo"]) == 0
