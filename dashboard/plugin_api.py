"""Omniscience dashboard plugin backend, mounted at /api/plugins/omniscience/.

Read-only health endpoint over the plugin's event database (see docs/DECISIONS.md D4:
``<HERMES_HOME>/plugin-data/omniscience/events.db``). No write endpoints — the plugin
itself is the sole writer (D2).

Per the Hermes dashboard doc ("Don't block the event loop"): every handler is async and
all blocking SQLite work runs off the loop via ``asyncio.to_thread``.
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
from pathlib import Path

from fastapi import APIRouter

try:  # hermes_constants ships with Hermes; keep the module importable outside Hermes too
    from hermes_constants import get_hermes_home
except Exception:  # pragma: no cover - fallback for non-Hermes import contexts
    def get_hermes_home() -> Path:  # type: ignore[misc]
        env = os.environ.get("HERMES_HOME")
        return Path(env).expanduser() if env else Path("~/.hermes").expanduser()

router = APIRouter()

PLUGIN_NAME = "omniscience"
DEFAULT_VIEWER_URL = "http://127.0.0.1:8797"


def _db_path() -> Path:
    """Resolve the event DB path exactly as the recorder/launcher do: OMNISCIENCE_DB wins."""
    override = os.environ.get("OMNISCIENCE_DB")
    if override:
        return Path(override).expanduser()
    return get_hermes_home() / "plugin-data" / PLUGIN_NAME / "events.db"


def _viewer_url() -> str:
    env = os.environ.get("OMNISCIENCE_VIEWER_URL")
    return env.strip() or DEFAULT_VIEWER_URL if env else DEFAULT_VIEWER_URL


def _query_locked(db_path: Path) -> dict:
    """Blocking DB read; called via asyncio.to_thread. Opens READ-ONLY (mode=ro) so a
    dashboard request can never interfere with the plugin's writer, and never creates
    the DB as a side effect of viewing it."""
    uri = "file:" + str(db_path).replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5.0)
    try:
        try:
            row = conn.execute("SELECT COUNT(*), MAX(ts) FROM events").fetchone()
        except sqlite3.OperationalError as exc:
            return {"ok": False, "error": f"query failed: {exc}"}
        count, last_ts = int(row[0] or 0), row[1]
        return {"ok": True, "events": count, "last_ts": float(last_ts) if last_ts is not None else None}
    finally:
        conn.close()


def _health_locked() -> dict:
    db_path = _db_path()
    result: dict = {
        "ok": False,
        "events": 0,
        "last_ts": None,
        "db_path": str(db_path),
        "viewer_url": _viewer_url(),
    }
    if not db_path.is_file():
        result["error"] = "event database not found"
        return result
    result.update(_query_locked(db_path))
    return result


@router.get("/health")
async def health() -> dict:
    """Read-only status of the omniscience event store + viewer location."""
    return await asyncio.to_thread(_health_locked)


def _viewer_link_locked() -> dict:
    """Viewer URL plus its per-launch key, for the desktop page. Behind Hermes dashboard auth."""
    # The profile folder may hold only a link to the shared DB; the key sits next to the real file.
    token_file = _db_path().resolve().parent / "viewer-token"
    try:
        token = token_file.read_text(encoding="utf-8").strip() or None
    except OSError:
        token = None
    return {"viewer_url": _viewer_url(), "token": token}


@router.get("/viewer")
async def viewer_link() -> dict:
    return await asyncio.to_thread(_viewer_link_locked)
