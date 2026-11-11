"""The session list must know the context as it stands now, not only the historical peak.

After a compaction the peak stays high forever, so a chat that was just compacted would keep
ranking as the most expensive one. `prompt_now` is the newest prompt, which is what the next
message actually pays for.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer import db as vdb

ROOT = "local-" + "ab12" * 16

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


def _db(tmp_path: Path, prompts: list[int]) -> str:
    path = str(tmp_path / "events.db")
    con = sqlite3.connect(path)
    con.execute(EVENTS_SCHEMA)
    for i, prompt in enumerate(prompts):
        con.execute(
            "INSERT INTO events (kind, session_id, status, ts, attrs) VALUES (?,?,?,?,?)",
            (
                "llm.response",
                ROOT,
                "ok",
                1000 + i,
                json.dumps({"usage": {"prompt_tokens": prompt, "output_tokens": 10}, "model": "m"}),
            ),
        )
    con.commit()
    con.close()
    return path


def test_prompt_now_is_the_latest_prompt_and_prompt_max_is_the_peak(tmp_path):
    rows, error = vdb.list_sessions_checked(_db(tmp_path, [10_000, 300_000, 40_000]))
    assert error is None
    (session,) = rows
    assert session["prompt_max"] == 300_000
    assert session["prompt_now"] == 40_000


def test_a_compaction_is_counted_and_prompt_now_follows_it(tmp_path):
    # A drop of more than 1000 tokens that also falls under 75% of the previous prompt.
    rows, error = vdb.list_sessions_checked(_db(tmp_path, [400_000, 410_000, 60_000]))
    assert error is None
    (session,) = rows
    assert session["compactions"] == 1
    assert session["prompt_now"] == 60_000
    assert session["prompt_max"] == 410_000


def test_prompt_now_is_zero_when_nothing_was_recorded(tmp_path):
    rows, error = vdb.list_sessions_checked(_db(tmp_path, []))
    assert error is None
    assert rows == []
