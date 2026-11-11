"""The Usage page: what this machine spent, in detail.

Two sources, deliberately:

* the recorder's ``events.db`` is the only place with **per-call** facts — prompt size, cache
  read/write, latency, time to first word, tool calls, where a chat was compacted. It is
  authoritative for tokens and behaviour.
* Hermes' ``state.db`` keeps a per-session *estimated cost*. The recorder never stores money,
  so a dollar figure can only come from there — and it is therefore always labelled
  "Hermes' estimate", never presented as a bill.

Nothing here invents a price: token figures come from the provider's ``usage``; dollars come
from Hermes' own column; the one derived figure ("what the cache saved") is computed from a
published list rate and says so.
"""

from __future__ import annotations

import json
import os
import importlib.util
from bisect import bisect_left
import sqlite3
import time
from datetime import datetime
from functools import lru_cache
from typing import Any, Iterable, Optional

# Published list prices, USD per million tokens, for the models this box actually billed.
# DeepSeek's own sheet (api-docs.deepseek.com/quick_start/pricing, offline rates). A model
# that is not here gets no dollar figure rather than a guessed one.
LIST_RATES_USD_PER_M: dict[str, dict[str, float]] = {
    "deepseek-v4.1-flash": {"in": 0.15, "out": 0.60, "cache": 0.003},
    "deepseek-v4-flash": {"in": 0.15, "out": 0.60, "cache": 0.003},
    "deepseek-v4-pro": {"in": 0.66, "out": 1.98, "cache": 0.022},
}

# A prompt under this is a background/auxiliary call, not a conversation carrying context.
_MIN_CONTEXT_PROMPT = 1000
# Compaction: a prompt that dropped by more than this share of itself, and by more than a
# thousand tokens. Same rule as db.py and web/src/graph/tokens.ts — change all three together.
_COMPACT_DROP = 1000
_COMPACT_SHARE = 0.75

CONTEXT_BUCKETS = (0, 25_000, 50_000, 100_000, 200_000, 350_000, 500_000, 1_000_000)


def _num(value: Any) -> float:
    """A finite number or 0. JSON, strings and NaN all reach this: never propagate junk."""
    if type(value) is int:
        # The hot path: hundreds of thousands of already-numeric values from the importer.
        return float(value)
    if type(value) is float:
        # Still has to survive NaN and the infinities, or one bad row poisons a whole total.
        return value if value == value and value not in (float("inf"), float("-inf")) else 0.0
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        f = float(value)
        return f if f == f and f not in (float("inf"), float("-inf")) else 0.0
    if isinstance(value, str):
        try:
            return _num(float(value))
        except ValueError:
            return 0.0
    return 0.0


def _attrs(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _usage(attrs: dict) -> dict[str, float]:
    """Normalise one provider usage block. A missing prompt is input + cache read."""
    u = attrs.get("usage") if isinstance(attrs.get("usage"), dict) else {}
    cache_read = _num(u.get("cache_read_tokens"))
    cache_write = _num(u.get("cache_write_tokens"))
    output = _num(u.get("output_tokens")) or _num(u.get("completion_tokens"))
    reasoning = _num(u.get("reasoning_tokens"))
    prompt = _num(u.get("prompt_tokens"))
    if prompt <= 0:
        # A call that warms the cache sends its whole context as *write* tokens; leaving them
        # out counted a 19k-token call as ten tokens.
        prompt = _num(u.get("input_tokens")) + cache_read + cache_write
    if prompt <= 0 and output <= 0:
        return {}
    fresh = max(0.0, prompt - cache_read)
    return {
        "prompt": prompt,
        "fresh": fresh,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "output": output,
        "reasoning": reasoning,
    }


@lru_cache(maxsize=8192)
def _day_of_hour(hour: int) -> str:
    return datetime.fromtimestamp(hour * 3600).strftime("%Y-%m-%d")


def day_key(ts: float) -> str:
    """The reader's own calendar day. Usage grouped by UTC would put late-evening work in
    tomorrow, which reads as a bug when the chat list says it happened today.

    Cached by hour: an hour never straddles midnight, so every timestamp inside one maps to the
    same day, and 120,000 calls cost 8,192 strftime calls at most.
    """
    return _day_of_hour(int(ts // 3600))


def rate_for(model: Optional[str]) -> Optional[dict[str, float]]:
    """List rates for a model id, matched on the name after any vendor prefix."""
    if not model:
        return None
    name = str(model).split("/")[-1].split(":")[0].strip().lower()
    for key, rates in LIST_RATES_USD_PER_M.items():
        if name.startswith(key):
            return rates
    return None


def _percentile(values: list[float], share: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * share))))
    return round(ordered[idx], 3)


def _median(values: list[float]) -> Optional[float]:
    return _percentile(values, 0.5)


def _band_keys() -> list[str]:
    keys = [f"{_short(low)}–{_short(high)}" for low, high in zip(CONTEXT_BUCKETS, CONTEXT_BUCKETS[1:])]
    keys.append(f"{_short(CONTEXT_BUCKETS[-1])}+")
    return keys


_BAND_KEYS: list[str] = []


def _bands() -> list[str]:
    """Built on first use: `_short` is defined below this point in the file."""
    global _BAND_KEYS
    if not _BAND_KEYS:
        _BAND_KEYS = _band_keys()
    return _BAND_KEYS


def bucket_for(prompt: float) -> str:
    """Which context-size band a call belongs to, as a printable range."""
    if prompt <= 0:
        return "no context"
    # bisect_right puts a prompt exactly on a boundary in the lower band, matching "low < p <= high".
    keys = _bands()
    index = max(0, bisect_left(CONTEXT_BUCKETS, prompt) - 1)
    return keys[min(index, len(keys) - 1)]


def _short(n: float) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:g}M"
    if n >= 1_000:
        return f"{n / 1_000:g}k"
    return f"{n:g}"


def _empty_totals() -> dict[str, float]:
    return {k: 0.0 for k in (
        "calls", "chats", "prompt", "fresh", "cache_read", "cache_write",
        "output", "reasoning", "tool_calls", "errors", "aux_calls",
    )}


def summarise(
    rows: Iterable[tuple],
    cost_rows: Iterable[dict] = (),
    imported: Iterable[dict] = (),
    days: int = 7,
    now: Optional[float] = None,
    parent_of: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Build the whole page payload from event rows and Hermes' per-session costs.

    ``rows`` are ``(ts, kind, session_id, parent_session_id, status, attrs)``; ``cost_rows`` are
    dicts with
    ``id``, ``started_at``, ``model``, ``estimated_cost_usd``.
    """
    now = time.time() if now is None else now
    since = 0.0 if days <= 0 else now - days * 86400

    totals = _empty_totals()
    daily: dict[str, dict[str, Any]] = {}
    models: dict[str, dict[str, Any]] = {}
    chats: dict[str, dict[str, Any]] = {}
    series: dict[str, list[float]] = {}
    context_calls: dict[str, int] = {}
    compactions: list[dict[str, Any]] = []
    parent_of = dict(parent_of or {})
    # Per day *and* model, so the daily chart can show what drove the day rather than a
    # single total the reader cannot attribute.
    day_models: dict[str, dict[str, dict[str, float]]] = {}
    # One row per harness, so the page can answer "who spent this" and not only "which model".
    harness: dict[str, dict[str, Any]] = {}
    call_ts: list[float] = []

    def _root(session_id: str) -> str:
        """A helper's spend belongs to the chat that started it, not to a row of its own."""
        seen = {session_id}
        current = session_id
        while True:
            parent = parent_of.get(current)
            if not parent or parent in seen:
                return current
            seen.add(parent)
            current = parent

    rows = list(rows)
    # The link that says "this is a helper of X" can arrive after the helper's first events
    # (it rides a turn.start row) and can sit outside the window entirely, so the caller
    # passes the whole map; anything inside the rows only fills gaps.
    for _ts, _kind, sid, parent, _status, _raw in rows:
        if sid and parent and sid not in parent_of:
            parent_of[sid] = parent

    for ts, kind, session_id, _parent_session_id, status, raw_attrs in rows:
        ts = _num(ts)
        if ts <= 0 or ts < since:
            continue
        attrs = _attrs(raw_attrs)
        day = day_key(ts)
        bucket = daily.setdefault(day, {"day": day, **_empty_totals()})
        if session_id:
            session_id = _root(session_id)
            chat = chats.setdefault(session_id, {
                "id": session_id, "calls": 0, "prompt": 0.0, "prompt_now": 0.0,
                "prompt_max": 0.0, "cache_read": 0.0, "output": 0.0,
                "first_ts": ts, "last_ts": ts, "latencies": [], "tools": 0,
            })
            chat["last_ts"] = max(chat["last_ts"], ts)
            chat["first_ts"] = min(chat["first_ts"], ts)

        if kind == "llm.response":
            usage = _usage(attrs)
            if not usage:
                continue
            model = str(attrs.get("response_model") or attrs.get("model") or "unknown")
            totals["calls"] += 1
            bucket["calls"] += 1
            call_ts.append(ts)
            for key in ("prompt", "fresh", "cache_read", "cache_write", "output", "reasoning"):
                totals[key] += usage[key]
                bucket[key] += usage[key]
            m = models.setdefault(model, {
                "model": model, "calls": 0, "prompt": 0.0, "fresh": 0.0,
                "cache_read": 0.0, "cache_write": 0.0, "output": 0.0, "reasoning": 0.0,
                "errors": 0, "latencies": [], "ttfb": [],
            })
            m["calls"] += 1
            for key in ("prompt", "fresh", "cache_read", "cache_write", "output", "reasoning"):
                m[key] += usage[key]
            dm = day_models.setdefault(day, {}).setdefault(
                model, {"prompt": 0.0, "output": 0.0, "calls": 0.0}
            )
            dm["prompt"] += usage["prompt"]
            dm["output"] += usage["output"]
            dm["calls"] += 1
            series.setdefault(session_id or "", []).append(usage["prompt"])
            if usage["prompt"] >= _MIN_CONTEXT_PROMPT:
                band = bucket_for(usage["prompt"])
                context_calls[band] = context_calls.get(band, 0) + 1
            duration = _num(attrs.get("duration_s"))
            if duration > 0:
                m["latencies"].append(duration)
                if session_id in chats:
                    chats[session_id]["latencies"].append(duration)
            ttfb = _num(attrs.get("ttfb_s"))
            if ttfb > 0:
                m["ttfb"].append(ttfb)
            if session_id in chats:
                chat = chats[session_id]
                chat["calls"] += 1
                chat["prompt"] += usage["prompt"]
                chat["cache_read"] += usage["cache_read"]
                chat["output"] += usage["output"]
                chat["prompt_max"] = max(chat["prompt_max"], usage["prompt"])
                chat["prompt_now"] = usage["prompt"]
            if str(status or "").lower() in ("error", "timeout", "failed"):
                totals["errors"] += 1
                m["errors"] += 1
        elif kind == "aux.response":
            usage = _usage(attrs)
            totals["aux_calls"] += 1
            bucket["aux_calls"] += 1
            for key in ("prompt", "output"):
                totals[key] += usage.get(key, 0.0)
                bucket[key] += usage.get(key, 0.0)
        elif kind == "tool.end":
            totals["tool_calls"] += 1
            bucket["tool_calls"] += 1
            if session_id in chats:
                chats[session_id]["tools"] += 1

    # Calls imported from the other harnesses. They carry no latency, status or parent link,
    # so they add to totals, days, models, the harness split and a chat row named after their
    # own source; nothing here pretends to know how long they took.
    for call in imported:
        ts = _num(call.get("ts"))
        if ts <= 0 or ts < since:
            continue
        fresh = _num(call.get("input"))
        cache_read = _num(call.get("cache_read"))
        cache_write = _num(call.get("cache_write"))
        output = _num(call.get("output"))
        reasoning = _num(call.get("reasoning"))
        if not any((fresh, cache_read, cache_write, output, reasoning)):
            continue
        source = str(call.get("source") or "imported")
        if source == "codex":
            # OpenAI counts cached tokens inside input_tokens (total_tokens == input_tokens), so
            # adding cache_read again doubled every Codex prompt and halved the cache rate.
            prompt = fresh
            fresh = max(0.0, fresh - cache_read)
        else:
            prompt = fresh + cache_read + cache_write
        model = str(call.get("model") or "unknown")
        day = day_key(ts)
        bucket = daily.get(day)
        if bucket is None:
            bucket = daily[day] = {"day": day, **_empty_totals()}
        n_calls = int(call.get("calls") or 1)
        totals["calls"] += n_calls
        bucket["calls"] += n_calls
        call_ts.append(ts)
        for key, value in (("prompt", prompt), ("fresh", fresh), ("cache_read", cache_read),
                           ("cache_write", cache_write), ("output", output),
                           ("reasoning", reasoning)):
            totals[key] += value
            bucket[key] += value
        m = models.get(model)
        if m is None:
            m = models[model] = {
                "model": model, "calls": 0, "prompt": 0.0, "fresh": 0.0,
                "cache_read": 0.0, "cache_write": 0.0, "output": 0.0, "reasoning": 0.0,
                "errors": 0, "latencies": [], "ttfb": [],
            }
        m["calls"] += 1
        for key, value in (("prompt", prompt), ("fresh", fresh), ("cache_read", cache_read),
                           ("cache_write", cache_write), ("output", output),
                           ("reasoning", reasoning)):
            m[key] += value
        per_model = day_models.get(day)
        if per_model is None:
            per_model = day_models[day] = {}
        dm = per_model.get(model)
        if dm is None:
            dm = per_model[model] = {"prompt": 0.0, "output": 0.0, "calls": 0.0}
        dm["prompt"] += prompt
        dm["output"] += output
        dm["calls"] += 1
        h = harness.get(source)
        if h is None:
            h = harness[source] = {
                "source": source, "calls": 0, "prompt": 0.0, "fresh": 0.0, "cache_read": 0.0,
                "cache_write": 0.0, "output": 0.0, "reasoning": 0.0, "models": set(),
            }
        h["calls"] += n_calls
        h["models"].add(model)
        for key, value in (("prompt", prompt), ("fresh", fresh), ("cache_read", cache_read),
                           ("cache_write", cache_write), ("output", output),
                           ("reasoning", reasoning)):
            h[key] += value
        sid = f"{source}:{call.get('session_id') or ''}"
        chat = chats.get(sid)
        if chat is None:
            chat = chats[sid] = {
                "id": sid, "calls": 0, "prompt": 0.0, "prompt_now": 0.0, "prompt_max": 0.0,
                "cache_read": 0.0, "output": 0.0, "first_ts": ts, "last_ts": ts,
                "latencies": [], "tools": 0, "source": source,
                "session": call.get("session_id"),
            }
        chat["calls"] += 1
        chat["prompt"] += prompt
        chat["cache_read"] += cache_read
        chat["output"] += output
        chat["prompt_max"] = max(chat["prompt_max"], prompt)
        chat["prompt_now"] = prompt
        chat["first_ts"] = min(chat["first_ts"], ts)
        chat["last_ts"] = max(chat["last_ts"], ts)
        series.setdefault(sid, []).append(prompt)
        if prompt >= _MIN_CONTEXT_PROMPT:
            band = bucket_for(prompt)
            context_calls[band] = context_calls.get(band, 0) + 1

    # Compaction is derived, per chat, from its own model calls: a big drop in what it sent.
    for session_id, prompts in series.items():
        # Calibrated on Hermes, whose context only grows within a turn; another harness's prompts
        # move for reasons that are not a compaction, and reporting 1,500 of them would be noise.
        foreign = chats.get(session_id, {}).get("source")
        if foreign and foreign != "hermes":
            continue
        peak_before = 0.0
        for prev, cur in zip(prompts, prompts[1:]):
            peak_before = max(peak_before, prev)
            if prev - cur > _COMPACT_DROP and cur < prev * _COMPACT_SHARE:
                compactions.append({
                    "session": session_id,
                    "before": int(prev),
                    "after": int(cur),
                })

    cost_by_id: dict[str, float] = {}
    cost_by_model: dict[str, float] = {}
    cost_total = 0.0
    cost_days: dict[str, float] = {}
    for row in cost_rows:
        started = _num(row.get("started_at"))
        cost = _num(row.get("estimated_cost_usd"))
        if not cost:
            continue
        sid = row.get("id")
        if isinstance(sid, str) and sid:
            # A chat row is not a period. A session that began before the window still cost its
            # money, so its row keeps the whole estimate; only the period totals below are
            # windowed. A helper's estimate lands on the chat that started it, because that is
            # the row whose calls include the helper's.
            root = _root(sid)
            cost_by_id[root] = cost_by_id.get(root, 0.0) + cost
        if started and started < since:
            continue
        cost_total += cost
        model = row.get("model")
        if isinstance(model, str) and model:
            cost_by_model[model] = cost_by_model.get(model, 0.0) + cost
        if started:
            cost_days[day_key(started)] = cost_days.get(day_key(started), 0.0) + cost

    totals["cost"] = round(cost_total, 4)
    for day in cost_days:
        if day not in daily:
            daily[day] = {"day": day, **_empty_totals()}
    for day, row in daily.items():
        row["cost"] = round(cost_days.get(day, 0.0), 4)
        for key in ("prompt", "fresh", "cache_read", "cache_write", "output", "reasoning"):
            row[key] = int(row[key])
    cost_by_model_norm: dict[str, float] = {}
    for name, amount in cost_by_model.items():
        key = name.split("/")[-1].lower()
        cost_by_model_norm[key] = cost_by_model_norm.get(key, 0.0) + amount
    for model, row in models.items():
        key = model.split("/")[-1].lower()
        row["cost"] = round(cost_by_model_norm[key], 4) if key in cost_by_model_norm else None
        latencies = row.pop("latencies")
        row["p50_s"] = _median(latencies)
        row["p95_s"] = _percentile(latencies, 0.95)
        row["ttfb_median_s"] = _median(row.pop("ttfb"))
        for key in ("prompt", "fresh", "cache_read", "cache_write", "output", "reasoning"):
            row[key] = int(row[key])
        rates = rate_for(model)
        row["rates"] = rates
    # A chat with only tool events never paid for a model call; counting it here would make
    # the headline disagree with /omni tokens and with what the page can show.
    totals["chats"] = sum(1 for c in chats.values() if c["calls"] > 0)

    chat_rows = []
    for chat in chats.values():
        latencies = chat.pop("latencies")
        chat["p95_s"] = _percentile(latencies, 0.95)
        chat["cost"] = round(cost_by_id.get(chat["id"], 0.0), 4) if chat["id"] in cost_by_id else None
        for key in ("prompt", "prompt_now", "prompt_max", "cache_read", "output"):
            chat[key] = int(chat[key])
        chat_rows.append(chat)
    for chat in chat_rows:
        chat.setdefault("source", "hermes")
    chat_rows.sort(key=lambda c: (-(c["cost"] or 0), -c["prompt_now"], -c["calls"]))
    chat_total = len(chat_rows)
    chat_rows = chat_rows[:300]

    # Time actually spent, and how many chats ran at once. A session's span is first to last
    # recorded call, which is the honest lower bound on the time a person sat there.
    spans = [(c["first_ts"], c["last_ts"]) for c in chat_rows if c["calls"] > 0]
    boundaries = sorted(
        [(a, 1) for a, _ in spans] + [(b, -1) for _, b in spans], key=lambda p: (p[0], -p[1])
    )
    peak = running = 0
    for _, delta in boundaries:
        running += delta
        peak = max(peak, running)
    # Active time counts only gaps under ten minutes: a session that sat open overnight is not
    # ten hours of work, and summing whole spans would report months of attention that never
    # happened. Longest run is still the honest end-to-end span of one chat.
    ordered = sorted(call_ts)
    active = sum(
        later - earlier for earlier, later in zip(ordered, ordered[1:]) if later - earlier <= 600
    )
    time_metrics = {
        "sessions": len(spans),
        "active_s": round(active, 1),
        "longest_s": round(max((b - a for a, b in spans), default=0.0), 1),
        "peak_concurrent": peak,
    }

    # Hermes needs a row of its own: the page promises "every agent plus Hermes itself", and the
    # shares are computed over these rows, so omitting it made the imported agents look like all
    # the traffic. Derived from totals minus what the imported harnesses accounted for.
    imported_calls = sum(h["calls"] for h in harness.values())
    hermes_calls = int(totals["calls"]) - imported_calls
    if hermes_calls > 0:
        imported_models = {name for h in harness.values() for name in h["models"]}
        harness["hermes"] = {
            "source": "hermes",
            "calls": hermes_calls,
            "prompt": totals["prompt"] - sum(h["prompt"] for h in harness.values()),
            "fresh": totals["fresh"] - sum(h["fresh"] for h in harness.values()),
            "cache_read": totals["cache_read"] - sum(h["cache_read"] for h in harness.values()),
            "cache_write": totals["cache_write"] - sum(h["cache_write"] for h in harness.values()),
            "output": totals["output"] - sum(h["output"] for h in harness.values()),
            "reasoning": totals["reasoning"] - sum(h["reasoning"] for h in harness.values()),
            "models": sorted(set(models) - imported_models),
        }

    hourly = [0] * 24
    weekday_hour = [[0] * 24 for _ in range(7)]
    for ts in call_ts:
        when = datetime.fromtimestamp(ts)
        hourly[when.hour] += 1
        weekday_hour[when.weekday()][when.hour] += 1

    # What the cache saved: the same tokens, priced at the input rate instead of the cache
    # rate. Only for models whose published rates we know; otherwise the figure is absent.
    saved = 0.0
    priced_calls = 0
    for model, row in models.items():
        rates = row.get("rates")
        if not rates:
            continue
        priced_calls += row["calls"]
        saved += row["cache_read"] / 1_000_000 * (rates["in"] - rates["cache"])
    cache = {
        "read": int(totals["cache_read"]),
        "fresh": int(totals["fresh"]),
        "hit_rate": round(
            totals["cache_read"] / totals["prompt"], 4
        ) if totals["prompt"] else None,
        "saved_usd": round(saved, 4) if priced_calls else None,
        "priced_share": round(priced_calls / totals["calls"], 3) if totals["calls"] else None,
    }

    histogram = []
    for low, high in zip(CONTEXT_BUCKETS, CONTEXT_BUCKETS[1:]):
        key = f"{_short(low)}–{_short(high)}"
        histogram.append({"band": key, "calls": context_calls.get(key, 0)})
    histogram.append({
        "band": f"{_short(CONTEXT_BUCKETS[-1])}+",
        "calls": context_calls.get(f"{_short(CONTEXT_BUCKETS[-1])}+", 0),
    })
    context = {
        "histogram": histogram,
        "compactions": sorted(compactions, key=lambda c: -c["before"]),
        "context_tokens": int(totals["prompt"]),
        "calls_with_context": sum(context_calls.values()),
    }

    daily_models = [
        {"day": day, "model": model, "prompt": int(v["prompt"]),
         "output": int(v["output"]), "calls": int(v["calls"])}
        for day, per_model in day_models.items()
        for model, v in per_model.items()
    ]

    return {
        "days": days,
        "generated_at": now,
        "since": since,
        "totals": {k: (int(v) if k != "cost" else v) for k, v in totals.items()},
        "daily": sorted(daily.values(), key=lambda r: r["day"]),
        "daily_models": sorted(daily_models, key=lambda r: (r["day"], -r["prompt"])),
        "models": sorted(models.values(), key=lambda m: -(m["prompt"] + m["output"])),
        "cache": cache,
        "context": context,
        "chats": chat_rows,
        "chat_total": chat_total,
        "harnesses": sorted(
            (
                {"source": h["source"], "calls": int(h["calls"]),
                 "prompt": int(h["prompt"]), "fresh": int(h["fresh"]),
                 "cache_read": int(h["cache_read"]), "cache_write": int(h["cache_write"]),
                 "output": int(h["output"]), "reasoning": int(h["reasoning"]),
                 "models": sorted(h["models"])}
                for h in harness.values()
            ),
            key=lambda h: -(h["prompt"] + h["output"]),
        ),
        "hourly": hourly,
        "weekday_hour": weekday_hour,
        "time_metrics": time_metrics,
        "cost_available": bool(cost_total),
    }


def _parent_links(events_db: str) -> dict[str, str]:
    """Which session is a helper of which — from every row ever recorded, not just the window.

    A chat's helper link can predate the period being looked at, and without it the helper is
    counted as a chat of its own.
    """
    con = sqlite3.connect(f"file:{events_db}?mode=ro", uri=True)
    try:
        links: dict[str, str] = {}
        for sid, parent in con.execute(
            "SELECT session_id, parent_session_id FROM events"
            " WHERE parent_session_id IS NOT NULL AND parent_session_id != ''"
            " AND session_id IS NOT NULL GROUP BY 1, 2"
        ):
            links.setdefault(sid, parent)
        return links
    finally:
        con.close()


def _event_rows(events_db: str, since: float) -> list[tuple]:
    con = sqlite3.connect(f"file:{events_db}?mode=ro", uri=True)
    try:
        return con.execute(
            "SELECT ts, kind, session_id, parent_session_id, status, attrs FROM events "
            "WHERE ts >= ? AND kind IN ('llm.response', 'aux.response', 'tool.end') "
            "ORDER BY ts ASC",
            (since,),
        ).fetchall()
    finally:
        con.close()


def _cost_rows(state_db: str, since: float) -> list[dict]:
    """Hermes' own per-session cost estimate. A missing or older database is not an error:
    the page then shows tokens and says cost is unavailable."""
    if not state_db or not os.path.exists(state_db):
        return []
    try:
        con = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)
    except sqlite3.Error:
        return []
    try:
        cur = con.execute(
            "SELECT id, started_at, model, estimated_cost_usd FROM sessions "
            "WHERE started_at >= ?",
            (since,),
        )
        names = [c[0] for c in cur.description]
        return [dict(zip(names, row)) for row in cur.fetchall()]
    except sqlite3.Error:
        return []
    finally:
        con.close()


def _sources_module():
    """The importer, whether this file is imported as a package or loaded by path from the
    plugin (which has no package to import from)."""
    try:
        from . import sources as mod  # type: ignore
        return mod
    except Exception:
        pass
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sources.py")
    if not os.path.exists(path):
        return None
    try:
        spec = importlib.util.spec_from_file_location("omniscience_sources_shared", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def build_usage(events_db: str, state_db: Optional[str] = None, days: int = 7,
                now: Optional[float] = None, include_imported: bool = True) -> dict[str, Any]:
    """Read both databases and return the page payload. Read-only on both.

    Imported harnesses are included only when their source is switched on; a switched-off
    harness has no rows in usage.db at all (see sources.delete_source).
    """
    now = time.time() if now is None else now
    since = 0.0 if days <= 0 else now - days * 86400
    rows = _event_rows(events_db, since)
    costs = _cost_rows(state_db or "", since)
    imported: list[dict] = []
    sources_mod = _sources_module() if include_imported else None
    if sources_mod is not None:
        try:
            imported = sources_mod.export_for_usage(events_db, since)
        except Exception:
            imported = []
    payload = summarise(rows, costs, imported=imported, days=days, now=now,
                        parent_of=_parent_links(events_db))
    if sources_mod is not None:
        try:
            payload["sources"] = sources_mod.source_status(events_db)
        except Exception:
            payload["sources"] = []
    else:
        payload["sources"] = []
    return payload
