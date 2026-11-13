"""The page a plugin install actually serves must reference files that are there.

``viewer_app/static`` is the bundle the plugin ships; ``web/`` is the source it is built from.
The stale-bundle failure is quiet — the page loads, asks for an asset hash that was replaced by
the last build, and renders nothing — so it is checked here, where a platform (or a person who
forgot ``scripts/bundle-viewer.sh``) cannot hide it.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "viewer_app" / "static"
ASSETS = re.compile(r"assets/[A-Za-z0-9_.@-]+\.(?:js|css)")


def test_the_shipped_page_references_assets_that_exist():
    index = STATIC / "index.html"
    assert index.is_file(), "viewer_app/static/index.html is missing: run scripts/bundle-viewer.sh"
    refs = ASSETS.findall(index.read_text(encoding="utf-8"))
    assert refs, "the shipped page references no assets at all"
    missing = [ref for ref in refs if not (STATIC / ref).is_file()]
    assert not missing, f"the shipped page asks for files that are not shipped: {missing}"


def test_the_shipped_bundle_carries_no_source_maps_or_dev_only_files():
    """A sourcemap in the install hands a reader the original TypeScript for free."""
    shipped = list(STATIC.rglob("*.map"))
    assert not shipped, f"sourcemaps shipped in viewer_app/static: {shipped[:3]}"
