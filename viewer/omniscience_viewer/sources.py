"""Token usage from other coding agents, for the Usage page.

Each harness keeps its own history in its own format. This module reads the ones that exist on
this machine and reduces every call to the same eleven fields — source, ids, timestamp, model,
five token counts and the project — into `usage.db` next to the recorder's database.

Two rules, because these are other tools' private transcripts:

* **Metadata only.** Parsers never keep a message, a prompt, a tool result or a file path's
  contents. They read the usage block out of a line and drop the line.
* **Opt-in per harness.** A source is read only when the user has switched it on. Off means no
  read at all, not "read and hide". `delete_source()` removes the rows and the file cursors.

The recorder's own `events.db` stays untouched: this writes a separate database, so the viewer
can keep reading both without either one owning the other.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS call (
    source TEXT NOT NULL,
    call_id TEXT NOT NULL,
    session_id TEXT,
    ts REAL NOT NULL,
    model TEXT,
    input INTEGER DEFAULT 0,
    output INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0,
    cache_write INTEGER DEFAULT 0,
    reasoning INTEGER DEFAULT 0,
    calls INTEGER DEFAULT 1,
    project TEXT,
    PRIMARY KEY (source, call_id)
);
CREATE INDEX IF NOT EXISTS call_ts ON call(ts);
CREATE INDEX IF NOT EXISTS call_source_ts ON call(source, ts);
CREATE TABLE IF NOT EXISTS source (
    source TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    last_scan REAL,
    calls INTEGER DEFAULT 0,
    files INTEGER DEFAULT 0,
    note TEXT
);
CREATE TABLE IF NOT EXISTS counter (
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    prompt INTEGER DEFAULT 0,
    output INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0,
    cache_write INTEGER DEFAULT 0,
    calls INTEGER DEFAULT 0,
    ts REAL,
    PRIMARY KEY (source, key)
);
CREATE TABLE IF NOT EXISTS file (
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER,
    mtime REAL,
    offset INTEGER,
    PRIMARY KEY (source, path)
);
"""

# Hard cap on how much of one file a single scan will parse, so a multi-gigabyte transcript
# cannot turn a background sync into a stall. A file over this is finished by the next scan,
# which resumes at the recorded cursor.
MAX_FILE_BYTES = 256 * 1024 * 1024

log = logging.getLogger(__name__)


def usage_db_path(events_db: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(events_db)), "usage.db")


def _migrate(con: sqlite3.Connection) -> None:
    """Databases written before a column existed get it added here, once, in place."""
    columns = {row[1] for row in con.execute("PRAGMA table_info(counter)")}
    if "calls" not in columns:
        con.execute("ALTER TABLE counter ADD COLUMN calls INTEGER DEFAULT 0")
    call_columns = {row[1] for row in con.execute("PRAGMA table_info(call)")}
    if "calls" not in call_columns:
        con.execute("ALTER TABLE call ADD COLUMN calls INTEGER DEFAULT 1")


def connect(path: str, write: bool = False) -> sqlite3.Connection:
    if write:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        con = sqlite3.connect(path, timeout=5.0)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=5000")
        con.executescript(SCHEMA)
        _migrate(con)
        return con
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=3.0)
    return con


def _num(value) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return 0
    return 0


def _iso_to_epoch(value) -> float:
    """Timestamps arrive as ISO-8601 with a Z, or as epoch seconds/milliseconds."""
    if isinstance(value, (int, float)):
        n = float(value)
        if n > 1e11:  # milliseconds
            n /= 1000.0
        return n if n > 0 else 0.0
    if isinstance(value, str) and value:
        text = value.replace("Z", "+00:00")
        try:
            from datetime import datetime

            return datetime.fromisoformat(text).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _row(call_id, session_id, ts, model, usage: dict, project=None) -> Optional[dict]:
    # snake_case and camelCase both occur: Claude/Codex spell the first, pi spells the second,
    # and opencode nests cache counters one level down.
    cache = usage.get("cache") if isinstance(usage.get("cache"), dict) else {}
    input_tokens = _num(usage.get("input_tokens") or usage.get("inputTokens") or usage.get("input"))
    output = _num(usage.get("output_tokens") or usage.get("outputTokens") or usage.get("output"))
    cache_read = _num(usage.get("cache_read_input_tokens") or cache.get("read")
                      or usage.get("cached_input_tokens") or usage.get("cache_read_tokens")
                      or usage.get("cacheRead"))
    cache_write = _num(usage.get("cache_creation_input_tokens") or cache.get("write")
                       or usage.get("cache_write_tokens") or usage.get("cacheWrite"))
    reasoning = _num(usage.get("reasoning_output_tokens") or usage.get("reasoning_tokens")
                     or usage.get("reasoningTokens") or usage.get("reasoning"))
    if not any((input_tokens, output, cache_read, cache_write, reasoning)):
        return None
    return {
        "call_id": str(call_id),
        "session_id": session_id,
        "ts": ts,
        "model": model,
        "input": input_tokens,
        "output": output,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "reasoning": reasoning,
        "project": project,
    }


# ---------------------------------------------------------------------------
# Claude Code: ~/.claude/projects/<project>/<session>.jsonl
# ---------------------------------------------------------------------------

def parse_claude(handle: Iterator[str], project: Optional[str] = None) -> Iterator[dict]:
    # One request is written on several lines while it streams, and the usage block grows with it:
    # on this machine 36,619 of 69,242 usage lines (53%) repeat a request id, and the later line
    # carries the real output_tokens (1 -> 243). Keeping the first line therefore stored a
    # fragment: output tokens were under-counted by two orders of magnitude. Last line wins.
    latest: dict[str, dict] = {}
    order: list[str] = []
    for line in handle:
        if '"usage"' not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        # One request can appear on several lines (streamed parts); the request id is the call.
        call_id = record.get("requestId") or record.get("uuid") or ""
        if not call_id:
            # No id on this line. Using "" as the id both hid the line behind the first such
            # line in the file and collided with every other id-less line in the table, so the
            # call disappeared. Derive a stable id from what the line does carry: re-reading
            # the file yields the same id, two different calls yield different ids.
            call_id = "anon:%s:%s:%s:%s" % (
                record.get("timestamp"),
                usage.get("input_tokens"),
                usage.get("output_tokens"),
                message.get("model"),
            )
        row = _row(
            call_id,
            record.get("sessionId") or record.get("session_id"),
            _iso_to_epoch(record.get("timestamp")),
            message.get("model"),
            usage,
            project,
        )
        if row:
            if call_id not in latest:
                order.append(call_id)
            latest[call_id] = row
    for call_id in order:
        yield latest[call_id]


# ---------------------------------------------------------------------------
# Codex: ~/.codex/sessions/**.jsonl — token_count carries per-call last_token_usage;
# total_token_usage is cumulative for the session and must not be summed.
# ---------------------------------------------------------------------------

def parse_codex(handle: Iterator[str], project: Optional[str] = None) -> Iterator[dict]:
    session_id = None
    model = None
    index = 0
    for line in handle:
        index += 1
        if "token_count" not in line and "thread_settings" not in line and "session_meta" not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        payload = record.get("payload") or {}
        kind = payload.get("type") or record.get("type")
        if record.get("type") == "session_meta":
            session_id = payload.get("id") or payload.get("session_id")
            model = payload.get("model") or model
            project = payload.get("cwd") or project
            continue
        if kind == "thread_settings_applied":
            settings = payload.get("thread_settings") or {}
            model = settings.get("model") or model
            continue
        if kind != "token_count":
            continue
        info = payload.get("info") or {}
        usage = info.get("last_token_usage") or {}
        if not usage:
            continue
        # The line index restarts on an incremental read, so the id is the event's own
        # timestamp: stable across re-reads, and unique within a session.
        row = _row(
            f"{session_id or 'codex'}:{record.get('timestamp')}",
            session_id,
            _iso_to_epoch(record.get("timestamp")),
            model,
            usage,
            project,
        )
        if row:
            yield row


# ---------------------------------------------------------------------------
# opencode: sqlite, message.data JSON carries role/modelID/tokens/cost
# ---------------------------------------------------------------------------

def parse_opencode(events_db: str, since: float = 0.0) -> Iterator[dict]:
    path = Path.home() / ".local/share/opencode/opencode.db"
    if not path.exists():
        return
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
    try:
        rows = con.execute(
            "SELECT id, session_id, time_created, data FROM message"
            " WHERE data LIKE '%\"tokens\"%' AND time_created > ?",
            (int(since * 1000) if since else 0,),
        )
        for message_id, session_id, created, data in rows:
            try:
                record = json.loads(data)
            except ValueError:
                continue
            if record.get("role") != "assistant":
                continue
            usage = record.get("tokens") or {}
            if not isinstance(usage, dict):
                continue
            row = _row(
                message_id,
                session_id,
                (created or 0) / 1000.0,
                record.get("modelID"),
                usage,
            )
            if row:
                yield row
    finally:
        con.close()


# ---------------------------------------------------------------------------
# omp / pi: ~/.omp/agent/sessions/**.jsonl, ~/.pi/agent/sessions/**.jsonl
# Message lines nest the provider's own usage block under message.usage.
# ---------------------------------------------------------------------------

def parse_omp(handle: Iterator[str], project: Optional[str] = None) -> Iterator[dict]:
    session_id = None
    model = None
    for line in handle:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        kind = record.get("type")
        if kind == "session":
            session_id = record.get("id")
            project = record.get("cwd") or project
            continue
        if kind == "model_change":
            model = record.get("model") or record.get("modelId") or model
            continue
        if kind != "message":
            continue
        message = record.get("message") or {}
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        model = message.get("model") or model
        row = _row(
            record.get("id") or f"{session_id}:{record.get('timestamp')}",
            session_id,
            _iso_to_epoch(record.get("timestamp") or message.get("timestamp")),
            model,
            usage,
            project,
        )
        if row:
            yield row


# ---------------------------------------------------------------------------
# Cumulative readers
#
# These report a running total, not per-call rows, so what gets stored is the increment since the
# last look. A restart that resets a counter loses nothing and double-counts nothing: the delta
# floors at zero, and the counter table remembers the last value seen.
# ---------------------------------------------------------------------------

# TensorFold servers to read token counters from, as "name=http://host:port" pairs separated by commas.
SPARKS = dict(
    pair.split("=", 1) for pair in os.environ.get("OMNISCIENCE_TENSORFOLD_HOSTS", "").split(",") if "=" in pair
)


def parse_tensorfold_metrics(text):
    """The two token counters, from a TensorFold /metrics body."""
    out = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, value = line.partition(" ")
        if name in ("tensorfold:prompt_tokens_total", "tensorfold:generation_tokens_total",
                    "tensorfold:e2e_request_latency_seconds_count"):
            try:
                out[name.split(":")[1]] = float(value)
            except ValueError:
                continue
    return out


def _http_get(url, timeout=3.0):
    import urllib.request

    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 — fixed hosts
        return response.read().decode("utf-8", "replace")


def read_sparks():
    for lane, base in SPARKS.items():
        try:
            metrics = parse_tensorfold_metrics(_http_get(base + "/metrics"))
            models = json.loads(_http_get(base + "/v1/models") or "{}")
        except Exception:
            log.debug("spark %s did not answer; skipped", lane, exc_info=True)
            continue
        model = ((models.get("data") or [{}])[0] or {}).get("id")
        if not metrics:
            continue
        yield {"key": lane, "session": lane, "project": lane, "model": model,
               "prompt": metrics.get("prompt_tokens_total", 0.0),
               "output": metrics.get("generation_tokens_total", 0.0),
               "cache_read": 0.0, "cache_write": 0.0,
               "calls": metrics.get("e2e_request_latency_seconds_count", 0.0)}


def read_dsh():
    base = Path.home() / ".dsh/storages/session_projcache/sessions"
    if not base.exists():
        return
    for path in base.glob("*.json"):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        record = document.get("record") or {}
        rows = record.get("rows") or {}
        totals = ((rows.get("tokenUsage") or {}).get("val") or {}).get("totals") or {}
        if not totals:
            continue
        identity = record.get("identity") or {}
        model = (((rows.get("modelSelection") or {}).get("val") or {})
                 .get("lastUsed") or {}).get("model")
        uncached = _num(totals.get("uncachedInputTokens"))
        cache_read = _num(totals.get("cacheReadTokens"))
        cache_write = _num(totals.get("cacheWriteTokens"))
        yield {"key": path.name, "session": path.name,
               "project": (identity.get("cwd") or "").rsplit("/", 1)[-1] or None,
               "model": model,
               # Unchanged at source: the aggregator composes prompt = input + cache read + write.
               # Storing the composed total here made the cache share count twice.
               "prompt": uncached,
               "output": _num(totals.get("outputTokens")),
               "cache_read": cache_read, "cache_write": cache_write,
               "calls": _num((rows.get("sessionStats") or {}).get("val", {}).get("steps"))}


def _record_deltas(con, source_id, entries, now):
    written = 0
    for entry in entries:
        prior = con.execute(
            "SELECT prompt, output, cache_read, cache_write, calls FROM counter"
            " WHERE source = ? AND key = ?", (source_id, entry["key"])).fetchone()
        prompt, output = entry["prompt"], entry["output"]
        cache_read, cache_write = entry["cache_read"], entry["cache_write"]
        calls = entry.get("calls", 0.0) or 0.0
        if prior:
            prompt = max(0.0, prompt - prior[0])
            output = max(0.0, output - prior[1])
            cache_read = max(0.0, cache_read - prior[2])
            cache_write = max(0.0, cache_write - prior[3])
            calls = max(0.0, calls - prior[4])
        con.execute(
            "INSERT OR REPLACE INTO counter (source, key, prompt, output, cache_read,"
            " cache_write, calls, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (source_id, entry["key"], entry["prompt"], entry["output"],
             entry["cache_read"], entry["cache_write"], entry.get("calls", 0.0), now))
        if not any((prompt, output, cache_read, cache_write)):
            continue
        cur = con.execute(
            "INSERT OR IGNORE INTO call (source, call_id, session_id, ts, model, input, output,"
            " cache_read, cache_write, reasoning, calls, project)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
            (source_id, entry["key"] + ":" + ("%.6f" % now), entry.get("session"), now,
             entry.get("model"), prompt, output, cache_read, cache_write,
             max(1, int(calls)) if calls else 1, entry.get("project")))
        written += max(0, cur.rowcount)
    return written


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

@dataclass
class Source:
    id: str
    label: str
    kind: str                      # "jsonl" | "sqlite"
    roots: list[str] = field(default_factory=list)
    pattern: str = "*.jsonl"
    parser: Optional[Callable] = None
    note: str = ""


def _root(rel: str) -> str:
    return str(Path.home() / rel)


SOURCES: dict[str, Source] = {
    "claude-code": Source(
        "claude-code", "Claude Code", "jsonl",
        roots=[_root(".claude/projects")], parser=parse_claude,
        note="Reads message.usage from each transcript line; the prompt is not kept.",
    ),
    "codex": Source(
        "codex", "Codex CLI", "jsonl",
        roots=[_root(".codex/sessions"), _root(".codex/archived_sessions")], parser=parse_codex,
        note="Reads per-call last_token_usage; the session's cumulative total is not summed.",
    ),
    "opencode": Source(
        "opencode", "opencode", "sqlite",
        roots=[_root(".local/share/opencode")], parser=parse_opencode,
        note="Reads the tokens block from the message table.",
    ),
    "omp": Source(
        "omp", "omp (Oh My Pi)", "jsonl",
        roots=[_root(".omp/agent/sessions")], parser=parse_omp,
        note="Reads the provider usage block on assistant messages.",
    ),
    "dsh": Source(
        "dsh", "DeepSeek Harness", "counter", roots=[_root(".dsh")], parser=None,
        note="Reads the harness's own session totals and stores the increment since the last look.",
    ),
    "sparks": Source(
        "sparks", "DGX Sparks", "counter", roots=[], parser=None,
        note="Polls each lane's TensorFold counters over HTTP; local inference, so the honest cost is zero.",
    ),
    "pi": Source(
        "pi", "Pi", "jsonl",
        roots=[_root(".pi/agent/sessions")], parser=parse_omp,
        note="Same session format as omp.",
    ),
}


# Clients this page knows about but cannot read, and why. Omitting them reads as "Omniscience
# forgot Cursor"; a row that says why is an answer, and it is still honest: nothing here is
# claimed as imported. These never enter SOURCES, so the switch route refuses them by itself.
DECLARED_NO_USAGE: tuple[dict, ...] = (
    {
        "id": "cursor",
        "label": "Cursor",
        "note": (
            "Cursor keeps no local token counts — its usage lives in the Cursor dashboard, so "
            "there is nothing on this machine to read."
        ),
    },
    {
        "id": "gemini-cli",
        "label": "Gemini CLI",
        "note": (
            "Gemini CLI's chat logs carry no usage block, so there are no token counts to import."
        ),
    },
)


def _iter_files(source: Source) -> Iterator[Path]:
    for root in source.roots:
        base = Path(root)
        if not base.exists():
            continue
        if source.kind == "unmeasurable":
            return {"ok": False, "error": source.note}
        if source.kind == "sqlite":
            for name in ("opencode.db", "opencode-stable.db"):
                candidate = base / name
                if candidate.exists():
                    yield candidate
            continue
        for path in base.rglob(source.pattern):
            if path.is_file():
                yield path


def discover(source_id: str) -> dict:
    """What a source would read, without reading it: file count, size, and whether it exists."""
    source = SOURCES.get(source_id)
    if source is None:
        return {"available": False, "files": 0, "bytes": 0, "note": "unknown source"}

    # A counter source has no files to count: its data lives in a lane's HTTP endpoint or in the
    # harness's own session store. Saying "not found" because the glob was empty hid two sources.
    if source.kind == "counter":
        if source_id == "sparks":
            return {"available": True, "files": len(SPARKS), "bytes": 0, "note": source.note}
        base = Path(source.roots[0]) if source.roots else None
        if base and base.exists():
            sessions = base / "storages/session_projcache/sessions"
            count = len(list(sessions.glob("*.json"))) if sessions.exists() else 0
            return {"available": count > 0, "files": count, "bytes": 0, "note": source.note}
        return {"available": False, "files": 0, "bytes": 0, "note": source.note}

    files = 0
    size = 0
    for path in _iter_files(source):
        files += 1
        try:
            size += path.stat().st_size
        except OSError:
            log.debug("could not stat %s while probing; size left unchanged", path, exc_info=True)
    return {"available": files > 0, "files": files, "bytes": size, "note": source.note}


def _project_of(path: Path, source: Source) -> Optional[str]:
    """The bit of the path that names the project, never the whole path: a usage row should
    not carry a directory tree that can read like content."""
    try:
        rel = path.relative_to(Path(source.roots[0]))
    except (ValueError, IndexError):
        return None
    parts = rel.parts
    if len(parts) > 1:
        return parts[0][:80]
    return None


# How much of a file's beginning is replayed when resuming at a byte cursor. Codex and omp put
# the session id and the model in a header line at the top; a resumed read starts past it, so the
# new calls were stored with no model and no session. Replaying the head is cheap (one read, not a
# parse of the whole file) and duplicate rows are ignored by the primary key.
HEADER_BYTES = 64 * 1024


def _read_jsonl(path: Path, offset: int, parser: Callable, project: Optional[str]) -> tuple[list[dict], int]:
    rows: list[dict] = []
    with open(path, "rb") as handle:
        head = b""
        if offset > 0:
            handle.seek(0)
            head = handle.read(HEADER_BYTES)
            cut = head.rfind(b"\n")
            head = head[: cut + 1] if cut >= 0 else b""
        handle.seek(offset)
        start = handle.tell()
        text = handle.read(MAX_FILE_BYTES).decode("utf-8", errors="replace")
    # Only complete lines are parsed; a partially written last line is left for next time.
    keep = text.rfind("\n")
    if keep == -1:
        return [], start
    text = text[: keep + 1]
    head_text = head.decode("utf-8", errors="replace")
    lines = head_text.splitlines() + text.splitlines()
    rows = list(parser(iter(lines), project))
    # The cursor is where the last complete line ended, so a half-written line is re-read
    # next time instead of being silently skipped.
    return rows, start + len(text.encode())


def _write_rows(con: sqlite3.Connection, source_id: str, rows: Iterable[dict]) -> int:
    written = 0
    for row in rows:
        # "Last line wins" has to survive across scans, not only within one parse. A streaming
        # request can be read part-way (output=1) on one scan and finished (output=243) on the
        # next; the byte cursor means the final line is only ever seen on that later scan.
        # INSERT OR IGNORE kept the first, partial value and dropped the correction, so an
        # upsert carries the later (never smaller) usage onto the row already stored.
        cur = con.execute(
            "INSERT INTO call (source, call_id, session_id, ts, model, input, output,"
            " cache_read, cache_write, reasoning, project)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(source, call_id) DO UPDATE SET"
            " session_id=excluded.session_id, ts=excluded.ts, model=excluded.model,"
            " input=excluded.input, output=excluded.output, cache_read=excluded.cache_read,"
            " cache_write=excluded.cache_write, reasoning=excluded.reasoning,"
            " project=excluded.project"
            " WHERE excluded.output > call.output",
            (source_id, row["call_id"], row["session_id"], row["ts"], row["model"],
             row["input"], row["output"], row["cache_read"], row["cache_write"],
             row["reasoning"], row["project"]),
        )
        written += cur.rowcount if cur.rowcount > 0 else 0
    return written


def scan(source_id: str, events_db: str, since: float = 0.0) -> dict:
    """Import one source's new calls. Incremental for JSONL (byte cursor per file), by row id
    for sqlite. Returns what it did, so the caller can report it rather than claim it."""
    source = SOURCES.get(source_id)
    if source is None:
        return {"ok": False, "error": "unknown source"}
    db = usage_db_path(events_db)
    con = connect(db, write=True)
    try:
        files = 0
        calls = 0
        start = time.time()
        if source.kind == "counter":
            reader = read_sparks if source_id == "sparks" else read_dsh
            calls = _record_deltas(con, source_id, reader(), time.time())
            files = 1
        elif source.kind == "sqlite":
            rows = list(source.parser(events_db, since))
            calls = _write_rows(con, source_id, rows)
            files = 1 if rows else 0
        else:
            for path in _iter_files(source):
                files += 1
                try:
                    stat = path.stat()
                except OSError:
                    continue
                prior = con.execute(
                    "SELECT size, offset FROM file WHERE source = ? AND path = ?",
                    (source_id, str(path)),
                ).fetchone()
                offset = 0
                if prior and prior[1]:
                    read_to = int(prior[1])
                    if stat.st_size < read_to:
                        offset = 0  # replaced with a shorter file: read it again
                    elif read_to >= stat.st_size and prior[0] == stat.st_size:
                        continue  # fully read and unchanged since the last scan
                    else:
                        # Appended, or cut short by MAX_FILE_BYTES last time: resume at the
                        # cursor. Comparing sizes alone used to skip the unread tail forever.
                        offset = read_to
                rows, new_offset = _read_jsonl(path, offset, source.parser, _project_of(path, source))
                calls += _write_rows(con, source_id, rows)
                con.execute(
                    "INSERT OR REPLACE INTO file (source, path, size, mtime, offset)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (source_id, str(path), stat.st_size, stat.st_mtime, new_offset),
                )
        # Rows are not calls: a counter row can stand for thousands of finished requests.
        total = con.execute(
            "SELECT COALESCE(SUM(calls), 0) FROM call WHERE source = ?", (source_id,)
        ).fetchone()[0]
        con.execute(
            "INSERT INTO source (source, enabled, last_scan, calls, files, note)"
            " VALUES (?, COALESCE((SELECT enabled FROM source WHERE source = ?), 0), ?, ?, ?, ?)"
            " ON CONFLICT(source) DO UPDATE SET last_scan = excluded.last_scan,"
            " calls = excluded.calls, files = excluded.files, note = excluded.note",
            (source_id, source_id, start, total, files, source.note),
        )
        con.commit()
        return {"ok": True, "source": source_id, "files": files, "new_calls": calls,
                "total_calls": total, "seconds": round(time.time() - start, 2)}
    except Exception as exc:  # a broken transcript must not take the sync down
        con.rollback()
        return {"ok": False, "source": source_id, "error": str(exc)[:200]}
    finally:
        con.close()


def set_enabled(source_id: str, events_db: str, enabled: bool) -> dict:
    con = connect(usage_db_path(events_db), write=True)
    try:
        con.execute(
            "INSERT INTO source (source, enabled) VALUES (?, ?)"
            " ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled",
            (source_id, 1 if enabled else 0),
        )
        con.commit()
    finally:
        con.close()
    if enabled:
        return scan(source_id, events_db)
    return delete_source(source_id, events_db)


def delete_source(source_id: str, events_db: str) -> dict:
    con = connect(usage_db_path(events_db), write=True)
    try:
        removed = con.execute("DELETE FROM call WHERE source = ?", (source_id,)).rowcount
        con.execute("DELETE FROM file WHERE source = ?", (source_id,))
        con.execute(
            "INSERT INTO source (source, enabled, calls, files) VALUES (?, 0, 0, 0)"
            " ON CONFLICT(source) DO UPDATE SET enabled = 0, calls = 0, files = 0",
            (source_id,),
        )
        con.commit()
        return {"ok": True, "source": source_id, "removed": max(0, removed)}
    finally:
        con.close()


def source_status(events_db: str) -> list[dict]:
    """Every known source, whether it is on, and what it holds — including the ones that are
    present on disk but not yet allowed, so the switch can say what it would read."""
    db = usage_db_path(events_db)
    rows: dict[str, dict] = {}
    if os.path.exists(db):
        try:
            con = connect(db)
            try:
                for source, enabled, last_scan, calls, files, note in con.execute(
                    "SELECT source, enabled, last_scan, calls, files, note FROM source"
                ):
                    rows[source] = {"id": source, "enabled": bool(enabled),
                                    "last_scan": last_scan, "imported": calls, "files": files,
                                    "note": note}
            finally:
                con.close()
        except sqlite3.Error:
            pass
    # Count calls from the rows themselves: a stored total goes stale the moment a fix changes how
    # calls are counted, and the panel then reports a number nobody can reproduce.
    live_counts: dict[str, int] = {}
    if os.path.exists(db):
        try:
            con = connect(db)
            try:
                for source_id, total in con.execute(
                    "SELECT source, COALESCE(SUM(calls), 0) FROM call GROUP BY source"
                ):
                    live_counts[source_id] = int(total)
            finally:
                con.close()
        except sqlite3.Error:
            pass

    out = []
    for source_id, source in SOURCES.items():
        found = discover(source_id)
        entry = rows.get(source_id, {"id": source_id, "enabled": False, "last_scan": None,
                                     "imported": 0})
        if source_id in live_counts:
            entry["imported"] = live_counts[source_id]
        entry.update({"label": source.label, "available": found["available"],
                      "disk_files": found["files"], "disk_bytes": found["bytes"],
                      "note": source.note})
        out.append(entry)
    for declared in DECLARED_NO_USAGE:
        out.append({
            "id": declared["id"],
            "label": declared["label"],
            "enabled": False,
            "available": False,
            "declared": True,
            "last_scan": None,
            "imported": 0,
            "files": 0,
            "disk_files": 0,
            "disk_bytes": 0,
            "note": declared["note"],
        })
    # A client that is declared but unreadable has no switch to flip; the page says why instead.
    for row in out:
        row.setdefault("measurable", not row.get("declared", False))
    out.sort(key=lambda r: (not r["available"], r["label"]))
    return out


def totals_by_source(events_db: str, since: float = 0.0) -> list[dict]:
    db = usage_db_path(events_db)
    if not os.path.exists(db):
        return []
    con = connect(db)
    try:
        return [
            {"source": source, "calls": calls, "input": input_tokens, "output": output,
             "cache_read": cache_read, "cache_write": cache_write, "reasoning": reasoning}
            for source, calls, input_tokens, output, cache_read, cache_write, reasoning in con.execute(
                "SELECT source, COUNT(*), SUM(input), SUM(output), SUM(cache_read),"
                " SUM(cache_write), SUM(reasoning) FROM call WHERE ts >= ? GROUP BY source"
                " ORDER BY SUM(input) + SUM(cache_read) DESC",
                (since,),
            )
        ]
    finally:
        con.close()


def export_for_usage(events_db: str, since: float) -> list[dict]:
    """Rows for the Usage aggregation, shaped like the recorder's own calls."""
    db = usage_db_path(events_db)
    if not os.path.exists(db):
        return []
    con = connect(db)
    try:
        return [
            {"source": source, "session_id": session_id, "ts": ts, "model": model,
             "input": input_tokens, "output": output, "cache_read": cache_read,
             "cache_write": cache_write, "reasoning": reasoning, "calls": calls,
             "project": project}
            for source, session_id, ts, model, input_tokens, output, cache_read, cache_write, \
                reasoning, calls, project in con.execute(
                "SELECT c.source, c.session_id, c.ts, c.model, c.input, c.output, c.cache_read,"
                " c.cache_write, c.reasoning, c.calls, c.project FROM call c"
                " JOIN source s ON s.source = c.source AND s.enabled = 1"
                " WHERE c.ts >= ? ORDER BY c.ts",
                (since,),
            )
        ]
    finally:
        con.close()
