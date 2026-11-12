"""The viewer must not outlive the app that started it.

The trap here is a zombie: os.kill(pid, 0) succeeds for a process that has exited but not been
reaped, so a watcher that only asks "does this pid exist" keeps the viewer serving for hours after
Hermes closed. These tests pin the state check that avoids it.
"""

import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer.app import _pid_alive  # noqa: E402


def test_our_own_process_is_alive():
    assert _pid_alive(os.getpid()) is True


def test_a_pid_nobody_has_is_dead():
    assert _pid_alive(999_999_999) is False


@pytest.mark.skipif(os.name == "nt", reason="os.fork is POSIX-only")
def test_a_reaped_child_is_dead():
    pid = os.fork()
    if pid == 0:  # pragma: no cover - the child only exits
        os._exit(0)
    os.waitpid(pid, 0)
    time.sleep(0.05)
    assert _pid_alive(pid) is False


@pytest.mark.skipif(os.name == "nt", reason="os.fork is POSIX-only")
def test_a_zombie_child_is_dead_too():
    pid = os.fork()
    if pid == 0:  # pragma: no cover - the child only exits
        os._exit(0)
    time.sleep(0.3)  # exit without reaping: this child is now a zombie
    try:
        assert _pid_alive(pid) is False
    finally:
        os.waitpid(pid, 0)
