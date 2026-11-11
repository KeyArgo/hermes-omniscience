"""Plugin writes → viewer reads: the slice's storage contract, end to end (no Hermes needed)."""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
import os as _os_pkg  # noqa: E402
sys.path.insert(0, _os_pkg.environ["OMNI_TEST_PKG_DIR"])  # set by tests/conftest.py
sys.path.insert(0, str(REPO / "viewer"))

from omniscience.store import EventStore  # noqa: E402
from omniscience_viewer import db as vdb  # noqa: E402

ROOT = "local-" + "ab12" * 16
TURN = f"{ROOT}:{ROOT}:a870a1a2"
CHILD = "20261105_234903_b11152"
CTURN = f"{CHILD}:sa-0:280dbf1a"


def test_plugin_db_is_readable_by_viewer_with_subagent_tree(tmp_path):
    db = str(tmp_path / "events.db")
    st = EventStore(db)
    calls = [
        ("on_session_start", dict(session_id=ROOT, platform="cli", model="m")),
        ("pre_llm_call", dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, model="m", user_message="hi")),
        ("pre_api_request", dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, api_request_id=f"{TURN}:api:1",
                                 model="m", provider="custom", retry_count=0)),
        ("post_api_request", dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, api_request_id=f"{TURN}:api:1",
                                  api_duration=1.0, usage={"total_tokens": 10})),
        ("post_tool_call", dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, api_request_id=f"{TURN}:api:1",
                                tool_call_id="call_1", tool_name="terminal", duration_ms=5, status="ok")),
        ("subagent_start", dict(parent_session_id=ROOT, parent_turn_id=TURN, child_session_id=CHILD,
                                child_subagent_id="sa-0", child_goal="g")),
        ("on_session_start", dict(session_id=CHILD, platform="subagent", model="m")),
        ("pre_llm_call", dict(session_id=CHILD, task_id="sa-0", turn_id=CTURN, parent_session_id=ROOT)),
        ("post_tool_call", dict(session_id=CHILD, task_id="sa-0", turn_id=CTURN, tool_call_id="call_2",
                                tool_name="terminal", duration_ms=3, status="ok")),
        ("subagent_stop", dict(parent_session_id=ROOT, child_session_id=CHILD, child_status="completed")),
    ]
    for hook, kw in calls:
        st.submit(hook, kw)
    assert st.flush(10)
    st.close()

    roots = vdb.list_sessions(db)
    assert [r["id"] for r in roots] == [ROOT]
    evs = vdb.events_for_root(db, ROOT)
    assert len(evs) == len(calls)
    assert {e["session_id"] for e in evs} == {ROOT, CHILD}
    start = next(e for e in evs if e["kind"] == "subagent.start")
    assert start["attrs"]["child_session_id"] == CHILD and start["turn_id"] == TURN
    assert vdb.health(db)["schema"] == "omni.v1"
