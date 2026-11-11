"""Event contract for omni.v1."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

SCHEMA_VERSION = "omni.v1"

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

COLUMNS = (
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


@dataclass
class Event:
    event_id: str
    schema: str
    boot_id: str
    seq: int
    ts: float
    kind: str
    session_id: str | None = None
    parent_session_id: str | None = None
    turn_id: str | None = None
    api_request_id: str | None = None
    tool_call_id: str | None = None
    subagent_id: str | None = None
    status: str | None = None
    attrs: dict = field(default_factory=dict)


def make_event_id(kind: str, natural_key: str) -> str:
    return hashlib.sha256(f"{kind}|{natural_key}".encode("utf-8")).hexdigest()[:32]
