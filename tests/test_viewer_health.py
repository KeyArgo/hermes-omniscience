"""Problem logging for the viewer: health lines, slow requests, error traces, log rotation.

The viewer must say what went wrong, with timestamps, in viewer.log — and stay quiet (and
cheap) while nothing is wrong. These tests drive the health monitor with a fake clock and a
fake memory reader, the middleware through a real TestClient, and the rotation with real files.

Run from the repo root: ``pytest tests/test_viewer_health.py``.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))


class FakeActivity:
    """Only the attribute the health line reads."""

    def __init__(self, sockets: int = 0) -> None:
        self.open_sockets = sockets


class FakeReader:
    def __init__(self, rss: float = 120.0, peak: float = 150.0) -> None:
        self.rss = rss
        self.peak = peak

    def __call__(self):
        return self.rss, self.peak


class FakeCpu:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def _make_monitor(tmp_path, *, reader=None, sockets=0, cache=3, db_bytes=2 * 1024 * 1024, cpu=None):
    from omniscience_viewer import health as health_mod

    db = tmp_path / "events.db"
    if not db.exists():
        db.write_bytes(b"\0" * db_bytes)
    return health_mod.HealthMonitor(
        str(db),
        FakeActivity(sockets),
        reader=reader if reader is not None else FakeReader(),
        clock=lambda: 0.0,
        cpu_clock=cpu if cpu is not None else FakeCpu(),
        cache_sessions=lambda: cache,
    )


def _health_lines(caplog):
    return [r.getMessage() for r in caplog.records if "health rss_mb=" in r.getMessage()]


def _warnings(caplog, kind):
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING and kind in r.getMessage()]


# ---------------------------------------------------------------------------
# the health line
# ---------------------------------------------------------------------------

def test_health_line_format(tmp_path, caplog):
    reader = FakeReader(rss=123.4, peak=200.5)
    cpu = FakeCpu()
    mon = _make_monitor(tmp_path, reader=reader, sockets=2, cache=7, cpu=cpu)
    cpu.value = 1.5  # 1.5 CPU-s over 60 wall-s = 2.5 %
    with caplog.at_level(logging.INFO, logger="omniscience"):
        mon.tick(now=60.0)
    lines = _health_lines(caplog)
    assert len(lines) == 1
    assert re.fullmatch(
        r"omniscience: health rss_mb=123\.4 peak_mb=200\.5 cpu_pct=2\.5 "
        r"threads=\d+ sockets=2 db_mb=2\.0 cache_sessions=7",
        lines[0],
    )


def test_missing_memory_reads_as_question_mark(tmp_path, caplog):
    mon = _make_monitor(tmp_path, reader=lambda: (None, None))
    with caplog.at_level(logging.INFO, logger="omniscience"):
        mon.tick(now=60.0)
    lines = _health_lines(caplog)
    assert len(lines) == 1
    assert "rss_mb=?" in lines[0] and "peak_mb=?" in lines[0]


def test_a_reader_that_raises_never_crashes_the_tick(tmp_path, caplog):
    def broken():
        raise OSError("no /proc here")

    mon = _make_monitor(tmp_path, reader=broken)
    with caplog.at_level(logging.INFO, logger="omniscience"):
        mon.tick(now=60.0)
    lines = _health_lines(caplog)
    assert len(lines) == 1
    assert "rss_mb=?" in lines[0]


def test_missing_db_and_cache_read_as_question_mark(tmp_path, caplog):
    from omniscience_viewer import health as health_mod

    mon = health_mod.HealthMonitor(
        str(tmp_path / "gone.db"),
        FakeActivity(),
        reader=FakeReader(),
        clock=lambda: 0.0,
        cpu_clock=FakeCpu(),
        cache_sessions=lambda: None,
    )
    with caplog.at_level(logging.INFO, logger="omniscience"):
        mon.tick(now=60.0)
    lines = _health_lines(caplog)
    assert len(lines) == 1
    assert "db_mb=?" in lines[0] and "cache_sessions=?" in lines[0]


def test_idle_viewer_stays_silent_but_checks_in_every_ten_minutes(tmp_path, caplog):
    mon = _make_monitor(tmp_path, sockets=0)  # stable reader, no CPU burned, no sockets
    with caplog.at_level(logging.INFO, logger="omniscience"):
        mon.tick(now=60.0)    # the first line always lands
        mon.tick(now=120.0)   # nothing changed, nobody connected: silent
        mon.tick(now=180.0)
        assert len(_health_lines(caplog)) == 1
        mon.tick(now=660.0)   # ten minutes since the last line: forced check-in
        assert len(_health_lines(caplog)) == 2


def test_a_real_change_is_logged_even_without_sockets(tmp_path, caplog):
    reader = FakeReader(rss=120.0)
    mon = _make_monitor(tmp_path, reader=reader, sockets=0)
    with caplog.at_level(logging.INFO, logger="omniscience"):
        mon.tick(now=60.0)
        reader.rss = 180.0
        mon.tick(now=120.0)
    assert len(_health_lines(caplog)) == 2


def test_open_sockets_keep_the_line_flowing(tmp_path, caplog):
    mon = _make_monitor(tmp_path, sockets=1)
    with caplog.at_level(logging.INFO, logger="omniscience"):
        mon.tick(now=60.0)
        mon.tick(now=120.0)  # unchanged values, but somebody is connected
    assert len(_health_lines(caplog)) == 2


# ---------------------------------------------------------------------------
# memory warnings
# ---------------------------------------------------------------------------

def test_high_memory_warns_at_most_once_per_ten_minutes(tmp_path, caplog, monkeypatch):
    monkeypatch.delenv("OMNISCIENCE_VIEWER_RSS_WARN_MB", raising=False)
    mon = _make_monitor(tmp_path, reader=FakeReader(rss=500.0, peak=500.0))
    with caplog.at_level(logging.WARNING, logger="omniscience"):
        mon.tick(now=60.0)
        mon.tick(now=120.0)
        mon.tick(now=600.0)
        assert len(_warnings(caplog, "memory high")) == 1
        mon.tick(now=700.0)  # past the cooldown
        assert len(_warnings(caplog, "memory high")) == 2
    assert "rss_mb=500.0" in _warnings(caplog, "memory high")[0]


def test_healthy_memory_does_not_warn(tmp_path, caplog, monkeypatch):
    monkeypatch.delenv("OMNISCIENCE_VIEWER_RSS_WARN_MB", raising=False)
    mon = _make_monitor(tmp_path, reader=FakeReader(rss=350.0))
    with caplog.at_level(logging.WARNING, logger="omniscience"):
        mon.tick(now=60.0)
    assert _warnings(caplog, "memory high") == []


def test_the_rss_warning_limit_comes_from_the_environment(tmp_path, caplog, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_VIEWER_RSS_WARN_MB", "200")
    mon = _make_monitor(tmp_path, reader=FakeReader(rss=250.0))
    with caplog.at_level(logging.WARNING, logger="omniscience"):
        mon.tick(now=60.0)
    assert len(_warnings(caplog, "memory high")) == 1


def test_a_junk_warning_limit_falls_back_to_the_default(tmp_path, caplog, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_VIEWER_RSS_WARN_MB", "not-a-number")
    mon = _make_monitor(tmp_path, reader=FakeReader(rss=250.0))
    with caplog.at_level(logging.WARNING, logger="omniscience"):
        mon.tick(now=60.0)
    assert _warnings(caplog, "memory high") == []  # default is 400


def test_memory_growth_over_half_an_hour_warns_once(tmp_path, caplog, monkeypatch):
    monkeypatch.delenv("OMNISCIENCE_VIEWER_RSS_WARN_MB", raising=False)
    reader = FakeReader(rss=100.0, peak=100.0)
    mon = _make_monitor(tmp_path, reader=reader)
    with caplog.at_level(logging.WARNING, logger="omniscience"):
        mon.tick(now=60.0)
        reader.rss = 150.0
        mon.tick(now=600.0)    # +50 MB: under the 100 MB bar
        assert _warnings(caplog, "memory growing") == []
        reader.rss = 210.0
        mon.tick(now=1200.0)   # +110 MB within the window
        assert len(_warnings(caplog, "memory growing")) == 1
        reader.rss = 220.0
        mon.tick(now=1260.0)   # still growing, but inside the cooldown
        assert len(_warnings(caplog, "memory growing")) == 1
    assert "rose_mb=" in _warnings(caplog, "memory growing")[0]


def test_growth_older_than_the_window_does_not_warn(tmp_path, caplog, monkeypatch):
    monkeypatch.delenv("OMNISCIENCE_VIEWER_RSS_WARN_MB", raising=False)
    reader = FakeReader(rss=100.0, peak=100.0)
    mon = _make_monitor(tmp_path, reader=reader)
    with caplog.at_level(logging.WARNING, logger="omniscience"):
        mon.tick(now=60.0)
        reader.rss = 250.0
        mon.tick(now=1900.0)  # the 100 MB sample is now outside the 30-minute window
    assert _warnings(caplog, "memory growing") == []


# ---------------------------------------------------------------------------
# slow requests and unhandled errors (real middleware, real TestClient)
# ---------------------------------------------------------------------------

def test_the_slow_request_threshold_is_one_second():
    from omniscience_viewer import app as app_mod

    assert app_mod.SLOW_REQUEST_MS == 1000.0


def test_slow_request_warns_with_path_only(tmp_path, monkeypatch, caplog):
    from fastapi.testclient import TestClient
    from omniscience_viewer import app as app_mod

    monkeypatch.setattr(app_mod, "SLOW_REQUEST_MS", 5.0)
    app = app_mod.create_app(str(tmp_path / "events.db"))

    @app.get("/api/v1/slow-probe")
    def slow_probe():
        time.sleep(0.02)
        return {"ok": True}

    with caplog.at_level(logging.WARNING, logger="omniscience"):
        with TestClient(app, base_url="http://127.0.0.1") as client:
            resp = client.get("/api/v1/slow-probe?t=SUPERSECRETTOKEN")
    assert resp.status_code == 200
    slow = [r.getMessage() for r in caplog.records if "slow request" in r.getMessage()]
    assert len(slow) == 1
    assert re.search(r"slow request path=/api/v1/slow-probe ms=\d+", slow[0])
    assert "SUPERSECRETTOKEN" not in caplog.text
    assert "?" not in slow[0]  # the query string never reaches the line


def test_a_fast_request_is_not_logged(tmp_path, caplog):
    from fastapi.testclient import TestClient
    from omniscience_viewer import app as app_mod

    app = app_mod.create_app(str(tmp_path / "events.db"))
    with caplog.at_level(logging.WARNING, logger="omniscience"):
        with TestClient(app, base_url="http://127.0.0.1") as client:
            assert client.get("/api/v1/ping").status_code == 200
    assert "slow request" not in caplog.text


def test_unhandled_route_error_is_logged_with_traceback(tmp_path, caplog):
    from fastapi.testclient import TestClient
    from omniscience_viewer import app as app_mod

    app = app_mod.create_app(str(tmp_path / "events.db"))

    @app.get("/api/v1/boom")
    def boom():
        raise RuntimeError("probe exploded")

    with caplog.at_level(logging.ERROR, logger="omniscience"):
        with TestClient(app, base_url="http://127.0.0.1") as client:
            with pytest.raises(RuntimeError):
                client.get("/api/v1/boom?t=SUPERSECRETTOKEN")
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert errors, "an unhandled route error must reach the log at ERROR"
    assert "path=/api/v1/boom" in caplog.text
    assert "Traceback" in caplog.text
    assert "RuntimeError: probe exploded" in caplog.text
    assert "SUPERSECRETTOKEN" not in caplog.text


def test_live_feed_unexpected_error_is_logged_with_traceback(tmp_path, monkeypatch, caplog):
    from starlette.websockets import WebSocketDisconnect
    from omniscience_viewer import app as app_mod

    app = app_mod.create_app(str(tmp_path / "events.db"))
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", None) == "/api/v1/live")

    class Socket:
        headers = {"host": "127.0.0.1"}

        async def accept(self, **kwargs):
            pass

        async def send_json(self, data):
            raise RuntimeError("feed exploded")

        async def close(self, **kwargs):
            pass

    async def run_thread(*args):
        return ([{"rowid": 1, "session_id": "root"}], None)

    async def no_sleep(delay):
        raise WebSocketDisconnect()  # safety net; the send above raises first

    monkeypatch.setattr(app_mod.asyncio, "to_thread", run_thread)
    monkeypatch.setattr(app_mod.asyncio, "sleep", no_sleep)
    with caplog.at_level(logging.ERROR, logger="omniscience"):
        asyncio.run(endpoint(Socket(), root="root", after=0))
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert errors, "an unexpected live-feed error must reach the log at ERROR"
    assert "Traceback" in caplog.text
    assert "RuntimeError: feed exploded" in caplog.text


# ---------------------------------------------------------------------------
# viewer.log rotation (at viewer start, Windows-safe)
# ---------------------------------------------------------------------------

def test_the_cap_is_five_megabytes_with_two_backups():
    from omniscience import viewer_launcher as launcher

    assert launcher.LOG_MAX_BYTES == 5 * 1024 * 1024
    assert launcher.LOG_BACKUPS == 2


def test_oversized_viewer_log_rotates_at_start(tmp_path):
    from omniscience import viewer_launcher as launcher

    log = tmp_path / "viewer.log"
    log.write_bytes(b"x" * (launcher.LOG_MAX_BYTES + 1))
    assert launcher.rotate_viewer_log(str(tmp_path)) is True
    assert not log.exists()
    assert (tmp_path / "viewer.log.1").stat().st_size == launcher.LOG_MAX_BYTES + 1


def test_rotation_keeps_two_old_files_and_drops_the_oldest(tmp_path):
    from omniscience import viewer_launcher as launcher

    (tmp_path / "viewer.log").write_bytes(b"n" * (launcher.LOG_MAX_BYTES + 1))
    (tmp_path / "viewer.log.1").write_bytes(b"o" * 10)
    (tmp_path / "viewer.log.2").write_bytes(b"p" * 20)
    assert launcher.rotate_viewer_log(str(tmp_path)) is True
    assert (tmp_path / "viewer.log.1").read_bytes() == b"n" * (launcher.LOG_MAX_BYTES + 1)
    assert (tmp_path / "viewer.log.2").read_bytes() == b"o" * 10
    assert not (tmp_path / "viewer.log.3").exists()


def test_small_log_is_left_alone(tmp_path):
    from omniscience import viewer_launcher as launcher

    log = tmp_path / "viewer.log"
    log.write_bytes(b"x" * 100)
    assert launcher.rotate_viewer_log(str(tmp_path)) is False
    assert log.read_bytes() == b"x" * 100
    assert not (tmp_path / "viewer.log.1").exists()


def test_missing_log_is_not_an_error(tmp_path):
    from omniscience import viewer_launcher as launcher

    assert launcher.rotate_viewer_log(str(tmp_path)) is False


def test_rotation_never_raises_when_rename_fails(tmp_path, monkeypatch):
    from omniscience import viewer_launcher as launcher

    log = tmp_path / "viewer.log"
    log.write_bytes(b"x" * (launcher.LOG_MAX_BYTES + 1))

    def locked(*args, **kwargs):
        raise OSError("file in use")  # Windows: an open file cannot be renamed

    monkeypatch.setattr(launcher.os, "replace", locked)
    assert launcher.rotate_viewer_log(str(tmp_path)) is False
    assert log.exists()  # a failed rotation keeps the log, never crashes the start


def test_ensure_viewer_rotates_before_spawning(tmp_path, monkeypatch):
    from omniscience import viewer_launcher as launcher

    db = tmp_path / "events.db"
    db.write_bytes(b"")
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "viewer.log").write_bytes(b"x" * (launcher.LOG_MAX_BYTES + 1))
    monkeypatch.setenv("OMNISCIENCE_VIEWER_URL", "http://127.0.0.1:1")  # nothing answers
    monkeypatch.delenv("OMNISCIENCE_VIEWER_AUTOSTART", raising=False)

    def no_spawn(*args, **kwargs):
        raise OSError("no spawn in tests")

    monkeypatch.setattr(launcher.subprocess, "Popen", no_spawn)
    result = launcher.ensure_viewer(str(db), log_dir=str(log_dir), autostart=True)
    assert result["started"] is False
    assert "spawn failed" in result["reason"]
    # The oversized log was rolled before the (refused) spawn opened it: the old content is
    # in .1, and the launcher pre-created a fresh empty viewer.log for the next start.
    assert (log_dir / "viewer.log.1").stat().st_size == launcher.LOG_MAX_BYTES + 1
    assert (log_dir / "viewer.log").stat().st_size == 0


# ---------------------------------------------------------------------------
# wiring: the app carries the monitor, and both viewer copies agree
# ---------------------------------------------------------------------------

def test_create_app_wires_the_health_monitor(tmp_path):
    from omniscience_viewer import health as health_mod
    from omniscience_viewer.app import create_app

    app = create_app(str(tmp_path / "events.db"))
    assert isinstance(app.state.health_monitor, health_mod.HealthMonitor)


def test_both_viewer_copies_carry_the_same_health_module():
    a = (ROOT / "viewer" / "omniscience_viewer" / "health.py").read_bytes()
    b = (ROOT / "viewer_app" / "omniscience_viewer" / "health.py").read_bytes()
    assert a == b


def test_cached_session_count_reads_the_fold(tmp_path):
    from omniscience_viewer import db as db_mod

    db_mod.clear_caches()
    path = str(tmp_path / "events.db")
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE events (rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, "
        "boot_id TEXT, seq INTEGER, ts REAL, kind TEXT, session_id TEXT, "
        "parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, tool_call_id TEXT, "
        "subagent_id TEXT, status TEXT, attrs TEXT)"
    )
    for sid in ("sess-a", "sess-b"):
        con.execute(
            "INSERT INTO events (ts, kind, session_id, parent_session_id, status, attrs) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (1.0, "turn.start", sid, "", "ok", "{}"),
        )
    con.commit()
    con.close()
    try:
        assert db_mod.cached_session_count(path) == 0  # nothing folded yet
        rows, error = db_mod.list_sessions_checked(path, 100)
        assert error is None
        assert len(rows) == 2
        assert db_mod.cached_session_count(path) == 2
    finally:
        db_mod.clear_caches()
