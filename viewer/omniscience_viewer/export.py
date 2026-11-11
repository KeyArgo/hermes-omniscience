"""Local read-only viewer export helpers for AI-agent activity logs."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
from datetime import datetime
from statistics import median
from typing import Any, Optional

STEP_COLUMNS = [
    "chat_id",
    "helper_of",
    "message_number",
    "step_number",
    "kind",
    "started_at",
    "duration_s",
    "first_word_wait_s",
    "model_requested",
    "model_answered",
    "provider",
    "fell_back",
    "tokens_new_input",
    "tokens_cached_input",
    "tokens_output",
    "tokens_reasoning",
    "output_tokens_per_s",
    "tool_name",
    "mcp_server",
    "background_task",
    "status",
    "error_type",
    "http_status",
    "retry",
    "imported",
]

CHAT_COLUMNS = [
    "chat_id",
    "platform",
    "started_at",
    "ended_at",
    "duration_s",
    "messages",
    "model_calls",
    "tool_runs",
    "background_calls",
    "helpers",
    "failures",
    "rate_limits",
    "fallbacks",
    "tokens_new_input",
    "tokens_cached_input",
    "tokens_output",
    "cache_share_pct",
    "median_first_word_wait_s",
    "longest_step_s",
    "most_used_tool",
    "models_used",
    "imported",
]

MODEL_COLUMNS = [
    "model",
    "provider",
    "calls",
    "failed_calls",
    "rate_limited_calls",
    "tokens_new_input",
    "tokens_cached_input",
    "tokens_output",
    "median_duration_s",
    "median_first_word_wait_s",
    "median_output_tokens_per_s",
    "as_fallback_calls",
]

_BOM = "\ufeff"


def _open_ro(db_path: str) -> sqlite3.Connection:
    uri = f"file:{db_path}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def _parse_attrs(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _iso_local(ts: Optional[float]) -> str:
    if ts is None:
        return ""
    try:
        dt = datetime.fromtimestamp(float(ts))
    except (ValueError, OSError, OverflowError):
        return ""
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _fmt_num(value: Optional[float], decimals: int) -> str:
    if value is None:
        return ""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return ""
    if v != v:  # NaN
        return ""
    return f"{v:.{decimals}f}"


def _fmt_int(value: Optional[float]) -> str:
    if value is None:
        return ""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return ""
    if v != v:
        return ""
    return str(int(v))


def _yes_no(value: Any) -> str:
    if value is True:
        return "yes"
    if value is False:
        return "no"
    if isinstance(value, (int, float)):
        return "yes" if value else "no"
    if isinstance(value, str):
        return "yes" if value.lower() in ("true", "yes", "1") else "no"
    return "no"


def _median(values: list) -> Optional[float]:
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    try:
        return float(median(vals))
    except (TypeError, ValueError):
        return None


def _defuse(value) -> str:
    """Stop a cell from being evaluated as a spreadsheet formula.

    Excel and LibreOffice evaluate a cell that begins with =, +, -, @, a tab or a CR even when
    the CSV writer has quoted it, so a recorded tool / model / provider name (an MCP server
    names its own tools; a provider names its own model) could run a formula when the user
    opens the export. A leading apostrophe makes the cell plain text.
    """
    text = "" if value is None else str(value)
    if not text:
        return text
    if text[0] in ("\t", "\r"):
        return "'" + text
    if text[0] in ("=", "+", "-", "@"):
        try:
            float(text)
        except ValueError:
            return "'" + text
    return text


def _csv_text(columns: list, rows: list) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow([_defuse(c) for c in columns])
    for row in rows:
        writer.writerow([_defuse(c) for c in row])
    return _BOM + buf.getvalue()


def _load_events(db_path: str) -> list:
    """Return all events as dicts. Empty list on any DB problem."""
    try:
        conn = _open_ro(db_path)
    except sqlite3.Error:
        return []
    try:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            "SELECT rowid, event_id, schema, boot_id, seq, ts, kind, "
            "session_id, parent_session_id, turn_id, api_request_id, "
            "tool_call_id, subagent_id, status, attrs FROM events ORDER BY rowid"
        )
        rows = cur.fetchall()
    except sqlite3.Error:
        return []
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass

    events = []
    for r in rows:
        try:
            attrs = _parse_attrs(r["attrs"])
        except Exception:
            attrs = {}
        events.append(
            {
                "rowid": r["rowid"],
                "event_id": r["event_id"],
                "schema": r["schema"],
                "boot_id": r["boot_id"],
                "seq": r["seq"],
                "ts": r["ts"],
                "kind": r["kind"],
                "session_id": r["session_id"],
                "parent_session_id": r["parent_session_id"],
                "turn_id": r["turn_id"],
                "api_request_id": r["api_request_id"],
                "tool_call_id": r["tool_call_id"],
                "subagent_id": r["subagent_id"],
                "status": r["status"],
                "attrs": attrs,
            }
        )
    return events


def _build_session_tree(events: list) -> dict:
    """Map session_id -> parent_session_id, and children lists."""
    parent_of: dict = {}
    children: dict = {}
    for ev in events:
        sid = ev["session_id"]
        if sid is None:
            continue
        pid = ev["parent_session_id"]
        if sid not in parent_of:
            parent_of[sid] = pid
        if pid is not None:
            children.setdefault(pid, []).append(sid)
    return {"parent_of": parent_of, "children": children}


def _descendants(session_id: str, tree: dict) -> set:
    """All sessions that are helpers of session_id (recursive)."""
    result = set()
    stack = [session_id]
    children = tree["children"]
    while stack:
        cur = stack.pop()
        for child in children.get(cur, []):
            if child not in result:
                result.add(child)
                stack.append(child)
    return result


def _root_chats(tree: dict) -> list:
    """Sessions with no parent (root chats)."""
    parent_of = tree["parent_of"]
    return [sid for sid, pid in parent_of.items() if pid is None]


def _sessions_in_scope(events: list, tree: dict, root: Optional[str]) -> set:
    if root is None:
        return {ev["session_id"] for ev in events if ev["session_id"] is not None}
    scope = {root}
    scope |= _descendants(root, tree)
    return scope


def _pair_llm(events: list) -> dict:
    """Pair llm.request with llm.response/llm.error by api_request_id.

    A single api_request_id represents ONE logical model call, even if it was
    retried (multiple llm.request events with increasing retry_count, and/or
    intermediate llm.error events). We collapse all events sharing the same
    api_request_id into one logical call record.

    Returns dict keyed by api_request_id -> {
        request: the latest llm.request (highest retry_count),
        response: the successful llm.response if any,
        error: the last llm.error if no response,
        retries: list of retry_count values seen,
        rate_limited: bool,
        http_status: last error status code,
        error_type: last error type,
    }
    """
    by_arid: dict = {}

    for ev in events:
        kind = ev["kind"]
        arid = ev["api_request_id"]
        if arid is None:
            continue
        if kind not in ("llm.request", "llm.response", "llm.error"):
            continue
        rec = by_arid.setdefault(
            arid,
            {
                "request": None,
                "response": None,
                "error": None,
                "retries": [],
                "rate_limited": False,
                "http_status": "",
                "error_type": "",
                "first_ts": None,
            },
        )
        attrs = ev["attrs"]
        if rec["first_ts"] is None and ev["ts"] is not None:
            rec["first_ts"] = ev["ts"]

        if kind == "llm.request":
            rc = attrs.get("retry_count")
            try:
                rc_int = int(rc) if rc is not None else 0
            except (TypeError, ValueError):
                rc_int = 0
            rec["retries"].append(rc_int)
            # Keep the request with the highest retry_count as the "current" one.
            prev = rec["request"]
            if prev is None:
                rec["request"] = ev
            else:
                prev_rc = prev["attrs"].get("retry_count")
                try:
                    prev_rc_int = int(prev_rc) if prev_rc is not None else 0
                except (TypeError, ValueError):
                    prev_rc_int = 0
                if rc_int >= prev_rc_int:
                    rec["request"] = ev
        elif kind == "llm.response":
            rec["response"] = ev
        elif kind == "llm.error":
            rec["error"] = ev
            reason = attrs.get("reason", "") or ""
            etype = attrs.get("error_type", "") or ""
            if reason == "rate_limit" or etype == "rate_limit":
                rec["rate_limited"] = True
            sc = attrs.get("status_code")
            if sc is not None:
                rec["http_status"] = str(sc)
            if etype:
                rec["error_type"] = etype
            elif reason:
                rec["error_type"] = reason

    return by_arid


def _token_math(attrs: dict) -> tuple:
    """Return (new_input, cached_input, output, reasoning) from usage dict."""
    usage = attrs.get("usage")
    if not isinstance(usage, dict):
        usage = {}
    prompt_tokens = usage.get("prompt_tokens")
    input_tokens = usage.get("input_tokens")
    cache_read = usage.get("cache_read_tokens")
    output = usage.get("output_tokens")
    reasoning = usage.get("reasoning_tokens")

    new_input = None
    cached_input = None
    if prompt_tokens is not None:
        try:
            pt = float(prompt_tokens)
            cr = float(cache_read) if cache_read is not None else 0.0
            new_input = max(0.0, pt - cr)
            cached_input = cr
        except (TypeError, ValueError):
            new_input = None
            cached_input = None
    elif input_tokens is not None:
        try:
            new_input = float(input_tokens)
            cached_input = 0.0
        except (TypeError, ValueError):
            new_input = None
            cached_input = None

    return new_input, cached_input, output, reasoning


def _output_tokens_per_s(output, duration, ttfb) -> Optional[float]:
    if output is None or duration is None or ttfb is None:
        return None
    try:
        o = float(output)
        d = float(duration)
        t = float(ttfb)
    except (TypeError, ValueError):
        return None
    if o <= 0 or d <= 0 or t <= 0:
        return None
    denom = d - t
    if denom <= 0:
        return None
    return o / denom


def _turn_order(events: list, session_id: str) -> dict:
    """Map turn_id -> 1-based message number within a session, based on turn.start ts."""
    starts = [ev for ev in events if ev["kind"] == "turn.start" and ev["session_id"] == session_id]
    starts.sort(key=lambda e: (e["ts"] if e["ts"] is not None else 0, e["rowid"]))
    order = {}
    for idx, ev in enumerate(starts, start=1):
        tid = ev["turn_id"]
        if tid is not None:
            order[tid] = idx
    return order


def _root_of(session_id: str, parent_of: dict) -> Optional[str]:
    cur = session_id
    seen = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        p = parent_of.get(cur)
        if p is None:
            return cur
        cur = p
    return session_id


def _make_row(**kwargs) -> dict:
    row = {col: "" for col in STEP_COLUMNS}
    row.update(kwargs)
    return row


def export_steps(db_path: str, root: Optional[str]) -> str:
    events = _load_events(db_path)
    if not events:
        return _csv_text(STEP_COLUMNS, [])

    tree = _build_session_tree(events)
    scope = _sessions_in_scope(events, tree, root)
    parent_of = tree["parent_of"]

    turn_orders: dict = {}
    for sid in scope:
        turn_orders[sid] = _turn_order(events, sid)

    paired = _pair_llm(events)

    rows: list = []

    session_events: dict = {}
    for ev in events:
        sid = ev["session_id"]
        if sid is None or sid not in scope:
            continue
        session_events.setdefault(sid, []).append(ev)

    for sid, sev in session_events.items():
        rchat = _root_of(sid, parent_of)
        if rchat is None:
            continue
        helper_of = "" if sid == rchat else rchat
        torder = turn_orders.get(sid, {})

        local_paired = {}
        for arid, val in paired.items():
            req = val["request"]
            resp = val["response"]
            err = val["error"]
            owner = None
            for e in (req, resp, err):
                if e is not None and e["session_id"] == sid:
                    owner = sid
                    break
            if owner == sid:
                local_paired[arid] = val

        # Model calls: one row per api_request_id (logical call).
        for arid, val in local_paired.items():
            req = val["request"]
            resp = val["response"]
            err = val["error"]

            started_ev = req or resp or err
            if started_ev is None:
                continue
            # A call that only ever errored (an llm.error with no matching response) is emitted
            # once below, as kind="error", by the unanswered-errors pass. Emitting it here as a
            # model_call too produced two rows for one failure and inflated the step count.
            if resp is None and err is not None:
                continue
            started_ts = val["first_ts"]
            if started_ts is None:
                started_ts = started_ev["ts"]

            turn_id = None
            for e in (req, resp, err):
                if e is not None and e["turn_id"] is not None:
                    turn_id = e["turn_id"]
                    break
            msg_num = torder.get(turn_id, "") if turn_id is not None else ""

            model_requested = ""
            provider = ""
            retry = ""
            if req is not None:
                ra = req["attrs"]
                model_requested = ra.get("model", "") or ""
                provider = ra.get("provider", "") or ""
                rc = ra.get("retry_count")
                if rc is not None:
                    retry = str(rc)

            model_answered = ""
            duration_s = None
            ttfb = None
            status = "running"
            error_type = ""
            http_status = ""
            new_input = None
            cached_input = None
            output = None
            reasoning = None
            imported = False

            if resp is not None:
                ra = resp["attrs"]
                model_answered = ra.get("response_model", "") or ra.get("model", "") or ""
                duration_s = ra.get("duration_s")
                ttfb = ra.get("ttfb_s")
                status = "ok"
                ni, ci, out, rea = _token_math(ra)
                new_input = ni
                cached_input = ci
                output = out
                reasoning = rea
                if ra.get("imported") is True:
                    imported = True
                if not provider:
                    provider = ra.get("provider", "") or ""
                # If there was a rate-limit error before the successful retry,
                # surface that info on the row.
                if val["rate_limited"]:
                    error_type = "rate_limit"
                    http_status = val["http_status"]
            elif err is not None:
                ea = err["attrs"]
                duration_s = ea.get("duration_s")
                error_type = ea.get("error_type", "") or ea.get("reason", "") or ""
                sc = ea.get("status_code")
                if sc is not None:
                    http_status = str(sc)
                status = "error"
                if ea.get("imported") is True:
                    imported = True
                if not provider:
                    provider = ea.get("provider", "") or ""
            else:
                if req is not None and req["attrs"].get("imported") is True:
                    imported = True

            fell_back = "no"
            if model_requested and model_answered and model_requested != model_answered:
                fell_back = "yes"

            otps = _output_tokens_per_s(output, duration_s, ttfb)

            rows.append(
                _make_row(
                    chat_id=rchat,
                    helper_of=helper_of,
                    message_number=msg_num,
                    kind="model_call",
                    started_at=_iso_local(started_ts),
                    duration_s=_fmt_num(duration_s, 3),
                    first_word_wait_s=_fmt_num(ttfb, 3),
                    model_requested=model_requested,
                    model_answered=model_answered,
                    provider=provider,
                    fell_back=fell_back,
                    tokens_new_input=_fmt_int(new_input),
                    tokens_cached_input=_fmt_int(cached_input),
                    tokens_output=_fmt_int(output),
                    tokens_reasoning=_fmt_int(reasoning),
                    output_tokens_per_s=_fmt_num(otps, 1),
                    status=status,
                    error_type=error_type,
                    http_status=http_status,
                    retry=retry,
                    imported=_yes_no(imported),
                    _sort=(started_ts if started_ts is not None else 0, started_ev["rowid"]),
                )
            )

        # Tool runs
        for ev in sev:
            if ev["kind"] != "tool.end":
                continue
            attrs = ev["attrs"]
            started_ts = ev["ts"]
            turn_id = ev["turn_id"]
            msg_num = torder.get(turn_id, "") if turn_id is not None else ""
            tool_name = attrs.get("tool_name", "") or ""
            mcp_server = attrs.get("mcp_server", "") or ""
            duration_ms = attrs.get("duration_ms")
            duration_s = None
            if duration_ms is not None:
                try:
                    duration_s = float(duration_ms) / 1000.0
                except (TypeError, ValueError):
                    duration_s = None
            status = ev["status"] or "ok"
            error_type = attrs.get("error_type", "") or ""
            imported = attrs.get("imported") is True

            rows.append(
                _make_row(
                    chat_id=rchat,
                    helper_of=helper_of,
                    message_number=msg_num,
                    kind="tool",
                    started_at=_iso_local(started_ts),
                    duration_s=_fmt_num(duration_s, 3),
                    tool_name=tool_name,
                    mcp_server=mcp_server,
                    status=status,
                    error_type=error_type,
                    imported=_yes_no(imported),
                    _sort=(started_ts if started_ts is not None else 0, ev["rowid"]),
                )
            )

        # Background calls
        aux_requests = [e for e in sev if e["kind"] == "aux.request"]
        aux_responses = [e for e in sev if e["kind"] == "aux.response"]

        resp_by_sub: dict = {}
        for e in aux_responses:
            sid_key = e["subagent_id"]
            if sid_key is not None:
                resp_by_sub.setdefault(sid_key, []).append(e)

        used_resp = set()
        for req in aux_requests:
            attrs = req["attrs"]
            started_ts = req["ts"]
            turn_id = req["turn_id"]
            msg_num = torder.get(turn_id, "") if turn_id is not None else ""
            aux_task = attrs.get("aux_task", "") or ""
            model_requested = attrs.get("model", "") or ""
            provider = attrs.get("provider", "") or ""

            resp = None
            sub = req["subagent_id"]
            if sub is not None and sub in resp_by_sub and resp_by_sub[sub]:
                resp = resp_by_sub[sub].pop(0)
                # Mark it consumed. Without this, the fallback below (which skips only ids in
                # used_resp) could hand the same response to a later request that has no
                # subagent, so two background calls claimed one response and the second one
                # reported tokens it never spent.
                used_resp.add(id(resp))
            elif aux_responses:
                for r in aux_responses:
                    if id(r) not in used_resp:
                        resp = r
                        used_resp.add(id(r))
                        break

            model_answered = ""
            duration_s = None
            ttfb = None
            status = "running"
            error_type = ""
            new_input = None
            cached_input = None
            output = None
            reasoning = None
            imported = attrs.get("imported") is True

            if resp is not None:
                ra = resp["attrs"]
                model_answered = ra.get("response_model", "") or ra.get("model", "") or ""
                duration_s = ra.get("duration_s")
                ni, ci, out, rea = _token_math(ra)
                new_input = ni
                cached_input = ci
                output = out
                reasoning = rea
                error_type = ra.get("error_type", "") or ""
                status = "error" if error_type else "ok"
                if ra.get("imported") is True:
                    imported = True
            else:
                if attrs.get("error_type"):
                    status = "error"
                    error_type = attrs.get("error_type", "") or ""

            otps = _output_tokens_per_s(output, duration_s, ttfb)

            rows.append(
                _make_row(
                    chat_id=rchat,
                    helper_of=helper_of,
                    message_number=msg_num,
                    kind="background_call",
                    started_at=_iso_local(started_ts),
                    duration_s=_fmt_num(duration_s, 3),
                    first_word_wait_s=_fmt_num(ttfb, 3),
                    model_requested=model_requested,
                    model_answered=model_answered,
                    provider=provider,
                    tokens_new_input=_fmt_int(new_input),
                    tokens_cached_input=_fmt_int(cached_input),
                    tokens_output=_fmt_int(output),
                    tokens_reasoning=_fmt_int(reasoning),
                    output_tokens_per_s=_fmt_num(otps, 1),
                    background_task=aux_task,
                    status=status,
                    error_type=error_type,
                    imported=_yes_no(imported),
                    _sort=(started_ts if started_ts is not None else 0, req["rowid"]),
                )
            )

        # Helper agents. A helper's final status and run duration are known only when it
        # finishes, so the recorder puts them on subagent.stop (fired on this, the parent,
        # thread), never on subagent.start. Index the stops by the child session they report.
        helper_stops: dict = {}
        for ev in sev:
            if ev["kind"] == "subagent.stop":
                child = ev["attrs"].get("child_session_id")
                if child:
                    helper_stops[child] = ev["attrs"]
        for ev in sev:
            if ev["kind"] != "subagent.start":
                continue
            attrs = ev["attrs"]
            stop = helper_stops.get(attrs.get("child_session_id"), {})
            started_ts = ev["ts"]
            turn_id = ev["turn_id"]
            msg_num = torder.get(turn_id, "") if turn_id is not None else ""
            child_status = stop.get("child_status") or attrs.get("child_status", "") or ""
            duration_ms = stop.get("duration_ms")
            if duration_ms is None:
                duration_ms = attrs.get("duration_ms")
            duration_s = None
            if duration_ms is not None:
                try:
                    duration_s = float(duration_ms) / 1000.0
                except (TypeError, ValueError):
                    duration_s = None
            imported = attrs.get("imported") is True
            status = "ok" if child_status in ("completed", "ok", "") else "error"

            rows.append(
                _make_row(
                    chat_id=rchat,
                    helper_of=helper_of,
                    message_number=msg_num,
                    kind="helper",
                    started_at=_iso_local(started_ts),
                    duration_s=_fmt_num(duration_s, 3),
                    status=status,
                    imported=_yes_no(imported),
                    _sort=(started_ts if started_ts is not None else 0, ev["rowid"]),
                )
            )

        # Unanswered errors: only when there is NO response for the api_request_id.
        for arid, val in local_paired.items():
            if val["response"] is None and val["error"] is not None:
                err = val["error"]
                attrs = err["attrs"]
                started_ts = val["first_ts"]
                if started_ts is None:
                    started_ts = err["ts"]
                turn_id = err["turn_id"]
                msg_num = torder.get(turn_id, "") if turn_id is not None else ""
                duration_s = attrs.get("duration_s")
                error_type = attrs.get("error_type", "") or attrs.get("reason", "") or ""
                sc = attrs.get("status_code")
                http_status = str(sc) if sc is not None else ""
                imported = attrs.get("imported") is True
                provider = attrs.get("provider", "") or ""
                req = val["request"]
                model_requested = ""
                retry = ""
                if req is not None:
                    model_requested = req["attrs"].get("model", "") or ""
                    rc = req["attrs"].get("retry_count")
                    if rc is not None:
                        retry = str(rc)
                    if not provider:
                        provider = req["attrs"].get("provider", "") or ""

                rows.append(
                    _make_row(
                        chat_id=rchat,
                        helper_of=helper_of,
                        message_number=msg_num,
                        kind="error",
                        started_at=_iso_local(started_ts),
                        duration_s=_fmt_num(duration_s, 3),
                        model_requested=model_requested,
                        provider=provider,
                        status="error",
                        error_type=error_type,
                        http_status=http_status,
                        retry=retry,
                        imported=_yes_no(imported),
                        _sort=(started_ts if started_ts is not None else 0, err["rowid"]),
                    )
                )

    by_chat: dict = {}
    for r in rows:
        by_chat.setdefault(r["chat_id"], []).append(r)

    for chat_id, chat_rows in by_chat.items():
        chat_rows.sort(key=lambda r: r["_sort"])
        for idx, r in enumerate(chat_rows, start=1):
            r["step_number"] = str(idx)

    final_rows = []
    for r in rows:
        final_rows.append([r[col] for col in STEP_COLUMNS])

    return _csv_text(STEP_COLUMNS, final_rows)


def export_chats(db_path: str) -> str:
    events = _load_events(db_path)
    if not events:
        return _csv_text(CHAT_COLUMNS, [])

    tree = _build_session_tree(events)
    roots = _root_chats(tree)

    def earliest_ts(sid: str) -> float:
        best = None
        for ev in events:
            if ev["session_id"] == sid and ev["ts"] is not None:
                if best is None or ev["ts"] < best:
                    best = ev["ts"]
        return best if best is not None else 0

    roots.sort(key=earliest_ts)

    parent_of = tree["parent_of"]

    rows = []
    for root in roots:
        scope = {root} | _descendants(root, tree)
        sev = [ev for ev in events if ev["session_id"] in scope]

        started_at = ""
        ended_at = ""
        platform = ""
        duration_s = ""
        start_ts = None
        end_ts = None
        imported_any = False

        for ev in sev:
            if ev["session_id"] == root:
                if ev["kind"] == "session.start":
                    attrs = ev["attrs"]
                    platform = attrs.get("platform", "") or ""
                    if ev["ts"] is not None:
                        start_ts = ev["ts"]
                    if attrs.get("imported") is True:
                        imported_any = True
                elif ev["kind"] == "session.end":
                    if ev["ts"] is not None:
                        end_ts = ev["ts"]
                    if ev["attrs"].get("imported") is True:
                        imported_any = True

        if start_ts is not None:
            started_at = _iso_local(start_ts)
        if end_ts is not None:
            ended_at = _iso_local(end_ts)
        if start_ts is not None and end_ts is not None:
            duration_s = _fmt_num(end_ts - start_ts, 3)

        messages = sum(1 for ev in sev if ev["kind"] == "turn.start" and ev["session_id"] == root)

        paired = _pair_llm(sev)
        model_calls = 0
        tool_runs = 0
        background_calls = 0
        helpers = 0
        failures = 0
        rate_limits = 0
        fallbacks = 0
        tokens_new_input = 0.0
        tokens_cached_input = 0.0
        tokens_output = 0.0
        ttfb_values = []
        longest_step = None
        tool_counts: dict = {}
        models_used_set: set = set()

        for arid, val in paired.items():
            req = val["request"]
            resp = val["response"]
            err = val["error"]
            in_scope = False
            for e in (req, resp, err):
                if e is not None and e["session_id"] in scope:
                    in_scope = True
                    break
            if not in_scope:
                continue

            model_calls += 1

            if val["rate_limited"]:
                rate_limits += 1

            if resp is not None:
                ra = resp["attrs"]
                ni, ci, out, _ = _token_math(ra)
                if ni is not None:
                    tokens_new_input += ni
                if ci is not None:
                    tokens_cached_input += ci
                if out is not None:
                    tokens_output += out
                ttfb = ra.get("ttfb_s")
                if ttfb is not None:
                    try:
                        ttfb_values.append(float(ttfb))
                    except (TypeError, ValueError):
                        pass
                dur = ra.get("duration_s")
                if dur is not None:
                    try:
                        d = float(dur)
                        if longest_step is None or d > longest_step:
                            longest_step = d
                    except (TypeError, ValueError):
                        pass
                rm = ra.get("response_model", "") or ra.get("model", "")
                if rm:
                    models_used_set.add(rm)
                if ra.get("imported") is True:
                    imported_any = True
                if req is not None:
                    rq_model = req["attrs"].get("model", "")
                    if rq_model and rm and rq_model != rm:
                        fallbacks += 1
            elif err is not None:
                ea = err["attrs"]
                failures += 1
                if ea.get("imported") is True:
                    imported_any = True
            else:
                if req is not None and req["attrs"].get("imported") is True:
                    imported_any = True

        for ev in sev:
            if ev["kind"] == "tool.end":
                tool_runs += 1
                attrs = ev["attrs"]
                tn = attrs.get("tool_name", "") or ""
                if tn:
                    tool_counts[tn] = tool_counts.get(tn, 0) + 1
                if ev["status"] == "error":
                    failures += 1
                if attrs.get("imported") is True:
                    imported_any = True
                dur_ms = attrs.get("duration_ms")
                if dur_ms is not None:
                    try:
                        d = float(dur_ms) / 1000.0
                        if longest_step is None or d > longest_step:
                            longest_step = d
                    except (TypeError, ValueError):
                        pass

        for ev in sev:
            if ev["kind"] in ("aux.request", "aux.response"):
                if ev["kind"] == "aux.request":
                    background_calls += 1
                if ev["attrs"].get("imported") is True:
                    imported_any = True

        for ev in sev:
            if ev["kind"] == "subagent.start" and ev["session_id"] == root:
                helpers += 1
                if ev["attrs"].get("imported") is True:
                    imported_any = True

        total_input = tokens_new_input + tokens_cached_input
        cache_share_pct = ""
        if total_input > 0:
            cache_share_pct = _fmt_num((tokens_cached_input / total_input) * 100.0, 1)

        median_ttfb = _median(ttfb_values)

        most_used_tool = ""
        if tool_counts:
            most_used_tool = max(tool_counts, key=lambda k: tool_counts[k])

        models_used = ";".join(sorted(models_used_set))

        rows.append(
            [
                root,
                platform,
                started_at,
                ended_at,
                duration_s,
                str(messages),
                str(model_calls),
                str(tool_runs),
                str(background_calls),
                str(helpers),
                str(failures),
                str(rate_limits),
                str(fallbacks),
                _fmt_int(tokens_new_input),
                _fmt_int(tokens_cached_input),
                _fmt_int(tokens_output),
                cache_share_pct,
                _fmt_num(median_ttfb, 3),
                _fmt_num(longest_step, 3),
                most_used_tool,
                models_used,
                _yes_no(imported_any),
            ]
        )

    return _csv_text(CHAT_COLUMNS, rows)


def export_models(db_path: str, root: Optional[str]) -> str:
    events = _load_events(db_path)
    if not events:
        return _csv_text(MODEL_COLUMNS, [])

    tree = _build_session_tree(events)
    scope = _sessions_in_scope(events, tree, root)

    paired = _pair_llm(events)
    # Background calls (titling, compression, ...) also use models: count them per model too.
    aux_as_llm = [
        {
            **ev,
            "kind": "llm." + ev["kind"].split(".", 1)[1],
            # Hermes does not always give background calls a request id; pair them within their turn.
            "api_request_id": ev["api_request_id"] or f"{ev['session_id']}|{ev['turn_id']}|{ev['subagent_id']}",
        }
        for ev in events
        if ev["kind"] in ("aux.request", "aux.response")
    ]
    for arid, val in _pair_llm(aux_as_llm).items():
        paired.setdefault(f"aux:{arid}", val)

    agg: dict = {}

    for arid, val in paired.items():
        req = val["request"]
        resp = val["response"]
        err = val["error"]

        in_scope = False
        for e in (req, resp, err):
            if e is not None and e["session_id"] in scope:
                in_scope = True
                break
        if not in_scope:
            continue

        model_answered = ""
        provider = ""
        if resp is not None:
            ra = resp["attrs"]
            model_answered = ra.get("response_model", "") or ra.get("model", "") or ""
            provider = ra.get("provider", "") or ""
        elif err is not None:
            ea = err["attrs"]
            provider = ea.get("provider", "") or ""
        if req is not None:
            rq = req["attrs"]
            if not provider:
                provider = rq.get("provider", "") or ""

        model_key = model_answered
        if not model_key and req is not None:
            model_key = req["attrs"].get("model", "") or ""

        k = (model_key, provider)
        if k not in agg:
            agg[k] = {
                "calls": 0,
                "failed_calls": 0,
                "rate_limited_calls": 0,
                "tokens_new_input": 0.0,
                "tokens_cached_input": 0.0,
                "tokens_output": 0.0,
                "durations": [],
                "ttfbs": [],
                "otps": [],
                "as_fallback_calls": 0,
            }

        a = agg[k]
        a["calls"] += 1

        if val["rate_limited"]:
            a["rate_limited_calls"] += 1

        if resp is not None:
            ra = resp["attrs"]
            ni, ci, out, _ = _token_math(ra)
            if ni is not None:
                a["tokens_new_input"] += ni
            if ci is not None:
                a["tokens_cached_input"] += ci
            if out is not None:
                a["tokens_output"] += out
            dur = ra.get("duration_s")
            if dur is not None:
                try:
                    a["durations"].append(float(dur))
                except (TypeError, ValueError):
                    pass
            ttfb = ra.get("ttfb_s")
            if ttfb is not None:
                try:
                    a["ttfbs"].append(float(ttfb))
                except (TypeError, ValueError):
                    pass
            otps = _output_tokens_per_s(out, dur, ttfb)
            if otps is not None:
                a["otps"].append(otps)
            if req is not None:
                rq_model = req["attrs"].get("model", "")
                rm = ra.get("response_model", "") or ra.get("model", "")
                if rq_model and rm and rq_model != rm:
                    a["as_fallback_calls"] += 1
        elif err is not None:
            a["failed_calls"] += 1
            dur = err["attrs"].get("duration_s")
            if dur is not None:
                try:
                    a["durations"].append(float(dur))
                except (TypeError, ValueError):
                    pass

    rows = []
    for (model, provider), a in sorted(agg.items()):
        rows.append(
            [
                model,
                provider,
                str(a["calls"]),
                str(a["failed_calls"]),
                str(a["rate_limited_calls"]),
                _fmt_int(a["tokens_new_input"]),
                _fmt_int(a["tokens_cached_input"]),
                _fmt_int(a["tokens_output"]),
                _fmt_num(_median(a["durations"]), 3),
                _fmt_num(_median(a["ttfbs"]), 3),
                _fmt_num(_median(a["otps"]), 1),
                str(a["as_fallback_calls"]),
            ]
        )

    return _csv_text(MODEL_COLUMNS, rows)
