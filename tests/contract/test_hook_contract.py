"""Lock in the Hermes observer-hook contract that the plugin consumes.

The fixtures are realistic kwargs captured from the field lists in
docs/HERMES_INTEGRATION.md §3-4 and the cited Hermes fire sites.  Each fixture
carries the golden normalize() result, so an upstream Hermes payload change
fails here instead of silently degrading the stored event stream.
"""

from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
import os as _os_pkg  # noqa: E402
sys.path.insert(0, _os_pkg.environ["OMNI_TEST_PKG_DIR"])  # set by tests/conftest.py
sys.path.insert(0, str(REPO / "viewer"))

from omniscience.sanitize import normalize  # noqa: E402
from omniscience.store import EventStore  # noqa: E402
from omniscience_viewer import db as vdb  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "hermes"

ROOT = "local-" + "ab12" * 16
CHILD = "20261105_234903_b11152"
TURN = f"{ROOT}:{ROOT}:a870a1a2"
CTURN = f"{CHILD}:sa-0-2ad31b82:280dbf1a"
API = f"{TURN}:api:1"
CAP = f"{CTURN}:api:1"

HOOKS = (
    "on_session_start",
    "on_session_end",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "post_tool_call",
    "subagent_start",
    "subagent_stop",
)

DUAL_CASE_HOOKS = (
    "on_session_start",
    "on_session_end",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "post_tool_call",
)

# Deterministic replay order: a root turn with a tool, a delegated helper with
# its own turn/tool, then the two session ends.  Every entry is a fixture case.
REPLAY = (
    ("on_session_start", "root"),
    ("pre_llm_call", "root"),
    ("pre_api_request", "root"),
    ("post_api_request", "root"),
    ("post_tool_call", "root"),
    ("subagent_start", "root"),
    ("on_session_start", "subagent"),
    ("pre_llm_call", "subagent"),
    ("pre_api_request", "subagent"),
    ("post_api_request", "subagent"),
    ("post_tool_call", "subagent"),
    ("api_request_error", "root"),
    ("api_request_error", "subagent"),
    ("post_llm_call", "subagent"),
    ("on_session_end", "subagent"),
    ("subagent_stop", "root"),
    ("post_llm_call", "root"),
    ("on_session_end", "root"),
)


def load_fixture(hook: str) -> dict:
    return json.loads((FIXTURES / f"{hook}.json").read_text(encoding="utf-8"))


def _cases() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for hook in HOOKS:
        data = load_fixture(hook)
        out.extend((hook, name) for name in data["cases"])
    return out


CASES = _cases()


def _assert_equal(actual, expected, path: str = "value") -> None:
    """Exact match for metadata, approximate for derived float timings."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected dict, got {type(actual)!r}"
        assert set(actual) == set(expected), f"{path}: keys differ"
        for key in expected:
            _assert_equal(actual[key], expected[key], f"{path}.{key}")
        return
    if isinstance(expected, list):
        assert isinstance(actual, list), f"{path}: expected list"
        assert len(actual) == len(expected), f"{path}: length differs"
        for i, (a, e) in enumerate(zip(actual, expected)):
            _assert_equal(a, e, f"{path}[{i}]")
        return
    if isinstance(expected, float):
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), path
        assert actual == pytest.approx(expected), f"{path}: {actual!r} != {expected!r}"
        return
    assert actual == expected, f"{path}: {actual!r} != {expected!r}"


@pytest.mark.parametrize("hook", HOOKS)
def test_fixture_is_complete_and_has_both_session_shapes(hook):
    data = load_fixture(hook)
    assert data["hook"] == hook
    assert data["sources"], "fixture must cite the Hermes fire site"
    assert data["hermes_version"]
    assert data["cases"], "fixture must carry at least one kwargs case"

    if hook in DUAL_CASE_HOOKS:
        assert set(data["cases"]) == {"root", "subagent"}, (
            f"{hook} fixture must cover a root session and a helper-agent session"
        )
        assert data["cases"]["root"]["kwargs"]["session_id"] == ROOT
        assert data["cases"]["subagent"]["kwargs"]["session_id"] == CHILD
    else:
        assert "root" in data["cases"]


@pytest.mark.parametrize("hook,case", CASES)
def test_normalize_matches_golden(hook, case):
    case_data = load_fixture(hook)["cases"][case]
    expected = case_data["expected"]
    result = normalize(hook, case_data["kwargs"])

    assert result is not None, f"{hook}/{case} produced no event"
    kind, ids, status, attrs, _natural_key = result

    assert kind == expected["kind"]
    _assert_equal(ids, expected["ids"], f"{hook}/{case}.ids")
    assert status == expected["status"]

    ignored = set(expected.get("attrs_ignore", ()))
    assert set(attrs) == set(expected["attrs"]) | ignored, (
        f"{hook}/{case}: unexpected attrs {sorted(set(attrs) - set(expected['attrs']) - ignored)}"
    )
    _assert_equal(
        {key: attrs[key] for key in expected["attrs"]},
        expected["attrs"],
        f"{hook}/{case}.attrs",
    )
    for key in ignored:
        assert isinstance(attrs[key], float), f"{hook}/{case}: {key} must stay numeric"


def _reconstruct_tree(events):
    """Small, deterministic mirror of web/src/graph/reduce.ts for contract assertions."""
    sessions: set[str] = set()
    turns: dict[str, str | None] = {}
    llms: dict[str, dict] = {}
    tools: list[dict] = []
    child_links: list[dict] = []

    for event in events:
        attrs = event.get("attrs") or {}
        session_id = event.get("session_id")
        kind = event.get("kind")
        if session_id:
            sessions.add(session_id)

        if kind in ("turn.start", "turn.end"):
            if event.get("turn_id"):
                turns.setdefault(event["turn_id"], session_id)
        elif kind in ("llm.request", "llm.response", "llm.error"):
            if event.get("api_request_id"):
                llms.setdefault(
                    event["api_request_id"],
                    {"turn_id": event.get("turn_id"), "session_id": session_id},
                )
        elif kind == "tool.end":
            tools.append(
                {
                    "node": f"tool:{event['event_id']}",
                    "api_request_id": event.get("api_request_id"),
                    "turn_id": event.get("turn_id"),
                    "session_id": session_id,
                }
            )
        elif kind == "subagent.start":
            child = attrs.get("child_session_id")
            if child:
                sessions.add(child)
                child_links.append(
                    {
                        "child": child,
                        "parent_session_id": session_id,
                        "parent_turn_id": attrs.get("parent_turn_id") or event.get("turn_id"),
                    }
                )

    nodes = {f"session:{sid}" for sid in sessions}
    nodes.update(f"turn:{tid}" for tid in turns)
    nodes.update(f"llm:{aid}" for aid in llms)
    nodes.update(tool["node"] for tool in tools)

    edges: list[tuple[str, str, str]] = []
    for turn_id, session_id in turns.items():
        if session_id:
            edges.append((f"session:{session_id}", f"turn:{turn_id}", "session-turn"))
    for api_id, info in llms.items():
        turn_id = info["turn_id"]
        if turn_id and f"turn:{turn_id}" in nodes:
            edges.append((f"turn:{turn_id}", f"llm:{api_id}", "turn-llm"))
        elif info["session_id"]:
            edges.append((f"session:{info['session_id']}", f"llm:{api_id}", "session-turn"))
    for tool in tools:
        api_id = tool["api_request_id"]
        if api_id and f"llm:{api_id}" in nodes:
            edges.append((f"llm:{api_id}", tool["node"], "llm-tool"))
        elif tool["turn_id"] and f"turn:{tool['turn_id']}" in nodes:
            edges.append((f"turn:{tool['turn_id']}", tool["node"], "llm-tool"))
        elif tool["session_id"]:
            edges.append((f"session:{tool['session_id']}", tool["node"], "llm-tool"))
    for link in child_links:
        parent_turn = link["parent_turn_id"]
        if parent_turn and f"turn:{parent_turn}" in nodes:
            edges.append((f"turn:{parent_turn}", f"session:{link['child']}", "turn-child"))
        elif link["parent_session_id"]:
            edges.append(
                (f"session:{link['parent_session_id']}", f"session:{link['child']}", "turn-child")
            )

    return nodes, edges


def _reachable(nodes, edges, start: str, target: str) -> bool:
    adjacency: dict[str, list[str]] = {}
    for source, dest, _kind in edges:
        adjacency.setdefault(source, []).append(dest)
    seen = {start}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        if node == target:
            return True
        for nxt in adjacency.get(node, ()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return False


def test_full_fixture_replay_builds_the_expected_tree(tmp_path):
    db_path = str(tmp_path / "events.db")
    store = EventStore(db_path)
    try:
        for hook, case in REPLAY:
            store.submit(hook, load_fixture(hook)["cases"][case]["kwargs"])
        assert store.flush(10), "writer did not drain the fixture replay"
    finally:
        store.close()

    events = vdb.events_for_root(db_path, ROOT)
    assert len(events) == len(REPLAY)
    assert {event["session_id"] for event in events} == {ROOT, CHILD}

    roots = vdb.list_sessions(db_path)
    assert [session["id"] for session in roots] == [ROOT]

    nodes, edges = _reconstruct_tree(events)

    root_node = f"session:{ROOT}"
    child_node = f"session:{CHILD}"
    assert root_node in nodes
    assert child_node in nodes

    subagent_start = next(event for event in events if event["kind"] == "subagent.start")
    assert subagent_start["attrs"]["child_session_id"] == CHILD
    assert subagent_start["turn_id"] == TURN
    assert (f"turn:{TURN}", child_node, "turn-child") in edges

    root_tools = [tool for tool in _tools(events) if tool["session_id"] == ROOT]
    child_tools = [tool for tool in _tools(events) if tool["session_id"] == CHILD]
    assert len(root_tools) == 1 and len(child_tools) == 1

    assert _reachable(nodes, edges, f"turn:{TURN}", root_tools[0]["node"])
    assert _reachable(nodes, edges, f"turn:{CTURN}", child_tools[0]["node"])
    assert not _reachable(nodes, edges, f"turn:{CTURN}", root_tools[0]["node"])

    root_tool_events = [
        event for event in events
        if event["kind"] == "tool.end" and event["session_id"] == ROOT
    ]
    child_tool_events = [
        event for event in events
        if event["kind"] == "tool.end" and event["session_id"] == CHILD
    ]
    assert root_tool_events[0]["turn_id"] == TURN
    assert root_tool_events[0]["api_request_id"] == API
    assert child_tool_events[0]["turn_id"] == CTURN
    assert child_tool_events[0]["api_request_id"] == CAP

    # The tool hangs off the LLM call that belongs to the correct turn, not the other one.
    assert (f"turn:{TURN}", f"llm:{API}", "turn-llm") in edges
    assert (f"llm:{API}", f"tool:{root_tool_events[0]['event_id']}", "llm-tool") in edges
    assert (f"turn:{CTURN}", f"llm:{CAP}", "turn-llm") in edges
    assert (f"llm:{CAP}", f"tool:{child_tool_events[0]['event_id']}", "llm-tool") in edges


def _tools(events):
    return [
        {"node": f"tool:{event['event_id']}", "session_id": event["session_id"]}
        for event in events
        if event["kind"] == "tool.end"
    ]
