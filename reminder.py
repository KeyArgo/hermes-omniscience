"""Cost reminders for the Omniscience Hermes plugin.

Every message in a chat re-sends the whole conversation, so a long chat gets
expensive in a way the user cannot see: the input grows, and the bill per message
grows with it. This module decides, from the numbers the provider reported, when
to say so in the chat and what to say.

Rules of the house:

- No invented money. Only token counts that were actually reported.
- Quiet by default. One reminder per chat per escalation, not one per reply.
- Never suggest something the user cannot do: the wording says what compacting
  changes, and points at the viewer for the detail.
"""

from __future__ import annotations

import os
from collections import OrderedDict
from typing import Any, Optional

__all__ = ["CostWatch", "advice", "compact_target", "format_tokens", "enabled"]

# Thresholds mirror web/src/graph/pressure.ts so the chat and the viewer agree.
COMPACT_PROMPT = 200_000
WATCH_PROMPT = 100_000
POOR_CACHE_SHARE = 0.5
# A chat that already has a small cache bill but a big context is still a cost.
POOR_CACHE_PROMPT = 120_000

# Re-remind only when the situation really moved.
GROWTH_TO_REPEAT = 0.25
_MAX_SESSIONS = 64
_LEVELS = ("ok", "watch", "compact")

_LEVEL_RANK = {"ok": 0, "watch": 1, "compact": 2}


def enabled() -> bool:
    """Cost reminders are on unless someone turns them off."""
    value = os.environ.get("OMNISCIENCE_COST_NOTICES", "1").strip().lower()
    return value not in ("0", "false", "no", "off")


def format_tokens(n: int) -> str:
    """42,000 -> "42,000". Never a decimal that hides the scale."""
    try:
        return f"{int(round(n)):,}"
    except (TypeError, ValueError):
        return "0"


def compact_target(now: int) -> int:
    """The size a compaction would realistically leave behind."""
    if now <= 0:
        return 1
    if now > 100_000:
        return 35_000
    return max(1, min(now, int(round(now * 0.4))))


def _level(prompt: int, cache_share: Optional[float]) -> str:
    if prompt >= COMPACT_PROMPT:
        return "compact"
    if cache_share is not None and cache_share < POOR_CACHE_SHARE and prompt >= POOR_CACHE_PROMPT:
        return "compact"
    if prompt >= WATCH_PROMPT:
        return "watch"
    if cache_share is not None and cache_share < POOR_CACHE_SHARE and prompt >= 60_000:
        return "watch"
    return "ok"


def advice(prompt_tokens: Any, cache_read_tokens: Any = 0) -> dict:
    """What to tell the user about this chat's cost, in tokens.

    Returns {"level": "ok"|"watch"|"compact", "prompt": int, "target": int,
             "save_pct": int, "cache_share": float|None, "text": str|None}
    where text is the sentence to post, and None when there is nothing to say.
    """
    prompt = _number(prompt_tokens)
    cache_read = _number(cache_read_tokens)
    if prompt <= 0:
        return {
            "level": "ok",
            "prompt": 0,
            "target": 0,
            "save_pct": 0,
            "cache_share": None,
            "text": None,
        }

    cache_share = max(0.0, min(1.0, cache_read / prompt)) if prompt else None
    level = _level(prompt, cache_share)
    target = compact_target(prompt)
    save_pct = int(round((1 - (target / prompt)) * 100)) if prompt > 0 else 0
    save_pct = max(0, min(95, save_pct))

    text: Optional[str] = None
    if level == "watch":
        text = (
            f"Omniscience: this chat now sends {format_tokens(prompt)} tokens with every "
            f"message. Compacting at a good moment would bring it to about "
            f"{format_tokens(target)} ({save_pct}% less input per message)."
        )
    elif level == "compact":
        text = (
            f"Omniscience: every message in this chat now sends {format_tokens(prompt)} "
            f"tokens, and compacting would cut that to about {format_tokens(target)} "
            f"({save_pct}% less input per message). Until then, every reply pays for the "
            f"whole conversation."
        )

    return {
        "level": level,
        "prompt": prompt,
        "target": target,
        "save_pct": save_pct,
        "cache_share": cache_share,
        "text": text,
    }


def _number(value: Any) -> int:
    """A finite, non-negative token count, or 0. Never raises, never NaN."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if value != value or value in (float("inf"), float("-inf")):
        return 0
    return max(0, int(round(value)))


class CostWatch:
    """Per-chat memory so the same reminder does not repeat every reply."""

    def __init__(self) -> None:
        self._seen: "OrderedDict[str, dict]" = OrderedDict()

    def consider(
        self, session_id: Optional[str], prompt_tokens: Any, cache_read_tokens: Any = 0
    ) -> Optional[dict]:
        """Return the reminder to post, or None when there is nothing new to say.

        The returned dict is the advice dict plus ``repeat`` (False when this is a
        new escalation, True when it is the same level after real growth).
        """
        if not session_id or not enabled():
            return None
        fact = advice(prompt_tokens, cache_read_tokens)
        if fact["text"] is None:
            return None

        record = self._seen.get(session_id)
        repeat = False
        if record is not None:
            previous_level = record["level"]
            previous_prompt = record["prompt"]
            grew = previous_prompt > 0 and fact["prompt"] > previous_prompt * (1 + GROWTH_TO_REPEAT)
            if _LEVEL_RANK[fact["level"]] < _LEVEL_RANK[previous_level]:
                # It got better (a compaction landed, or a new chat): stay quiet
                # until it is worth mentioning again, but remember the new size.
                self._remember(session_id, fact)
                return None
            if _LEVEL_RANK[fact["level"]] == _LEVEL_RANK[previous_level] and not grew:
                self._remember(session_id, fact, level_kept=True)
                return None
            repeat = _LEVEL_RANK[fact["level"]] == _LEVEL_RANK[previous_level]

        self._remember(session_id, fact)
        return {**fact, "repeat": repeat}

    def forget(self, session_id: Optional[str]) -> None:
        if session_id:
            self._seen.pop(session_id, None)

    def _remember(self, session_id: str, fact: dict, level_kept: bool = False) -> None:
        record = self._seen.get(session_id)
        level = record["level"] if (level_kept and record) else fact["level"]
        self._seen[session_id] = {"level": level, "prompt": fact["prompt"]}
        self._seen.move_to_end(session_id)
        while len(self._seen) > _MAX_SESSIONS:
            self._seen.popitem(last=False)
