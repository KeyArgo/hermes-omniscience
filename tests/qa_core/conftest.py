"""Shared setup for the qa-core regression lane.

Adds the three product roots to sys.path and pins Hypothesis to fully
deterministic settings (derandomized, no example database, no deadlines).
"""

import sys
from pathlib import Path

from hypothesis import settings

REPO = Path(__file__).resolve().parents[2]
for _sub in ("viewer", "analysis"):  # the plugin (repo root) is importable via tests/conftest.py
    _p = str(REPO / _sub)
    if _p not in sys.path:
        sys.path.insert(0, _p)

settings.register_profile(
    "qa-core",
    derandomize=True,
    deadline=None,
    max_examples=60,
    database=None,
)
settings.load_profile("qa-core")
