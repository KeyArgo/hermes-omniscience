"""User preferences that both the plugin and the viewer must agree on.

Kept in a small JSON file next to the event database so that the chat command
(``/omni digest off``) and the viewer's settings write the same thing, and the
recorder reads it fresh on every turn — no restart, no second source of truth.

File format (all keys optional; unknown keys are preserved but ignored):

    {
      "version": 1,
      "digest": {"enabled": true, "detail": "standard"},
      "viewer": "on",
      "failure_alerts": true
    }

``detail`` is one of ``brief``, ``standard`` or ``full``. ``viewer`` is ``on`` or ``off``: off
means the viewer does not run at all; recording carries on. ``failure_alerts`` is true or
false: false silences the repeated-failure pop-up; recording carries on.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from typing import Any

log = logging.getLogger("omniscience")

__all__ = [
    "DETAIL_LEVELS",
    "PREF_FILE_NAME",
    "defaults",
    "digest_enabled",
    "detail_level",
    "failure_alerts_enabled",
    "load",
    "normalize",
    "path_for",
    "save",
    "set_digest",
    "set_failure_alerts",
    "set_viewer",
    "viewer_enabled",
]

PREF_FILE_NAME = "prefs.json"
DETAIL_LEVELS = ("brief", "standard", "full")
DEFAULT_DETAIL = "standard"
VIEWER_MODES = ("on", "off")


def defaults() -> dict:
    """The shipped defaults: a turn summary in the chat, standard detail, the viewer on,
    failure pop-ups on."""
    return {
        "version": 1,
        "digest": {"enabled": True, "detail": DEFAULT_DETAIL},
        "viewer": "on",
        "failure_alerts": True,
    }


def path_for(db_path: str | None) -> str:
    """``.../omniscience/events.db`` -> ``.../omniscience/prefs.json``."""
    if not db_path:
        hermes_home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        return os.path.join(hermes_home, "plugin-data", "omniscience", PREF_FILE_NAME)
    return os.path.join(os.path.dirname(os.path.abspath(db_path)), PREF_FILE_NAME)


def normalize(raw: Any) -> dict:
    """Coerce anything into a usable prefs dict. Never raises, never loses the defaults."""
    out = defaults()
    if not isinstance(raw, dict):
        return out

    incoming = raw.get("digest")
    if isinstance(incoming, bool):
        out["digest"]["enabled"] = incoming
    elif isinstance(incoming, dict):
        enabled = incoming.get("enabled")
        if isinstance(enabled, bool):
            out["digest"]["enabled"] = enabled
        detail = incoming.get("detail")
        if isinstance(detail, str) and detail.strip().lower() in DETAIL_LEVELS:
            out["digest"]["detail"] = detail.strip().lower()

    version = raw.get("version")
    if isinstance(version, int) and version > 0:
        out["version"] = version

    viewer = raw.get("viewer")
    if isinstance(viewer, bool):
        out["viewer"] = "on" if viewer else "off"
    elif isinstance(viewer, str) and viewer.strip().lower() in VIEWER_MODES:
        out["viewer"] = viewer.strip().lower()

    alerts = raw.get("failure_alerts")
    if isinstance(alerts, bool):
        out["failure_alerts"] = alerts
    return out


def load(path: str) -> dict:
    """Read prefs, falling back to defaults for a missing or broken file."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return normalize(json.load(fh))
    except (OSError, ValueError):
        return defaults()


def save(path: str, prefs: dict) -> bool:
    """Write prefs atomically. False (never an exception) when it cannot be written."""
    payload = normalize(prefs)
    directory = os.path.dirname(os.path.abspath(path))
    tmp = None
    try:
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".prefs-", suffix=".json", dir=directory)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
        return True
    except OSError:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                log.debug("omniscience: could not remove the temporary prefs file", exc_info=True)
        return False


def digest_enabled(prefs: dict) -> bool:
    """The digest is on by default; ``OMNISCIENCE_DIGEST=0`` is a hard off switch."""
    env = os.environ.get("OMNISCIENCE_DIGEST")
    if isinstance(env, str) and env.strip().lower() in ("0", "false", "no", "off"):
        return False
    digest = prefs.get("digest") if isinstance(prefs, dict) else None
    if isinstance(digest, bool):
        return digest
    if isinstance(digest, dict) and isinstance(digest.get("enabled"), bool):
        return digest["enabled"]
    return True


def detail_level(prefs: dict) -> str:
    digest = prefs.get("digest") if isinstance(prefs, dict) else None
    if isinstance(digest, dict):
        detail = digest.get("detail")
        if isinstance(detail, str) and detail in DETAIL_LEVELS:
            return detail
    return DEFAULT_DETAIL


def set_digest(prefs: dict, *, enabled: bool | None = None, detail: str | None = None) -> dict:
    """Return a new prefs dict with the digest settings changed (normalized)."""
    out = normalize(prefs)
    if isinstance(enabled, bool):
        out["digest"]["enabled"] = enabled
    if isinstance(detail, str) and detail in DETAIL_LEVELS:
        out["digest"]["detail"] = detail
    return out


def viewer_enabled(prefs: dict) -> bool:
    """Whether the viewer may run. On by default; anything but ``off`` means on."""
    viewer = prefs.get("viewer") if isinstance(prefs, dict) else None
    if isinstance(viewer, bool):
        return viewer
    if isinstance(viewer, str):
        return viewer.strip().lower() != "off"
    return True


def set_viewer(prefs: dict, enabled: bool) -> dict:
    """Return a new prefs dict with the viewer switch set (normalized)."""
    out = normalize(prefs)
    out["viewer"] = "on" if enabled else "off"
    return out


def failure_alerts_enabled(prefs: dict) -> bool:
    """The repeated-failure pop-up is on by default; only an explicit false turns it off."""
    alerts = prefs.get("failure_alerts") if isinstance(prefs, dict) else None
    if isinstance(alerts, bool):
        return alerts
    return True


def set_failure_alerts(prefs: dict, enabled: bool) -> dict:
    """Return a new prefs dict with the failure pop-up switch set (normalized)."""
    out = normalize(prefs)
    if isinstance(enabled, bool):
        out["failure_alerts"] = enabled
    return out
