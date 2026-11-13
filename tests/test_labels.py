import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer import labels  # noqa: E402


def test_titles_take_precedence_and_missing_titles_fall_back(tmp_path, monkeypatch):
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.executemany('insert into sessions values (?, ?)', [('a', 'My renamed chat'), ('b', '  ')])
        conn.executemany('insert into messages values (?, ?, ?, ?)', [('a', 'user', 'Original prompt', 1), ('b', 'user', 'Fallback prompt', 1)])
    assert labels.labels_for(['a', 'b'], str(db)) == {'a': 'My renamed chat', 'b': 'Fallback prompt'}


def test_older_database_without_title_column_still_uses_message(tmp_path, monkeypatch):
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', 'Older chat', 1))
    assert labels.labels_for(['a'], str(db)) == {'a': 'Older chat'}


def test_session_metadata_reports_known_and_unknown_archive_state(tmp_path, monkeypatch):
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, source text, archived integer)')
        conn.executemany('insert into sessions values (?, ?, ?)', [('a', 'cron', 1), ('b', 'local', 0)])
    assert labels.session_metadata(['a', 'b', 'missing'], str(db)) == {
        'a': {'source': 'cron', 'archived': True}, 'b': {'source': 'local', 'archived': False},
    }
    with sqlite3.connect(db) as conn:
        conn.execute('drop table sessions')
        conn.execute('create table sessions (id text, source text)')
        conn.execute('insert into sessions values (?, ?)', ('a', 'cron'))
    assert labels.session_metadata(['a'], str(db)) == {'a': {'source': 'cron', 'archived': None}}


def test_the_state_database_is_only_the_one_the_plugin_passed_in(tmp_path, monkeypatch):
    """No guessed paths: `profiles/dev` is one profile's name, not the active one.

    The old lookup invented `<HERMES_HOME>/profiles/dev/state.db` and `~/.hermes/state.db`, so a
    viewer started for one profile could label chats with another profile's titles. The plugin
    knows which profile is active and hands the path over (``--state-db``); labels use that path
    or none at all.
    """
    home = tmp_path / 'hermes'
    (home / 'profiles' / 'dev').mkdir(parents=True)
    _state_db(home / 'profiles' / 'dev' / 'state.db', {'a': 'Another profile\'s chat'})
    _state_db(home / 'state.db', {'a': 'The default profile\'s chat'})
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setenv('HOME', str(tmp_path))

    assert labels.hermes_state_db() is None
    assert labels.labels_for(['a']) == {}
    assert labels.session_metadata(['a']) == {}

    # Given the path, it is used — and only it.
    explicit = home / 'state.db'
    assert labels.hermes_state_db(str(explicit)) == explicit
    assert labels.labels_for(['a'], str(explicit)) == {'a': "The default profile's chat"}
    assert labels.labels_for(['a'], str(home / 'profiles' / 'dev' / 'state.db')) == {
        'a': "Another profile's chat"
    }
    # A path that does not exist is not silently replaced by a guess.
    assert labels.hermes_state_db(str(tmp_path / 'missing.db')) is None


def _state_db(path, titles):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.executemany('insert into sessions values (?, ?)', list(titles.items()))


def test_the_sessions_route_labels_from_the_path_it_was_given(tmp_path, monkeypatch):
    """The viewer must read the profile it was pointed at, never a path under ~/.hermes."""
    import json

    from fastapi.testclient import TestClient

    from omniscience_viewer.app import create_app

    events = tmp_path / 'events.db'
    with sqlite3.connect(events) as conn:
        conn.execute('create table events (rowid integer primary key, event_id text, schema text, '
                     'boot_id text, seq integer, ts real, kind text, session_id text, parent_session_id text, '
                     'turn_id text, api_request_id text, tool_call_id text, subagent_id text, status text, attrs text)')
        conn.execute("insert into events (event_id, ts, kind, session_id, attrs) values ('e1', 1.0, 'session.start', 'chat-a', '{}')")

    mine = tmp_path / 'state.db'
    _state_db(mine, {'chat-a': 'Conversation on this profile'})
    home = tmp_path / 'hermes'
    (home / 'profiles' / 'dev').mkdir(parents=True)
    _state_db(home / 'profiles' / 'dev' / 'state.db', {'chat-a': "A different profile's title"})
    monkeypatch.setenv('HERMES_HOME', str(home))

    client = TestClient(create_app(str(events), state_db=str(mine)), base_url='http://127.0.0.1')
    rows = client.get('/api/v1/sessions').json()
    assert rows and rows[0]['label'] == 'Conversation on this profile'

    # Without a path there is no title, and no guess: the id is the label.
    client = TestClient(create_app(str(events)), base_url='http://127.0.0.1')
    rows = client.get('/api/v1/sessions').json()
    assert rows[0]['label'] == 'chat-a'
