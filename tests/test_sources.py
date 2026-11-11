"""The multi-harness importer: what happens on the second scan, and to odd lines.

Every test here failed against the importer as first written. The module had no tests at all,
which is why three data-loss defects survived: an incremental read lost the session header, a
transcript line without an id was dropped, and a file larger than one read was skipped forever.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from omniscience_viewer import sources


def _codex_lines(model: str, inputs: list[int]) -> list[dict]:
    lines = [
        {"type": "session_meta", "payload": {"id": "sess-1", "model": model, "cwd": "/proj"}},
    ]
    for i, tokens in enumerate(inputs):
        lines.append({
            "type": "event_msg",
            "timestamp": f"2026-11-09T10:0{i}:00Z",
            "payload": {"type": "token_count",
                        "info": {"last_token_usage": {"input_tokens": tokens, "output_tokens": 5}}},
        })
    return lines


def _write(path, lines):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")


def _rows(events_db, source="codex"):
    con = sqlite3.connect(sources.usage_db_path(str(events_db)))
    try:
        return con.execute(
            "SELECT model, input FROM call WHERE source = ? ORDER BY ts", (source,)
        ).fetchall()
    finally:
        con.close()


@pytest.fixture()
def codex_tree(tmp_path, monkeypatch):
    root = tmp_path / "codex"
    root.mkdir()
    monkeypatch.setattr(sources.SOURCES["codex"], "roots", [str(root)])
    return root


def test_a_second_scan_keeps_the_model_the_header_named(tmp_path, codex_tree):
    """An appended turn is read from the byte cursor, which is past session_meta.

    The parser learned the model from a line it no longer sees, so the new call was stored with
    model NULL — and the per-model totals that the Usage page exists to show then undercounted
    that harness without saying so.
    """
    path = codex_tree / "sess-1.jsonl"
    _write(path, _codex_lines("gpt-5-codex", [100]))
    events_db = tmp_path / "events.db"

    first = sources.scan("codex", str(events_db))
    assert first["ok"] and first["new_calls"] == 1, first

    _write(path, _codex_lines("gpt-5-codex", [100, 200]))
    second = sources.scan("codex", str(events_db))
    assert second["ok"] and second["new_calls"] == 1, second

    rows = _rows(events_db)
    assert rows == [("gpt-5-codex", 100), ("gpt-5-codex", 200)], rows


def test_a_line_without_any_id_is_still_imported(tmp_path, monkeypatch):
    """Claude transcripts are deduped by request id; a line carrying none was given ''.

    The empty string was then remembered, so every later id-less line in the same file was
    discarded — and a second file competed for the same primary key.
    """
    root = tmp_path / "claude" / "proj"
    monkeypatch.setattr(sources.SOURCES["claude-code"], "roots", [str(tmp_path / "claude")])
    path = root / "sess.jsonl"
    lines = [
        {"timestamp": f"2026-11-09T10:0{i}:00Z",
         "message": {"model": "claude-sonnet-4",
                     "usage": {"input_tokens": 10 * (i + 1), "output_tokens": 1}}}
        for i in range(3)
    ]
    _write(path, lines)
    events_db = tmp_path / "events.db"

    result = sources.scan("claude-code", str(events_db))
    assert result["ok"], result
    assert result["new_calls"] == 3, result
    assert _rows(events_db, "claude-code") == [("claude-sonnet-4", 10),
                                               ("claude-sonnet-4", 20),
                                               ("claude-sonnet-4", 30)]


def test_a_file_bigger_than_one_read_is_finished_next_time(tmp_path, codex_tree, monkeypatch):
    """MAX_FILE_BYTES caps one read; the rest of the file must be read by the next scan.

    Instead the scan recorded the file's full size next to a part-way cursor, so the
    "unchanged since the last scan" check matched and the tail was never read.
    """
    monkeypatch.setattr(sources, "MAX_FILE_BYTES", 220)
    path = codex_tree / "sess-1.jsonl"
    _write(path, _codex_lines("gpt-5-codex", [100, 200, 300]))
    events_db = tmp_path / "events.db"

    sources.scan("codex", str(events_db))
    sources.scan("codex", str(events_db))
    sources.scan("codex", str(events_db))

    rows = _rows(events_db)
    assert [tokens for _, tokens in rows] == [100, 200, 300], rows


def test_a_streamed_request_keeps_its_final_usage_not_its_first(tmp_path, monkeypatch):
    """Claude writes one request across several lines while it streams, and the usage grows.

    On this machine 53% of usage lines repeat a request id, and the later line carries the real
    output_tokens — 1 on the first line, 243 on the last. Keeping the first line stored 1, so the
    tokens-out total for that harness was two orders of magnitude low.
    """
    root = tmp_path / "claude" / "proj"
    monkeypatch.setattr(sources.SOURCES["claude-code"], "roots", [str(tmp_path / "claude")])
    path = root / "sess.jsonl"
    _write(path, [
        {"requestId": "req_1", "timestamp": "2026-11-09T10:00:00Z",
         "message": {"model": "claude-sonnet-4",
                     "usage": {"input_tokens": 2, "cache_read_input_tokens": 28201,
                               "output_tokens": 1}}},
        {"requestId": "req_1", "timestamp": "2026-11-09T10:00:02Z",
         "message": {"model": "claude-sonnet-4",
                     "usage": {"input_tokens": 2, "cache_read_input_tokens": 28201,
                               "output_tokens": 243}}},
    ])
    events_db = tmp_path / "events.db"
    result = sources.scan("claude-code", str(events_db))
    assert result["ok"] and result["new_calls"] == 1, result

    con = sqlite3.connect(sources.usage_db_path(str(events_db)))
    try:
        assert con.execute("SELECT input, cache_read, output FROM call").fetchall() == [(2, 28201, 243)]
    finally:
        con.close()


def test_every_known_client_is_listed_even_when_it_cannot_be_read():
    """A missing row reads as "Omniscience forgot Cursor"; a row saying why is an answer."""
    from omniscience_viewer import sources

    rows = sources.source_status("")  # no usage.db yet: the list must still be complete
    ids = {row["id"] for row in rows}
    assert {"cursor", "gemini-cli"} <= ids
    declared = {row["id"]: row for row in rows if row.get("declared")}
    assert declared["cursor"]["available"] is False
    assert declared["cursor"]["enabled"] is False
    assert "no local token counts" in declared["cursor"]["note"].lower()


def test_a_client_that_keeps_no_usage_cannot_be_switched_on():
    from omniscience_viewer import sources

    assert "cursor" not in sources.SOURCES
    assert "gemini-cli" not in sources.SOURCES
    # The switch route refuses any id outside SOURCES, so a declared row can never import.
    assert sources.scan("cursor", "")["ok"] is False
def test_a_request_still_streaming_at_scan_time_is_corrected_on_the_next_scan(tmp_path, monkeypatch):
    """"Last line wins" has to hold ACROSS scans, not only within one.

    A Claude request can still be streaming when a scan runs: the first scan sees only the early
    line (output=1); the byte cursor then advances past it, so the final line (output=243) is
    read only by the next scan. ``INSERT OR IGNORE`` saw the row already present and dropped the
    correction, leaving the tokens-out count two orders of magnitude low — the very under-count
    the parser's last-line-wins rule exists to prevent.
    """
    root = tmp_path / "claude" / "proj"
    monkeypatch.setattr(sources.SOURCES["claude-code"], "roots", [str(tmp_path / "claude")])
    path = root / "sess.jsonl"
    early = {"requestId": "req_1", "timestamp": "2026-11-09T10:00:00Z",
             "message": {"model": "claude-sonnet-4",
                         "usage": {"input_tokens": 2, "cache_read_input_tokens": 28201,
                                   "output_tokens": 1}}}
    _write(path, [early])
    events_db = tmp_path / "events.db"
    first = sources.scan("claude-code", str(events_db))
    assert first["ok"], first

    # The request finishes; its final line is appended and only the next scan reads it.
    final = {"requestId": "req_1", "timestamp": "2026-11-09T10:00:02Z",
             "message": {"model": "claude-sonnet-4",
                         "usage": {"input_tokens": 2, "cache_read_input_tokens": 28201,
                                   "output_tokens": 243}}}
    _write(path, [early, final])
    second = sources.scan("claude-code", str(events_db))
    assert second["ok"], second

    con = sqlite3.connect(sources.usage_db_path(str(events_db)))
    try:
        assert con.execute("SELECT input, cache_read, output FROM call").fetchall() == [(2, 28201, 243)]
    finally:
        con.close()
