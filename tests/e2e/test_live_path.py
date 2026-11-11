"""In-process live path: plugin EventStore -> sqlite -> viewer websocket.

The full pipeline runs in one process with a tmp-path database:

  register-like hook callbacks -> EventStore (writer thread) -> events.db
  viewer app (create_app) -> TestClient websocket /api/v1/live

Asserts the tool.end event reaches the socket and that SECRETWORD survives
only as metadata (lengths/arg names), never as raw DB bytes.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

REPO = Path(__file__).resolve().parents[2]
import os as _os_pkg  # noqa: E402
sys.path.insert(0, _os_pkg.environ["OMNI_TEST_PKG_DIR"])  # set by tests/conftest.py
sys.path.insert(0, str(REPO / "viewer"))

from fastapi.testclient import TestClient  # noqa: E402

import omniscience  # noqa: E402
from omniscience_viewer.app import create_app  # noqa: E402

SECRETWORD = "SECRETWORD"


class _Ctx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, cb):
        self.hooks[name] = cb


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "events.db"))
    ctx = _Ctx()
    omniscience.register(ctx)
    db_path = str(tmp_path / "events.db")

    app = create_app(db_path, allowed_hosts=["testserver"])
    client = TestClient(app)

    store = omniscience._store
    yield {
        "hooks": ctx.hooks,
        "store": store,
        "client": client,
        "db": Path(db_path),
        "session": "local-" + "e2e0" * 12,
        "turn": "local-" + "e2e0" * 12 + ":turn1",
    }
    client.close()
    store.close()


def test_live_path_delivers_tool_end_and_db_stays_clean(live):
    hooks, store, client = live["hooks"], live["store"], live["client"]
    session, turn = live["session"], live["turn"]

    hooks["on_session_start"](session_id=session, platform="cli", model="m")
    hooks["pre_llm_call"](
        session_id=session, turn_id=turn, model="m", user_message="run it"
    )
    hooks["pre_api_request"](
        session_id=session,
        turn_id=turn,
        api_request_id=f"{turn}:api:1",
        model="m",
        provider="fleet",
        retry_count=0,
    )
    hooks["post_api_request"](
        session_id=session,
        turn_id=turn,
        api_request_id=f"{turn}:api:1",
        api_duration=0.5,
        usage={"total_tokens": 12},
    )

    cursor = 0
    with client.websocket_connect(f"/api/v1/live?root={session}&after={cursor}") as ws:
        hooks["post_tool_call"](
            session_id=session,
            turn_id=turn,
            api_request_id=f"{turn}:api:1",
            tool_call_id="call_e2e_1",
            tool_name="terminal",
            args={"command": f"echo {SECRETWORD}", "cwd": "."},
            result=f"ok {SECRETWORD} output",
            duration_ms=7,
            status="ok",
        )
        store.flush(5)

        seen: list[dict] = []
        deadline = time.monotonic() + 6.0
        # The feed is incremental: the first frame carries whatever is already recorded, so keep
        # reading until the tool.end arrives. Bounded by frames as well as time, because this
        # client's receive_json() has no per-frame timeout.
        for _ in range(12):
            if time.monotonic() > deadline:
                break
            msg = ws.receive_json()
            if msg.get("type") != "events":
                continue
            seen.extend(msg["events"])
            if any(e.get("kind") == "tool.end" and e.get("tool_call_id") == "call_e2e_1"
                   for e in seen):
                break

    tool_ends = [
        event
        for event in seen
        if event["kind"] == "tool.end" and event["tool_call_id"] == "call_e2e_1"
    ]
    assert tool_ends, f"tool.end for call_e2e_1 not delivered: {[e['kind'] for e in seen]}"
    event = tool_ends[0]
    assert event["session_id"] == session
    assert event["attrs"]["tool_name"] == "terminal"
    assert "command" in event["attrs"]["arg_names"]

    store.flush(5)
    store.close()

    db_bytes = live["db"].read_bytes()
    assert SECRETWORD.encode() not in db_bytes, (
        "SECRETWORD must not leak into the DB bytes (metadata-only contract)"
    )


def test_live_websocket_rejects_foreign_origin(live):
    client = live["client"]
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/api/v1/live?root=x",
            headers={"origin": "http://evil.example", "host": "testserver"},
        ) as ws:
            ws.receive_json(timeout=2)
