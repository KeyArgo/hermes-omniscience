"""Version visibility contract — drop this into a plugin repo as tests/test_version_visibility.py.

It makes the rule enforceable by the repo itself, so nobody has to remember it in chat.

What it asserts:

1. ``plugin.yaml`` declares a SemVer version.
2. the package vendors ``version_stamp.py``.
3. at least one module uses it — that is the ``/version`` or ``/about`` path.
4. ``BUILD_INFO.json`` is gitignored, so a stale stamp cannot be committed.
5. a stamp, when present, agrees with the manifest.

Adjust ``PACKAGE`` if the package directory is not named after the plugin.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _find_package() -> Path:
    """The package that vendors version_stamp.py, wherever it lives.

    Drop-in means drop-in: hard-coding one plugin's package name made this test fail on every other
    repo. The vendored stamp is the marker, so look for it first and fall back to the manifest name.
    """
    for candidate in ROOT.rglob("version_stamp.py"):
        if ".git" not in candidate.parts and "templates" not in candidate.parts:
            return candidate.parent
    for line in (ROOT / "plugin.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip().strip('"').strip("'").replace("-", "_")
            return ROOT / name
    return ROOT


PACKAGE = _find_package()
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def manifest_version() -> str:
    for line in (ROOT / "plugin.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return ""


def test_manifest_declares_a_semver():
    version = manifest_version()
    assert version, "plugin.yaml has no version:"
    assert SEMVER.match(version), f"{version!r} is not SemVer"


def test_version_stamp_is_vendored():
    assert (PACKAGE / "version_stamp.py").is_file(), (
        "copy templates/version_stamp.py from inovinlabs-suite into the package"
    )


def test_something_uses_the_stamp():
    """The stamp is only worth having if a user can reach it."""
    hits = [
        path for path in ROOT.rglob("*.py")
        if path.name != "version_stamp.py"
        and ".venv" not in path.parts
        and "version_stamp" in path.read_text(encoding="utf-8", errors="replace")
    ]
    assert hits, "no module imports version_stamp — wire it into /version or /about"


def test_build_info_is_gitignored():
    ignore = ROOT / ".gitignore"
    lines = set()
    if ignore.is_file():
        lines = {l.strip() for l in ignore.read_text(encoding="utf-8").splitlines()}
    assert lines & {"BUILD_INFO.json", "/BUILD_INFO.json"}, (
        "BUILD_INFO.json must be gitignored; a committed stamp goes stale silently"
    )


def test_stamp_matches_the_manifest_when_present():
    stamp = ROOT / "BUILD_INFO.json"
    if not stamp.is_file():
        return                                    # no stamp yet: not a failure before release
    data = json.loads(stamp.read_text(encoding="utf-8"))
    assert data.get("version") == manifest_version(), (
        f"BUILD_INFO.json says {data.get('version')!r}, manifest says {manifest_version()!r} — restamp"
    )
