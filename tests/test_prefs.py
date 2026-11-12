"""Shared settings: defaults, tolerant reading, atomic writing, and the two copies agreeing."""

from __future__ import annotations

import importlib.util
import json
import os
import sys

import pytest

import prefs


def test_defaults_send_the_summary():
    d = prefs.defaults()
    assert prefs.digest_enabled(d) is True
    assert prefs.detail_level(d) == "standard"


def test_path_sits_next_to_the_database():
    assert prefs.path_for("/data/omniscience/events.db") == os.path.join(os.path.abspath("/data/omniscience"), "prefs.json")
    assert prefs.path_for(None).endswith(os.path.join("plugin-data", "omniscience", "prefs.json"))


def test_missing_file_is_not_an_error(tmp_path):
    assert prefs.load(str(tmp_path / "nope.json")) == prefs.defaults()


def test_broken_file_is_not_an_error(tmp_path):
    path = tmp_path / "prefs.json"
    path.write_text("{not json", encoding="utf-8")
    assert prefs.load(str(path)) == prefs.defaults()


def test_round_trip(tmp_path):
    path = str(tmp_path / "prefs.json")
    assert prefs.save(path, prefs.set_digest(prefs.defaults(), enabled=False, detail="full")) is True
    loaded = prefs.load(path)
    assert prefs.digest_enabled(loaded) is False
    assert prefs.detail_level(loaded) == "full"


def test_saved_file_is_valid_json_with_no_temp_files_left(tmp_path):
    path = tmp_path / "prefs.json"
    prefs.save(str(path), prefs.defaults())
    assert json.loads(path.read_text(encoding="utf-8"))["digest"]["enabled"] is True
    assert [p.name for p in tmp_path.iterdir()] == ["prefs.json"]


def test_normalize_forgives_everything():
    assert prefs.normalize(None) == prefs.defaults()
    assert prefs.normalize({"digest": "yes"}) == prefs.defaults()
    assert prefs.normalize({"digest": {"enabled": "no", "detail": 12}}) == prefs.defaults()
    assert prefs.normalize({"digest": {"detail": "LOUD"}})["digest"]["detail"] == "standard"
    assert prefs.normalize({"digest": {"detail": " Brief "}})["digest"]["detail"] == "brief"


def test_a_bare_boolean_is_accepted():
    assert prefs.normalize({"digest": False})["digest"]["enabled"] is False


def test_env_switch_overrides_the_file(monkeypatch):
    on = prefs.defaults()
    monkeypatch.setenv("OMNISCIENCE_DIGEST", "0")
    assert prefs.digest_enabled(on) is False
    monkeypatch.setenv("OMNISCIENCE_DIGEST", "1")
    assert prefs.digest_enabled(prefs.set_digest(on, enabled=False)) is False


def test_set_digest_never_mutates_its_input():
    before = prefs.defaults()
    prefs.set_digest(before, enabled=False)
    assert before["digest"]["enabled"] is True


def test_unwritable_location_returns_false(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")
    assert prefs.save(str(blocker / "prefs.json"), prefs.defaults()) is False


def _load_viewer_copy():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "viewer", "omniscience_viewer", "prefs.py")
    spec = importlib.util.spec_from_file_location("viewer_prefs_under_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["viewer_prefs_under_test"] = module
    spec.loader.exec_module(module)
    return module


def test_the_viewer_copy_behaves_identically(tmp_path):
    """Two copies exist because the viewer must not import the plugin package."""
    other = _load_viewer_copy()
    cases = [
        {},
        {"digest": False},
        {"digest": {"enabled": True, "detail": "brief"}},
        {"digest": {"enabled": False, "detail": "nonsense"}},
        {"digest": "garbage"},
    ]
    for case in cases:
        assert prefs.normalize(case) == other.normalize(case)

    path_plugin = str(tmp_path / "a.json")
    path_viewer = str(tmp_path / "b.json")
    assert prefs.save(path_plugin, prefs.defaults()) is True
    assert other.save(path_viewer, other.defaults()) is True
    assert prefs.load(path_plugin) == other.load(path_viewer)


def test_both_copies_derive_the_same_path():
    other = _load_viewer_copy()
    for db in ("/data/omniscience/events.db", None):
        assert prefs.path_for(db) == other.path_for(db)


@pytest.mark.parametrize("detail", ["brief", "standard", "full"])
def test_every_detail_level_is_accepted(detail):
    assert prefs.set_digest(prefs.defaults(), detail=detail)["digest"]["detail"] == detail
