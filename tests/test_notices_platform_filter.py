"""The 'local only' notice platform filter must actually keep notices off
messaging platforms.

By default (OMNISCIENCE_NOTICES unset -> 'local' mode) register() calls
``set_platform_filter(_LOCAL_PLATFORMS)`` so live step notices are only posted on
local surfaces (cli/tui/desktop/...). A regression where the filter reads the
platform from the wrong place turns it into a no-op, and short step facts (model,
provider, tool names, rate-limit notices) start leaking into off-machine chats
such as Slack or Telegram.

These tests use the REAL sanitize.normalize (the plugin's own field mapping),
because the leak only shows up with the real mapping: normalize records the
platform in ``attrs`` (on turn.start), never in ``ids``.
"""

from __future__ import annotations

from omniscience import _LOCAL_PLATFORMS
from omniscience.notices import Notices


class _Handle:
    def edit(self, text: str) -> None:  # pragma: no cover - not exercised here
        pass


class _Ctx:
    def __init__(self) -> None:
        self.posted: list[str] = []

    def post_message(self, text: str) -> _Handle:
        self.posted.append(text)
        return _Handle()


def _notices(ctx: _Ctx) -> Notices:
    # normalize=None -> the real sanitize.normalize is used.
    n = Notices(ctx, link_for=lambda sid: "L", enabled=True, spawn=lambda fn: fn())
    n.set_platform_filter(_LOCAL_PLATFORMS)
    return n


def _run_turn(n: Notices, platform: str) -> None:
    n.observe("pre_llm_call", {"session_id": "s1", "turn_id": "t1",
                               "platform": platform, "model": "m"})
    n.observe("pre_api_request", {"session_id": "s1", "turn_id": "t1",
                                  "api_request_id": "a1", "model": "m",
                                  "provider": "zhipu"})
    n.observe("api_request_error", {"session_id": "s1", "turn_id": "t1",
                                    "api_request_id": "a1", "status_code": 429,
                                    "reason": "rate_limit",
                                    "error_type": "RateLimitError",
                                    "api_duration": 1.2})


def test_notice_not_posted_on_a_messaging_platform():
    ctx = _Ctx()
    n = _notices(ctx)
    _run_turn(n, platform="slack")
    assert ctx.posted == [], (
        "a live notice leaked onto a non-local platform: the 'local only' filter "
        "did not block it"
    )


def test_notice_still_posted_on_a_local_platform():
    ctx = _Ctx()
    n = _notices(ctx)
    _run_turn(n, platform="cli")
    assert len(ctx.posted) == 1, "a rate-limit notice must still appear on a local surface"
