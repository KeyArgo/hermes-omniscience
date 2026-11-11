"""Regression tests for two step-export defects.

F1: a model call that only ever errored (an ``llm.error`` with no matching ``llm.response``)
    was emitted twice — once by the model-call loop (kind=``model_call``, status=error) and
    again by the dedicated unanswered-errors loop (kind=``error``). One failure, two rows.

F2: a helper's final status and run duration live on ``subagent.stop`` (the recorder never puts
    ``child_status``/``duration_ms`` on ``subagent.start`` — see sanitize._normalize_subagent_*).
    The steps export read them from ``subagent.start``, so every real helper row reported
    status=ok with a blank duration, even for a helper that failed.
"""

import csv
import io
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer.export import export_steps  # noqa: E402

_COLS = (
    "event_id, schema, boot_id, seq, ts, kind, session_id, parent_session_id, turn_id, "
    "api_request_id, tool_call_id, subagent_id, status, attrs"
)


def _make_db(path: Path, rows: list[tuple]) -> None:
    con = sqlite3.connect(str(path))
    con.execute(
        "CREATE TABLE events (rowid INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, schema TEXT, "
        "boot_id TEXT, seq INTEGER, ts REAL, kind TEXT, session_id TEXT, parent_session_id TEXT, "
        "turn_id TEXT, api_request_id TEXT, tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT)"
    )
    con.executemany(
        f"INSERT INTO events ({_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
    )
    con.commit()
    con.close()


def _step_rows(text: str) -> list[dict]:
    lines = [l for l in text.lstrip("﻿").split("\r\n") if l.strip()]
    header = next(csv.reader(io.StringIO(lines[0])))
    out = []
    for line in lines[1:]:
        out.append(dict(zip(header, next(csv.reader(io.StringIO(line))))))
    return out


def test_a_response_less_failed_call_is_a_single_error_row(tmp_path):
    db = tmp_path / "e.db"
    _make_db(db, [
        ("s1", "v1", "b1", 1, 1000.0, "session.start", "chat1", None, None, None, None, None, None,
         '{"model":"gpt-4"}'),
        ("t1", "v1", "b1", 2, 1001.0, "turn.start", "chat1", None, "t1", None, None, None, None, '{}'),
        ("rq", "v1", "b1", 3, 1002.0, "llm.request", "chat1", None, "t1", "reqX", None, None, None,
         '{"model":"gpt-4","provider":"openai","retry_count":0}'),
        # Only an error, never a response: the call failed outright.
        ("er", "v1", "b1", 4, 1003.0, "llm.error", "chat1", None, "t1", "reqX", None, None, "error",
         '{"duration_s":1.0,"reason":"overloaded","status_code":529,"error_type":"overloaded"}'),
    ])
    rows = _step_rows(export_steps(str(db), "chat1"))
    kinds = [r["kind"] for r in rows]
    # Exactly one row for the failed call, and it is the error row — not also a model_call row.
    assert kinds.count("error") == 1, rows
    assert kinds.count("model_call") == 0, rows


def test_a_failed_helper_is_reported_as_error_with_its_duration(tmp_path):
    db = tmp_path / "h.db"
    _make_db(db, [
        ("s1", "v1", "b1", 1, 1000.0, "session.start", "chat1", None, None, None, None, None, None,
         '{"model":"gpt-4"}'),
        ("t1", "v1", "b1", 2, 1001.0, "turn.start", "chat1", None, "t2", None, None, None, None, '{}'),
        # Realistic subagent.start: it names the child but carries no status or duration yet.
        ("ss", "v1", "b1", 3, 1002.0, "subagent.start", "chat1", None, "t2", None, None, "subA", None,
         '{"child_session_id":"helperX","role":"worker"}'),
        # The helper failed; status and duration are reported on subagent.stop (parent thread).
        ("se", "v1", "b1", 4, 1009.0, "subagent.stop", "chat1", None, None, None, None, "subA", "error",
         '{"child_session_id":"helperX","child_status":"error","duration_ms":7000}'),
    ])
    rows = _step_rows(export_steps(str(db), "chat1"))
    helpers = [r for r in rows if r["kind"] == "helper"]
    assert len(helpers) == 1, rows
    assert helpers[0]["status"] == "error", helpers
    assert helpers[0]["duration_s"] == "7.000", helpers
