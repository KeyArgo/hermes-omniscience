#!/usr/bin/env python3
"""Synthetic Omniscience event generator (demo/synth.py).

Creates an events DB with the schema from ARCHITECTURE.md §3 and writes a
realistic, fully deterministic synthetic Hermes run.

Usage:
    python demo/synth.py OUT.db [--live]

``--live`` inserts the events one at a time with a 0.3 s pause so the viewer's
live WebSocket can be demonstrated against a growing DB.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sqlite3
import time
from typing import Any

from ddl import DDL

SCHEMA_VERSION = "omni.v1"
BOOT_ID = "b007000000000000000000000000beef"
BASE_TS = 1_760_000_000.0

ROOT = "local-" + "a1b2c3d4" * 8
ROOT2 = "local-" + "5e6f7a8b" * 8
CHILD = "20261105_234903_b11152"
CHILD_SUBAGENT_ID = "sa-0-2ad31b82"

T1 = ROOT + ":" + ROOT + ":1a2b3c4d"
T2 = ROOT + ":" + ROOT + ":5e6f7a8b"
CT1 = CHILD + ":" + CHILD_SUBAGENT_ID + ":9c0d1e2f"
BT1 = ROOT2 + ":" + ROOT2 + ":77112233"

A1 = T1 + ":api:1"
A2 = T1 + ":api:2"
A3 = T2 + ":api:1"
CA1 = CT1 + ":api:1"
BA1 = BT1 + ":api:1"

MODEL = "deepseek-v4.1-flash-1017"
MODEL_B = "glm-4.6"

KINDS = (
    "session.start",
    "session.end",
    "turn.start",
    "turn.end",
    "llm.request",
    "llm.response",
    "llm.error",
    "tool.end",
    "subagent.start",
    "subagent.stop",
    "omni.dropped",
)

_COLUMNS = (
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


def make_event_id(kind: str, natural_key: str) -> str:
    return hashlib.sha256((kind + "|" + natural_key).encode("utf-8")).hexdigest()[:32]


class _Builder:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self._seq = 0
        self._t = BASE_TS

    def advance(self, dt: float) -> float:
        self._t += dt
        return self._t

    def add(
        self,
        ts: float,
        kind: str,
        natural_key: str,
        *,
        session_id: str | None = None,
        parent_session_id: str | None = None,
        turn_id: str | None = None,
        api_request_id: str | None = None,
        tool_call_id: str | None = None,
        subagent_id: str | None = None,
        status: str | None = None,
        attrs: dict[str, Any] | None = None,
        seq_jump: int = 0,
    ) -> None:
        self._seq += 1 + seq_jump
        self.events.append(
            {
                "event_id": make_event_id(kind, natural_key),
                "schema": SCHEMA_VERSION,
                "boot_id": BOOT_ID,
                "seq": self._seq,
                "ts": round(ts, 6),
                "kind": kind,
                "session_id": session_id,
                "parent_session_id": parent_session_id,
                "turn_id": turn_id,
                "api_request_id": api_request_id,
                "tool_call_id": tool_call_id,
                "subagent_id": subagent_id,
                "status": status,
                "attrs": json.dumps(attrs or {}, sort_keys=True),
            }
        )


def build_events() -> list[dict]:
    """Build the deterministic synthetic event list."""
    rnd = random.Random(20261105)
    b = _Builder()

    # ---------------------------------------------------------------- root A
    ts = b.advance(0.5)
    b.add(
        ts,
        "session.start",
        ROOT,
        session_id=ROOT,
        attrs={"platform": "cli", "model": MODEL},
    )

    # Turn 1: first LLM round, two tools, second LLM round.
    ts_t1 = b.advance(1.2)
    b.add(
        ts_t1,
        "turn.start",
        T1,
        session_id=ROOT,
        turn_id=T1,
        attrs={
            "platform": "cli",
            "model": MODEL,
            "is_first_turn": True,
            "user_chars": 42,
        },
    )

    ts_req1 = b.advance(0.1)
    b.add(
        ts_req1,
        "llm.request",
        A1 + "|0",
        session_id=ROOT,
        turn_id=T1,
        api_request_id=A1,
        attrs={
            "model": MODEL,
            "provider": "deepseek",
            "api_mode": "chat",
            "api_call_count": 1,
            "retry_count": 0,
            "message_count": 2,
            "tool_count": 0,
            "approx_input_tokens": 1180,
            "max_tokens": 4096,
            "started_at": ts_req1,
        },
    )
    ts_resp1 = b.advance(0.9)
    b.add(
        ts_resp1,
        "llm.response",
        A1 + "|0",
        session_id=ROOT,
        turn_id=T1,
        api_request_id=A1,
        status="ok",
        attrs={
            "duration_s": 0.91,
            "started_at": ts_req1,
            "ended_at": ts_resp1,
            "ttfb_s": 0.22,
            "finish_reason": "tool_calls",
            "response_model": MODEL,
            "usage": {
                "input_tokens": 1180,
                "output_tokens": 64,
                "cache_read_tokens": 1024,
                "total_tokens": 1244,
            },
            "tool_call_count": 2,
        },
    )

    ts_tool1 = b.advance(0.4)
    b.add(
        ts_tool1,
        "tool.end",
        "call_7132a1b2c3d4",
        session_id=ROOT,
        turn_id=T1,
        api_request_id=A1,
        tool_call_id="call_7132a1b2c3d4",
        status="ok",
        attrs={
            "tool_name": "terminal",
            "duration_ms": 420,
            "started_at": round(ts_tool1 - 0.42, 6),
            "arg_names": ["command"],
            "result_chars": 128,
        },
    )
    ts_tool2 = b.advance(0.2)
    b.add(
        ts_tool2,
        "tool.end",
        "call_7132e5f6a7b8",
        session_id=ROOT,
        turn_id=T1,
        api_request_id=A1,
        tool_call_id="call_7132e5f6a7b8",
        status="error",
        attrs={
            "tool_name": "read_file",
            "duration_ms": 12,
            "started_at": round(ts_tool2 - 0.012, 6),
            "arg_names": ["path"],
            "error_type": "FileNotFoundError",
        },
    )

    ts_req2 = b.advance(0.1)
    b.add(
        ts_req2,
        "llm.request",
        A2 + "|0",
        session_id=ROOT,
        turn_id=T1,
        api_request_id=A2,
        attrs={
            "model": MODEL,
            "provider": "deepseek",
            "api_mode": "chat",
            "api_call_count": 2,
            "retry_count": 0,
            "message_count": 4,
            "tool_count": 2,
            "approx_input_tokens": 1810,
            "max_tokens": 4096,
            "started_at": ts_req2,
        },
    )
    ts_resp2 = b.advance(1.4)
    b.add(
        ts_resp2,
        "llm.response",
        A2 + "|0",
        session_id=ROOT,
        turn_id=T1,
        api_request_id=A2,
        status="ok",
        attrs={
            "duration_s": 1.37,
            "started_at": ts_req2,
            "ended_at": ts_resp2,
            "ttfb_s": 0.31,
            "finish_reason": "stop",
            "response_model": MODEL,
            "usage": {
                "input_tokens": 1810,
                "output_tokens": 212,
                "cache_read_tokens": 1600,
                "total_tokens": 2022,
            },
            "tool_call_count": 0,
        },
    )
    b.add(
        b.advance(0.2),
        "turn.end",
        T1,
        session_id=ROOT,
        turn_id=T1,
        attrs={"model": MODEL, "assistant_chars": 210},
    )

    # Turn 2: an error + retry, then a delegated child session.
    ts_t2 = b.advance(1.5)
    b.add(
        ts_t2,
        "turn.start",
        T2,
        session_id=ROOT,
        turn_id=T2,
        attrs={
            "platform": "cli",
            "model": MODEL,
            "is_first_turn": False,
            "user_chars": 88,
        },
    )

    ts_req3 = b.advance(0.1)
    b.add(
        ts_req3,
        "llm.request",
        A3 + "|0",
        session_id=ROOT,
        turn_id=T2,
        api_request_id=A3,
        attrs={
            "model": MODEL,
            "provider": "deepseek",
            "api_mode": "chat",
            "api_call_count": 1,
            "retry_count": 0,
            "message_count": 2,
            "tool_count": 0,
            "approx_input_tokens": 760,
            "max_tokens": 4096,
            "started_at": ts_req3,
        },
    )
    ts_err = b.advance(1.1)
    b.add(
        ts_err,
        "llm.error",
        A3 + "|0",
        session_id=ROOT,
        turn_id=T2,
        api_request_id=A3,
        status="error",
        attrs={
            "duration_s": 1.08,
            "status_code": 429,
            "retryable": True,
            "reason": "rate_limit",
            "error_type": "RateLimitError",
            "error_message": "Rate limit exceeded, retrying after backoff",
        },
    )
    ts_req3b = b.advance(0.1)
    b.add(
        ts_req3b,
        "llm.request",
        A3 + "|1",
        session_id=ROOT,
        turn_id=T2,
        api_request_id=A3,
        attrs={
            "model": MODEL,
            "provider": "deepseek",
            "api_mode": "chat",
            "api_call_count": 2,
            "retry_count": 1,
            "message_count": 2,
            "tool_count": 0,
            "approx_input_tokens": 760,
            "max_tokens": 4096,
            "started_at": ts_req3b,
        },
    )
    ts_resp3 = b.advance(1.2)
    b.add(
        ts_resp3,
        "llm.response",
        A3 + "|1",
        session_id=ROOT,
        turn_id=T2,
        api_request_id=A3,
        status="ok",
        attrs={
            "duration_s": 1.16,
            "started_at": ts_req3b,
            "ended_at": ts_resp3,
            "ttfb_s": 0.28,
            "finish_reason": "tool_calls",
            "response_model": MODEL,
            "usage": {
                "input_tokens": 760,
                "output_tokens": 41,
                "total_tokens": 801,
            },
            "tool_call_count": 1,
        },
    )

    b.add(
        b.advance(0.5),
        "subagent.start",
        CHILD,
        session_id=ROOT,
        turn_id=T2,
        subagent_id=CHILD_SUBAGENT_ID,
        attrs={
            "child_session_id": CHILD,
            "child_subagent_id": CHILD_SUBAGENT_ID,
            "parent_turn_id": T2,
            "role": "researcher",
            "goal_chars": 150,
        },
    )

    # Child session events.
    ts_child_start = b.advance(0.1)
    b.add(
        ts_child_start,
        "session.start",
        CHILD,
        session_id=CHILD,
        parent_session_id=ROOT,
        attrs={"platform": "subagent", "model": MODEL},
    )
    ts_ct = b.advance(0.2)
    b.add(
        ts_ct,
        "turn.start",
        CT1,
        session_id=CHILD,
        parent_session_id=ROOT,
        turn_id=CT1,
        attrs={
            "platform": "subagent",
            "model": MODEL,
            "is_first_turn": True,
            "user_chars": 150,
        },
    )
    ts_creq = b.advance(0.1)
    b.add(
        ts_creq,
        "llm.request",
        CA1 + "|0",
        session_id=CHILD,
        parent_session_id=ROOT,
        turn_id=CT1,
        api_request_id=CA1,
        attrs={
            "model": MODEL,
            "provider": "deepseek",
            "api_mode": "chat",
            "api_call_count": 1,
            "retry_count": 0,
            "message_count": 2,
            "tool_count": 1,
            "approx_input_tokens": 940,
            "max_tokens": 4096,
            "started_at": ts_creq,
        },
    )
    ts_cresp = b.advance(1.0)
    b.add(
        ts_cresp,
        "llm.response",
        CA1 + "|0",
        session_id=CHILD,
        parent_session_id=ROOT,
        turn_id=CT1,
        api_request_id=CA1,
        status="ok",
        attrs={
            "duration_s": 0.97,
            "started_at": ts_creq,
            "ended_at": ts_cresp,
            "ttfb_s": 0.25,
            "finish_reason": "tool_calls",
            "response_model": MODEL,
            "usage": {
                "input_tokens": 940,
                "output_tokens": 58,
                "total_tokens": 998,
            },
            "tool_call_count": 1,
        },
    )
    ts_ctool = b.advance(0.3)
    b.add(
        ts_ctool,
        "tool.end",
        "call_8821ffee0011",
        session_id=CHILD,
        parent_session_id=ROOT,
        turn_id=CT1,
        api_request_id=CA1,
        tool_call_id="call_8821ffee0011",
        status="ok",
        attrs={
            "tool_name": "web_search",
            "duration_ms": 600,
            "started_at": round(ts_ctool - 0.6, 6),
            "arg_names": ["query"],
            "result_chars": 512,
        },
    )
    b.add(
        b.advance(0.1),
        "turn.end",
        CT1,
        session_id=CHILD,
        parent_session_id=ROOT,
        turn_id=CT1,
        attrs={"model": MODEL, "assistant_chars": 180},
    )
    ts_child_end = b.advance(0.1)
    b.add(
        ts_child_end,
        "session.end",
        CHILD + "|" + str(round(ts_child_end, 6)),
        session_id=CHILD,
        parent_session_id=ROOT,
        status="completed",
        attrs={"completed": True, "interrupted": False},
    )

    # Queue overflow lost seq 22-24; the marker reports the gap.
    b.add(
        b.advance(0.05),
        "omni.dropped",
        BOOT_ID + "|dropped",
        attrs={"count": 3, "since_seq": 22},
        seq_jump=3,
    )

    b.add(
        b.advance(0.4),
        "subagent.stop",
        CHILD,
        session_id=ROOT,
        turn_id=T2,
        subagent_id=CHILD_SUBAGENT_ID,
        status="completed",
        attrs={
            "child_session_id": CHILD,
            "child_status": "completed",
            "duration_ms": 2900,
            "tool_count": 1,
        },
    )
    b.add(
        b.advance(0.2),
        "turn.end",
        T2,
        session_id=ROOT,
        turn_id=T2,
        attrs={"model": MODEL, "assistant_chars": 96},
    )
    ts_end = b.advance(0.3)
    b.add(
        ts_end,
        "session.end",
        ROOT + "|" + str(round(ts_end, 6)),
        session_id=ROOT,
        status="completed",
        attrs={"completed": True, "interrupted": False},
    )

    # ----------------------------------------------------------- smaller root B
    ts_b = b.advance(5.0)
    b.add(
        ts_b,
        "session.start",
        ROOT2,
        session_id=ROOT2,
        attrs={"platform": "cli", "model": MODEL_B},
    )
    ts_bt = b.advance(0.5)
    b.add(
        ts_bt,
        "turn.start",
        BT1,
        session_id=ROOT2,
        turn_id=BT1,
        attrs={
            "platform": "cli",
            "model": MODEL_B,
            "is_first_turn": True,
            "user_chars": 31,
        },
    )
    ts_breq = b.advance(0.1)
    b.add(
        ts_breq,
        "llm.request",
        BA1 + "|0",
        session_id=ROOT2,
        turn_id=BT1,
        api_request_id=BA1,
        attrs={
            "model": MODEL_B,
            "provider": "zai",
            "api_mode": "chat",
            "api_call_count": 1,
            "retry_count": 0,
            "message_count": 2,
            "tool_count": 0,
            "approx_input_tokens": 320,
            "max_tokens": 2048,
            "started_at": ts_breq,
        },
    )
    ts_bresp = b.advance(0.8)
    b.add(
        ts_bresp,
        "llm.response",
        BA1 + "|0",
        session_id=ROOT2,
        turn_id=BT1,
        api_request_id=BA1,
        status="ok",
        attrs={
            "duration_s": 0.77,
            "started_at": ts_breq,
            "ended_at": ts_bresp,
            "ttfb_s": 0.19,
            "finish_reason": "stop",
            "response_model": MODEL_B,
            "usage": {
                "input_tokens": 320,
                "output_tokens": 42,
                "total_tokens": 362,
            },
            "tool_call_count": 0,
        },
    )
    b.add(
        b.advance(0.1),
        "turn.end",
        BT1,
        session_id=ROOT2,
        turn_id=BT1,
        attrs={"model": MODEL_B, "assistant_chars": 42},
    )
    ts_bend = b.advance(0.2)
    b.add(
        ts_bend,
        "session.end",
        ROOT2 + "|" + str(round(ts_bend, 6)),
        session_id=ROOT2,
        status="completed",
        attrs={"completed": True, "interrupted": False},
    )

    # Keep the RNG referenced so the fixed seed is explicit and stable.
    _ = rnd.random()
    return b.events


def _insert(con: sqlite3.Connection, events: list[dict]) -> None:
    placeholders = ", ".join("?" for _ in _COLUMNS)
    sql = f"INSERT OR IGNORE INTO events ({', '.join(_COLUMNS)}) VALUES ({placeholders})"
    con.executemany(sql, [tuple(event[c] for c in _COLUMNS) for event in events])


def build_showcase_events() -> list[dict]:
    """Add a longer, deterministic chat to the small regression fixture for the demo viewer."""
    events = build_events()
    b = _Builder()
    b._seq = max(event['seq'] for event in events)
    b._t = max(event['ts'] for event in events) + 60
    root = 'local-' + 'decafbad' * 8
    turn = root + ':' + root + ':showcase'
    b.add(b.advance(0.1), 'session.start', root, session_id=root,
          attrs={'platform': 'cli', 'model': MODEL})
    b.add(b.advance(0.1), 'turn.start', turn, session_id=root, turn_id=turn,
          attrs={'platform': 'cli', 'model': MODEL, 'is_first_turn': True, 'user_chars': 100})
    for i in range(60):
        request = f'{turn}:api:{i + 1}'
        prompt = 4000 + i * 700 if i < 36 else 9000 + (i - 36) * 700
        started = b.advance(0.1)
        b.add(started, 'llm.request', request, session_id=root, turn_id=turn,
              api_request_id=request, attrs={'model': MODEL, 'provider': 'deepseek',
              'api_call_count': i + 1, 'approx_input_tokens': prompt, 'started_at': started})
        ended = b.advance(0.8)
        b.add(ended, 'llm.response', request, session_id=root, turn_id=turn,
              api_request_id=request, status='ok', attrs={'started_at': started, 'ended_at': ended,
              'duration_s': 0.8, 'response_model': MODEL, 'finish_reason': 'tool_calls',
              'usage': {'input_tokens': prompt, 'output_tokens': 120, 'total_tokens': prompt + 120}})
        if i == 20:
            # A browser run, so the privacy alert has something real to show in the demo.
            tool = 'showcase-browser-20'
            b.add(b.advance(0.4), 'tool.end', tool, session_id=root, turn_id=turn,
                  api_request_id=request, tool_call_id=tool, status='ok',
                  attrs={'tool_name': 'browser_exec', 'duration_ms': 400, 'result_chars': 220})
        if i in (12, 28, 48):
            tool = f'showcase-tool-{i}'
            failed = i == 28
            b.add(b.advance(0.2), 'tool.end', tool, session_id=root, turn_id=turn,
                  api_request_id=request, tool_call_id=tool, status='error' if failed else 'ok',
                  attrs={'tool_name': 'read_file' if failed else 'terminal', 'duration_ms': 200,
                         **({'error_type': 'FileNotFoundError'} if failed else {'result_chars': 128})})
    b.add(b.advance(0.1), 'turn.end', turn, session_id=root, turn_id=turn,
          attrs={'model': MODEL, 'assistant_chars': 300})
    b.add(b.advance(0.1), 'session.end', root, session_id=root, status='completed',
          attrs={'completed': True, 'interrupted': False})
    return events + b.events


def _fresh(path: str) -> None:
    for candidate in (path, path + "-wal", path + "-shm"):
        try:
            os.remove(candidate)
        except FileNotFoundError:
            pass


def _create(con: sqlite3.Connection) -> None:
    con.executescript(DDL)
    con.executemany(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        [("schema_version", SCHEMA_VERSION), ("created_at", str(BASE_TS))],
    )


def write_db(path: str, events: list[dict]) -> None:
    """Create *path* from scratch and write all events."""
    _fresh(path)
    con = sqlite3.connect(path)
    try:
        _create(con)
        _insert(con, events)
        con.commit()
    finally:
        con.close()


def write_db_live(path: str, events: list[dict], delay: float = 0.3) -> None:
    """Create *path* and append events one at a time with a pause."""
    _fresh(path)
    con = sqlite3.connect(path)
    try:
        _create(con)
        con.commit()
        for event in events:
            _insert(con, [event])
            con.commit()
            time.sleep(delay)
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a synthetic Omniscience events DB.")
    parser.add_argument("out", help="output SQLite DB path")
    parser.add_argument(
        "--live",
        action="store_true",
        help="append events one by one with a 0.3 s delay",
    )
    args = parser.parse_args(argv)

    events = build_events()
    if args.live:
        write_db_live(args.out, events)
    else:
        write_db(args.out, events)
    print(f"wrote {len(events)} events to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
