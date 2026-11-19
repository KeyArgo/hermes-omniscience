import time

import omniscience


class FakeCtx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, cb):
        self.hooks[name] = cb


def test_registers_exactly_the_observer_hooks(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "e.db"))
    ctx = FakeCtx()
    omniscience.register(ctx)
    assert set(ctx.hooks) == set(omniscience.HOOKS)
    assert len(ctx.hooks) == 14
    assert "pre_tool_call" not in ctx.hooks  # fails closed on timeout — see docs/DECISIONS.md D1
    omniscience._store.close()


def test_callback_swallows_store_errors(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "e.db"))
    ctx = FakeCtx()
    omniscience.register(ctx)

    def boom(*a, **k):
        raise RuntimeError("store exploded")

    monkeypatch.setattr(omniscience._store, "submit", boom)
    assert ctx.hooks["post_tool_call"](tool_name="terminal", session_id="s") is None
    omniscience._store.close()


def test_session_delete_purges_the_whole_deleted_set(tmp_path, monkeypatch):
    """Hermes sends every id it removed; all of them have to go, not just the one asked for."""
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "e.db"))
    ctx = FakeCtx()
    omniscience.register(ctx)
    calls = []
    monkeypatch.setattr(
        omniscience._store, "purge_sessions",
        lambda ids, reason="delete": calls.append((list(ids), reason)) or 0,
    )
    assert ctx.hooks["on_session_delete"](
        session_id="root", reason="delete", deleted_ids=["root", "seg2"], profile="default"
    ) is None
    assert calls == [(["root", "seg2"], "delete")]

    # A single-id payload (the common case) still reaches the purge.
    ctx.hooks["on_session_delete"](session_id="solo", reason="archive")
    assert calls[-1] == (["solo"], "archive")
    omniscience._store.close()


def test_session_delete_never_raises_into_the_host(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "e.db"))
    ctx = FakeCtx()
    omniscience.register(ctx)

    def boom(*a, **k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(omniscience._store, "purge_sessions", boom)
    assert ctx.hooks["on_session_delete"](session_id="s1", reason="delete") is None
    omniscience._store.close()


def test_default_db_path_follows_hermes_home(monkeypatch, tmp_path):
    monkeypatch.delenv("OMNISCIENCE_DB", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert omniscience._db_path() == str(tmp_path / "plugin-data" / "omniscience" / "events.db")


def test_register_does_not_start_the_viewer_by_default(tmp_path, monkeypatch):
    """Nobody is looking at boot, so nothing runs: the pane starts the viewer when it opens."""
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "e.db"))
    monkeypatch.delenv("OMNISCIENCE_VIEWER_AUTOSTART", raising=False)
    started = []
    monkeypatch.setattr(omniscience, "_start_viewer_in_background", started.append)

    omniscience.register(FakeCtx())

    assert started == []
    omniscience._store.close()


def test_register_starts_the_viewer_only_when_asked_to(tmp_path, monkeypatch):
    """OMNISCIENCE_VIEWER_AUTOSTART=1 (or always) restores the old always-on behaviour."""
    monkeypatch.setenv("OMNISCIENCE_DB", str(tmp_path / "e.db"))
    started = []
    monkeypatch.setattr(omniscience, "_start_viewer_in_background", started.append)

    monkeypatch.setenv("OMNISCIENCE_VIEWER_AUTOSTART", "1")
    omniscience.register(FakeCtx())
    assert started == [str(tmp_path / "e.db")]
    omniscience._store.close()

    started.clear()
    monkeypatch.setenv("OMNISCIENCE_VIEWER_AUTOSTART", "0")
    omniscience.register(FakeCtx())
    assert started == []
    omniscience._store.close()


def test_the_viewer_switch_beats_the_boot_opt_in(tmp_path, monkeypatch):
    """With the pref off nothing starts, even when boot start was asked for."""
    from omniscience import prefs, viewer_launcher

    db = str(tmp_path / "e.db")
    calls = []
    monkeypatch.setattr(
        viewer_launcher, "ensure_viewer",
        lambda *a, **k: calls.append((a, k)) or {"running": True, "reason": "started successfully"},
    )

    prefs.save(prefs.path_for(db), prefs.set_viewer(prefs.defaults(), False))
    omniscience._start_viewer_in_background(db)
    assert calls == []

    prefs.save(prefs.path_for(db), prefs.set_viewer(prefs.defaults(), True))
    omniscience._start_viewer_in_background(db)
    deadline = time.monotonic() + 2.0
    while not calls and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(calls) == 1
    assert calls[0][1]["autostart"] is True
