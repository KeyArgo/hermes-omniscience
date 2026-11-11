"""Explain each failure in a run: what happened, why, and what to do next.

The recorder keeps no message text — that is the privacy design — so this works from the
structured fields it does keep: ``kind``, ``status``, ``error_type``, ``reason``, ``status_code``,
``duration_ms``/``duration_s``, ``tool_name``, and the model call in front of the failure.

Every sentence is derived from a row. Where the rows cannot support a cause, the answer says what
is missing instead of guessing, and a cause is only claimed when the field that proves it exists
(``status_code == 429``, ``reason == "timeout"``, a recorded ``error_type``).

This replaces the single-sentence answer: a reader troubleshooting a stopped message needs the
tool, the timing, the context size it died with, and a next action — not "the first failure was
the terminal tool".
"""

from __future__ import annotations

import time
from typing import Any, Optional

# How far back a failure looks for its own context (the model call before it, a rate-limit storm).
CONTEXT_LOOKBACK = 40
RATE_LIMIT_WINDOW_S = 3600

# What a tool's failure usually means, and what actually helps. Keyed by the recorded tool name;
# the fallback is deliberately shallow, because "some tool failed" is all the rows prove.
_TOOL_ADVICE: dict[str, tuple[str, list[str]]] = {
    "terminal": (
        "a command that failed, timed out or was killed — a bad path, a permission, a long-running "
        "command, or a process the shell could not start",
        [
            "Open the step and check the exit status and how long it ran before it stopped.",
            "Re-run the same command by hand; a permission or path problem shows immediately.",
            "If it was killed, the cause is usually the command running longer than the tool's timeout.",
        ],
    ),
    "write_file": (
        "a refused write — the file changed on disk since it was read, or the path is not writable",
        [
            "Read the file again, then write it: a write is refused when the copy you have is stale.",
            "Check the path exists and the directory is writable.",
        ],
    ),
    "read_file": (
        "a missing or unreadable path",
        ["Check the path with the file browser, then retry with the exact name."],
    ),
    "memory": (
        "Hermes' memory store is over its character budget, so writes are rejected until it is trimmed",
        [
            "Trim or merge an old memory entry rather than retrying the write.",
            "Move task procedures into a skill; that is where they belong and it costs no budget.",
        ],
    ),
    "browser_exec": (
        "the page failed to load, a login wall stopped it, or the element it wanted was not there",
        [
            "Check whether the page needed a login or a 2FA step (the recorder never stores those).",
            "Retry with a simpler action: read the page text first, then click.",
        ],
    ),
}


def _num(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _prompt_of(attrs: dict) -> float:
    usage = attrs.get("usage")
    if not isinstance(usage, dict):
        usage = {}
    prompt = _num(usage.get("prompt_tokens"))
    if prompt and prompt > 0:
        return prompt
    cache_read = _num(usage.get("cache_read_tokens")) or 0.0
    fresh = _num(usage.get("input_tokens")) or 0.0
    return cache_read + fresh


def _median(values: list[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def _fmt_ms(value: Optional[float]) -> str:
    if value is None:
        return "an unknown time"
    if value < 1000:
        return f"{value:.0f} ms"
    if value < 60_000:
        return f"{value / 1000:.1f} s"
    minutes = value / 60_000
    return f"{minutes:.1f} min"


def _fmt_tokens(value: Optional[float]) -> Optional[str]:
    if not value:
        return None
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M tokens"
    if value >= 1000:
        return f"{value / 1000:.0f}k tokens"
    return f"{value:.0f} tokens"


def is_failure(event: dict) -> bool:
    """The same rule the rest of the viewer uses, kept in one place."""
    kind = event.get("kind")
    attrs = event.get("attrs") or {}
    status = str(event.get("status") or "")
    if kind == "llm.error":
        return True
    if kind == "tool.end":
        return status in ("error", "timeout") or bool(attrs.get("error_type"))
    if kind == "subagent.stop":
        return str(attrs.get("child_status") or "") in ("failed", "error")
    return False


def explain_failures(events: list[dict], now: Optional[float] = None) -> list[dict]:
    """One explanation per failure, in the order they happened.

    ``events`` must be in time order (the viewer's own query returns that), because every answer
    is about what came immediately before the failure.
    """
    now = time.time() if now is None else now
    tool_durations: dict[str, list[float]] = {}
    for event in events:
        if event.get("kind") == "tool.end" and str(event.get("status") or "") == "ok":
            attrs = event.get("attrs") or {}
            duration = _num(attrs.get("duration_ms"))
            name = str(attrs.get("tool_name") or "")
            if duration is not None and name:
                tool_durations.setdefault(name, []).append(duration)

    out: list[dict] = []
    for index, event in enumerate(events):
        if not is_failure(event):
            continue
        out.append(_explain_one(events, index, tool_durations, now))
    return out


def _explain_one(
    events: list[dict],
    index: int,
    tool_durations: dict[str, list[float]],
    now: float,
) -> dict:
    event = events[index]
    attrs = event.get("attrs") or {}
    kind = str(event.get("kind") or "")
    status = str(event.get("status") or "")
    tool = str(attrs.get("tool_name") or "") or None
    error_type = attrs.get("error_type") or None
    reason = str(attrs.get("reason") or "") or None
    status_code = attrs.get("status_code")
    duration_ms = _num(attrs.get("duration_ms"))
    duration_s_raw = _num(attrs.get("duration_s"))
    duration_from_s = duration_s_raw * 1000 if duration_s_raw is not None else None
    elapsed = duration_ms if duration_ms is not None else duration_from_s

    # The model call in front of it: its prompt, model and provider are the context it died in.
    last_call: Optional[dict] = None
    for back in range(index - 1, max(-1, index - CONTEXT_LOOKBACK - 1), -1):
        candidate = events[back]
        if candidate.get("kind") in ("llm.response", "llm.request"):
            last_call = candidate
            break

    # Rate limits for the same provider in the hour before: a storm is a different story from a
    # single refusal, and the count is a fact the rows already hold.
    rate_limits = 0
    for back in range(index - 1, max(-1, index - CONTEXT_LOOKBACK - 1), -1):
        other = events[back]
        if other.get("kind") != "llm.error":
            continue
        other_attrs = other.get("attrs") or {}
        if other_attrs.get("status_code") == 429 or "rate" in str(other_attrs.get("reason") or "").lower():
            if float(other.get("ts") or 0) >= float(event.get("ts") or 0) - RATE_LIMIT_WINDOW_S:
                rate_limits += 1

    call_attrs = (last_call or {}).get("attrs") or {}
    prompt = _prompt_of(call_attrs) if last_call else 0.0
    model = str(call_attrs.get("response_model") or call_attrs.get("model") or "") or None
    provider = str(call_attrs.get("provider") or "") or None

    why: list[str] = []
    actions: list[str] = []
    headline = "A step failed"

    rate_limited = status_code == 429 or (reason or "").lower().startswith("rate")
    timed_out = (reason or "").lower() == "timeout" or status == "timeout" or "timeout" in str(error_type or "").lower()

    if kind == "llm.error":
        if rate_limited:
            headline = "The provider refused the call (rate limit)"
            why.append(
                f"The request was rejected with a rate limit"
                + (f" (HTTP {status_code})" if status_code else "")
                + (f" on {model}" if model else "")
                + (f" via {provider}" if provider else "")
                + "."
            )
            if rate_limits:
                why.append(
                    f"{rate_limits} rate limit{'s' if rate_limits != 1 else ''} hit in the hour before this one: "
                    "the account, not the prompt, is being throttled."
                )
            actions.append("Retry after a wait; the retry's own duration lands in the same average.")
            actions.append(
                "Send fewer calls at once, or route this work to another provider or model."
            )
        elif timed_out:
            headline = "The model call timed out"
            why.append(
                f"The call ran {_fmt_ms(elapsed)} and was given up on"
                + (f" ({error_type})" if error_type else "")
                + "."
            )
            if prompt and _fmt_tokens(prompt):
                why.append(
                    f"It was carrying {_fmt_tokens(prompt)} of context, and a large prompt is what "
                    "makes a call slow at the provider."
                )
            actions.append("Retry the message; a timeout is often a single slow request.")
            actions.append("If it repeats in one chat, compact that chat — its context is the weight being sent.")
        else:
            headline = "The model call failed"
            why.append(
                "The provider returned an error"
                + (f" of type {error_type}" if error_type else "")
                + (f" (HTTP {status_code})" if status_code else "")
                + "."
            )
            if attrs.get("retryable") is False:
                why.append("It was recorded as not retryable, so repeating it unchanged will fail again.")
            actions.append("Retry once; if it repeats, switch provider or model for this chat.")
    elif kind == "tool.end":
        headline = f"The {tool or 'tool'} tool failed"
        text, tips = _TOOL_ADVICE.get(
            tool or "",
            (
                "the tool returned an error"
                + (f" of type {error_type}" if error_type else "")
                + (f" with status {status}" if status else ""),
                ["Open the step to see the recorded arguments' names and how long it ran."],
            ),
        )
        why.append(f"Recorded as {status or 'failed'}: {text}.")
        median = _median(tool_durations.get(tool or "", []))
        if elapsed is not None and median:
            ratio = elapsed / median if median else 0
            why.append(
                f"It ran {_fmt_ms(elapsed)} against a median of {_fmt_ms(median)} for this tool in this run"
                + (" — far slower than usual, which points at the command itself." if ratio >= 3 else ".")
            )
        elif elapsed is not None:
            why.append(f"It ran {_fmt_ms(elapsed)} before failing.")
        actions.extend(tips)
    elif kind == "subagent.stop":
        headline = "A helper agent failed"
        why.append(f"The helper finished with status {attrs.get('child_status') or 'failed'}.")
        actions.append("Open the helper's chat from Helpers to see which step inside it failed.")

    if prompt and _fmt_tokens(prompt) and not any("context" in line for line in why):
        why.append(f"The last model call before it carried {_fmt_tokens(prompt)} of context.")

    if not why:
        why.append("The recorded rows do not carry enough to name a cause.")

    return {
        "event_id": event.get("event_id"),
        "rowid": event.get("rowid"),
        "ts": event.get("ts"),
        "kind": kind,
        "tool": tool,
        "status": status or None,
        "error_type": error_type,
        "reason": reason,
        "status_code": status_code,
        "severity": "error",
        "model": model,
        "provider": provider,
        "prompt_tokens": int(prompt) if prompt else None,
        "rate_limits_before": rate_limits,
        "headline": headline,
        "why": why,
        "actions": actions[:3],
    }


def _nearest_failure(events: list[dict], now: float) -> Optional[str]:
    """The last failure before the stop, as a sentence — the two answers belong together."""
    for event in reversed(events):
        if not is_failure(event):
            continue
        attrs = event.get("attrs") or {}
        when = float(event.get("ts") or 0)
        if not when:
            continue
        minutes = max(0, int((now - when) / 60))
        age = f"{minutes}m" if minutes < 120 else f"{minutes // 60}h {minutes % 60}m"
        what = attrs.get("tool_name") or str(event.get("kind") or "step")
        reason = attrs.get("reason") or attrs.get("error_type") or event.get("status") or "failed"
        return f"The nearest failure before the stop was {what} ({reason}), {age} earlier."
    return None


def explain_stop(events: list[dict], now: Optional[float] = None) -> dict:
    """Why the run stopped where it did — the question behind "my message never finished".

    The verdict says a message stopped before completing; that is a fact about the *flow*, and the
    flow is visible: a request with no response, or a tool that never returned. An LLM call that
    went out and never came back is the ordinary shape of a killed process or a provider that died
    mid-call, and it is not a "failure" row — which is why listing failures alone never answered
    this.
    """
    now = time.time() if now is None else now
    if not events:
        return {"stopped": False, "reason": "no_events", "headline": "", "why": [], "actions": [], "event_id": None}

    last = events[-1]
    kind = str(last.get("kind") or "")
    attrs = last.get("attrs") or {}
    when = float(last.get("ts") or 0)
    age = max(0, int(now - when)) if when else None
    ago = f"{age}s ago" if age is not None and age < 120 else (f"{age // 60}m ago" if age is not None else "at an unknown time")

    if kind in ("session.end", "turn.end"):
        return {"stopped": False, "reason": "ended", "headline": "", "why": [], "actions": [], "event_id": None}

    if kind == "llm.request":
        model = str(attrs.get("model") or "") or None
        provider = str(attrs.get("provider") or "") or None
        return {
            "stopped": True,
            "reason": "model_call_unanswered",
            "event_id": last.get("event_id"),
            "headline": "The run stopped waiting on a model call that never came back",
            "why": [
                "The last recorded step is a model request"
                + (f" to {model}" if model else "")
                + (f" via {provider}" if provider else "")
                + f" sent {ago}, and no response was ever recorded for it."
            ]
            + (
                [f"It was carrying {_fmt_tokens(_prompt_of(attrs))} of context, so the provider had a "
                 "large prompt to read before it could answer."]
                if _fmt_tokens(_prompt_of(attrs))
                else []
            ),
            "actions": [
                "Resend your message: an unanswered request is not retried by the viewer, it is simply gone.",
                "If it keeps happening on the same chat, compact it — the prompt it re-sends is the weight.",
                "If the process behind the viewer was restarted, that call died with it; nothing failed in the agent.",
            ],
        }

    if kind == "llm.response":
        tool_calls = attrs.get("tool_call_count")
        requested = int(tool_calls) if isinstance(tool_calls, (int, float)) else 0
        finish = str(attrs.get("finish_reason") or "")
        nearest = _nearest_failure(events, now)
        if requested > 0:
            return {
                "stopped": True,
                "reason": "tool_request_unanswered",
                "event_id": last.get("event_id"),
                "headline": "The run stopped after the model asked for a tool that never ran",
                "why": [
                    f"The last recorded step is a model reply that requested {requested} tool "
                    f"call{'s' if requested != 1 else ''} {ago}"
                    + (f" ({finish})" if finish else "")
                    + ", and no tool step was recorded after it."
                ]
                + ([nearest] if nearest else []),
                "actions": [
                    "Resend the message: the agent will ask for that tool again and finish the step.",
                    "If it stops at the same point every time, the tool it wanted is the suspect — "
                    "open the last step to see its name and how long it ran.",
                ],
            }
        return {
            "stopped": True,
            "reason": "answer_then_idle",
            "event_id": last.get("event_id"),
            "headline": "The last message ended with an answer, and nothing was left pending",
            "why": [
                f"The last recorded step is a model reply with no tool calls {ago}"
                + (f" ({finish})" if finish else "")
                + ", so the turn had finished its work."
            ]
            + ([nearest] if nearest else []),
            "actions": [
                "Nothing to fix here: the chat has been idle since that answer.",
                "Send your next message; the recording will pick it up from there.",
            ],
        }

    if kind == "llm.error":
        return {
            "stopped": True,
            "reason": "last_step_failed",
            "event_id": last.get("event_id"),
            "headline": "The run stopped on a failed model call",
            "why": [
                f"The last recorded step is a failed model request ({attrs.get('reason') or attrs.get('error_type') or 'unknown reason'}) {ago}."
            ],
            "actions": [
                "Retry the message; if it repeats, switch provider or model for this chat.",
            ],
        }

    if kind == "tool.end":
        tool = str(attrs.get("tool_name") or "tool")
        status = str(last.get("status") or "")
        if status in ("error", "timeout"):
            return {
                "stopped": True,
                "reason": "last_tool_failed",
                "event_id": last.get("event_id"),
                "headline": f"The run stopped after the {tool} tool failed",
                "why": [f"The last recorded step is a failed {tool} call ({status}) {ago}."],
                "actions": ["Open that step for its recorded arguments' names; fix the cause, then resend."],
            }
        return {
            "stopped": True,
            "reason": "idle_after_tool",
            "event_id": last.get("event_id"),
            "headline": "The run stopped after a step that succeeded",
            "why": [
                f"The last recorded step is a successful {tool} call {ago}, with nothing after it. "
                "The agent stopped between steps, which is what a cancel, a kill or a closed window looks like."
            ],
            "actions": ["Resend the message if you did not cancel it; the recording has no error to explain."],
        }

    answered = "a model call that answered" if kind == "llm.response" else f"a {kind or 'unknown'} step"
    return {
        "stopped": True,
        "reason": "idle",
        "event_id": last.get("event_id"),
        "headline": "The run stopped after a step that succeeded",
        "why": [
            f"The last recorded step is {answered} {ago}, and nothing followed it. The recording has "
            "no error to explain: this is what a cancel, a killed process or a closed window looks like."
        ],
        "actions": ["Resend the message if you did not cancel it; there is nothing to fix here."],
    }
