"""Warnings endpoint support: run detection and explain every finding.

The viewer stays read-only; the analysis package is imported from the repo's
``analysis/`` folder when available, and warnings degrade to an empty list
rather than crashing.
"""

from __future__ import annotations

import sys
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


def warnings_for_root(db_path: str, root: str) -> list[dict]:
    """Explained warnings for *root*; ``[]`` when analysis is unavailable."""
    if _rules is None or _explain is None or not root:
        return []
    try:
        events = db_mod.events_for_root(db_path, root, limit=2000, tail=True)
        findings = _rules.detect(events)
    except Exception:
        return []
    explained = []
    for finding in findings:
        try:
            explained.append(_explain.explain(finding))
        except Exception:
            continue
    return explained
