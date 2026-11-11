"""Privacy controls for the Omniscience plugin.

This module manages what metadata is recorded about agent activity,
how users can pause/resume recording, and how to delete recordings.
"""

import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("omniscience")

PAUSED_FILE = "paused-sessions.json"
# Marker file used to coordinate a recording barrier across Hermes processes.
BARRIER_FILE = "recording-barrier.json"


class PausedSessions:
    """Track which sessions have recording paused.

    Paused sessions are stored in a JSON file next to the database.
    The list is cached in memory and re-read from disk at most every 2 seconds.
    """

    def __init__(self, db_path: str):
        self._db_path = db_path
        self._paused_file = os.path.join(os.path.dirname(db_path), PAUSED_FILE)
        self._cache: set[str] | None = None
        self._cache_time: float = 0.0
        self._cache_ttl = 2.0  # seconds

    def _read_paused(self) -> set[str]:
        """Read paused session IDs from disk. Never raises."""
        try:
            if not os.path.exists(self._paused_file):
                return set()
            with open(self._paused_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return {str(sid) for sid in data if isinstance(sid, str)}
            return set()
        except Exception:
            return set()

    def _write_paused(self, paused: set[str]) -> bool:
        """Write paused session IDs to disk atomically. Returns False on failure."""
        try:
            # Every paused chat is kept: dropping one would silently resume its recording.
            ids = sorted(paused)
            tmp_path = self._paused_file + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(ids, f)
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, self._paused_file)
            return True
        except Exception:
            return False

    def is_paused(self, session_id: str) -> bool:
        """Check if a session is paused. Never raises, returns False on error."""
        try:
            now = time.monotonic()
            if self._cache is None or (now - self._cache_time) >= self._cache_ttl:
                self._cache = self._read_paused()
                self._cache_time = now
            return session_id in self._cache
        except Exception:
            return False

    def pause(self, session_id: str) -> bool:
        """Pause recording for a session. Returns False if the setting could not be saved."""
        try:
            current = self._read_paused()
            current.add(session_id)
            if not self._write_paused(current):
                return False
            self._cache = current
            self._cache_time = time.monotonic()
            return True
        except Exception:
            return False

    def resume(self, session_id: str) -> bool:
        """Resume recording for a session. Returns False if the setting could not be saved."""
        try:
            current = self._read_paused()
            current.discard(session_id)
            if not self._write_paused(current):
                return False
            self._cache = current
            self._cache_time = time.monotonic()
            return True
        except Exception:
            return False


def _descendant_sessions(cursor: sqlite3.Cursor, session_id: str) -> set[str]:
    """Recursively collect every session whose parent chain leads to *session_id*."""
    seen: set[str] = set()
    frontier = [session_id]
    while frontier:
        current = frontier.pop()
        cursor.execute(
            "SELECT DISTINCT session_id FROM events WHERE parent_session_id = ?",
            (current,),
        )
        for (child,) in cursor.fetchall():
            if child and child not in seen:
                seen.add(child)
                frontier.append(child)
    return seen


def _set_barrier(db_path: str, active: bool) -> None:
    """Cross-process recording barrier: writers check this before submitting."""
    try:
        path = os.path.join(os.path.dirname(db_path), BARRIER_FILE)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"active": bool(active), "ts": time.time()}, f)
        os.replace(tmp, path)
    except Exception:
        log.debug("omniscience: could not write the recording barrier", exc_info=True)


def _wait_barrier_clear(db_path: str, timeout: float = 2.0) -> None:
    """Best-effort wait for other writers to observe the barrier (they flush on seeing it)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.05)
        break


def forget_session(db_path: str, session_id: str) -> int:
    """Delete all events for a session and its (recursively nested) helper sessions.

    Coordinates a recording barrier across Hermes processes so events queued in another
    writer are flushed before deletion, then deletes the whole descendant tree.

    Returns the number of deleted rows, or -1 when the database exists but could not be
    written (a failed delete must never be reported as "deleted 0").
    """
    if not os.path.exists(db_path):
        return 0

    # Raise the barrier so other writers stop submitting and flush their queues.
    _set_barrier(db_path, True)
    try:
        _wait_barrier_clear(db_path)

        conn = sqlite3.connect(db_path, timeout=10)
        try:
            cursor = conn.cursor()

            # Recursively identify all descendant sessions (helpers of helpers, etc.).
            descendants = _descendant_sessions(cursor, session_id)
            all_ids = {session_id} | descendants

            placeholders = ",".join("?" * len(all_ids))
            params = list(all_ids)

            cursor.execute(
                f"""
                DELETE FROM events
                WHERE session_id IN ({placeholders})
                   OR parent_session_id IN ({placeholders})
                """,
                params + params,
            )
            deleted_count = cursor.rowcount

            conn.commit()

            # Best-effort WAL checkpoint
            try:
                cursor.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                log.debug("omniscience: checkpoint after delete failed", exc_info=True)

            return deleted_count
        finally:
            conn.close()
    except Exception:
        log.warning(
            "omniscience: could not delete the recording for session %s", session_id, exc_info=True
        )
        return -1
    finally:
        _set_barrier(db_path, False)


def stored_summary(db_path: str, session_id: str | None) -> dict[str, Any]:
    """Get a summary of stored data. Best-effort, never raises."""
    result = {
        "events_total": 0,
        "events_this_chat": 0,
        "oldest_ts": None,
        "db_bytes": 0,
    }

    try:
        if not os.path.exists(db_path):
            return result

        result["db_bytes"] = os.path.getsize(db_path)

        conn = sqlite3.connect(db_path, timeout=10)
        cursor = conn.cursor()

        # Total events
        cursor.execute("SELECT COUNT(*) FROM events")
        result["events_total"] = cursor.fetchone()[0]

        # Events for this chat
        if session_id is not None:
            cursor.execute(
                "SELECT COUNT(*) FROM events WHERE session_id = ?",
                (session_id,),
            )
            result["events_this_chat"] = cursor.fetchone()[0]

        # Oldest timestamp
        cursor.execute("SELECT MIN(ts) FROM events")
        row = cursor.fetchone()
        if row and row[0] is not None:
            result["oldest_ts"] = float(row[0])

        conn.close()
    except Exception:
        log.debug("omniscience: could not read the stored counts for %s", db_path, exc_info=True)

    return result


PRIVACY_TEXT = """\
What Omniscience keeps:
  - Which steps happened and when (messages started/ended, model calls,
    tool runs, helper agents, background model calls, skills used)
  - Timings, token counts, model and provider names
  - Tool names and the NAMES of tool settings
  - Error types and codes

What it never keeps:
  - What you or the AI wrote, prompts, tool inputs and outputs
  - File contents, commands, error message text, API keys

Where it lives:
  - One file on this computer: {db_path}
  - The recording itself is never sent anywhere by Omniscience
  - The viewer only answers this computer and needs a per-launch key

Live notices:
  - By default notices post short step facts (model, provider, tool names)
    into the chat you are using, but only on local surfaces (cli, tui,
    desktop, local, gui, oneshot)
  - OMNISCIENCE_NOTICES=all also posts them on messaging platforms
  - OMNISCIENCE_NOTICES=0 turns notices off

Your controls:
  - /omni off   — stop recording this chat
  - /omni on    — resume recording this chat
  - /omni forget — delete this chat's recording
  - OMNISCIENCE_NOTICES=0 — no live notices
  - Disable the plugin to stop everything
"""


def privacy_report(db_path: str, session_id: str, paused: bool) -> str:
    """Generate a human-readable privacy report.

    Args:
        db_path: Path to the SQLite database.
        session_id: The current session ID.
        paused: Whether recording is currently paused for this session.

    Returns:
        A formatted string with privacy information and current status.
    """
    # Format the privacy text with the db path
    text = PRIVACY_TEXT.format(db_path=db_path)

    # Status line
    status = "off" if paused else "on"
    text += f"\nRecording this chat: {status}\n"

    # Summary numbers
    summary = stored_summary(db_path, session_id)

    events_this_chat = summary["events_this_chat"]
    events_total = summary["events_total"]
    db_bytes = summary["db_bytes"]

    # Format bytes nicely
    if db_bytes < 1024:
        size_str = f"{db_bytes} B"
    elif db_bytes < 1024 * 1024:
        size_str = f"{db_bytes / 1024:.1f} KB"
    else:
        size_str = f"{db_bytes / (1024 * 1024):.1f} MB"

    # Format numbers with commas
    this_chat_str = f"{events_this_chat:,}"
    total_str = f"{events_total:,}"

    text += f"\nThis chat: {this_chat_str} recorded steps.\n"
    text += f"All chats: {total_str} steps, {size_str}.\n"

    return text
