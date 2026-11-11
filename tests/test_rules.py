"""Deterministic rule tests for omniscience_analysis.rules (phase 3)."""

import json
import os
import random
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "analysis"))

from omniscience_analysis import Config, Finding, detect  # noqa: E402
from omniscience_analysis.__main__ import main as cli_main  # noqa: E402

RULES = {
    "repeated_tool_failure",
    "loop",
    "stall",
    "unanswered_request",
    "slow_inference",
    "token_spike",
    "lost_events",
}


def ev(event_id, kind, session_id="s1", ts=0.0, **kw):
    e = {
        "rowid": kw.pop("rowid", None),
        "event_id": event_id,
        "schema": "omni.v1",
        "boot_id": kw.pop("boot_id", "b1"),
        "seq": kw.pop("seq", None),
        "ts": ts,
        "kind": kind,
        "session_id": session_id,
        "attrs": kw.pop("attrs", {}),
    }
    e.update(kw)
    return e


def rules_hit(findings):
    return {f.rule for f in findings}


# --------------------------------------------------------------------------
# repeated_tool_failure
# --------------------------------------------------------------------------


def test_repeated_tool_failure_positive():
    events = [
        ev(f"tf{i}", "tool.end", status="error", attrs={"tool_name": "bash"})
        for i in range(3)
    ]
    findings = detect(events)
    assert rules_hit(findings) == {"repeated_tool_failure"}
    f = findings[0]
    assert f.session_id == "s1"
    assert sorted(f.event_ids) == ["tf0", "tf1", "tf2"]
    assert f.severity

def test_repeated_tool_failure_negative_two_errors():
    events = [
        ev("tf0", "tool.end", status="error", attrs={"tool_name": "bash"}),
        ev("tf1", "tool.end", status="error", attrs={"tool_name": "bash"}),
        ev("tf2", "tool.end", status="ok", attrs={"tool_name": "bash"}),
    ]
    assert detect(events) == []


def test_repeated_tool_failure_missing_tool_name_skipped():
    events = [
        ev(f"tf{i}", "tool.end", status="error", attrs={}) for i in range(4)
    ]
    assert detect(events) == []


# --------------------------------------------------------------------------
# loop
# --------------------------------------------------------------------------


def _loop_events(n, turn="t1", tool="grep", args=("pattern",), start=0):
    return [
        ev(
            f"lp{i}",
            "tool.end",
            turn_id=turn,
            ts=5.0,
            rowid=20 + i,
            status="ok",
            attrs={"tool_name": tool, "arg_names": list(args)},
        )
        for i in range(start, start + n)
    ]


def test_loop_positive_five_consecutive():
    findings = detect(_loop_events(5))
    assert rules_hit(findings) == {"loop"}
    assert sorted(findings[0].event_ids) == sorted(f"lp{i}" for i in range(5))


def test_loop_negative_four_consecutive():
    assert detect(_loop_events(4)) == []


def test_loop_negative_split_across_turns():
    events = _loop_events(3, turn="t1") + _loop_events(3, turn="t2", start=3)
    assert detect(events) == []


def test_loop_negative_different_arg_names():
    events = _loop_events(3) + _loop_events(3, args=("pattern", "path"), start=3)
    assert detect(events) == []


def test_loop_missing_turn_id_skipped():
    events = _loop_events(6)
    for e in events:
        e["turn_id"] = None
    assert detect(events) == []


# --------------------------------------------------------------------------
# stall
# --------------------------------------------------------------------------


def test_stall_positive_session_start():
    events = [
        ev("ss", "session.start", ts=0.0),
        # activity elsewhere: this session has been idle for 1000 s
        ev("late", "tool.end", session_id="other", ts=1000.0, status="ok", attrs={"tool_name": "bash"}),
    ]
    findings = detect(events)
    assert rules_hit(findings) == {"stall"}
    assert findings[0].event_ids == ["ss"]


def test_stall_positive_llm_request():
    # No later activity in the request's own session: a true stall.
    events = [
        ev("r", "llm.request", session_id="s1", ts=0.0, api_request_id="req1"),
        ev("late", "tool.end", session_id="s2", ts=400.0, status="ok", attrs={"tool_name": "bash"}),
    ]
    findings = detect(events)
    assert rules_hit(findings) == {"stall"}
    assert findings[0].event_ids == ["r"]


def test_unanswered_request_positive_request_then_other_activity():
    # The request never got llm.response/llm.error, but the session carried on.
    events = [
        ev("r", "llm.request", ts=0.0, api_request_id="req1"),
        ev("later", "turn.start", ts=350.0),
        ev("late", "tool.end", ts=400.0, status="ok", attrs={"tool_name": "bash"}),
    ]
    findings = detect(events)
    assert rules_hit(findings) == {"unanswered_request"}
    f = findings[0]
    assert f.severity == "low"
    assert f.event_ids == ["r"]
    assert "3171" not in f.message and "s older" not in f.message


def test_unanswered_request_any_later_kind_counts():
    events = [
        ev("r1", "llm.request", ts=0.0, api_request_id="req1"),
        ev("r2", "llm.request", ts=1.0, api_request_id="req2"),
        ev("other", "turn.start", ts=400.0),
    ]
    findings = detect(events)
    assert {f.rule for f in findings} == {"unanswered_request"}
    assert sorted(f.event_ids[0] for f in findings) == ["r1", "r2"]


def test_unanswered_request_later_activity_in_other_session_does_not_count():
    events = [
        ev("r", "llm.request", session_id="s1", ts=0.0, api_request_id="req1"),
        ev("other", "turn.start", session_id="s2", ts=400.0),
    ]
    findings = detect(events)
    assert {f.rule for f in findings} == {"stall"}


def test_unanswered_request_not_old_enough_stays_silent():
    events = [
        ev("r", "llm.request", ts=700.0, api_request_id="req1"),
        ev("later", "turn.start", ts=900.0),
    ]
    assert detect(events) == []


def test_unanswered_request_message_has_no_duration():
    events = [
        ev("r", "llm.request", ts=0.0, api_request_id="req1"),
        ev("later", "turn.start", ts=900.0),
    ]
    f = [x for x in detect(events) if x.rule == "unanswered_request"][0]
    assert f.message == (
        "llm.request req1 got no answer, but the session carried on afterwards"
    )


def test_unanswered_request_response_is_end_not_unanswered():
    events = [
        ev("r", "llm.request", ts=0.0, api_request_id="req1"),
        ev("resp", "llm.response", ts=1.0, api_request_id="req1"),
        ev("later", "turn.start", ts=900.0),
    ]
    assert detect(events) == []


def test_stall_negative_closed_sessions():
    events = [
        ev("ss", "session.start", ts=0.0),
        ev("se", "session.end", ts=1400.0),
        ev("r", "llm.request", ts=10.0, api_request_id="req1"),
        ev("resp", "llm.response", ts=20.0, api_request_id="req1", attrs={"usage": {"total_tokens": 5}}),
        ev("err", "llm.error", ts=25.0, api_request_id="req2"),
        ev("r2", "llm.request", ts=24.0, api_request_id="req2"),
    ]
    assert detect(events) == []


def test_stall_negative_within_window():
    events = [
        ev("ss", "session.start", ts=900.0),
        ev("late", "tool.end", ts=900.0 + 299.0, status="ok", attrs={"tool_name": "bash"}),
    ]
    assert detect(events) == []


def test_stall_missing_ts_skipped():
    e = ev("ss", "session.start")
    e["ts"] = None
    events = [e, ev("late", "tool.end", ts=1000.0, status="ok", attrs={"tool_name": "bash"})]
    assert detect(events) == []


def test_stall_never_uses_wall_clock():
    # Far-past timestamps: stall age is relative to the max ts in the input only.
    events = [ev("ss", "session.start", ts=1_000_000.0)]
    assert detect(events) == []


# --------------------------------------------------------------------------
# slow_inference
# --------------------------------------------------------------------------


def test_slow_inference_positive():
    events = [
        ev("r1", "llm.response", attrs={"duration_s": 61.0, "usage": {"total_tokens": 10}}),
        ev("r2", "llm.response", attrs={"duration_s": 61.0, "usage": {"total_tokens": 10}}),
        ev("r3", "llm.response", attrs={"duration_s": 61.0, "usage": {"total_tokens": 10}}),
    ]
    findings = [f for f in detect(events) if f.rule == "slow_inference"]
    assert len(findings) == 3
    assert all(f.event_ids for f in findings)


def test_slow_inference_negative_and_missing():
    events = [
        ev("r1", "llm.response", attrs={"duration_s": 59.0}),
        ev("r2", "llm.response", attrs={}),
        ev("r3", "llm.response", attrs={"duration_s": "slow"}),
    ]
    assert detect(events) == []


# --------------------------------------------------------------------------
# token_spike
# --------------------------------------------------------------------------


def _resp(eid, tokens):
    return ev(eid, "llm.response", attrs={"usage": {"total_tokens": tokens}})


def test_token_spike_positive():
    events = [_resp("r1", 100), _resp("r2", 100), _resp("r3", 1000)]
    findings = [f for f in detect(events) if f.rule == "token_spike"]
    assert len(findings) == 1
    assert findings[0].event_ids == ["r3"]
    assert findings[0].session_id == "s1"


def test_token_spike_negative_under_min_samples():
    events = [_resp("r1", 100), _resp("r2", 10_000)]
    assert detect(events) == []


def test_token_spike_negative_uniform():
    events = [_resp("r1", 100), _resp("r2", 100), _resp("r3", 100)]
    assert detect(events) == []


def test_missing_usage_does_not_trigger_token_spike():
    events = [
        ev("r1", "llm.response", attrs={"duration_s": 1.0}),
        ev("r2", "llm.response", attrs={"duration_s": 1.0}),
        ev("r3", "llm.response", attrs={"usage": {}}),
        ev("r4", "llm.response", attrs={"usage": {"total_tokens": 9_999_999}}),
    ]
    # Only one real sample -> below min_samples even at face value.
    assert detect(events) == []


def test_token_spike_median_is_per_session():
    events = [
        _resp("a1", 100), _resp("a2", 100), _resp("a3", 1000),
        _resp("b1", 100), _resp("b2", 100), _resp("b3", 101),
    ]
    for e in events[3:]:
        e["session_id"] = "s2"
    findings = [f for f in detect(events) if f.rule == "token_spike"]
    assert [f.event_ids for f in findings] == [["a3"]]


# --------------------------------------------------------------------------
# lost_events
# --------------------------------------------------------------------------


def test_lost_events_positive_dropped_marker():
    events = [ev("d", "omni.dropped", attrs={"count": 4, "since_seq": 9})]
    findings = detect(events)
    assert rules_hit(findings) == {"lost_events"}
    assert findings[0].event_ids == ["d"]
    assert "4" in findings[0].message


def test_seq_gap_alone_is_not_loss():
    # Regression: seq is gateway-wide; other sessions' events create gaps in one session's view.
    events = [
        ev("e1", "turn.start", session_id="s3", boot_id="b2", seq=1),
        ev("e2", "turn.end", session_id="s3", boot_id="b2", seq=2),
        ev("e3", "turn.start", session_id="s3", boot_id="b2", seq=5),
    ]
    assert [f for f in detect(events) if f.rule == "lost_events"] == []


def test_lost_events_negative_contiguous():
    events = [
        ev("e1", "turn.start", boot_id="b2", seq=1),
        ev("e2", "turn.end", boot_id="b2", seq=2),
        ev("e3", "turn.start", boot_id="b2", seq=3),
    ]
    assert detect(events) == []


# --------------------------------------------------------------------------
# invariants & determinism
# --------------------------------------------------------------------------


def _composite():
    events = []
    events += [
        ev(f"tf{i}", "tool.end", turn_id="t1", ts=float(i), rowid=100 + i,
           seq=1 + i, status="error", attrs={"tool_name": "bash"})
        for i in range(3)
    ]
    events += [
        ev(f"lp{i}", "tool.end", turn_id="t2", ts=5.0, rowid=200 + i,
           seq=4 + i, status="ok",
           attrs={"tool_name": "grep", "arg_names": ["pattern"]})
        for i in range(5)
    ]
    events += [
        ev("r1", "llm.response", ts=6.0, rowid=301, seq=9,
           attrs={"duration_s": 1.0, "usage": {"total_tokens": 100}}),
        ev("r2", "llm.response", ts=7.0, rowid=302, seq=10,
           attrs={"duration_s": 2.0, "usage": {"total_tokens": 100}}),
        ev("r3", "llm.response", ts=8.0, rowid=303, seq=11,
           attrs={"duration_s": 120.0, "usage": {"total_tokens": 1000}}),
    ]
    events += [
        ev("ur", "llm.request", ts=5.5, rowid=305, seq=12, api_request_id="ur1"),
        ev("ss2", "session.start", session_id="s2", ts=100.0, rowid=400, seq=13),
        ev("late", "tool.end", ts=1000.0, rowid=401, seq=14,
           status="ok", attrs={"tool_name": "read"}),
        ev("drop", "omni.dropped", ts=1000.0, rowid=402, seq=15, attrs={"count": 2}),
        ev("g1", "turn.start", session_id="s3", boot_id="b2", seq=1, ts=1000.0, rowid=403),
        ev("g2", "turn.start", session_id="s3", boot_id="b2", seq=5, ts=1000.0, rowid=404),
    ]
    return events


def test_composite_fires_every_rule_and_cites_events():
    findings = detect(_composite())
    assert rules_hit(findings) == RULES
    assert all(isinstance(f, Finding) for f in findings)
    assert all(f.rule for f in findings)
    assert all(f.severity for f in findings)
    assert all(f.message for f in findings)
    assert all(f.event_ids for f in findings), "every finding must cite >=1 event id"
    un = [f for f in findings if f.rule == "unanswered_request"]
    assert un and un[0].event_ids == ["ur"]


def test_determinism_same_input_twice():
    events = _composite()
    a = detect(events)
    b = detect(events)
    assert [(f.rule, f.severity, f.session_id, f.message, f.event_ids) for f in a] == [
        (f.rule, f.severity, f.session_id, f.message, f.event_ids) for f in b
    ]
    assert events == _composite()  # inputs untouched


def test_determinism_equal_ts_input_order_irrelevant():
    events = _composite()
    reference = detect(events)
    for seed in (1, 2, 3):
        shuffled = list(events)
        random.Random(seed).shuffle(shuffled)
        got = detect(shuffled)
        assert [(f.rule, f.session_id, f.message, f.event_ids) for f in got] == [
            (f.rule, f.session_id, f.message, f.event_ids) for f in reference
        ]
    assert [(f.rule, f.session_id, f.message, f.event_ids) for f in detect(events[::-1])] == [
        (f.rule, f.session_id, f.message, f.event_ids) for f in reference
    ]


def test_thresholds_configurable():
    events = _composite()
    strict = Config(spike_factor=50.0, slow_s=1000.0, loop_threshold=9,
                    repeated_tool_failure_threshold=9, stall_s=10_000.0)
    assert rules_hit(detect(events, strict)) == {"lost_events"}


def test_empty_input():
    assert detect([]) == []


# --------------------------------------------------------------------------
# CLI (read-only)
# --------------------------------------------------------------------------


def _write_db(path):
    con = sqlite3.connect(str(path))
    con.execute(
        "CREATE TABLE events (event_id TEXT UNIQUE, schema TEXT, boot_id TEXT, seq INTEGER,"
        " ts REAL, kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT,"
        " api_request_id TEXT, tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT)"
    )
    rows = [
        ("ss1", "b1", 1, 0.0, "session.start", "s1", None, None, None, None, None, None, {}),
        ("tf0", "b1", 2, 1.0, "tool.end", "s1", None, "t1", None, None, None, "error", {"tool_name": "bash"}),
        ("tf1", "b1", 3, 2.0, "tool.end", "s1", None, "t1", None, None, None, "error", {"tool_name": "bash"}),
        ("tf2", "b1", 4, 3.0, "tool.end", "s1", None, "t1", None, None, None, "error", {"tool_name": "bash"}),
        ("ss2", "b1", 5, 4.0, "session.start", "s2", "s1", None, None, None, None, None, {}),
        ("late", "b1", 6, 1000.0, "tool.end", "s2", "s1", "t1", None, None, None, "ok", {"tool_name": "read"}),
    ]
    con.executemany(
        "INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(e, "omni.v1", b, s, t, k, sid, p, tu, ar, tc, sa, st, json.dumps(a)) for e, b, s, t, k, sid, p, tu, ar, tc, sa, st, a in rows],
    )
    con.commit()
    con.close()


def test_cli_json_findings(tmp_path, capsys):
    db = tmp_path / "events.db"
    _write_db(db)
    assert cli_main(["--db", str(db)]) == 0
    out = json.loads(capsys.readouterr().out)
    hits = {f["rule"] for f in out}
    assert hits == {"repeated_tool_failure", "stall"}
    tf = next(f for f in out if f["rule"] == "repeated_tool_failure")
    assert tf["session_id"] == "s1"
    assert tf["event_ids"] == ["tf0", "tf1", "tf2"]
    assert all(f["event_ids"] for f in out)


def test_cli_root_filter(tmp_path, capsys):
    db = tmp_path / "events.db"
    _write_db(db)
    assert cli_main(["--db", str(db), "--root", "s2"]) == 0
    out = json.loads(capsys.readouterr().out)
    # s2 was still active at the newest event, so it is not reported as stuck
    assert out == []


def test_cli_missing_file(tmp_path, capsys):
    assert cli_main(["--db", str(tmp_path / "nope.db")]) == 2
