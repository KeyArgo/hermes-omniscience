import os
import re
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


def test_a_real_viewer_writes_its_idle_exit_to_its_log(tmp_path):
    # The viewer's own INFO lines (who connected, why it closed) had no handler, so viewer.log
    # never showed them while the in-process tests, which capture logging, passed.
    import socket
    import sqlite3
    import subprocess

    db = tmp_path / "events.db"
    sqlite3.connect(db).execute("CREATE TABLE events (rowid INTEGER PRIMARY KEY, kind TEXT)").connection.close()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env = dict(os.environ, PYTHONPATH=str(ROOT_DIR / "viewer"), OMNISCIENCE_VIEWER_IDLE_EXIT_S="1")
    proc = subprocess.run(
        [sys.executable, "-m", "omniscience_viewer", "--db", str(db), "--port", str(port), "--no-token"],
        env=env, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    line = next((l for l in proc.stderr.splitlines() if "closing the viewer" in l), None)
    assert line is not None, proc.stderr[-2000:]
    assert re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", line), line
