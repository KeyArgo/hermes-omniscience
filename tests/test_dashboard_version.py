"""GET /version on the dashboard router: the chip's facts while the viewer is off.

The desktop settings chip reads /version from the plugin backend, not the viewer, so it must
return the same fields version_stamp prints — including the chip_line the suite standardises —
without needing a viewer process, a database, or the web app.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_API = REPO_ROOT / "dashboard" / "plugin_api.py"


def _load_plugin_api(monkeypatch, hermes_home: Path):
    """Import plugin_api.py by path with HERMES_HOME pointing at a temp dir (as test_dashboard does)."""
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_version_under_test", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    import sys

    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _make_app(module) -> TestClient:
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/omniscience")
    return TestClient(app)


def test_dashboard_version_matches_version_stamp(tmp_path, monkeypatch):
    module = _load_plugin_api(monkeypatch, tmp_path)
    client = _make_app(module)
    resp = client.get("/api/plugins/omniscience/version")
    assert resp.status_code == 200
    data = resp.json()
    for field in ("version", "commit", "commit_short", "commit_date", "dirty", "chip_line"):
        assert field in data, f"/version must answer with {field}"
    # The same module the route itself loaded: the response is version_stamp's own truth.
    stamp = module._version_stamp()
    info = stamp.as_dict()
    assert data["version"] == info["version"]
    assert data["commit"] == info["commit"]
    assert data["chip_line"] == stamp.chip_line(info)


def test_dashboard_version_keeps_the_suite_order(tmp_path, monkeypatch):
    """The chip line is version · commit · date, never Aura's date-before-commit fallback."""
    module = _load_plugin_api(monkeypatch, tmp_path)
    client = _make_app(module)
    data = client.get("/api/plugins/omniscience/version").json()
    parts = data["chip_line"].split(" · ")
    assert parts[0] == "v" + str(data["version"] or "unknown")
    if data["commit"]:
        assert parts[1] == str(data["commit"])[:8]
    tail = parts[-1]
    if data["dirty"]:
        assert tail == "modified"
        assert parts[-2] == str(data["commit_date"])[:10]
    else:
        assert tail == str(data["commit_date"])[:10]


def test_dashboard_version_reports_the_build_info_it_was_handed(tmp_path, monkeypatch):
    """A BUILD_INFO.json the test wrote must come back verbatim, not the module's own truth.

    The two tests above quote the same version_stamp the route loaded, so they cannot see a
    route that drops or rewrites a field. Here the expected values are written down first and
    the stamp is pointed at a BUILD_INFO.json in the temp dir (its _HERE, where
    _find_build_info looks first) so real files are never touched."""
    module = _load_plugin_api(monkeypatch, tmp_path)
    stamp = module._version_stamp()
    build_info = {
        "version": "1.0.0-dev.99",
        "commit": "abcdef1234567890",
        "commit_date": "2026-01-02",
        "dirty": False,
        "channel": "dev",
    }
    (tmp_path / "BUILD_INFO.json").write_text(json.dumps(build_info), encoding="utf-8")
    monkeypatch.setattr(stamp, "_HERE", tmp_path)
    client = _make_app(module)

    resp = client.get("/api/plugins/omniscience/version")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == "1.0.0-dev.99"
    assert data["commit"] == "abcdef1234567890"
    assert data["commit_short"] == "abcdef12"
    assert data["commit_date"] == "2026-01-02"
    assert data["dirty"] is False
    assert data["channel"] == "dev"
    assert data["chip_line"] == "v1.0.0-dev.99 · abcdef12 · 2026-01-02"
