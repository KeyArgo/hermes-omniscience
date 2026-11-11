"""Ask one of your own models to read this recording and write it up.

The viewer can show the numbers; explaining them is a model job. This module finds the
endpoints Hermes itself is authenticated against (``~/.hermes/auth.json``, ``config.yaml``,
``.env``), lists the models those endpoints serve, and posts a **metadata-only** digest of the
recording to the one the operator picks.

What is sent: counts, token totals, model and provider names, durations, error reasons, chat
labels. What is never sent: a prompt, a tool argument, a tool result, or a file's contents —
the recorder does not store them, so there is nothing to leak. Keys stay in this process; only
the finished text goes back to the browser.

The digest is built from the same functions that feed the pages (``usage.build_usage`` and
``db.latency_by_model``), so the writeup cannot contradict the screen it is describing.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from . import db as db_mod
from . import usage as usage_mod

log = logging.getLogger(__name__)

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
MODEL_CACHE_SECONDS = 600
HTTP_TIMEOUT = 6.0
ANSWER_TIMEOUT = 180.0

_models_cache: dict[str, Any] = {"at": 0.0, "items": [], "unavailable": []}


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _read_env(path: Path) -> dict[str, str]:
    """``KEY=value`` lines from Hermes' own .env. Values stay in this process."""
    out: dict[str, str] = {}
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        if key.strip():
            out[key.strip()] = value
    return out


def _config_providers(path: Path) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    """The default provider/base_url, and any ``providers:`` block, without a YAML dependency.

    PyYAML is not installed in the viewer's venv and the viewer must not grow a dependency for
    two keys. This reads only the shape Hermes writes: a two-space map, one nested map per
    provider, scalar values.
    """
    default: dict[str, str] = {}
    providers: dict[str, dict[str, str]] = {}
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return default, providers

    section: Optional[str] = None
    current: Optional[str] = None
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.split(" #")[0].rstrip()
        if indent == 0:
            section = line.rstrip(":").strip() or None
            current = None
            continue
        body = line.strip()
        if ":" not in body:
            continue
        key, _, value = body.partition(":")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if section == "model" and indent == 2 and value:
            default[key] = value
        elif section == "providers":
            if indent == 2 and not value:
                current = key
                providers.setdefault(current, {})
            elif indent >= 4 and current and value:
                providers[current][key] = value
    return default, providers


def endpoints() -> list[dict[str, Any]]:
    """Every provider this machine can already talk to, with the credential to prove it.

    Ordered: the one Hermes uses by default first, then the rest of the pool. A provider with
    no base URL or no credential is skipped — an endpoint that cannot answer is not a choice.
    """
    auth = _read_json(HERMES_HOME / "auth.json")
    default, config = _config_providers(HERMES_HOME / "config.yaml")
    env = _read_env(HERMES_HOME / ".env")

    found: dict[str, dict[str, Any]] = {}

    def remember(provider: str, base_url: str, key: str, source: str) -> None:
        if not provider or provider in found:
            return
        if not base_url or not key:
            return
        found[provider] = {
            "provider": provider,
            "base_url": base_url.rstrip("/"),
            "key": key,
            "source": source,
        }

    pool = auth.get("credential_pool")
    if not isinstance(pool, dict):
        pool = {}
    for provider, entries in pool.items():
        for entry in entries or []:
            if not isinstance(entry, dict):
                continue
            base = str(
                entry.get("base_url")
                or entry.get("inference_base_url")
                or (config.get(provider) or {}).get("base_url")
                or ""
            )
            key = str(entry.get("access_token") or entry.get("api_key") or entry.get("key") or "")
            if not key:
                label = str(entry.get("label") or "")
                key = env.get(label, "")
            if not key:
                key_env = (config.get(provider) or {}).get("key_env")
                key = env.get(key_env, "") if key_env else ""
            if not key:
                key = env.get(f"{provider.upper().replace('-', '_')}_API_KEY", "")
            remember(provider, base, key, "credential pool")

    for provider, block in (auth.get("providers") or {}).items():
        if not isinstance(block, dict):
            continue
        base = str(block.get("inference_base_url") or (config.get(provider) or {}).get("base_url") or "")
        remember(provider, base, str(block.get("access_token") or ""), "auth.json")

    # The provider Hermes itself is configured to call comes first in the picker.
    wanted = default.get("provider") or auth.get("active_provider") or ""
    if wanted and wanted in found:
        found[wanted]["default"] = True
    elif default.get("base_url"):
        remember(wanted, default["base_url"], env.get(f"{wanted.upper().replace('-', '_')}_API_KEY", ""), "config.yaml")

    out = list(found.values())
    out.sort(key=lambda row: (not row.get("default"), row["provider"]))
    return out


def _models_from_endpoint(endpoint: dict[str, Any]) -> list[str]:
    request = urllib.request.Request(
        f"{endpoint['base_url']}/models",
        headers={"accept": "application/json", "authorization": f"Bearer {endpoint['key']}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        log.debug("omniscience: listing models for %s failed: %s", endpoint["provider"], exc)
        return []
    items = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return []
    ids: list[str] = []
    for item in items:
        ident = item.get("id") if isinstance(item, dict) else item
        if isinstance(ident, str) and ident:
            ids.append(ident)
    return ids


def list_models(refresh: bool = False, db_path: str = "") -> dict[str, Any]:
    """Every model the configured providers offer, with one of them marked as the best default.

    "Best default" is not "the model Hermes uses": the report is a single call of a few thousand
    tokens, so the honest default is the cheapest one that has actually worked on this machine.
    The recording decides that — a model is only a candidate if it has completed calls here and
    never been rate-limited — and the price comes from the viewer's own list-rate table. A name
    nobody has called yet is still offered, just not recommended: a picker that hides it would be
    a picker that cannot be used for the model you just added.

    Cached for ten minutes; ``refresh`` re-asks every provider.
    """
    now = time.time()
    if not refresh and _models_cache["items"] and now - _models_cache["at"] < MODEL_CACHE_SECONDS:
        return {
            "models": _models_cache["items"],
            "unavailable": _models_cache["unavailable"],
            "cached": True,
        }

    default_cfg, _blocks = _config_providers(HERMES_HOME / "config.yaml")
    preferred = (default_cfg.get("default") or "").strip()
    proven = _proven_models(db_path)

    items: list[dict[str, Any]] = []
    unavailable: list[dict[str, str]] = []
    for endpoint in endpoints():
        ids = _models_from_endpoint(endpoint)
        if not ids:
            # A provider that cannot list its models is not a provider the operator has nothing
            # from: the recording shows which of its models actually ran. Offer those, and say
            # where they came from, so "any model you have access to" is still true.
            recorded = sorted({model for (provider, model) in proven if provider == endpoint["provider"]})
            if recorded:
                for ident in recorded:
                    items.append({
                        "provider": endpoint["provider"],
                        "model": ident,
                        "default": bool(preferred) and ident == preferred,
                        "working": True,
                        "from_recording": True,
                    })
                unavailable.append({
                    "provider": endpoint["provider"],
                    "reason": f"no model list; offering the {len(recorded)} model(s) your recordings show",
                })
                continue
            unavailable.append({"provider": endpoint["provider"], "reason": "did not answer a model list"})
            continue
        for ident in sorted(set(ids)):
            items.append(
                {
                    "provider": endpoint["provider"],
                    "model": ident,
                    "default": bool(preferred) and ident == preferred,
                    "working": proven.get((endpoint["provider"], ident)) is not None,
                }
            )

    best = _recommend(items, proven)
    for row in items:
        if best is not None and (row["provider"], row["model"]) == best[0]:
            row["recommended"] = True
            row["why"] = best[1]
    # Recommended first, then the model Hermes itself uses, then a stable order: the picker's
    # first row should be the one the operator would have chosen anyway.
    items.sort(
        key=lambda row: (
            not row.get("recommended"),
            not row.get("default"),
            row["provider"],
            row["model"],
        )
    )

    _models_cache.update({"at": now, "items": items, "unavailable": unavailable})
    return {"models": items, "unavailable": unavailable, "cached": False}


def _proven_models(db_path: str) -> dict[tuple[str, str], dict]:
    """Models with completed calls here, from the recording. A rate-limited one is not proven."""
    if not db_path:
        return {}
    try:
        rows = db_mod.latency_by_model(db_path)
    except Exception:  # noqa: BLE001 - a model list must survive an unreadable database
        log.debug("omniscience: reading the recording for a model recommendation failed", exc_info=True)
        return {}
    out: dict[tuple[str, str], dict] = {}
    for row in rows:
        calls = int(row.get("calls") or 0)
        if calls <= 0:
            continue
        # A handful of rate limits on a busy model is normal; a route that is mostly refusals
        # (`opencode-zen`, 0 calls against 10) is not a model to recommend however cheap it is.
        limited = int(row.get("rate_limited") or 0)
        if limited and limited / (calls + limited) > 0.2:
            continue
        out[(str(row.get("provider")), str(row.get("model")))] = row
    return out


def _recommend(
    items: list[dict[str, Any]],
    proven: dict[tuple[str, str], dict],
) -> Optional[tuple[tuple[str, str], str]]:
    """The cheapest model that has actually answered here, and the sentence explaining why."""
    candidates: list[tuple[float, int, tuple[str, str], str]] = []
    for row in items:
        key = (row["provider"], row["model"])
        seen = proven.get(key)
        if seen is None:
            continue
        name = row["model"].lower()
        calls = int(seen.get("calls") or 0)
        if "free" in name:
            candidates.append((0.0, -calls, key, "free, and it has answered calls here"))
            continue
        rates = usage_mod.rate_for(row["model"])
        if rates:
            blended = float(rates.get("in", 0)) + float(rates.get("out", 0))
            candidates.append((blended, -calls, key, f"cheapest known rate (${blended:.2f} per M tokens)"))
        else:
            candidates.append((99.0, -calls, key, "it has answered calls here; its price is not in the rate table"))
    if not candidates:
        return None
    candidates.sort()
    return candidates[0][2], candidates[0][3]


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


def ask(provider: str, model: str, days: float, db_path: str, state_db: Optional[str]) -> dict[str, Any]:
    """Send the digest to the chosen model and return its writeup."""
    chosen = next(
        (row for row in endpoints() if row["provider"] == provider),
        None,
    )
    if chosen is None:
        raise RuntimeError(f"{provider} has no credential this viewer can use")

    digest = build_digest(db_path, state_db, days)
    body = {
        "model": model,
        "temperature": 0.3,
        "max_tokens": 3200,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": digest},
        ],
    }
    request = urllib.request.Request(
        f"{chosen['base_url']}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "authorization": f"Bearer {chosen['key']}",
        },
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=ANSWER_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"{provider} answered {exc.code}: {detail}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"could not reach {provider}: {exc}") from exc
    except ValueError as exc:
        raise RuntimeError(f"{provider} did not return JSON: {exc}") from exc

    choices = payload.get("choices") if isinstance(payload, dict) else None
    first = (choices or [{}])[0] if isinstance(choices, list) and choices else {}
    message = first.get("message") if isinstance(first, dict) else None
    text = (message or {}).get("content") if isinstance(message, dict) else None
    if (not isinstance(text, str) or not text.strip()) and isinstance(message, dict):
        # Some local and reasoning-heavy models put everything in reasoning_content and leave
        # content empty when the thinking budget is spent. An answer is better than a
        # "returned an empty answer" that hides one.
        fallback = message.get("reasoning_content")
        text = fallback if isinstance(fallback, str) else text
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError(
            f"{provider} returned an empty answer (finish reason: {first.get('finish_reason') or 'unknown'})"
        )

    usage = payload.get("usage") if isinstance(payload, dict) else None
    return {
        "markdown": text.strip(),
        "model": payload.get("model") or model,
        "provider": provider,
        "days": days,
        "took_s": round(time.time() - started, 1),
        "finish_reason": first.get("finish_reason"),
        "usage": usage if isinstance(usage, dict) else {},
        "generated_at": time.time(),
        "digest_chars": len(digest),
    }
