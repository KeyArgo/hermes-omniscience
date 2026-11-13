"""Write up a recording with the model Hermes is already running.

The viewer can show the numbers; explaining them is a model job — but the model belongs to
Hermes, not to this viewer. So this module never reads a credential file, never holds a key and
never talks to a provider. The plugin asks its host for the completion (``ctx.llm``, the
``agent/plugin_llm.py`` facade: the host owns routing, auth, timeouts and fallback) and hands
the answer back here to be shaped, saved and shown.

The entry point is :func:`writeup`: a digest plus a ``complete`` callable. The viewer process
has no ``ctx``, so it serves the report this module saved beside the recording (see the
``/api/v1/insight`` route); ``/omni insight`` inside Hermes is what produces it.

What is sent: counts, token totals, model and provider names, durations, error reasons, chat
labels. What is never sent: a prompt, a tool argument, a tool result, or a file's contents —
the recorder does not store them, so there is nothing to leak.

The digest is built from the same functions that feed the pages (``usage.build_usage`` and
``db.latency_by_model``), so the writeup cannot contradict the screen it is describing.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Optional

from . import db as db_mod
from . import usage as usage_mod

log = logging.getLogger(__name__)

# The writeup Hermes wrote, beside the recording it describes. One file, replaced on demand: a
# reader who asks for a report wants the latest one, and a corpus of stale diagnoses is noise.
WRITEUP_FILE = "insight.json"


def _fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:,.2f}" if value < 10 else f"{value:,.0f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _num(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _window_label(days: float) -> str:
    """How the digest names its own period. A fraction of a day is an hour, said as one."""
    if not days:
        return "everything recorded"
    hours = days * 24
    if hours <= 1.5:
        whole = max(1, round(hours))
        return f"the last {whole} hour" + ("" if whole == 1 else "s")
    if days < 1.5:
        return "the last day"
    return f"the last {days:g} days"


def has_events(db_path: str) -> bool:
    """False only when the recording is readable and empty.

    A fresh profile has the database and no rows; a digest of zeros is not a diagnosis, and
    asking a model to write one up spends a call to say nothing. An unreadable database answers
    True — that is a different problem, and the normal path reports it.
    """
    import sqlite3

    if not db_path or not os.path.isfile(db_path):
        return False
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
        try:
            return con.execute("select 1 from events limit 1").fetchone() is not None
        finally:
            con.close()
    except sqlite3.Error:
        return True


def build_digest(db_path: str, state_db: Optional[str], days: float, now: Optional[float] = None) -> str:
    """A compact, metadata-only description of the recording, as text for the model."""
    now = time.time() if now is None else now
    payload = usage_mod.build_usage(db_path, state_db, days=days, now=now)
    latency = db_mod.latency_by_model(db_path, window_seconds=(days * 86400) if days else None)

    totals = payload.get("totals") or {}
    cache = payload.get("cache") or {}
    window = _window_label(days)

    lines: list[str] = []
    lines.append(f"RECORDING DIGEST — {window}, generated {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now))}")
    lines.append("")
    lines.append("TOTALS")
    for key, label in (
        ("calls", "model calls"),
        ("chats", "chats"),
        ("tool_calls", "tool calls"),
        ("prompt", "tokens sent (including cache reads)"),
        ("cache_read", "cache-read tokens"),
        ("output", "output tokens"),
    ):
        lines.append(f"  {label}: {_fmt(totals.get(key))}")
    hit = _num(cache.get("hit_rate"))
    lines.append(f"  cache hit rate: {f'{hit * 100:.1f}%' if hit is not None else '—'}")
    cost = _num(totals.get("cost"))
    lines.append(
        f"  cost estimate (Hermes' own figure): {f'${cost:,.2f}' if cost and cost > 0 else 'not stored for this period'}"
    )
    saved = _num(cache.get("saved_usd"))
    if saved:
        lines.append(f"  saved by cache: ${saved:,.2f}")

    lines.append("")
    lines.append("MODELS (busiest first)")
    for row in list(payload.get("models") or [])[:10]:
        p95 = _num(row.get("p95_s"))
        tail = f", p95 {p95:.1f}s" if p95 is not None else ""
        lines.append(
            f"  {row.get('model')}: {_fmt(row.get('calls'))} calls, "
            f"{_fmt(row.get('prompt'))} tokens in, {_fmt(row.get('output'))} out{tail}"
        )

    harnesses = payload.get("harnesses") or []
    if harnesses:
        lines.append("")
        lines.append("HARNESSES")
        for row in harnesses[:8]:
            lines.append(
                f"  {row.get('source') or 'unknown'}: {_fmt(row.get('calls'))} calls, {_fmt(row.get('prompt'))} tokens, "
                f"{len(row.get('models') or [])} models"
            )

    if latency:
        lines.append("")
        lines.append("RELIABILITY BY PROVIDER AND MODEL")
        for row in latency[:12]:
            lines.append(
                "  "
                f"{row.get('provider')}/{row.get('model')}: {_fmt(row.get('calls'))} calls, "
                f"median {_fmt(row.get('p50_s'))}s, p95 {_fmt(row.get('p95_s'))}s, "
                f"slowest {_fmt(row.get('max_s'))}s, first word {_fmt(row.get('ttfb_p50_s'))}s, "
                f">30s {_fmt(row.get('over_30s'))}, rate-limited {_fmt(row.get('rate_limited'))}, "
                f"retried {_fmt(row.get('retried'))}, timeouts {_fmt(row.get('timeouts'))}, "
                f"other errors {_fmt(row.get('other_errors'))}, compactions seen {_fmt(row.get('compactions'))}"
            )

    chats = list(payload.get("chats") or [])
    if chats:
        lines.append("")
        lines.append("BUSIEST CHATS (label — calls, tools, context now, peak)")
        for row in chats[:10]:
            label = str(row.get("label") or row.get("session") or row.get("id") or "untitled")
            label = f"[{row.get('source')}] {label[:56]}" if row.get("source") else label[:60]
            lines.append(
                f"  {label}: {_fmt(row.get('calls'))} calls, {_fmt(row.get('tools'))} tools, "
                f"context now {_fmt(row.get('prompt_now'))}, peak {_fmt(row.get('prompt_max'))}"
            )

    reasons = _error_reasons(db_path, (now - days * 86400) if days else None)
    if reasons:
        lines.append("")
        lines.append("WHY CALLS FAILED (recorded error reasons)")
        for reason, count in reasons[:10]:
            lines.append(f"  {reason}: {count}")

    lines.append("")
    lines.append(
        "NOTE: this recording is metadata only. It never stores prompts, tool arguments, tool results "
        "or file contents, so nothing below can quote a conversation."
    )
    return "\n".join(lines)


def _error_reasons(db_path: str, since: Optional[float]) -> list[tuple[str, int]]:
    """``llm.error`` reasons with counts: the closest thing to a cause the recorder keeps."""
    import sqlite3

    if not db_path or not os.path.isfile(db_path):
        return []
    counts: dict[str, int] = {}
    query = "select attrs from events where kind = 'llm.error' and attrs is not null"
    params: tuple = ()
    if since:
        query += " and ts >= ?"
        params = (since,)
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            for (raw,) in con.execute(query, params):
                attrs = db_mod._parse_attrs(raw)
                label = str(
                    attrs.get("reason") or attrs.get("error_type") or attrs.get("status_code") or "unrecorded"
                )
                counts[label] = counts.get(label, 0) + 1
        finally:
            con.close()
    except sqlite3.Error:
        return []
    return sorted(counts.items(), key=lambda item: item[1], reverse=True)


SYSTEM_PROMPT = (
    "You are reading a metadata-only recording of an AI coding agent's activity on one machine "
    "(Omniscience). It records how many calls happened, how many tokens were sent and cached, how "
    "long each model took, which provider refused or retried a call, and how big each chat's context "
    "grew. It never records prompts, tool arguments, tool results or file contents, so do not ask for "
    "them and do not speculate about what was discussed.\n\n"
    "Write a diagnosis for the person who owns this machine. Rules:\n"
    "- Use the real numbers from the digest; never invent a figure, a date or a cause.\n"
    "- Say where the money went, which provider or model is slow and why, what failed, and whether "
    "context/compaction pressure is the real problem.\n"
    "- Where a number is missing, say it is missing rather than guessing.\n"
    "- End with five concrete actions, each one sentence, ordered by what saves the most time or money.\n"
    "- Markdown, short sections, no preamble, no filler, no emoji. Use bullet points. Around 400 words."
)


def messages(digest: str) -> list[dict[str, str]]:
    """The exact two messages the host sends: the rules, then the digest."""
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": digest},
    ]


def _text_of(result: Any) -> str:
    """The answer's text, whether the host returned a facade result or a bare string."""
    text = result if isinstance(result, str) else getattr(result, "text", None)
    return text.strip() if isinstance(text, str) else ""


def writeup(
    digest: str,
    complete: Callable[..., Any],
    *,
    days: float = 7.0,
    now: Optional[float] = None,
) -> dict[str, Any]:
    """Ask the host's LLM facade for the writeup and shape the answer.

    ``complete`` is ``ctx.llm.complete`` (or anything with that signature): the host routes the
    call to the user's active model with the user's own credentials. Nothing here knows a key,
    a base URL or a provider, and nothing here opens a file Hermes owns.
    """
    if not isinstance(digest, str) or not digest.strip():
        raise RuntimeError("there is nothing recorded to write up yet")
    started = time.time()
    try:
        result = complete(
            messages=messages(digest),
            temperature=0.3,
            max_tokens=3200,
        )
    except Exception as exc:  # noqa: BLE001 - the host's refusal is the explanation
        raise RuntimeError(f"Hermes could not run the model call: {exc}") from exc

    text = _text_of(result)
    if not text:
        raise RuntimeError("the model returned an empty answer; try again or ask for a shorter period")

    model = getattr(result, "model", "") if not isinstance(result, str) else ""
    provider = getattr(result, "provider", "") if not isinstance(result, str) else ""
    usage = getattr(result, "usage", None)
    return {
        "markdown": text,
        "model": str(model or "Hermes' active model"),
        "provider": str(provider or ""),
        "days": days,
        "took_s": round(time.time() - started, 1),
        "generated_at": time.time() if now is None else now,
        "digest_chars": len(digest),
        "usage": {
            key: getattr(usage, key)
            for key in ("input_tokens", "output_tokens", "total_tokens", "cost_usd")
            if getattr(usage, key, None) is not None
        }
        if usage is not None
        else {},
    }


def writeup_path(db_path: str) -> str:
    """Where the writeup for this recording lives: beside it, never in a Hermes config folder."""
    return os.path.join(os.path.dirname(os.path.realpath(db_path)), WRITEUP_FILE)


def save(db_path: str, report: dict[str, Any]) -> str:
    """Write the report beside the recording, replacing the last one. Read by the viewer."""
    path = writeup_path(db_path)
    body = dict(report)
    body.setdefault("generated_at", time.time())
    # Which recording this describes: two databases in one folder must not show each other's
    # report, and a report for a database that has since moved is worse than no report.
    body["db"] = os.path.realpath(db_path)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(body, fh, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except OSError:
        log.debug("omniscience: could not save the writeup next to %s", db_path, exc_info=True)
    return path


def load(db_path: str) -> Optional[dict[str, Any]]:
    """The saved report, or None when Hermes has not written one for this recording."""
    try:
        with open(writeup_path(db_path), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("markdown"), str):
        return None
    if data.get("db") not in (None, os.path.realpath(db_path)):
        return None
    return data
