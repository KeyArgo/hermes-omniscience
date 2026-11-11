"""Tests for viewer launcher: DB fingerprint verification, port conflict detection."""

import hashlib
import json
import os
import tempfile
import threading
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from unittest.mock import patch, MagicMock

import pytest


def _db_fingerprint(db_path: str) -> str:
    """Mirror of the launcher's fingerprint function."""
    try:
        real = os.path.realpath(db_path)
    except OSError:
        real = db_path
    return hashlib.sha256(real.encode("utf-8")).hexdigest()[:12]


class _MockViewerHandler(BaseHTTPRequestHandler):
    """Mock HTTP handler that returns a configurable db_fingerprint."""
    fingerprint = "abc123def456"

    def do_GET(self):
        if self.path == "/api/v1/ping":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            body = json.dumps({"ok": True, "db_fingerprint": self.fingerprint})
            self.wfile.write(body.encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress logging


def _start_mock_server(fingerprint: str) -> tuple[HTTPServer, int]:
    """Start a mock viewer server on a random port. Returns (server, port)."""
    _MockViewerHandler.fingerprint = fingerprint
    server = HTTPServer(("127.0.0.1", 0), _MockViewerHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def test_ping_with_fingerprint_returns_fingerprint():
    """_ping_with_fingerprint must return the db_fingerprint from the response."""
    from omniscience.viewer_launcher import _ping_with_fingerprint

    server, port = _start_mock_server("deadbeefcafe")
    try:
        url = f"http://127.0.0.1:{port}"
        up, fp = _ping_with_fingerprint(url)
        assert up is True
        assert fp == "deadbeefcafe"
    finally:
        server.shutdown()


def test_ping_with_fingerprint_returns_none_on_error():
    """_ping_with_fingerprint must return (False, None) when server is unreachable."""
    from omniscience.viewer_launcher import _ping_with_fingerprint

    # Use a port that's almost certainly not listening
    up, fp = _ping_with_fingerprint("http://127.0.0.1:1", timeout=0.1)
    assert up is False
    assert fp is None


def test_ensure_viewer_detects_wrong_db():
    """ensure_viewer must report 'port in use by another Omniscience viewer' when fingerprint mismatches."""
    from omniscience.viewer_launcher import ensure_viewer

    # Start a mock server with a different fingerprint than what our db would produce
    wrong_fp = "000000000000"
    server, port = _start_mock_server(wrong_fp)
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "events.db")
            with open(db_path, "w") as f:
                f.write("")
            log_dir = os.path.join(tmpdir, "logs")
            os.makedirs(log_dir, exist_ok=True)

            url = f"http://127.0.0.1:{port}"
            with patch.dict(os.environ, {"OMNISCIENCE_VIEWER_URL": url, "OMNISCIENCE_VIEWER_AUTOSTART": "1"}):
                result = ensure_viewer(db_path, log_dir=log_dir, autostart=True)
                assert result["running"] is False
                assert "port in use by another Omniscience viewer" in result["reason"]
    finally:
        server.shutdown()


def test_ensure_viewer_accepts_correct_db():
    """ensure_viewer must accept a viewer whose fingerprint matches the db."""
    from omniscience.viewer_launcher import ensure_viewer

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "events.db")
        with open(db_path, "w") as f:
            f.write("")
        correct_fp = _db_fingerprint(db_path)
        server, port = _start_mock_server(correct_fp)
        try:
            log_dir = os.path.join(tmpdir, "logs")
            os.makedirs(log_dir, exist_ok=True)

            url = f"http://127.0.0.1:{port}"
            with patch.dict(os.environ, {"OMNISCIENCE_VIEWER_URL": url, "OMNISCIENCE_VIEWER_AUTOSTART": "1"}):
                result = ensure_viewer(db_path, log_dir=log_dir, autostart=True)
                assert result["running"] is True
                assert "already running" in result["reason"]
        finally:
            server.shutdown()


def test_ensure_viewer_autostart_off():
    """ensure_viewer must respect autostart=False."""
    from omniscience.viewer_launcher import ensure_viewer

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "events.db")
        with open(db_path, "w") as f:
            f.write("")
        log_dir = os.path.join(tmpdir, "logs")
        os.makedirs(log_dir, exist_ok=True)

        result = ensure_viewer(db_path, log_dir=log_dir, autostart=False)
        assert result["running"] is False
        assert result["reason"] == "autostart off"


def test_ensure_viewer_non_local_url():
    """ensure_viewer must refuse to auto-start for non-local URLs."""
    from omniscience.viewer_launcher import ensure_viewer

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "events.db")
        with open(db_path, "w") as f:
            f.write("")
        log_dir = os.path.join(tmpdir, "logs")
        os.makedirs(log_dir, exist_ok=True)

        with patch.dict(os.environ, {"OMNISCIENCE_VIEWER_URL": "http://example.com:8797", "OMNISCIENCE_VIEWER_AUTOSTART": "1"}):
            result = ensure_viewer(db_path, log_dir=log_dir, autostart=True)
            assert result["running"] is False
            assert "non-local" in result["reason"]


def test_pythonpath_for_the_spawn_excludes_relative_entries():
    """The spawn handed the viewer every sys.path entry, including a relative one.

    A relative entry resolves against the child's working directory, so a file there could
    shadow a stdlib module in the viewer process.
    """
    import tempfile

    from omniscience.viewer_launcher import pythonpath_entries

    with tempfile.TemporaryDirectory() as d:
        entries = pythonpath_entries(d, ["", ".", "rel", "/also/not/here", d])
        assert entries[0] == d
        assert "." not in entries and "rel" not in entries and "" not in entries
        assert all(os.path.isabs(p) for p in entries)
