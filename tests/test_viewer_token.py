from __future__ import annotations

import os
import sqlite3
import stat
import tempfile

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer.app import create_app
from omniscience_viewer.auth import (
    TOKEN_FILE_NAME,
    read_token,
    token_ok,
    token_path,
    write_token,
)

EVENTS_SCHEMA = """
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


def make_db(tmp_path) -> str:
    db_path = os.path.join(str(tmp_path), "events.db")
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(EVENTS_SCHEMA)
        conn.commit()
    finally:
        conn.close()
    return db_path


def test_401_without_token(tmp_path):
    db_path = make_db(tmp_path)
    token = "secret-token"
    app = create_app(db_path, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    resp = client.get("/api/v1/sessions")
    assert resp.status_code == 401
    assert resp.json() == {"detail": "token required"}


def test_200_with_header(tmp_path):
    db_path = make_db(tmp_path)
    token = "secret-token"
    app = create_app(db_path, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    resp = client.get("/api/v1/sessions", headers={"x-omni-token": token})
    assert resp.status_code == 200


def test_http_query_token_rejected(tmp_path):
    # HTTP is header-only: the token must never ride in the URL query, so a plain
    # request with t= in the URL is rejected even when the value is correct.
    db_path = make_db(tmp_path)
    token = "secret-token"
    app = create_app(db_path, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    resp = client.get("/api/v1/sessions?t=secret-token")
    assert resp.status_code == 401


def test_ping_open(tmp_path):
    db_path = make_db(tmp_path)
    token = "secret-token"
    app = create_app(db_path, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    resp = client.get("/api/v1/ping")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True  # may also carry a db fingerprint


def test_static_not_blocked(tmp_path):
    db_path = make_db(tmp_path)
    static_dir = os.path.join(str(tmp_path), "static")
    os.makedirs(static_dir, exist_ok=True)
    with open(os.path.join(static_dir, "index.html"), "w", encoding="utf-8") as fh:
        fh.write("<html><body>ok</body></html>")
    token = "secret-token"
    app = create_app(db_path, static_dir=static_dir, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    resp = client.get("/")
    assert resp.status_code == 200
    assert "ok" in resp.text


def test_token_none_open(tmp_path):
    db_path = make_db(tmp_path)
    app = create_app(db_path, token=None)
    client = TestClient(app, base_url="http://127.0.0.1")
    resp = client.get("/api/v1/sessions")
    assert resp.status_code == 200


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no POSIX file modes; the owner-only ACL is the OS's job there")
def test_write_token_file_mode(tmp_path):
    path = os.path.join(str(tmp_path), TOKEN_FILE_NAME)
    token = write_token(path)
    assert token
    assert read_token(path) == token
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600


def test_token_ok_basics():
    assert token_ok(None, None) is True
    assert token_ok(None, "anything") is True
    assert token_ok("abc", "abc") is True
    assert token_ok("abc", "abd") is False
    assert token_ok("abc", "") is False
    assert token_ok("abc", None) is False


def test_websocket_rejected_without_token(tmp_path):
    db_path = make_db(tmp_path)
    token = "secret-token"
    app = create_app(db_path, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    with pytest.raises(Exception):
        with client.websocket_connect("/api/v1/live?root=s1", headers={"host": "127.0.0.1"}) as ws:
            ws.send_json({"type": "ping"})


def test_websocket_accepted_with_subprotocol(tmp_path):
    db_path = make_db(tmp_path)
    token = "secret-token"
    app = create_app(db_path, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    # Browsers cannot set an arbitrary header on `new WebSocket`, so the live socket
    # proposes the token as a subprotocol: Sec-WebSocket-Protocol: omni.<token>.
    subprotocol = f"omni.{token}"
    with client.websocket_connect(
        "/api/v1/live?root=s1",
        headers={"host": "127.0.0.1", "sec-websocket-protocol": subprotocol},
    ) as ws:
        ws.send_json({"type": "ping"})


def test_websocket_query_token_rejected_even_when_correct(tmp_path):
    db_path = make_db(tmp_path)
    token = "secret-token"
    app = create_app(db_path, token=token)
    client = TestClient(app, base_url="http://127.0.0.1")
    # The token is never taken from the URL, even for a WebSocket; a trailing `?t=`
    # (without a subprotocol) is rejected so it cannot be scraped from history/logs.
    with pytest.raises(Exception):
        with client.websocket_connect("/api/v1/live?root=s1&t=secret-token", headers={"host": "127.0.0.1"}) as ws:
            ws.send_json({"type": "ping"})


def test_page_is_never_served_stale(tmp_path):
    # An updated plugin must show its new look at once: the page is re-checked every time,
    # the hashed assets it points to are cacheable.
    db_path = make_db(tmp_path)
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html></html>")
    (static / "assets" / "index-abc.js").write_text("x")
    client = TestClient(create_app(db_path, str(static), token="k"), base_url="http://127.0.0.1")
    # no-store, not no-cache: a stored copy under some conditions is what strands a tab on old code.
    assert "no-store" in client.get("/").headers["cache-control"]
    assert "immutable" in client.get("/assets/index-abc.js").headers["cache-control"]


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no POSIX file modes; the owner-only ACL is the OS's job there")
def test_key_survives_viewer_restart_but_not_loose_permissions(tmp_path):
    from omniscience_viewer.auth import ensure_token

    path = str(tmp_path / "viewer-token")
    first = ensure_token(path)
    assert ensure_token(path) == first  # restart: same key, open pages keep working
    os.chmod(path, 0o644)
    assert ensure_token(path) != first  # readable by others: replaced
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


# --- bug hunt round 4 (2026-11-09): the token file is written next to a group-writable dir ---


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need admin rights on Windows, and the check is a POSIX mode")
def test_the_token_is_never_written_through_a_symlink(tmp_path):
    """write_token O_TRUNCs an existing path, so a symlink planted at viewer-token (the data
    directory is group-writable on some installs) received the key. It replaces the path now."""
    target = tmp_path / "planted.txt"
    target.write_text("untouched", encoding="utf-8")
    path = tmp_path / "viewer-token"
    path.symlink_to(target)

    token = write_token(str(path))

    assert target.read_text(encoding="utf-8") == "untouched", "the token was written through the link"
    assert not path.is_symlink()
    assert path.read_text(encoding="utf-8") == token
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_token_path_resolves_symlinked_directories(tmp_path):
    """The dashboard reads the key next to the *resolved* database path; token_path used abspath,
    so a symlinked profile folder made the two disagree and the dashboard saw no key."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    assert token_path(str(link / "events.db")) == str(real / "viewer-token")
