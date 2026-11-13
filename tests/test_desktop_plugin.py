"""The desktop page follows the plugin SDK, not the raw Electron bridge.

Nous' review of 1.0.0 made four asks about ``desktop/plugin.js``, and every one of them is
checkable from the source without a desktop app in the loop:

* external links open through ``ctx.os.openExternal`` (not ``window.hermesDesktop``);
* the viewer key comes from ``ctx.rest('/viewer')`` — the page never reads plugin-data itself;
* the viewer is embedded with the SDK's ``SandboxedFrame``, not a raw ``<iframe>``.

A source-level test is the honest instrument here: the defect *is* the call site, and a mocked
bridge would pass with the wrong one in place.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_JS = ROOT / "desktop" / "plugin.js"


def source() -> str:
    return PLUGIN_JS.read_text(encoding="utf-8")


def test_external_links_open_through_the_plugin_sdk():
    """``window.hermesDesktop.openExternal`` bypasses the SDK's attribution and allow-listing."""
    text = source()
    assert "hermesDesktop.openExternal" not in text
    calls = re.findall(
        r"([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\??\.openExternal", text
    )
    assert calls, "the page should still offer to open the viewer in the browser"
    for receiver in calls:
        assert receiver.replace("?.", ".") in ("ctx.os", "CTX.os"), (
            f"openExternal reached through {receiver}"
        )


def test_the_viewer_key_comes_only_from_the_plugin_backend():
    """Reading plugin-data through the desktop file bridge can reach other profiles' folders."""
    text = source()
    assert "readKeyFromDisk" not in text
    assert "readFileText" not in text
    assert "desktopPluginsRoot" not in text
    assert "hermesDesktop" not in text
    assert "rest('/viewer')" in text
