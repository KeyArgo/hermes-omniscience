"""Read-only access to the Omniscience events SQLite database.

Every call opens its own ``mode=ro`` connection: the viewer must never write to
(or checkpoint) the database owned by the Hermes plugin writer.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any

_EVENT_COLUMNS = (
    "rowid",
    "event_id",
    "schema",
    "boot_id",
    "seq",
    "ts",
    "kind",
    "session_id",
    "parent_session_id",
    "turn_id",
    "api_request_id",
    "tool_call_id",
    "subagent_id",
    "status",
    "attrs",
)


# A read that lands on the writer's lock is retried briefly and then reported, never turned
# into an empty list: "0 conversations" reads as an empty install, not as a busy database.
READ_BUSY_TIMEOUT_MS = 1000


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(
        f"file:{path}?mode=ro", uri=True, timeout=READ_BUSY_TIMEOUT_MS / 1000.0
    )
    conn.execute(f"PRAGMA busy_timeout={READ_BUSY_TIMEOUT_MS}")
    return conn


def _parse_attrs(raw: Any) -> dict:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


# A context compaction shows up as a sudden drop in the prompt the model was
# sent. The thresholds match web/src/graph/tokens.ts so the chat list and the
# per-call chart agree.
COMPACTION_MIN_DROP = 1000
COMPACTION_MIN_RATIO = 0.25


def _usage_numbers(usage: Any) -> tuple[float, float, float, float]:
    """(cached, fresh, output, prompt) from a usage mapping. Missing -> zero."""
    if not isinstance(usage, dict):
        return 0.0, 0.0, 0.0, 0.0

    def number(key: str) -> float:
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0.0
        return float(value)

    cache_read = number("cache_read_tokens")
    cache_write = number("cache_write_tokens")
    output = number("output_tokens")
    prompt = number("prompt_tokens")
    if prompt <= 0:
        # A cache-warming call sends its whole context as *write* tokens and reports no
        # prompt_tokens; leaving cache_write out counted a 19k-token call as a few hundred
        # and made the chat list disagree with the Usage page (usage._usage), which this
        # value is meant to match.
        prompt = number("input_tokens") + cache_read + cache_write
    fresh = max(0.0, prompt - cache_read)
    return cache_read, fresh, output, prompt


def _row_to_dict(row: tuple) -> dict:
    data = dict(zip(_EVENT_COLUMNS, row))
    data["attrs"] = _parse_attrs(data.get("attrs"))
    return data


def health(path: str) -> dict:
    """Return DB health/counts. Missing or unreadable DB -> ``ok: False``."""
    result = {
        "ok": False,
        "schema": None,
        "db_path": path,
        "events": 0,
        "last_rowid": 0,
    }
    try:
        con = _connect(path)
    except sqlite3.Error:
        return result
    try:
        count, last_rowid = con.execute(
            "SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM events"
        ).fetchone()
        row = con.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
        result.update(
            {
                "ok": True,
                "schema": row[0] if row else None,
                "events": int(count),
                "last_rowid": int(last_rowid),
            }
        )
    except sqlite3.Error:
        pass
    finally:
        con.close()
    return result


def _uninitialised(exc: sqlite3.Error) -> bool:
    """A fresh or never-written database file has no events table yet: that reads as empty."""
    return "no such table" in str(exc).lower()


def latency_by_model(path: str, window_seconds: float | None = None) -> list[dict]:
    """Observed model latency per provider and model, measured from the recordings themselves.

    The recorder stamps every model call with ``duration_s`` and ``ttfb_s``, so nothing here
    probes a provider: these are the times the calls in this database actually took, which is
    what a user having a slow afternoon needs. No network call, no cost, no synthetic traffic.

    A model name alone cannot answer "is this provider unhealthy": the same model is served
    through different providers, and a provider is where a rate limit or a retry actually
    comes from. So each row carries the ``provider`` the request was sent to (learned from
    ``llm.request``, the only event that records it), plus what went wrong around those calls:
    ``rate_limited`` (429 or a rate-limit reason), ``timeouts``, ``other_errors``, ``retried``
    (requests that needed a retry), ``compactions`` (context drops attributed to the model that
    saw them) and ``last_seen``.

    ``llm.error`` records no model or provider, so an error is attributed to the last request
    in its own session — the same call it interrupted. An error with no request before it in
    that session lands on ``unknown`` rather than being dropped, because a hidden failure is
    worse than one nobody can attribute.

    Returns rows sorted by p95, worst first.
    """
    if not path or not os.path.isfile(path):
        return []
    cutoff = time.time() - window_seconds if window_seconds else None
    try:
        con = _connect(path)
        query = (
            "select ts, kind, session_id, attrs from events "
            "where kind in ('llm.request', 'llm.response', 'llm.error') and attrs is not null"
        )
        params: tuple = ()
        if cutoff is not None:
            query += " and ts >= ?"
            params = (cutoff,)
        rows = con.execute(query + " order by ts, rowid", params).fetchall()
        con.close()
    except sqlite3.Error:
        return []

    samples: dict[tuple[str, str], list[float]] = {}
    ttfb: dict[tuple[str, str], list[float]] = {}
    rate_limited: dict[tuple[str, str], int] = {}
    timeouts: dict[tuple[str, str], int] = {}
    other_errors: dict[tuple[str, str], int] = {}
    retried: dict[tuple[str, str], int] = {}
    compactions: dict[tuple[str, str], int] = {}
    last_seen: dict[tuple[str, str], float] = {}
    model_provider: dict[str, str] = {}
    last_request: dict[str, tuple[str, str]] = {}
    prev_prompt: dict[str, float] = {}
    unknown: tuple[str, str] = ("unknown", "unknown")

    def bump(bucket: dict[tuple[str, str], int], key: tuple[str, str]) -> None:
        bucket[key] = bucket.get(key, 0) + 1

    for row in rows:
        attrs = _parse_attrs(row[3])
        if not attrs:
            continue
        kind = row[1]
        session = str(row[2] or "")
        ts = row[0] if isinstance(row[0], (int, float)) else 0.0

        if kind == "llm.request":
            model = str(attrs.get("model") or "").strip()
            provider = str(attrs.get("provider") or "").strip() or "unknown"
            if not model:
                continue
            key = (provider, model)
            model_provider.setdefault(model, provider)
            if session:
                last_request[session] = key
            count = attrs.get("retry_count")
            if isinstance(count, (int, float)) and count > 0:
                bump(retried, key)
            last_seen[key] = max(last_seen.get(key, 0.0), float(ts))
            continue

        if kind == "llm.response":
            model = str(attrs.get("response_model") or attrs.get("model") or "unknown").strip()
            # The provider belongs to the request, not to the model name: the same model is
            # served through several providers, so a global name→provider map would fold two
            # accounts into one row. Use this session's own last request first.
            provider = last_request.get(session, unknown)[0]
            if provider == "unknown":
                provider = model_provider.get(model, "unknown")
            key = (provider, model)
            model_provider.setdefault(model, provider)
            duration = attrs.get("duration_s")
            if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration > 0:
                samples.setdefault(key, []).append(float(duration) * 1000.0)
                first_byte = attrs.get("ttfb_s")
                if isinstance(first_byte, (int, float)) and first_byte >= 0:
                    ttfb.setdefault(key, []).append(float(first_byte) * 1000.0)
                last_seen[key] = max(last_seen.get(key, 0.0), float(ts))
            prompt = _usage_numbers(attrs.get("usage"))[3]
            if prompt > 0 and session:
                previous = prev_prompt.get(session)
                if previous is not None and previous - prompt > COMPACTION_MIN_DROP \
                        and prompt < previous * (1 - COMPACTION_MIN_RATIO):
                    bump(compactions, key)
                prev_prompt[session] = prompt
            continue

        # llm.error: the recorder leaves the model off this event, so the interrupted call
        # names it.
        key = last_request.get(session, unknown)
        reason = str(attrs.get("reason") or "").lower()
        error_type = str(attrs.get("error_type") or "").lower()
        status = attrs.get("status_code")
        if status == 429 or "rate" in reason or "ratelimit" in error_type:
            bump(rate_limited, key)
        elif "timeout" in reason or "timeout" in error_type:
            bump(timeouts, key)
        else:
            bump(other_errors, key)
        last_seen[key] = max(last_seen.get(key, 0.0), float(ts))

    def pct(values: list[float], share: float) -> float:
        ordered = sorted(values)
        index = min(len(ordered) - 1, max(0, int(round(share * (len(ordered) - 1)))))
        return ordered[index]

    keys = set(samples) | set(rate_limited) | set(timeouts) | set(other_errors) | set(retried)
    out = []
    for key in keys:
        provider, model = key
        values = samples.get(key, [])
        errors = rate_limited.get(key, 0) + timeouts.get(key, 0) + other_errors.get(key, 0)
        out.append({
            "provider": provider,
            "model": model,
            "calls": len(values),
            "p50_s": round(pct(values, 0.5) / 1000.0, 2) if values else None,
            "p95_s": round(pct(values, 0.95) / 1000.0, 2) if values else None,
            "max_s": round(max(values) / 1000.0, 2) if values else None,
            "ttfb_p50_s": round(pct(ttfb[key], 0.5) / 1000.0, 2) if ttfb.get(key) else None,
            "over_30s": sum(1 for value in values if value >= 30_000),
            "errors": errors,
            "rate_limited": rate_limited.get(key, 0),
            "timeouts": timeouts.get(key, 0),
            "other_errors": other_errors.get(key, 0),
            "retried": retried.get(key, 0),
            "compactions": compactions.get(key, 0),
            "last_seen": last_seen.get(key) or None,
        })
    out.sort(key=lambda row: (row["p95_s"] or 0.0), reverse=True)
    return out


def rollup_by_provider(rows: list[dict]) -> list[dict]:
    """Fold the per-model rows into one row per provider, worst p95 first.

    The question "is nous having a bad afternoon" is not a model question: one provider can
    serve several model names, and a rate limit belongs to the account, not the model. Kept
    here (not in the route) so the arithmetic is unit-testable without a server.
    """
    groups: dict[str, dict] = {}
    for row in rows:
        provider = row.get("provider") or "unknown"
        group = groups.setdefault(provider, {
            "provider": provider,
            "models": 0,
            "calls": 0,
            "errors": 0,
            "rate_limited": 0,
            "timeouts": 0,
            "retried": 0,
            "compactions": 0,
            "p95_s": None,
            "worst_model": None,
            "last_seen": None,
        })
        group["models"] += 1
        for field in ("calls", "errors", "rate_limited", "timeouts", "retried", "compactions"):
            value = row.get(field)
            group[field] += value if isinstance(value, int) else 0
        p95 = row.get("p95_s")
        if isinstance(p95, (int, float)) and (group["p95_s"] is None or p95 > group["p95_s"]):
            group["p95_s"] = p95
            group["worst_model"] = row.get("model")
        seen = row.get("last_seen")
        if isinstance(seen, (int, float)) and (group["last_seen"] is None or seen > group["last_seen"]):
            group["last_seen"] = seen
    out = list(groups.values())
    out.sort(key=lambda row: (row["p95_s"] or 0.0), reverse=True)
    return out


def _purged_ids(con: sqlite3.Connection) -> set[str]:
    """Ids Hermes has deleted (or archived) since the recorder saw them.

    The recorder writes this table from the ``on_session_delete`` hook. An older database
    has no such table, which means "nothing purged" — never an error.
    """
    try:
        return {row[0] for row in con.execute("SELECT session_id FROM purged") if row[0]}
    except sqlite3.Error:
        return set()


def list_sessions(path: str, limit: int = 100) -> list[dict]:
    """List root sessions (sessions that never appear as a child). Unreadable DB -> ``[]``."""
    rows, _error = list_sessions_checked(path, limit)
    return rows


def list_sessions_checked(path: str, limit: int = 100) -> tuple[list[dict], str | None]:
    """Like :func:`list_sessions` but return ``(roots, error)``.

    A missing file means "nothing recorded yet" and is not an error. Anything else that
    cannot be read - a writer holding the lock, a corrupt file - has to be reported by the
    caller: an empty list renders as "this viewer found 0 conversations", which is
    indistinguishable from an empty install and hides a real failure.
    """
    if not os.path.exists(path):
        return [], None
    try:
        con = _connect(path)
    except sqlite3.Error as exc:
        return [], str(exc)
    try:
        # Older recordings (and the fixtures) may predate the turn_id column: read what exists and
        # pass NULL for what does not, rather than 503-ing on a database that is merely old.
        columns = {row[1] for row in con.execute("PRAGMA table_info(events)")}
        turn_column = "turn_id" if "turn_id" in columns else "NULL AS turn_id"
        rows = con.execute(
            "SELECT rowid, kind, session_id, parent_session_id, status, attrs, ts, "
            f"{turn_column} FROM events ORDER BY rowid ASC"
        ).fetchall()
        purged = _purged_ids(con)
    except sqlite3.Error as exc:
        if _uninitialised(exc):
            return [], None
        return [], str(exc)
    finally:
        con.close()

    sessions: dict[str, dict] = {}
    children: set[str] = set()
    # child session id -> parent session id (first relation wins)
    parent_of: dict[str, str] = {}

    for _rowid, kind, session_id, parent_session_id, status, raw_attrs, ts, turn_id in rows:
        if session_id is None:
            continue
        if session_id in purged or (parent_session_id and parent_session_id in purged):
            # Deleted or archived in Hermes: an archived chat's rows are still here, and a
            # helper of a deleted one may have written a row after the purge.
            continue
        session = sessions.get(session_id)
        if session is None:
            session = {
                "id": session_id,
                "first_ts": ts,
                "last_ts": ts,
                "events": 0,
                "model": None,
                "status": "ok",
                "_has_end": False,
                "_has_error": False,
                "calls": 0,
                "cached": 0.0,
                "fresh": 0.0,
                "output": 0.0,
                "prompt_max": 0.0,
                "prompt_now": 0.0,
                "tools": 0,
                "mcp_calls": 0,
                "skills": 0,
                "aux_calls": 0,
                "subagents": 0,
                "compactions": 0,
                # When Hermes last compacted this chat, from the recorder's own evidence: a
                # compaction is an auxiliary call with aux_task == "compression". Knowing the
                # time matters because the recorded prompt only drops at the *next* model call,
                # so between the two the last known size is history, not the present.
                "compacted_at": None,
                "_last_prompt": None,
            }
            sessions[session_id] = session

        session["events"] += 1
        if ts is not None:
            if session["first_ts"] is None or ts < session["first_ts"]:
                session["first_ts"] = ts
            if session["last_ts"] is None or ts > session["last_ts"]:
                session["last_ts"] = ts

        # Only these event kinds consult attributes when building the list.
        attrs = _parse_attrs(raw_attrs) if kind in (
            "subagent.start",
            "llm.request",
            "llm.response",
            "aux.request",
            "aux.response",
            "tool.end",
            "skill.event",
            "session.start",
        ) else {}

        if parent_session_id:
            children.add(session_id)
            parent_of.setdefault(session_id, parent_session_id)
        if kind == "subagent.start":
            child = attrs.get("child_session_id")
            if child:
                children.add(child)
                parent_of.setdefault(child, session_id)

        if kind in ("llm.request", "session.start"):
            model = attrs.get("model")
            if model:
                session["model"] = model
        if kind == "llm.request":
            # A new *turn* starts: failures before it belong to earlier turns, so they no longer
            # brand the chat. Keyed on the turn, not on every model call — a tool error earlier in
            # the same turn must survive the next model call, or the chat list says "finished"
            # while the chat's own headline still counts the failure.
            turn = turn_id or attrs.get("turn_id")
            # No turn id recorded (older events, some harnesses): a model call is the only boundary
            # there is, so fall back to the previous behaviour rather than never clearing at all.
            if turn is None or turn != session.get("_turn"):
                session["_has_error"] = False
                session["_turn"] = turn

        if kind == "session.end":
            session["_has_end"] = True
        if kind == "llm.error" or status == "error":
            session["_has_error"] = True

        # Usage and activity counts feed the token view's chat list. Prompt size is
        # tracked in ingest order, which is time order, so a drop is a compaction.
        if kind in ("llm.response", "aux.response"):
            # A successful answer clears a failure that was retried: the turn went on and finished,
            # which is what the reader is asking about when they look at the verdict.
            session["_has_error"] = False
            cached, fresh, output, prompt = _usage_numbers(attrs.get("usage"))
            session["calls"] += 1
            if kind == "aux.response":
                session["aux_calls"] += 1
                if attrs.get("aux_task") == "compression":
                    session["compactions"] += 1
                    session["compacted_at"] = ts
            session["cached"] += cached
            session["fresh"] += fresh
            session["output"] += output
            # Only the chat's own calls carry the conversation context. Background
            # calls (titles, approval, vision) send a few hundred tokens and would
            # look like a compaction every time they run.
            if prompt > 0 and kind == "llm.response":
                if prompt > session["prompt_max"]:
                    session["prompt_max"] = prompt
                # The context as it stands now: after a compaction this falls, which is
                # what the next message actually pays for. Peak alone never comes down.
                session["prompt_now"] = prompt
                last = session["_last_prompt"]
                if (
                    last is not None
                    and last - prompt > COMPACTION_MIN_DROP
                    and prompt < last * (1.0 - COMPACTION_MIN_RATIO)
                    and session["compacted_at"] is None
                ):
                    # Fallback for records written before compactions were labelled.
                    session["compactions"] += 1
                session["_last_prompt"] = prompt
        elif kind == "tool.end":
            session["tools"] += 1
            if attrs.get("mcp_server"):
                session["mcp_calls"] += 1
        elif kind == "skill.event":
            session["skills"] += 1
        elif kind == "subagent.start":
            session["subagents"] += 1

    # Attribute each helper (child) session's events to its ultimate root so the
    # session list shows the full run, matching /api/v1/events for that root.
    root_of_child: dict[str, str] = {}
    for child_id, child in list(sessions.items()):
        if child_id not in children:
            continue
        seen: set[str] = {child_id}
        parent = parent_of.get(child_id)
        while parent is not None and parent in children and parent not in seen:
            seen.add(parent)
            parent = parent_of.get(parent)
        root = sessions.get(parent) if parent is not None else None
        if root is None or root is child:
            continue
        root_of_child[child_id] = parent
        root["events"] += child["events"]
        if child["first_ts"] is not None and (
            root["first_ts"] is None or child["first_ts"] < root["first_ts"]
        ):
            root["first_ts"] = child["first_ts"]
        if child["last_ts"] is not None and (
            root["last_ts"] is None or child["last_ts"] > root["last_ts"]
        ):
            root["last_ts"] = child["last_ts"]
        # A helper's failure is its own row's business. Copying it onto the parent branded a chat
        # for ever for something that happened inside a sub-agent it cannot see or fix.
        if child["_has_error"] and not root["_has_error"]:
            root["_helper_failed"] = True
        for key in (
            "calls",
            "cached",
            "fresh",
            "output",
            "tools",
            "mcp_calls",
            "skills",
            "aux_calls",
            "subagents",
            "compactions",
        ):
            root[key] += child[key]
        if child["prompt_max"] > root["prompt_max"]:
            root["prompt_max"] = child["prompt_max"]
        if root["prompt_now"] <= 0 and child["prompt_now"] > 0:
            root["prompt_now"] = child["prompt_now"]
        child_compacted = child.get("compacted_at")
        if child_compacted and (root["compacted_at"] is None or child_compacted > root["compacted_at"]):
            root["compacted_at"] = child_compacted

    roots: list[dict] = []
    for session_id, session in sessions.items():
        if session_id in children:
            continue
        if session["_has_error"]:
            session["status"] = "error"
        elif not session["_has_end"]:
            session["status"] = "running"
        else:
            session["status"] = "ok"
        session.pop("_has_end", None)
        session.pop("_has_error", None)
        session.pop("_last_prompt", None)
        # Whole numbers read better in the UI than floats.
        for key in ("cached", "fresh", "output", "prompt_max", "prompt_now"):
            session[key] = int(round(session[key]))
        roots.append(session)

    # Gateway-wide markers (omni.dropped) appear in every /events root view,
    # with or without a session id. Rows are already counted under the session
    # that carries them (main loop); every other marker is counted
    # individually for each root, matching /events for that root.
    dropped_sessions = [row[2] for row in rows if row[1] == "omni.dropped"]
    for session_id, session in sessions.items():
        if session_id in children:
            continue
        subtree = {session_id} | {
            child for child, root_id in root_of_child.items() if root_id == session_id
        }
        session["events"] += sum(
            1 for holder in dropped_sessions if holder is None or holder not in subtree
        )

    roots.sort(key=lambda item: (item["last_ts"] or 0), reverse=True)

    if limit is not None and limit >= 0:
        roots = roots[:limit]
    return roots, None


def _descendant_ids(con: sqlite3.Connection, root: str) -> set[str]:
    seen: set[str] = {root}
    frontier: set[str] = {root}
    while frontier:
        ids = list(frontier)
        placeholders = ", ".join("?" for _ in ids)
        query_parents = (
            "SELECT DISTINCT session_id FROM events "
            f"WHERE parent_session_id IN ({placeholders}) "
            "AND session_id IS NOT NULL"
        )
        query_subagents = (
            "SELECT DISTINCT json_extract(attrs, '$.child_session_id') "
            "FROM events WHERE kind = 'subagent.start' "
            f"AND session_id IN ({placeholders})"
        )
        found: set[str] = set()
        for (child,) in con.execute(query_parents, ids):
            if child:
                found.add(child)
        for (child,) in con.execute(query_subagents, ids):
            if child:
                found.add(child)
        frontier = found - seen
        seen |= frontier
    return seen


def events_for_root(
    path: str,
    root: str | None,
    after: int = 0,
    limit: int = 1000,
    before: int | None = None,
    tail: bool = False,
) -> list[dict]:
    """Return events for *root* plus all descendants, ascending rowid."""
    rows, _error = events_for_root_checked(path, root, after, limit, before, tail)
    return rows


def events_for_root_checked(
    path: str,
    root: str | None,
    after: int = 0,
    limit: int = 1000,
    before: int | None = None,
    tail: bool = False,
) -> tuple[list[dict], str | None]:
    """Like :func:`events_for_root` but return ``(rows, error)``.

    ``error`` is ``None`` on success, otherwise a short description of the
    sqlite failure (missing/unreadable DB, bad schema, ...). Callers that must
    distinguish "no new events" from "database unavailable" use this variant;
    the plain version keeps its silent ``[]`` behaviour for the HTTP endpoint.
    """
    if not root:
        return [], None
    try:
        after_rowid = int(after or 0)
    except (TypeError, ValueError):
        after_rowid = 0

    try:
        con = _connect(path)
    except sqlite3.Error as exc:
        return [], str(exc)
    try:
        ids = _descendant_ids(con, root)
        purged = _purged_ids(con)
        if root in purged:
            # A deleted chat has no steps left to show, whatever rows still point at it.
            ids = set()
        else:
            ids -= purged
        if not ids:
            return [], None
        placeholders = ", ".join("?" for _ in ids)
        sql = (
            f"SELECT {', '.join(_EVENT_COLUMNS)} FROM events "
            f"WHERE (session_id IN ({placeholders}) OR kind = 'omni.dropped') AND rowid > ? "
        )
        # omni.dropped markers are gateway-wide (no session): show them in every view so losses stay visible.
        params: list[Any] = list(ids) + [after_rowid]
        if before is not None:
            sql += " AND rowid < ?"
            params.append(int(before))
        sql += " ORDER BY rowid DESC" if tail or before is not None else " ORDER BY rowid ASC"
        if limit is not None and limit >= 0:
            sql += " LIMIT ?"
            params.append(int(limit))
        rows = con.execute(sql, params).fetchall()
    except sqlite3.Error as exc:
        return [], str(exc)
    finally:
        con.close()

    if tail or before is not None:
        rows.reverse()
    return [_row_to_dict(row) for row in rows], None


def events_for_sessions(
    path: str,
    session_ids: list[str] | tuple[str, ...] | set[str],
    before_or_equal: int,
    limit: int = 1000,
    after: int = 0,
) -> list[dict]:
    """Backfill rows for the given sessions. Unreadable DB -> ``[]``."""
    rows, _error = events_for_sessions_checked(path, session_ids, before_or_equal, limit, after)
    return rows


def events_for_sessions_checked(
    path: str,
    session_ids: list[str] | tuple[str, ...] | set[str],
    before_or_equal: int,
    limit: int = 1000,
    after: int = 0,
) -> tuple[list[dict], str | None]:
    """Return events for exactly the given session ids with ``after < rowid <= before_or_equal``.

    Used as a one-off backfill: when a descendant session only becomes visible
    later (its linking row is written after the session's own events), the live
    feed fetches the already-passed rows here. Ascending rowid, capped at *limit*;
    pass the last rowid received as *after* to read the next page.
    """
    ids = [sid for sid in dict.fromkeys(session_ids) if sid]
    if not ids:
        return [], None
    try:
        ceiling = int(before_or_equal)
        floor = int(after)
    except (TypeError, ValueError):
        return [], None
    if ceiling < 0 or floor < 0:
        return [], None

    try:
        con = _connect(path)
    except sqlite3.Error as exc:
        return [], str(exc)
    try:
        purged = _purged_ids(con)
        ids = [sid for sid in ids if sid not in purged]
        if not ids:
            return [], None
        placeholders = ", ".join("?" for _ in ids)
        sql = (
            f"SELECT {', '.join(_EVENT_COLUMNS)} FROM events "
            f"WHERE session_id IN ({placeholders}) AND rowid <= ? AND rowid > ? "
            "ORDER BY rowid ASC"
        )
        params: list[Any] = [*ids, ceiling, floor]
        if limit is not None and limit >= 0:
            sql += " LIMIT ?"
            params.append(int(limit))
        rows = con.execute(sql, params).fetchall()
    except sqlite3.Error as exc:
        return [], str(exc)
    finally:
        con.close()
    return [_row_to_dict(row) for row in rows], None


class Database:
    """Thin convenience wrapper binding a DB path to the read-only functions."""

    def __init__(self, path: str) -> None:
        self.path = path

    def health(self) -> dict:
        return health(self.path)

    def list_sessions(self, limit: int = 100) -> list[dict]:
        return list_sessions(self.path, limit)

    def events_for_root(
        self, root: str | None, after: int = 0, limit: int = 1000
    ) -> list[dict]:
        return events_for_root(self.path, root, after, limit)

    def events_for_sessions(
        self, session_ids, before_or_equal: int, limit: int = 1000
    ) -> list[dict]:
        return events_for_sessions(self.path, session_ids, before_or_equal, limit)


DB = Database
