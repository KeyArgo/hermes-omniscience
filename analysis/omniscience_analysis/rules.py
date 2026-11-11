"""Deterministic, stdlib-only anomaly-detection rules for omni.v1 events.

Events are plain dicts shaped like rows of the ``events`` table
(ARCHITECTURE.md section 3), with ``attrs`` already decoded to a dict.

Guarantees:
- pure: inputs are never mutated; no wall clock; no I/O;
- deterministic: output depends only on event content. Events are canonically
  ordered by ``(ts, rowid, event_id)`` before evaluation, so the input order of
  events with equal timestamps is irrelevant;
- every returned Finding cites at least one ``event_id``;
- missing fields make a rule skip that event — never substituted with 0.
"""

from __future__ import annotations

import json
import statistics
from dataclasses import dataclass, field
from typing import Any, Optional

_NEG = float("-inf")

END_KINDS_FOR_REQUEST = ("llm.response", "llm.error")


@dataclass(frozen=True)
class Config:
    """Thresholds for all rules (ROADMAP phase 3: configurable thresholds)."""

    repeated_tool_failure_threshold: int = 3
    loop_threshold: int = 5
    stall_s: float = 300.0
    slow_s: float = 60.0
    spike_factor: float = 3.0
    spike_min_samples: int = 3


@dataclass
class Finding:
    rule: str
    severity: str
    session_id: Optional[str]
    message: str
    event_ids: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def _val(event: dict, key: str) -> Any:
    """Value present only if non-None and (for strings) non-empty."""
    v = event.get(key)
    if v is None:
        return None
    if isinstance(v, str) and v == "":
        return None
    return v


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _attrs(event: dict) -> dict:
    a = event.get("attrs")
    if isinstance(a, dict):
        return a
    if isinstance(a, str):
        try:
            parsed = json.loads(a)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _sort_key(event: dict, idx: int) -> tuple:
    ts = _num(event.get("ts"))
    rowid = _num(event.get("rowid"))
    eid = event.get("event_id")
    return (
        ts if ts is not None else _NEG,
        rowid if rowid is not None else _NEG,
        eid if isinstance(eid, str) else "",
        idx,
    )


def _ids(events: list) -> list:
    return [e["event_id"] for e in events if isinstance(e.get("event_id"), str) and e["event_id"]]


def _finding_sort_key(f: Finding) -> tuple:
    return (f.rule, f.session_id or "", "|".join(f.event_ids), f.message)


# ---------------------------------------------------------------------------
# rules
# ---------------------------------------------------------------------------


def _repeated_tool_failure(evs: list, cfg: Config) -> list:
    groups: dict = {}
    for e in evs:
        if e.get("kind") != "tool.end" or e.get("status") != "error":
            continue
        sid = _val(e, "session_id")
        tool = _val(_attrs(e), "tool_name")
        if sid is None or tool is None:
            continue
        groups.setdefault((sid, tool), []).append(e)
    findings = []
    for (sid, tool), group in groups.items():
        if len(group) < cfg.repeated_tool_failure_threshold:
            continue
        ids = _ids(group)
        if not ids:
            continue
        findings.append(
            Finding(
                rule="repeated_tool_failure",
                severity="high",
                session_id=sid,
                message=(
                    f"tool '{tool}' ended with status=error {len(group)} time(s) "
                    f"(>= {cfg.repeated_tool_failure_threshold}) in session {sid}"
                ),
                event_ids=ids,
            )
        )
    return findings


def _loop(evs: list, cfg: Config) -> list:
    turns: dict = {}
    for e in evs:
        if e.get("kind") != "tool.end":
            continue
        tid = _val(e, "turn_id")
        if tid is None:
            continue
        attrs = _attrs(e)
        tool = _val(attrs, "tool_name")
        arg_names = attrs.get("arg_names")
        if tool is None or not isinstance(arg_names, list):
            continue
        key = (tool, tuple(sorted(str(a) for a in arg_names)))
        turns.setdefault(tid, []).append((key, e))
    findings = []
    for tid, stream in turns.items():
        run: list = []
        runs: list = []
        for item in stream + [None]:
            if item is not None and run and item[0] == run[-1][0]:
                run.append(item)
            else:
                if len(run) >= cfg.loop_threshold:
                    runs.append(list(run))
                run = [item] if item is not None else []
        for r in runs:
            ids = _ids([e for _, e in r])
            if not ids:
                continue
            tool, args = r[0][0]
            sid = _val(r[0][1], "session_id")
            findings.append(
                Finding(
                    rule="loop",
                    severity="high",
                    session_id=sid,
                    message=(
                        f"tool '{tool}' called {len(r)}x consecutively with identical "
                        f"arg_names {list(args)} in turn {tid}"
                    ),
                    event_ids=ids,
                )
            )
    return findings


def _stall(evs: list, cfg: Config) -> list:
    tss = [t for t in (_num(e.get("ts")) for e in evs) if t is not None]
    max_ts = max(tss) if tss else None

    open_starts: dict = {}
    # request event index (in canonical order) per (session, request)
    request_pos: dict = {}
    for idx, e in enumerate(evs):
        kind = e.get("kind")
        if kind == "session.start":
            sid = _val(e, "session_id")
            if sid is None:
                continue
            open_starts.setdefault(("session", sid, None), []).append(e)
        elif kind == "llm.request":
            sid = _val(e, "session_id")
            req = _val(e, "api_request_id")
            if sid is None or req is None:
                continue
            open_starts.setdefault(("llm", sid, req), []).append(e)
            request_pos.setdefault((sid, req), []).append(idx)
        elif kind == "session.end":
            sid = _val(e, "session_id")
            if sid is None:
                continue
            stack = open_starts.get(("session", sid, None))
            if stack:
                stack.pop(0)
        elif kind in END_KINDS_FOR_REQUEST:
            sid = _val(e, "session_id")
            req = _val(e, "api_request_id")
            if sid is None or req is None:
                continue
            stack = open_starts.get(("llm", sid, req))
            if stack:
                stack.pop(0)

    still_open = [entries for entries in open_starts.values() if entries]

    # An unanswered request followed by ANY later event in the same session was
    # not lost to a hang - the session carried on (cancelled/stopped), so it is
    # reported as ``unanswered_request``, not ``stall``.
    later_activity: set = set()
    if still_open:
        open_req_keys = {k for k in open_starts if k[0] == "llm" and open_starts[k]}
        sid_to_req_pos: dict = {}
        for (sid, req), positions in request_pos.items():
            if ("llm", sid, req) in open_req_keys:
                sid_to_req_pos.setdefault(sid, []).extend(positions)
        for positions in sid_to_req_pos.values():
            positions.sort()
        for idx, e in enumerate(evs):
            sid = _val(e, "session_id")
            positions = sid_to_req_pos.get(sid)
            if not positions:
                continue
            for pos in positions:
                if pos < idx:
                    later_activity.add(pos)

    findings = []
    for key, entries in open_starts.items():
        _, sid, req = key
        for e in entries:
            ts = _num(e.get("ts"))
            if ts is None:
                continue
            ids = _ids([e])
            if not ids:
                continue
            if req is None:
                # idle time: from the session's last event to the newest event,
                # so a long but still active session is not reported as stuck
                last = max(
                    (t for t in (_num(x.get("ts")) for x in evs if _val(x, "session_id") == sid) if t is not None),
                    default=ts,
                )
                age = None if max_ts is None else max_ts - last
                if age is None or age <= cfg.stall_s:
                    continue
                findings.append(
                    Finding(
                        rule="stall",
                        severity="medium",
                        session_id=sid,
                        message=(
                            f"session.start has no matching end and is {age:.1f}s older than the "
                            f"newest event (threshold {cfg.stall_s:.1f}s)"
                        ),
                        event_ids=ids,
                    )
                )
                continue
            positions = request_pos.get((sid, req), [])
            request_idx = positions[0] if positions else None
            age = max_ts - ts if max_ts is not None else None
            if age is None or age <= cfg.stall_s:
                continue
            if request_idx is not None and request_idx in later_activity:
                findings.append(
                    Finding(
                        rule="unanswered_request",
                        severity="low",
                        session_id=sid,
                        message=(
                            f"llm.request {req} got no answer, but the session "
                            f"carried on afterwards"
                        ),
                        event_ids=ids,
                    )
                )
                continue
            findings.append(
                Finding(
                    rule="stall",
                    severity="medium",
                    session_id=sid,
                    message=(
                        f"llm.request {req} has no matching end and is {age:.1f}s older than the "
                        f"newest event (threshold {cfg.stall_s:.1f}s)"
                    ),
                    event_ids=ids,
                )
            )
    return findings


def _slow_inference(evs: list, cfg: Config) -> list:
    findings = []
    for e in evs:
        if e.get("kind") != "llm.response":
            continue
        dur = _num(_attrs(e).get("duration_s"))
        if dur is None or dur <= cfg.slow_s:
            continue
        ids = _ids([e])
        if not ids:
            continue
        findings.append(
            Finding(
                rule="slow_inference",
                severity="low",
                session_id=_val(e, "session_id"),
                message=f"llm.response took {dur:.1f}s (> {cfg.slow_s:.1f}s)",
                event_ids=ids,
            )
        )
    return findings


def _token_spike(evs: list, cfg: Config) -> list:
    samples: dict = {}
    for e in evs:
        if e.get("kind") != "llm.response":
            continue
        sid = _val(e, "session_id")
        if sid is None:
            continue
        usage = _attrs(e).get("usage")
        if not isinstance(usage, dict):
            continue
        tokens = _num(usage.get("total_tokens"))
        if tokens is None:
            continue
        samples.setdefault(sid, []).append((e, tokens))
    findings = []
    for sid, pairs in samples.items():
        if len(pairs) < cfg.spike_min_samples:
            continue
        median = statistics.median(t for _, t in pairs)
        for e, tokens in pairs:
            if tokens <= cfg.spike_factor * median:
                continue
            ids = _ids([e])
            if not ids:
                continue
            findings.append(
                Finding(
                    rule="token_spike",
                    severity="medium",
                    session_id=sid,
                    message=(
                        f"usage.total_tokens {tokens:g} > {cfg.spike_factor:g}x session "
                        f"median {median:g} ({len(pairs)} samples)"
                    ),
                    event_ids=ids,
                )
            )
    return findings


def _lost_events(evs: list, cfg: Config) -> list:
    findings = []
    for e in evs:
        if e.get("kind") != "omni.dropped":
            continue
        ids = _ids([e])
        if not ids:
            continue
        count = _attrs(e).get("count")
        count_txt = f"count={count}" if count is not None else "count unknown"
        findings.append(
            Finding(
                rule="lost_events",
                severity="high",
                session_id=_val(e, "session_id"),
                message=f"omni.dropped marker present ({count_txt}): events were lost",
                event_ids=ids,
            )
        )

    # No seq-gap inference: seq is shared by every session in a gateway process, so a jump inside
    # one session's events is normally other sessions' activity, not loss (docs/DECISIONS.md).
    return findings


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def detect(events: list, cfg: Optional[Config] = None) -> list:
    """Run all rules over ``events`` (rows shaped like the events table).

    Returns a deterministic, sorted list of :class:`Finding`s. Each finding
    cites at least one ``event_id``.
    """
    cfg = cfg if cfg is not None else Config()
    events = [e for e in (events or []) if isinstance(e, dict)]
    evs = [e for _, e in sorted(enumerate(events), key=lambda p: _sort_key(p[1], p[0]))]

    findings: list = []
    findings += _repeated_tool_failure(evs, cfg)
    findings += _loop(evs, cfg)
    findings += _stall(evs, cfg)
    findings += _slow_inference(evs, cfg)
    findings += _token_spike(evs, cfg)
    findings += _lost_events(evs, cfg)

    findings.sort(key=_finding_sort_key)
    return findings
