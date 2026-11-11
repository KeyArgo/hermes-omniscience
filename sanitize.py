"""Allowlist normalizers and secret redaction for omni.v1 events.

Everything here is pure and bounded: it never touches the network, disk or
Hermes internals. The allowlist is the contract; unknown payload fields are
dropped by construction.
"""

from __future__ import annotations

import itertools
import re
import time
from urllib.parse import urlsplit

REDACTED = "[REDACTED]"

# Keys that may never appear in attrs, regardless of allowlist drift.
SENSITIVE_KEY = re.compile(
    r"(?:key|token|secret|password|passwd|auth|cookie|credential)", re.IGNORECASE
)

_TOKEN_SUBS = (
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"), REDACTED),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{8,}"), REDACTED),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"), REDACTED),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"), REDACTED),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), REDACTED),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), REDACTED),
    (re.compile(r"\bxox[bpoa]-[A-Za-z0-9-]{8,}"), REDACTED),
    (
        re.compile(
            r"(?i)\b(?:api[_-]?key|token|secret|password|passwd|auth|cookie|credential)"
            r"\b\s*[:=]\s*[^\s'\"&,;]+"
        ),
        REDACTED,
    ),
    (re.compile(r"(?i)([a-z][a-z0-9+.-]*://)[^/@\s]+@"), r"\1" + REDACTED + "@"),
)

# A query string belongs to a URL, so it is stripped only when the value looks like one. Run
# over every string it silently truncated ordinary values ("gpt?variant=2" became "gpt"), and
# on an id it broke the join the id exists for.
_URL_QUERY = re.compile(r"\?[^\s#]*")

_EXTRA_SUBS = (
    # JWTs: three base64url parts, the first two starting with "eyJ" ({")
    (re.compile(r"\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*"), REDACTED),
    # email addresses can identify a person
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), REDACTED),
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), REDACTED),
    (
        re.compile(
            r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])"
        ),
        REDACTED,
    ),
)


def _apply(text: str, subs) -> str:
    for pattern, repl in subs:
        text = pattern.sub(repl, text)
    return text


def redact(text, limit: int = 200) -> str:
    """Truncate free text and replace anything that looks like a credential."""
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    if limit is not None:
        # Bound regex work on the agent thread; keep slack so a secret cut at the edge is still matched.
        text = text[: limit * 4]
    text = _apply(text, _TOKEN_SUBS)
    if "://" in text:
        text = _URL_QUERY.sub("", text)
    text = _apply(text, _EXTRA_SUBS)
    if limit is not None:
        text = text[:limit]
    return text


def _sanitize_id(value):
    """IDs are opaque and must survive redaction of normal hex/base64 shapes."""
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    elif not isinstance(value, str):
        value = str(value)
    return _apply(value, _TOKEN_SUBS)


def host_only(url):
    if not isinstance(url, str) or not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if not parts.scheme or not parts.hostname:
        return None
    host = parts.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    try:
        port = parts.port
    except ValueError:
        port = None
    if port is not None:
        return f"{parts.scheme}://{host}:{port}"
    return f"{parts.scheme}://{host}"


HOOK_KINDS = {
    "on_session_start": "session.start",
    "on_session_end": "session.end",
    "pre_llm_call": "turn.start",
    "post_llm_call": "turn.end",
    "pre_api_request": "llm.request",
    "post_api_request": "llm.response",
    "api_request_error": "llm.error",
    "post_tool_call": "tool.end",
    "subagent_start": "subagent.start",
    "subagent_stop": "subagent.stop",
    "pre_auxiliary_call": "aux.request",
    "post_auxiliary_call": "aux.response",
    "on_skill_lifecycle": "skill.event",
}

USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "prompt_tokens",
    "total_tokens",
)

_ID_FIELDS = (
    "session_id",
    "parent_session_id",
    "turn_id",
    "api_request_id",
    "tool_call_id",
    "subagent_id",
)

# session.end can fire several times in a row; on Windows time_ns can repeat,
# so a process-wide counter keeps the natural key unique within this process.
_SESSION_END_COUNTER = itertools.count()


def _is_num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _char_count(value):
    """Length of text-like values only; anything else is omitted, never coerced."""
    if isinstance(value, (str, bytes)):
        return len(value)
    return None


def _item_count(value):
    """Length of list/tuple values only; anything else is omitted, never coerced."""
    if isinstance(value, (list, tuple)):
        return len(value)
    return None


def _is_sensitive_key(key: str) -> bool:
    # Token *counts* (max_tokens, approx_input_tokens) are metadata, not credentials.
    if key.endswith("_tokens"):
        return False
    return bool(SENSITIVE_KEY.search(key))


def _put(attrs: dict, key: str, value) -> None:
    if value is None:
        return
    if _is_sensitive_key(key):
        return
    if isinstance(value, str):
        attrs[key] = redact(value)
    elif _is_num(value) or isinstance(value, bool):
        attrs[key] = value
    # Anything else (dict, list, object) is dropped rather than stringified: the allowlist is
    # about scalars, and repr-ing a container is exactly how prompt / argument content would
    # sneak into the database through a field that is supposed to hold a name.


def _put_id(attrs: dict, key: str, value) -> None:
    """Opaque IDs in attrs: credential patterns only, no hex/base64 or length rules (they must still join)."""
    if value is not None:
        attrs[key] = value


def _ids(**values) -> dict:
    return {name: _sanitize_id(values.get(name)) for name in _ID_FIELDS}


def _subagent_id(kwargs: dict):
    task_id = kwargs.get("task_id")
    session_id = kwargs.get("session_id")
    if task_id and task_id != session_id:
        return _sanitize_id(task_id)
    return None


def _usage(raw):
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in USAGE_KEYS:
        value = raw.get(key)
        if _is_num(value):
            out[key] = value
    return out or None


def _error_fields(kwargs: dict, attrs: dict) -> None:
    error = kwargs.get("error")
    error_type = kwargs.get("error_type")
    error_message = kwargs.get("error_message")
    if isinstance(error, dict):
        if error_type is None:
            error_type = error.get("type")
        if error_message is None:
            error_message = error.get("message")
    _put(attrs, "error_type", error_type)
    # Metadata-only: error text can echo prompt or argument content, so only its length is kept.
    if isinstance(error_message, str):
        attrs["error_message_chars"] = len(error_message)


def _llm_key(ids: dict, kwargs: dict):
    api_id = ids.get("api_request_id")
    retry_count = kwargs.get("retry_count")
    if retry_count is None:
        return api_id
    retry = _sanitize_id(retry_count)
    if api_id is None:
        return None  # fall back to boot_id|seq — never collide two id-less calls
    return f"{api_id}|{retry}"


def _normalize_session_start(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    _put(attrs, "platform", kwargs.get("platform"))
    _put(attrs, "model", kwargs.get("model"))
    return ids, None, attrs, ids.get("session_id")


def _normalize_session_end(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        subagent_id=_subagent_id(kwargs),
    )
    completed = kwargs.get("completed")
    interrupted = kwargs.get("interrupted")
    if completed:
        status = "completed"
    elif interrupted:
        status = "interrupted"
    else:
        status = None
    attrs = {}
    _put(attrs, "completed", completed)
    _put(attrs, "interrupted", interrupted)
    session_id = ids.get("session_id")
    natural = (
        f"{session_id}|{time.time_ns()}|{next(_SESSION_END_COUNTER)}"
        if session_id is not None
        else None
    )
    return ids, status, attrs, natural


def _normalize_turn_start(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    _put(attrs, "platform", kwargs.get("platform"))
    _put(attrs, "model", kwargs.get("model"))
    _put(attrs, "is_first_turn", kwargs.get("is_first_turn"))
    user_chars = _char_count(kwargs.get("user_message"))
    if user_chars is not None:
        attrs["user_chars"] = user_chars
    return ids, None, attrs, ids.get("turn_id")


def _normalize_turn_end(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    _put(attrs, "model", kwargs.get("model"))
    assistant_chars = _char_count(kwargs.get("assistant_response"))
    if assistant_chars is not None:
        attrs["assistant_chars"] = assistant_chars
    return ids, None, attrs, ids.get("turn_id")


def _normalize_llm_request(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        api_request_id=kwargs.get("api_request_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    for key in (
        "model",
        "provider",
        "api_mode",
        "api_call_count",
        "retry_count",
        "message_count",
        "tool_count",
        "approx_input_tokens",
        "max_tokens",
        "started_at",
    ):
        _put(attrs, key, kwargs.get(key))
    return ids, None, attrs, _llm_key(ids, kwargs)


def _normalize_llm_response(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        api_request_id=kwargs.get("api_request_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    _put(attrs, "duration_s", kwargs.get("api_duration"))
    _put(attrs, "started_at", kwargs.get("started_at"))
    _put(attrs, "ended_at", kwargs.get("ended_at"))
    started = kwargs.get("started_at")
    first_chunk = kwargs.get("first_chunk_at")
    if _is_num(started) and _is_num(first_chunk):
        _put(attrs, "ttfb_s", first_chunk - started)
    _put(attrs, "finish_reason", kwargs.get("finish_reason"))
    _put(attrs, "response_model", kwargs.get("response_model"))
    usage = _usage(kwargs.get("usage"))
    if usage is not None:
        attrs["usage"] = usage
    _put(attrs, "tool_call_count", kwargs.get("assistant_tool_call_count"))
    return ids, "ok", attrs, _llm_key(ids, kwargs)


def _normalize_llm_error(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        api_request_id=kwargs.get("api_request_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    _put(attrs, "duration_s", kwargs.get("api_duration"))
    _put(attrs, "status_code", kwargs.get("status_code"))
    _put(attrs, "retryable", kwargs.get("retryable"))
    _put(attrs, "reason", kwargs.get("reason"))
    _error_fields(kwargs, attrs)
    return ids, "error", attrs, _llm_key(ids, kwargs)


def _normalize_tool_end(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        api_request_id=kwargs.get("api_request_id"),
        tool_call_id=kwargs.get("tool_call_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    tool_name = kwargs.get("tool_name")
    _put(attrs, "tool_name", tool_name)
    duration_ms = kwargs.get("duration_ms")
    _put(attrs, "duration_ms", duration_ms)
    if _is_num(duration_ms):
        _put(attrs, "started_at", time.time() - duration_ms / 1000.0)
    _error_fields(kwargs, attrs)
    args = kwargs.get("args")
    if isinstance(args, dict):
        attrs["arg_names"] = sorted(redact(str(name)) for name in args.keys())
    result = kwargs.get("result")
    if result is not None:
        if isinstance(result, (str, bytes)):
            attrs["result_chars"] = len(result)  # O(1); never stringify large objects on the agent thread
    server = _mcp_server(tool_name)
    if server is not None:
        _put(attrs, "mcp_server", server)
    status = _sanitize_id(kwargs.get("status"))
    tool_call_id = ids.get("tool_call_id")
    if tool_call_id:
        natural = tool_call_id
    elif ids.get("api_request_id") is not None:
        parts = [
            part
            for part in (
                ids.get("session_id"),
                ids.get("api_request_id"),
                redact(tool_name) if tool_name is not None else None,
            )
            if part is not None
        ]
        natural = "|".join(parts)
    else:
        natural = None  # fall back to boot_id|seq, keeping distinct calls distinct
    return ids, status, attrs, natural


def _normalize_subagent_start(kwargs):
    parent_session_id = _sanitize_id(kwargs.get("parent_session_id"))
    parent_turn_id = _sanitize_id(kwargs.get("parent_turn_id"))
    child_session_id = _sanitize_id(kwargs.get("child_session_id"))
    child_subagent_id = _sanitize_id(kwargs.get("child_subagent_id"))
    ids = _ids(
        session_id=parent_session_id,
        turn_id=parent_turn_id,
        subagent_id=child_subagent_id,
    )
    attrs = {}
    _put_id(attrs, "child_session_id", child_session_id)
    _put_id(attrs, "child_subagent_id", child_subagent_id)
    _put_id(attrs, "parent_turn_id", parent_turn_id)
    _put(attrs, "role", kwargs.get("child_role"))
    goal_chars = _char_count(kwargs.get("child_goal"))
    if goal_chars is not None:
        attrs["goal_chars"] = goal_chars
    return ids, None, attrs, child_session_id


def _normalize_subagent_stop(kwargs):
    parent_session_id = _sanitize_id(kwargs.get("parent_session_id"))
    child_session_id = _sanitize_id(kwargs.get("child_session_id"))
    ids = _ids(
        session_id=parent_session_id,
        subagent_id=_sanitize_id(kwargs.get("child_subagent_id")),
    )
    attrs = {}
    _put_id(attrs, "child_session_id", child_session_id)
    _put(attrs, "child_status", kwargs.get("child_status"))
    _put(attrs, "duration_ms", kwargs.get("duration_ms"))
    tool_count = _item_count(kwargs.get("tool_call_history"))
    if tool_count is not None:
        attrs["tool_count"] = tool_count
    return ids, _sanitize_id(kwargs.get("child_status")), attrs, child_session_id


def _aux_key(ids: dict, kwargs: dict):
    """Background calls retry under one api_request_id; key each attempt separately."""
    key = _llm_key(ids, kwargs)
    return f"aux|{key}" if key is not None else None


def _mcp_server(tool_name):
    """Extract the server segment from an MCP tool name, else None."""
    if not isinstance(tool_name, str):
        return None
    if tool_name.startswith("mcp__"):
        rest = tool_name[len("mcp__"):]
        return rest.split("__", 1)[0] or None
    if tool_name.startswith("mcp_"):
        rest = tool_name[len("mcp_"):]
        return rest.split("_", 1)[0] or None
    return None


def _normalize_aux_request(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        api_request_id=kwargs.get("api_request_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    for key in (
        "aux_task",
        "model",
        "provider",
        "api_mode",
        "retry_count",
        "message_count",
        "tool_count",
        "approx_input_tokens",
        "plugin_id",
    ):
        _put(attrs, key, kwargs.get(key))
    return ids, None, attrs, _aux_key(ids, kwargs)


def _normalize_aux_response(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        api_request_id=kwargs.get("api_request_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    for key in (
        "aux_task",
        "model",
        "provider",
        "finish_reason",
        "response_model",
        "error_type",
    ):
        _put(attrs, key, kwargs.get(key))
    _put(attrs, "duration_s", kwargs.get("api_duration"))
    _put(attrs, "started_at", kwargs.get("started_at"))
    _put(attrs, "ended_at", kwargs.get("ended_at"))
    usage = _usage(kwargs.get("usage"))
    if usage is not None:
        attrs["usage"] = usage
    status = "error" if kwargs.get("error_type") else "ok"
    return ids, status, attrs, _aux_key(ids, kwargs)


def _normalize_skill_lifecycle(kwargs):
    ids = _ids(
        session_id=kwargs.get("session_id"),
        parent_session_id=kwargs.get("parent_session_id"),
        turn_id=kwargs.get("turn_id"),
        subagent_id=_subagent_id(kwargs),
    )
    attrs = {}
    _put(attrs, "action", kwargs.get("action"))
    skill_name = kwargs.get("skill_name")
    if skill_name is not None:
        attrs["skill_name"] = redact(skill_name)
    _put(attrs, "use_count", kwargs.get("use_count"))
    _put(attrs, "reused", kwargs.get("reused"))
    return ids, None, attrs, None  # boot_id|seq: every skill event is its own row



_NORMALIZERS = {
    "on_session_start": _normalize_session_start,
    "on_session_end": _normalize_session_end,
    "pre_llm_call": _normalize_turn_start,
    "post_llm_call": _normalize_turn_end,
    "pre_api_request": _normalize_llm_request,
    "post_api_request": _normalize_llm_response,
    "api_request_error": _normalize_llm_error,
    "post_tool_call": _normalize_tool_end,
    "subagent_start": _normalize_subagent_start,
    "subagent_stop": _normalize_subagent_stop,
    "pre_auxiliary_call": _normalize_aux_request,
    "post_auxiliary_call": _normalize_aux_response,
    "on_skill_lifecycle": _normalize_skill_lifecycle,
}


def normalize(hook_name, kwargs):
    """Return (kind, ids, status, attrs, natural_key) or None."""
    if not isinstance(kwargs, dict):
        return None
    normalizer = _NORMALIZERS.get(hook_name)
    if normalizer is None:
        return None
    ids, status, attrs, natural_key = normalizer(kwargs)
    if ids.get("session_id") is None:
        return None
    return HOOK_KINDS[hook_name], ids, status, attrs, natural_key
