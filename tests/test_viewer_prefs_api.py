"""The viewer's settings must write the same file the chat reads."""

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "viewer"))

import prefs
from omniscience_viewer.app import create_app


def _client(tmp_path):
    db = tmp_path / "events.db"
    db.write_bytes(b"")
    return TestClient(create_app(str(db)), base_url="http://127.0.0.1"), db


def test_prefs_are_served_with_the_shipped_defaults(tmp_path):
    client, _ = _client(tmp_path)
    body = client.get("/api/v1/prefs").json()
    assert body["digest"] == {"enabled": True, "detail": "standard"}


def test_turning_the_summary_off_from_the_app_writes_the_file(tmp_path):
    client, db = _client(tmp_path)
    response = client.post("/api/v1/prefs", json={"digest": {"enabled": False}})
    assert response.status_code == 200
    assert response.json()["digest"]["enabled"] is False
    on_disk = prefs.load(prefs.path_for(str(db)))
    assert on_disk["digest"]["enabled"] is False
    assert client.get("/api/v1/prefs").json()["digest"]["enabled"] is False


def test_detail_level_round_trips_and_junk_is_ignored(tmp_path):
    client, _ = _client(tmp_path)
    client.post("/api/v1/prefs", json={"digest": {"detail": "full"}})
    assert client.get("/api/v1/prefs").json()["digest"]["detail"] == "full"

    client.post("/api/v1/prefs", json={"digest": {"detail": "shouty"}, "nonsense": 1})
    body = client.get("/api/v1/prefs").json()
    assert body["digest"]["detail"] == "full"
    assert "nonsense" not in body


def test_a_partial_update_keeps_the_other_setting(tmp_path):
    client, _ = _client(tmp_path)
    client.post("/api/v1/prefs", json={"digest": {"enabled": False, "detail": "brief"}})
    client.post("/api/v1/prefs", json={"digest": {"enabled": True}})
    body = client.get("/api/v1/prefs").json()
    assert body["digest"] == {"enabled": True, "detail": "brief"}


def test_the_app_and_the_chat_agree_on_the_same_file(tmp_path):
    """The chat reads <db dir>/prefs.json; so must the viewer."""
    client, db = _client(tmp_path)
    client.post("/api/v1/prefs", json={"digest": {"enabled": False}})
    path = prefs.path_for(str(db))
    assert json.loads(open(path, encoding="utf-8").read())["digest"]["enabled"] is False
