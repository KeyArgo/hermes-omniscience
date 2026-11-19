"""Omniscience dashboard plugin backend, mounted at /api/plugins/omniscience/.

Read-only health endpoint over the plugin's event database (see docs/DECISIONS.md D4:
``<HERMES_HOME>/plugin-data/omniscience/events.db``), plus the owner's viewer on/off switch
(``/viewer/mode``), which writes ``prefs.json`` but never the recording (D2). Asking for the viewer
link also restarts the viewer when it is down (see ``_ensure_viewer``); ``POST /viewer/restart``
stops it first and starts it again, the reset that does not quit Hermes. Starting a process writes
nothing to the recording.

Per the Hermes dashboard doc ("Don't block the event loop"): every handler is async and
all blocking SQLite work runs off the loop via ``asyncio.to_thread``.
"""
from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

try:  # hermes_constants ships with Hermes; keep the module importable outside Hermes too
    from hermes_constants import get_hermes_home
except Exception:  # pragma: no cover - fallback for non-Hermes import contexts
    def get_hermes_home() -> Path:  # type: ignore[misc]
        env = os.environ.get("HERMES_HOME")
        return Path(env).expanduser() if env else Path("~/.hermes").expanduser()

router = APIRouter()
log = logging.getLogger(__name__)

PLUGIN_NAME = "omniscience"
DEFAULT_VIEWER_URL = "http://127.0.0.1:8797"


def _db_path() -> Path:
    """Resolve the event DB path exactly as the recorder/launcher do: OMNISCIENCE_DB wins."""
    override = os.environ.get("OMNISCIENCE_DB")
    if override:
        return Path(override).expanduser()
    return get_hermes_home() / "plugin-data" / PLUGIN_NAME / "events.db"


def _state_db_path() -> Path:
    """Hermes' own store for the active profile — the same one the plugin reads.

    Never derived from where the plugin files sit: a shared or symlinked install would hand the
    viewer another profile's chat titles.
    """
    return get_hermes_home() / "state.db"


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


_LAUNCHER = None
_PREFS = None


def _launcher():
    """The plugin's viewer_launcher.py, beside this folder. Hermes loads this file by path, so a
    package-relative import is not available here."""
    global _LAUNCHER
    if _LAUNCHER is None:
        path = Path(__file__).resolve().parents[1] / "viewer_launcher.py"
        spec = importlib.util.spec_from_file_location("omniscience_dashboard_viewer_launcher", path)
        if not spec or not spec.loader:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _LAUNCHER = module
    return _LAUNCHER


def _prefs():
    """The plugin's prefs.py, beside this folder: the same file the recorder and the viewer read."""
    global _PREFS
    if _PREFS is None:
        path = Path(__file__).resolve().parents[1] / "prefs.py"
        spec = importlib.util.spec_from_file_location("omniscience_dashboard_prefs", path)
        if not spec or not spec.loader:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PREFS = module
    return _PREFS


_VERSION_STAMP = None


def _version_stamp():
    """The viewer's version_stamp.py, loaded by path like _launcher() does. The chip's values must
    come from the same place whether the viewer answers or the dashboard answers for it."""
    global _VERSION_STAMP
    if _VERSION_STAMP is None:
        path = (
            Path(__file__).resolve().parents[1]
            / "viewer"
            / "omniscience_viewer"
            / "version_stamp.py"
        )
        spec = importlib.util.spec_from_file_location("omniscience_dashboard_version_stamp", path)
        if not spec or not spec.loader:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _VERSION_STAMP = module
    return _VERSION_STAMP


def _version_locked() -> dict:
    stamp = _version_stamp()
    info = stamp.as_dict()
    return {**info, "chip_line": stamp.chip_line(info)}


@router.get("/version")
async def version() -> dict:
    """Which build this plugin is, in the same fields as the viewer's /api/v1/version, so the
    desktop settings chip shows the real version even while the viewer is off."""
    return await asyncio.to_thread(_version_locked)


def _viewer_enabled() -> bool:
    """The owner's switch. An unreadable settings file reads as the default (on)."""
    try:
        prefs_mod = _prefs()
        return prefs_mod.viewer_enabled(prefs_mod.load(prefs_mod.path_for(str(_db_path()))))
    except Exception:  # never let settings trouble stop the viewer from being offered
        log.debug("omniscience: could not read the viewer preference", exc_info=True)
        return True


def _stop_viewer() -> dict:
    """Stop a viewer this machine started; the launcher refuses anything but its own viewer."""
    real = os.path.realpath(_db_path())
    try:
        return _launcher().stop_viewer(os.path.dirname(real))
    except Exception as exc:  # a switch that cannot stop is still a switch that is off
        log.debug("omniscience: stopping the viewer from the dashboard failed", exc_info=True)
        return {"stopped": False, "reason": f"could not stop the viewer: {exc}"}


def _ensure_viewer() -> dict:
    """Start the viewer if it is down, owned by this long-lived dashboard process.

    The viewer stops when the Hermes process that started it exits. When that was a short-lived
    one (a one-shot chat, a CLI command), the page later found nothing listening and nothing
    restarted it. Opening the page now restarts it. The launcher still honours
    OMNISCIENCE_VIEWER_AUTOSTART=0, Pause, local-only URLs and its one-minute retry pause.

    The owner's switch comes first: with the ``viewer`` pref off nothing is started, and a viewer
    started earlier is stopped, so the pane shows "off" rather than an unexplained failure.
    """
    if not _viewer_enabled():
        _stop_viewer()
        return {"running": False, "reason": "off"}
    db = _db_path()
    if not db.is_file():
        return {"running": False, "reason": "event database not found"}
    real = os.path.realpath(db)
    try:
        result = _launcher().ensure_viewer(
            real,
            log_dir=os.path.dirname(real),
            autostart=True,
            state_db=str(_state_db_path()),
        )
    except Exception as exc:  # never let a launch problem break the link answer
        log.debug("omniscience: viewer restart from the dashboard failed", exc_info=True)
        return {"running": False, "reason": f"could not start the viewer: {exc}"}
    return {"running": bool(result.get("running")), "reason": str(result.get("reason", ""))}


def _viewer_link_locked() -> dict:
    """Viewer URL plus its per-launch key, for the desktop page. Behind Hermes dashboard auth."""
    viewer = _ensure_viewer()
    # The profile folder may hold only a link to the shared DB; the key sits next to the real file.
    token_file = _db_path().resolve().parent / "viewer-token"
    try:
        token = token_file.read_text(encoding="utf-8").strip() or None
    except OSError:
        token = None
    return {"viewer_url": _viewer_url(), "token": token, "viewer": viewer}


@router.get("/viewer")
async def viewer_link() -> dict:
    return await asyncio.to_thread(_viewer_link_locked)


def _restart_viewer_locked() -> dict:
    """Stop the viewer this machine started, then start it again and hand over the fresh link.

    The reset that does not quit Hermes: the viewer can stop under an open page (its parent
    process exited, or ten idle minutes passed), and a stuck or stale one is cleared by a real
    stop-then-start rather than by reopening the pane. The owner's switch still wins — with the
    viewer off nothing is started, and the answer says ``off``.
    """
    _stop_viewer()
    return _viewer_link_locked()


@router.post("/viewer/restart")
async def restart_viewer() -> dict:
    """Stop the viewer and start it again (the owner's on/off switch is respected)."""
    return await asyncio.to_thread(_restart_viewer_locked)


def _viewer_mode_locked() -> dict:
    return {"enabled": _viewer_enabled()}


@router.get("/viewer/mode")
async def viewer_mode() -> dict:
    """The owner's on/off switch, as stored (off: recording continues, the viewer does not run)."""
    return await asyncio.to_thread(_viewer_mode_locked)


def _set_viewer_mode_locked(enabled: bool) -> dict:
    """Save the switch, and stop the viewer on the way off.

    The answer is read back from disk, so a save that did not land is not reported as a change.
    """
    prefs_mod = _prefs()
    path = prefs_mod.path_for(str(_db_path()))
    prefs_mod.save(path, prefs_mod.set_viewer(prefs_mod.load(path), enabled))
    if not enabled:
        _stop_viewer()
    return {"enabled": prefs_mod.viewer_enabled(prefs_mod.load(path))}


@router.post("/viewer/mode")
async def set_viewer_mode(payload: dict = Body(...)) -> dict:
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(status_code=400, detail="enabled must be true or false")
    return await asyncio.to_thread(_set_viewer_mode_locked, enabled)
