import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "demo"))

import synth  # noqa: E402

EXPECTED_KINDS = {
    "session.start",
    "session.end",
    "turn.start",
    "turn.end",
    "llm.request",
    "llm.response",
    "llm.error",
    "tool.end",
    "subagent.start",
    "subagent.stop",
    "omni.dropped",
}


def test_build_events_is_deterministic():
    assert synth.build_events() == synth.build_events()


def test_showcase_contains_a_long_chat_with_one_context_drop():
    import json

    events = synth.build_showcase_events()
    root = 'local-' + 'decafbad' * 8
    calls = [e for e in events if e['session_id'] == root and e['kind'] == 'llm.response']
    prompts = [json.loads(e['attrs'])['usage']['input_tokens'] for e in calls]
    assert len(calls) == 60
    assert sum(a - b > 1000 and b < a * 0.75 for a, b in zip(prompts, prompts[1:])) == 1
    assert any(e['session_id'] == root and e['kind'] == 'tool.end' and e['status'] == 'error' for e in events)
    assert len({e['event_id'] for e in events}) == len(events)


def test_build_events_contains_every_kind():
    events = synth.build_events()
    kinds = {event["kind"] for event in events}
    assert EXPECTED_KINDS <= kinds
    assert len(set(event["event_id"] for event in events)) == len(events)


def test_build_events_shape_and_sequence():
    events = synth.build_events()

    for event in events:
        assert event["schema"] == "omni.v1"
        assert event["boot_id"] == synth.BOOT_ID
        assert isinstance(event["seq"], int)
        assert isinstance(event["ts"], float)
        assert isinstance(json.loads(event["attrs"]), dict)

    seqs = [event["seq"] for event in events]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)


def test_events_include_child_session_and_gap():
    events = synth.build_events()
    kinds = [event["kind"] for event in events]

    assert synth.CHILD in {event["session_id"] for event in events}
    child_events = [event for event in events if event["session_id"] == synth.CHILD]
    assert any(event["parent_session_id"] == synth.ROOT for event in child_events)

    gaps = [
        b["seq"] - a["seq"]
        for a, b in zip(events, events[1:])
        if kind_of(b) == "omni.dropped"
    ]
    assert gaps and gaps[0] > 1
    assert "omni.dropped" in kinds


def kind_of(event):
    return event["kind"]
