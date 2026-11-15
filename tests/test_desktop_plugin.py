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


def test_the_viewer_is_embedded_with_the_sdk_sandboxed_frame():
    """A raw <iframe> inherits the app's realm; the SDK primitive gives the guest an opaque one."""
    text = source()
    assert "SandboxedFrame" in text
    assert "jsx('iframe'" not in text
    assert "allowFullScreen" not in text
    # The SDK primitive is imported, not reached through the app's internals.
    assert re.search(r"import\s*\{[^}]*SandboxedFrame[^}]*\}\s*from\s*'@hermes/plugin-sdk'", text)


def test_the_sandboxed_embed_speaks_the_posture_the_viewer_needs():
    """An opaque-origin guest is what the viewer must survive: it needs CORS and a null Origin."""
    text = source()
    # allow-same-origin would defeat the sandbox; the SDK drops it, and we must not ask for it.
    assert "allow-same-origin" not in text


def test_messages_from_the_sandboxed_viewer_are_recognised():
    """A sandboxed frame reports an opaque origin ("null"), so the origin check must know it.

    The page's own buttons (open full view, hide the pane, open in the browser) arrive as
    postMessage; with the origin check pinned to the viewer URL every one of them is dropped and
    the pane's buttons go dead.
    """
    text = source()
    assert re.search(r"VIEWER_ORIGINS\s*=\s*new Set\(", text)
    assert "'null'" in text
    assert "event.origin !== VIEWER_URL" not in text


def test_every_embedded_frame_is_told_it_is_in_hermes():
    """Host mode is explicit.

    The viewer decides Hermes vs web from ``?host=hermes`` in its src, never from being framed:
    a browser tab and any other embed are web mode. Both the full page and the docked mini pane
    must carry the marker, or the pane silently loses its readable defaults.
    """
    text = source()
    assert re.search(r"HOST_MARKER\s*=\s*\{\s*host:\s*'hermes'\s*\}", text)
    assert "viewerSrc(session, key.token, HOST_MARKER)" in text, (
        "the full embedded page does not pass the Hermes marker"
    )
    assert re.search(
        r"viewerSrc\(session, key\.token, \{\s*\.\.\.HOST_MARKER,\s*mini:\s*'1'", text
    ), "the docked mini pane does not pass the Hermes marker"


def test_opening_in_the_browser_does_not_carry_the_hermes_marker():
    """A browser tab is web mode; it must not inherit the desktop pane's marker."""
    text = source()
    assert "viewerSrc(session, key.token)" in text, (
        "the open-in-browser action should build the viewer URL without the host marker"
    )
