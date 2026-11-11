"""Regression tests for plugin/omniscience/store.py (queue + writer thread).

Covers ARCHITECTURE.md §1/§3 guarantees:
  * conservation rows + dropped == submitted under 8x2000 thread load;
  * seq monotonic per boot and rows land in seq order per boot;
  * INSERT OR IGNORE idempotency under redelivery;
  * flush()/close() never hang; writer survives a busy DB and a broken DB;
  * DB file mode 0600, WAL journal, drop markers counted with exact totals.

All paths are tmp dirs; no wall-clock sleep over 1 s in a single call (the
mandated 2 s exclusive-lock hold is done with bounded poll loops).
"""

import os
import sqlite3
import stat
import threading
import time

import pytest

from omniscience.schema import KINDS
from omniscience.store import EventStore

FLUSH_TIMEOUT = 30.0


def _tool(i, **over):
    kw = dict(session_id="s1", turn_id="t1", api_request_id="a1",
              tool_call_id=f"call_{i}", tool_name="terminal",
              duration_ms=5, status="ok", args={"cmd": "ls"}, result="done")
    kw.update(over)
    return kw


def _rows(path, where="kind != 'omni.dropped'", cols="*", order=""):
    con = sqlite3.connect(path)
    try:
        return con.execute(f"SELECT {cols} FROM events WHERE {where} {order}").fetchall()
    finally:
        con.close()


def _count(path, where="1=1"):
    con = sqlite3.connect(path)
    try:
        return con.execute(f"SELECT COUNT(*) FROM events WHERE {where}").fetchone()[0]
    finally:
        con.close()


def _wait_until(pred, timeout=10.0, poll=0.01):
    """Bounded poll (poll < 1 s per sleep) instead of a long wall-clock sleep."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(poll)
    return False


# --------------------------------------------------------------------------
# concurrency / conservation / ordering
# --------------------------------------------------------------------------


def test_eight_threads_2000_submits_conservation_and_seq_order(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=20000, batch_max=250, flush_interval=0.02)
    start = threading.Barrier(8)

    def worker(tid):
        start.wait()
        for i in range(2000):
            st.submit("post_tool_call", _tool(f"{tid}-{i}", tool_call_id=f"c-{tid}-{i}",
                                              session_id=f"s{tid}"))

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(8)]
    t0 = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert st.flush(FLUSH_TIMEOUT), "flush must report success within timeout"
    stats = st.stats()
    assert stats["submitted"] == 16000
    assert stats["dropped"] == 0
    assert stats["written"] == 16000
    assert time.monotonic() - t0 < 120

    seqs = [r[0] for r in _rows(db, cols="seq", order="ORDER BY rowid ASC")]
    assert len(seqs) == 16000
    assert all(b > a for a, b in zip(seqs, seqs[1:])), "rows must land in seq order"
    assert len(set(seqs)) == 16000, "seq unique within boot"
    boots = {r[0] for r in _rows(db, cols="boot_id")}
    assert len(boots) == 1
    ids = {r[0] for r in _rows(db, cols="event_id")}
    assert len(ids) == 16000
    assert _count(db, "kind = 'omni.dropped'") == 0
    st.close()


def test_writer_alive_after_burst(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=20000, batch_max=100, flush_interval=0.02)
    for i in range(3000):
        st.submit("post_tool_call", _tool(i, tool_call_id=f"c{i}"))
    st.flush(FLUSH_TIMEOUT)
    assert st._thread.is_alive(), "writer thread must never die on normal load"
    st.close()


# --------------------------------------------------------------------------
# idempotency under redelivery (INSERT OR IGNORE)
# --------------------------------------------------------------------------


def test_redelivery_same_natural_keys_are_idempotent(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    for _ in range(5):
        st.submit("post_tool_call", _tool(1, tool_call_id="same-call"))
    for _ in range(3):
        st.submit("pre_api_request",
                  dict(session_id="s", api_request_id="api-X", retry_count=2, model="m"))
        st.submit("post_api_request",
                  dict(session_id="s", api_request_id="api-X", retry_count=0,
                       api_duration=1.0))
    assert st.flush(10)
    st.close()
    assert _count(db) == 1 + 1 + 1  # tool, request, response — one each across redelivers
    # different retry_count must NOT collide with the same api_request_id
    st2 = EventStore(db)
    st2.submit("pre_api_request", dict(session_id="s", api_request_id="api-X", retry_count=1))
    st2.flush(10)
    st2.close()
    assert _count(db, "kind='llm.request'") == 2


def test_session_end_redeliveries_are_distinct_by_design(tmp_path):
    # ARCHITECTURE §3: session.end natural key includes ts ("can fire per run").
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    for _ in range(3):
        st.submit("on_session_end", dict(session_id="s", completed=True))
    assert st.flush(10)
    st.close()
    assert _count(db, "kind='session.end'") == 3


def test_tool_end_redelivery_without_tool_call_id_is_idempotent(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    kw = _tool(0)
    kw.pop("tool_call_id")
    for _ in range(3):
        st.submit("post_tool_call", dict(kw))
    assert st.flush(10)
    st.close()
    assert _count(db, "kind='tool.end'") == 1


def test_tool_end_fallback_key_separates_tool_names(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    base = _tool(0)
    base.pop("tool_call_id")
    for name in ("terminal", "read_file", "terminal"):
        st.submit("post_tool_call", dict(base, tool_name=name))
    assert st.flush(10)
    st.close()
    assert _count(db, "kind='tool.end'") == 2


def test_events_without_natural_key_still_persist_uniquely(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    kw = _tool(0)
    kw.pop("tool_call_id")
    kw.pop("api_request_id")
    kw.pop("tool_name")
    for _ in range(4):
        st.submit("post_tool_call", dict(kw))
    assert st.flush(10)
    st.close()
    # boot_id|seq fallback: four legitimate calls => four rows, none lost
    assert _count(db, "kind='tool.end'") == 4


# --------------------------------------------------------------------------
# overflow drops + dropped marker accounting
# --------------------------------------------------------------------------


def test_queue_overflow_counts_drops_and_markers_exactly(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=8, batch_max=4, flush_interval=0.05)
    st._pause.set()  # park the writer so the queue definitely overflows
    for i in range(100):
        st.submit("post_tool_call", _tool(i, tool_call_id=f"c{i}"))
    _wait_until(lambda: st.stats()["dropped"] > 0 or not st._pause.is_set(), timeout=3)
    st._pause.clear()
    assert st.flush(FLUSH_TIMEOUT)
    rows = _count(db)
    markers = _count(db, "kind = 'omni.dropped'")
    events = rows - markers
    stats = st.stats()
    assert events + stats["dropped"] == stats["submitted"] == 100
    assert stats["dropped"] > 0
    con = sqlite3.connect(db)
    marker_rows = con.execute(
        "SELECT attrs FROM events WHERE kind='omni.dropped'"
    ).fetchall()
    con.close()
    import json

    total_counted = 0
    for (raw,) in marker_rows:
        attrs = json.loads(raw)
        assert set(attrs) == {"count", "since_seq"}
        assert isinstance(attrs["count"], int) and isinstance(attrs["since_seq"], int)
        total_counted += attrs["count"]
    assert total_counted == stats["dropped"]
    assert "omni.dropped" in KINDS
    st.close()


def test_invalid_payloads_are_dropped_before_the_counter(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    st.submit("pre_llm_call", None)          # not a dict
    st.submit("no_such_hook", dict(session_id="s"))
    st.submit("pre_llm_call", {})             # missing session_id
    st.submit("on_session_start", {"platform": "cli"})
    assert st.flush(5)
    stats = st.stats()
    assert stats["submitted"] == 0 and stats["dropped"] == 0
    # lazy-open contract: a store that accepted nothing may never create the
    # DB file at all; if it does exist it must hold zero rows.
    st.close()
    if os.path.exists(db):
        assert _count(db) == 0


# --------------------------------------------------------------------------
# lifecycle: flush/close never hang
# --------------------------------------------------------------------------


def test_flush_on_idle_store_returns_true_quickly(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    t0 = time.monotonic()
    assert st.flush(2.0) is True
    assert time.monotonic() - t0 < 1.0
    st.close()


def test_close_is_bounded_and_drains_the_backlog(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=5000, batch_max=100, flush_interval=0.05)
    for i in range(600):
        st.submit("post_tool_call", _tool(i, tool_call_id=f"c{i}"))
    t0 = time.monotonic()
    st.close()  # stop must not lose queued events; thread daemon but must be joinable
    assert time.monotonic() - t0 < 10.0
    assert not st._thread.is_alive()
    assert _count(db) == 600


def test_flush_and_close_respect_timeout_on_unopenable_db(tmp_path):
    broken = tmp_path / "a_directory"  # sqlite cannot open a directory as DB
    broken.mkdir()
    st = EventStore(str(broken))
    st.submit("post_tool_call", _tool(1))
    t0 = time.monotonic()
    result = st.flush(2.0)  # must return (True or False), never hang
    assert time.monotonic() - t0 < 4.0
    assert st._thread.is_alive(), "writer retries in background, keeps agent path alive"
    assert st.stats()["dropped"] >= 0
    t1 = time.monotonic()
    st.close()
    assert time.monotonic() - t1 < 5.0
    assert not st._thread.is_alive()


# --------------------------------------------------------------------------
# on-disk guarantees
# --------------------------------------------------------------------------


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes are not meaningful on Windows")
def test_db_created_private_mode_0600_and_wal(tmp_path):
    db = tmp_path / "nested" / "deeper" / "events.db"  # parents auto-created
    st = EventStore(str(db), flush_interval=0.05)
    st.submit("post_tool_call", _tool(1, tool_call_id="c1"))
    assert st.flush(10)
    assert db.parent.is_dir()
    mode = stat.S_IMODE(os.stat(str(db)).st_mode)
    assert mode == 0o600, f"events.db must be private, got {oct(mode)}"
    con = sqlite3.connect(str(db))
    assert con.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert con.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()[0] == "omni.v1"
    row = con.execute("SELECT event_id, schema, ts, kind, attrs FROM events").fetchone()
    assert row[1] == "omni.v1"
    con.close()
    st.close()
    # after clean close the -wal is checkpointed away; file stays private
    assert stat.S_IMODE(os.stat(str(db)).st_mode) == 0o600


def test_writer_survives_exclusive_lock_held_about_two_seconds(tmp_path):
    db = str(tmp_path / "lock.db")
    st = EventStore(db, batch_max=200, flush_interval=0.05)
    assert _wait_until(lambda: os.path.exists(db), timeout=10), "writer must create the DB"
    # ensure the writer finished its schema init before we grab the lock
    assert _wait_until(
        lambda: os.path.exists(db) and _count_all(db) == 0, timeout=5
    ), "writer must finish schema initialisation"

    blocker = sqlite3.connect(db, timeout=0, isolation_level=None)

    def begin_exclusive():
        try:
            blocker.execute("BEGIN EXCLUSIVE")
            return True
        except sqlite3.OperationalError:
            return False

    assert _wait_until(begin_exclusive, timeout=6, poll=0.05), "could not grab lock"

    for i in range(16):
        st.submit("post_tool_call", _tool(i, tool_call_id=f"lock-{i}"))
    # hold ~2 s with bounded polls (no single sleep over 1 s)
    t0 = time.monotonic()
    while time.monotonic() - t0 < 2.0:
        time.sleep(0.05)
    assert st._thread.is_alive(), "writer must merely block on lock, not die"
    blocker.close()

    assert st.flush(15), "writer must complete the batch once the lock is released"
    assert st._thread.is_alive()
    stats = st.stats()
    assert stats["submitted"] == 16
    events = _count(db, "kind != 'omni.dropped'")
    assert events + stats["dropped"] == 16  # written after release, or counted drops
    assert st._thread.is_alive()
    st.close()


def _count_all(path):
    try:
        con = sqlite3.connect(path)
    except sqlite3.Error:
        return -1
    try:
        return con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    except sqlite3.Error:
        return -1
    finally:
        con.close()
