"""The test-channel helper must pin exactly what it resolves without shell parsing."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace


def load_installer():
    path = Path(__file__).resolve().parents[1] / "scripts" / "install-omniscience-test.py"
    spec = importlib.util.spec_from_file_location("omni_test_installer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dry_run_does_not_install(monkeypatch):
    installer = load_installer()
    calls = []
    monkeypatch.setattr(installer.shutil, "which", lambda name: "/test/" + name)
    monkeypatch.setattr(installer.sys, "argv", ["installer", "--dry-run"])

    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout="a" * 40 + "\t" + installer.TEST_REF + "\n", returncode=0)

    monkeypatch.setattr(installer.subprocess, "run", run)
    assert installer.main() == 0
    assert len(calls) == 1 and calls[0][1] == "ls-remote"


def test_install_pins_and_checks_resolved_commit(monkeypatch):
    installer = load_installer()
    sha = "a" * 40
    calls = []
    monkeypatch.setattr(installer.shutil, "which", lambda name: "/test/" + name)
    monkeypatch.setattr(installer.sys, "argv", ["installer"])

    def run(args, **kwargs):
        calls.append(args)
        if args[1] == "ls-remote":
            return SimpleNamespace(stdout=sha + "\t" + installer.TEST_REF + "\n", returncode=0)
        return SimpleNamespace(stdout=sha + "\n", returncode=0)

    monkeypatch.setattr(installer.subprocess, "run", run)
    assert installer.main() == 0
    assert calls[1][calls[1].index("--ref") + 1] == sha
    assert calls[2][1] == "-C"


def test_malformed_remote_result_never_installs(monkeypatch):
    installer = load_installer()
    calls = []
    monkeypatch.setattr(installer.shutil, "which", lambda name: "/test/" + name)
    monkeypatch.setattr(installer.sys, "argv", ["installer"])

    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout="bad\t" + installer.TEST_REF + "\n", returncode=0)

    monkeypatch.setattr(installer.subprocess, "run", run)
    assert installer.main() == 1
    assert len(calls) == 1
