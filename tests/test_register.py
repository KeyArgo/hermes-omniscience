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
