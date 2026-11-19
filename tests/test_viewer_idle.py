"""The viewer costs nothing when nobody is looking, and says who was looking.

Two behaviours, both from the same complaint: the viewer sat at ~80% CPU while no pane was open
and its log could not say who had opened sockets. The idle task asks uvicorn to stop after a
quiet spell; the live feed logs one line per socket, both ends, with a timestamp and a client.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from fastapi.testclient import TestClient  # noqa: E402

from omniscience_viewer.app import (  # noqa: E402
    IDLE_EXIT_DEFAULT_S,
    ViewerActivity,
    create_app,
    idle_exit_seconds,
    idle_watch,
)


SCHEMA = """
CREATE TABLE events (
    rowid INTEGER PRIMARY KEY,
    event_id TEXT,
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
)
"""


def _make_db(tmp_path: Path) -> str:
    path = str(tmp_path / "events.db")
    con = sqlite3.connect(path)
    con.execute(SCHEMA)
    con.commit()
    con.close()
    return path


def test_the_default_quiet_spell_is_ten_minutes():
    assert idle_exit_seconds({}) == IDLE_EXIT_DEFAULT_S == 600.0


def test_the_quiet_spell_is_configurable_and_zero_disables_it():
    assert idle_exit_seconds({"OMNISCIENCE_VIEWER_IDLE_EXIT_S": "2.5"}) == 2.5
    assert idle_exit_seconds({"OMNISCIENCE_VIEWER_IDLE_EXIT_S": "0"}) == 0
    # Junk must not read as "exit at once"; negative must not read as "never exit".
    assert idle_exit_seconds({"OMNISCIENCE_VIEWER_IDLE_EXIT_S": "soon"}) == IDLE_EXIT_DEFAULT_S
    assert idle_exit_seconds({"OMNISCIENCE_VIEWER_IDLE_EXIT_S": "-5"}) == IDLE_EXIT_DEFAULT_S


def test_the_idle_task_asks_the_server_to_exit_when_nothing_happened():
    activity = ViewerActivity()
    asked = []

    async def run():
        await asyncio.wait_for(idle_watch(activity, 0.05, lambda: asked.append(1)), timeout=5)

    asyncio.run(run())
    assert asked == [1]


def test_an_open_socket_keeps_the_viewer_up():
    """A pane is looking, even when it is not asking for anything."""
    activity = ViewerActivity()
    activity.socket_open()
    asked = []

    async def run():
        task = asyncio.create_task(idle_watch(activity, 0.05, lambda: asked.append(1)))
        await asyncio.sleep(0.3)
        assert asked == []
        task.cancel()

    asyncio.run(run())


def test_a_request_restarts_the_countdown():
    activity = ViewerActivity()
    asked = []

    async def run():
        task = asyncio.create_task(idle_watch(activity, 0.2, lambda: asked.append(1)))
        await asyncio.sleep(0.1)
        activity.touch()          # somebody asked for something
        await asyncio.sleep(0.15)  # less than 0.2 s since that request
        assert asked == []
        task.cancel()

    asyncio.run(run())


def test_zero_disables_the_watch_entirely():
    activity = ViewerActivity()
    asked = []
    asyncio.run(asyncio.wait_for(idle_watch(activity, 0, lambda: asked.append(1)), timeout=1))
    assert asked == []


def test_live_socket_open_and_close_are_logged_with_time_and_client(tmp_path, caplog):
    """Two lines, both ends: a timestamp, the root, and the page's client marker."""
    caplog.set_level(logging.INFO, logger="omniscience")
    app = create_app(_make_db(tmp_path))

    with TestClient(app, base_url="http://127.0.0.1") as client:
        with client.websocket_connect("/api/v1/live?root=abcdef123456&client=pane",
                                      headers={"host": "127.0.0.1"}):
            pass

    lines = [r.getMessage() for r in caplog.records if "live socket" in r.getMessage()]
    assert len(lines) == 2, lines
    assert "open" in lines[0] and "close" in lines[1]
    for line in lines:
        assert re.search(r"ts=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", line), line
        assert "root=abcdef12" in line, line          # the root, first 8 chars only
        assert "client=pane" in line, line


def test_a_client_marker_cannot_forge_a_log_line(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="omniscience")
    app = create_app(_make_db(tmp_path))

    with TestClient(app, base_url="http://127.0.0.1") as client:
        with client.websocket_connect("/api/v1/live?root=r&client=pane%0Aadmin",
                                      headers={"host": "127.0.0.1"}) as ws:
            ws.receive_json()

    lines = [r.getMessage() for r in caplog.records if "live socket open" in r.getMessage()]
    assert lines and "client=paneadmin" in lines[0], lines
