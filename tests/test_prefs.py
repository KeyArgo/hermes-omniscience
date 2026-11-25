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
        {"viewer": "off"},
        {"viewer": "nonsense"},
        {"viewer": False},
        {"digest": {"enabled": False}, "viewer": "OFF"},
        {"failure_alerts": False},
        {"failure_alerts": True},
        {"failure_alerts": "nonsense"},
        {"digest": {"enabled": False}, "failure_alerts": False},
        {"keep_days": 7},
        {"keep_days": 90},
        {"keep_days": 0},
        {"keep_days": 12},
        {"keep_days": "30"},
        {"keep_days": True},
        {"keep_days": None},
        {"keep_days": 30, "failure_alerts": False},
    ]
    for case in cases:
        assert prefs.normalize(case) == other.normalize(case)
        assert prefs.viewer_enabled(case) == other.viewer_enabled(case)
        assert prefs.set_viewer(case, False) == other.set_viewer(case, False)
        assert prefs.failure_alerts_enabled(case) == other.failure_alerts_enabled(case)
        assert prefs.set_failure_alerts(case, False) == other.set_failure_alerts(case, False)
        assert prefs.keep_days(case) == other.keep_days(case)
        assert prefs.set_keep_days(case, 90) == other.set_keep_days(case, 90)

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


def test_the_viewer_is_on_by_default():
    assert prefs.viewer_enabled(prefs.defaults()) is True
    assert prefs.defaults()["viewer"] == "on"


def test_only_off_means_off():
    """Unknown values read as on: a settings file the owner hand-edited must not hide the pane."""
    assert prefs.viewer_enabled({"viewer": "off"}) is False
    assert prefs.viewer_enabled({"viewer": " OFF "}) is False
    assert prefs.viewer_enabled({"viewer": False}) is False
    assert prefs.viewer_enabled({"viewer": "on"}) is True
    assert prefs.viewer_enabled({"viewer": "maybe"}) is True
    assert prefs.viewer_enabled({}) is True
    assert prefs.viewer_enabled(None) is True


def test_set_viewer_round_trips_and_never_mutates_its_input(tmp_path):
    before = prefs.defaults()
    off = prefs.set_viewer(before, False)
    assert off["viewer"] == "off"
    assert before["viewer"] == "on"
    path = str(tmp_path / "prefs.json")
    assert prefs.save(path, off) is True
    assert prefs.viewer_enabled(prefs.load(path)) is False
    assert prefs.digest_enabled(prefs.load(path)) is True  # the other setting is untouched


def test_failure_alerts_are_on_by_default():
    assert prefs.defaults()["failure_alerts"] is True
    assert prefs.failure_alerts_enabled(prefs.defaults()) is True


def test_failure_alerts_normalize_like_the_other_switches():
    assert prefs.normalize({"failure_alerts": False})["failure_alerts"] is False
    assert prefs.normalize({"failure_alerts": True})["failure_alerts"] is True
    assert prefs.normalize({"failure_alerts": "nonsense"})["failure_alerts"] is True
    assert prefs.normalize({"failure_alerts": None})["failure_alerts"] is True


def test_only_false_means_off():
    assert prefs.failure_alerts_enabled({"failure_alerts": False}) is False
    assert prefs.failure_alerts_enabled({"failure_alerts": True}) is True
    assert prefs.failure_alerts_enabled({}) is True
    assert prefs.failure_alerts_enabled(None) is True


def test_set_failure_alerts_round_trips_and_never_mutates_its_input(tmp_path):
    before = prefs.defaults()
    off = prefs.set_failure_alerts(before, False)
    assert off["failure_alerts"] is False
    assert before["failure_alerts"] is True
    path = str(tmp_path / "prefs.json")
    assert prefs.save(path, off) is True
    loaded = prefs.load(path)
    assert prefs.failure_alerts_enabled(loaded) is False
    assert prefs.digest_enabled(loaded) is True  # the other settings are untouched
    assert prefs.viewer_enabled(loaded) is True


def test_step_history_is_kept_for_30_days_by_default():
    assert prefs.defaults()["keep_days"] == 30
    assert prefs.keep_days(prefs.defaults()) == 30


def test_only_the_offered_retention_windows_are_accepted():
    for days in prefs.KEEP_DAYS_CHOICES:
        assert prefs.normalize({"keep_days": days})["keep_days"] == days
    # A hand-edited or older file must not turn into "delete everything" or "keep everything".
    for junk in (1, 6, 31, 365, -1, True, False, None, "nonsense", [], {}):
        assert prefs.normalize({"keep_days": junk})["keep_days"] == prefs.DEFAULT_KEEP_DAYS
    assert prefs.normalize({"keep_days": "90"})["keep_days"] == 90


def test_set_keep_days_round_trips_and_never_mutates_its_input(tmp_path):
    before = prefs.defaults()
    changed = prefs.set_keep_days(before, 7)
    assert changed["keep_days"] == 7
    assert before["keep_days"] == 30
    path = str(tmp_path / "prefs.json")
    assert prefs.save(path, changed) is True
    assert prefs.keep_days(prefs.load(path)) == 7
    # An unsupported value leaves the saved choice alone rather than silently wrapping it.
    assert prefs.set_keep_days(changed, 12)["keep_days"] == 7
