"""What the viewer costs on a busy recording, pinned so the cost cannot come back.

Measured on a real 152k-row recording with one open page, the viewer sat at ~50% of a CPU core:
63% rebuilding the chat list every five seconds because one new row invalidated the cache, 19%
walking a chat's subtree on every one-second live poll, and 7% re-running warnings every ten
seconds. None of that work changed the answer.

These tests are in two halves. The property test proves the cheap path answers *exactly* what a
full rebuild answers, across random batches of every row kind the list reads. The cost tests
count decoded rows and traced SQL instead of measuring seconds, so they are deterministic on any
machine and fail on the specific work that used to happen — not on a busy CI box.
"""

from __future__ import annotations

import json
import random
import re
import sqlite3
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))
sys.path.insert(0, str(ROOT / "analysis"))

from omniscience_viewer import db as db_mod  # noqa: E402
from omniscience_viewer import warnings as warnings_mod  # noqa: E402
from test_warnings_api import warnings_db  # noqa: E402,F401  (the fixture)

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)

# A full scan of the rows in rowid order: the one query the cheap paths must never issue.
FULL_ROW_SCAN = re.compile(r"FROM\s+events\s+ORDER\s+BY\s+rowid", re.IGNORECASE)
# The subtree walk's two queries: whole-table scans because the link columns carry no index.
SUB_TREE_WALKS = (
    "parent_session_id IN",
    "json_extract(attrs, '$.child_session_id') FROM events WHERE kind = 'subagent.start'",
)


def _make_db(tmp_path: Path) -> str:
    path = str(tmp_path / "events.db")
    con = sqlite3.connect(path)
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    con.execute("CREATE TABLE purged (session_id TEXT PRIMARY KEY, ts REAL)")
    con.commit()
    con.close()
    return path


def _insert(con, ts, kind, session=None, parent=None, status=None, attrs=None, turn_id=None):
    con.execute(
        "INSERT INTO events (ts, kind, session_id, parent_session_id, turn_id, status, attrs)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (ts, kind, session, parent, turn_id, status, json.dumps(attrs or {})),
    )


def _roots(rows) -> list[str]:
    return [row["id"] for row in rows]


def _read_only_connection(path: str):
    return db_mod._connect(path)


# ---------------------------------------------------------------------------
# property: the cheap path and a full rebuild answer the same thing
# ---------------------------------------------------------------------------

PARENTS = {
    "sess-a-child": "sess-a",
    "sess-a-grand": "sess-a-child",
    "sess-b-child": "sess-b",
}
POOL = ["sess-a", "sess-b", "sess-a-child", "sess-a-grand", "sess-b-child", "sess-archived"]
KINDS = [
    "llm.request",
    "llm.response",
    "tool.end",
    "subagent.start",
    "session.start",
    "session.end",
    "llm.error",
    "aux.response",
    "skill.event",
    "omni.dropped",
]


class _Recording:
    """A tiny appender that mixes every row kind the chat list folds."""

    def __init__(self, con, rng: random.Random) -> None:
        self.con = con
        self.rng = rng
        self.clock = 1000.0
        self.parents = dict(PARENTS)
        self.pool = list(POOL)

    def batch(self, step: int) -> None:
        rng = self.rng
        for _ in range(rng.randint(1, 4)):
            kind = rng.choice(KINDS)
            session = rng.choice(self.pool)
            parent = self.parents.get(session)
            if kind == "omni.dropped" and rng.random() < 0.5:
                session = None
            attrs: dict = {}
            turn_id = None
            status = None
            if kind in ("llm.request", "session.start"):
                attrs["model"] = rng.choice(["model-a", "model-b"])
            if kind == "llm.request":
                turn_id = f"t{rng.randint(0, 3)}"
                attrs["turn_id"] = turn_id if rng.random() < 0.5 else None
            if kind == "llm.response":
                attrs["usage"] = {
                    "prompt_tokens": rng.choice([120, 4000, 90_000]),
                    "cache_read_tokens": rng.choice([0, 3000]),
                    "output_tokens": rng.choice([1, 250]),
                }
                turn_id = f"t{rng.randint(0, 3)}"
            if kind == "aux.response":
                attrs["usage"] = {"prompt_tokens": 700, "output_tokens": 20}
                if rng.random() < 0.5:
                    attrs["aux_task"] = "compression"
            if kind == "tool.end":
                attrs["tool_name"] = rng.choice(["bash", "read", "search"])
                if rng.random() < 0.3:
                    attrs["mcp_server"] = "files"
            if kind == "skill.event":
                attrs["skill"] = "omniscience-dev"
            if kind == "subagent.start":
                attrs["child_session_id"] = rng.choice(self.pool)
            if kind == "llm.error" or rng.random() < 0.08:
                status = "error"
            self.clock += rng.random() * 3
            _insert(
                self.con,
                round(self.clock, 3),
                kind,
                session=session,
                parent=parent,
                status=status,
                attrs=attrs,
                turn_id=turn_id,
            )
        # Now and then a brand-new helper appears: its link row and its own rows arrive
        # together, and only then does the subtree (and the chat list's helper attribution)
        # have a new member to account for.
        if step % 3 == 0:
            parent = rng.choice(["sess-a", "sess-a-child", "sess-b"])
            child = f"sess-late-{step}"
            self.parents[child] = parent
            self.pool.append(child)
            _insert(self.con, round(self.clock, 3), "subagent.start", session=parent,
                    attrs={"child_session_id": child})
            for _ in range(rng.randint(1, 3)):
                self.clock += 1.0
                _insert(self.con, round(self.clock, 3), rng.choice(["tool.end", "llm.response"]),
                        session=child, parent=parent, status="ok",
                        attrs={"usage": {"prompt_tokens": 500, "output_tokens": 10}})
        self.con.commit()


def _full_rebuild(path: str, limit: int = 100):
    rows, error = db_mod._list_sessions_uncached(path, limit)
    assert error is None, error
    return rows


def _uncached_descendants(path: str, root: str) -> set[str]:
    con = _read_only_connection(path)
    try:
        return db_mod._descendant_ids(con, root)
    finally:
        con.close()


def _uncached_warnings(path: str, root: str) -> list[dict]:
    events = db_mod.events_for_root(path, root, limit=2000, tail=True)
    findings = warnings_mod._rules.detect(events)
    return [warnings_mod._explain.explain(finding) for finding in findings]


def test_cheap_paths_answer_exactly_what_a_full_rebuild_answers(tmp_path, monkeypatch):
    rng = random.Random(20261118)
    path = _make_db(tmp_path)
    con = sqlite3.connect(path)
    recording = _Recording(con, rng)
    roots = ["sess-a", "sess-b", "sess-a-child", "sess-b-child", "sess-archived"]

    # Counting the folds proves the cheap path was actually taken: a test that silently rebuilt
    # every time would compare a rebuild with a rebuild and pin nothing at all.
    folds: list[bool] = []
    real_incremental = db_mod._sessions_incremental

    def counting_incremental(*args, **kwargs):
        folded = real_incremental(*args, **kwargs)
        folds.append(folded is not None)
        return folded

    monkeypatch.setattr(db_mod, "_sessions_incremental", counting_incremental)

    for step in range(20):
        recording.batch(step)
        if step == 12:
            # The user deletes a chat: its rows stay in the recording, the chat must not.
            con.execute("INSERT OR REPLACE INTO purged VALUES ('sess-archived', 1.0)")
            con.commit()

        got, error = db_mod.list_sessions_checked(path)
        assert error is None
        assert got == _full_rebuild(path), f"chat list differs after batch {step}"

        for root in roots:
            con_ro = _read_only_connection(path)
            try:
                purged = db_mod._purged_ids(con_ro)
                cached = db_mod._descendant_ids_cached(con_ro, path, root, purged)
            finally:
                con_ro.close()
            assert cached == _uncached_descendants(path, root), (
                f"subtree of {root} differs after batch {step}"
            )
            assert warnings_mod.warnings_for_root(path, root) == _uncached_warnings(path, root), (
                f"warnings for {root} differ after batch {step}"
            )
    con.close()
    assert len(folds) >= 15 and sum(folds) >= 15, (
        f"only {sum(folds)} of {len(folds)} chat-list calls folded the new rows instead of "
        "rebuilding: the cheap path is not the one under test"
    )


def test_the_chat_list_still_sees_a_purge_a_replaced_file_and_a_limit(tmp_path):
    """The cheap path must not become a way to answer from a fold that is no longer true."""
    rng = random.Random(7)
    path = _make_db(tmp_path)
    con = sqlite3.connect(path)
    recording = _Recording(con, rng)
    for step in range(4):
        recording.batch(step)
    assert db_mod.list_sessions_checked(path)[0] == _full_rebuild(path)

    # A chat is archived after the fold was built.
    con.execute("INSERT OR REPLACE INTO purged VALUES ('sess-b', 2.0)")
    con.commit()
    rows, error = db_mod.list_sessions_checked(path)
    assert error is None
    assert "sess-b" not in _roots(rows)
    assert rows == _full_rebuild(path)

    # A different limit is a different question, answered from the same fold.
    for limit in (1, 2, 1000):
        assert db_mod.list_sessions_checked(path, limit)[0] == _full_rebuild(path, limit)

    # The recording is replaced by another file (the plugin rewrites it, or a restore lands).
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    other = _make_db(other_dir)
    con2 = sqlite3.connect(other)
    _insert(con2, 1.0, "session.start", session="only-here", attrs={"model": "m"})
    con2.commit()
    con2.close()
    Path(other).replace(path)
    assert _roots(db_mod.list_sessions_checked(path)[0]) == ["only-here"]
    con.close()


# ---------------------------------------------------------------------------
# cost: one new row costs one row of work
# ---------------------------------------------------------------------------


def _seed_history(path: str, rows: int = 400) -> None:
    con = sqlite3.connect(path)
    for i in range(rows):
        session = f"sess-{i % 7}"
        _insert(con, 1000.0 + i, "llm.response", session=session,
                attrs={"usage": {"prompt_tokens": 5000, "output_tokens": 40}})
        _insert(con, 1000.0 + i, "tool.end", session=session, attrs={"tool_name": "bash"})
    con.commit()
    con.close()


def test_one_new_row_does_not_re_read_the_recording(tmp_path, monkeypatch):
    path = _make_db(tmp_path)
    _seed_history(path)
    db_mod.clear_caches()
    db_mod.list_sessions_checked(path)  # warm the fold

    con = sqlite3.connect(path)
    _insert(con, 9999.0, "llm.response", session="sess-3",
            attrs={"usage": {"prompt_tokens": 6000, "output_tokens": 12}})
    con.commit()
    con.close()

    decoded: list[int] = []
    real_parse = db_mod._parse_attrs

    def counting_parse(raw):
        decoded.append(1)
        return real_parse(raw)

    traced: list[str] = []
    real_connect = db_mod._connect

    def traced_connect(db_path):
        connection = real_connect(db_path)
        connection.set_trace_callback(traced.append)
        return connection

    monkeypatch.setattr(db_mod, "_parse_attrs", counting_parse)
    monkeypatch.setattr(db_mod, "_connect", traced_connect)
    rows, error = db_mod.list_sessions_checked(path)
    monkeypatch.undo()

    assert error is None
    assert rows == _full_rebuild(path)
    # The new row is the only attrs blob the list needs; a rebuild decodes all 801.
    assert len(decoded) <= 5, f"the chat list decoded {len(decoded)} attrs blobs for one new row"
    offenders = [sql for sql in traced if FULL_ROW_SCAN.search(sql)]
    assert not offenders, f"the chat list re-read every row for one new row: {offenders}"


def test_a_second_subtree_lookup_does_no_walk(tmp_path):
    path = _make_db(tmp_path)
    con = sqlite3.connect(path)
    _insert(con, 1.0, "session.start", session="root")
    _insert(con, 2.0, "tool.end", session="kid", parent="root")
    _insert(con, 3.0, "tool.end", session="grand", parent="kid")
    _insert(con, 4.0, "subagent.start", session="root", attrs={"child_session_id": "linked"})
    _insert(con, 5.0, "tool.end", session="linked")
    con.commit()
    con.close()
    db_mod.clear_caches()

    con_ro = _read_only_connection(path)
    try:
        purged = db_mod._purged_ids(con_ro)
        first = db_mod._descendant_ids_cached(con_ro, path, "root", purged)

        traced: list[str] = []
        con_ro.set_trace_callback(traced.append)
        second = db_mod._descendant_ids_cached(con_ro, path, "root", purged)
        con_ro.set_trace_callback(None)
    finally:
        con_ro.close()

    assert first == second == {"root", "kid", "grand", "linked"}, first
    assert second == _uncached_descendants(path, "root")
    walks = [sql for sql in traced if any(mark in sql for mark in SUB_TREE_WALKS)]
    assert not walks, f"an unchanged subtree was walked again: {walks}"


def test_new_links_extend_the_cached_subtree_without_losing_old_ones(tmp_path):
    """A helper linked late must join the subtree, and its own helpers must come with it.

    ``mid`` is only ever reachable through the ``subagent.start`` link row written last, and
    ``grand`` only through ``mid`` — so the incremental walk has to start from the newly linked
    session, not from the root, and still see the links written before it.
    """
    path = _make_db(tmp_path)
    con = sqlite3.connect(path)
    _insert(con, 1.0, "session.start", session="root")
    _insert(con, 2.0, "tool.end", session="mid")
    _insert(con, 3.0, "tool.end", session="grand", parent="mid")
    con.commit()
    con.close()
    db_mod.clear_caches()

    con_ro = _read_only_connection(path)
    try:
        purged = db_mod._purged_ids(con_ro)
        assert db_mod._descendant_ids_cached(con_ro, path, "root", purged) == {"root"}
    finally:
        con_ro.close()

    # The link row that reveals the mid helper to the root is written last.
    con = sqlite3.connect(path)
    _insert(con, 9.0, "subagent.start", session="root", attrs={"child_session_id": "mid"})
    con.commit()
    con.close()

    con_ro = _read_only_connection(path)
    try:
        purged = db_mod._purged_ids(con_ro)
        got = db_mod._descendant_ids_cached(con_ro, path, "root", purged)
    finally:
        con_ro.close()
    assert got == {"root", "mid", "grand"} == _uncached_descendants(path, "root")


# ---------------------------------------------------------------------------
# live feed: an idle chat costs one index seek, not a query
# ---------------------------------------------------------------------------


def test_an_idle_live_feed_queries_once_until_a_row_arrives(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from omniscience_viewer import app as app_mod

    monkeypatch.setattr(app_mod, "POLL_INTERVAL_S", 0.05)
    monkeypatch.setattr(app_mod, "IDLE_POLL_INTERVAL_S", 0.05)
    db_mod.clear_caches()

    path = _make_db(tmp_path)
    con = sqlite3.connect(path)
    _insert(con, 1.0, "session.start", session="root", attrs={"model": "m"})
    con.commit()
    con.close()

    app = app_mod.create_app(path)
    calls: list[tuple] = []
    real = db_mod.events_for_root_checked

    def counting(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(db_mod, "events_for_root_checked", counting)

    received: list[dict] = []
    started = threading.Event()

    def run() -> None:
        with TestClient(app, base_url="http://127.0.0.1") as c:
            with c.websocket_connect("/api/v1/live?root=root&after=0",
                                     headers={"host": "127.0.0.1"}) as ws:
                started.set()
                deadline = time.monotonic() + 8.0
                while time.monotonic() < deadline:
                    try:
                        msg = ws.receive_json()
                    except Exception:
                        break
                    if msg.get("type") == "heartbeat":
                        continue
                    received.append(msg)
                    rows = [e["rowid"] for m in received if m.get("type") == "events"
                            for e in m["events"]]
                    if 2 in rows:
                        break

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert started.wait(5)

    # The first poll has to read once (this socket has not read the file yet). Several idle
    # ticks later it must not have asked again: nothing was appended.
    deadline = time.monotonic() + 5.0
    while not calls and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(calls) == 1, f"the first poll did not read the database once: {len(calls)}"
    time.sleep(0.4)
    assert len(calls) == 1, f"an idle feed ran {len(calls)} per-socket queries"

    con = sqlite3.connect(path)
    _insert(con, 2.0, "tool.end", session="root", attrs={"tool_name": "bash"})
    con.commit()
    con.close()

    thread.join(timeout=8.0)
    delivered = {e["rowid"] for m in received if m.get("type") == "events" for e in m["events"]}
    assert 2 in delivered, f"the appended row never reached the feed: {delivered}"
    assert len(calls) >= 2, "the latest-row check never asked for the new row"


def test_tabs_opening_together_build_the_chat_list_once(tmp_path, monkeypatch):
    # Three pages opening at the same moment each asked for the chat list, and each re-read the
    # whole recording in parallel (40% of a core for the first seconds on a real recording).
    path = _make_db(tmp_path)
    _seed_history(path)
    db_mod.clear_caches()
    builds = []
    real_load = db_mod._load_sessions_state

    def slow_load(p):
        builds.append(p)
        time.sleep(0.2)  # long enough for every caller to arrive while the first build runs
        return real_load(p)

    monkeypatch.setattr(db_mod, "_load_sessions_state", slow_load)
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(db_mod.list_sessions_checked(path)))
        for _ in range(5)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(builds) == 1
    assert len(results) == 5 and all(err is None for _rows, err in results)
    assert all(rows == results[0][0] for rows, _err in results)


def test_a_row_written_mid_update_does_not_force_a_rebuild(tmp_path, monkeypatch):
    # The count comes from one read and the new rows from another; on a busy recording a row
    # landed in between every time, the numbers disagreed, and every poll re-read everything.
    path = _make_db(tmp_path)
    _seed_history(path)
    db_mod.clear_caches()
    db_mod.list_sessions_checked(path)
    writer = sqlite3.connect(path)
    _insert(writer, 5000.0, "tool.end", session="sess-1", attrs={"tool_name": "bash"})
    writer.commit()

    real_read = db_mod._read_session_rows

    def read_after_a_late_write(con, after_rowid=None, upto_rowid=None):
        _insert(writer, 5001.0, "tool.end", session="late-chat", attrs={"tool_name": "bash"})
        writer.commit()
        return real_read(con, after_rowid, upto_rowid)

    rebuilds = []
    real_load = db_mod._load_sessions_state
    monkeypatch.setattr(db_mod, "_load_sessions_state", lambda p: rebuilds.append(p) or real_load(p))
    monkeypatch.setattr(db_mod, "_read_session_rows", read_after_a_late_write)
    db_mod.list_sessions_checked(path)
    monkeypatch.setattr(db_mod, "_read_session_rows", real_read)
    assert rebuilds == []
    rows, error = db_mod.list_sessions_checked(path)
    assert error is None and "late-chat" in _roots(rows)
    assert rows == _full_rebuild(path)
    writer.close()


def test_a_row_written_during_a_full_build_is_not_lost(tmp_path, monkeypatch):
    # The full build read the rows, then counted the table in a second read: a row written in
    # between was recorded as already folded and never reached the chat list.
    path = _make_db(tmp_path)
    _seed_history(path)
    db_mod.clear_caches()
    writer = sqlite3.connect(path)
    real_purged = db_mod._purged_ids
    wrote = []

    def purged_after_a_late_write(con):
        if not wrote:
            wrote.append(1)
            _insert(writer, 5001.0, "tool.end", session="late-chat", attrs={"tool_name": "bash"})
            writer.commit()
        return real_purged(con)

    monkeypatch.setattr(db_mod, "_purged_ids", purged_after_a_late_write)
    db_mod.list_sessions_checked(path)
    monkeypatch.setattr(db_mod, "_purged_ids", real_purged)
    # The next write is folded on top: the late row must not be skipped as "already read".
    _insert(writer, 5002.0, "tool.end", session="sess-2", attrs={"tool_name": "bash"})
    writer.commit()
    rows, error = db_mod.list_sessions_checked(path)
    assert error is None and "late-chat" in _roots(rows)
    assert rows == _full_rebuild(path)
    writer.close()


def test_a_locked_read_is_not_remembered_as_no_warnings(warnings_db, monkeypatch):
    # A lock during the read used to be cached as "no warnings" until the next row was written.
    path, root, _clean = warnings_db
    path = str(path)
    db_mod.clear_caches()
    warnings_mod._WARNING_CACHE.clear()
    expected = _uncached_warnings(path, root)
    assert expected, "the fixture must produce a warning, or this test proves nothing"
    real = db_mod.events_for_root_checked
    monkeypatch.setattr(db_mod, "events_for_root_checked", lambda *a, **k: ([], "database is locked"))
    assert warnings_mod.warnings_for_root(path, root) == []
    monkeypatch.setattr(db_mod, "events_for_root_checked", real)
    assert warnings_mod.warnings_for_root(path, root) == expected
