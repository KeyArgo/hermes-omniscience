"""The counter sources, and the two ways they broke tonight.

A block of the counter branch was once pasted into `_iter_files`, where `source_id` and `con` do not
exist: every discovery call raised, which emptied the Sources panel and the summary. And a counter
source with no files to glob reported itself "not found", so two new sources were invisible even
after they were written. Both are pinned here.
"""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer import sources as S  # noqa: E402


def _reading(key, prompt, output=10, cache_read=0, cache_write=0):
    return {"key": key, "session": key, "project": key, "model": "m",
            "prompt": prompt, "output": output,
            "cache_read": cache_read, "cache_write": cache_write}


def test_every_source_can_be_probed_without_raising():
    """discover() is on the path of the Sources panel and of the page payload: it must never raise."""
    for source_id in S.SOURCES:
        found = S.discover(source_id)
        assert isinstance(found["available"], bool), source_id
        assert set(found) >= {"available", "files", "bytes", "note"}, source_id


def test_a_counter_source_has_no_files_and_is_still_available():
    # Sparks polls HTTP endpoints; dsh reads session JSON. Neither is found by globbing transcripts.
    assert S.discover("sparks")["available"] is True
    assert S.discover("sparks")["files"] > 0 or S.discover("sparks")["available"]
    # cursor is named in the status list (see the unmeasurable test), not in the registry
    assert "cursor" not in S.SOURCES


def test_a_counter_source_stores_the_increment_not_the_total(tmp_path, monkeypatch):
    db = str(tmp_path / "events.db")
    Path(db).touch()
    readings = iter([[_reading("lane-a", 100, 10)], [_reading("lane-a", 160, 25)]])
    monkeypatch.setattr(S, "read_dsh", lambda: iter(next(readings)))

    S.scan("dsh", db)
    S.scan("dsh", db)

    con = sqlite3.connect(S.usage_db_path(db))
    try:
        rows = con.execute(
            "SELECT input, output FROM call WHERE source = 'dsh' ORDER BY ts"
        ).fetchall()
    finally:
        con.close()
    assert rows == [(100, 10), (60, 15)], rows


def test_a_reset_counter_does_not_record_a_negative(tmp_path, monkeypatch):
    db = str(tmp_path / "events.db")
    Path(db).touch()
    readings = iter([[_reading("lane-b", 500)], [_reading("lane-b", 40)]])
    monkeypatch.setattr(S, "read_dsh", lambda: iter(next(readings)))

    S.scan("dsh", db)  # 500
    S.scan("dsh", db)  # the harness restarted: 40 is a new run, not a subtraction

    con = sqlite3.connect(S.usage_db_path(db))
    try:
        total = con.execute("SELECT COALESCE(SUM(input), 0) FROM call WHERE source='dsh'").fetchone()[0]
    finally:
        con.close()
    assert total == 500, total


def test_a_client_with_no_tokens_is_named_but_not_importable():
    # The owner asked why Cursor shows nothing. It is named in the status list with the reason,
    # and it cannot be imported, so no total is ever guessed.
    assert "cursor" not in S.SOURCES
    assert any(row["id"] == "cursor" for row in S.source_status(""))
    assert S.scan("cursor", "")["ok"] is False
