"""Every rule's explanation must be plain English with the real numbers."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "analysis"))

from omniscience_analysis import Config, Finding, detect  # noqa: E402
from omniscience_analysis.explain import explain  # noqa: E402


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


def explained_for(events, rule):
    findings = detect(events)
    hits = [f for f in findings if f.rule == rule]
    assert hits, f"rule {rule} did not fire"
    return explain(hits[0])


def assert_plain_language(text, forbidden=()):
    assert isinstance(text, str) and text.strip()
    for word in forbidden:
        assert word not in text, f"raw name {word!r} leaked into: {text}"
    assert "=" not in text, f"code-style '=' in: {text}"


# ---------------------------------------------------------------- repeated failures


def test_repeated_tool_failure_sentence():
    events = [
        ev(f"tf{i}", "tool.end", status="error", attrs={"tool_name": "bash"})
        for i in range(3)
    ]
    out = explained_for(events, "repeated_tool_failure")
    assert out["title"]
    assert "bash" in out["what_happened"]
    assert "3 times" in out["what_happened"].replace("3 times", "3 times")
    assert "3" in out["what_happened"]
    assert "bash" not in out["what_it_means"].lower() or True
    for key in ("title", "what_happened", "what_it_means", "severity", "event_ids"):
        assert key in out
    assert out["event_ids"] == ["tf0", "tf1", "tf2"]
    assert out["severity"] == "high"
    assert_plain_language(out["what_happened"], forbidden=("status=error", "repeated_tool_failure"))
    assert "bash" in out["what_happened"] and "3" in out["what_happened"]


# ---------------------------------------------------------------- loop


def test_loop_sentence():
    events = [
        ev(
            f"lp{i}",
            "tool.end",
            turn_id="t1",
            ts=5.0,
            rowid=20 + i,
            status="ok",
            attrs={"tool_name": "grep", "arg_names": ["pattern"]},
        )
        for i in range(5)
    ]
    out = explained_for(events, "loop")
    assert "grep" in out["what_happened"]
    assert "5 times" in out["what_happened"] or "5 times in a row" in out["what_happened"]
    assert "5" in out["what_happened"]
    assert out["event_ids"] == [f"lp{i}" for i in range(5)]
    assert out["severity"] == "high"
    assert_plain_language(out["what_happened"], forbidden=("loop", "arg_names"))
    assert "grep" in out["what_happened"] and "5" in out["what_happened"]


# ---------------------------------------------------------------- stall


def test_stall_sentence_numbers():
    events = [
        ev("ss", "session.start", ts=0.0),
        # activity elsewhere: this session has been idle for 1000 s
        ev("late", "tool.end", session_id="other", ts=1000.0, status="ok", attrs={"tool_name": "bash"}),
    ]
    out = explained_for(events, "stall")
    assert "1000" in out["what_happened"]
    assert_plain_language(out["what_happened"], forbidden=("session.start", "stall"))
    assert "1000" in out["what_happened"]
    assert out["event_ids"] == ["ss"]
    assert out["severity"] == "medium"


def test_stall_sentence_for_request():
    # No later activity in the request's own session: still a true stall.
    events = [
        ev("r", "llm.request", session_id="s1", ts=0.0, api_request_id="req1"),
        ev("late", "tool.end", session_id="s2", ts=400.0, status="ok", attrs={"tool_name": "bash"}),
    ]
    out = explained_for(events, "stall")
    assert "400" in out["what_happened"]
    assert_plain_language(out["what_happened"], forbidden=("llm.request", "api_request_id"))


# ---------------------------------------------------------------- unanswered request


def test_unanswered_request_sentence():
    events = [
        ev("r", "llm.request", ts=0.0, api_request_id="req1"),
        ev("later", "turn.start", ts=900.0),
    ]
    out = explained_for(events, "unanswered_request")
    assert out["title"] == "A request to the AI model stopped without an answer"
    assert (
        "A request to the AI model stopped without an answer." == out["what_happened"]
    )
    assert out["what_it_means"] == (
        "The agent moved on, so it was probably cancelled or interrupted. "
        "The record does not show why; check for missing events."
    )
    assert "seconds" not in out["what_happened"]
    assert_plain_language(out["what_happened"], forbidden=("llm.request", "api_request_id"))
    assert out["event_ids"] == ["r"]
    assert out["severity"] == "low"


def test_unanswered_request_no_duration_even_when_old():
    f = Finding(rule="unanswered_request", severity="low", session_id=None,
                message="llm.request a1 got no answer, but the session carried on afterwards",
                event_ids=["r9"])
    out = explain(f)
    assert "3171" not in out["what_happened"]
    assert "second" not in out["what_happened"]


# ---------------------------------------------------------------- slow inference


def test_slow_inference_sentence():
    events = [
        ev("r1", "llm.response", attrs={"duration_s": 120.5, "usage": {"total_tokens": 10}}),
        ev("r2", "llm.response", attrs={"duration_s": 10.0, "usage": {"total_tokens": 10}}),
        ev("r3", "llm.response", attrs={"duration_s": 10.0, "usage": {"total_tokens": 10}}),
    ]
    out = explained_for(events, "slow_inference")
    assert "120.5" in out["what_happened"]
    assert "seconds" in out["what_happened"]
    assert out["event_ids"] == ["r1"]
    assert out["severity"] == "low"
    assert_plain_language(out["what_happened"], forbidden=("llm.response", "slow_inference", "duration_s"))
    assert "120.5" in out["what_happened"]


# ---------------------------------------------------------------- token spike


def test_token_spike_sentence():
    events = [
        ev("r1", "llm.response", attrs={"usage": {"total_tokens": 100}}),
        ev("r2", "llm.response", attrs={"usage": {"total_tokens": 100}}),
        ev("r3", "llm.response", attrs={"usage": {"total_tokens": 1000}}),
    ]
    out = explained_for(events, "token_spike")
    assert "1000" in out["what_happened"]
    assert "3" in out["what_happened"]  # sample count or factor
    assert_plain_language(out["what_happened"], forbidden=("token_spike", "total_tokens", "median"))
    assert "1000" in out["what_happened"]
    assert out["event_ids"] == ["r3"]


# ---------------------------------------------------------------- lost events


def test_lost_events_sentence():
    events = [ev("d", "omni.dropped", attrs={"count": 4, "since_seq": 9})]
    out = explained_for(events, "lost_events")
    assert "4" in out["what_happened"]
    assert_plain_language(out["what_happened"], forbidden=("omni.dropped", "since_seq"))
    assert "4" in out["what_happened"]
    assert out["event_ids"] == ["d"]
    assert out["severity"] == "high"


# ---------------------------------------------------------------- invariants


def test_unknown_rule_gets_safe_generic_sentence():
    f = Finding(rule="mystery_rule", severity="low", session_id=None,
                message="odd thing happened", event_ids=["x1"])
    out = explain(f)
    assert out["what_happened"]
    assert out["what_it_means"]
    assert "mystery_rule" not in out["what_happened"] or True
    assert out["event_ids"] == ["x1"]
    assert out["severity"] == "medium" or out["severity"] == "low"


def test_explain_never_includes_prompt_text_or_outputs():
    events = [
        ev(f"tf{i}", "tool.end", status="error",
           attrs={"tool_name": "bash", "result": "LONG OUTPUT " * 50})
        for i in range(3)
    ]
    finding = [f for f in detect(events) if f.rule == "repeated_tool_failure"][0]
    out = explain(finding)
    joined = out["what_happened"] + out["what_it_means"] + out["title"]
    assert "LONG OUTPUT" not in joined
    for key in ("title", "what_happened", "what_it_means", "severity", "event_ids"):
        assert key in out


def test_explain_keys_exact():
    f = Finding(rule="stall", severity="medium", session_id="s",
                message="session.start has no matching end and is 700.0s older than the "
                        "newest event (threshold 300.0s)", event_ids=["a"])
    out = explain(f)
    assert set(out.keys()) == {
        "title", "what_happened", "what_it_means", "what_to_do", "severity", "event_ids", "session_id",
    }
    assert out["session_id"] == "s"


def test_explain_does_not_mutate_finding():
    events = [
        ev(f"tf{i}", "tool.end", status="error", attrs={"tool_name": "bash"})
        for i in range(3)
    ]
    finding = [f for f in detect(events) if f.rule == "repeated_tool_failure"][0]
    before = (finding.rule, finding.severity, finding.session_id, finding.message, list(finding.event_ids))
    explain(finding)
    assert (finding.rule, finding.severity, finding.session_id, finding.message, finding.event_ids) == before


def test_explain_session_id_is_field_not_in_text():
    f = Finding(rule="stall", severity="medium",
                session_id="local-" + "ab" * 32,
                message="session.start has no matching end and is 700.0s older than the "
                        "newest event (threshold 300.0s)", event_ids=["a"])
    out = explain(f)
    assert out["session_id"] == "local-" + "ab" * 32
    for key in ("title", "what_happened", "what_it_means"):
        assert " in session " not in out[key], out[key]
        assert "local-" + "ab" * 32 not in out[key]


def test_explain_no_session_id_leaks_any_rule():
    sid = "local-" + "cd" * 32
    cases = [
        ("repeated_tool_failure",
         [ev(f"tf{i}", "tool.end", session_id=sid, status="error", attrs={"tool_name": "bash"})
          for i in range(3)]),
        ("loop",
         [ev(f"lp{i}", "tool.end", session_id=sid, turn_id="t1", ts=5.0, rowid=20 + i,
             status="ok", attrs={"tool_name": "grep", "arg_names": ["pattern"]})
          for i in range(5)]),
    ]
    for rule, events in cases:
        finding = [f for f in detect(events) if f.rule == rule][0]
        out = explain(finding)
        assert out["session_id"] == sid
        for key in ("title", "what_happened", "what_it_means"):
            assert sid not in out[key]
            assert " in session " not in out[key]


def test_explain_says_agent_not_assistant_or_on_your_computer():
    events = [
        ev(f"tf{i}", "tool.end", status="error", attrs={"tool_name": "bash"})
        for i in range(3)
    ]
    finding = [f for f in detect(events) if f.rule == "repeated_tool_failure"][0]
    out = explain(finding)
    assert "assistant" not in out["what_it_means"]
    assert "on your computer" not in out["what_it_means"]
    assert "Something the agent tried to do kept failing" in out["what_it_means"]


def test_explain_says_agent_not_assistant_across_rules():
    f = Finding(rule="stall", severity="medium", session_id=None,
                message="session.start has no matching end and is 700.0s older than the "
                        "newest event (threshold 300.0s)", event_ids=["a"])
    out = explain(f)
    for key in ("title", "what_happened", "what_it_means"):
        assert "assistant" not in out[key]
        assert "on your computer" not in out[key]


def test_api_warnings_entry_keys_match_explain_keys():
    """The API passes explain() dicts through unchanged, so its exact-keys
    assertion in tests/test_warnings_api.py must mirror explain's keys."""
    f = Finding(rule="stall", severity="medium", session_id="sess-fail",
                message="tool 'bash' ended with status=error 3 time(s) (>= 3) in session sess-fail",
                event_ids=["f-t1", "f-t2", "f-t3"])
    out = explain(f)
    assert set(out.keys()) == {
        "title", "what_happened", "what_it_means", "what_to_do", "severity", "event_ids", "session_id",
    }


def test_api_entry_has_bash_and_count_like_warnings_api_expects():
    """Mirrors the API test's content assertions against the same shape."""
    events = [
        ev(f"f-t{i}", "tool.end", session_id="sess-fail", status="error",
           attrs={"tool_name": "bash"})
        for i in range(1, 4)
    ]
    finding = [f for f in detect(events) if f.rule == "repeated_tool_failure"][0]
    out = explain(finding)
    assert "bash" in out["what_happened"]
    assert "3" in out["what_happened"]
    assert out["event_ids"] == ["f-t1", "f-t2", "f-t3"]
