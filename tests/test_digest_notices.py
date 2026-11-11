"""The turn summary as the recorder actually sends it: at turn.end, once, off the main thread."""

from __future__ import annotations

from omniscience.notices import Notices


class Handle:
    def __init__(self) -> None:
        self.edits: list[str] = []

    def edit(self, text: str) -> None:
        self.edits.append(text)


class Ctx:
    def __init__(self) -> None:
        self.posts: list[str] = []

    def post_message(self, text: str) -> Handle:
        self.posts.append(text)
        return Handle()


def fake_normalize(hook_name: str, kwargs: dict):
    """Turn hook names into the same (kind, ids, status, attrs) the sanitizer produces."""
    ids = {
        "session_id": kwargs.get("session_id", "chat"),
        "parent_session_id": kwargs.get("parent_session_id"),
        "turn_id": kwargs.get("turn_id", "t1"),
        "api_request_id": kwargs.get("api_request_id"),
    }
    kind = {
        "pre_llm_call": "turn.start",
        "post_llm_call": "turn.end",
        "pre_api_request": "llm.request",
        "post_api_request": "llm.response",
        "api_request_error": "llm.error",
        "post_tool_call": "tool.end",
        "post_auxiliary_call": "aux.response",
        "subagent_start": "subagent.start",
        "on_skill_lifecycle": "skill.event",
    }.get(hook_name)
    if kind is None:
        return None
    attrs = {k: v for k, v in kwargs.items() if k not in ids}
    return (kind, ids, kwargs.get("status", "ok"), attrs, "n")


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make(prefs: dict | None = None, clock: Clock | None = None):
    ctx = Ctx()
    clock = clock or Clock()
    notices = Notices(
        ctx,
        lambda sid: "http://127.0.0.1:8797/?session=" + sid,
        spawn=lambda fn: fn(),
        normalize=fake_normalize,
        clock=clock,
        prefs_reader=lambda: prefs if prefs is not None else {"digest": {"enabled": True, "detail": "standard"}},
    )
    return notices, ctx, clock


def hook(notices, name, **kwargs):
    notices.observe(name, kwargs)


def run_turn(notices, clock, *, prompt=248_000, cached=240_000, output=800, tools=3, fail=None, mcp=False, start_turn=True):
    clock.now += 5
    if start_turn:
        hook(notices, "pre_llm_call", session_id="chat", turn_id="t1")
    hook(notices, "pre_api_request", session_id="chat", api_request_id="r1", model="m", provider="p")
    hook(
        notices,
        "post_api_request",
        session_id="chat",
        api_request_id="r1",
        response_model="m",
        usage={"prompt_tokens": prompt, "cache_read_tokens": cached, "output_tokens": output},
    )
    for i in range(tools):
        hook(
            notices,
            "post_tool_call",
            session_id="chat",
            tool_name=f"tool{i}",
            status="error" if fail == i else "ok",
            duration_ms=1200,
            mcp_server="github" if (mcp and i == 0) else None,
        )
    clock.now += 60
    hook(notices, "post_llm_call", session_id="chat", turn_id="t1")


def test_a_turn_posts_one_summary_with_real_numbers():
    notices, ctx, clock = make()
    run_turn(notices, clock)
    assert len(ctx.posts) == 1
    text = ctx.posts[0]
    assert text.startswith("◍ Omniscience")
    assert "1 model call" in text
    assert "3 tool calls" in text
    assert "248,000 tokens sent per message" in text
    assert "97% reused from cache" in text


def test_the_summary_is_sent_once_per_turn_not_once_per_call():
    notices, ctx, clock = make()
    run_turn(notices, clock)
    run_turn(notices, clock)
    assert len(ctx.posts) == 2


def test_the_hint_appears_only_the_first_time():
    notices, ctx, clock = make()
    run_turn(notices, clock)
    run_turn(notices, clock)
    assert "/omni digest off" in ctx.posts[0]
    assert "/omni digest off" not in ctx.posts[1]


def test_turning_it_off_stops_it_completely():
    notices, ctx, clock = make(prefs={"digest": {"enabled": False}})
    run_turn(notices, clock)
    assert ctx.posts == []


def test_env_switch_off_wins(monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_DIGEST", "0")
    notices, ctx, clock = make()
    run_turn(notices, clock)
    assert ctx.posts == []


def test_brief_detail_leaves_the_token_arithmetic_out():
    notices, ctx, clock = make(prefs={"digest": {"enabled": True, "detail": "brief"}})
    run_turn(notices, clock, prompt=40_000, cached=39_000)
    assert len(ctx.posts) == 1
    assert "tokens sent per message" not in ctx.posts[0]
    assert "1 model call" in ctx.posts[0]


def test_a_failure_is_reported_by_name():
    notices, ctx, clock = make()
    run_turn(notices, clock, fail=1)
    assert "⚠ 1 failure: tool1" in ctx.posts[0]


def test_mcp_calls_are_separated_from_plain_tools():
    notices, ctx, clock = make()
    run_turn(notices, clock, mcp=True)
    assert "3 tool calls (1 MCP)" in ctx.posts[0]


def test_outside_calls_and_skills_are_counted():
    notices, ctx, clock = make()
    hook(notices, "pre_llm_call", session_id="chat", turn_id="t1")
    hook(notices, "on_skill_lifecycle", session_id="chat", skill_name="github", phase="load")
    hook(notices, "post_auxiliary_call", session_id="chat", usage={"prompt_tokens": 100})
    run_turn(notices, clock, tools=0, start_turn=False)
    text = ctx.posts[0]
    assert "1 skill" in text
    assert "1 outside" in text


def test_a_helper_agent_is_counted_on_the_turn_that_started_it():
    notices, ctx, clock = make()
    hook(notices, "pre_llm_call", session_id="chat", turn_id="t1")
    # The child's event carries the parent, so it is skipped as a chat of its own —
    # but the parent still paid for it.
    hook(notices, "subagent_start", session_id="helper", parent_session_id="chat")
    hook(notices, "post_tool_call", session_id="helper", parent_session_id="chat", tool_name="bash", status="ok")
    run_turn(notices, clock, tools=0, start_turn=False)
    assert "1 helper agent" in ctx.posts[0]


def test_a_helper_session_never_posts_its_own_summary():
    notices, ctx, clock = make()
    hook(notices, "pre_llm_call", session_id="helper", parent_session_id="chat", turn_id="h1")
    hook(notices, "post_llm_call", session_id="helper", parent_session_id="chat", turn_id="h1")
    assert ctx.posts == []


def test_a_turn_with_nothing_in_it_says_nothing():
    notices, ctx, clock = make()
    hook(notices, "pre_llm_call", session_id="chat", turn_id="t1")
    hook(notices, "post_llm_call", session_id="chat", turn_id="t1")
    assert ctx.posts == []


def test_the_compaction_advice_rides_along_with_the_summary():
    notices, ctx, clock = make()
    run_turn(notices, clock, prompt=400_000, cached=390_000)
    assert "Compacting would cut that" in ctx.posts[0]


def test_the_cost_reminder_does_not_double_up_when_the_summary_is_on():
    notices, ctx, clock = make()
    run_turn(notices, clock, prompt=400_000, cached=390_000)
    # one message: the turn summary, not a separate cost notice as well
    assert len(ctx.posts) == 1


def test_off_means_off_not_even_a_cost_warning():
    notices, ctx, clock = make(prefs={"digest": {"enabled": False}})
    run_turn(notices, clock, prompt=400_000, cached=390_000)
    assert ctx.posts == []


def test_brief_still_gets_the_escalation_because_it_has_no_cost_line():
    notices, ctx, clock = make(prefs={"digest": {"enabled": True, "detail": "brief"}})
    run_turn(notices, clock, prompt=400_000, cached=390_000)
    assert len(ctx.posts) == 2
    digest_posts = [post for post in ctx.posts if post.startswith("◍")]
    reminder_posts = [post for post in ctx.posts if post.startswith("Omniscience:")]
    assert len(digest_posts) == 1 and len(reminder_posts) == 1
    assert "tokens sent per message" not in digest_posts[0]
    assert "compacting" in reminder_posts[0].lower()


def test_a_missing_usage_block_does_not_crash_or_invent_tokens():
    notices, ctx, clock = make()
    hook(notices, "pre_llm_call", session_id="chat", turn_id="t1")
    hook(notices, "post_api_request", session_id="chat", api_request_id="r1", response_model="m")
    hook(notices, "post_llm_call", session_id="chat", turn_id="t1")
    assert len(ctx.posts) == 1
    assert "tokens sent per message" not in ctx.posts[0]


def test_a_hostile_tool_name_cannot_fabricate_a_second_line():
    """Tool / provider / model names are recorded from outside and were interpolated raw.

    A name containing a newline could render a fake second line ("⚠ ... your data is being
    uploaded") inside a real notice. Names are now flattened to one line.
    """
    notices, ctx, clock = make()
    evil = "terminal\n\n⚠ Omniscience: recording is OFF and nothing is being kept"
    hook(notices, "pre_llm_call", session_id="chat", turn_id="t1")
    for _ in range(3):
        hook(notices, "post_tool_call", session_id="chat", turn_id="t1",
             tool_name=evil, status="error", duration_ms=5)
    assert ctx.posts, "expected a repeated-failure notice"
    for text in ctx.posts:
        assert "\n" not in text, repr(text)
    assert "recording is OFF" in ctx.posts[-1]  # the words survive, flattened onto one line

    # The digest's failure list is the same surface.
    from digest import TurnFacts, render

    out = render(TurnFacts(failures=[evil], calls=1), detail="standard")
    assert out is not None
    failure_line = out.splitlines()[0]
    assert "recording is OFF" in failure_line, failure_line
