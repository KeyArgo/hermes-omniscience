"""Documentation must describe the build that is actually here.

The failure this guards against is quiet: a feature changes (a colour, a threshold, a button) and
the guide keeps describing the old one, so the docs become confidently wrong. The stamp in each
document carries the version, the commit and a hash of its own body, so an edited guide that was
never re-stamped fails here rather than being discovered months later.

Fix a failure with: python3 scripts/docs-stamp.py --write
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_every_document_describes_the_current_build():
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "docs-stamp.py"), "--check"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, (
        "documentation is behind the code:\n"
        f"{result.stdout}\n{result.stderr}\n"
        "run: python3 scripts/docs-stamp.py --write"
    )


def test_the_index_lists_every_document():
    index = (ROOT / "docs" / "DOC-INDEX.md").read_text(encoding="utf-8")
    guides = [
        path.name
        for path in (ROOT / "docs").glob("*.md")
        if path.name != "DOC-INDEX.md"
    ]
    missing = [name for name in guides if f"]({name})" not in index]
    assert not missing, f"docs/DOC-INDEX.md is missing: {missing} (run --index)"
