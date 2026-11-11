"""Explain *why* a recorded run failed, using only the recorded rows.

The privacy design never stores error message text, so this reads the
structured fields the plugin does keep -- ``status``, ``error_type``,
``child_status``, ``tool_name`` and ``duration_ms`` -- and builds a single
plain-English line from them. It never guesses a cause: if the rows do not
carry the required fields it returns an ``insufficient`` answer naming what is
missing. No LLM calls and stdlib only.
"""

from __future__ import annotations

from typing import Any

from . import db as db_mod

_KIND_LABELS = {
    "tool": "tool",
    "llm": "model request",
    "subagent": "helper agent",
}


def _failure_kind(event: dict) -> str | None:
    """Return ``tool``/``llm``/``subagent`` if *event* is a failing step, else None.

    Only the recorded fields are consulted (never message text): a ``tool.end``
    is failing when its status is ``error`` or an ``error_type`` was recorded;
    any ``llm.error`` is failing; a ``subagent.stop`` is failing when the child
    finished ``failed``/``error``.
    """
    kind = event.get("kind")
    attrs = event.get("attrs") or {}
    if kind == "tool.end":
        if event.get("status") == "error" or attrs.get("error_type"):
            return "tool"
        return None
    if kind == "llm.error":
        return "llm"
    if kind == "subagent.stop":
        if attrs.get("child_status") in ("failed", "error"):
            return "subagent"
        return None
    return None


def _is_ok_step(event: dict, session_id: Any) -> bool:
    """An *ok* prior step: a successfully finished ``tool.end`` in *session_id*."""
    return (
        event.get("kind") == "tool.end"
        and event.get("status") == "ok"
        and event.get("session_id") == session_id
    )


def _insufficient(missing: list[str]) -> dict:
    return {"status": "insufficient", "missing": missing}


def _build_sentence(failure: str, failed_tool: str | None, error_type: Any,
                    duration_ms: Any) -> str:
    """One plain-English line built only from the structured fields above."""
    if failed_tool is not None:
        actor = f"the {failed_tool} tool"
    else:
        actor = f"the {_KIND_LABELS.get(failure, 'last')} step"
    parts = [f"The first failure was {actor}"]
    if error_type:
        parts.append(f"with a {error_type} error")
    if duration_ms is not None:
        parts.append(f"after {duration_ms} ms")
    return " ".join(parts) + "."


# How many of the newest rows a diagnosis reads. Bounded so a huge chat cannot make the
# endpoint slow, wide enough that the end of a long turn is inside it.
DIAGNOSE_WINDOW = 2000


def explain(db_path: str, session_id: str) -> dict:
    """Explain the first failure of *session_id* (root plus helper agents).

    Returns ``explained`` / ``no_failure`` / ``insufficient`` per the contract;
    the answer is derived solely from stored rows -- no message text, no LLM.
    """
    # The newest rows, not the first 1000 ever recorded: a long chat's failure is at the end,
    # and reading from the beginning reported "no failure" for exactly the runs worth explaining.
    events = db_mod.events_for_root(db_path, session_id, limit=DIAGNOSE_WINDOW, tail=True)

    # Gateway-wide omni.dropped markers carry no session; they are not this
    # run's rows, so "no rows" means no events from the session's own subtree.
    if not [e for e in events if e.get("session_id") is not None]:
        return _insufficient(["rows"])

    failing = None
    for event in events:
        failure = _failure_kind(event)
        if failure is not None:
            failing = event
            break
    if failing is None:
        if len(events) >= DIAGNOSE_WINDOW:
            # The window is full, so an earlier failure could exist just outside it. "No failure"
            # would be a claim the data cannot support.
            return {"status": "insufficient", "missing": ["failure in the most recent events"],
                    "window": DIAGNOSE_WINDOW}
        return {"status": "no_failure", "events": len(events), "window": DIAGNOSE_WINDOW}

    failure = _failure_kind(failing)
    failing_id = failing["event_id"]
    failing_session = failing.get("session_id")
    failing_attrs = failing.get("attrs") or {}

    previous = None
    for event in events:
        if event.get("rowid") >= failing.get("rowid"):
            break
        if _is_ok_step(event, failing_session):
            previous = event

    missing: list[str] = []
    if previous is None:
        missing.append("previous_step")
    error_type = failing_attrs.get("error_type")
    if error_type is None and failing.get("status") is None:
        missing.append("error_type")
    if missing:
        return _insufficient(missing)

    previous_attrs = previous.get("attrs") or {}
    failed_tool = failing_attrs.get("tool_name") if failure == "tool" else None
    duration_ms = failing_attrs.get("duration_ms")

    return {
        "status": "explained",
        "failed_kind": failing.get("kind"),
        "failed_tool": failed_tool,
        "error_type": error_type,
        "duration_ms": duration_ms,
        "session_id": failing_session,
        "previous_step": {
            "kind": previous.get("kind"),
            "tool": previous_attrs.get("tool_name"),
            "duration_ms": previous_attrs.get("duration_ms"),
            "event_id": previous.get("event_id"),
        },
        "evidence_event_ids": [failing_id, previous.get("event_id")],
        "sentence": _build_sentence(failure, failed_tool, error_type, duration_ms),
    }
