"""The acceptance tests for the problem bundle.

These are the tests the two specs asked for: each one would fail if the redaction were wrong. The
point is that "your secrets are stripped" is checked by the machine, not asserted by me.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer.bundle import build_bundle, canonical_path, scan, write_bundle  # noqa: E402


def _db(tmp_path: Path) -> str:
    path = tmp_path / "events.db"
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE events (event_id TEXT PRIMARY KEY, ts REAL, kind TEXT, session_id TEXT,"
        " turn_id TEXT, status TEXT, attrs TEXT)"
    )
    rows = [
        # 1. a failing terminal call, whose error string carries a key and a home path
        ("evt-aaa", 1000.0, "tool_call", "sess-SECRETCHATNAME", "turn-1", "failed", json.dumps({
            "tool_name": "terminal",
            "error": "curl failed: invalid key sk-abcdef0123456789abcdef in /home/alex/client-acme",
            "duration_ms": 1200,
            "arguments": {"path": "/home/alex/client-acme/private/app.py"},
            "output": "PRINTED SOURCE CODE",
        })),
        # 2. the same call, retried and succeeding
        ("evt-bbb", 1003.0, "tool_call", "sess-SECRETCHATNAME", "turn-1", "ok", json.dumps({
            "tool_name": "terminal", "duration_ms": 900, "exit_code": 0,
        })),
        # 3. a model call
        ("evt-ccc", 1010.0, "llm_call", "sess-SECRETCHATNAME", "turn-1", "ok", json.dumps({
            "model": "deepseek-v4.1-flash", "provider": "nous",
            "input_tokens": 1200, "output_tokens": 300, "cache_read_tokens": 800,
            "cost_usd": 0.0012, "prompt": "MY PRIVATE PROMPT",
        })),
    ]
    con.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?)", rows)
    con.commit()
    con.close()
    return str(path)


def test_a_secret_in_an_error_string_never_reaches_the_bundle(tmp_path):
    bundle = build_bundle(_db(tmp_path), session_id="sess-SECRETCHATNAME")
    text = json.dumps(bundle)

    assert "sk-abcdef0123456789abcdef" not in text
    assert "[REDACTED:openai_key]" in text
    # The replacement is visible, so a reader knows something was removed rather than absent.
    assert bundle["redaction_report"]["matches"]["openai_key"] == 1
    # And the useful part of the message survives, because an error is why the bundle exists.
    assert "curl failed" in text


def test_a_chat_name_cannot_leak_through_a_path(tmp_path):
    bundle = build_bundle(_db(tmp_path), session_id="sess-SECRETCHATNAME")
    text = json.dumps(bundle)

    assert "client-acme" not in text, "directory names must not survive canonicalisation"
    assert bundle["paths"], "the path should still be recorded, by reference"
    assert bundle["paths"][0]["path"].endswith("app.py")


def test_identifiers_timestamps_prompts_and_output_are_all_excluded(tmp_path):
    bundle = build_bundle(_db(tmp_path), session_id="sess-SECRETCHATNAME")
    text = json.dumps(bundle)

    assert "evt-aaa" not in text and "sess-SECRETCHATNAME" not in text and "turn-1" not in text
    assert "MY PRIVATE PROMPT" not in text
    assert "PRINTED SOURCE CODE" not in text
    assert [event["ref"] for event in bundle["events"]] == ["e1", "e2", "e3"]
    # Relative time only: the first event is zero, the third is ten seconds later.
    assert bundle["events"][0]["elapsed_ms"] == 0
    assert bundle["events"][2]["elapsed_ms"] == 10000


def test_a_retry_is_linked_to_the_failure_it_followed(tmp_path):
    bundle = build_bundle(_db(tmp_path), session_id="sess-SECRETCHATNAME")
    events = bundle["events"]

    assert events[0]["status"] == "failure"
    assert events[1]["retry_of"] == "e1", "a same-tool step after a failure is a retry, and says so"
    assert bundle["summary"]["failed_count"] == 1
    assert bundle["summary"]["retried_count"] == 1


def test_the_written_file_is_exactly_what_was_previewed(tmp_path):
    bundle = build_bundle(_db(tmp_path), session_id="sess-SECRETCHATNAME")
    dest = write_bundle(bundle, str(tmp_path / "bundle.json"))

    with open(dest, encoding="utf-8") as handle:
        written = json.load(handle)
    # Sorted keys and a fixed indent, so the bytes on disk are the bytes that were shown.
    assert written == json.loads(json.dumps(bundle, sort_keys=True))
    assert written["schema_version"] == "1.0"
    assert written["bundle_id"] != "", "a bundle id is random, never derived from session data"


def test_a_bundle_needs_something_to_bundle(tmp_path):
    try:
        build_bundle(_db(tmp_path), session_id="no-such-session")
    except ValueError as error:
        assert "nothing recorded" in str(error)
    else:  # pragma: no cover
        raise AssertionError("an empty bundle should be refused, not written")


def test_paths_are_collapsed_but_keep_their_shape():
    counts: dict[str, int] = {}
    assert canonical_path(f"{Path.home().as_posix()}/client-acme/private/app.py", counts) == "~/…/app.py"
    assert canonical_path("C:\\Users\\someone\\notes.txt", counts) == "<drive>/…/notes.txt"
    assert canonical_path("relative/file.py", counts) == "…/file.py"
    # A filename that is itself a secret is replaced, not shipped.
    assert "sk-" not in canonical_path("/tmp/sk-abcdef0123456789abcdef", counts)
    assert counts.get("openai_key") == 1


def test_scan_leaves_ordinary_text_alone():
    clean, counts = scan("Connection refused after 3 attempts (port 8642)")
    assert clean == "Connection refused after 3 attempts (port 8642)"
    assert counts == {}
