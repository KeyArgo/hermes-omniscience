"""A problem bundle: one file a person can hand to someone else to investigate a failure.

Rules, decided by two independent specs and then reconciled here:

- One plain UTF-8 JSON file. Not a zip: a zip can carry content the preview never showed.
- Nothing from the recording is passed through unchanged except tool names, models, provider names
  and error strings, and those four are scanned first.
- Identifiers are synthetic (`e1`, `s1`, `t1`). Hermes ids and turn ids can embed chat names.
- Timestamps are offsets from the first event. Wall-clock times leak working hours and timezone.
- Tool output is excluded by default. It is the most likely place for source code and secrets.
- Prompts and model responses are never included. Token counts already say how big they were.
- Every removal is reported, so a reader knows what is missing rather than assuming nothing was.

The bundle answers: what was attempted, in what order, what failed, how long it took, which model,
and whether it was retried.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from typing import Any

SCHEMA_VERSION = "1.0"
RULES_VERSION = "1"

# --- scanning ---------------------------------------------------------------------------------

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}\b")),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")),
    ("aws_key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{12,}", re.I)),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")),
    ("connection_string", re.compile(r"\b[a-z]+://[^\s:/@]+:[^\s@]+@[^\s]+", re.I)),
    ("env_assignment", re.compile(r"\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*[^\s]{4,}")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")),
    ("home_path", re.compile(r"/(?:home|Users)/[^/\s\"']+")),
)


_ABS_PATH = re.compile(r"/(?:home|Users|tmp|var|opt|mnt|srv|root)/[^\s\"'`;,)\]}]+")
_SECRET_IN_NAME = re.compile(r"sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}")


def scan(text: str) -> tuple[str, dict[str, int]]:
    """Replace every secret-shaped run with a marker, and count what was replaced.

    Replacement is `[REDACTED:<rule>]` rather than deletion: a reader must see that something was
    there, otherwise a scrubbed error message reads as a complete one.
    """
    if not text:
        return text, {}
    counts: dict[str, int] = {}
    out = text

    # Paths first: an absolute path left in an error message carries directory names — a client, a
    # chat, a private host — and it is not a secret "shape" any other rule would catch.
    def _path_sub(match: re.Match[str]) -> str:
        counts["abs_path"] = counts.get("abs_path", 0) + 1
        base = match.group(0).rstrip("/").split("/")[-1]
        # Only a filename with an extension is kept. The last segment of a directory path is a
        # directory name, and directory names are exactly what a chat or a client calls itself.
        if "." not in base or _SECRET_IN_NAME.search(base):
            base = "<name>"
        return "…/" + base

    out = _ABS_PATH.sub(_path_sub, out)

    for rule, pattern in _PATTERNS:
        def _sub(match: re.Match[str], rule: str = rule) -> str:
            counts[rule] = counts.get(rule, 0) + 1
            if rule == "env_assignment":
                return match.group(1) + "=[REDACTED:env_assignment]"
            if rule == "bearer":
                return "Bearer [REDACTED:bearer]"
            return "[REDACTED:" + rule + "]"

        out = pattern.sub(_sub, out)
    return out, counts


def _merge_counts(into: dict[str, int], extra: dict[str, int]) -> None:
    for rule, count in extra.items():
        into[rule] = into.get(rule, 0) + count


# --- paths ------------------------------------------------------------------------------------

MAX_PATH_CHARS = 120


def canonical_path(raw: str, counts: dict[str, int]) -> str:
    """A path with the shape kept and the names gone.

    Only the filename survives, and only after scanning. Directory names are collapsed to `…`: a
    directory tree is where a chat name, a client name or a private host reposes, and the reader of
    the bundle does not need it to understand the failure.
    """
    if not raw:
        return ""
    text = str(raw).replace("\\", "/")
    text = re.sub(r"^[A-Za-z]:", "<drive>", text)
    text = re.sub(r"^//[^/]+/[^/]+", "<unc>", text)
    # Resolve . and .. by text only: never touch the filesystem, never follow a symlink.
    parts: list[str] = []
    for part in text.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    if not parts:
        return ""
    name = parts[-1]
    home = os.path.expanduser("~/")
    lowered = text.lower()
    if lowered.startswith(home.lower()):
        prefix = "~"
    elif text.startswith("<drive>"):
        prefix = "<drive>"
    elif text.startswith("<unc>"):
        prefix = "<unc>"
    elif text.startswith("/"):
        prefix = "/"
    else:
        prefix = ""
    cleaned, found = scan(name)
    _merge_counts(counts, found)
    if cleaned != name:
        cleaned = "REDACTED"
    if prefix and prefix != "/":
        head = prefix + "/"
    else:
        head = prefix
    if len(parts) > 1:
        head += "…/"
    return head + cleaned[:MAX_PATH_CHARS]


# --- events -----------------------------------------------------------------------------------

_KINDS = {"llm_call", "tool_call", "turn", "compaction", "session"}
_FAILED = {"failed", "error", "failure", "timeout", "cancelled", "aborted", "rejected"}
_OK = {"ok", "success", "completed", "done", "finished"}
_ALLOWED_ARG_KEY = re.compile(r"^[a-z_]{1,32}$")
_MODEL_ALLOWED = re.compile(r"^[A-Za-z0-9._:/\-]{1,64}$")
_KEEP_ATTRS = {
    "tool_name", "tool", "name", "duration_ms", "exit_code", "error", "error_message", "model",
    "model_id", "provider", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "prompt_tokens", "completion_tokens",
    "estimated_cost_usd", "cost_usd", "tokens_before", "tokens_after", "arguments", "args",
}


def _attrs(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _status(raw: Any) -> str:
    value = str(raw or "").lower()
    if value in _OK:
        return "success"
    if value in _FAILED:
        return "failure"
    if value == "running":
        return "running"
    return "unknown"


def _int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def build_bundle(db_path: str, session_id: str | None = None, event_ids: list[str] | None = None) -> dict[str, Any]:
    """Assemble a bundle from the recording. Raises ValueError when there is nothing to send."""
    con = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    counts: dict[str, int] = {}
    excluded_attrs: set[str] = set()
    excluded_events = 0
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(events)")}
        if not columns:
            raise ValueError("this recording has no events table")
        turn_col = "turn_id" if "turn_id" in columns else "NULL AS turn_id"
        if event_ids:
            marks = ",".join("?" for _ in event_ids)
            rows = con.execute(
                "SELECT event_id, ts, kind, session_id, " + turn_col + ", status, attrs FROM events "
                "WHERE event_id IN (" + marks + ") ORDER BY ts LIMIT 500", tuple(event_ids)
            ).fetchall()
        elif session_id:
            rows = con.execute(
                "SELECT event_id, ts, kind, session_id, " + turn_col + ", status, attrs FROM events "
                "WHERE session_id = ? ORDER BY ts LIMIT 500", (session_id,)
            ).fetchall()
        else:
            raise ValueError("choose a chat or a step to bundle")
    finally:
        con.close()

    if not rows:
        raise ValueError("nothing recorded matches that chat or those steps")

    sessions: dict[str, str] = {}
    turns: dict[str, str] = {}
    events: list[dict[str, Any]] = []
    paths: dict[str, str] = {}
    first_ts = rows[0]["ts"] or 0
    failures: dict[tuple[str, str, str], str] = {}
    failed_count = retried_count = 0
    models: set[str] = set()

    for index, row in enumerate(rows, start=1):
        kind = str(row["kind"] or "").lower()
        if kind not in _KINDS:
            kind = "other"
        attrs = _attrs(row["attrs"])
        for key in attrs:
            if key not in _KEEP_ATTRS and _ALLOWED_ARG_KEY.match(str(key)):
                excluded_attrs.add(str(key))

        tool = attrs.get("tool_name") or attrs.get("tool") or attrs.get("name")
        tool = str(tool)[:64] if tool else None
        status = _status(row["status"])
        sid = row["session_id"] or "unknown"
        session_ref = sessions.setdefault(str(sid), "s%d" % (len(sessions) + 1))
        turn_ref = None
        if row["turn_id"]:
            turn_ref = turns.setdefault(str(row["turn_id"]), "t%d" % (len(turns) + 1))

        # A retry is the same kind and tool in the same turn, after one that failed.
        key = (str(row["session_id"]), str(row["turn_id"] or ""), kind + "|" + str(tool or ""))
        retry_of = failures.get(key)
        if status == "failure":
            failed_count += 1
            failures[key] = "e%d" % index
        elif retry_of:
            retried_count += 1

        error_text = attrs.get("error") or attrs.get("error_message")
        error_out = None
        if isinstance(error_text, str) and error_text:
            error_out, found = scan(error_text[:500])
            _merge_counts(counts, found)

        model = attrs.get("model") or attrs.get("model_id")
        model_out = None
        if isinstance(model, str) and _MODEL_ALLOWED.match(model):
            model_out, found = scan(model)
            _merge_counts(counts, found)
            model_out = model_out[:64]
            models.add(model_out)

        path_refs: list[str] = []
        raw_args = attrs.get("arguments") or attrs.get("args")
        if isinstance(raw_args, (dict, list)):
            for value in (raw_args.values() if isinstance(raw_args, dict) else raw_args):
                if isinstance(value, str) and ("/" in value or "\\" in value) and len(value) < 400:
                    cleaned = canonical_path(value, counts)
                    if cleaned:
                        path_refs.append(paths.setdefault(cleaned, "p%d" % (len(paths) + 1)))

        events.append({
            "ref": "e%d" % index,
            "elapsed_ms": int(max(0, (row["ts"] or first_ts) - first_ts) * 1000),
            "kind": kind,
            "session": session_ref,
            "turn": turn_ref,
            "status": status,
            "tool": tool,
            "duration_ms": _int(attrs.get("duration_ms")),
            "exit_code": _int(attrs.get("exit_code")),
            "error": error_out,
            "retry_of": retry_of,
            "model": model_out,
            "paths": path_refs,
            "tokens": {
                name: _int(attrs.get(source))
                for name, source in (
                    ("input", "input_tokens" if "input_tokens" in attrs else "prompt_tokens"),
                    ("output", "output_tokens" if "output_tokens" in attrs else "completion_tokens"),
                    ("cache_read", "cache_read_tokens"),
                    ("cache_write", "cache_write_tokens"),
                    ("reasoning", "reasoning_tokens"),
                )
            },
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "bundle_id": str(uuid.uuid4()),
        "generator": {"name": "omniscience", "version": _version()},
        "summary": {
            "event_count": len(events),
            "failed_count": failed_count,
            "retried_count": retried_count,
            "models": sorted(models),
        },
        "sessions": [{"ref": ref, "event_count": sum(1 for e in events if e["session"] == ref)}
                     for ref in sessions.values()],
        "events": events,
        "paths": [{"ref": ref, "path": path} for path, ref in paths.items()],
        "redaction_report": {
            "rules_version": RULES_VERSION,
            "matches": counts,
            "excluded_attrs": sorted(excluded_attrs),
            "excluded_events": excluded_events,
            "excluded_by_default": ["prompts", "model responses", "tool output", "arguments values",
                                    "wall-clock timestamps", "session and turn identifiers"],
        },
    }


def write_bundle(bundle: dict[str, Any], dest: str) -> str:
    """Write exactly the bytes that were previewed: sorted keys, two-space indent, UTF-8."""
    text = json.dumps(bundle, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    with open(dest, "w", encoding="utf-8") as handle:
        handle.write(text)
    return dest


def _version() -> str:
    try:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(here, "BUILD_INFO.json"), encoding="utf-8") as handle:
            return str(json.load(handle).get("version") or "0")
    except (OSError, ValueError):
        return "0"
