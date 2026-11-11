"""Read-only, metadata-only triage for the invoking Hermes session."""
from __future__ import annotations

import json
import os
import sqlite3
import time


def _fmt_int(n):
    return f'{n:,}'


def _parse_attrs(raw):
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def _get_int(d, key):
    v = d.get(key)
    return v if isinstance(v, int) else None


def _get_float(d, key):
    v = d.get(key)
    return v if isinstance(v, (int, float)) else None


def _compute_data(db_path, session_id, state_db_path):
    """Compute all data needed for both light and full reports."""
    if not session_id or not isinstance(session_id, str):
        return {'error': 'Omniscience could not identify this chat. No other session was inspected.'}
    if not os.path.isfile(db_path):
        return {'error': 'Omniscience could not find its event database for this chat.'}

    try:
        con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=2)
        try:
            rows = con.execute(
                'SELECT event_id, kind, status, attrs FROM events WHERE session_id = ? ORDER BY rowid DESC LIMIT 501',
                (session_id,),
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return {'error': 'Omniscience could not read its event database. No diagnosis was made.'}

    if not rows:
        return {'error': ('No recorded events were found for this chat. The recorder may be delayed, '
                          'the session may not be recorded, or the viewer may use a different database.')}

    partial = len(rows) > 500
    rows = rows[:500]
    tools = sum(kind == 'tool.end' for _, kind, _, _ in rows)
    failures = []
    for event_id, kind, status, raw_attrs in rows:
        if kind != 'llm.error' and not (kind == 'tool.end' and status == 'error'):
            continue
        attrs = _parse_attrs(raw_attrs)
        tool = attrs.get('tool_name') if isinstance(attrs, dict) else None
        label = f'{tool} tool' if kind == 'tool.end' and isinstance(tool, str) and tool else ('tool' if kind == 'tool.end' else 'model call')
        failures.append((label, event_id))

    # Chat size data
    turn_starts = []
    llm_requests = []
    llm_responses = []

    for event_id, kind, status, raw_attrs in rows:
        attrs = _parse_attrs(raw_attrs)
        if kind == 'turn.start':
            turn_starts.append(event_id)
        elif kind == 'llm.request':
            llm_requests.append(attrs)
        elif kind == 'llm.response':
            llm_responses.append(attrs)

    n_user_msgs = len(turn_starts)
    n_model_calls = len(llm_requests)

    latest_req = llm_requests[0] if llm_requests else None
    latest_msg_count = _get_int(latest_req, 'message_count') if latest_req else None
    latest_tool_count = _get_int(latest_req, 'tool_count') if latest_req else None
    latest_model = latest_req.get('model') if latest_req else None
    latest_provider = latest_req.get('provider') if latest_req else None

    latest_resp = llm_responses[0] if llm_responses else None
    latest_usage = latest_resp.get('usage') if latest_resp else None
    if not isinstance(latest_usage, dict):
        latest_usage = None

    latest_prompt_tokens = _get_int(latest_usage, 'prompt_tokens') if latest_usage else None
    latest_cache_read = _get_int(latest_usage, 'cache_read_tokens') if latest_usage else None
    latest_input_tokens = _get_int(latest_usage, 'input_tokens') if latest_usage else None
    latest_output_tokens = _get_int(latest_usage, 'output_tokens') if latest_usage else None
    latest_reasoning_tokens = _get_int(latest_usage, 'reasoning_tokens') if latest_usage else None

    # Growth data
    earliest_prompt = None
    if len(llm_responses) >= 2:
        earliest_resp = llm_responses[-1]
        earliest_usage = earliest_resp.get('usage') if isinstance(earliest_resp.get('usage'), dict) else None
        earliest_prompt = _get_int(earliest_usage, 'prompt_tokens') if earliest_usage else None

    # Average data
    avg_prompt = None
    avg_output = None
    avg_count = 0
    if n_model_calls > 0:
        total_prompt = 0
        total_output = 0
        count = 0
        for resp in llm_responses:
            usage = resp.get('usage') if isinstance(resp.get('usage'), dict) else None
            if usage:
                p = _get_int(usage, 'prompt_tokens')
                o = _get_int(usage, 'output_tokens')
                if p is not None and o is not None:
                    total_prompt += p
                    total_output += o
                    count += 1
        if count > 0:
            avg_prompt = total_prompt // count
            avg_output = total_output // count
            avg_count = count

    # Last user message data
    last_msg_calls = None
    last_msg_measured = None
    last_msg_tokens = None
    if turn_starts:
        first_ts_idx = None
        for i, (eid, kind, _, _) in enumerate(rows):
            if kind == 'turn.start':
                first_ts_idx = i
                break
        if first_ts_idx is not None:
            newer_responses = []
            for i in range(first_ts_idx):
                eid, kind, _, raw_attrs = rows[i]
                if kind == 'llm.response':
                    attrs = _parse_attrs(raw_attrs)
                    newer_responses.append(attrs)
            # Count only the responses that actually reported a prompt size, so "N calls
            # totalling M tokens" describes the same N responses.
            measured = 0
            t = 0
            for resp in newer_responses:
                usage = resp.get('usage') if isinstance(resp.get('usage'), dict) else None
                if usage:
                    p = _get_int(usage, 'prompt_tokens')
                    if p is not None:
                        measured += 1
                        t += p
            if measured > 0:
                last_msg_calls = len(newer_responses)
                last_msg_measured = measured
                last_msg_tokens = t

    # Cost data
    cost_status = None
    estimated_cost = None
    actual_cost = None
    cost_error = False

    if state_db_path and os.path.isfile(state_db_path):
        try:
            con = sqlite3.connect(f'file:{state_db_path}?mode=ro', uri=True, timeout=2)
            try:
                row = con.execute(
                    'SELECT cost_status, estimated_cost_usd, actual_cost_usd FROM sessions WHERE id = ?',
                    (session_id,),
                ).fetchone()
            finally:
                con.close()
            if row:
                cost_status, estimated_cost, actual_cost = row
                # Hermes stores a 0.0 placeholder for models it has no price for; never show it as a cost.
                if cost_status != 'estimated' and actual_cost is None:
                    estimated_cost = None
        except (sqlite3.Error, Exception):
            cost_error = True

    return {
        'rows': rows,
        'partial': partial,
        'tools': tools,
        'failures': failures,
        'n_user_msgs': n_user_msgs,
        'n_model_calls': n_model_calls,
        'latest_msg_count': latest_msg_count,
        'latest_tool_count': latest_tool_count,
        'latest_model': latest_model,
        'latest_provider': latest_provider,
        'latest_prompt_tokens': latest_prompt_tokens,
        'latest_cache_read': latest_cache_read,
        'latest_input_tokens': latest_input_tokens,
        'latest_output_tokens': latest_output_tokens,
        'latest_reasoning_tokens': latest_reasoning_tokens,
        'earliest_prompt': earliest_prompt,
        'avg_prompt': avg_prompt,
        'avg_output': avg_output,
        'avg_count': avg_count,
        'last_msg_calls': last_msg_calls,
        'last_msg_measured': last_msg_measured,
        'last_msg_tokens': last_msg_tokens,
        'cost_status': cost_status,
        'estimated_cost': estimated_cost,
        'actual_cost': actual_cost,
        'cost_error': cost_error,
    }


def _build_full_report(data):
    rows = data['rows']
    partial = data['partial']
    tools = data['tools']
    failures = data['failures']
    n_user_msgs = data['n_user_msgs']
    n_model_calls = data['n_model_calls']
    latest_msg_count = data['latest_msg_count']
    latest_tool_count = data['latest_tool_count']
    latest_model = data['latest_model']
    latest_provider = data['latest_provider']
    latest_prompt_tokens = data['latest_prompt_tokens']
    latest_cache_read = data['latest_cache_read']
    latest_input_tokens = data['latest_input_tokens']
    latest_output_tokens = data['latest_output_tokens']
    latest_reasoning_tokens = data['latest_reasoning_tokens']
    earliest_prompt = data['earliest_prompt']
    avg_prompt = data['avg_prompt']
    avg_output = data['avg_output']
    avg_count = data.get('avg_count', 0)
    last_msg_calls = data['last_msg_calls']
    last_msg_measured = data.get('last_msg_measured')
    last_msg_tokens = data['last_msg_tokens']
    cost_status = data['cost_status']
    estimated_cost = data['estimated_cost']
    actual_cost = data['actual_cost']
    cost_error = data['cost_error']

    lines = [f'Omniscience: reviewed {len(rows)} recent recorded events in this chat, including {tools} completed tool calls.']
    if partial:
        lines.append('Earlier events were not reviewed.')
    lines.append('Helper-agent events are not included in this first version; recorder loss may leave gaps.')

    if failures:
        if len(failures) > 3:
            lines.append(f'{len(failures)} recorded failure event(s) in this portion (showing 3 most recent):')
        else:
            lines.append(f'{len(failures)} recorded failure event(s) in this portion:')
        lines.extend(f'- {label} failed (event {event_id})' for label, event_id in failures[:3])
    else:
        lines.append('No failures were recorded in this portion. This does not establish that the run succeeded.')

    # Chat size section
    chat_lines = []
    parts = []
    if n_user_msgs is not None and n_model_calls is not None:
        parts.append(f'Chat size: {_fmt_int(n_user_msgs)} user messages, {_fmt_int(n_model_calls)} model calls in reviewed events')
    if latest_msg_count is not None and latest_tool_count is not None and latest_model and latest_provider:
        parts.append(f'latest request carried {_fmt_int(latest_msg_count)} messages and {_fmt_int(latest_tool_count)} tool definitions (model {latest_model} via {latest_provider})')
    if parts:
        chat_lines.append('; '.join(parts) + '.')

    if latest_prompt_tokens is not None and latest_cache_read is not None and latest_output_tokens is not None:
        # New input is the prompt minus what was reused. `input_tokens` cannot be trusted for
        # this: some providers report the whole input there, cached part included.
        fresh_input = max(0, latest_prompt_tokens - latest_cache_read)
        line = f'Latest model call sent {_fmt_int(latest_prompt_tokens)} prompt tokens: {_fmt_int(latest_cache_read)} reused from cache, {_fmt_int(fresh_input)} new; reply {_fmt_int(latest_output_tokens)} output tokens'
        if latest_reasoning_tokens is not None:
            line += f' ({_fmt_int(latest_reasoning_tokens)} reasoning)'
        line += '.'
        chat_lines.append(line)

    if earliest_prompt is not None and latest_prompt_tokens is not None:
        chat_lines.append(f'Earliest reviewed call sent {_fmt_int(earliest_prompt)} prompt tokens; latest sent {_fmt_int(latest_prompt_tokens)}.')

    if avg_prompt is not None and avg_output is not None:
        measured = '' if avg_count >= n_model_calls else f' ({_fmt_int(avg_count)} of {_fmt_int(n_model_calls)} calls reported usage)'
        chat_lines.append(f'Average per model call in reviewed events{measured}: {_fmt_int(avg_prompt)} prompt tokens, {_fmt_int(avg_output)} output tokens.')

    if last_msg_calls is not None and last_msg_tokens is not None:
        chat_lines.append(f'Last user message used {_fmt_int(last_msg_calls)} model calls totalling {_fmt_int(last_msg_tokens)} prompt tokens.')

    if partial:
        chat_lines.append('Token figures cover only the reviewed events.')

    not_rec = 'Not recorded: how the prompt splits between system text, tool definitions and history; the model\'s context limit.'
    if latest_prompt_tokens is not None:
        not_rec += ' Each new message re-sends roughly the latest prompt size.'
    chat_lines.append(not_rec)

    lines.extend(chat_lines)

    # Cost section
    cost_lines = []
    if cost_error or not cost_status:
        cost_lines.append('Cost: not recorded for this chat.')
    elif cost_status == 'included':
        cost_lines.append('Cost: Hermes marks this chat as included in your plan, so no per-message price is recorded.')
    elif cost_status == 'unknown' and actual_cost is None:
        cost_lines.append('Cost: Hermes has no price for this model, so no cost is shown.')
    else:
        cost_val = actual_cost if actual_cost is not None else estimated_cost
        if cost_val is not None:
            label = 'ACTUAL' if actual_cost is not None else 'ESTIMATE'
            line = f'Cost so far (Hermes {label}): ${cost_val:.4f} for the whole chat'
            if not partial and n_model_calls >= 1:
                per_call = cost_val / n_model_calls
                line += f', about ${per_call:.4f} per model call on average'
            cost_lines.append(line)
        else:
            cost_lines.append('Cost: not recorded for this chat.')

    lines.extend(cost_lines)
    lines.append('Message, command, output and error text are not captured, so the cause cannot be determined from these records alone.')
    return '\n'.join(lines)


def _build_light_report(data, links=None):
    failures = data['failures']
    latest_prompt_tokens = data['latest_prompt_tokens']
    latest_cache_read = data['latest_cache_read']
    latest_input_tokens = data['latest_input_tokens']
    latest_output_tokens = data['latest_output_tokens']
    earliest_prompt = data['earliest_prompt']
    last_msg_calls = data['last_msg_calls']
    last_msg_measured = data.get('last_msg_measured')
    last_msg_tokens = data['last_msg_tokens']
    cost_status = data['cost_status']
    estimated_cost = data['estimated_cost']
    actual_cost = data['actual_cost']
    cost_error = data['cost_error']

    lines = []

    # Line 1
    if failures:
        lines.append(f'Omniscience (light): {len(failures)} recorded failure(s) in this chat\'s recent events.')
    else:
        lines.append('Omniscience (light): no failures recorded in recent events (this does not prove success).')

    # Line 2
    if latest_prompt_tokens is not None:
        line = f'The latest model call sent {_fmt_int(latest_prompt_tokens)} tokens'
        if earliest_prompt is not None:
            line += f' ({_fmt_int(earliest_prompt)} at the earliest reviewed call)'
        if last_msg_calls and last_msg_tokens is not None:
            calls_word = 'call' if last_msg_calls == 1 else 'calls'
            usage_note = ''
            if last_msg_measured is not None and last_msg_measured < last_msg_calls:
                # Do not let the token total look like it covers every call.
                usage_note = f' ({_fmt_int(last_msg_measured)} reported usage)'
            line += (f'; your last message used {_fmt_int(last_msg_calls)} {calls_word}'
                     f'{usage_note} totalling {_fmt_int(last_msg_tokens)} tokens')
        lines.append(line + '.')

    # Line 3
    if latest_prompt_tokens is not None:
        lines.append('Starting a new chat would reset this; switching model re-sends the whole '
                     'context instead of reusing the old cache.')

    # Line 4 Cost
    if not cost_error and cost_status and cost_status != 'included':
        cost_val = actual_cost if actual_cost is not None else estimated_cost
        if cost_val is not None:
            label = 'ACTUAL' if actual_cost is not None else 'ESTIMATE'
            lines.append(f'Cost so far (Hermes {label}): ${cost_val:.4f}.')

    # Links
    if links:
        for label, value in links:
            lines.append(f'- {label}: {value}')

    lines.append('Type /omni full for the detailed report.')
    return '\n'.join(lines)


def diagnose_current(db_path: str, session_id: str | None, *, state_db_path: str | None = None, mode: str = "light", links=None) -> str:
    data = _compute_data(db_path, session_id, state_db_path)

    if 'error' in data:
        return data['error']

    if mode == "full":
        return _build_full_report(data)
    else:
        return _build_light_report(data, links)


# ---------------------------------------------------------------------------
# /omni tokens — the headline from the Usage page, and the way in to the page.
# ---------------------------------------------------------------------------

def _fmt_tokens(n: float) -> str:
    """1.68B, 47.7M, 12k — the same shape the page prints, so the two agree at a glance."""
    if n >= 1e12:
        return f'{n / 1e12:.2f}T'
    if n >= 1e9:
        return f'{n / 1e9:.2f}B'
    if n >= 1e6:
        return f'{n / 1e6:.2f}M'
    if n >= 1e3:
        return f'{round(n / 1e3)}k'
    return str(int(n))


def usage_headline(db_path: str, state_db_path: str | None, days: int) -> dict:
    """Four numbers for the chat command. The full breakdown lives on the Usage page.

    Deliberately the same rows the page reads, so the command cannot disagree with it.
    """
    since = 0 if days <= 0 else time.time() - days * 86400
    out = {'days': days, 'calls': 0, 'prompt': 0.0, 'cache_read': 0.0,
           'output': 0.0, 'cost': None, 'chats': 0}
    if not os.path.exists(db_path):
        return out
    try:
        con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    except sqlite3.Error:
        return out
    try:
        # A response with no usage block recorded no tokens: the page skips it, so the
        # command must too, or the two disagree on the call count.
        row = con.execute(
            "SELECT COUNT(*),"
            " COALESCE(SUM(json_extract(attrs, '$.usage.prompt_tokens')), 0),"
            " COALESCE(SUM(json_extract(attrs, '$.usage.cache_read_tokens')), 0),"
            " COALESCE(SUM(json_extract(attrs, '$.usage.output_tokens')), 0)"
            " FROM events WHERE kind = 'llm.response' AND ts >= ?"
            " AND json_extract(attrs, '$.usage') IS NOT NULL",
            (since,),
        ).fetchone()
        # Chats are counted the way the page counts them — a helper's spend belongs to the
        # chat that started it — so the two surfaces cannot disagree. That needs the parent
        # chain, and recorder rows carry '' (not NULL) for "no parent" at a root.
        parent_of: dict[str, str] = {}
        for sid, parent in con.execute(
            "SELECT session_id, parent_session_id FROM events"
            " WHERE parent_session_id IS NOT NULL AND parent_session_id != ''"
            " AND session_id IS NOT NULL GROUP BY 1, 2"
        ):
            parent_of.setdefault(sid, parent)

        def root_of(sid: str) -> str:
            seen = {sid}
            current = sid
            while True:
                parent = parent_of.get(current)
                if not parent or parent in seen:
                    return current
                seen.add(parent)
                current = parent

        roots = {
            root_of(sid) for (sid,) in con.execute(
                "SELECT DISTINCT session_id FROM events WHERE kind = 'llm.response'"
                " AND ts >= ? AND session_id IS NOT NULL"
                " AND json_extract(attrs, '$.usage') IS NOT NULL",
                (since,),
            )
        }
    except sqlite3.Error:
        return out
    finally:
        con.close()
    if row:
        out['calls'] = int(row[0] or 0)
        out['prompt'] = float(row[1] or 0)
        out['cache_read'] = float(row[2] or 0)
        out['output'] = float(row[3] or 0)
        out['chats'] = len(roots)
    if state_db_path and os.path.exists(state_db_path):
        try:
            scon = sqlite3.connect(f'file:{state_db_path}?mode=ro', uri=True)
            try:
                total = scon.execute(
                    "SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM sessions WHERE started_at >= ?",
                    (since,),
                ).fetchone()
            finally:
                scon.close()
        except sqlite3.Error:
            total = None
        if total:
            out['cost'] = float(total[0] or 0)
    return out


def _fmt_money(value: float) -> str:
    if value <= 0:
        return '$0.00'
    if value < 0.01:
        return f'~${value:.4f}'
    return f'${value:.2f}'


def _secs(value) -> str:
    if value is None:
        return '—'
    if value < 1:
        return f'{round(value * 1000)} ms'
    if value < 60:
        return f'{value:.1f}s'
    return f'{int(value // 60)}m {round(value % 60)}s'


def _short_model(name: str) -> str:
    # Drop the vendor prefix only: the ":US" route is a different billing channel and must
    # not render as the same model as the plain id.
    return name.rsplit('/', 1)[-1]


def _period_phrase(days: int) -> str:
    if days <= 0:
        return 'all recorded history'
    if days == 1:
        return 'the last 24 hours'
    return f'the last {days} days'


def tokens_report(report: dict, link: str | None) -> str:
    """The chat reply for /omni tokens: the period's shape, then the way to the page.

    Chat is for what you can hold in one glance — totals, which models and chats carry the
    cost, whether compaction fired, and which model is slow. The calendar, the per-call context
    and every chat live on the page, so nobody has to scroll a wall of numbers here.
    """
    days = int(report.get('days') or 0)
    totals = report.get('totals') or {}
    calls = int(totals.get('calls') or 0)
    period = _period_phrase(days)
    if not calls:
        lines = [f'Usage — {period}', '  No model calls recorded in this period.']
    else:
        chats = int(totals.get('chats') or 0)
        prompt = float(totals.get('prompt') or 0)
        output = float(totals.get('output') or 0)
        cache = report.get('cache') or {}
        hit = cache.get('hit_rate')
        lines = [
            f'Usage — {period}',
            f"  {calls:,} model calls · {chats:,} chat{'' if chats == 1 else 's'}"
            f" · {_fmt_tokens(prompt)} context · {_fmt_tokens(output)} output",
        ]
        if hit is not None:
            line = f"  {hit * 100:.0f}% of that context came from the cache"
            if cache.get('saved_usd'):
                line += f"; it saved {_fmt_money(cache['saved_usd'])} at list price"
                if (cache.get('priced_share') or 1) < 1:
                    line += f" (priced for {cache['priced_share'] * 100:.0f}% of calls)"
            lines.append(line)
        if totals.get('cost'):
            lines.append(f"  Hermes estimates the spend at {_fmt_money(totals['cost'])}")

        models = [m for m in (report.get('models') or []) if m.get('calls')][:3]
        if models:
            lines += ['', '  By model']
            for m in models:
                bits = [f"{m['calls']:,} calls", f"{_fmt_tokens(m.get('prompt') or 0)} in"]
                if m.get('p95_s') is not None:
                    bits.append(f"p95 {_secs(m['p95_s'])}")
                if m.get('cost'):
                    bits.append(_fmt_money(m['cost']))
                lines.append(f"    {_short_model(m['model'])[:30]:<31} {' · '.join(bits)}")

        chat_rows = [c for c in (report.get('chats') or []) if c.get('calls')][:3]
        if chat_rows:
            lines += ['', '  Costliest chats']
            for c in chat_rows:
                bits = []
                if c.get('cost'):
                    bits.append(_fmt_money(c['cost']))
                bits.append(f"{c['calls']:,} calls")
                bits.append(f"{_fmt_tokens(c.get('prompt_now') or 0)} now"
                            f" / {_fmt_tokens(c.get('prompt_max') or 0)} peak")
                lines.append(f"    {c['id'][:16]}…  {' · '.join(bits)}")

        context = report.get('context') or {}
        comps = context.get('compactions') or []
        if comps:
            deepest = max(comps, key=lambda c: c.get('before') or 0)
            lines.append(
                f"  Compaction: {len(comps)} recorded; deepest "
                f"{_fmt_tokens(deepest.get('before') or 0)} → {_fmt_tokens(deepest.get('after') or 0)}"
            )

        slow = [m for m in (report.get('models') or []) if (m.get('p95_s') or 0) > 0]
        if slow:
            worst = max(slow, key=lambda m: m.get('p95_s') or 0)
            if (worst.get('p95_s') or 0) >= 10:
                lines.append(
                    f"  Watch: {_short_model(worst['model'])} has a slow tail "
                    f"(p95 {_secs(worst['p95_s'])}) — usually queuing, not the model."
                )

    lines.append('')
    if link:
        lines.append(f'Calendar, context and every chat: {link}')
    else:
        lines.append('Calendar and graphs: the viewer is not running — start it with '
                     '`python -m omniscience_viewer`, then run /omni tokens again.')
    return '\n'.join(lines)
