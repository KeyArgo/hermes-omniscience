"""Failures explained from structured rows only — no message text, no invented causes.

A stopped message is the thing an operator actually opens this viewer to understand, so each
answer has to name the step, the evidence behind it, and a next action it can support. These
cases pin the wording to the rows: if a field is absent, the answer must not claim the cause.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import failure  # noqa: E402


def ev(rowid, kind, status=None, ts=1_800_000_000.0, **attrs):
    return {
        "rowid": rowid,
        "event_id": f"e{rowid}",
        "ts": ts + rowid,
        "kind": kind,
        "session_id": "s1",
        "status": status,
        "attrs": attrs,
    }


def response(rowid, prompt=5000, model="m-1", provider="nous", duration=2.0):
    return ev(rowid, "llm.response", usage={"prompt_tokens": prompt}, response_model=model,
              provider=provider, duration_s=duration)


def test_a_rate_limit_is_named_as_the_provider_throttling():
    events = [
        response(1),
        ev(2, "llm.error", "error", reason="rate_limit", status_code=429, error_type="RateLimitError"),
        ev(3, "llm.error", "error", reason="rate_limit", status_code=429, error_type="RateLimitError"),
        ev(4, "llm.error", "error", reason="rate_limit", status_code=429, error_type="RateLimitError"),
    ]
    out = failure.explain_failures(events)
    assert len(out) == 3
    first = out[0]
    assert "rate limit" in first["headline"].lower()
    assert first["status_code"] == 429
    assert "m-1" in " ".join(first["why"])
    assert any("provider" in line.lower() or "model" in line.lower() for line in first["actions"])


def test_a_storm_of_rate_limits_is_counted_not_guessed():
    events = [
        response(1),
        ev(2, "llm.error", "error", reason="rate_limit", status_code=429),
        ev(3, "llm.error", "error", reason="rate_limit", status_code=429),
    ]
    out = failure.explain_failures(events)
    second = out[1]
    assert "1 rate limit" in " ".join(second["why"])


def test_a_timeout_reports_the_context_it_was_carrying():
    events = [response(1, prompt=229_353), ev(2, "llm.error", "error", reason="timeout", duration_s=120)]
    out = failure.explain_failures(events)
    why = " ".join(out[0]["why"])
    assert "timed out" in out[0]["headline"].lower()
    assert "229k tokens" in why
    assert any("compact" in line.lower() for line in out[0]["actions"])


def test_a_tool_failure_is_compared_with_that_tool_s_own_median():
    events = [
        ev(1, "tool.end", "ok", tool_name="terminal", duration_ms=1000),
        ev(2, "tool.end", "ok", tool_name="terminal", duration_ms=1200),
        ev(3, "tool.end", "error", tool_name="terminal", duration_ms=30_000, error_type="tool_error"),
    ]
    out = failure.explain_failures(events)
    why = " ".join(out[0]["why"])
    assert "30.0 s" in why
    assert "median of 1.1 s" in why
    assert "far slower" in why


def test_a_refused_write_says_the_file_may_have_changed():
    events = [response(1), ev(2, "tool.end", "error", tool_name="write_file", duration_ms=15)]
    out = failure.explain_failures(events)
    text = " ".join(out[0]["why"] + out[0]["actions"]).lower()
    assert "changed on disk" in text or "stale" in text


def test_a_memory_failure_points_at_the_character_budget():
    events = [ev(1, "tool.end", "error", tool_name="memory", duration_ms=5)]
    out = failure.explain_failures(events)
    text = " ".join(out[0]["why"] + out[0]["actions"]).lower()
    assert "budget" in text
    assert "skill" in text


def test_a_cancelled_tool_is_not_reported_as_a_failure():
    events = [ev(1, "tool.end", "cancelled", tool_name="terminal", duration_ms=5)]
    assert failure.explain_failures(events) == []


def test_no_rows_means_saying_so_rather_than_guessing():
    events = [ev(1, "tool.end", "error", tool_name="weird-tool", duration_ms=5)]
    out = failure.explain_failures(events)
    assert out[0]["why"]
    assert "arguments" in " ".join(out[0]["actions"]).lower()


def test_a_helper_that_failed_is_named_as_one():
    events = [ev(1, "subagent.stop", child_status="failed")]
    out = failure.explain_failures(events)
    assert "helper" in out[0]["headline"].lower()
    assert any("helpers" in line.lower() for line in out[0]["actions"])


def test_an_unanswered_model_request_is_what_stopped_the_run():
    """The verdict says the message stopped mid-flight; a request with no response is the shape of
    that, and it is not a failure row, so listing failures never explained it."""
    events = [response(1), ev(2, "llm.request", model="m-1", provider="nous"),]
    stop = failure.explain_stop(events, now=1_800_000_010.0)
    assert stop["stopped"] is True
    assert stop["reason"] == "model_call_unanswered"
    assert "never came back" in stop["headline"]
    assert "m-1" in " ".join(stop["why"])
    assert any("resend" in line.lower() for line in stop["actions"])


def test_a_finished_turn_is_not_reported_as_stopped():
    stop = failure.explain_stop([ev(1, "turn.end")])
    assert stop["stopped"] is False


def test_a_failed_last_step_says_so_instead_of_calling_it_idle():
    stop = failure.explain_stop([ev(1, "tool.end", "error", tool_name="terminal")])
    assert stop["reason"] == "last_tool_failed"
    assert "terminal" in stop["headline"]


def test_a_reply_that_asked_for_a_tool_and_got_none_is_the_shape_of_a_stop():
    events = [
        response(1),
        ev(2, "llm.response", "ok", response_model="m-1", tool_call_count=1, finish_reason="tool_calls"),
    ]
    stop = failure.explain_stop(events, now=1_800_000_020.0)
    assert stop["reason"] == "tool_request_unanswered"
    assert "asked for a tool" in stop["headline"]
    assert "no tool step was recorded" in " ".join(stop["why"])


def test_a_final_answer_with_no_tool_calls_is_not_a_crash():
    events = [ev(2, "llm.response", "ok", response_model="m-1", tool_call_count=0, finish_reason="stop")]
    stop = failure.explain_stop(events, now=1_800_000_020.0)
    assert stop["reason"] == "answer_then_idle"
    assert "nothing was left pending" in stop["headline"]


def test_the_stop_names_the_nearest_failure_before_it():
    events = [
        ev(1, "tool.end", "error", tool_name="memory", error_type="tool_error"),
        ev(2, "llm.response", "ok", response_model="m-1", tool_call_count=1, finish_reason="tool_calls"),
    ]
    stop = failure.explain_stop(events, now=1_800_000_600.0)
    joined = " ".join(stop["why"])
    assert "nearest failure" in joined
    assert "memory" in joined
