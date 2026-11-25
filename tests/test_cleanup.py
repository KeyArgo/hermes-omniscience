"""Old step history is rolled up and deleted, and the totals it leaves behind stay true.

The failure this guards against is the one nobody sees at first: the recording grows for ever,
and the day cleanup deletes a month of steps the Usage page quietly starts reporting zero for
that month. Every case here is either "the steps go, the totals stay" or "this chat must not be
touched".
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

import cleanup
from omniscience.store import EventStore

NOW = 1_800_000_000.0
DAY = 86400.0

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


def _db(tmp_path: Path) -> Path:
    path = tmp_path / "events.db"
    con = sqlite3.connect(path)
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    con.commit()
    con.close()
    return path


def _insert(db: Path, rows) -> None:
    con = sqlite3.connect(db)
    for index, (ts, kind, session, parent, status, attrs) in enumerate(rows, start=1):
        con.execute(
            "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, "
            "parent_session_id, status, attrs) VALUES (?, 'omni.v1', 'boot', ?, ?, ?, ?, ?, ?, ?)",
            (f"e{index}", index, ts, kind, session, parent, status, json.dumps(attrs)),
        )
    con.commit()
    con.close()


def _llm(ts, session, prompt, output=100, cache_read=0, model="m1", provider="p1", status="ok"):
    return (ts, "llm.response", session, None, status, {
        "response_model": model, "provider": provider,
        "usage": {"prompt_tokens": prompt, "cache_read_tokens": cache_read,
                  "output_tokens": output},
    })


def _tool(ts, session, name="grep", status="ok"):
    return (ts, "tool.end", session, None, status, {"tool_name": name, "duration_ms": 5})


def _count(db: Path, where: str = "1", params=()) -> int:
    con = sqlite3.connect(db)
    try:
        return con.execute(f"SELECT COUNT(*) FROM events WHERE {where}", params).fetchone()[0]
    finally:
        con.close()


def _rows(db: Path, sql: str, params=()):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def _flagged(state_dir: Path, session_id: str) -> None:
    directory = state_dir / "privacy-flags"
    directory.mkdir(parents=True)
    (directory / "20261115-120000-flagged.json").write_text(
        json.dumps({"session_id": session_id}), encoding="utf-8"
    )


def test_old_steps_are_rolled_into_daily_totals_before_they_are_deleted(tmp_path):
    db = _db(tmp_path)
    old = NOW - 10 * DAY
    _insert(db, [
        _llm(old, "s1", 1000, output=50, cache_read=600),
        _tool(old, "s1", "grep", "ok"),
        _tool(old, "s1", "grep", "error"),
        (old, "aux.response", "s1", None, "ok", {
            "aux_task": "titling",
            "usage": {"prompt_tokens": 20, "output_tokens": 5},
        }),
        _llm(NOW - 8 * DAY, "s1", 200, output=10),
        _llm(NOW - 60, "s2", 500, output=10),
    ])

    result = cleanup.run_history_cleanup(str(db), 7, now=NOW)

    assert result["ok"] is True
    assert result["deleted"] == 5
    assert result["before_bytes"] > 0 and result["after_bytes"] > 0
    # The recent step stays; every old one is gone.
    assert _count(db, "ts < ?", (NOW - 7 * DAY,)) == 0
    assert _count(db, "session_id = 's2'") == 1

    day = cleanup.day_key(old)
    totals = _rows(
        db,
        "SELECT model, provider, calls, aux_calls, errors, prompt_tokens, fresh_tokens, "
        "cache_read_tokens, output_tokens FROM daily_totals WHERE day = ? ORDER BY model",
        (day,),
    )
    assert totals == [
        # A background call keeps only its prompt and output, as the Usage page counts it.
        ("", "", 0, 1, 0, 20, 0, 0, 5),
        ("m1", "p1", 1, 0, 0, 1000, 400, 600, 50),
    ]
    assert _rows(db, "SELECT day, tool, calls, failures FROM daily_tools") == [
        (day, "grep", 2, 1)
    ]

    # A second pass has nothing left to count, so the totals do not grow.
    again = cleanup.run_history_cleanup(str(db), 7, now=NOW)
    assert again["deleted"] == 0
    assert _rows(db, "SELECT SUM(calls), SUM(prompt_tokens) FROM daily_totals WHERE model = 'm1'") == [(2, 1200)]


def test_a_flagged_chat_and_its_helpers_are_never_touched(tmp_path):
    db = _db(tmp_path)
    old = NOW - 40 * DAY
    _insert(db, [
        _llm(old, "root", 1000),
        _llm(old, "helper", 800),
        _llm(old, "ordinary", 300),
    ])
    # The helper is linked to the flagged root through parent_session_id.
    con = sqlite3.connect(db)
    con.execute("UPDATE events SET parent_session_id = 'root' WHERE session_id = 'helper'")
    # A damaged attrs blob must not abort the protection walk, or the flagged chat loses its steps.
    con.execute(
        "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs)"
        " VALUES ('broken', 'omni.v1', 'boot', 99, ?, 'subagent.start', 'root', 'ok', '{not json')",
        (old,),
    )
    con.commit()
    con.close()
    _flagged(tmp_path, "root")

    result = cleanup.run_history_cleanup(str(db), 7, now=NOW)

    assert result["ok"] is True
    assert result["deleted"] == 1  # only the ordinary chat's old step
    assert _count(db, "session_id = 'root'") == 2  # its own step and the damaged subagent row
    assert _count(db, "session_id = 'helper'") == 1
    assert _count(db, "session_id = 'ordinary'") == 0
    # The flagged chat's steps were not rolled into totals either.
    assert _rows(db, "SELECT model, prompt_tokens FROM daily_totals") == [("m1", 300)]


def test_forever_keeps_every_step_and_writes_no_stamp(tmp_path):
    db = _db(tmp_path)
    _insert(db, [_llm(NOW - 400 * DAY, "s1", 1000)])

    result = cleanup.run_history_cleanup(str(db), 0, now=NOW)

    assert result["ok"] is True
    assert result["deleted"] == 0
    assert result["skipped"] == "forever"
    assert _count(db) == 1
    assert cleanup.cleanup_due(str(db), now=NOW) is True


def test_the_pass_is_due_once_a_day(tmp_path):
    db = _db(tmp_path)
    assert cleanup.cleanup_due(str(db), now=NOW) is True
    cleanup.run_history_cleanup(str(db), 7, now=NOW)
    assert cleanup.cleanup_due(str(db), now=NOW + 3600) is False
    # A stamp older than a day opens the gate again.
    stamp = cleanup.stamp_path(str(db))
    old = NOW - cleanup.CLEANUP_INTERVAL_S - 1
    os.utime(stamp, (old, old))
    assert cleanup.cleanup_due(str(db), now=NOW) is True


def test_small_transactions_do_not_double_count_or_leave_rows(tmp_path):
    db = _db(tmp_path)
    old = NOW - 30 * DAY
    _insert(db, [_llm(old, "s1", 100) for _ in range(7)])

    result = cleanup.run_history_cleanup(str(db), 7, now=NOW, chunk_rows=2)

    assert result["deleted"] == 7
    assert _count(db) == 0
    assert _rows(db, "SELECT calls, prompt_tokens FROM daily_totals") == [(7, 700)]


def test_a_broken_database_is_reported_not_raised(tmp_path):
    db = tmp_path / "events.db"
    db.write_text("this is not a database", encoding="utf-8")

    result = cleanup.run_history_cleanup(str(db), 7, now=NOW)

    assert result["ok"] is False
    assert result["error"]


def test_the_writer_runs_the_pass_at_startup_and_gates_it_with_the_stamp(tmp_path):
    db = tmp_path / "events.db"
    store = EventStore(str(db))
    store.flush(timeout=5.0)
    # Wait for the first start's own pass to finish (it writes the stamp) before replacing it.
    deadline = time.time() + 10
    while time.time() < deadline and not os.path.exists(cleanup.stamp_path(str(db))):
        time.sleep(0.05)
    store.close()

    old = time.time() - 40 * DAY
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs) "
        "VALUES ('old', 'omni.v1', 'boot', 1, ?, 'llm.response', 's1', 'ok', ?)",
        (old, json.dumps({"response_model": "m1", "usage": {"prompt_tokens": 100,
                                                           "output_tokens": 10}})),
    )
    con.commit()
    con.close()

    from omniscience import prefs as prefs_mod

    prefs_mod.save(
        prefs_mod.path_for(str(db)),
        prefs_mod.set_keep_days(prefs_mod.defaults(), 7),
    )
    # Start from a blank slate: the first store's own pass wrote a stamp.
    os.unlink(cleanup.stamp_path(str(db)))

    store = EventStore(str(db))
    deadline = time.time() + 10
    while time.time() < deadline and cleanup.cleanup_due(str(db)):
        time.sleep(0.05)
    store.close()

    assert cleanup.cleanup_due(str(db)) is False
    assert _count(db, "event_id = 'old'") == 0
    assert _rows(db, "SELECT calls FROM daily_totals WHERE model = 'm1'") == [(1,)]


def test_the_writer_will_not_clean_twice_in_one_day(tmp_path):
    """The stamp, not the idle loop, is what limits the pass: a second ask must do nothing."""
    db = tmp_path / "events.db"
    store = EventStore(str(db))
    store.flush(timeout=5.0)
    deadline = time.time() + 10
    while time.time() < deadline and not os.path.exists(cleanup.stamp_path(str(db))):
        time.sleep(0.05)

    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, status, attrs) "
        "VALUES ('old2', 'omni.v1', 'boot', 9, ?, 'llm.response', 's9', 'ok', ?)",
        (time.time() - 60 * DAY, json.dumps({"response_model": "m9",
                                             "usage": {"prompt_tokens": 10,
                                                       "output_tokens": 1}})),
    )
    con.commit()
    con.close()

    store.maybe_cleanup_history(force=True)
    time.sleep(0.5)
    try:
        assert _count(db, "event_id = 'old2'") == 1
    finally:
        store.close()


def test_a_model_call_without_usage_is_not_counted(tmp_path):
    """The Usage page skips a response with no usage block; the roll-up must too, or a cleaned-up
    day reports more calls than the same day did before (seen on a real recording: +3,160)."""
    db = _db(tmp_path)
    _insert(db, [(NOW - 30 * DAY, "llm.response", "s1", None, "ok", {"response_model": "m1"})])
    result = cleanup.run_history_cleanup(str(db), 7, now=NOW)
    assert result["deleted"] == 1
    assert _rows(db, "SELECT calls FROM daily_totals") == []


def test_a_pass_with_nothing_old_leaves_the_file_alone(tmp_path):
    """No tables, no checkpoint, no compaction when nothing is old enough: each takes a lock, and
    on Windows a lock held for nothing made the recording unreadable to another reader."""
    db = _db(tmp_path)
    _insert(db, [_llm(NOW - 60, "s1", 100)])
    result = cleanup.run_history_cleanup(str(db), 7, now=NOW)
    assert result["skipped"] == "nothing old" and result["deleted"] == 0
    assert _rows(db, "SELECT name FROM sqlite_master WHERE name = 'daily_totals'") == []
    assert not cleanup.cleanup_due(str(db), now=NOW + 60)
