"""Warnings endpoint support: run detection and explain every finding.

The viewer stays read-only; the analysis package is imported from the repo's
``analysis/`` folder when available, and warnings degrade to an empty list
rather than crashing.
"""

from __future__ import annotations

import copy
import os
import sys
import threading
from pathlib import Path

from . import db as db_mod

# Repo layout: <repo>/viewer/omniscience_viewer/warnings.py and
# <repo>/analysis/omniscience_analysis/. Insert the analysis dir once.
_ANALYSIS_DIR = Path(__file__).resolve().parents[2] / "analysis"
if _ANALYSIS_DIR.is_dir() and str(_ANALYSIS_DIR) not in sys.path:
    sys.path.insert(0, str(_ANALYSIS_DIR))

try:
    from omniscience_analysis import rules as _rules
    from omniscience_analysis import explain as _explain
except Exception:  # pragma: no cover - degraded mode is exercised via API
    _rules = None
    _explain = None


# Detection reads the whole (tail window of the) chat and explains every finding, and an open
# page asks again every ten seconds. A chat's warnings only change when rows are added or the
# chat is purged, so the answer is kept per (recording, root) until that cheap stamp moves.
_WARNING_CACHE: dict[tuple[str, str], tuple[tuple, list[dict]]] = {}
_WARNING_LOCK = threading.Lock()
_WARNING_CACHE_MAX = 256


def _remember(key: tuple[str, str], stamp: tuple, explained: list[dict]) -> None:
    with _WARNING_LOCK:
        if len(_WARNING_CACHE) >= _WARNING_CACHE_MAX and key not in _WARNING_CACHE:
            _WARNING_CACHE.clear()
        _WARNING_CACHE[key] = (stamp, copy.deepcopy(explained))


def warnings_for_root(db_path: str, root: str) -> list[dict]:
    """Explained warnings for *root*; ``[]`` when analysis is unavailable.

    Callers get their own copy: the API serialises the list and never mutates it, but a shared
    list is one ``append`` away from poisoning every later answer.
    """
    if _rules is None or _explain is None or not root:
        return []
    try:
        realpath = os.path.realpath(db_path)
    except OSError:
        realpath = db_path
    key = (realpath, root)
    stamp = db_mod.data_stamp(db_path)
    if stamp is not None:
        with _WARNING_LOCK:
            hit = _WARNING_CACHE.get(key)
        if hit is not None and hit[0] == stamp:
            return copy.deepcopy(hit[1])
    try:
        events, error = db_mod.events_for_root_checked(db_path, root, limit=2000, tail=True)
        if error is not None:
            # A locked or unreadable recording: answer empty now, but never remember it, or the
            # warnings would stay empty until the next row is written.
            return []
        findings = _rules.detect(events)
    except Exception:
        return []
    explained = []
    for finding in findings:
        try:
            explained.append(_explain.explain(finding))
        except Exception:
            continue
    if stamp is not None:
        _remember(key, stamp, explained)
    return explained
