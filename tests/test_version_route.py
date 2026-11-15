"""The version endpoint exposes the exact line produced by the shared stamp."""

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import version_stamp  # noqa: E402
from omniscience_viewer.app import create_app  # noqa: E402


def test_version_endpoint_includes_stamp_chip_line(monkeypatch, tmp_path):
    info = {
        "version": "2.1.0-dev.12",
        "release": "2.1.0",
        "commit": "1234567890abcdef",
        "commit_short": "12345678",
        "commit_date": "2026-11-14T12:00:00Z",
        "dirty": True,
        "channel": "dev",
        "source": "git",
    }
    monkeypatch.setattr(version_stamp, "as_dict", lambda: info)

    client = TestClient(create_app(str(tmp_path / "events.db")), base_url="http://127.0.0.1")
    response = client.get("/api/v1/version")

    assert response.status_code == 200
    assert response.json()["chip_line"] == version_stamp.chip_line(info)
    assert response.json()["chip_line"] == "v2.1.0-dev.12 · 12345678 · 2026-11-14 · modified"
