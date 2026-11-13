"""Hermes Omniscience — metadata-only observer plugin."""

from __future__ import annotations

import logging
import os
import urllib.parse
import socket
import sys
import ipaddress
from pathlib import Path

from .store import EventStore
from . import prefs
from .command import diagnose_current

log = logging.getLogger("omniscience")

HOOKS = (
    "on_session_start",
    "on_session_end",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "post_tool_call",
    "subagent_start",
    "subagent_stop",
    "pre_auxiliary_call",
    "post_auxiliary_call",
    "on_skill_lifecycle",
    # Hermes fires this after a committed delete or a deliberate archive. Without it the
    # viewer keeps listing conversations the user removed, which is what "old conversations
    # that no longer exist" looks like from the outside.
    "on_session_delete",
)

_store = None
_notices = None
_paused = None
_ctx = None
# Hooks the live notices care about; others are only recorded.
_NOTICE_HOOKS = frozenset({"pre_llm_call", "pre_api_request", "post_api_request", "api_request_error", "post_tool_call"})


def _db_path() -> str:
    override = os.environ.get("OMNISCIENCE_DB")
    if override:
        return override
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    return os.path.join(home, "plugin-data", "omniscience", "events.db")


def _make_callback(hook_name):
    def callback(**kwargs):
        if hook_name == "on_session_delete":
            # A deleted or archived chat must leave the viewer, not linger as a row nobody
            # recognises. Handled here rather than through the event queue: the purge has to
            # run after the host's delete commits, and a row that arrives later must not win.
            try:
                ids = kwargs.get("deleted_ids") or [kwargs.get("session_id")]
                if _store is not None:
                    _store.purge_sessions(ids, reason=kwargs.get("reason") or "delete")
            except Exception:
                log.debug("omniscience: purging a deleted chat failed", exc_info=True)
            return None
        try:
            if _paused is not None:
                # A helper event carries its own session_id but belongs to the parent chat;
                # pause if either the event's session or its parent chain is paused.
                sid = kwargs.get("session_id")
                parent = kwargs.get("parent_session_id")
                if (isinstance(sid, str) and sid and _paused.is_paused(sid)) or \
                        (isinstance(parent, str) and parent and _paused.is_paused(parent)):
                    return None  # the user turned recording off for this chat (/omni off)
        except Exception:
            # PausedSessions.is_paused() is written never to raise and fails open by design;
            # this guard only exists so a broken pause store cannot break the host.
            log.debug("omniscience: pause check failed; recording continues", exc_info=True)
        try:
            _store.submit(hook_name, kwargs)
        except Exception:
            log.debug("omniscience: submitting an event failed", exc_info=True)
        if _notices is not None and hook_name in _NOTICE_HOOKS:
            _notices.observe(hook_name, kwargs)  # never raises; posting happens off this thread
        return None

    return callback


def _state_db_path() -> str:
    profile_home = Path(__file__).resolve().parents[2]
    candidate = profile_home / "state.db"
    if candidate.is_file():
        return str(candidate)

    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    return os.path.join(home, "state.db")


def _is_loopback_host(host: str) -> bool:
    """True only if *host* is a loopback address (127.0.0.0/8, ::1, or 'localhost')."""
    if not host:
        return False
    h = host.strip().strip("[]").lower()
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        # A hostname: resolve it and require every address to be loopback.
        try:
            infos = socket.getaddrinfo(h, None)
        except Exception:
            return False
        addrs = {info[4][0] for info in infos}
        if not addrs:
            return False
        try:
            return all(ipaddress.ip_address(a).is_loopback for a in addrs)
        except ValueError:
            return False


def _viewer_is_loopback(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
        return _is_loopback_host(parsed.hostname or "")
    except Exception:
        return False


def _viewer_up(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname
        port = parsed.port
        if not host:
            return False
        if not port:
            port = 80 if parsed.scheme == 'http' else 443

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.3)
        try:
            sock.connect((host, port))
            return True
        finally:
            sock.close()
    except Exception:
        return False


def _viewer_token() -> str | None:
    """The running viewer's per-launch key (written next to the event DB, readable only by this user)."""
    try:
        path = os.path.join(os.path.dirname(os.path.realpath(_db_path())), "viewer-token")
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


# Surfaces where a /omni reply stays on this machine. Elsewhere (Telegram, Slack...) the reply
# leaves the machine, so the viewer key is never put in the link there.
_LOCAL_PLATFORMS = (None, "", "cli", "tui", "desktop", "local", "gui", "oneshot")


def _privacy_command(action: str, session_id: str | None) -> str:
    from . import privacy

    db_path = _store.db_path if _store is not None else _db_path()
    if action == "privacy":
        paused = bool(session_id and _paused is not None and _paused.is_paused(session_id))
        return privacy.privacy_report(db_path, session_id, paused)
    if not session_id:
        return "Omniscience: this command needs a chat; run it inside the chat you mean."
    if action == "off":
        ok = _paused.pause(session_id) if _paused is not None else False
        if not ok:
            return "Omniscience: could not save the setting; recording may still be ON for this chat."
        return "Omniscience: recording is OFF for this chat. Nothing new is kept. Type /omni on to resume."
    if action == "on":
        ok = _paused.resume(session_id) if _paused is not None else False
        if not ok:
            return "Omniscience: could not save the setting; recording may still be OFF for this chat."
        return "Omniscience: recording is ON for this chat again."
    if action == "forget":
        count = privacy.stored_summary(db_path, session_id).get("events_this_chat", 0)
        return (f"Omniscience: this will permanently delete this chat's recording ({count:,} recorded steps, "
                "including its helper agents). Type /omni forget confirm to delete it.")
    if action == "forget confirm":
        if _store is not None:
            _store.flush(timeout=2.0)
        deleted = privacy.forget_session(db_path, session_id)
        if deleted < 0:
            return ("Omniscience: could not delete this chat's recording - the database was busy "
                    "or unreadable, so nothing was removed. Try /omni forget confirm again in a moment.")
        cleared = _paused.resume(session_id) if _paused is not None else True
        done = f"Omniscience: deleted {deleted:,} recorded steps for this chat."
        if not cleared:
            return (done + " The pause setting could not be cleared, so this chat stays paused; "
                    "type /omni on if you resume it.")
        return done + " Type /omni off to stop recording it."
    return ""


def _digest_command(action: str) -> str:
    """Turn the in-chat turn summary on or off, or change how much it says."""
    path = prefs.path_for(_store.db_path if _store is not None else _db_path())
    current = prefs.load(path)

    if action in ("digest", "digest status", "digest ?"):
        on = prefs.digest_enabled(current)
        detail = prefs.detail_level(current)
        if not on:
            return ("Omniscience: the in-chat summary is OFF. Type /omni digest on to bring it back "
                    "and I will report the tokens, the tools and anything that went wrong at the end of each turn.")
        return (f"Omniscience: the in-chat summary is ON ({detail}). It reports what ran, the tokens each "
                f"message sends, and anything that failed. /omni digest off stops it; "
                f"/omni detail brief|standard|full changes how much it says.")

    enabled = None
    detail = None
    if action in ("digest off", "quiet", "digest quiet"):
        enabled = False
    elif action in ("digest on", "loud"):
        enabled = True
        detail = "standard"
    elif action in ("digest brief", "detail brief"):
        enabled, detail = True, "brief"
    elif action in ("detail standard", "digest standard"):
        enabled, detail = True, "standard"
    elif action in ("detail full", "digest full"):
        enabled, detail = True, "full"
    else:
        return "Omniscience: try /omni digest on, /omni digest off, or /omni digest status."

    updated = prefs.set_digest(current, enabled=enabled, detail=detail)
    if not prefs.save(path, updated):
        return "Omniscience: could not save that setting, so nothing changed."
    if _notices is not None:
        # The recorder caches prefs for a couple of seconds; make this take effect now.
        _notices._prefs_at = 0.0
    if updated["digest"]["enabled"] is False:
        return "Omniscience: the in-chat summary is OFF. /omni digest on turns it back on."
    return (f"Omniscience: the in-chat summary is ON ({updated['digest']['detail']}). "
            f"It appears at the end of each turn.")


def _omni_command(_args: str, *, session_id: str | None = None, platform: str | None = None) -> str:
    action = " ".join(_args.strip().lower().split())
    if action in ("privacy", "off", "on", "forget", "forget confirm"):
        return _privacy_command(action, session_id)
    if action.split(" ")[0] in ("digest", "quiet", "loud", "detail"):
        return _digest_command(action)
    if action.split(" ")[0] in ("tokens", "usage"):
        return _tokens_command(action, platform)
    if action.split(" ")[0] in ("insight", "writeup"):
        return _insight_command(action)
    mode = "full" if action == "full" else "light"

    links = None
    if mode == "light" and session_id and isinstance(session_id, str):
        viewer = os.environ.get("OMNISCIENCE_VIEWER_URL", "http://127.0.0.1:8797").rstrip("/")
        dashboard = os.environ.get("OMNISCIENCE_DASHBOARD_URL", "http://127.0.0.1:9120").rstrip("/")
        q = urllib.parse.quote(session_id, safe="")
        # Print the panel link only when something answers on that port: a dead link teaches
        # the reader to ignore the live one beside it.
        panel_up = _viewer_up(dashboard)

        if _viewer_up(viewer):
            # Only attach the key when the viewer is verified loopback AND the reply stays local;
            # otherwise the key would travel to an off-machine host or a messaging platform.
            token = None
            if platform in _LOCAL_PLATFORMS and _viewer_is_loopback(viewer):
                token = _viewer_token()
            key = f"&t={urllib.parse.quote(token, safe='')}" if token else ""
            links = [("Full view in browser", f"{viewer}/?session={q}{key}")]
        else:
            links = [
                ("Full view", "the Omniscience viewer is not running; start it with: python -m omniscience_viewer"),
            ]
        if panel_up:
            links.append(("Omniscience panel (left sidebar in Hermes)",
                          f"{dashboard}/omniscience?session={q}"))

    return diagnose_current(_store.db_path if _store is not None else _db_path(), session_id,
                            state_db_path=_state_db_path(), mode=mode, links=links)


def _viewer_module(filename: str, module_name: str):
    """A module from the viewer package, loaded from the copy shipped with this plugin.

    One implementation for both surfaces: a second copy here would drift, and the chat command
    and the page would disagree about the same thing.
    """
    import importlib.util

    here = os.path.dirname(os.path.abspath(__file__))
    for rel in (("viewer_app", "omniscience_viewer", filename),
                ("viewer", "omniscience_viewer", filename)):
        path = os.path.join(here, *rel)
        if not os.path.isfile(path):
            continue
        try:
            spec = importlib.util.spec_from_file_location(module_name, path)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        except Exception:
            log.debug("omniscience: bundled %s did not load from %s", filename, path, exc_info=True)
    return None


def _usage_module():
    return _viewer_module("usage.py", "omniscience_usage_shared")


def _insight_module():
    """The insight module as a package import: it reads its neighbours (``db``, ``usage``)."""
    import importlib

    here = os.path.dirname(os.path.abspath(__file__))
    for rel in ("viewer_app", "viewer"):
        root = os.path.join(here, rel)
        if not os.path.isdir(os.path.join(root, "omniscience_viewer")):
            continue
        if root not in sys.path:
            sys.path.insert(0, root)
        try:
            return importlib.import_module("omniscience_viewer.insight")
        except Exception:
            log.debug("omniscience: bundled insight module did not import from %s", root, exc_info=True)
    return None


def _insight_command(action: str) -> str:
    """``/omni insight [7|30|all]`` — Hermes' own model reads the recording and writes it up.

    The completion runs inside Hermes (``ctx.llm``): the host owns the credentials, the routing
    and the fallback, so the viewer never reads a key file and never talks to a provider. The
    report is saved beside the recording, where the viewer's Insight panel reads it back.
    """
    period = action.split(" ", 1)[1].strip().lower() if " " in action else ""
    days = {"": 7, "7": 7, "week": 7, "today": 1, "day": 1, "1": 1,
            "30": 30, "month": 30, "all": 0, "0": 0}.get(period, 7)
    llm = getattr(_ctx, "llm", None)
    if llm is None or not callable(getattr(llm, "complete", None)):
        return ("Omniscience: this Hermes build does not expose plugin LLM access (ctx.llm), "
                "so the writeup cannot be generated. Everything else keeps working.")
    module = _insight_module()
    if module is None:
        return "Omniscience: the bundled insight module is missing from this install, so nothing was generated."
    db_path = _store.db_path if _store is not None else _db_path()
    try:
        digest = module.build_digest(db_path, _state_db_path(), days)
        report = module.writeup(digest, llm.complete, days=days)
    except Exception as exc:  # noqa: BLE001 - tell the user what happened, not a traceback
        log.debug("omniscience: the insight writeup failed", exc_info=True)
        return f"Omniscience: the writeup did not happen. {exc}"
    module.save(db_path, report)
    where = module.writeup_path(db_path)
    return (f"{report['markdown']}\n\n"
            f"— written by {report.get('model') or 'your active model'} over {report.get('digest_chars', 0):,} "
            f"characters of metadata, in {report.get('took_s', 0)}s. Saved for the viewer at {where}.")




def _tokens_command(action: str, platform: str | None) -> str:
    """``/omni tokens [today|7|30|all]`` — what the period cost, and the way to the Usage page.

    The reply carries what can be read at a glance: totals, the models and chats that carry
    the money, whether compaction fired, and which model is slow. The calendar and per-call
    detail stay on the page. The link is only handed over when the viewer answers and the
    reply stays on this machine.
    """
    from .command import tokens_report, usage_headline

    period = action.split(" ", 1)[1].strip().lower() if " " in action else ""
    days = {"": 7, "7": 7, "week": 7, "today": 1, "day": 1, "1": 1,
            "30": 30, "month": 30, "all": 0, "0": 0}.get(period, 7)
    db_path = _store.db_path if _store is not None else _db_path()
    report = None
    module = _usage_module()
    if module is not None:
        try:
            report = module.build_usage(db_path, _state_db_path(), days=days)
        except Exception:
            log.debug("omniscience: building the usage report failed; falling back", exc_info=True)
    if report is None:
        # Degraded but honest: four numbers rather than a traceback in the chat.
        report = {'days': days, 'totals': usage_headline(db_path, _state_db_path(), days),
                  'cache': {}, 'models': [], 'chats': [], 'context': {}}
    viewer = os.environ.get("OMNISCIENCE_VIEWER_URL", "http://127.0.0.1:8797").rstrip("/")
    link = None
    if _viewer_up(viewer) and platform in _LOCAL_PLATFORMS and _viewer_is_loopback(viewer):
        token = _viewer_token()
        key = f"&t={urllib.parse.quote(token, safe='')}" if token else ""
        link = f"{viewer}/?view=usage&days={days}{key}"
    elif _viewer_up(viewer):
        link = f"{viewer}/?view=usage&days={days}"
    return tokens_report(report, link)


def _start_viewer_in_background(db_path: str) -> None:
    """Start the bundled viewer if it is not running (localhost only; OMNISCIENCE_VIEWER_AUTOSTART=0 opts out).
    Several Hermes processes register the plugin; a lock file makes sure only one starts it."""
    import threading

    from . import viewer_launcher

    autostart = os.environ.get("OMNISCIENCE_VIEWER_AUTOSTART", "1").strip().lower() not in ("0", "false", "no", "off")
    real_db = os.path.realpath(db_path)
    threading.Thread(
        target=lambda: viewer_launcher.ensure_viewer(real_db, log_dir=os.path.dirname(real_db), autostart=autostart),
        name="omniscience-viewer-autostart",
        daemon=True,
    ).start()


def _notices_mode() -> str:
    """'off', 'local' (default), or 'all'."""
    raw = os.environ.get("OMNISCIENCE_NOTICES", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return "off"
    if raw in ("all", "1", "true", "yes", "on"):
        return "all"
    return "local"


def _import_history_in_background(db_path: str) -> None:
    """Chats that ran before Omniscience was on (or before it loaded mid-chat) still show up:
    import their metadata (never content) from Hermes's own chat database, once, off-thread."""
    import threading

    if os.environ.get("OMNISCIENCE_IMPORT_HISTORY", "1").strip().lower() in ("0", "false", "no", "off"):
        return

    def _run() -> None:
        try:
            from .backfill import backfill_from_hermes

            if _store is not None:
                _store.flush(timeout=5.0)  # recorded rows first, so partial chats import only the gap
            backfill_from_hermes(os.path.realpath(db_path), _state_db_path())
        except Exception:
            # Chats that ran before the plugin was on never appear if this fails, so say it.
            log.warning("omniscience: importing earlier chat history failed", exc_info=True)

    threading.Thread(target=_run, name="omniscience-import-history", daemon=True).start()


def register(ctx):
    global _store, _ctx
    _ctx = ctx
    db_path = _db_path()
    parent = os.path.dirname(os.path.abspath(db_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    _store = EventStore(db_path)
    global _paused
    from .privacy import PausedSessions

    _paused = PausedSessions(db_path)
    global _notices
    mode = _notices_mode()
    if mode != "off" and callable(getattr(ctx, "post_message", None)):
        from .notices import Notices

        dashboard = os.environ.get("OMNISCIENCE_DASHBOARD_URL", "http://127.0.0.1:9120").rstrip("/")
        # Link to the Hermes panel (behind Hermes's own login), never to the viewer with its key:
        # a notice may land on a messaging platform outside this machine.
        _prefs_path = prefs.path_for(db_path)
        _notices = Notices(
            ctx,
            lambda sid: f"{dashboard}/omniscience?session={urllib.parse.quote(sid, safe='')}",
            prefs_reader=lambda: prefs.load(_prefs_path),
        )
        if mode == "local":
            # Restrict notices to local surfaces; messaging platforms are opt-in via =all.
            _notices.set_platform_filter(_LOCAL_PLATFORMS)
        log.debug("omniscience: live notices enabled (%s mode)", mode)
    elif mode != "off":
        log.debug("omniscience: live notices disabled (post_message not available or notices=off)")
    for hook_name in HOOKS:
        ctx.register_hook(hook_name, _make_callback(hook_name))
    _start_viewer_in_background(db_path)
    _import_history_in_background(db_path)
    if callable(getattr(ctx, 'register_command', None)):
        ctx.register_command('omni', _omni_command, description='Inspect recorded activity for this chat')
