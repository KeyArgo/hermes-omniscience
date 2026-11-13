"""FastAPI application for the read-only Omniscience viewer (ARCHITECTURE.md §4)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any

from urllib.parse import urlsplit

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import db as db_mod
from . import diagnose as diagnose_mod
from . import failure as failure_mod
from . import insight as insight_mod
from . import prefs as prefs_mod
from . import sources as sources_mod
from . import usage as usage_mod
from . import warnings as warnings_mod
from . import brake as brake_mod
from . import concerns as concerns_mod
from . import bundle as bundle_mod
from . import privacy as privacy_mod
from .auth import TokenMiddleware

log = logging.getLogger("omniscience")

# Anything that would need quoting inside the Content-Disposition filename.
_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")

# Poll interval for the live feed, per connected viewer: 1.0 s is the default, and the
# opening price of a faster one is real — measured on this machine with a single client,
# 1.0 s costs 28% of a core, 0.25 s costs 41%, 0.1 s costs 60%. Slower updates are cheaper;
# a test or a demo that needs the old cadence sets OMNISCIENCE_POLL_INTERVAL_S=0.25.
POLL_INTERVAL_S = float(os.environ.get("OMNISCIENCE_POLL_INTERVAL_S", "1.0"))
# A tab left open on an idle chat, or ten of them, must not cost what a busy chat costs: after a
# few empty polls the cadence stretches out, and the first row found brings it back. The feed is
# still live — it is simply quieter when nothing is happening.
IDLE_POLL_INTERVAL_S = float(os.environ.get("OMNISCIENCE_IDLE_POLL_INTERVAL_S", "4.0"))
IDLE_AFTER = 3
HEARTBEAT_INTERVAL_S = 10.0


class SandboxedFrameCors:
    """CORS for one origin only: the opaque origin of a sandboxed frame.

    The desktop embeds this page with the SDK's ``SandboxedFrame``, whose guest has no origin of
    its own and reports ``Origin: null``. A ``null`` origin is cross-origin to the viewer, so the
    guest's ``fetch`` — which carries the ``X-Omni-Token`` header, so it is never a simple
    request — needs a preflight answer, and its responses need the origin echoed or the browser
    discards them.

    Scoped deliberately: a real site gets no CORS headers at all, the allowed methods are the
    ones the page uses, and every request on ``/api/`` is still gated by the token. Answering
    only ``null`` keeps a random page's ``fetch`` exactly as blocked as it was.
    """

    ALLOWED_METHODS = b"GET, POST, OPTIONS"
    ALLOWED_HEADERS = b"x-omni-token, content-type, accept"

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in (scope.get("headers") or [])
        }
        if not path.startswith("/api/") or headers.get("origin") != "null":
            await self.app(scope, receive, send)
            return

        if scope.get("method", "").upper() == "OPTIONS":
            await send(
                {
                    "type": "http.response.start",
                    "status": 204,
                    "headers": [
                        (b"access-control-allow-origin", b"null"),
                        (b"access-control-allow-methods", self.ALLOWED_METHODS),
                        (b"access-control-allow-headers", self.ALLOWED_HEADERS),
                        (b"access-control-max-age", b"600"),
                        (b"vary", b"origin"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b""})
            return

        async def with_cors(message: dict) -> None:
            if message.get("type") == "http.response.start":
                message = {
                    **message,
                    "headers": list(message.get("headers") or [])
                    + [(b"access-control-allow-origin", b"null"), (b"vary", b"origin")],
                }
            await send(message)

        await self.app(scope, receive, with_cors)


LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"]

# Addresses that mean "this machine, no network involved". Only these get the viewer key
# embedded in the page they are served.
LOOPBACK_CLIENTS = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


def _is_loopback_client(host: str | None) -> bool:
    return bool(host) and str(host) in LOOPBACK_CLIENTS


def _inject_key(html: str, token: str | None) -> str:
    """Hand the current key to the page it is served with.

    The viewer owns the key and serves the page, so a reload can always recover from a key
    that rotated under an open tab (the "This page's key is out of date" dead end). The
    page is same-origin, so a hostile site cannot read the injected value; and callers must
    only inject for loopback clients (see ``_is_loopback_client``) so a network client never
    receives the key here.
    """
    if not token:
        return html
    snippet = f"<script>window.__OMNI_TOKEN__={json.dumps(token)};</script>"
    marker = "</head>"
    if marker in html:
        return html.replace(marker, snippet + marker, 1)
    return snippet + html


def _db_fingerprint(db_path: str) -> str:
    """Return a short fingerprint of the database path for identity verification."""
    try:
        real = os.path.realpath(db_path)
    except OSError:
        real = db_path
    return hashlib.sha256(real.encode("utf-8")).hexdigest()[:12]


def _origin_allowed(origin: str | None, host_header: str | None) -> bool:
    """Same-origin only: browsers let any site open a WebSocket to localhost, so check Origin.

    The one exception is the opaque origin ("null") a sandboxed frame reports: the desktop embeds
    this page in the SDK's SandboxedFrame, so the live feed has to open from there. What actually
    protects the socket is the per-launch token in the subprotocol, which a hostile page cannot
    read — the Origin check is defence in depth, not the lock.
    """
    if not origin:
        return True  # non-browser client (curl, tests)
    if origin == "null":
        return True  # a sandboxed frame: opaque origin, token still required
    try:
        return urlsplit(origin).netloc == (host_header or "")
    except ValueError:
        return False


BACKFILL_PAGE = 1000
BACKFILL_MAX_ROUNDS = 8


def _linked_children(rows) -> set[str]:
    """Session ids named by ``subagent.start`` link rows."""
    found: set[str] = set()
    for row in rows:
        if row.get("kind") != "subagent.start":
            continue
        child = (row.get("attrs") or {}).get("child_session_id")
        if isinstance(child, str) and child:
            found.add(child)
    return found


def _collect_backfill(db_path: str, seed, cursor: int):
    """Every row at or before *cursor* for *seed* and for the helpers they link to.

    A link row can name a helper that itself links to another helper, and that helper's
    history is just as far behind the cursor. Following the links found in the rows we fetch
    closes the whole subtree, a bounded number of levels deep. Returns
    ``(rows ascending by rowid, ids fetched)``; ids fetched with no rows are still returned so
    the caller does not ask for them again.
    """
    fetched: dict[int, dict] = {}
    seen: set[str] = set()
    pending = [sid for sid in seed if sid]
    for _ in range(BACKFILL_MAX_ROUNDS):
        if not pending:
            break
        seen.update(pending)
        page_rows: list[dict] = []
        floor = 0
        while True:
            page, error = db_mod.events_for_sessions_checked(
                db_path, sorted(pending), cursor, BACKFILL_PAGE, floor
            )
            if error is not None:
                # An empty page and a lock look identical otherwise, and the caller would mark
                # these ids as seen - losing the helper's history for the rest of the session.
                raise RuntimeError(error)
            if not page:
                break
            page_rows.extend(page)
            floor = page[-1]["rowid"]
            if len(page) < BACKFILL_PAGE:
                break
        if not page_rows:
            break
        for row in page_rows:
            fetched.setdefault(row["rowid"], row)
        pending = [child for child in _linked_children(page_rows) if child not in seen]
    return [fetched[rowid] for rowid in sorted(fetched)], seen


def _presented_subprotocol(headers) -> str | None:
    """The `omni.<token>` the client proposed as a WebSocket subprotocol, or None.

    Browsers cannot set an arbitrary header on ``new WebSocket``, so the live socket
    carries the per-launch token in the ``Sec-WebSocket-Protocol`` header instead of
    the URL. The server echoes exactly one of the client's proposed protocols on
    ``accept()`` so the handshake completes.
    """
    items = headers.items() if hasattr(headers, "items") else headers
    for name, value in items:
        try:
            if name.lower() == "sec-websocket-protocol":
                for part in value.split(","):
                    part = part.strip()
                    if part.startswith("omni."):
                        return part
        except Exception:
            continue
    return None


class _FreshStaticFiles(StaticFiles):
    """The page itself is always re-checked (so an updated plugin shows its new look at once);
    the hashed asset files it points to never change, so they may be cached for good."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Starlette hands over an OS path: "assets\\index-abc.js" on Windows.
        if path.replace("\\", "/").startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            # A stale document is what strands a tab on old code; forbid storing it at all.
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response



def _pid_alive_windows(pid: int) -> bool:
    """Windows has no /proc or signal 0, so ask the kernel for the exit code."""
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _pid_state_from_ps(pid: int) -> bool:
    """POSIX without /proc (macOS, BSD): `ps` reports Z for a zombie."""
    try:
        proc = subprocess.run(
            ["ps", "-o", "stat=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return True  # cannot check it, so do not close a viewer that may still be needed
    state = proc.stdout.strip()
    if not state:
        return False
    return not state.startswith("Z")


def _pid_alive(pid: int) -> bool:
    """Is this process still running (not gone, not a zombie)?

    os.kill(pid, 0) succeeds for a zombie, and a parent that exited without being reaped stays a
    zombie for as long as its own parent lives — which is how a watcher that only asks "does this
    pid exist" keeps serving for hours after the app closed. Read the state instead, portably:
    /proc on Linux, `ps` on macOS/BSD, OpenProcess on Windows.
    """
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    try:
        with open(f"/proc/{pid}/stat", "rb") as handle:
            state = handle.read().rsplit(b") ", 1)[1].split(b" ", 1)[0]
    except FileNotFoundError:
        return _pid_state_from_ps(pid)
    except (OSError, IndexError):
        return True
    return state not in (b"Z", b"X")


def _watch_parent() -> None:
    """Exit when the process that started the viewer is gone.

    A detached viewer outlives a page reload by design; it must not outlive Hermes. Without this,
    closing the app leaves a server behind that still serves, still logs and still spends CPU.
    """
    raw = os.environ.get("OMNISCIENCE_PARENT_PID")
    if not raw or not raw.isdigit():
        return
    parent = int(raw)

    def watch() -> None:
        while True:
            time.sleep(5.0)
            if not _pid_alive(parent):
                log.info("omniscience: parent %s is gone, closing the viewer", parent)
                os._exit(0)

    threading.Thread(target=watch, name="omniscience-parent-watch", daemon=True).start()


def create_app(db_path: str, static_dir: str | None = None,
               allowed_hosts: list[str] | None = None,
               token: str | None = None) -> FastAPI:
    _watch_parent()
    app = FastAPI(title="Hermes Omniscience Viewer", docs_url=None, redoc_url=None)
    # Blocks DNS-rebinding: a hostile page can't reach us under its own hostname.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts or LOCAL_HOSTS)
    # A shared mutable holder: __main__ writes the per-launch token into this dict after the
    # server binds; the registered TokenMiddleware reads from the same dict every request, so
    # the token actually takes effect even though it is generated after create_app(...).
    token_state: dict[str, str | None] = {"token": token}
    app.state.token_state = token_state
    app.state.token_middleware = None  # top-level registration below
    app.add_middleware(TokenMiddleware, token_state=token_state)
    # Outermost (added last): a sandboxed frame preflights every API call, and the preflight
    # carries no token, so it must be answered before TokenMiddleware sees it.
    app.add_middleware(SandboxedFrameCors)

    def _build_id() -> str:
        """A cheap marker for the page that is installed right now.

        The page is served no-cache but its hashed bundle is immutable, so a tab opened before
        an update keeps running the old code until someone reloads. The page compares this on a
        timer and offers a reload, instead of a stale view looking like a broken one.
        """
        target = os.path.join(static_dir, "index.html") if static_dir else None
        try:
            st = os.stat(target) if target else None
        except OSError:
            return "none"
        if st is None:
            return "none"
        return f"{int(st.st_mtime)}-{st.st_size}"

    @app.get("/api/v1/latency")
    def latency_route(window: int = 0) -> dict:
        """Observed model latency per provider and model: measured from recorded calls, no probing.

        ``window`` limits the lookback in seconds (0 = everything recorded). ``providers`` folds
        the same rows per provider, because a rate limit or a queue belongs to the account.
        """
        rows = db_mod.latency_by_model(db_path, window_seconds=window or None)
        return {
            "window_s": window or None,
            "models": rows,
            "providers": db_mod.rollup_by_provider(rows),
        }

    @app.get("/api/v1/insight")
    def insight_latest() -> dict:
        """The writeup Hermes already wrote for this recording, if there is one.

        The viewer cannot ask a model: it has no Hermes credentials and must not want any. The
        plugin writes the report beside the recording with ``ctx.llm`` (``/omni insight`` in
        Hermes); this route only reads that file back, so the page shows the same text the
        operator got in chat.
        """
        report = insight_mod.load(db_path)
        return {
            "available": report is not None,
            "report": report,
            "hint": (
                "In Hermes, run /omni insight (optionally /omni insight 30 for a period). "
                "Hermes writes it with the model you are already using, so the viewer never "
                "holds a key."
            ),
        }

    _usage_cache: dict[float, tuple[float, dict]] = {}

    @app.get("/api/v1/usage")
    def usage_route(days: float = 7, fresh: int = 0) -> dict:
        """What this machine spent, in detail: tokens from the recording, money from Hermes.

        ``days`` is the lookback (0 = everything recorded). The recorder never stores a price,
        so a dollar figure comes from Hermes' own ``state.db`` estimate and is labelled as
        such; without that database the page still answers, with tokens and no money.
        """
        try:
            # Float on purpose: "the last hour" is 1/24 of a day, and int() would round that to 0,
            # which this API means as "everything ever recorded".
            lookback = max(0.0, min(float(days), 3650.0))
        except (TypeError, ValueError):
            lookback = 7.0
        state_db = None
        try:
            from .labels import hermes_state_db

            found = hermes_state_db()
            state_db = str(found) if found else None
        except Exception:
            # Cost is one section of the page; a missing session store must not empty it.
            log.debug("omniscience: locating Hermes' state database failed", exc_info=True)
        # Aggregating a month of imported history takes seconds; a page that is opened, left and
        # returned to should not pay that every time. Twenty seconds is short enough that the
        # freshness footer ("generated …") stays honest.
        cached = _usage_cache.get(lookback)
        if cached and not fresh and time.time() - cached[0] < 20:
            return cached[1]
        try:
            payload = usage_mod.build_usage(db_path, state_db, days=lookback)
        except sqlite3.Error as exc:
            raise HTTPException(status_code=503, detail=f"database unavailable: {exc}") from exc
        _usage_cache[lookback] = (time.time(), payload)
        return payload

    @app.get("/api/v1/usage/sources")
    def usage_sources_route() -> dict:
        """Which harnesses the page may read, and what each would read if switched on.

        Nothing is imported while a source is off — `sources.delete_source` removes its rows and
        its file cursors, so "off" means absent, not hidden.
        """
        try:
            return {"sources": sources_mod.source_status(db_path)}
        except sqlite3.Error as exc:
            raise HTTPException(status_code=503, detail=f"database unavailable: {exc}") from exc

    @app.get("/api/v1/concerns")
    def concerns_route(days: float = 1) -> dict:
        """What deserves attention in the window, counted rather than listed."""
        try:
            window = max(0.0, min(float(days), 3650.0))
        except (TypeError, ValueError):
            window = 1.0
        try:
            return concerns_mod.build_concerns(db_path, window)
        except sqlite3.Error as exc:
            raise HTTPException(status_code=503, detail=f"cannot read the recording: {exc}") from exc

    @app.get("/api/v1/privacy")
    def privacy_runs(days: float = 7.0) -> dict:
        """Every privacy-relevant tool run in the window, newest first."""
        window = max(0.0, min(days, 3650.0))
        return {"runs": privacy_mod.list_runs(db_path, window), "days": window}

    @app.get("/api/v1/privacy/flags")
    def privacy_flags() -> dict:
        return {"flags": privacy_mod.list_flags(os.path.dirname(db_path))}


    @app.post("/api/v1/bundle/preview")
    def bundle_preview(payload: dict = Body(...)) -> dict:
        """The exact object that would be written, for the user to inspect first."""
        session_id = payload.get("session_id") if isinstance(payload, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(status_code=400, detail="choose a chat to bundle")
        try:
            return bundle_mod.build_bundle(db_path, session_id=session_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/api/v1/bundle/write")
    def bundle_write(payload: dict = Body(...)) -> dict:
        """Write the bundle the user just previewed. Nothing is written that was not shown."""
        session_id = payload.get("session_id") if isinstance(payload, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(status_code=400, detail="choose a chat to bundle")
        try:
            bundle = bundle_mod.build_bundle(db_path, session_id=session_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        name = "omniscience-bundle-" + str(bundle["bundle_id"])[:8] + ".json"
        dest = os.path.join(os.path.dirname(db_path), "bundles", name)
        bundle_mod.write_bundle(bundle, dest)
        return {"path": dest, "summary": bundle["summary"], "redaction": bundle["redaction_report"]}

    @app.post("/api/v1/privacy/flag")
    def privacy_flag(payload: dict = Body(...)) -> dict:
        """Write a self-contained dossier for one action and its surroundings."""
        session_id = payload.get("session_id") if isinstance(payload, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(status_code=400, detail="session_id is required")
        event_id = payload.get("event_id")
        note = payload.get("note") if isinstance(payload.get("note"), str) else ""
        try:
            return privacy_mod.write_flag(
                db_path,
                os.path.dirname(db_path),
                session_id,
                event_id if isinstance(event_id, str) else None,
                note,
            )
        except (sqlite3.Error, ValueError) as exc:
            raise HTTPException(status_code=503, detail=f"cannot read the recording: {exc}") from exc

    @app.post("/api/v1/run/stop")
    def run_stop(payload: dict = Body(...)) -> dict:
        """Stop the chat, if the host's run API has been switched on for this viewer.

        With the brake off the answer is an honest refusal in words; with it on, the host API is
        asked, and its own answer (including "this chat is not a run") is passed back.
        """
        session_id = payload.get("session_id") if isinstance(payload, dict) else None
        action = payload.get("action") if isinstance(payload, dict) else None
        if action not in ("stop", "skip"):
            raise HTTPException(status_code=400, detail="action must be 'stop' or 'skip'")
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(status_code=400, detail="session_id is required")
        return brake_mod.stop_run(os.path.dirname(db_path), session_id, action)

    @app.post("/api/v1/usage/sources")
    def usage_source_switch(payload: dict = Body(...)) -> dict:
        """Switch one harness on (scan it now) or off (delete what was imported).

        This is the only write the viewer performs, and it writes `usage.db` beside the
        recording's database — never into the recording itself.
        """
        source = payload.get("source") if isinstance(payload, dict) else None
        if not isinstance(source, str) or source not in sources_mod.SOURCES:
            raise HTTPException(status_code=400, detail="unknown source")
        enabled = payload.get("enabled", True)
        if not isinstance(enabled, bool):
            raise HTTPException(status_code=400, detail="enabled must be true or false")
        result = sources_mod.set_enabled(source, db_path, enabled)
        return {"sources": sources_mod.source_status(db_path), "result": result}

    @app.get("/api/v1/failures")
    def failures_route(root: str, window: int = 0) -> dict:
        """Every failure in a run, explained: what happened, why, and what to do next.

        Reads the newest rows for the chat and its helpers, and answers from the structured fields
        only — no message text is stored, so nothing here can quote a conversation.
        """
        limit = max(100, min(int(window or diagnose_mod.DIAGNOSE_WINDOW), 20000))
        events = db_mod.events_for_root(db_path, root or None, limit=limit, tail=True)
        failures = failure_mod.explain_failures(events)
        return {
            "root": root,
            "window": limit,
            # Why the run stopped, which is a fact about the flow (an unanswered request), not a
            # failure row — the two questions "what failed" and "why did it stop" have different
            # answers and both are asked.
            "stop": failure_mod.explain_stop(events),
            # A full window may hide an earlier failure; say so rather than implying the list is
            # the whole story.
            "truncated": len(events) >= limit,
            "failures": failures,
        }

    @app.get("/api/v1/version")
    def version_route() -> dict:
        """Exactly which build is answering, so a screenshot can be matched to a commit."""
        try:
            from .version_stamp import as_dict
        except Exception:  # pragma: no cover - the stamp is optional
            info: dict = {"version": "unknown", "commit": "", "commit_short": "", "dirty": None}
        else:
            info = as_dict()
        return {
            **info,
            "build": _build_id(),
            "static_dir": os.path.abspath(static_dir) if static_dir else "",
        }

    @app.get("/api/v1/ping")
    def ping() -> dict:
        return {"ok": True, "db_fingerprint": _db_fingerprint(db_path), "build": _build_id()}

    @app.get("/api/v1/health")
    def health() -> dict:
        return db_mod.health(db_path)

    @app.get("/api/v1/sessions")
    def sessions(limit: int = 100) -> list[dict]:
        rows, error = db_mod.list_sessions_checked(db_path, limit)
        if error is not None:
            # An empty list would render as "0 conversations recorded" - a lie when the
            # database is simply busy or unreadable.
            raise HTTPException(status_code=503, detail=f"database unavailable: {error}")
        # Chat titles come from Hermes's own session titles (they can hold the start of what the
        # user typed). The viewer only answers this computer behind its key, and Hermes shows the same
        # titles, so they are on by default; OMNISCIENCE_VIEWER_CONTENT_LABELS=0 turns them off and
        # the viewer's settings can hide them on screen.
        content_labels_enabled = os.environ.get("OMNISCIENCE_VIEWER_CONTENT_LABELS", "1").strip().lower() not in ("0", "false", "no", "off")
        try:
            from .labels import labels_for, session_metadata

            session_ids = [r.get("id") for r in rows if r.get("id")]
            metadata = session_metadata(session_ids)
            if content_labels_enabled:
                names = labels_for(session_ids)
            else:
                names = {}
        except Exception:
            # Labels are cosmetic: a broken titles file must not empty the chat list.
            log.debug("omniscience: reading chat labels failed", exc_info=True)
            names = {}
            metadata = {}
        for row in rows:
            sid = row.get("id") or ""
            if content_labels_enabled and sid in names:
                row["label"] = names[sid]
            else:
                # Metadata-only: use session id as label (no content exposure)
                row["label"] = sid
            row.update(metadata.get(sid, {}))
        return rows

    @app.get("/api/v1/events")
    def events(root: str | None = None, after: int = 0, limit: int = 1000, before: int | None = None, tail: bool = False) -> list[dict]:
        if not root:
            return []
        if not os.path.exists(db_path):
            # Nothing recorded yet (the plugin creates the file on its first event). The
            # websocket feed keeps reporting a database that disappears mid-session as an
            # error, which is why this check lives here and not in the reader.
            return []
        rows, error = db_mod.events_for_root_checked(
            db_path, root, after, min(max(limit, 0), 2000), before, tail
        )
        if error is not None:
            # Same rule as the session list: an empty list means "this chat has no steps", so a
            # busy or unreadable database must say so instead of answering with one.
            raise HTTPException(status_code=503, detail=f"database unavailable: {error}")
        return rows

    @app.get("/api/v1/prefs")
    def get_prefs() -> dict:
        """The settings the chat and the viewer share (today: the in-chat summary)."""
        return prefs_mod.load(prefs_mod.path_for(db_path))

    @app.post("/api/v1/prefs")
    def set_prefs(payload: dict = Body(...)) -> dict:
        """Change a shared setting. Unknown keys are ignored; values are validated."""
        path = prefs_mod.path_for(db_path)
        current = prefs_mod.load(path)
        digest = payload.get("digest") if isinstance(payload, dict) else None
        enabled = None
        detail = None
        if isinstance(digest, dict):
            if isinstance(digest.get("enabled"), bool):
                enabled = digest["enabled"]
            if isinstance(digest.get("detail"), str):
                detail = digest["detail"]
        updated = prefs_mod.set_digest(current, enabled=enabled, detail=detail)
        if not prefs_mod.save(path, updated):
            raise HTTPException(status_code=500, detail="could not save the setting")
        return updated

    @app.get("/api/v1/export/{table}.csv")
    def export_csv(table: str, root: str | None = None):
        """Spreadsheet-ready CSV (metadata only): steps of one chat (or all), chats, or models."""
        from fastapi.responses import Response

        from . import export as export_mod

        if table == "steps":
            text = export_mod.export_steps(db_path, root or None)
        elif table == "chats":
            text = export_mod.export_chats(db_path)
        elif table == "models":
            text = export_mod.export_models(db_path, root or None)
        else:
            raise HTTPException(status_code=404, detail="unknown export")
        stamp = time.strftime("%Y%m%d-%H%M")
        scope = (root or "all")[-8:] if table != "chats" else "all"
        # ``root`` is caller-supplied. The filename goes into a quoted Content-Disposition
        # header, so a quote in it produced a malformed header (and a saved file named
        # anything the caller liked). Keep the name to characters that need no quoting.
        scope = _FILENAME_UNSAFE.sub("_", scope)
        name = f"omniscience-{table}-{scope}-{stamp}.csv".replace("/", "_")
        return Response(
            content=text.encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
        )

    @app.get("/api/v1/warnings")
    def warnings(root: str | None = None) -> list[dict]:
        if not root:
            return []
        return warnings_mod.warnings_for_root(db_path, root)

    @app.get("/api/v1/diagnose")
    def diagnose(root: str | None = None) -> dict:
        if not root:
            raise HTTPException(status_code=400, detail="root query parameter is required")
        return diagnose_mod.explain(db_path, root)

    @app.websocket("/api/v1/live")
    async def live(websocket: WebSocket, root: str | None = None, after: int = 0) -> None:
        if not _origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
            await websocket.close(code=1008)
            return
        # The client proposes `omni.<token>` as a subprotocol (browsers cannot set a
        # header on `new WebSocket`, so the token rides the Sec-WebSocket-Protocol
        # header, not the URL). Echo it back so the handshake completes in a real
        # browser; rejecting the subprotocol here aborts the socket with a protocol error.
        websocket_sub = _presented_subprotocol(websocket.headers)
        await websocket.accept(subprotocol=websocket_sub)
        cursor = after or 0
        last_heartbeat = time.monotonic()
        idle_polls = 0
        db_broken = False
        seen_sessions: set[str] = {root} if root else set()
        pending_backfill: set[str] = set()
        try:
            while True:
                if root:
                    try:
                        rows, error = await asyncio.to_thread(
                            db_mod.events_for_root_checked, db_path, root, cursor, 1000
                        )
                    except Exception:
                        # Never let a transient failure kill the feed silently.
                        rows, error = [], "database unavailable"
                    if error is not None:
                        # A broken feed must not look healthy: say so once, keep polling,
                        # and announce recovery when the DB works again.
                        if not db_broken:
                            db_broken = True
                            await websocket.send_json(
                                {"type": "error", "detail": "database unavailable"}
                            )
                    else:
                        if db_broken:
                            db_broken = False
                            await websocket.send_json({"type": "recovered"})
                        if not rows and pending_backfill:
                            # An idle poll is where a failed backfill gets its retry, so one
                            # transient lock cannot lose a helper's history for the session.
                            try:
                                extra, fetched_ids = await asyncio.to_thread(
                                    _collect_backfill, db_path, sorted(pending_backfill), cursor
                                )
                            except Exception:
                                log.debug("omniscience: backfill retry failed", exc_info=True)
                            else:
                                pending_backfill = set()
                                seen_sessions |= fetched_ids
                                if extra:
                                    await websocket.send_json({"type": "events", "events": extra})
                        if rows:
                            known: set[str] = {
                                sid for sid in (r.get("session_id") for r in rows)
                                if isinstance(sid, str) and sid
                            }
                            # A link row reveals a helper that may have no row of its own in
                            # this poll: every one of its events can sit before the cursor, so
                            # nothing would ever ask for them. Name it here so the backfill
                            # below picks up its history.
                            known |= _linked_children(rows)
                            new_ids = (known - seen_sessions) | pending_backfill
                            if new_ids:
                                # A descendant session may appear late: its events can be
                                # written before the row that links it to the root, so those
                                # rows have rowid <= cursor and the normal poll misses them.
                                # Backfill the subtree up to the cursor; the client dedupes by
                                # rowid, and paging means a big helper is fetched completely.
                                try:
                                    extra, fetched_ids = await asyncio.to_thread(
                                        _collect_backfill, db_path, sorted(new_ids), cursor
                                    )
                                except Exception:
                                    # Try again on the next poll (idle or not): one transient
                                    # lock must not lose a helper's history for the session.
                                    log.debug(
                                        "omniscience: backfill failed; will retry next poll",
                                        exc_info=True,
                                    )
                                    pending_backfill = set(new_ids)
                                    known = known - new_ids
                                else:
                                    pending_backfill = set()
                                    known |= fetched_ids
                                    if extra:
                                        by_rowid = {r["rowid"]: r for r in rows}
                                        for row in extra:
                                            by_rowid.setdefault(row["rowid"], row)
                                        rows = [by_rowid[k] for k in sorted(by_rowid)]
                            seen_sessions |= known
                            cursor = rows[-1]["rowid"]
                            await websocket.send_json({"type": "events", "events": rows})
                            idle_polls = 0 if rows else idle_polls + 1

                now = time.monotonic()
                if now - last_heartbeat >= HEARTBEAT_INTERVAL_S:
                    await websocket.send_json({"type": "heartbeat"})
                    last_heartbeat = now

                await asyncio.sleep(
                    IDLE_POLL_INTERVAL_S if idle_polls >= IDLE_AFTER else POLL_INTERVAL_S
                )
        except WebSocketDisconnect:
            return
        except Exception:
            log.debug("omniscience: live feed closed by an unexpected error", exc_info=True)
            return

    index_path = os.path.join(static_dir, "index.html") if static_dir else None

    @app.get("/", include_in_schema=False)
    def index_page(request: Request):
        """Serve the page with the current key for this machine, so a reload always works.

        Served here rather than by the static mount so the token, which is only known after
        the server binds, can be written into the page. Registered before the mount, so this
        route answers "/" and the mount keeps serving the hashed assets.
        """
        if not index_path or not os.path.isfile(index_path):
            return HTMLResponse("<h1>Omniscience viewer</h1><p>No page bundle is installed.</p>")
        with open(index_path, "r", encoding="utf-8") as fh:
            html = fh.read()
        client_host = request.client.host if request.client else None
        if _is_loopback_client(client_host):
            html = _inject_key(html, token_state.get("token"))
        return HTMLResponse(
            html,
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate",
                "Pragma": "no-cache",
            },
        )

    if static_dir and os.path.isdir(static_dir):
        app.mount("/", _FreshStaticFiles(directory=static_dir, html=True), name="static")

    return app
