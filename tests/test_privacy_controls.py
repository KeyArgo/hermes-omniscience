"""Tests for the Omniscience privacy controls."""

import sys
import json
import os
import sqlite3
import stat

import pytest

from omniscience.privacy import (
    PausedSessions,
    forget_session,
    privacy_report,
    stored_summary,
)


def _create_db(db_path: str) -> None:
    """Create a test database with the events schema."""
    conn = sqlite3.connect(db_path)
    conn.execute("""
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
    """)
    conn.commit()
    conn.close()


def _insert_event(
    db_path: str,
    session_id: str,
    parent_session_id: str | None = None,
    ts: float = 1000.0,
) -> None:
    """Insert a test event into the database."""
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO events (event_id, schema, boot_id, seq, ts, kind,
                            session_id, parent_session_id, turn_id,
                            api_request_id, tool_call_id, subagent_id,
                            status, attrs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"evt-{session_id}-{ts}",
            "v1",
            "boot-1",
            1,
            ts,
            "test",
            session_id,
            parent_session_id,
            "turn-1",
            None,
            None,
            None,
            "ok",
            "{}",
        ),
    )
    conn.commit()
    conn.close()


class TestPausedSessions:
    """Tests for PausedSessions class."""

    def test_pause_resume_persistence(self, tmp_path):
        """Paused sessions persist across instances."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        # Pause a session
        ps1 = PausedSessions(db_path)
        ps1.pause("session-1")
        assert ps1.is_paused("session-1") is True
        assert ps1.is_paused("session-2") is False

        # Create a new instance and verify persistence
        ps2 = PausedSessions(db_path)
        assert ps2.is_paused("session-1") is True
        assert ps2.is_paused("session-2") is False

        # Resume and verify
        ps2.resume("session-1")
        assert ps2.is_paused("session-1") is False

        # Verify persistence of resume
        ps3 = PausedSessions(db_path)
        assert ps3.is_paused("session-1") is False

    @pytest.mark.skipif(sys.platform == "win32", reason="Windows has no POSIX file modes; the owner-only ACL is the OS's job there")
    def test_file_mode_0600(self, tmp_path):
        """Paused sessions file has mode 0600."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        ps = PausedSessions(db_path)
        ps.pause("session-1")

        paused_file = os.path.join(os.path.dirname(db_path), "paused-sessions.json")
        assert os.path.exists(paused_file)

        mode = os.stat(paused_file).st_mode
        # Check that owner has read/write, no group/other access
        assert mode & stat.S_IRUSR != 0
        assert mode & stat.S_IWUSR != 0
        assert mode & stat.S_IRGRP == 0
        assert mode & stat.S_IWGRP == 0
        assert mode & stat.S_IROTH == 0
        assert mode & stat.S_IWOTH == 0

    def test_is_paused_never_raises_on_corrupt_file(self, tmp_path):
        """is_paused returns False on corrupt file, never raises."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        paused_file = os.path.join(os.path.dirname(db_path), "paused-sessions.json")

        # Write corrupt data
        with open(paused_file, "w") as f:
            f.write("this is not valid json {{{")

        ps = PausedSessions(db_path)
        # Should not raise, should return False
        assert ps.is_paused("session-1") is False

        # Write invalid structure
        with open(paused_file, "w") as f:
            json.dump({"not": "a list"}, f)

        ps2 = PausedSessions(db_path)
        assert ps2.is_paused("session-1") is False

    def test_every_paused_chat_is_kept(self, tmp_path):
        # A cap would silently resume recording for whichever chat it dropped.
        db = str(tmp_path / "events.db")
        ps = PausedSessions(db)
        for i in range(600):
            ps.pause(f"session-{i}")
        fresh = PausedSessions(db)
        assert all(fresh.is_paused(f"session-{i}") for i in range(600))

    def test_deletes_chat_and_helpers(self, tmp_path):
        """forget_session deletes the chat, its helpers, and leaves others."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        # Insert events for main session
        _insert_event(db_path, "main-session", ts=1000.0)
        _insert_event(db_path, "main-session", ts=1001.0)

        # Insert events for helper sessions (parent is main-session)
        _insert_event(db_path, "helper-1", parent_session_id="main-session", ts=1002.0)
        _insert_event(db_path, "helper-2", parent_session_id="main-session", ts=1003.0)

        # Insert events for another unrelated session
        _insert_event(db_path, "other-session", ts=1004.0)
        _insert_event(db_path, "other-helper", parent_session_id="other-session", ts=1005.0)

        # Verify initial counts
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM events")
        assert cursor.fetchone()[0] == 6
        conn.close()

        # Forget the main session
        deleted = forget_session(db_path, "main-session")

        # Should have deleted 4 rows: 2 main + 2 helpers
        assert deleted == 4

        # Verify remaining events
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT session_id FROM events ORDER BY session_id")
        remaining = [row[0] for row in cursor.fetchall()]
        conn.close()

        assert "main-session" not in remaining
        assert "helper-1" not in remaining
        assert "helper-2" not in remaining
        assert "other-session" in remaining
        assert "other-helper" in remaining

    def test_returns_count(self, tmp_path):
        """forget_session returns the number of deleted rows."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        _insert_event(db_path, "session-a", ts=1000.0)
        _insert_event(db_path, "session-a", ts=1001.0)
        _insert_event(db_path, "session-b", ts=1002.0)

        deleted = forget_session(db_path, "session-a")
        assert deleted == 2

    def test_missing_db_returns_zero(self, tmp_path):
        """forget_session returns 0 for missing database."""
        db_path = str(tmp_path / "nonexistent.db")
        deleted = forget_session(db_path, "any-session")
        assert deleted == 0


class TestStoredSummary:
    """Tests for stored_summary function."""

    def test_basic_summary(self, tmp_path):
        """stored_summary returns correct counts."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        _insert_event(db_path, "session-1", ts=1000.0)
        _insert_event(db_path, "session-1", ts=1001.0)
        _insert_event(db_path, "session-2", ts=1002.0)

        summary = stored_summary(db_path, "session-1")

        assert summary["events_total"] == 3
        assert summary["events_this_chat"] == 2
        assert summary["oldest_ts"] == 1000.0
        assert summary["db_bytes"] > 0

    def test_missing_db(self, tmp_path):
        """stored_summary handles missing database gracefully."""
        db_path = str(tmp_path / "nonexistent.db")
        summary = stored_summary(db_path, "session-1")

        assert summary["events_total"] == 0
        assert summary["events_this_chat"] == 0
        assert summary["oldest_ts"] is None
        assert summary["db_bytes"] == 0


class TestPrivacyReport:
    """Tests for privacy_report function."""

    def test_contains_db_path(self, tmp_path):
        """privacy_report contains the database path."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        report = privacy_report(db_path, "session-1", paused=False)
        assert db_path in report

    def test_contains_on_off(self, tmp_path):
        """privacy_report contains 'on' or 'off' for recording status."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        report_on = privacy_report(db_path, "session-1", paused=False)
        assert "Recording this chat: on" in report_on

        report_off = privacy_report(db_path, "session-1", paused=True)
        assert "Recording this chat: off" in report_off

    def test_contains_summary_numbers(self, tmp_path):
        """privacy_report contains formatted summary numbers."""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)

        for i in range(263):
            _insert_event(db_path, "session-1", ts=1000.0 + i)

        report = privacy_report(db_path, "session-1", paused=False)
        assert "263 recorded steps" in report
        assert "All chats:" in report

    def test_forget_reports_a_failure_instead_of_zero_deleted(self, tmp_path):
        """A delete that failed said "0 deleted", which reads as "there was nothing to delete".

        Before the fix the exception was swallowed and 0 returned, so /omni forget confirm
        told the user their recording was gone (0 steps) while every row was still there.
        """
        db_path = str(tmp_path / "broken.db")
        with open(db_path, "wb") as fh:
            fh.write(b"this is not a sqlite database")

        deleted = forget_session(db_path, "session-a")
        assert deleted == -1, "a failed delete must be distinguishable from 'nothing matched'"
