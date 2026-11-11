"""Who refused the call, and which model was slow: attribution on the delays page.

The page answers two questions that a bare model name cannot: *is this provider unhealthy*
(a rate limit belongs to the account) and *which model name is the slow one*. Before this,
the endpoint keyed only on the response's model name and dropped every failure from
``llm.error``, so a 429 storm and its retries left no trace on the page the user was reading.
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


def make_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(path))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    return con


def add(con, ts, kind, session, attrs, status=None):
    con.execute(
        "INSERT INTO events (ts, kind, session_id, status, attrs) VALUES (?, ?, ?, ?, ?)",
        (ts, kind, session, status, json.dumps(attrs)),
    )


def test_an_error_is_attributed_to_the_request_that_was_interrupted(tmp_path):
    db = tmp_path / "events.db"
    con = make_db(db)
    add(con, 100, "llm.request", "s1", {"model": "m-1", "provider": "nous"})
    add(con, 104, "llm.error", "s1", {"reason": "rate_limit", "status_code": 429}, status="error")
    add(con, 106, "llm.response", "s1", {"response_model": "m-1", "duration_s": 4.0, "usage": {}})
    con.commit()
    con.close()

    rows = db_mod.latency_by_model(str(db))
    assert len(rows) == 1
    row = rows[0]
    assert row["provider"] == "nous"
    assert row["model"] == "m-1"
    assert row["rate_limited"] == 1
    assert row["errors"] == 1


def test_a_rate_limit_reason_without_a_status_code_still_counts(tmp_path):
    db = tmp_path / "events.db"
    con = make_db(db)
    add(con, 100, "llm.request", "s1", {"model": "m-1", "provider": "p"})
    add(con, 101, "llm.error", "s1", {"reason": "rate limit exceeded"}, status="error")
    con.commit()
    con.close()

    row = db_mod.latency_by_model(str(db))[0]
    assert row["rate_limited"] == 1
    assert row["timeouts"] == 0


def test_a_timeout_is_not_folded_into_rate_limits(tmp_path):
    db = tmp_path / "events.db"
    con = make_db(db)
    add(con, 100, "llm.request", "s1", {"model": "m-1", "provider": "p"})
    add(con, 130, "llm.error", "s1", {"reason": "timeout", "error_type": "APIConnectionError"})
    con.commit()
    con.close()

    row = db_mod.latency_by_model(str(db))[0]
    assert row["timeouts"] == 1
    assert row["rate_limited"] == 0
    assert row["errors"] == 1


def test_an_error_with_no_request_before_it_is_still_reported(tmp_path):
    db = tmp_path / "events.db"
    con = make_db(db)
    add(con, 100, "llm.error", "orphan", {"reason": "boom", "status_code": 500})
    con.commit()
    con.close()

    rows = db_mod.latency_by_model(str(db))
    assert len(rows) == 1
    assert rows[0]["provider"] == "unknown"
    assert rows[0]["other_errors"] == 1


def test_a_retry_is_counted_on_the_request_that_needed_it(tmp_path):
    db = tmp_path / "events.db"
    con = make_db(db)
    add(con, 100, "llm.request", "s1", {"model": "m-1", "provider": "p", "retry_count": 0})
    add(con, 110, "llm.request", "s1", {"model": "m-1", "provider": "p", "retry_count": 2})
    con.commit()
    con.close()

    row = db_mod.latency_by_model(str(db))[0]
    assert row["retried"] == 1


def test_a_compaction_is_attributed_to_the_model_that_saw_it(tmp_path):
    db = tmp_path / "events.db"
    con = make_db(db)
    add(con, 100, "llm.request", "s1", {"model": "big", "provider": "p"})
    add(con, 101, "llm.response", "s1", {"response_model": "big", "duration_s": 1.0,
                                        "usage": {"prompt_tokens": 300_000}})
    add(con, 102, "llm.response", "s1", {"response_model": "big", "duration_s": 1.0,
                                        "usage": {"prompt_tokens": 40_000}})
    con.commit()
    con.close()

    row = db_mod.latency_by_model(str(db))[0]
    assert row["compactions"] == 1


def test_the_same_model_on_two_providers_stays_two_rows(tmp_path):
    db = tmp_path / "events.db"
    con = make_db(db)
    add(con, 100, "llm.request", "s1", {"model": "shared", "provider": "alpha"})
    add(con, 101, "llm.response", "s1", {"response_model": "shared", "duration_s": 2.0})
    add(con, 102, "llm.request", "s2", {"model": "shared", "provider": "beta"})
    add(con, 103, "llm.response", "s2", {"response_model": "shared", "duration_s": 8.0})
    con.commit()
    con.close()

    rows = db_mod.latency_by_model(str(db))
    assert [(r["provider"], r["calls"]) for r in rows] == [("beta", 1), ("alpha", 1)]
    assert rows[0]["p95_s"] == 8.0


def test_provider_rollup_folds_models_and_keeps_the_worst_p95():
    rows = [
        {"provider": "nous", "model": "a", "calls": 10, "p95_s": 3.0, "errors": 1,
         "rate_limited": 1, "timeouts": 0, "retried": 2, "compactions": 1, "last_seen": 50.0},
        {"provider": "nous", "model": "b", "calls": 4, "p95_s": 9.0, "errors": 0,
         "rate_limited": 0, "timeouts": 0, "retried": 0, "compactions": 0, "last_seen": 90.0},
        {"provider": "other", "model": "c", "calls": 1, "p95_s": 1.0, "errors": 0,
         "rate_limited": 0, "timeouts": 0, "retried": 0, "compactions": 0, "last_seen": 10.0},
    ]
    out = db_mod.rollup_by_provider(rows)
    assert out[0]["provider"] == "nous"
    assert out[0]["models"] == 2
    assert out[0]["calls"] == 14
    assert out[0]["p95_s"] == 9.0
    assert out[0]["worst_model"] == "b"
    assert out[0]["rate_limited"] == 1
    assert out[0]["last_seen"] == 90.0
