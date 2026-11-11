import os
import sqlite3
import stat
import time

import pytest

from omniscience.store import EventStore


def _tool(i, call_id=None):
    return dict(session_id="s1", turn_id="t1", api_request_id="a1", tool_call_id=call_id or f"call_{i}",
                tool_name="terminal", duration_ms=5, status="ok")


def _rows(path, where="1=1"):
    con = sqlite3.connect(path)
    try:
        return con.execute(f"SELECT kind, attrs FROM events WHERE {where}").fetchall()
    finally:
        con.close()


def test_bulk_write(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=20000)
    for i in range(10_000):
        st.submit("post_tool_call", _tool(i))
    assert st.flush(30)
    st.close()
    assert len(_rows(db)) == 10_000
    assert st.stats()["dropped"] == 0


def test_duplicate_event_is_idempotent(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    st.submit("post_tool_call", _tool(1, "call_same"))
    st.submit("post_tool_call", _tool(2, "call_same"))
    st.flush(5); st.close()
    assert len(_rows(db)) == 1


def test_overflow_counts_drops_and_writes_marker(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=10)
    st._pause.set()
    time.sleep(0.3)  # let the writer park in its pause loop
    for i in range(50):
        st.submit("post_tool_call", _tool(i))
    assert st.stats()["dropped"] > 0
    st._pause.clear()
    assert st.flush(10)
    st.close()
    markers = _rows(db, "kind='omni.dropped'")
    assert markers, "expected an omni.dropped marker"
    assert '"count":' in markers[0][1]
    assert len(_rows(db, "kind='tool.end'")) + st.stats()["dropped"] == 50


def test_submit_never_blocks(tmp_path):
    # Writer paused and queue overflowing: submit must still return fast (no waiting on I/O or the writer).
    # Median, not p99: on a loaded host p99 measures OS preemption, not this code.
    st = EventStore(str(tmp_path / "e.db"), queue_max=100)
    st._pause.set()
    times = []
    for i in range(5000):
        t = time.perf_counter()
        st.submit("post_tool_call", _tool(i))
        times.append(time.perf_counter() - t)
    st._pause.clear()
    st.close()
    times.sort()
    assert times[len(times) // 2] < 0.0005
    assert st.stats()["dropped"] >= 4500  # the writer may take a few batches before the pause lands


def test_garbage_never_raises(tmp_path):
    st = EventStore(str(tmp_path / "e.db"))
    for bad in (None, 1, "x", {"session_id": object()}, {"session_id": "s", "args": object(), "result": object()}):
        st.submit("post_tool_call", bad)
    st.submit("no_such_hook", {"session_id": "s"})
    st.close()


@pytest.mark.skipif(os.name == "nt", reason="POSIX file mode 0600 does not apply on Windows")
def test_db_file_is_private(tmp_path):
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    st.submit("post_tool_call", _tool(1))
    st.flush(5); st.close()
    assert stat.S_IMODE(os.stat(db).st_mode) == 0o600


def test_unopenable_db_counts_drops_instead_of_dying(tmp_path):
    bad = tmp_path / "is_a_dir.db"
    bad.mkdir()
    st = EventStore(str(bad))
    for i in range(5):
        st.submit("post_tool_call", _tool(i))
    time.sleep(1.0)
    assert st._thread.is_alive()
    assert st.stats()["dropped"] == 5
    st.close()


# --- bug-hunt regressions (2026-11-09) -------------------------------------
# Each test below reproduced a real defect before its fix; the comment says what
# the failure looked like so a future reader can tell a regression from a rewrite.


def test_nothing_is_stranded_when_the_database_never_opens(tmp_path):
    """close() during the open-retry backoff left queued events neither written nor counted.

    Before the fix: submitted=6, written=0, dropped=3, queue_depth=3 - three events
    vanished from every counter and no marker could ever be written for them.
    """
    bad = tmp_path / "is_a_dir.db"
    bad.mkdir()
    st = EventStore(str(bad))
    for i in range(3):
        st.submit("post_tool_call", _tool(i))
    time.sleep(1.2)  # the writer is asleep in its backoff wait by now
    for i in range(3, 6):
        st.submit("post_tool_call", _tool(i))
    st.close()
    stats = st.stats()
    assert stats["queue_depth"] == 0, stats
    assert stats["submitted"] == stats["written"] + stats["dropped"], stats


def test_close_while_paused_returns_and_writes_the_queue(tmp_path):
    """close() spun in the pause branch, so it blocked for the full 10s join and lost the queue.

    Before the fix: close_seconds=10.0, thread still alive, 0 events written.
    """
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=100)
    st._pause.set()
    st.submit("post_tool_call", _tool(1))
    started = time.time()
    st.close()
    assert time.time() - started < 5.0, "close() must not wait out the join timeout"
    assert not st._thread.is_alive()
    assert len(_rows(db)) == 1


def test_writer_survives_a_bad_iteration(tmp_path):
    """One unexpected exception killed the writer thread for good; later events were lost.

    Before the fix: thread dead, flush False, 1 of 7 events written, no drop marker.
    """
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=1000)
    real = st._emit_drop_marker
    calls = {"n": 0}

    def flaky(conn):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("injected failure in the loop body")
        return real(conn)

    st._emit_drop_marker = flaky
    st.submit("post_tool_call", _tool(1))
    time.sleep(0.6)  # let the loop hit the injected failure
    assert st._thread.is_alive(), "the writer must not die on one bad iteration"
    for i in range(2, 8):
        st.submit("post_tool_call", _tool(i))
    assert st.flush(5)
    st.close()
    assert len(_rows(db, "kind='tool.end'")) == 7


def test_flush_waits_for_the_drop_marker(tmp_path):
    """flush() reported success while the omni.dropped row was still being written.

    Before the fix: flush returned True in 0.0s with 0 markers in the database, so a
    shutdown or a test could report "all written" while the record of the loss was lost.
    """
    db = str(tmp_path / "e.db")
    st = EventStore(db, queue_max=5)
    st._pause.set()
    time.sleep(0.25)  # let the writer park in its pause loop
    for i in range(40):
        st.submit("post_tool_call", _tool(i))
    st._pause.clear()
    real = st._write_batch

    def slow(conn, batch):
        if len(batch) == 1 and batch[0].kind == "omni.dropped":
            time.sleep(0.6)
        return real(conn, batch)

    st._write_batch = slow
    time.sleep(0.05)
    assert st.flush(0.2) is False, "flush must not report success while the marker is in flight"
    assert st.flush(10)
    markers = _rows(db, "kind='omni.dropped'")
    st.close()
    assert markers, "the drop marker must be committed before flush() says it is done"


@pytest.mark.skipif(os.name == "nt", reason="POSIX file mode 0600 does not apply on Windows")
def test_existing_db_is_reprivatised_on_open(tmp_path):
    """0600 was applied only when the file was created, so a restored/loosened DB stayed readable.

    Before the fix: a database chmod-ed to 0644 was still 0644 after a new store
    opened it and wrote to it.
    """
    db = str(tmp_path / "e.db")
    st = EventStore(db)
    st.submit("post_tool_call", _tool(1))
    st.flush(5)
    st.close()
    os.chmod(db, 0o644)
    st = EventStore(db)
    st.submit("post_tool_call", _tool(2))
    st.flush(5)
    st.close()
    assert stat.S_IMODE(os.stat(db).st_mode) == 0o600

