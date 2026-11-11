import json
import sqlite3

import omniscience
import prefs


class Context:
    def register_hook(self, name, callback):
        pass

    def post_message(self, text):
        # A chat surface that accepts messages, so the recorder's notices exist.
        return None

    def register_command(self, name, handler, **kwargs):
        self.name, self.handler = name, handler


def _setup(tmp_path, monkeypatch):
    db = tmp_path / "events.db"
    with sqlite3.connect(db) as conn:
        conn.execute(
            "create table events (event_id text, session_id text, kind text, status text, attrs text)"
        )
        conn.execute(
            "insert into events values (?, ?, ?, ?, ?)", ("e1", "chat-a", "tool.end", "ok", "{}")
        )
    monkeypatch.setenv("OMNISCIENCE_DB", str(db))
    ctx = Context()
    omniscience.register(ctx)
    return db, ctx


def test_digest_is_on_by_default_and_says_how_to_change_it(tmp_path, monkeypatch):
    db, ctx = _setup(tmp_path, monkeypatch)
    try:
        text = ctx.handler("digest", session_id="chat-a")
        assert "ON" in text
        assert "/omni digest off" in text
        assert "standard" in text
    finally:
        omniscience._store.close()


def test_digest_off_writes_the_shared_settings_file(tmp_path, monkeypatch):
    db, ctx = _setup(tmp_path, monkeypatch)
    try:
        text = ctx.handler("digest off", session_id="chat-a")
        assert "OFF" in text
        saved = prefs.load(prefs.path_for(str(db)))
        assert saved["digest"]["enabled"] is False
        # and it really is on disk where the viewer looks, as plain JSON
        raw = json.loads((tmp_path / "prefs.json").read_text(encoding="utf-8"))
        assert raw["digest"]["enabled"] is False

        again = ctx.handler("digest", session_id="chat-a")
        assert "OFF" in again
        assert "/omni digest on" in again
    finally:
        omniscience._store.close()


def test_digest_on_again(tmp_path, monkeypatch):
    db, ctx = _setup(tmp_path, monkeypatch)
    try:
        ctx.handler("quiet", session_id="chat-a")
        assert prefs.load(prefs.path_for(str(db)))["digest"]["enabled"] is False
        text = ctx.handler("digest on", session_id="chat-a")
        assert "ON" in text
        assert prefs.load(prefs.path_for(str(db)))["digest"]["enabled"] is True
    finally:
        omniscience._store.close()


def test_detail_levels_can_be_set_from_the_chat(tmp_path, monkeypatch):
    db, ctx = _setup(tmp_path, monkeypatch)
    try:
        for word, expected in (("brief", "brief"), ("standard", "standard"), ("full", "full")):
            ctx.handler(f"detail {word}", session_id="chat-a")
            assert prefs.load(prefs.path_for(str(db)))["digest"]["detail"] == expected
        # "full" as a detail level must not be mistaken for the full report
        assert "ON" in ctx.handler("loud", session_id="chat-a")
    finally:
        omniscience._store.close()


def test_a_nonsense_argument_teaches_instead_of_crashing(tmp_path, monkeypatch):
    db, ctx = _setup(tmp_path, monkeypatch)
    try:
        text = ctx.handler("digest perhaps", session_id="chat-a")
        assert "/omni digest on" in text and "/omni digest off" in text
    finally:
        omniscience._store.close()


def test_an_unsaveable_setting_is_reported_honestly(tmp_path, monkeypatch):
    db = tmp_path / "events.db"
    blocker = tmp_path / "prefs.json"
    blocker.mkdir()  # a directory where the file should be: the write must fail
    monkeypatch.setenv("OMNISCIENCE_DB", str(db))
    ctx = Context()
    omniscience.register(ctx)
    try:
        text = ctx.handler("digest off", session_id="chat-a")
        assert "could not save" in text.lower()
        assert "OFF" not in text
    finally:
        omniscience._store.close()


def test_the_running_recorder_sees_the_change_without_a_restart(tmp_path, monkeypatch):
    db, ctx = _setup(tmp_path, monkeypatch)
    try:
        notices = omniscience._notices
        assert notices is not None
        notices._prefs_at = 0.0
        assert notices._digest_on() is True
        ctx.handler("digest off", session_id="chat-a")
        assert notices._digest_on() is False
    finally:
        omniscience._store.close()
