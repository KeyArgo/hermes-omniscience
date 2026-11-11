"""Concerns are counted, not listed: a summary page must never be an audit log."""

import json
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import concerns  # noqa: E402

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


def build(tmp_path: Path) -> str:
    now = time.time()
    db = tmp_path / "events.db"
    con = sqlite3.connect(str(db))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    rows = [
        (now - 900, "tool.end", "s1", "ok", {"tool_name": "browser_exec"}),
        (now - 800, "tool.end", "s1", "ok", {"tool_name": "browser_exec"}),
        (now - 700, "tool.end", "s2", "ok", {"tool_name": "browser_exec"}),
        (now - 600, "tool.end", "s1", "ok", {"tool_name": "web_search"}),
        (now - 500, "tool.end", "s1", "error", {"tool_name": "terminal", "error_type": "Timeout"}),
        (now - 400, "tool.end", "s2", "error", {"tool_name": "terminal", "error_type": "Timeout"}),
        (now - 300, "tool.end", "s1", "error", {"tool_name": "apply_patch", "error_type": "NotFound"}),
    ]
    for i, (ts, kind, session, status, attrs) in enumerate(rows):
        con.execute(
            "INSERT INTO events (event_id, ts, kind, session_id, turn_id, status, attrs) VALUES (?,?,?,?,?,?,?)",
            (f"e{i}", ts, kind, session, "t1", status, json.dumps(attrs)),
        )
    con.commit()
    con.close()
    return str(db)


def test_the_same_problem_is_one_row_with_a_count(tmp_path):
    db = build(tmp_path)
    report = concerns.build_concerns(db, days=1)
    failures = [item for item in report["items"] if item["kind"] == "failure"]
    timeouts = [item for item in failures if item["error_type"] == "Timeout"]
    assert len(timeouts) == 1
    assert timeouts[0]["count"] == 2
    assert timeouts[0]["sessions"] == 2


def test_privacy_calls_are_grouped_by_class_not_by_call(tmp_path):
    db = build(tmp_path)
    report = concerns.build_concerns(db, days=1)
    browser = [item for item in report["items"] if item.get("cls") == "browser"]
    assert len(browser) == 1
    assert browser[0]["count"] == 3
    assert browser[0]["sessions"] == 2
    assert browser[0]["tools"] == ["browser_exec"]
    assert report["counts"]["privacy"] == 4
    assert report["counts"]["failures"] == 3


def test_an_empty_window_is_empty_not_broken(tmp_path):
    db = build(tmp_path)
    report = concerns.build_concerns(db, days=1 / 24, now=time.time() + 7200)
    assert report["items"] == []
    assert report["counts"] == {"privacy": 0, "failures": 0}
