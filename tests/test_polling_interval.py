"""The polling interval is a safety property, not a preference.

A change from 1.0 s to 0.25 s was merged twice and took the viewer from 28 % of a core to 41 %,
which on a loaded machine reads as "the system is unresponsive". This test fails on the exact line
that regression changed, in both copies of the file, so it runs in the ordinary suite on every
platform — no GitHub Action needed to catch it locally.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
COPIES = (
    "viewer/omniscience_viewer/app.py",
    "viewer_app/omniscience_viewer/app.py",
)
EXPECTED = 'POLL_INTERVAL_S = float(os.environ.get("OMNISCIENCE_POLL_INTERVAL_S", "1.0"))'


@pytest.mark.parametrize("relative", COPIES)
def test_the_interval_comes_from_the_environment_with_a_safe_default(relative):
    text = (ROOT / relative).read_text(encoding="utf-8")
    assert EXPECTED in text, (
        f"{relative} does not read the interval from OMNISCIENCE_POLL_INTERVAL_S with a 1.0 s "
        "default. 1.0 s costs 28 % of a core; 0.25 s costs 41 % and the machine stops answering."
    )


@pytest.mark.parametrize("relative", COPIES)
def test_no_hardcoded_interval_is_assigned(relative):
    text = (ROOT / relative).read_text(encoding="utf-8")
    hardcoded = re.findall(r"^\s*POLL_INTERVAL_S\s*=\s*(?![fF]loat\()\S+", text, re.MULTILINE)
    assert not hardcoded, f"{relative} assigns a literal interval: {hardcoded}"


def test_both_copies_agree_on_the_line():
    """viewer/ and viewer_app/ are byte-identical by convention; a fix in one only is a trap."""
    lines = {}
    for relative in COPIES:
        text = (ROOT / relative).read_text(encoding="utf-8")
        lines[relative] = [line for line in text.splitlines() if "POLL_INTERVAL_S" in line]
    assert lines[COPIES[0]] == lines[COPIES[1]], lines
