"""The page carries this machine's current key, so a rotated key recovers on reload."""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer.app import _inject_key, _is_loopback_client, create_app

PAGE = "<html><head><title>Omniscience</title></head><body><div id=\"root\"></div></body></html>"


def test_loopback_clients_are_recognised():
    for host in ("127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"):
        assert _is_loopback_client(host) is True
    for host in ("", None, "10.0.0.5", "192.168.1.20", "0.0.0.0"):
        assert _is_loopback_client(host) is False


def test_key_is_injected_before_head_closes():
    out = _inject_key(PAGE, "abc123")
    assert '<script>window.__OMNI_TOKEN__="abc123";</script></head>' in out
    assert out.startswith("<html><head>")
    # The page still contains everything it had before.
    assert '<div id="root"></div>' in out


def test_injection_is_a_no_op_without_a_key():
    assert _inject_key(PAGE, None) == PAGE
    assert _inject_key(PAGE, "") == PAGE


def test_key_is_escaped_not_interpolated_raw():
    # A token is urlsafe base64, but the value must never be able to break out of the string.
    out = _inject_key(PAGE, 'a"b</script>')
    assert '\\"b' in out
    assert "</script></script>" not in out


def test_page_without_head_still_gets_the_key():
    out = _inject_key("<div id=\"root\"></div>", "abc123")
    assert out.startswith("<script>window.__OMNI_TOKEN__=")


def _app(tmp_path: Path, token: str | None):
    db = tmp_path / "events.db"
    con = sqlite3.connect(db)
    # The columns the viewer's session list reads; this fixture exists for the auth and page
    # tests, so it only has to be a database the reader accepts.
    con.execute(
        "CREATE TABLE events (rowid INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, "
        "session_id TEXT, parent_session_id TEXT, kind TEXT, status TEXT, attrs TEXT, ts REAL)"
    )
    con.commit()
    con.close()
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text(PAGE, encoding="utf-8")
    assets = static / "assets"
    assets.mkdir()
    (assets / "app.js").write_text("console.log(1)", encoding="utf-8")
    return create_app(str(db), static_dir=str(static), token=token)


def test_asset_requests_are_untouched(tmp_path):
    client = TestClient(_app(tmp_path, "abc123"), base_url="http://127.0.0.1")
    response = client.get("/assets/app.js")
    assert response.status_code == 200
    assert response.text == "console.log(1)"
    assert "__OMNI_TOKEN__" not in response.text


def test_root_still_serves_the_page(tmp_path):
    client = TestClient(_app(tmp_path, "abc123"), base_url="http://127.0.0.1")
    response = client.get("/")
    assert response.status_code == 200
    assert '<div id="root"></div>' in response.text
    # no-store, not no-cache: a cacheable document is what strands a tab on an old bundle.
    assert "no-store" in response.headers.get("cache-control", "")


def test_the_api_still_demands_the_key(tmp_path):
    client = TestClient(_app(tmp_path, "abc123"), base_url="http://127.0.0.1")
    assert client.get("/api/v1/sessions").status_code == 401
    assert client.get("/api/v1/sessions", headers={"x-omni-token": "abc123"}).status_code == 200
