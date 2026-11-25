"""Keep the recording small without losing the totals it is read for.

The events table only ever grew: a fortnight of ordinary use reached 186,000 steps and 204 MB.
Deleting old steps alone would make the Usage page lie — a 90-day range would drop to zero the
day cleanup ran — so each deleted block is first rolled into two small tables that survive the
step rows: ``daily_totals`` (day, model, provider, tokens, calls, cost) and ``daily_tools``
(day, tool, calls, failures).

Three rules shape the code here:

* **Nothing is lost before it is counted.** A chunk is rolled up and deleted in one transaction,
  so a crash can only leave the chunk in place for the next run, never count it twice.
* **A flagged chat is never touched.** Its dossier in ``privacy-flags`` is evidence, and its
  steps may be the only remaining source. The flagged session and its parent/helper links are
  kept, whatever their age.
* **Recording keeps moving.** Deletes land in bounded chunks, and the database is only compacted
  when it is not busy; every sqlite3 error is reported and swallowed, never raised into the
  writer or a dashboard request.

The module has no package-relative imports: the plugin loads it from the package, and the
dashboard loads the same file by path in a separate process.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from typing import Any, Iterable

log = logging.getLogger("omniscience")

STAMP_FILE_NAME = "history-cleanup.stamp"
CLEANUP_INTERVAL_S = 24 * 3600
CHUNK_ROWS = 5000
# Compact with a full VACUUM only when this share of the file is free pages; otherwise the
# cheap incremental pass is enough and leaves the file in place.
VACUUM_FREE_SHARE = 0.25

TOTALS_DDL = """
CREATE TABLE IF NOT EXISTS daily_totals (
    day TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    calls INTEGER NOT NULL DEFAULT 0,
    aux_calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    fresh_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    PRIMARY KEY (day, model, provider)
);
CREATE TABLE IF NOT EXISTS daily_tools (
    day TEXT NOT NULL,
    tool TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, tool)
);
"""

_TOTAL_COLUMNS = (
    "calls", "aux_calls", "errors", "prompt_tokens", "fresh_tokens", "cache_read_tokens",
    "cache_write_tokens", "output_tokens", "reasoning_tokens",
)


def day_key(ts: float) -> str:
    """The reader's own calendar day, the same one the Usage page groups by."""
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def stamp_path(db_path: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(db_path)), STAMP_FILE_NAME)


def cleanup_due(db_path: str, now: float | None = None, interval: float = CLEANUP_INTERVAL_S) -> bool:
    """Whether the daily pass may run: no stamp, or a stamp older than the interval."""
    now = time.time() if now is None else now
    try:
        return now - os.path.getmtime(stamp_path(db_path)) >= interval
    except OSError:
        return True


def mark_cleanup(db_path: str, now: float | None = None) -> None:
    """Record that a pass ran, atomically so two processes cannot leave half a stamp."""
    now = time.time() if now is None else now
    path = stamp_path(db_path)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(f"{now:.0f}\n")
        # The stamp's *time* is what the 24 h gate reads, not the clock inside the file: a test or
        # a backdated pass must move the file's mtime with it.
        os.utime(tmp, (now, now))
        os.replace(tmp, path)
    except OSError:
        log.debug("omniscience: could not write the cleanup stamp", exc_info=True)


def db_bytes(db_path: str) -> int:
    """The recording's size on disk, including its write-ahead log."""
    total = 0
    for suffix in ("", "-wal"):
        try:
            total += os.path.getsize(db_path + suffix)
        except OSError:
            continue
    return total


def flagged_sessions(state_dir: str) -> set[str]:
    """Session ids with a privacy dossier beside the database.

    An unflag moves its dossier into ``unflagged/``, which is deliberately not read: once the
    owner has taken a flag off, the chat is ordinary history again.
    """
    directory = os.path.join(state_dir, "privacy-flags")
    found: set[str] = set()
    try:
        names = os.listdir(directory)
    except OSError:
        return found
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        session_id = data.get("session_id")
        if isinstance(session_id, str) and session_id:
            found.add(session_id)
    return found


def _attrs(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _num(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number == number and number not in (float("inf"), float("-inf")) else 0.0
    if isinstance(value, str):
        try:
            return _num(float(value))
        except ValueError:
            return 0.0
    return 0.0


def _usage_numbers(attrs: dict[str, Any]) -> dict[str, float] | None:
    """One provider usage block, normalised exactly as the Usage page normalises it."""
    usage = attrs.get("usage") if isinstance(attrs.get("usage"), dict) else {}
    cache_read = _num(usage.get("cache_read_tokens"))
    cache_write = _num(usage.get("cache_write_tokens"))
    output = _num(usage.get("output_tokens")) or _num(usage.get("completion_tokens"))
    reasoning = _num(usage.get("reasoning_tokens"))
    prompt = _num(usage.get("prompt_tokens"))
    if prompt <= 0:
        prompt = _num(usage.get("input_tokens")) + cache_read + cache_write
    if prompt <= 0 and output <= 0:
        return None
    return {
        "prompt_tokens": prompt,
        "fresh_tokens": max(0.0, prompt - cache_read),
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "output_tokens": output,
        "reasoning_tokens": reasoning,
    }


def _error_status(status: Any) -> bool:
    return str(status or "").strip().lower() in ("error", "timeout", "failed")


def _cost(attrs: dict[str, Any]) -> float | None:
    """A cost is only rolled when one was actually recorded; nothing is estimated here."""
    for key in ("cost_usd", "estimated_cost_usd", "cost"):
        value = attrs.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            return float(value)
    return None


def _empty_model_totals() -> dict[str, float]:
    row: dict[str, float] = {key: 0.0 for key in _TOTAL_COLUMNS}
    row["cost"] = 0.0
    row["_has_cost"] = 0.0
    return row


def _aggregate(rows: Iterable[tuple]) -> tuple[dict[tuple, dict], dict[tuple, dict]]:
    """Fold one chunk into per-(day, model, provider) and per-(day, tool) totals."""
    totals: dict[tuple, dict] = {}
    tools: dict[tuple, dict] = {}
    for _rowid, ts, kind, _session_id, status, raw in rows:
        attrs = _attrs(raw)
        try:
            day = day_key(float(ts))
        except (TypeError, ValueError, OSError):
            continue
        if kind in ("llm.response", "aux.response"):
            numbers = _usage_numbers(attrs)
            # The Usage page's own rules, so a day reads the same before and after its steps go:
            # a model call with no usage block is not counted at all, and a background call adds
            # only its prompt and output.
            if kind == "llm.response" and not numbers:
                continue
            model = str(attrs.get("response_model") or attrs.get("model") or "") if kind == "llm.response" else ""
            provider = str(attrs.get("provider") or "")
            key = (day, model, provider)
            entry = totals.get(key)
            if entry is None:
                entry = totals[key] = _empty_model_totals()
            if kind == "llm.response":
                entry["calls"] += 1
                if _error_status(status):
                    entry["errors"] += 1
                for name, value in numbers.items():
                    entry[name] += value
            else:
                entry["aux_calls"] += 1
                if numbers:
                    entry["prompt_tokens"] += numbers["prompt_tokens"]
                    entry["output_tokens"] += numbers["output_tokens"]
            cost = _cost(attrs)
            if cost is not None:
                entry["cost"] += cost
                entry["_has_cost"] = 1.0
        elif kind == "tool.end":
            name = str(attrs.get("tool_name") or attrs.get("tool") or attrs.get("name") or "")
            key = (day, name)
            entry = tools.get(key)
            if entry is None:
                entry = tools[key] = {"calls": 0, "failures": 0}
            entry["calls"] += 1
            if status and str(status).strip().lower() != "ok":
                entry["failures"] += 1
    return totals, tools


def _write_totals(conn: sqlite3.Connection, totals: dict[tuple, dict], tools: dict[tuple, dict]) -> None:
    for (day, model, provider), row in totals.items():
        conn.execute(
            "INSERT INTO daily_totals (day, model, provider, " + ", ".join(_TOTAL_COLUMNS) + ", cost) "
            "VALUES (" + ", ".join("?" for _ in range(len(_TOTAL_COLUMNS) + 4)) + ") "
            "ON CONFLICT(day, model, provider) DO UPDATE SET "
            + ", ".join(f"{key} = {key} + excluded.{key}" for key in _TOTAL_COLUMNS)
            + ", cost = CASE WHEN excluded.cost IS NULL THEN cost "
            "ELSE COALESCE(cost, 0) + excluded.cost END",
            (day, model, provider, *(int(row[key]) for key in _TOTAL_COLUMNS),
             row["cost"] if row["_has_cost"] else None),
        )
    for (day, tool), row in tools.items():
        conn.execute(
            "INSERT INTO daily_tools (day, tool, calls, failures) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(day, tool) DO UPDATE SET "
            "calls = calls + excluded.calls, failures = failures + excluded.failures",
            (day, tool, int(row["calls"]), int(row["failures"])),
        )


def _protect_closure(conn: sqlite3.Connection, flagged: set[str]) -> set[str]:
    """A flagged chat and everything linked to it as a helper or a parent.

    Deleting a helper's steps would leave the flagged chat's dossier pointing at nothing, and
    deleting a parent's steps would do the same for a flag raised inside one of its helpers.
    """
    seen = set(flagged)
    frontier = set(flagged)
    while frontier:
        ids = list(frontier)
        marks = ", ".join("?" for _ in ids)
        found: set[str] = set()
        try:
            for (child,) in conn.execute(
                f"SELECT DISTINCT session_id FROM events WHERE parent_session_id IN ({marks}) "
                "AND session_id IS NOT NULL",
                ids,
            ):
                if child:
                    found.add(child)
            for (child,) in conn.execute(
                "SELECT DISTINCT json_extract(attrs, '$.child_session_id') FROM events "
                f"WHERE kind = 'subagent.start' AND session_id IN ({marks}) AND json_valid(attrs)",
                ids,
            ):
                if child:
                    found.add(child)
            for (parent,) in conn.execute(
                f"SELECT DISTINCT parent_session_id FROM events WHERE session_id IN ({marks}) "
                "AND parent_session_id IS NOT NULL",
                ids,
            ):
                if parent:
                    found.add(parent)
        except sqlite3.Error:
            log.debug("omniscience: could not expand the protected chats", exc_info=True)
            return seen
        frontier = found - seen
        seen |= frontier
    return seen


def _ensure_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(TOTALS_DDL)
    conn.commit()


def _compact(conn: sqlite3.Connection) -> str:
    """Shrink the file after a delete, without ever waiting on a busy database."""
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.Error:
        log.debug("omniscience: checkpoint after cleanup failed", exc_info=True)
    try:
        page_count = int(conn.execute("PRAGMA page_count").fetchone()[0] or 0)
        free_pages = int(conn.execute("PRAGMA freelist_count").fetchone()[0] or 0)
    except (sqlite3.Error, TypeError):
        return "none"
    if page_count <= 0:
        return "none"
    try:
        if free_pages / page_count > VACUUM_FREE_SHARE:
            conn.execute("VACUUM")
            return "full"
        conn.execute("PRAGMA incremental_vacuum")
        return "incremental"
    except sqlite3.Error:
        log.debug("omniscience: vacating free pages after cleanup failed", exc_info=True)
        return "skipped"


def run_history_cleanup(
    db_path: str,
    keep_days: int,
    *,
    now: float | None = None,
    chunk_rows: int = CHUNK_ROWS,
) -> dict[str, Any]:
    """Roll step detail older than *keep_days* into daily totals, then delete those steps.

    ``keep_days <= 0`` means "keep for ever" and does nothing. Never raises: a recording
    problem is reported in the returned ``ok``/``error`` fields so the writer and the dashboard
    both stay up. The answer also carries the recording size before and after, which is what
    the Clean up now button shows.
    """
    now = time.time() if now is None else now
    before = db_bytes(db_path)
    result: dict[str, Any] = {
        "ok": True, "deleted": 0, "days": [], "vacuum": "none",
        "before_bytes": before, "after_bytes": before, "keep_days": int(keep_days),
    }
    if keep_days is None or int(keep_days) <= 0:
        result["skipped"] = "forever"
        return result
    if not os.path.exists(db_path):
        result["skipped"] = "no database"
        return result

    cutoff = now - int(keep_days) * 86400
    try:
        conn = sqlite3.connect(db_path, timeout=5.0, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error as exc:
        result.update(ok=False, error=str(exc), after_bytes=db_bytes(db_path))
        return result

    # Most daily passes find nothing old enough. Answer those from the ts index alone: no tables
    # created, no checkpoint, no compaction — each of which takes a lock, and on Windows a lock
    # held for nothing is a file another process cannot read.
    try:
        has_old = conn.execute(
            "SELECT 1 FROM events WHERE ts < ? LIMIT 1", (cutoff,)
        ).fetchone() is not None
    except sqlite3.Error:
        has_old = True  # let the full pass report the real problem
    if not has_old:
        try:
            conn.close()
        except sqlite3.Error:
            pass
        result["skipped"] = "nothing old"
        mark_cleanup(db_path, now)
        return result

    deleted = 0
    touched_days: set[str] = set()
    try:
        _ensure_tables(conn)
        protected = _protect_closure(conn, flagged_sessions(os.path.dirname(os.path.abspath(db_path))))

        # Only the rowids and their chats: the attributes are read again inside each chunk
        # transaction, so nothing can change between counting a step and deleting it, and a long
        # history does not have to hold every attrs blob in memory at once.
        rowids: list[int] = []
        try:
            for rowid, session_id in conn.execute(
                "SELECT rowid, session_id FROM events WHERE ts < ? ORDER BY rowid",
                (cutoff,),
            ):
                if session_id and session_id in protected:
                    continue
                rowids.append(rowid)
        except sqlite3.Error as exc:
            result.update(ok=False, error=str(exc))
            return result

        chunk = max(1, int(chunk_rows))
        for start in range(0, len(rowids), chunk):
            block = rowids[start:start + chunk]
            marks = ", ".join("?" for _ in block)
            try:
                conn.execute("BEGIN IMMEDIATE")
            except sqlite3.Error as exc:
                result.update(ok=False, error=str(exc), deleted=deleted)
                break
            try:
                rows = conn.execute(
                    "SELECT rowid, ts, kind, session_id, status, attrs FROM events "
                    f"WHERE rowid IN ({marks}) ORDER BY rowid",
                    block,
                ).fetchall()
                totals, tools = _aggregate(rows)
                _write_totals(conn, totals, tools)
                deleted += max(0, conn.execute(
                    f"DELETE FROM events WHERE rowid IN ({marks})", block
                ).rowcount)
                touched_days.update(day for (day, _model, _provider) in totals)
                touched_days.update(day for (day, _tool) in tools)
                conn.commit()
            except sqlite3.Error as exc:
                log.warning("omniscience: rolling up old steps failed; stopping this pass", exc_info=True)
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
                result.update(ok=False, error=str(exc), deleted=deleted)
                break
    except sqlite3.Error as exc:
        log.warning("omniscience: history cleanup failed", exc_info=True)
        result.update(ok=False, error=str(exc), deleted=deleted)
    finally:
        try:
            result["vacuum"] = _compact(conn)
        except sqlite3.Error:
            log.debug("omniscience: compacting after cleanup failed", exc_info=True)
        try:
            conn.close()
        except sqlite3.Error:
            pass

    result["deleted"] = deleted
    result["days"] = sorted(touched_days)
    result["after_bytes"] = db_bytes(db_path)
    # A pass that could not finish (a busy database) is not a pass: leave the gate open so the
    # next idle check may retry instead of silently skipping a day of cleanup.
    if result.get("ok") and "skipped" not in result:
        mark_cleanup(db_path, now)
    return result
