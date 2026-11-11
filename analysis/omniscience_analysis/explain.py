"""Plain-English explanations for rule findings.

``explain`` turns a :class:`~omniscience_analysis.rules.Finding` into a dict of
friendly sentences a non-programmer can read. It carries the real numbers from
the finding (counts, seconds, tool names) but never echoes prompt text,
arguments, or outputs. Session ids are kept out of the sentences and returned
separately.
"""

from __future__ import annotations

import re
from typing import Any

SEVERITY_LABELS = {
    "high": "high",
    "medium": "medium",
    "low": "low",
}

_WORD = re.compile(r"[A-Za-z0-9_]+")


def _title_case(name: str) -> str:
    words = _WORD.findall(name) if isinstance(name, str) else []
    return " ".join(w[:1].upper() + w[1:] for w in words) if words else "Warning"


def _fmt_num(value: Any) -> str:
    """Format a number without trailing ``.0`` noise."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return str(value)
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    return f"{f:.1f}"


def _extract_numbers(text: str) -> list:
    return []



# What to do about each finding. A warning that only says "this happened" leaves the reader to
# guess; every rule below names the usual cause and the next action, using only recorded facts.
_REMEDIES = {
    "repeated_tool_failure": (
        "The same tool failed several times in a row, which usually means the input was not the "
        "problem the agent thought it was: a wrong path, a missing permission, a command that is "
        "not installed, or the same arguments retried unchanged. Read the tool's own error text in "
        "the listed events, fix that cause, then retry once rather than looping."
    ),
    "loop": (
        "The agent kept calling tools without the conversation moving forward. Common causes are a "
        "blocked input it cannot fix (a missing file, a command that needs a password) and a plan "
        "that keeps re-reading the same thing. Stop the chat and restate the goal with the missing "
        "detail, or fix the blocked input first."
    ),
    "stall": (
        "Nothing was recorded for a long time. Either a model call is still streaming, or a tool is "
        "waiting on something outside the agent (a network call, a file lock, a prompt for input). "
        "The model latency figures show whether the provider is the slow part; if they are normal, "
        "look at the tool that was running when the events stopped."
    ),
    "unanswered_request": (
        "A model request has no matching response, so something ended the call early: the process "
        "was stopped, the provider dropped the connection, or the turn timed out. The cost of that "
        "call may still have been billed. Retry the turn; if it repeats at the same point, the "
        "request is probably too large or the provider is rate limiting."
    ),
    "slow_inference": (
        "This is provider or model latency, not something the agent did wrong. Compare the model "
        "and provider in the listed calls with the others in the same chat: a single model running "
        "several times slower than its usual figure points at that provider. Switching model or "
        "retrying later is the practical fix; a retry of the same call usually lands on a healthy "
        "worker."
    ),
    "token_spike": (
        "One message added far more context than the rest, so every following call pays for it "
        "again. The usual cause is a large paste, a big tool output, or a file read that returned "
        "more than expected. Find the step where the jump happened and keep that material out of "
        "the conversation, or compact now."
    ),
    "lost_events": (
        "The recorder dropped events, so this view is incomplete rather than the run being slow. "
        "That happens when the write queue fills or the writer thread hits an error. Treat the "
        "counts here as a lower bound; the recorded database still holds everything that was "
        "written."
    ),
}

_GENERIC_REMEDY = (
    "Read the listed events first: the cause is usually in the last step before the pattern "
    "started. If it repeats in the same place, it is worth a bug report with the version line "
    "from the header."
)

def explain(finding: Any) -> dict:
    """Return ``{"title", "what_happened", "what_it_means", "severity",
    "event_ids", "session_id"}`` for a single Finding-like object.

    Unknown rules get a safe generic sentence. The finding is never mutated.
    """
    rule = getattr(finding, "rule", None)
    message = getattr(finding, "message", "") or ""
    severity = getattr(finding, "severity", None) or "medium"
    event_ids = list(getattr(finding, "event_ids", None) or [])
    session_id = getattr(finding, "session_id", None)
    if not isinstance(message, str):
        message = str(message)

    handler = _HANDLERS.get(rule) if rule else None
    if handler is not None:
        title, what_happened, what_it_means = handler(message, session_id)
    else:
        label = _title_case(rule) if rule else "Warning"
        title = label
        what_happened = (
            f"{label}: {message}" if message else f"{label}: an unusual pattern was detected."
        )
        what_it_means = (
            "This is an automated note about how the session went. "
            "Check the listed events to see the details."
        )

    return {
        "title": title,
        "what_happened": what_happened,
        "what_it_means": what_it_means,
        "what_to_do": _REMEDIES.get(rule, _GENERIC_REMEDY),
        "severity": SEVERITY_LABELS.get(severity, "medium"),
        "event_ids": event_ids,
        "session_id": session_id,
    }


# ---------------------------------------------------------------------------
# per-rule sentences
# ---------------------------------------------------------------------------


def _session_clause(_session_id: Any) -> str:
    return ""


def _repeated_tool_failure(message: str, session_id: Any) -> tuple[str, str, str]:
    # "tool 'bash' ended with status=error 3 time(s) (>= 3) in session s1"
    m = re.search(r"tool '([^']+)'.*?(\d+) time", message)
    tool = m.group(1) if m else "a tool"
    count = m.group(2) if m else "several"
    title = f"Repeated failures in the {tool} tool"
    what = (
        f"The {tool} tool failed {count} times{_session_clause(session_id)}."
    )
    means = (
        "Something the agent tried to do kept failing. "
        "The task may still be unfinished; it is worth a closer look."
        if m
        else "Something kept breaking; the task may be unfinished."
    )
    return title, what, means


def _loop(message: str, session_id: Any) -> tuple[str, str, str]:
    # "tool 'grep' called 5x consecutively with identical arg_names [...] in turn t1"
    m = re.search(r"tool '([^']+)'.*?(\d+)x consecutively", message)
    tool = m.group(1) if m else "a tool"
    count = m.group(2) if m else "several"
    title = f"Repeated calls to the {tool} tool"
    what = (
        f"The {tool} tool was called {count} times in a row with the same argument names"
        f"{_session_clause(session_id)}."
    )
    means = (
        "The values are not recorded, so these may be different requests. "
        "Check the surrounding activity to decide whether this needs attention."
    )
    return title, what, means


def _stall(message: str, session_id: Any) -> tuple[str, str, str]:
    # "session.start has no matching end and is 700.0s older than the newest
    #  event (threshold 300.0s)" / "llm.request <id> has no matching end and ..."
    m = re.search(r"([\d.]+)s older than the newest event \(threshold ([\d.]+)s\)", message)
    age = _fmt_num(m.group(1)) if m else None
    threshold = _fmt_num(m.group(2)) if m else None
    is_request = message.startswith("llm.request")
    if is_request:
        title = "A model request may be stuck"
        what = (
            f"A request to the AI model has been waiting with no answer for about "
            f"{age} seconds{_session_clause(session_id)}." if age and threshold else
            f"A request to the AI model has been waiting with no answer"
            f"{_session_clause(session_id)}."
        )
        means = (
            "Things usually move faster than this. The request may have been "
            "lost; you may need to send it again."
        )
    else:
        title = "A session may be left open"
        what = (
            f"A session has had no activity for about {age} seconds and has not properly "
            f"ended yet{_session_clause(session_id)}."
            if age and threshold
            else f"A session has not properly ended{_session_clause(session_id)}."
        )
        means = (
            "Sessions normally close when the work finishes. This one may have "
            "been interrupted or is still running."
        )
    return title, what, means


def _unanswered_request(message: str, session_id: Any) -> tuple[str, str, str]:
    # "llm.request <id> got no answer, but the session carried on afterwards"
    title = "A request to the AI model stopped without an answer"
    what = (
        "A request to the AI model stopped without an answer"
        f"{_session_clause(session_id)}."
    )
    means = (
        "The agent moved on, so it was probably cancelled or interrupted. "
        "The record does not show why; check for missing events."
    )
    return title, what, means


def _slow_inference(message: str, session_id: Any) -> tuple[str, str, str]:
    # "llm.response took 120.0s (> 60.0s)"
    m = re.search(r"took ([\d.]+)s \(> ([\d.]+)s\)", message)
    took = _fmt_num(m.group(1)) if m else None
    limit = _fmt_num(m.group(2)) if m else None
    title = "The AI took a long time to answer"
    if took:
        what = (
            f"It took {took} seconds for the AI model to finish answering"
            f"{_session_clause(session_id)}."
            + (f" That is above the usual {limit} seconds." if limit else "")
        )
    else:
        what = (
            f"The AI model took longer than usual to finish answering"
            f"{_session_clause(session_id)}."
        )
    means = (
        "The answer arrived, but the recording alone does not explain the delay."
    )
    return title, what, means


def _token_spike(message: str, session_id: Any) -> tuple[str, str, str]:
    # "usage.total_tokens 1000 > 3x session median 100 (3 samples)"
    m = re.search(
        r"([\d.eE+]+) > ([\d.eE+]+)x session median ([\d.eE+]+) \((\d+) samples\)", message
    )
    if m:
        tokens, factor, median, samples = m.group(1), m.group(2), m.group(3), m.group(4)
        title = "Much more text than usual in one step"
        what = (
            f"One step used {tokens} tokens, about {factor} times the session's "
            f"typical {median} (over {samples} steps)"
            f"{_session_clause(session_id)}."
        )
    else:
        title = "Much more text than usual in one step"
        what = (
            f"One step used far more tokens than the session's typical amount"
            f"{_session_clause(session_id)}."
        )
    means = (
        "A token is a small chunk of text. A spike like this can make the "
        "session slower or cost more. The recorded usage does not identify the cause."
    )
    return title, what, means


def _lost_events(message: str, session_id: Any) -> tuple[str, str, str]:
    # "omni.dropped marker present (count=3): events were lost"
    m = re.search(r"count=([^):]+)", message)
    count = m.group(1).strip() if m else None
    title = "Some activity records were lost"
    if count is not None:
        what = (
            f"About {count} event record{'s were' if not count.isdigit() or int(count) != 1 else ' was'} "
            f"lost while the tracker was writing"
            f"{_session_clause(session_id)}."
        )
    else:
        what = (
            f"Event records were lost while the tracker was writing"
            f"{_session_clause(session_id)}."
        )
    means = (
        "The history is incomplete, so conclusions based on it may be incomplete too."
    )
    return title, what, means


_HANDLERS = {
    "repeated_tool_failure": _repeated_tool_failure,
    "loop": _loop,
    "stall": _stall,
    "unanswered_request": _unanswered_request,
    "slow_inference": _slow_inference,
    "token_spike": _token_spike,
    "lost_events": _lost_events,
}
