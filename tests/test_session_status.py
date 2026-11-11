"""A chat's verdict must describe its latest turn, not its worst moment.

Every long chat used to read "finished with errors" once anything inside it had failed — an
occasional 429 or a rejected tool call six hours earlier branded the chat for good.
"""

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import db as db_mod  # noqa: E402

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


def _db(tmp_path: Path):
    con = sqlite3.connect(str(tmp_path / "events.db"))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    return con


def _add(con, ts, kind, session, attrs=None, status=None, turn="t1"):
    con.execute(
        "INSERT INTO events (ts, kind, session_id, status, attrs, turn_id) VALUES (?, ?, ?, ?, ?, ?)",
        (ts, kind, session, status, json.dumps(attrs or {}), turn),
    )


def _status(tmp_path, con) -> str:
    con.commit()
    sessions = db_mod.list_sessions(str(tmp_path / "events.db"))
    return next(s["status"] for s in sessions if s["id"] == "s1")


def test_a_recovered_chat_reads_as_finished(tmp_path):
    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1", {"model": "m"})
    _add(con, 2, "llm.request", "s1", {"model": "m"})
    _add(con, 3, "llm.error", "s1", {"error_type": "rate_limit"}, status="error")
    _add(con, 4, "llm.request", "s1", {"model": "m"})
    _add(con, 5, "llm.response", "s1", {"usage": {"input": 10, "output": 2}})
    _add(con, 6, "session.end", "s1", {})
    assert _status(tmp_path, con) == "ok"


def test_a_chat_whose_latest_turn_failed_still_reads_as_failed(tmp_path):
    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1", {"model": "m"})
    _add(con, 2, "llm.request", "s1", {"model": "m"})
    _add(con, 3, "llm.response", "s1", {"usage": {"input": 10, "output": 2}})
    _add(con, 4, "llm.request", "s1", {"model": "m"})
    _add(con, 5, "llm.error", "s1", {"error_type": "rate_limit"}, status="error")
    assert _status(tmp_path, con) == "error"


def test_an_error_earlier_in_the_same_turn_still_counts(tmp_path):
    """The chat list must not say "finished" while the chat's own headline counts a failure."""
    con = _db(tmp_path)
    _add(con, 1, "session.start", "s1", {"model": "m"}, turn="t1")
    _add(con, 2, "llm.request", "s1", {"model": "m"}, turn="t1")
    _add(con, 3, "tool.end", "s1", {"tool_name": "terminal"}, status="error", turn="t1")
    _add(con, 4, "llm.request", "s1", {"model": "m", "api_call_count": 2}, turn="t1")
    assert _status(tmp_path, con) == "error"


def test_a_retry_that_succeeds_clears_the_failure(tmp_path):
    con = _db(tmp_path)
    _add(con, 1, "llm.request", "s1", {"model": "m"}, turn="t1")
    _add(con, 2, "llm.error", "s1", {"error_type": "RateLimitError"}, status="error", turn="t1")
    _add(con, 3, "llm.response", "s1", {"usage": {"input": 10, "output": 2}}, turn="t1")
    _add(con, 4, "session.end", "s1", {"completed": True}, status="completed", turn="t1")
    assert _status(tmp_path, con) == "ok"
