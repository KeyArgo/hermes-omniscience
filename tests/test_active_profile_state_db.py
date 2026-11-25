"""The active profile only: one ``state.db``, never another profile's.

A plugin checkout can be shared or symlinked into several profiles' trees, so the plugin file's
own location says nothing about which profile is running. ``HERMES_HOME`` does, and both the
plugin and the dashboard must read Hermes' store from it — the catalog review's ask #5.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_API = REPO_ROOT / "dashboard" / "plugin_api.py"
# What the plugin package needs to import; the rest of the repo is not part of the claim.
PLUGIN_FILES = (
    "__init__.py", "store.py", "prefs.py", "command.py", "sanitize.py", "schema.py", "cleanup.py",
)


def _plugin_under(profile: Path, module_name: str):
    """The plugin's own files, copied under *profile*'s tree, imported as a package."""
    target = profile / "plugins" / "omniscience"
    target.mkdir(parents=True, exist_ok=True)
    for filename in PLUGIN_FILES:
        shutil.copyfile(REPO_ROOT / filename, target / filename)
    spec = importlib.util.spec_from_file_location(
        module_name, target / "__init__.py", submodule_search_locations=[str(target)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_plugin_api(monkeypatch, hermes_home: Path):
    """Import plugin_api.py by path with HERMES_HOME pointing at *hermes_home*."""
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_active_profile", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _FakeLauncher:
    def __init__(self):
        self.state_db = None

    def stop_viewer(self, log_dir):
        return {"stopped": True}

    def ensure_viewer(self, db_path, *, log_dir, autostart, state_db=None):
        self.state_db = state_db
        return {"running": True, "started": True, "reason": "started successfully"}


@pytest.fixture()
def profiles(tmp_path, monkeypatch):
    """The active profile (A) and a second one (B) whose tree holds the plugin files."""
    active = tmp_path / "profile-a"
    shared = tmp_path / "profile-b"
    active.mkdir()
    shared.mkdir()
    (active / "state.db").write_bytes(b"")
    (shared / "state.db").write_bytes(b"")
    monkeypatch.setenv("HERMES_HOME", str(active))
    monkeypatch.delenv("OMNISCIENCE_DB", raising=False)
    monkeypatch.delenv("OMNISCIENCE_STATE_DB", raising=False)
    return active, shared


def test_the_plugin_reads_the_active_profiles_state_db_from_a_shared_checkout(profiles):
    """The plugin file sits in profile B's tree; HERMES_HOME names profile A. A wins."""
    active, shared = profiles
    plugin = _plugin_under(shared, "omniscience_profile_b")

    assert plugin._state_db_path() == str(active / "state.db")


def test_the_dashboard_restarts_the_viewer_with_the_same_store_the_plugin_reads(profiles, monkeypatch):
    active, shared = profiles
    plugin = _plugin_under(shared, "omniscience_profile_b_restart")
    api = _load_plugin_api(monkeypatch, active)
    db = active / "plugin-data" / "omniscience" / "events.db"
    db.parent.mkdir(parents=True)
    db.write_bytes(b"")
    fake = _FakeLauncher()
    monkeypatch.setattr(api, "_launcher", lambda: fake)

    api._ensure_viewer()

    # The restart hands the viewer the profile that is running — not the one the files sit in.
    assert fake.state_db == str(active / "state.db")
    assert fake.state_db == plugin._state_db_path()
    assert fake.state_db != str(shared / "state.db")
    assert os.path.dirname(fake.state_db) != str(shared)
