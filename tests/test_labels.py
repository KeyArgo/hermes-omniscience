import sqlite3

from omniscience_viewer import labels


def test_titles_take_precedence_and_missing_titles_fall_back(tmp_path, monkeypatch):
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.executemany('insert into sessions values (?, ?)', [('a', 'My renamed chat'), ('b', '  ')])
        conn.executemany('insert into messages values (?, ?, ?, ?)', [('a', 'user', 'Original prompt', 1), ('b', 'user', 'Fallback prompt', 1)])
    monkeypatch.setattr(labels, 'hermes_state_db', lambda: db)
    assert labels.labels_for(['a', 'b']) == {'a': 'My renamed chat', 'b': 'Fallback prompt'}


def test_older_database_without_title_column_still_uses_message(tmp_path, monkeypatch):
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', 'Older chat', 1))
    monkeypatch.setattr(labels, 'hermes_state_db', lambda: db)
    assert labels.labels_for(['a']) == {'a': 'Older chat'}


def test_session_metadata_reports_known_and_unknown_archive_state(tmp_path, monkeypatch):
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, source text, archived integer)')
        conn.executemany('insert into sessions values (?, ?, ?)', [('a', 'cron', 1), ('b', 'local', 0)])
    monkeypatch.setattr(labels, 'hermes_state_db', lambda: db)
    assert labels.session_metadata(['a', 'b', 'missing']) == {
        'a': {'source': 'cron', 'archived': True}, 'b': {'source': 'local', 'archived': False},
    }
    with sqlite3.connect(db) as conn:
        conn.execute('drop table sessions')
        conn.execute('create table sessions (id text, source text)')
        conn.execute('insert into sessions values (?, ?)', ('a', 'cron'))
    assert labels.session_metadata(['a']) == {'a': {'source': 'cron', 'archived': None}}
