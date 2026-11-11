"""A deleted chat must leave the recording, and a helper must not resurrect it.

Hermes fires ``on_session_delete`` after a committed delete (reason ``delete``) or a
deliberate archive (reason ``archive``). The recorder answers by removing the rows (or
hiding them) and remembering the ids, so the viewer cannot list a conversation the user
removed.
"""

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience.store import EventStore  # noqa: E402
from omniscience_viewer import db as viewer_db  # noqa: E402


def _event(session_id, kind="tool.end", parent=None, attrs="{}", seq=0):
    return (
        f"ev-{session_id}-{kind}-{seq}",
        "1",
        "boot",
        seq,
        1_700_000_000.0 + seq,
        kind,
        session_id,
        parent,
        attrs,
    )


def _write(path, rows):
    con = sqlite3.connect(path)
    try:
        con.executemany(
            "INSERT OR IGNORE INTO events (event_id, schema, boot_id, seq, ts, kind,"
            " session_id, parent_session_id, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        con.commit()
    finally:
        con.close()


def _store_with_rows(tmp_path):
    path = str(tmp_path / "e.db")
    st = EventStore(path)
    st.submit("post_tool_call", dict(session_id="warm", tool_name="terminal",
                                     tool_call_id="c0", status="ok"))
    assert st.flush(5)
    st.close()
    # "root" ran a helper ("helper"), which ran its own helper ("grandchild").
    _write(path, [
        _event("root", seq=1),
        _event("helper", parent="root", seq=2),
        _event("grandchild", parent="helper", seq=3),
        _event("other", seq=4),
    ])
    return path


def test_deleting_a_chat_removes_it_and_its_helpers(tmp_path):
    path = _store_with_rows(tmp_path)
    st = EventStore(path)
    try:
        deleted = st.purge_sessions(["root"], reason="delete")
    finally:
        st.close()
    assert deleted == 3, "the chat, its helper and the helper's own helper go together"
    con = sqlite3.connect(path)
    try:
        left = {row[0] for row in con.execute("SELECT DISTINCT session_id FROM events")}
    finally:
        con.close()
    assert left == {"other", "warm"}


def test_a_deleted_chat_is_not_listed_and_has_no_steps(tmp_path):
    path = _store_with_rows(tmp_path)
    st = EventStore(path)
    try:
        st.purge_sessions(["root"], reason="delete")
    finally:
        st.close()
    ids = [row["id"] for row in viewer_db.list_sessions(path)]
    assert "root" not in ids and "helper" not in ids
    assert "other" in ids
    assert viewer_db.events_for_root(path, "root") == []


def test_an_archived_chat_is_hidden_but_its_history_is_kept(tmp_path):
    """Archive is not delete: the conversation still exists in Hermes, and destroying the
    recordings for it would be unrecoverable. It must still disappear from the viewer."""
    path = _store_with_rows(tmp_path)
    st = EventStore(path)
    try:
        assert st.purge_sessions(["root"], reason="archive") == 0
    finally:
        st.close()
    con = sqlite3.connect(path)
    try:
        kept = con.execute("SELECT COUNT(*) FROM events WHERE session_id = 'root'").fetchone()[0]
        reasons = {row[0] for row in con.execute("SELECT reason FROM purged")}
    finally:
        con.close()
    assert kept == 1, "an archive keeps the rows"
    assert reasons == {"archive"}
    assert "root" not in [row["id"] for row in viewer_db.list_sessions(path)]


def test_a_helper_writing_after_the_delete_cannot_bring_the_chat_back(tmp_path):
    path = _store_with_rows(tmp_path)
    st = EventStore(path)
    try:
        st.purge_sessions(["root"], reason="delete")
    finally:
        st.close()
    # The in-flight helper lands one more row after the purge.
    _write(path, [_event("helper", seq=99), _event("new-helper", parent="root", seq=100)])
    ids = [row["id"] for row in viewer_db.list_sessions(path)]
    assert "helper" not in ids and "new-helper" not in ids


def test_purge_is_idempotent(tmp_path):
    path = _store_with_rows(tmp_path)
    st = EventStore(path)
    try:
        st.purge_sessions(["root"], reason="delete")
        assert st.purge_sessions(["root"], reason="delete") == 0
    finally:
        st.close()


def test_purge_never_raises_on_a_bad_id(tmp_path):
    path = _store_with_rows(tmp_path)
    st = EventStore(path)
    try:
        assert st.purge_sessions([None, "", 7], reason="delete") == 0
        assert st.purge_sessions(None) == 0
    finally:
        st.close()


def test_an_older_database_without_the_purged_table_still_lists(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    try:
        con.execute(
            "CREATE TABLE events (rowid INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL,"
            " schema TEXT NOT NULL, boot_id TEXT NOT NULL, seq INTEGER NOT NULL, ts REAL NOT NULL,"
            " kind TEXT NOT NULL, session_id TEXT, parent_session_id TEXT, turn_id TEXT,"
            " api_request_id TEXT, tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT)"
        )
        con.execute(
            "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id)"
            " VALUES ('e1', '1', 'b', 1, 1.0, 'tool.end', 's1')"
        )
        con.commit()
    finally:
        con.close()
    assert [row["id"] for row in viewer_db.list_sessions(str(path))] == ["s1"]
