# tests/test_notices.py
"""Tests for omniscience.notices.Notices.

These tests do NOT depend on the real sanitize.normalize field mapping.
Instead they pass a tiny fake normalize that maps hook names directly to
(kind, ids, status, attrs, natural_key) tuples.
"""

from __future__ import annotations

import pytest

from omniscience.notices import Notices


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------
class FakeHandle:
    def __init__(self) -> None:
        self.ok = True
        self.edited: list[str] = []

    def edit(self, text: str) -> None:
        self.edited.append(text)


class FakeCtx:
    def __init__(self) -> None:
        self.posted: list[str] = []
        self.handles: list[FakeHandle] = []

    def post_message(self, text: str) -> FakeHandle:
        self.posted.append(text)
        h = FakeHandle()
        self.handles.append(h)
        return h


def _fake_normalize(hook_name: str, kwargs: dict):
    """Map hook names to (kind, ids, status, attrs, natural_key)."""
    sid = kwargs.get("session_id", "s1")
    tid = kwargs.get("turn_id", "t1")
    aid = kwargs.get("api_request_id")
    tcid = kwargs.get("tool_call_id")
    parent = kwargs.get("parent_session_id")

    ids = {
        "session_id": sid,
        "turn_id": tid,
        "api_request_id": aid,
        "tool_call_id": tcid,
        "parent_session_id": parent,
    }

    if hook_name == "pre_llm_call":
        return ("turn.start", ids, None, {}, f"turn.start:{sid}:{tid}")
    if hook_name == "post_llm_call":
        return ("turn.end", ids, None, {}, f"turn.end:{sid}:{tid}")
    if hook_name == "pre_api_request":
        attrs = {
            "model": kwargs.get("model"),
            "provider": kwargs.get("provider"),
        }
        return ("llm.request", ids, None, attrs, f"llm.request:{aid}")
    if hook_name == "post_api_request":
        attrs = {
            "duration_s": kwargs.get("api_duration"),
            "ttfb_s": kwargs.get("ttfb"),
            "response_model": kwargs.get("response_model"),
        }
        return ("llm.response", ids, "ok", attrs, f"llm.response:{aid}")
    if hook_name == "api_request_error":
        attrs = {
            "reason": kwargs.get("reason"),
            "status_code": kwargs.get("status_code"),
            "error_type": kwargs.get("error_type"),
            "retryable": kwargs.get("retryable", True),
            "duration_s": kwargs.get("api_duration"),
            "api_request_id": aid,
        }
        return ("llm.error", ids, "error", attrs, f"llm.error:{aid}")
    if hook_name == "post_tool_call":
        error = kwargs.get("error")
        status = "error" if error else "ok"
        attrs = {
            "tool_name": kwargs.get("tool_name"),
            "duration_ms": kwargs.get("duration_ms"),
        }
        return ("tool.end", ids, status, attrs, f"tool.end:{tcid}")

    return None


def _make_notices(**overrides):
    ctx = FakeCtx()
    kwargs = dict(
        ctx=ctx,
        link_for=lambda sid: f"https://viewer/{sid}",
        enabled=True,
        spawn=lambda fn: fn(),
        normalize=_fake_normalize,
    )
    kwargs.update(overrides)
    return ctx, Notices(**kwargs)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_rate_limit_post_then_edit():
    ctx, n = _make_notices()
    sid, tid, aid = "s1", "t1", "a1"

    # Turn start
    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})

    # Remember provider
    n.observe(
        "pre_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "provider": "zhipu",
        },
    )

    # First 429
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 429,
            "reason": "rate_limit",
            "error_type": "RateLimitError",
            "api_duration": 1.2,
        },
    )
    assert len(ctx.posted) == 1
    assert "zhipu" in ctx.posted[0]
    assert "429" in ctx.posted[0]
    assert "retrying" in ctx.posted[0]

    # Second 429 -> edit
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 429,
            "reason": "rate_limit",
            "error_type": "RateLimitError",
            "api_duration": 1.2,
        },
    )
    assert len(ctx.posted) == 1  # no new message
    assert len(ctx.handles[0].edited) == 1
    assert "2 times" in ctx.handles[0].edited[0]

    # Third 429 -> edit again
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 429,
            "reason": "rate_limit",
            "error_type": "RateLimitError",
            "api_duration": 1.2,
        },
    )
    assert len(ctx.handles[0].edited) == 2
    assert "3 times" in ctx.handles[0].edited[1]


def test_fallback_once():
    ctx, n = _make_notices()
    sid, tid, aid = "s1", "t1", "a1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})
    n.observe(
        "pre_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "provider": "zhipu",
        },
    )
    n.observe(
        "post_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "response_model": "GLM-4",
            "api_duration": 2.0,
            "ttfb": 1.0,
        },
    )
    assert len(ctx.posted) == 1
    assert "GLM-5" in ctx.posted[0]
    assert "GLM-4" in ctx.posted[0]
    assert "requested from" in ctx.posted[0] and "answered by" in ctx.posted[0]

    # Same pair again -> no duplicate
    n.observe(
        "post_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "response_model": "GLM-4",
            "api_duration": 2.0,
            "ttfb": 1.0,
        },
    )
    assert len(ctx.posted) == 1


def test_slow_start():
    ctx, n = _make_notices()
    sid, tid, aid = "s1", "t1", "a1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})
    n.observe(
        "pre_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "provider": "zhipu",
        },
    )
    n.observe(
        "post_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "response_model": "GLM-5",
            "api_duration": 2.0,
            "ttfb": 70,
        },
    )
    assert len(ctx.posted) == 1
    assert "70" in ctx.posted[0]
    assert "zhipu" in ctx.posted[0]

    # Second slow response -> no duplicate
    n.observe(
        "post_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "response_model": "GLM-5",
            "api_duration": 2.0,
            "ttfb": 80,
        },
    )
    assert len(ctx.posted) == 1


def test_helper_session_ignored():
    ctx, n = _make_notices()
    sid, tid, aid = "s1", "t1", "a1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})
    n.observe(
        "pre_api_request",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "model": "GLM-5",
            "provider": "zhipu",
        },
    )
    # Helper session: parent_session_id set
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 429,
            "reason": "rate_limit",
            "error_type": "RateLimitError",
            "api_duration": 1.2,
            "parent_session_id": "parent-s",
        },
    )
    assert len(ctx.posted) == 0


def test_tool_failure_three_in_a_row_then_edit():
    ctx, n = _make_notices()
    sid, tid = "s1", "t1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})

    for i in range(3):
        n.observe(
            "post_tool_call",
            {
                "session_id": sid,
                "turn_id": tid,
                "tool_name": "terminal",
                "tool_call_id": f"tc{i}",
                "duration_ms": 10,
                "error": "boom",
            },
        )

    # First two failures: no notice. Third: post.
    assert len(ctx.posted) == 1
    assert "terminal" in ctx.posted[0]
    assert "3 times" in ctx.posted[0]

    # Fourth failure: edit to 4.
    n.observe(
        "post_tool_call",
        {
            "session_id": sid,
            "turn_id": tid,
            "tool_name": "terminal",
            "tool_call_id": "tc3",
            "duration_ms": 10,
            "error": "boom",
        },
    )
    assert len(ctx.posted) == 1
    assert len(ctx.handles[0].edited) == 1
    assert "4 times" in ctx.handles[0].edited[0]


def test_tool_success_resets_count():
    ctx, n = _make_notices()
    sid, tid = "s1", "t1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})

    # Two failures
    for i in range(2):
        n.observe(
            "post_tool_call",
            {
                "session_id": sid,
                "turn_id": tid,
                "tool_name": "terminal",
                "tool_call_id": f"tc{i}",
                "duration_ms": 10,
                "error": "boom",
            },
        )
    # Success resets
    n.observe(
        "post_tool_call",
        {
            "session_id": sid,
            "turn_id": tid,
            "tool_name": "terminal",
            "tool_call_id": "tc_ok",
            "duration_ms": 10,
            "error": None,
        },
    )
    # Two more failures -> only 2, no notice yet
    for i in range(2):
        n.observe(
            "post_tool_call",
            {
                "session_id": sid,
                "turn_id": tid,
                "tool_name": "terminal",
                "tool_call_id": f"tc_r{i}",
                "duration_ms": 10,
                "error": "boom",
            },
        )
    assert len(ctx.posted) == 0


def test_cap_five_new_messages():
    ctx, n = _make_notices()
    sid, tid = "s1", "t1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})

    # Generate many distinct notices to exceed the cap.
    # Use different api_request_ids so each is a separate event.
    for i in range(10):
        aid = f"a{i}"
        n.observe(
            "pre_api_request",
            {
                "session_id": sid,
                "turn_id": tid,
                "api_request_id": aid,
                "model": "GLM-5",
                "provider": "zhipu",
            },
        )
        n.observe(
            "post_api_request",
            {
                "session_id": sid,
                "turn_id": tid,
                "api_request_id": aid,
                "model": "GLM-5",
                "response_model": f"GLM-{i}",
                "api_duration": 2.0,
                "ttfb": 70,
            },
        )

    # Each response triggers both fallback and slow-start, but cap is 5.
    assert len(ctx.posted) <= 5


def test_disabled():
    ctx, n = _make_notices(enabled=False)
    sid, tid, aid = "s1", "t1", "a1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 429,
            "reason": "rate_limit",
            "error_type": "RateLimitError",
            "api_duration": 1.2,
        },
    )
    assert len(ctx.posted) == 0


def test_normalize_raising():
    def bad_normalize(hook_name, kwargs):
        raise RuntimeError("boom")

    ctx, n = _make_notices(normalize=bad_normalize)
    # Should not raise
    n.observe("pre_llm_call", {"session_id": "s1", "turn_id": "t1"})
    assert len(ctx.posted) == 0


def test_no_post_message_on_ctx():
    class NoPostCtx:
        pass

    ctx = NoPostCtx()
    n = Notices(
        ctx=ctx,
        link_for=lambda sid: f"https://viewer/{sid}",
        enabled=True,
        spawn=lambda fn: fn(),
        normalize=_fake_normalize,
    )
    sid, tid, aid = "s1", "t1", "a1"
    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 429,
            "reason": "rate_limit",
            "error_type": "RateLimitError",
            "api_duration": 1.2,
        },
    )
    # No crash, nothing posted (no post_message attr)
    assert not hasattr(ctx, "posted")


def test_provider_error_once():
    ctx, n = _make_notices()
    sid, tid, aid = "s1", "t1", "a1"

    n.observe("pre_llm_call", {"session_id": sid, "turn_id": tid})
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 503,
            "reason": "timeout",
            "error_type": "TimeoutError",
            "api_duration": 30.0,
        },
    )
    assert len(ctx.posted) == 1
    assert "timeout" in ctx.posted[0]

    # Second provider error -> no duplicate
    n.observe(
        "api_request_error",
        {
            "session_id": sid,
            "turn_id": tid,
            "api_request_id": aid,
            "status_code": 500,
            "reason": "timeout",
            "error_type": "TimeoutError",
            "api_duration": 30.0,
        },
    )
    assert len(ctx.posted) == 1


def test_edits_before_the_post_lands_are_applied_not_reposted():
    # Production posts on a background thread: the handle is not known yet when the next
    # rate limit arrives. The second error must edit the first notice, not post a new one.
    queued = []
    ctx, n = _make_notices(spawn=queued.append)
    base = {"session_id": "s1", "turn_id": "t1", "api_request_id": "a1"}
    n.observe("pre_llm_call", {"session_id": "s1", "turn_id": "t1"})
    n.observe("pre_api_request", {**base, "model": "GLM-5", "provider": "zhipu"})
    err = {**base, "status_code": 429, "reason": "rate_limit", "error_type": "RateLimitError", "api_duration": 1.0}
    n.observe("api_request_error", err)
    n.observe("api_request_error", err)
    assert ctx.posted == []  # nothing has run yet
    for fn in queued:
        fn()
    assert len(ctx.posted) == 1
    assert ctx.handles[0].edited and "2 times" in ctx.handles[0].edited[-1]
