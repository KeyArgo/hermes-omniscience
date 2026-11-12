"""version_stamp: the "am I running the latest?" answer.

The module had no tests at all. Its precedence rules (BUILD_INFO, then git, then plugin.yaml, then
"unknown") are the whole point, and a wrong answer here sends a bug report chasing the wrong build.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from omniscience_viewer import version_stamp


@pytest.fixture()
def build_info(monkeypatch, tmp_path):
    """Point the module at a temp plugin root with a BUILD_INFO.json in it."""
    payload = {}

    def fake_build_info():
        return dict(payload)

    monkeypatch.setattr(version_stamp, "_find_build_info", fake_build_info)
    monkeypatch.setattr(version_stamp, "_git", lambda *a: "")
    monkeypatch.setattr(version_stamp, "_declared_version", lambda: "")
    return payload


def test_build_info_wins_over_everything(build_info):
    build_info.update({"version": "1.0.0-dev.201", "commit": "6004d361abc", "dirty": False,
                       "commit_date": "2026-11-09T10:00:00-07:00", "built_at": "2026-11-09T17:00:00Z"})
    info = version_stamp.as_dict()
    assert info["version"] == "1.0.0-dev.201"
    assert info["commit_short"] == "6004d361"
    assert info["source"] == "build_info"
    assert info["dirty"] is False
    assert info["commit_date"].startswith("2026-11-09")


def test_build_info_dirty_flag_is_believed_even_when_git_is_clean(build_info, monkeypatch):
    """A dirty build that was committed afterwards is still a dirty build."""
    build_info.update({"version": "1.0.0", "commit": "abc12345", "dirty": True})
    monkeypatch.setattr(version_stamp, "_git", lambda *a: "")
    assert version_stamp.as_dict()["dirty"] is True


def _fake_git(tag="", shallow="false", count="42"):
    answers = {"rev-parse": "deadbeefcafe", "status": "", "log": "2026-11-01T09:00:00-07:00",
               "describe": tag, "rev-list": count}

    def fake_git(*args):
        if args[:2] == ("rev-parse", "--is-shallow-repository"):
            return shallow
        return answers.get(args[0], "")
    return fake_git


def test_git_is_used_when_there_is_no_build_info(build_info, monkeypatch):
    monkeypatch.setattr(version_stamp, "_git", _fake_git(tag="v1.0.0"))
    monkeypatch.setattr(version_stamp, "_declared_version", lambda: "1.0.0")
    monkeypatch.setattr(version_stamp, "_catalog_pin", lambda: "")
    info = version_stamp.as_dict()
    assert info["commit_short"] == "deadbeef"
    assert info["source"] == "git"
    assert info["version"] == "1.0.0"  # HEAD is the v1.0.0 tag: the release itself


def test_an_untagged_checkout_reads_dev(build_info, monkeypatch):
    monkeypatch.setattr(version_stamp, "_declared_version", lambda: "1.0.0")
    monkeypatch.setattr(version_stamp, "_catalog_pin", lambda: "")
    monkeypatch.setattr(version_stamp, "_git", _fake_git())
    assert version_stamp.as_dict()["version"] == "1.0.0-dev.42"
    monkeypatch.setattr(version_stamp, "_git", _fake_git(shallow="true"))
    assert version_stamp.as_dict()["version"] == "1.0.0-dev"  # a shallow count means nothing


def test_a_catalog_install_of_the_pinned_commit_reads_the_release(build_info, monkeypatch):
    monkeypatch.setattr(version_stamp, "_declared_version", lambda: "1.0.0")
    monkeypatch.setattr(version_stamp, "_git", _fake_git(shallow="true"))
    monkeypatch.setattr(version_stamp, "_catalog_pin", lambda: "deadbeefcafe")
    assert version_stamp.as_dict()["version"] == "1.0.0"
    monkeypatch.setattr(version_stamp, "_catalog_pin", lambda: "0123456789ab")
    assert version_stamp.as_dict()["version"] == "1.0.0-dev"  # pinned elsewhere: not this release


def test_a_dirty_checkout_is_reported_as_modified(build_info, monkeypatch):
    monkeypatch.setattr(version_stamp, "_git",
                        lambda *a: "deadbeef" if a[0] == "rev-parse" else " M store.py")
    assert version_stamp.as_dict()["dirty"] is True
    assert version_stamp.describe().endswith("(modified)")


def test_the_manifest_is_the_last_resort(build_info, monkeypatch):
    monkeypatch.setattr(version_stamp, "_declared_version", lambda: "0.9.0")
    info = version_stamp.as_dict()
    assert info["version"] == "0.9.0" and info["source"] == "manifest"
    assert info["commit"] == ""


def test_unknown_when_nothing_knows(build_info):
    info = version_stamp.as_dict()
    assert info["version"] == "unknown"
    assert info["source"] == "manifest"


def test_describe_stays_on_one_line_and_shortens_the_hash(build_info, monkeypatch):
    build_info.update({"version": "1.0.0", "commit": "0123456789abcdef", "dirty": False,
                       "commit_date": "2026-11-05T12:00:00Z"})
    line = version_stamp.describe()
    assert line == "1.0.0 · 01234567 · 2026-11-05", line
    assert "\n" not in line


def test_a_malformed_build_info_is_ignored_not_fatal(tmp_path, monkeypatch):
    here = tmp_path / "pkg"
    here.mkdir()
    (here / "BUILD_INFO.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(version_stamp, "_HERE", here)
    monkeypatch.setattr(version_stamp, "_git", lambda *a: "")
    monkeypatch.setattr(version_stamp, "_declared_version", lambda: "2.0.0")
    info = version_stamp.as_dict()
    assert info["version"] == "2.0.0", info


def test_a_build_info_that_is_not_an_object_is_ignored(tmp_path, monkeypatch):
    here = tmp_path / "pkg"
    here.mkdir()
    (here / "BUILD_INFO.json").write_text("[1, 2, 3]", encoding="utf-8")
    monkeypatch.setattr(version_stamp, "_HERE", here)
    monkeypatch.setattr(version_stamp, "_git", lambda *a: "")
    monkeypatch.setattr(version_stamp, "_declared_version", lambda: "3.0.0")
    assert version_stamp.as_dict()["version"] == "3.0.0"


def test_the_declared_version_survives_quotes_and_stops_at_the_colon(tmp_path, monkeypatch):
    root = tmp_path / "plugin"
    root.mkdir()
    (root / "plugin.yaml").write_text('name: omniscience\nversion: "1.2.3-rc1"\nother: x\n', encoding="utf-8")
    monkeypatch.setattr(version_stamp, "_HERE", root / "viewer" / "omniscience_viewer")
    (root / "viewer" / "omniscience_viewer").mkdir(parents=True)
    assert version_stamp._declared_version() == "1.2.3-rc1"
