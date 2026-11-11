"""The turn summary: what it says, what it refuses to say, and how it ranks."""

from __future__ import annotations

from digest import TurnFacts, compact_warning_level, format_tokens, render


def _text(facts: TurnFacts, **kwargs) -> str:
    text = render(facts, **kwargs)
    assert isinstance(text, str) and text
    return text


def test_a_quiet_turn_says_nothing_at_all():
    assert render(TurnFacts()) is None


def test_a_normal_turn_reports_what_ran_and_what_it_costs():
    facts = TurnFacts(
        calls=3,
        tools=12,
        mcp=2,
        skills=["systematic-debugging"],
        aux=1,
        seconds=74.0,
        prompt_last=248_000,
        fresh_last=31_000,
        cache_share=0.875,
        peak=248_000,
    )
    text = _text(facts)
    assert text is not None
    lines = text.splitlines()
    assert lines[0].startswith("◍ Omniscience")
    assert "3 model calls" in lines[0]
    assert "12 tool calls (2 MCP)" in lines[0]
    assert "1 skill" in lines[0]
    assert "74 s" in lines[0]
    assert "248,000 tokens sent per message" in lines[1]
    assert "88% reused from cache" in lines[1]
    assert "31,000 new on the last call" in lines[1]


def test_no_money_is_ever_invented():
    facts = TurnFacts(calls=1, prompt_last=900_000, cache_share=0.0, peak=900_000)
    text = _text(facts, detail="full")
    assert text is not None
    assert "$" not in text


def test_failures_come_first_and_are_named():
    facts = TurnFacts(calls=1, tools=3, failures=["bash", "http_get"], prompt_last=1000)
    lines = _text(facts).splitlines()
    assert lines[0].startswith("⚠ 2 failures: bash, http_get")


def test_too_many_failures_are_summarised_not_listed():
    facts = TurnFacts(calls=1, failures=["a", "b", "c", "d", "e"])
    assert "a, b, c +2 more" in _text(facts)


def test_a_big_context_gets_the_compaction_advice():
    facts = TurnFacts(calls=1, prompt_last=248_000, cache_share=0.9, peak=248_000)
    text = _text(facts)
    assert "Compacting would cut that" in text
    assert "86% less" in text


def test_a_poorly_cached_chat_is_warned_earlier():
    facts = TurnFacts(calls=1, prompt_last=130_000, cache_share=0.02, peak=130_000)
    assert "Compacting would cut that" in _text(facts)


def test_a_medium_context_is_only_a_heads_up():
    facts = TurnFacts(calls=1, prompt_last=120_000, cache_share=0.95, peak=120_000)
    text = _text(facts)
    assert "Getting big" in text
    assert "Compacting would cut" not in text


def test_brief_keeps_the_identity_line_and_problems():
    facts = TurnFacts(calls=2, tools=4, seconds=30.0, prompt_last=250_000, cache_share=0.9, failures=["bash"])
    lines = _text(facts, detail="brief").splitlines()
    assert lines[0].startswith("⚠ 1 failure: bash")
    assert lines[1].startswith("◍ Omniscience")
    assert not any("tokens sent per message" in line for line in lines)


def test_full_adds_switches_compaction_and_the_slowest_step():
    facts = TurnFacts(
        calls=2,
        prompt_last=40_000,
        cache_share=0.9,
        peak=200_000,
        switches=[("opus", "deepseek")],
        compacted=(200_000, 40_000),
        slowest_s=23.4,
        slowest_name="read_file",
    )
    lines = _text(facts, detail="full").splitlines()
    assert any("answered by deepseek, not the opus" in line for line in lines)
    assert any("compacted mid-turn: 200,000 → 40,000" in line for line in lines)
    assert any("Slowest step: read_file at 23 s" in line for line in lines)


def test_standard_leaves_the_verbose_bits_out():
    facts = TurnFacts(calls=1, prompt_last=40_000, switches=[("a", "b")], slowest_s=30.0, slowest_name="x")
    text = _text(facts, detail="standard")
    assert "answered by" not in text
    assert "Slowest step" not in text


def test_rate_limits_are_reported_once():
    facts = TurnFacts(calls=1, rate_limits=2)
    assert "rate-limited 2× · Hermes retried" in _text(facts)


def test_helpers_and_outside_calls_are_counted():
    facts = TurnFacts(calls=1, aux=3, helpers=2)
    line = _text(facts).splitlines()[0]
    assert "3 outside" in line
    assert "2 helper agents" in line


def test_the_hint_appears_once_and_can_be_left_off():
    facts = TurnFacts(calls=1)
    assert "/omni digest off" in _text(facts, hint=True)
    assert "/omni digest off" not in _text(facts, hint=False)


def test_detail_levels_are_validated_not_trusted():
    facts = TurnFacts(calls=1, prompt_last=250_000, cache_share=0.9, peak=250_000)
    assert "Compacting would cut" in _text(facts, detail="nonsense")


def test_unknown_detail_falls_back_to_standard_and_still_renders():
    assert render(TurnFacts(calls=1), detail="") is not None


def test_format_tokens_is_readable():
    assert format_tokens(248_000) == "248,000"
    assert format_tokens(None) == "0"
    assert format_tokens(True) == "0"


def test_warning_bands_match_the_viewer():
    assert compact_warning_level(99_000, 0.9) == "ok"
    assert compact_warning_level(100_000, 0.9) == "watch"
    assert compact_warning_level(200_000, 0.9) == "compact"
    assert compact_warning_level(130_000, 0.0) == "compact"
    assert compact_warning_level(70_000, 0.0) == "watch"
