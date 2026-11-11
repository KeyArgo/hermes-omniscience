"""The privacy record: what gets listed, and what a flag contains.

The flag is the evidence trail. If it does not carry the action, its neighbours and both clock
times, it is not worth writing; if it carries message text, it is a liability.
"""

import json
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import privacy  # noqa: E402

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


def build(tmp_path: Path, now: float | None = None) -> str:
    now = now or time.time()
    db = tmp_path / "events.db"
    con = sqlite3.connect(str(db))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    rows = [
        (now - 300, "llm.request", "s1", "t1", {"model": "m"}),
        (now - 240, "tool.end", "s1", "t1", {"tool_name": "terminal"}),
        (now - 120, "tool.end", "s1", "t1", {"tool_name": "browser_exec", "duration_ms": 4200}),
        (now - 90, "tool.end", "s1", "t1", {"tool_name": "web_search"}),
        (now - 60, "tool.end", "s1", "t1", {"tool_name": "mcp__fs__read"}),
        (now - 30, "tool.end", "s1", "t1", {"tool_name": "grep", "files": 40}),
        (now - 10, "tool.end", "s1", "t1", {"tool_name": "grep", "files": 2}),
    ]
    for i, (ts, kind, session, turn, attrs) in enumerate(rows):
        con.execute(
            "INSERT INTO events (event_id, ts, kind, session_id, turn_id, status, attrs) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"e{i}", ts, kind, session, turn, "ok", json.dumps(attrs)),
        )
    con.commit()
    con.close()
    return str(db)


def test_wide_sweeps_are_flagged_but_small_reads_are_not():
    assert privacy.classify("grep", {"files": 40}) == "sweep"
    assert privacy.classify("grep", {"paths": ["a", "b", "c", "d", "e", "f"]}) == "sweep"
    assert privacy.classify("grep", {"files": 5}) is None
    assert privacy.classify("grep") is None


def test_browser_desktop_network_and_mcp_are_classified():
    assert privacy.classify("browser_exec") == "browser"
    assert privacy.classify("computer_use") == "computer"
    assert privacy.classify("web_search") == "network"
    assert privacy.classify("mcp__filesystem__read") == "mcp"
    assert privacy.classify("terminal") is None


def test_listing_keeps_the_loud_and_the_quiet(tmp_path):
    db = build(tmp_path)
    runs = privacy.list_runs(db, days=1)
    tools = [run["tool"] for run in runs]
    assert "terminal" not in tools
    assert tools.count("grep") == 1  # the two-file read is not privacy-relevant
    assert {run["cls"] for run in runs} == {"browser", "network", "mcp", "sweep"}
    assert all(run["tone"] in ("high", "low") for run in runs)


def test_a_flag_carries_the_action_its_neighbours_and_both_times(tmp_path):
    db = build(tmp_path)
    result = privacy.write_flag(db, str(tmp_path), "s1", "e2", note="why is it browsing")
    assert result["ok"] is True
    payload = json.loads(Path(result["path"]).read_text())
    assert payload["session_id"] == "s1"
    assert payload["action"]["tool"] == "browser_exec"
    assert payload["action"]["attrs"]["duration_ms"] == 4200
    assert payload["action"]["at"] and payload["flagged_at_local"]
    assert payload["session"]["events"] == 7
    # The steps around it, so the action can be read in context.
    assert len(payload["context"]) >= 5
    kinds = [step["kind"] for step in payload["context"]]
    assert "llm.request" in kinds
    # Only privacy-relevant calls are summarised, not every step.
    assert [event["cls"] for event in payload["session"]["privacy_events"]] == [
        "browser",
        "network",
        "mcp",
        "sweep",
    ]
    assert payload["note"] == "why is it browsing"


def test_flags_are_listed_newest_first(tmp_path):
    db = build(tmp_path)
    privacy.write_flag(db, str(tmp_path), "s1", "e2", note="first")
    time.sleep(1.1)
    privacy.write_flag(db, str(tmp_path), "s1", "e5", note="second")
    flags = privacy.list_flags(str(tmp_path))
    assert len(flags) == 2
    assert flags[0]["note"] == "second"


def test_chat_names_are_read_live_so_a_rename_shows_up(tmp_path, monkeypatch):
    """The Privacy page must show the chat's current name, not the one it had when the step ran."""
    import sqlite3

    from omniscience_viewer.privacy import chat_titles, list_runs

    state = tmp_path / "state.db"
    con = sqlite3.connect(state)
    con.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT)")
    con.execute("INSERT INTO sessions VALUES ('s-1', 'Fix the parser', NULL)")
    con.commit()
    con.close()

    con = sqlite3.connect(tmp_path / "events.db")
    con.execute(
        "CREATE TABLE events (event_id TEXT PRIMARY KEY, ts REAL, kind TEXT, session_id TEXT,"
        " turn_id TEXT, status TEXT, attrs TEXT)"
    )
    con.execute(
        "INSERT INTO events VALUES ('e1', ?, 'tool_call', 's-1', 't1', 'ok',"
        " '{\"tool_name\": \"browser_exec\"}')",
        (time.time(),),
    )
    con.commit()
    con.close()

    monkeypatch.setenv("OMNISCIENCE_STATE_DB", str(state))
    runs = list_runs(str(tmp_path / "events.db"), days=3650)
    assert [r["chat_title"] for r in runs] == ["Fix the parser"]

    con = sqlite3.connect(state)
    con.execute("UPDATE sessions SET title = 'Parser, again' WHERE id = 's-1'")
    con.commit()
    con.close()

    assert chat_titles(str(state), {"s-1"}) == {"s-1": "Parser, again"}
    assert list_runs(str(tmp_path / "events.db"), days=3650)[0]["chat_title"] == "Parser, again"


def test_chat_name_falls_back_to_display_name_then_absent(tmp_path, monkeypatch):
    import sqlite3

    from omniscience_viewer.privacy import chat_titles

    state = tmp_path / "state.db"
    con = sqlite3.connect(state)
    con.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT)")
    con.execute("INSERT INTO sessions VALUES ('s-1', NULL, 'Old session')")
    con.commit()
    con.close()

    assert chat_titles(str(state), {"s-1"}) == {"s-1": "Old session"}
    # An unknown session is absent, never a made-up name.
    assert chat_titles(str(state), {"s-9"}) == {}
    # A missing database is not an error: the page still renders, using short ids.
    assert chat_titles(str(tmp_path / "nope.db"), {"s-1"}) == {}
