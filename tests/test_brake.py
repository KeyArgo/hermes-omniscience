"""The brake reads its settings and finds the right run; it never guesses."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import brake  # noqa: E402


def test_no_brake_file_means_no_brake(tmp_path):
    assert brake.load_config(str(tmp_path)) is None


def test_a_malformed_brake_file_is_ignored(tmp_path):
    (tmp_path / "brake.json").write_text("{}")
    assert brake.load_config(str(tmp_path)) is None
    (tmp_path / "brake.json").write_text('{"url": "not-a-url", "token": "x"}')
    assert brake.load_config(str(tmp_path)) is None


def test_a_good_brake_file_is_read(tmp_path):
    (tmp_path / "brake.json").write_text(
        json.dumps({"url": "http://127.0.0.1:8642/", "token": "abc"})
    )
    assert brake.load_config(str(tmp_path)) == {"url": "http://127.0.0.1:8642", "token": "abc"}


def test_finds_the_run_for_a_session_in_either_shape():
    as_list = [{"id": "run-1", "session_id": "other"}, {"id": "run-2", "session_id": "mine"}]
    assert brake.find_run(as_list, "mine") == "run-2"
    as_object = {"runs": as_list}
    assert brake.find_run(as_object, "mine") == "run-2"
    assert brake.find_run({"data": [{"run_id": "r9", "session": "mine"}]}, "mine") == "r9"


def test_returns_nothing_when_the_run_is_unknown_or_malformed():
    assert brake.find_run({"runs": [{"id": "run-1", "session_id": "other"}]}, "mine") is None
    assert brake.find_run({"runs": [{"session_id": "mine"}]}, "mine") is None  # no id
    assert brake.find_run("nonsense", "mine") is None
    assert brake.find_run(None, "mine") is None


def test_without_a_brake_the_answer_names_the_switch(tmp_path):
    result = brake.stop_run(str(tmp_path), "s1", "stop")
    assert result["ok"] is False
    assert "scripts/brake.sh on" in result["reason"]
