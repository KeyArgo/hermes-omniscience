# tests/test_reminder.py
"""Tests for the cost reminders: thresholds, wording, and the "say it once" rule."""

from __future__ import annotations

import pytest

from omniscience.reminder import CostWatch, advice, compact_target, enabled, format_tokens
from omniscience.notices import Notices


class FakeHandle:
    def __init__(self) -> None:
        self.edits: list[str] = []

    def edit(self, text: str) -> None:
        self.edits.append(text)


class FakeCtx:
    def __init__(self) -> None:
        self.posts: list[str] = []

    def post_message(self, text: str) -> FakeHandle:
        self.posts.append(text)
        return FakeHandle()


def fake_normalize(hook_name: str, kwargs: dict):
    """Pretend a post_api_request hook produced an llm.response event."""
    ids = {"session_id": kwargs.get("session_id", "s1"), "api_request_id": kwargs.get("api_request_id")}
    return ("llm.response", ids, "ok", kwargs.get("attrs", {}), f"llm.response:{ids['api_request_id']}")


def make_notices(detail="brief", **kwargs):
    ctx = FakeCtx()
    notices = Notices(
        ctx,
        lambda session: f"http://127.0.0.1:8797/?session={session}",
        spawn=lambda fn: fn(),
        normalize=fake_normalize,
        prefs_reader=lambda: {"digest": {"enabled": True, "detail": detail}},
        **kwargs,
    )
    return notices, ctx


def response(notices, usage, session="s1"):
    notices.observe(
        "post_api_request",
        {
            "session_id": session,
            "api_request_id": "r1",
            "attrs": {"response_model": "m", "usage": usage},
        },
    )


def test_notices_posts_one_cost_reminder_for_a_big_chat():
    notices, ctx = make_notices()
    response(notices, {"prompt_tokens": 250000, "cache_read_tokens": 240000})
    # same size again in the same turn: no second post
    response(notices, {"prompt_tokens": 250000, "cache_read_tokens": 240000})
    assert len(ctx.posts) == 1
    assert "250,000" in ctx.posts[0]
    assert "session=s1" in ctx.posts[0]


def test_the_escalation_stays_out_of_the_way_when_the_summary_carries_the_cost():
    notices, ctx = make_notices(detail="standard")
    response(notices, {"prompt_tokens": 250000, "cache_read_tokens": 240000})
    assert ctx.posts == []


def test_the_escalation_is_silent_when_the_summary_is_off():
    notices, ctx = make_notices(detail="brief", )
    notices._prefs_reader = lambda: {"digest": {"enabled": False}}
    notices._prefs_at = 0.0
    response(notices, {"prompt_tokens": 250000, "cache_read_tokens": 240000})
    assert ctx.posts == []


def test_notices_says_nothing_for_an_ordinary_chat():
    notices, ctx = make_notices()
    response(notices, {"prompt_tokens": 30000, "cache_read_tokens": 29000})
    assert ctx.posts == []


def test_notices_survives_missing_usage():
    notices, ctx = make_notices()
    response(notices, None)
    assert ctx.posts == []


def test_format_tokens_always_shows_scale():
    assert format_tokens(42000) == "42,000"
    assert format_tokens(0) == "0"
    assert format_tokens(None) == "0"


def test_compact_target_shrinks_to_a_realistic_size():
    assert compact_target(400000) == 35000
    assert compact_target(20000) == 8000
    assert compact_target(0) == 1
    assert compact_target(10000) < 10000


def test_small_chat_says_nothing():
    fact = advice(42000, 40000)
    assert fact["level"] == "ok"
    assert fact["text"] is None


def test_watch_band_states_the_numbers_and_the_saving():
    fact = advice(148000, 140000)
    assert fact["level"] == "watch"
    assert "148,000" in fact["text"]
    assert "%" in fact["text"]
    assert "$" not in fact["text"]


def test_compact_band_explains_what_it_costs_to_wait():
    fact = advice(248000, 240000)
    assert fact["level"] == "compact"
    assert "248,000" in fact["text"]
    assert "35,000" in fact["text"]
    assert "every reply pays" in fact["text"]


def test_thresholds_are_exact():
    assert advice(199_999, 199_000)["level"] == "watch"
    assert advice(200_000, 199_000)["level"] == "compact"


def test_poor_cache_makes_a_smaller_context_worth_mentioning():
    assert advice(130_000, 0)["level"] == "compact"
    assert advice(70_000, 0)["level"] == "watch"


def test_never_raises_on_nonsense_numbers():
    for bad in (None, "lots", float("nan"), float("inf"), -5, True):
        fact = advice(bad, bad)
        assert fact["level"] == "ok"
        assert fact["prompt"] >= 0


def test_says_it_once_per_level_not_once_per_reply():
    watch = CostWatch()
    first = watch.consider("s1", 150000, 140000)
    assert first is not None and first["repeat"] is False
    assert watch.consider("s1", 150000, 140000) is None
    assert watch.consider("s1", 155000, 145000) is None


def test_speaks_up_when_the_context_really_grows():
    watch = CostWatch()
    watch.consider("s1", 150000, 140000)
    again = watch.consider("s1", 200000, 190000)
    assert again is not None
    assert again["level"] == "compact"
    assert again["repeat"] is False


def test_repeats_a_growing_context_at_the_same_level():
    watch = CostWatch()
    watch.consider("s1", 210000, 200000)
    again = watch.consider("s1", 280000, 270000)
    assert again is not None
    assert again["level"] == "compact"
    assert again["repeat"] is True


def test_quiet_after_a_compaction_helped():
    watch = CostWatch()
    watch.consider("s1", 240000, 200000)
    assert watch.consider("s1", 45000, 40000) is None
    assert watch.consider("s1", 52000, 50000) is None


def test_separate_chats_are_remembered_separately():
    watch = CostWatch()
    assert watch.consider("a", 210000) is not None
    assert watch.consider("b", 210000) is not None


def test_off_switch(monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_COST_NOTICES", "0")
    assert enabled() is False
    assert CostWatch().consider("s1", 900000) is None
    monkeypatch.setenv("OMNISCIENCE_COST_NOTICES", "1")
    assert enabled() is True
