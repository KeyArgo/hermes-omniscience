import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer.export import (
    CHAT_COLUMNS,
    MODEL_COLUMNS,
    STEP_COLUMNS,
    export_chats,
    export_models,
    export_steps,
)


def _create_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    conn.execute(
        """
        CREATE TABLE events (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            schema TEXT,
            boot_id TEXT,
            seq INTEGER,
            ts REAL,
            kind TEXT,
            session_id TEXT,
            parent_session_id TEXT,
            turn_id TEXT,
            api_request_id TEXT,
            tool_call_id TEXT,
            subagent_id TEXT,
            status TEXT,
            attrs TEXT
        )
        """
    )

    rows = [
        # Root chat session
        (
            "e1", "v1", "b1", 1, 1000.0, "session.start", "chat1", None, None, None, None, None, None,
            '{"model":"gpt-4","platform":"web"}'
        ),
        # Turn 1
        (
            "e2", "v1", "b1", 2, 1001.0, "turn.start", "chat1", None, "t1", None, None, None, None,
            '{"model":"gpt-4","platform":"web","user_chars":100}'
        ),
        # LLM request 1 (main)
        (
            "e3", "v1", "b1", 3, 1002.0, "llm.request", "chat1", None, "t1", "req1", None, None, None,
            '{"model":"gpt-4","provider":"openai","message_count":1,"tool_count":0,"approx_input_tokens":100,"retry_count":0}'
        ),
        # LLM response 1
        (
            "e4", "v1", "b1", 4, 1004.0, "llm.response", "chat1", None, "t1", "req1", None, None, "ok",
            '{"duration_s":2.0,"ttfb_s":0.5,"started_at":1002.0,"ended_at":1004.0,"finish_reason":"stop","response_model":"gpt-4","usage":{"prompt_tokens":100,"input_tokens":100,"cache_read_tokens":20,"cache_write_tokens":0,"output_tokens":50,"reasoning_tokens":0}}'
        ),
        # Turn 2
        (
            "e5", "v1", "b1", 5, 1005.0, "turn.start", "chat1", None, "t2", None, None, None, None,
            '{"model":"gpt-4","platform":"web","user_chars":50}'
        ),
        # Rate-limited request then succeeded with fallback
        (
            "e6", "v1", "b1", 6, 1006.0, "llm.request", "chat1", None, "t2", "req2", None, None, None,
            '{"model":"gpt-4","provider":"openai","message_count":2,"tool_count":0,"approx_input_tokens":200,"retry_count":0}'
        ),
        (
            "e7", "v1", "b1", 7, 1007.0, "llm.error", "chat1", None, "t2", "req2", None, None, "error",
            '{"duration_s":1.0,"reason":"rate_limit","status_code":429,"error_type":"rate_limit","retryable":true}'
        ),
        (
            "e8", "v1", "b1", 8, 1008.0, "llm.request", "chat1", None, "t2", "req2", None, None, None,
            '{"model":"gpt-4","provider":"openai","message_count":2,"tool_count":0,"approx_input_tokens":200,"retry_count":1}'
        ),
        (
            "e9", "v1", "b1", 9, 1010.0, "llm.response", "chat1", None, "t2", "req2", None, None, "ok",
            '{"duration_s":2.0,"ttfb_s":0.3,"started_at":1008.0,"ended_at":1010.0,"finish_reason":"stop","response_model":"gpt-3.5-turbo","usage":{"prompt_tokens":200,"input_tokens":200,"cache_read_tokens":50,"cache_write_tokens":0,"output_tokens":80,"reasoning_tokens":0}}'
        ),
        # Tool error
        (
            "e10", "v1", "b1", 10, 1011.0, "tool.end", "chat1", None, "t2", None, "tc1", None, "error",
            '{"tool_name":"search","duration_ms":500,"started_at":1010.5,"result_chars":0,"arg_names":["query"],"error_type":"timeout"}'
        ),
        # Background call
        (
            "e11", "v1", "b1", 11, 1012.0, "aux.request", "chat1", None, "t2", None, None, "sub1", None,
            '{"aux_task":"summarize","model":"gpt-4o-mini","provider":"openai"}'
        ),
        (
            "e12", "v1", "b1", 12, 1013.0, "aux.response", "chat1", None, "t2", None, None, "sub1", "ok",
            '{"duration_s":1.0,"usage":{"prompt_tokens":50,"input_tokens":50,"cache_read_tokens":0,"cache_write_tokens":0,"output_tokens":20,"reasoning_tokens":0},"response_model":"gpt-4o-mini"}'
        ),
        # Helper session
        (
            "e13", "v1", "b1", 13, 1014.0, "subagent.start", "chat1", None, "t2", None, None, "sub2", None,
            '{"child_session_id":"helper1","child_status":"completed","duration_ms":1000}'
        ),
        (
            "e14", "v1", "b1", 14, 1014.5, "session.start", "helper1", "chat1", None, None, None, None, None,
            '{"model":"gpt-4","platform":"web"}'
        ),
        # Helper tool
        (
            "e15", "v1", "b1", 15, 1015.0, "tool.end", "helper1", "chat1", None, None, "tc2", None, "ok",
            '{"tool_name":"fetch","duration_ms":300,"started_at":1015.0,"result_chars":100,"arg_names":["url"]}'
        ),
        (
            "e16", "v1", "b1", 16, 1016.0, "session.end", "helper1", "chat1", None, None, None, None, None,
            '{"completed":true,"interrupted":false}'
        ),
        # Session end
        (
            "e17", "v1", "b1", 17, 1020.0, "session.end", "chat1", None, None, None, None, None, None,
            '{"completed":true,"interrupted":false}'
        ),
    ]

    conn.executemany(
        "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, parent_session_id, turn_id, api_request_id, tool_call_id, subagent_id, status, attrs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()


def test_headers_exact():
    assert STEP_COLUMNS == [
        "chat_id", "helper_of", "message_number", "step_number", "kind",
        "started_at", "duration_s", "first_word_wait_s", "model_requested",
        "model_answered", "provider", "fell_back", "tokens_new_input",
        "tokens_cached_input", "tokens_output", "tokens_reasoning",
        "output_tokens_per_s", "tool_name", "mcp_server", "background_task",
        "status", "error_type", "http_status", "retry", "imported",
    ]
    assert CHAT_COLUMNS == [
        "chat_id", "platform", "started_at", "ended_at", "duration_s",
        "messages", "model_calls", "tool_runs", "background_calls", "helpers",
        "failures", "rate_limits", "fallbacks", "tokens_new_input",
        "tokens_cached_input", "tokens_output", "cache_share_pct",
        "median_first_word_wait_s", "longest_step_s", "most_used_tool",
        "models_used", "imported",
    ]
    assert MODEL_COLUMNS == [
        "model", "provider", "calls", "failed_calls", "rate_limited_calls",
        "tokens_new_input", "tokens_cached_input", "tokens_output",
        "median_duration_s", "median_first_word_wait_s",
        "median_output_tokens_per_s", "as_fallback_calls",
    ]


def test_bom_present(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_steps(str(db), "chat1")
    assert text.startswith("\ufeff")


def test_empty_db_header_only(tmp_path):
    db = tmp_path / "empty.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE events (rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT)"
    )
    conn.commit()
    conn.close()

    steps = export_steps(str(db), None)
    assert steps.startswith("\ufeff")
    lines = steps.lstrip("\ufeff").split("\r\n")
    assert lines[0].lstrip("\ufeff") == ",".join(STEP_COLUMNS)
    assert len([l for l in lines if l.strip()]) == 1

    chats = export_chats(str(db))
    assert chats.startswith("\ufeff")
    lines = chats.lstrip("\ufeff").split("\r\n")
    assert lines[0].lstrip("\ufeff") == ",".join(CHAT_COLUMNS)

    models = export_models(str(db), None)
    assert models.startswith("\ufeff")
    lines = models.lstrip("\ufeff").split("\r\n")
    assert lines[0].lstrip("\ufeff") == ",".join(MODEL_COLUMNS)


def test_row_counts_per_kind(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_steps(str(db), "chat1")
    lines = text.lstrip("\ufeff").split("\r\n")
    header = lines[0]
    assert header == ",".join(STEP_COLUMNS)

    data_lines = [l for l in lines[1:] if l.strip()]
    kinds = []
    for line in data_lines:
        import csv
        import io
        reader = csv.reader(io.StringIO(line))
        row = next(reader)
        kinds.append(row[4])  # kind column

    # One row per model call; a retried attempt shows on that row (retry, rate_limit, 429).
    assert kinds.count("model_call") == 2  # req1, req2 (retried after a 429)
    assert kinds.count("tool") == 2  # search error + fetch ok
    assert kinds.count("background_call") == 1
    assert kinds.count("helper") == 1
    assert kinds.count("error") == 0  # the rate_limit error is paired with retry1 response, so not unanswered


def test_fell_back_yes(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_steps(str(db), "chat1")
    import csv
    import io
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff")))
    rows = list(reader)
    header = rows[0]
    fell_back_idx = header.index("fell_back")
    model_answered_idx = header.index("model_answered")
    model_requested_idx = header.index("model_requested")

    found_fallback = False
    for row in rows[1:]:
        if row[fell_back_idx] == "yes":
            assert row[model_requested_idx] == "gpt-4"
            assert row[model_answered_idx] == "gpt-3.5-turbo"
            found_fallback = True
    assert found_fallback


def test_rate_limits_in_chats(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_chats(str(db))
    import csv
    import io
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff")))
    rows = list(reader)
    header = rows[0]
    rate_limits_idx = header.index("rate_limits")
    assert len(rows) == 2  # header + 1 chat
    assert rows[1][rate_limits_idx] == "1"


def test_failures_in_chats(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_chats(str(db))
    import csv
    import io
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff")))
    rows = list(reader)
    header = rows[0]
    failures_idx = header.index("failures")
    # 1 tool error + 0 unanswered model errors (rate_limit was answered by retry)
    assert rows[1][failures_idx] == "1"


def test_tokens_math(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_steps(str(db), "chat1")
    import csv
    import io
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff")))
    rows = list(reader)
    header = rows[0]
    ni_idx = header.index("tokens_new_input")
    ci_idx = header.index("tokens_cached_input")
    out_idx = header.index("tokens_output")

    # First model call: prompt=100, cache_read=20 -> new=80, cached=20, output=50
    model_call_rows = [r for r in rows[1:] if r[header.index("kind")] == "model_call"]
    first_mc = model_call_rows[0]
    assert first_mc[ni_idx] == "80"
    assert first_mc[ci_idx] == "20"
    assert first_mc[out_idx] == "50"


def test_root_none_covers_all(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text_all = export_steps(str(db), None)
    text_chat = export_steps(str(db), "chat1")
    # Both should have same data rows since only one chat exists
    all_lines = [l for l in text_all.split("\r\n") if l.strip()]
    chat_lines = [l for l in text_chat.split("\r\n") if l.strip()]
    assert len(all_lines) == len(chat_lines)


def test_unknown_attrs_never_appear(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_steps(str(db), "chat1")
    # Ensure no raw JSON keys leak into output
    forbidden = ["message_count", "tool_count", "approx_input_tokens", "result_chars", "arg_names", "ended_at", "finish_reason", "cache_write_tokens", "retryable", "completed", "interrupted", "user_chars"]
    for key in forbidden:
        assert key not in text, f"Unknown attrs key '{key}' leaked into output"


def test_models_export(tmp_path):
    db = tmp_path / "test.db"
    _create_db(db)
    text = export_models(str(db), "chat1")
    import csv
    import io
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff")))
    rows = list(reader)
    header = rows[0]
    assert ",".join(header) == ",".join(MODEL_COLUMNS)
    # Should have rows for gpt-4 and gpt-3.5-turbo and gpt-4o-mini
    models = [r[0] for r in rows[1:]]
    assert "gpt-4" in models
    assert "gpt-3.5-turbo" in models
    assert "gpt-4o-mini" in models


def test_export_endpoint_needs_key_and_returns_csv(tmp_path):
    from fastapi.testclient import TestClient
    from omniscience_viewer.app import create_app

    db = tmp_path / "test.db"
    _create_db(db)
    client = TestClient(create_app(str(db), token="k"), base_url="http://127.0.0.1")
    assert client.get("/api/v1/export/steps.csv?root=chat1").status_code == 401
    r = client.get("/api/v1/export/steps.csv?root=chat1", headers={"x-omni-token": "k"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    assert r.text.lstrip("﻿").startswith("chat_id,")
    assert client.get("/api/v1/export/nope.csv", headers={"x-omni-token": "k"}).status_code == 404


# --- bug hunt round 2 (2026-11-09): spreadsheet formula injection ------------------
# A recorded tool/model/provider name is attacker-influenced data (an MCP server names its own
# tools; a provider names its own model). csv.writer quotes such a value, but Excel and
# LibreOffice still evaluate a quoted cell that begins with = + - @ or a control character,
# so opening the export could run a formula. Each cell that would do that is now prefixed
# with an apostrophe, which spreadsheets treat as "this is text".

_DANGEROUS = ("=", "+", "-", "@", "\t", "\r")


def _cells(text: str) -> list[str]:
    import csv
    import io

    return [cell for row in csv.reader(io.StringIO(text.lstrip("\ufeff"))) for cell in row]


def _formula_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    conn.execute(
        "CREATE TABLE events (rowid INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, schema TEXT,"
        " boot_id TEXT, seq INTEGER, ts REAL, kind TEXT, session_id TEXT, parent_session_id TEXT,"
        " turn_id TEXT, api_request_id TEXT, tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT)"
    )
    evil_tool = '=HYPERLINK("http://example.invalid","click me")'
    evil_model = "=cmd|' /C calc'!A0"
    rows = [
        ("e1", "v1", "b1", 1, 1000.0, "session.start", "chat1", None, None, None, None, None, None,
         '{"model":"gpt-4"}'),
        ("e2", "v1", "b1", 2, 1001.0, "turn.start", "chat1", None, "t1", None, None, None, None,
         '{"model":"gpt-4"}'),
        ("e3", "v1", "b1", 3, 1002.0, "llm.request", "chat1", None, "t1", "req1", None, None, None,
         '{"model":"' + evil_model.replace('"', '\\"') + '","provider":"openai"}'),
        ("e4", "v1", "b1", 4, 1003.0, "llm.response", "chat1", None, "t1", "req1", None, None, "ok", "{}"),
        ("e5", "v1", "b1", 5, 1004.0, "tool.end", "chat1", None, "t1", "req1", "call1", None, "ok",
         '{"tool_name":"' + evil_tool.replace('"', '\\"') + '","duration_ms":5,"arg_names":["command"]}'),
    ]
    conn.executemany(
        "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, parent_session_id,"
        " turn_id, api_request_id, tool_call_id, subagent_id, status, attrs)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()


def test_exported_cells_cannot_be_spreadsheet_formulas(tmp_path):
    db = tmp_path / "events.db"
    _formula_db(db)
    for name, text in (
        ("steps", export_steps(str(db), "chat1")),
        ("chats", export_chats(str(db))),
        ("models", export_models(str(db), "chat1")),
    ):
        bad = [c for c in _cells(text) if c.startswith(_DANGEROUS)]
        assert not bad, f"{name} export would be evaluated as a formula: {bad[:3]}"
    # The data must still be there, only defused.
    assert "HYPERLINK" in export_steps(str(db), "chat1")


def test_a_response_consumed_by_a_helper_is_not_offered_to_the_next_call(tmp_path):
    """A background response pairs with exactly one request.

    The subagent-matching branch popped its response but never recorded it as used, so a later
    background request without a subagent id took the fallback and picked the same response
    again: two rows, one answer, and the second reported tokens it never spent.
    """
    db = tmp_path / "events.db"
    _create_db(db)
    conn = sqlite3.connect(str(db))
    cols = ("event_id, schema, boot_id, seq, ts, kind, session_id, parent_session_id, turn_id,"
            " api_request_id, tool_call_id, subagent_id, status, attrs")
    rows = [
        ("a1", "v1", "b1", 1, 1000.0, "session.start", "chat1", None, None, None, None, None, None,
         '{"model":"gpt-4","platform":"web"}'),
        ("a2", "v1", "b1", 2, 1001.0, "turn.start", "chat1", None, "t1", None, None, None, None,
         '{"model":"gpt-4","platform":"web","user_chars":10}'),
        # background pair that carries a subagent id
        ("a3", "v1", "b1", 3, 1002.0, "aux.request", "chat1", None, "t1", None, None, "sub1", None,
         '{"aux_task":"summarize","model":"m1","provider":"p"}'),
        ("a4", "v1", "b1", 4, 1003.0, "aux.response", "chat1", None, "t1", None, None, "sub1", "ok",
         '{"duration_s":1.0,"response_model":"m1","usage":{"prompt_tokens":5,"input_tokens":5,'
         '"cache_read_tokens":0,"cache_write_tokens":0,"output_tokens":111,"reasoning_tokens":0}}'),
        # background pair with no subagent id: must take the *other* response
        ("a5", "v1", "b1", 5, 1004.0, "aux.request", "chat1", None, "t1", None, None, None, None,
         '{"aux_task":"title","model":"m2","provider":"p"}'),
        ("a6", "v1", "b1", 6, 1005.0, "aux.response", "chat1", None, "t1", None, None, None, "ok",
         '{"duration_s":1.0,"response_model":"m2","usage":{"prompt_tokens":7,"input_tokens":7,'
         '"cache_read_tokens":0,"cache_write_tokens":0,"output_tokens":222,"reasoning_tokens":0}}'),
    ]
    conn.executemany(f"insert into events ({cols}) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()

    text = export_steps(str(db), "chat1")
    assert "111" in text and "222" in text, text
