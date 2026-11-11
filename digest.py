"""The turn summary Omniscience sends into the chat.

The user should not have to open the viewer to learn the things that actually
matter about a turn: what ran, what it cost in tokens, whether the context is
now expensive to keep sending, and anything that went wrong. This module turns a
turn's facts into at most four short lines, ranked by importance.

Rules:

- Only provider-reported token counts. No invented money, ever.
- Nothing to say (no calls, no tools) means nothing sent.
- Sentence case, `·` separators, numbers with thousands separators.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

__all__ = ["TurnFacts", "render", "format_tokens", "compact_warning_level", "plain_name"]

# Control characters only. Tool, provider and model names come from outside this code (an MCP
# server names its own tools, a provider names its own model), so a newline in one of them must
# not be able to fabricate a second line - a fake warning, for instance. Punctuation is left
# alone: real names carry underscores, dots and slashes.
_CONTROL = re.compile(r"[\x00-\x1f\x7f\u2028\u2029]")


def plain_name(value, limit: int = 80) -> str:
    """A recorded name rendered on one line, bounded in length."""
    text = "" if value is None else str(value)
    text = " ".join(_CONTROL.sub(" ", text).split())
    return text[:limit]

COMPACT_PROMPT = 200_000
WATCH_PROMPT = 100_000
MAX_NAMES = 3


def format_tokens(n: Optional[int]) -> str:
    if n is None or isinstance(n, bool):
        return "0"
    try:
        return f"{int(round(n)):,}"
    except (TypeError, ValueError):
        return "0"


@dataclass
class TurnFacts:
    """What happened during one turn, as the recorder saw it."""

    calls: int = 0
    tools: int = 0
    mcp: int = 0
    skills: list[str] = field(default_factory=list)
    aux: int = 0
    helpers: int = 0
    failures: list[str] = field(default_factory=list)
    rate_limits: int = 0
    switches: list[tuple[str, str]] = field(default_factory=list)
    slowest_s: Optional[float] = None
    slowest_name: Optional[str] = None
    prompt_last: Optional[int] = None
    fresh_last: Optional[int] = None
    cache_share: Optional[float] = None
    peak: Optional[int] = None
    output: Optional[int] = None
    seconds: Optional[float] = None
    compacted: Optional[tuple[int, int]] = None

    def is_empty(self) -> bool:
        return self.calls <= 0 and self.tools <= 0 and self.helpers <= 0


def _plural(n: int, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def _join(parts: list[str]) -> str:
    return " · ".join(part for part in parts if part)


def _names(names: list[str]) -> str:
    clean = [plain_name(n) for n in names if n]
    if not clean:
        return ""
    if len(clean) <= MAX_NAMES:
        return ", ".join(clean)
    return ", ".join(clean[:MAX_NAMES]) + f" +{len(clean) - MAX_NAMES} more"


def compact_warning_level(prompt: int, cache_share: Optional[float] = None) -> str:
    """ok / watch / compact — the same bands the viewer's banner uses."""
    if prompt >= COMPACT_PROMPT:
        return "compact"
    if cache_share is not None and cache_share < 0.5 and prompt >= 120_000:
        return "compact"
    if prompt >= WATCH_PROMPT:
        return "watch"
    if cache_share is not None and cache_share < 0.5 and prompt >= 60_000:
        return "watch"
    return "ok"


def render(facts: TurnFacts, detail: str = "standard", hint: bool = False) -> Optional[str]:
    """The message to post, or None when the turn has nothing worth reporting."""
    if facts is None or facts.is_empty():
        return None

    detail = detail if detail in ("brief", "standard", "full") else "standard"
    lines: list[str] = []

    # 1. Something went wrong: that is the most important thing to say.
    if facts.failures:
        count = len(facts.failures)
        lines.append(f"⚠ {count} {_plural(count, 'failure')}: {_names(facts.failures)}")
    if facts.rate_limits:
        n = facts.rate_limits
        lines.append(f"⚠ rate-limited {n}× · Hermes retried")

    # 2. What ran.
    ran: list[str] = []
    if facts.calls:
        ran.append(f"{format_tokens(facts.calls)} model {_plural(facts.calls, 'call')}")
    if facts.tools:
        tools = f"{format_tokens(facts.tools)} {_plural(facts.tools, 'tool call')}"
        if facts.mcp:
            tools += f" ({format_tokens(facts.mcp)} MCP)"
        ran.append(tools)
    if facts.skills:
        n = len(facts.skills)
        ran.append(f"{n} {_plural(n, 'skill')}")
    if facts.aux:
        ran.append(f"{format_tokens(facts.aux)} outside")
    if facts.helpers:
        ran.append(f"{format_tokens(facts.helpers)} helper {_plural(facts.helpers, 'agent')}")
    if facts.seconds and facts.seconds >= 1:
        ran.append(f"{int(round(facts.seconds))} s")
    head = _join(["◍ Omniscience"] + ran)

    # 3. What it cost in tokens.
    cost: list[str] = []
    if facts.prompt_last:
        cost.append(f"{format_tokens(facts.prompt_last)} tokens sent per message")
    if facts.cache_share is not None and facts.prompt_last:
        cost.append(f"{int(round(facts.cache_share * 100))}% reused from cache")
    if facts.fresh_last:
        cost.append(f"{format_tokens(facts.fresh_last)} new on the last call")
    if detail == "full" and facts.output:
        cost.append(f"{format_tokens(facts.output)} back")

    # 4. Is this chat now expensive to keep talking to?
    warning = ""
    if facts.prompt_last or facts.peak:
        size = max(facts.prompt_last or 0, facts.peak or 0)
        level = compact_warning_level(size, facts.cache_share)
        if level == "compact":
            target = 35_000 if size > 100_000 else max(1, int(size * 0.4))
            save = max(0, min(95, int(round((1 - target / size) * 100))))
            warning = (
                f"Compacting would cut that to about {format_tokens(target)} per message "
                f"({save}% less)."
            )
        elif level == "watch":
            warning = "Getting big — worth compacting before it grows further."

    if detail == "brief":
        # Identity plus anything that went wrong. No token arithmetic at all.
        lines.append(head)
    else:
        lines.append(head)
        if cost:
            lines.append(_join(cost) + ".")
        if warning:
            lines.append(warning)

    if detail == "full":
        for asked, answered in facts.switches:
            lines.append(f"↪ answered by {plain_name(answered)}, not the {plain_name(asked)} it asked for.")
        if facts.compacted:
            before, after = facts.compacted
            lines.append(
                f"◐ compacted mid-turn: {format_tokens(before)} → {format_tokens(after)}."
            )
        if facts.slowest_s and facts.slowest_s >= 5:
            step = plain_name(facts.slowest_name) or "one step"
            lines.append(f"Slowest step: {step} at {int(round(facts.slowest_s))} s.")

    if hint:
        lines[-1] = f"{lines[-1]} · /omni digest off to stop this"

    return "\n".join(line for line in lines if line)
