"""Regression: the chat-list token math must count cache-write tokens.

The Usage page (``usage._usage``) and the chat list (``db._usage_numbers``) are
contractually meant to agree on how many prompt tokens a call sent — the module
docstrings say so ("so the chat list and the per-call chart agree"). A
cache-warming call reports its context as *write* tokens with no ``prompt_tokens``
field (the Anthropic shape: ``input_tokens`` + ``cache_creation_input_tokens``),
so the fallback that reconstructs the prompt must include ``cache_write_tokens``.
``usage._usage`` does; ``db._usage_numbers`` used to drop them, counting a
19k-token warming call as a few hundred tokens and making the two surfaces
disagree.
"""

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import db as db_mod  # noqa: E402
from omniscience_viewer import usage as usage_mod  # noqa: E402

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


def test_usage_numbers_counts_cache_write_in_prompt_fallback():
    # A cache-warming call: no prompt_tokens, a little fresh input, a large written cache.
    usage = {
        "input_tokens": 300,
        "cache_write_tokens": 19000,
        "cache_read_tokens": 0,
        "output_tokens": 50,
    }
    cached, fresh, output, prompt = db_mod._usage_numbers(usage)
    # The real context sent is input + written cache = 19,300 tokens, not 300.
    assert prompt == 19300, prompt
    assert fresh == 19300, fresh


def test_db_and_usage_agree_on_cache_warming_prompt():
    """The two surfaces must report the same prompt for the same call."""
    attrs = {
        "usage": {
            "input_tokens": 300,
            "cache_write_tokens": 19000,
            "cache_read_tokens": 0,
            "output_tokens": 50,
        }
    }
    db_prompt = db_mod._usage_numbers(attrs["usage"])[3]
    page_prompt = usage_mod._usage(attrs)["prompt"]
    assert db_prompt == page_prompt == 19300


def test_list_sessions_prompt_reflects_cache_warming(tmp_path):
    path = tmp_path / "events.db"
    con = sqlite3.connect(str(path))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    con.execute(
        "INSERT INTO events (seq, ts, kind, session_id, status, attrs) VALUES (?, ?, ?, ?, ?, ?)",
        (
            1,
            1000.0,
            "llm.response",
            "sess-warm",
            "ok",
            '{"usage":{"input_tokens":300,"cache_write_tokens":19000,'
            '"cache_read_tokens":0,"output_tokens":50}}',
        ),
    )
    con.commit()
    con.close()

    roots = db_mod.list_sessions(str(path))
    assert len(roots) == 1
    row = roots[0]
    # The chat list must show the real context size, not a few hundred tokens.
    assert row["prompt_max"] == 19300, row["prompt_max"]
    assert row["prompt_now"] == 19300, row["prompt_now"]
