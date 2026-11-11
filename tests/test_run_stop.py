"""The stop buttons must answer in words, never in a 405.

The alert's Stop and Skip used to call a route that did not exist, so the header showed
``{"detail":"Method Not Allowed"}`` — a stack-trace-shaped message in front of a reader who had just
pressed a button about privacy. These tests pin the contract: the route exists, it refuses honestly
(the viewer records runs, it does not drive them), and a malformed request says what is wrong.
"""

import sqlite3
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import app as app_mod  # noqa: E402

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


def client(tmp_path: Path) -> TestClient:
    db = tmp_path / "events.db"
    con = sqlite3.connect(str(db))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    con.commit()
    con.close()
    # The viewer rejects unknown host headers (DNS-rebinding guard), so the default `testserver`
    # host answers 400 before any route runs.
    return TestClient(app_mod.create_app(str(db), token=None), base_url="http://127.0.0.1")


def test_a_stop_request_is_answered_not_refused(tmp_path):
    response = client(tmp_path).post(
        "/api/v1/run/stop", json={"session_id": "local-abc", "action": "stop"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    # The reader must be able to see why, and what to do instead.
    assert "cannot stop or skip" in body["reason"]
    assert "scripts/brake.sh on" in body["reason"]


def test_a_skip_request_says_the_agent_continues(tmp_path):
    body = client(tmp_path).post(
        "/api/v1/run/stop", json={"session_id": "local-abc", "action": "skip"}
    ).json()
    assert body["ok"] is False
    assert "cannot stop or skip" in body["reason"]


def test_get_is_the_only_unsupported_method(tmp_path):
    # The 405 the owner saw came from the route not existing at all; now GET is the only refusal.
    assert client(tmp_path).get("/api/v1/run/stop").status_code == 405


def test_a_bad_action_says_what_is_wrong(tmp_path):
    response = client(tmp_path).post(
        "/api/v1/run/stop", json={"session_id": "local-abc", "action": "explode"}
    )
    assert response.status_code == 400
    assert "stop" in response.json()["detail"]


def test_a_missing_session_is_rejected(tmp_path):
    response = client(tmp_path).post("/api/v1/run/stop", json={"action": "stop"})
    assert response.status_code == 400
    assert "session_id" in response.json()["detail"]
