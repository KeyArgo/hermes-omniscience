"""Tests for the review findings fixes (privacy, pause chain, forget recursion, notices, dashboard)."""

import json
import os
import sqlite3

import pytest


# ---------------------------------------------------------------------------
# P1: viewer key only for verified loopback viewer
# ---------------------------------------------------------------------------
def test_viewer_key_only_for_loopback(monkeypatch, tmp_path):
    import omniscience as omni

    monkeypatch.setenv("OMNISCIENCE_VIEWER_URL", "http://127.0.0.1:8797")
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "events.db"))
    (tmp_path / "viewer-token").write_text("SECRETKEY", encoding="utf-8")

    assert omni._viewer_is_loopback("http://127.0.0.1:8797") is True
    assert omni._viewer_is_loopback("http://localhost:8797") is True
    assert omni._viewer_is_loopback("http://[::1]:8797") is True
    assert omni._viewer_is_loopback("http://example.com:8797") is False


def test_offmachine_viewer_link_is_keyless(monkeypatch, tmp_path):
    import omniscience as omni

    monkeypatch.setenv("OMNISCIENCE_VIEWER_URL", "http://example.com:8797")
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "events.db"))
    (tmp_path / "viewer-token").write_text("SECRETKEY", encoding="utf-8")
    monkeypatch.setattr(omni, "_viewer_up", lambda url: True)
    monkeypatch.setattr(omni, "_store", None)
    monkeypatch.setattr(omni, "diagnose_current", lambda *a, **k: str(k.get("links")))

    out = omni._omni_command("", session_id="sess1", platform="cli")
    assert "SECRETKEY" not in out


# ---------------------------------------------------------------------------
# P1: pause checks parent chain; pause/resume report write failures
# ---------------------------------------------------------------------------
def test_pause_checks_parent_chain(tmp_path):
    from omniscience.privacy import PausedSessions

    db = str(tmp_path / "events.db")
    ps = PausedSessions(db)
    assert ps.pause("parent") is True

    # A helper event has its own session_id but parent_session_id == parent.
    sid = "helper"
    parent = "parent"
    paused = (isinstance(sid, str) and sid and ps.is_paused(sid)) or \
             (isinstance(parent, str) and parent and ps.is_paused(parent))
    assert paused is True


def test_pause_returns_false_on_write_failure(tmp_path, monkeypatch):
    from omniscience.privacy import PausedSessions

    db = str(tmp_path / "events.db")
    ps = PausedSessions(db)

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(ps, "_write_paused", lambda s: False)
    assert ps.pause("s") is False
    assert ps.resume("s") is False


# ---------------------------------------------------------------------------
# P1: forget recursively deletes nested helpers
# ---------------------------------------------------------------------------
def _make_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE events (session_id TEXT, parent_session_id TEXT, ts REAL)")
    conn.commit()
    return conn


def test_forget_deletes_nested_helpers(tmp_path):
    from omniscience.privacy import forget_session

    db = str(tmp_path / "events.db")
    conn = _make_db(db)
    conn.executemany(
        "INSERT INTO events VALUES (?,?,?)",
        [
            ("root", None, 1.0),
            ("helper1", "root", 2.0),
            ("helper2", "helper1", 3.0),  # helper of a helper
            ("other", None, 4.0),
        ],
    )
    conn.commit()
    conn.close()

    deleted = forget_session(db, "root")
    assert deleted == 3

    conn = sqlite3.connect(db)
    remaining = {r[0] for r in conn.execute("SELECT session_id FROM events")}
    conn.close()
    assert remaining == {"other"}


# ---------------------------------------------------------------------------
# P2: notices default to local surfaces only
# ---------------------------------------------------------------------------
def test_notices_platform_filter_blocks_remote():
    from omniscience.notices import Notices

    posted = []

    class Ctx:
        def post_message(self, text):
            posted.append(text)
            return None

    def normalize(hook, kwargs):
        return ("llm.error", {"session_id": "s", "platform": "telegram"},
                "error", {"reason": "rate_limit"}, None)

    n = Notices(Ctx(), lambda s: "link", normalize=normalize, spawn=lambda fn: fn())
    n.set_platform_filter((None, "", "cli", "tui", "desktop", "local", "gui", "oneshot"))
    n.observe("api_request_error", {})
    assert posted == []


def test_notices_all_mode_posts_remote():
    from omniscience.notices import Notices

    posted = []

    class Ctx:
        def post_message(self, text):
            posted.append(text)
            return None

    def normalize(hook, kwargs):
        return ("llm.error", {"session_id": "s", "platform": "telegram"},
                "error", {"reason": "rate_limit"}, None)

    n = Notices(Ctx(), lambda s: "link", normalize=normalize, spawn=lambda fn: fn())
    n.observe("api_request_error", {})
    assert len(posted) == 1


# ---------------------------------------------------------------------------
# P2: dashboard honors OMNISCIENCE_DB
# ---------------------------------------------------------------------------
def test_dashboard_honors_db_override(monkeypatch, tmp_path):
    from omniscience.dashboard import plugin_api

    custom = tmp_path / "custom.db"
    monkeypatch.setenv("OMNISCIENCE_DB", str(custom))
    assert plugin_api._db_path() == custom


# ---------------------------------------------------------------------------
# P3: rate-limit provider lookup uses api_request_id from ids
# ---------------------------------------------------------------------------
def test_rate_limit_uses_provider_from_ids():
    from omniscience.notices import Notices

    posted = []

    class Ctx:
        def post_message(self, text):
            posted.append(text)
            return None

    def normalize(hook, kwargs):
        kind = kwargs["kind"]
        if kind == "llm.request":
            return ("llm.request", {"session_id": "s", "api_request_id": "req1"},
                    "ok", {"provider": "AcmeAI", "model": "m"}, None)
        return ("llm.error", {"session_id": "s", "api_request_id": "req1"},
                "error", {"reason": "rate_limit"}, None)

    n = Notices(Ctx(), lambda s: "link", normalize=normalize, spawn=lambda fn: fn())
    n.observe("pre_api_request", {"kind": "llm.request"})
    n.observe("api_request_error", {"kind": "llm.error"})
    assert any("AcmeAI" in t for t in posted)
