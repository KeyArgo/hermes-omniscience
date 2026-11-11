"""A smoke test over the two routes the Sources panel and the summary depend on.

The regression that emptied the panel was not a wrong number — it was an exception inside
`discover()` that took out both routes. Unit tests over `sources` did not catch it because the
route both calls and renders; this exercises the app the way the browser does, for every source in
the registry, so a broken probe fails here instead of in the owner's browser.
"""

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from fastapi.testclient import TestClient  # noqa: E402

from omniscience_viewer import sources  # noqa: E402
from omniscience_viewer.app import create_app  # noqa: E402


@pytest.fixture()
def client(tmp_path):
    db = tmp_path / "events.db"
    # An empty but valid recording: the viewer reads the events table, it does not create one.
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE events (ts REAL, kind TEXT, session_id TEXT, parent_session_id TEXT,"
        " status TEXT, attrs TEXT)"
    )
    con.commit()
    con.close()
    app = create_app(str(db))
    return TestClient(app, base_url="http://127.0.0.1")


def test_the_sources_route_answers_for_every_registered_source(client):
    response = client.get("/api/v1/usage/sources")
    assert response.status_code == 200, response.text
    rows = response.json()["sources"]
    ids = {row["id"] for row in rows}
    # Every importable source must be listed, and the declared-but-unreadable ones too.
    for source_id in sources.SOURCES:
        assert source_id in ids, f"{source_id} missing from the sources list"
    assert {"cursor", "gemini-cli"} <= ids
    assert all(isinstance(row["available"], bool) for row in rows)


def test_the_usage_route_answers_with_an_empty_recording(client):
    # The page payload is built from events + usage.db; an empty pair must still produce a page.
    response = client.get("/api/v1/usage?days=0")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["totals"]["calls"] == 0
    assert payload["harnesses"] == []
    assert len(payload["hourly"]) == 24


def test_probing_a_source_never_raises(tmp_path):
    # discover() runs inside the request; a raise there is the whole panel, not one row.
    for source_id in list(sources.SOURCES) + ["cursor", "gemini-cli", "nope"]:
        found = sources.discover(source_id)
        assert isinstance(found, dict)
        assert "available" in found
