"""Bounded, non-blocking event queue and SQLite writer thread."""

from __future__ import annotations

import itertools
import json
import logging
import os
import queue
import sqlite3
import threading
import time
import uuid

from .sanitize import normalize
from .schema import SCHEMA_VERSION, Event, make_event_id

# Recording must never break the host, but a failure that vanishes is a bug nobody can
# see, so every swallowed error below is logged with its context instead of dropped.
log = logging.getLogger("omniscience")

INSERT_SQL = """
INSERT OR IGNORE INTO events (
    event_id, schema, boot_id, seq, ts, kind, session_id, parent_session_id,
    turn_id, api_request_id, tool_call_id, subagent_id, status, attrs
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""

DDL = """
CREATE TABLE IF NOT EXISTS events (
    rowid INTEGER PRIMARY KEY,
    event_id TEXT UNIQUE NOT NULL,
    schema TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    parent_session_id TEXT,
    turn_id TEXT,
    api_request_id TEXT,
    tool_call_id TEXT,
    subagent_id TEXT,
    status TEXT,
    attrs TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_rowid ON events(session_id, rowid);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id);
-- Every window question ("last hour", "past month") filters on ts. Without this the page scans
-- the whole recording each time, which is invisible on a small one and expensive on a 78 MB one.
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
-- Chats Hermes removed: delete() removed the rows, archive() only hid them. Either way the
-- viewer must not show them again, and a helper that is still finishing work must not
-- resurrect the chat by writing one more row after the purge.
CREATE TABLE IF NOT EXISTS purged (
    session_id TEXT PRIMARY KEY,
    ts REAL NOT NULL,
    reason TEXT
);
"""


def _row(event: Event):
    return (
        event.event_id,
        event.schema,
        event.boot_id,
        event.seq,
        event.ts,
        event.kind,
        event.session_id,
        event.parent_session_id,
        event.turn_id,
        event.api_request_id,
        event.tool_call_id,
        event.subagent_id,
        event.status,
        json.dumps(event.attrs, separators=(",", ":"), sort_keys=True),
    )


class EventStore:
    def __init__(self, db_path, queue_max=10000, batch_max=500, flush_interval=0.25):
        self.db_path = str(db_path)
        self.queue_max = int(queue_max)
        self.batch_max = int(batch_max)
        self.flush_interval = float(flush_interval)
        self.boot_id = uuid.uuid4().hex

        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)

        self._lock = threading.Lock()
        self._seq = itertools.count(1)
        self._q = queue.Queue(maxsize=self.queue_max)

        self._submitted = 0
        self.dropped = 0
        self._pending_dropped = 0
        self._first_dropped_seq = None
        self._written = 0

        self._stop = threading.Event()
        self._pause = threading.Event()

        self._thread = threading.Thread(
            target=self._writer_loop, name="omniscience-writer", daemon=True
        )
        self._thread.start()

    # -- producer side ----------------------------------------------------

    def _next_seq(self) -> int:
        with self._lock:
            return next(self._seq)

    def _count_dropped(self, count: int, first_seq) -> None:
        with self._lock:
            self.dropped += count
            self._pending_dropped += count
            if self._first_dropped_seq is None:
                self._first_dropped_seq = first_seq

    def submit(self, hook_name, kwargs) -> None:
        try:
            result = normalize(hook_name, kwargs)
            if result is None:
                return
            kind, ids, status, attrs, natural_key = result
            ts = time.time()
            # seq allocation and enqueue under one lock so rows land in seq order.
            with self._lock:
                seq = next(self._seq)
                key = natural_key if natural_key is not None else f"{self.boot_id}|{seq}"
                event = Event(
                    event_id=make_event_id(kind, str(key)),
                    schema=SCHEMA_VERSION,
                    boot_id=self.boot_id,
                    seq=seq,
                    ts=ts,
                    kind=kind,
                    session_id=ids.get("session_id"),
                    parent_session_id=ids.get("parent_session_id"),
                    turn_id=ids.get("turn_id"),
                    api_request_id=ids.get("api_request_id"),
                    tool_call_id=ids.get("tool_call_id"),
                    subagent_id=ids.get("subagent_id"),
                    status=status,
                    attrs=attrs,
                )
                self._submitted += 1
                try:
                    self._q.put_nowait(event)
                    return
                except queue.Full:
                    pass
            self._count_dropped(1, seq)
        except Exception:
            # sanitize.normalize is written never to raise; this only fires if a hook hands
            # us something it cannot handle, and a recording failure must not reach the host.
            log.debug("omniscience: dropping an event that could not be normalised", exc_info=True)

    # -- deletion ---------------------------------------------------------

    # Hermes reports "archive" when the conversation still exists and only left the list.
    # Every other reason it sends (delete, prune, empty_sweep, …) means the row is gone.
    ARCHIVE_REASON = "archive"

    def purge_sessions(self, session_ids, reason="delete"):
        """Make a chat Hermes removed disappear from the recording.

        Hermes fires ``on_session_delete`` after a committed delete (``reason="delete"``, or
        ``prune`` / ``empty_sweep`` from a sweep) or a deliberate archive
        (``reason="archive"``). A delete removes the rows; an archive only hides them,
        because the conversation still exists in Hermes and only left the list — destroying
        history for that would be unrecoverable. Either way the ids land in ``purged`` so the
        viewer never lists the chat again and a helper that is still finishing work cannot
        resurrect it by writing one more row after the purge.

        Returns the number of event rows deleted. Never raises: the host calls this from a
        delete path and a recording failure must not break the delete.
        """
        ids = [sid for sid in dict.fromkeys(session_ids or ()) if isinstance(sid, str) and sid]
        if not ids:
            return 0
        try:
            conn = self._open_db()
            try:
                scope = self._expand_scope(conn, ids)
                now = time.time()
                conn.executemany(
                    "INSERT OR REPLACE INTO purged(session_id, ts, reason) VALUES (?, ?, ?)",
                    [(sid, now, str(reason or "delete")) for sid in scope],
                )
                deleted = 0
                if str(reason or "delete") != self.ARCHIVE_REASON:
                    placeholders = ", ".join("?" for _ in scope)
                    deleted = conn.execute(
                        f"DELETE FROM events WHERE session_id IN ({placeholders})", list(scope)
                    ).rowcount
                conn.commit()
                return max(0, deleted)
            finally:
                conn.close()
        except sqlite3.Error:
            log.warning("omniscience: purging a deleted chat failed", exc_info=True)
            return 0

    @staticmethod
    def _expand_scope(conn, roots):
        """The given chats plus every helper session that belongs to them."""
        seen = set(roots)
        frontier = set(roots)
        while frontier:
            ids = list(frontier)
            placeholders = ", ".join("?" for _ in ids)
            found = set()
            for (child,) in conn.execute(
                "SELECT DISTINCT session_id FROM events "
                f"WHERE parent_session_id IN ({placeholders}) AND session_id IS NOT NULL",
                ids,
            ):
                if child:
                    found.add(child)
            for (child,) in conn.execute(
                "SELECT DISTINCT json_extract(attrs, '$.child_session_id') FROM events "
                f"WHERE kind = 'subagent.start' AND session_id IN ({placeholders})",
                ids,
            ):
                if child:
                    found.add(child)
            frontier = found - seen
            seen |= frontier
        return seen

    # -- writer side ------------------------------------------------------

    def _open_db(self):
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA wal_autocheckpoint=1000")  # Checkpoint every 1000 pages (prevents WAL growth)
        conn.execute("PRAGMA journal_size_limit=10485760")  # Cap WAL at 10MB
        conn.executescript(DDL)
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)",
            ("schema_version", SCHEMA_VERSION),
        )
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)",
            ("created_at", str(time.time())),
        )
        conn.commit()
        # Always, not only on creation: this file holds every recording, and one written by
        # an older version, restored from a backup, or copied in from elsewhere can carry a
        # looser mode. 0600 is an invariant of the database, not a one-time setup step.
        self._chmod_private()
        return conn

    def _chmod_private(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            path = self.db_path + suffix
            try:
                os.chmod(path, 0o600)
            except FileNotFoundError:
                # -wal/-shm are created on first write; the next open picks them up.
                continue
            except OSError:
                log.debug("omniscience: could not restrict %s to 0600", path, exc_info=True)

    def _collect(self):
        try:
            first = self._q.get(timeout=self.flush_interval)
        except queue.Empty:
            return []
        batch = [first]
        while len(batch) < self.batch_max:
            try:
                batch.append(self._q.get_nowait())
            except queue.Empty:
                break
        return batch

    def _write_batch(self, conn, batch) -> None:
        conn.executemany(INSERT_SQL, [_row(event) for event in batch])
        conn.commit()

    def _write_batch_with_retry(self, conn, batch) -> bool:
        try:
            self._write_batch(conn, batch)
        except Exception:
            log.debug("omniscience: batch write failed, retrying once", exc_info=True)
            try:
                conn.rollback()
            except Exception:
                log.debug("omniscience: rollback failed", exc_info=True)
            self._stop.wait(0.5)
            try:
                self._write_batch(conn, batch)
            except Exception:
                log.warning(
                    "omniscience: %d events could not be written; counting them as dropped",
                    len(batch), exc_info=True,
                )
                try:
                    conn.rollback()
                except Exception:
                    log.debug("omniscience: rollback failed", exc_info=True)
                self._count_dropped(len(batch), batch[0].seq)
                return False
        with self._lock:
            self._written += len(batch)
        return True

    def _emit_drop_marker(self, conn) -> None:
        """Write one ``omni.dropped`` row for everything counted since the last marker."""
        with self._lock:
            count = self._pending_dropped
            since = self._first_dropped_seq
            if count <= 0:
                return
        # The pending counter is lowered only after the row is committed. flush() reads that
        # counter, so clearing it here would let a shutdown report "everything written" while
        # the record of what was lost was still in flight.
        seq = self._next_seq()
        event = Event(
            event_id=make_event_id(
                "omni.dropped", f"{self.boot_id}|{since}|{count}|{seq}"
            ),
            schema=SCHEMA_VERSION,
            boot_id=self.boot_id,
            seq=seq,
            ts=time.time(),
            kind="omni.dropped",
            attrs={"count": count, "since_seq": since},
        )
        for attempt in (1, 2):
            try:
                self._write_batch(conn, [event])
                break
            except Exception:
                log.debug("omniscience: drop marker write failed (attempt %d)", attempt, exc_info=True)
                try:
                    conn.rollback()
                except Exception:
                    log.debug("omniscience: rollback failed", exc_info=True)
                if attempt == 1:
                    self._stop.wait(0.5)
        else:
            # Stays pending; the writer loop tries again on its next pass.
            return
        with self._lock:
            self._pending_dropped = max(0, self._pending_dropped - count)
            if self._pending_dropped == 0:
                self._first_dropped_seq = None
            self._written += 1

    def _drain_queue_as_dropped(self) -> None:
        """Account for events still queued when the writer stops, instead of stranding them.

        A stranded queue used to mean events that were neither written nor counted anywhere:
        no marker, no drop count, just a ``queue_depth`` nobody reads at exit.
        """
        while True:
            try:
                event = self._q.get_nowait()
            except queue.Empty:
                return
            try:
                self._count_dropped(1, event.seq)
            finally:
                self._q.task_done()

    def _writer_loop(self) -> None:
        conn = None
        try:
            delay = 0.5
            open_reported = False
            while conn is None and not self._stop.is_set():
                try:
                    conn = self._open_db()
                except Exception:
                    if not open_reported:
                        open_reported = True
                        log.warning(
                            "omniscience: cannot open %s; events are counted as dropped until it opens",
                            self.db_path, exc_info=True,
                        )
                    # Can't open/initialise the DB: drain the queue into the drop counter and retry later.
                    while True:
                        try:
                            ev = self._q.get_nowait()
                        except queue.Empty:
                            break
                        self._count_dropped(1, ev.seq)
                        self._q.task_done()
                    self._stop.wait(delay)
                    delay = min(delay * 2, 30.0)
            if conn is None:
                return
            while not self._stop.is_set() or not self._q.empty():
                # Honour a stop even while paused, or close() waits out its join timeout and
                # the queue is never written.
                if self._pause.is_set() and not self._stop.is_set():
                    time.sleep(0.01)
                    continue
                batch = self._collect()
                if batch:
                    try:
                        self._write_batch_with_retry(conn, batch)
                    except Exception:
                        # One unexpected failure must cost this batch, never the writer thread.
                        log.warning(
                            "omniscience: %d events lost to an unexpected write failure",
                            len(batch), exc_info=True,
                        )
                        self._count_dropped(len(batch), batch[0].seq)
                    finally:
                        for _ in batch:
                            self._q.task_done()
                try:
                    self._emit_drop_marker(conn)
                except Exception:
                    log.warning("omniscience: could not write the drop marker", exc_info=True)
        except Exception:
            log.warning("omniscience: writer stopped unexpectedly; events may be lost", exc_info=True)
        finally:
            # Nothing may be left unaccounted for: whatever is still queued is now counted as
            # dropped, and the final marker records it if the connection is usable.
            self._drain_queue_as_dropped()
            if conn is not None:
                try:
                    self._emit_drop_marker(conn)
                except Exception:
                    log.warning("omniscience: final drop marker failed", exc_info=True)
                try:
                    conn.close()
                except Exception:
                    log.debug("omniscience: closing the database failed", exc_info=True)

    # -- lifecycle --------------------------------------------------------

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait until every queued event is written (or counted as dropped) and drop markers are out."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                pending_drops = self._pending_dropped
            if self._q.unfinished_tasks == 0 and pending_drops == 0:
                return True
            if not self._thread.is_alive():
                return False
            time.sleep(0.01)
        return False

    def close(self) -> None:
        self._stop.set()
        try:
            self._thread.join(timeout=10.0)
        except Exception:
            log.debug("omniscience: joining the writer thread failed", exc_info=True)
            return
        if self._thread.is_alive():
            # Say it: a writer that outlives close() is a daemon thread that will be killed
            # with its queue still full at interpreter exit.
            log.warning(
                "omniscience: writer still running %.1fs after close(); %d events still queued",
                10.0, self._q.qsize(),
            )

    def stats(self) -> dict:
        with self._lock:
            submitted = self._submitted
            written = self._written
            dropped = self.dropped
        return {
            "submitted": submitted,
            "written": written,
            "dropped": dropped,
            "queue_depth": self._q.qsize(),
        }
