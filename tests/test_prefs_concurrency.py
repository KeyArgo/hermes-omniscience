"""Two switches, one ``prefs.json``.

``/viewer/mode`` and ``/alerts/mode`` each read the whole file, change one key and write it back,
and both run off the event loop (``asyncio.to_thread``). Two toggles at once therefore used to
read the same pre-state and the second write dropped the first switch's change — and on Windows
``os.replace()`` in ``prefs.save()`` can fail with ``PermissionError`` while the other thread is
reading the file it wants to replace.

These tests pin the module-level lock that makes each read-modify-write cycle atomic. They are
deterministic rather than timing-dependent: both threads must have read before either writes for
the loss to happen, so the test makes them meet at a barrier after the read.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import threading
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_API = REPO_ROOT / "dashboard" / "plugin_api.py"


def _load(monkeypatch, hermes_home: Path):
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("OMNISCIENCE_DB", raising=False)
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api_prefs_lock", PLUGIN_API)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _db(module) -> Path:
    path = Path(module._db_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute("create table if not exists events (rowid integer primary key, ts real)")
    return path


def _shim_reading_together(real, barrier):
    """The plugin's prefs module, with ``load`` waiting for the other thread before it answers."""

    shim = types.SimpleNamespace(
        **{name: getattr(real, name) for name in dir(real) if not name.startswith("_")}
    )

    def load(path):
        # Both cycles must have read before either writes — the interleave that loses a switch.
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            pass  # the other thread is serialised behind the lock, which is the fix
        return real.load(path)

    shim.load = load
    return shim


def test_two_switches_written_at_once_both_land(tmp_path, monkeypatch):
    module = _load(monkeypatch, tmp_path / "home")
    _db(module)
    real = module._prefs()
    barrier = threading.Barrier(2, timeout=0.5)
    shim = _shim_reading_together(real, barrier)
    monkeypatch.setattr(module, "_prefs", lambda: shim)
    # The switch going off stops the viewer; that is a process, not a prefs write, and not what
    # this test is about.
    monkeypatch.setattr(module, "_stop_viewer", lambda: {"stopped": True, "reason": "stopped"})

    answers: dict[str, dict] = {}

    def turn_the_viewer_off():
        answers["viewer"] = module._set_viewer_mode_locked(False)

    def turn_the_alerts_off():
        answers["alerts"] = module._set_alerts_mode_locked(False)

    threads = [
        threading.Thread(target=turn_the_viewer_off),
        threading.Thread(target=turn_the_alerts_off),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive()

    path = real.path_for(str(module._db_path()))
    on_disk = json.loads(Path(path).read_text(encoding="utf-8"))
    assert on_disk["viewer"] == "off", f"the viewer switch was lost: {on_disk}"
    assert on_disk["failure_alerts"] is False, f"the alerts switch was lost: {on_disk}"
    # Each answer is read back from disk, so a save that did not land is not reported as a change.
    assert answers == {"viewer": {"enabled": False}, "alerts": {"enabled": False}}


def test_the_run_switch_and_the_alert_switch_use_the_same_lock(tmp_path, monkeypatch):
    """One lock, not one per endpoint: the two switches write the same file."""
    module = _load(monkeypatch, tmp_path / "home")
    assert isinstance(module._PREFS_LOCK, type(threading.Lock()))
    # A non-blocking acquire proves it is an unlocked module-level lock, and that both writers
    # take it rather than a fresh one each.
    assert module._PREFS_LOCK.acquire(blocking=False)
    module._PREFS_LOCK.release()
