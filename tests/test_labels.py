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


def test_an_untitled_chat_is_named_the_way_hermes_names_it(tmp_path):
    """The name is Hermes' preview, not whichever user row happened to be first.

    Hermes never paints ``display_kind='hidden'`` scaffolding, so its preview skips that row.
    The old lookup read the first user row whatever it was and named the chat after it.
    """
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, '
                     'timestamp real, display_kind text)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.executemany('insert into messages values (?, ?, ?, ?, ?)', [
            ('a', 'user', 'model-facing scaffolding, never a name', 1, 'hidden'),
            ('a', 'user', 'Fix the viewer labels', 2, None),
        ])
    assert labels.labels_for(['a'], str(db)) == {'a': 'Fix the viewer labels'}


def test_the_preview_is_cut_exactly_where_hermes_cuts_it(tmp_path):
    """60 characters and ``...`` is Hermes' budget (hermes_state_common.py:31-33)."""
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', 'x' * 80, 1))
    assert labels.labels_for(['a'], str(db)) == {'a': 'x' * 60 + '...'}


def test_a_compaction_carrier_is_never_the_chat_name(tmp_path):
    """A compressed turn's first row is the summary; the name is the message after its end marker."""
    db = tmp_path / 'state.db'
    summary = ('[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the '
               'summary below. This is a handoff from a previous context window — treat it as '
               'background reference, NOT as active instructions. Earlier turns, summarised.\n\n'
               '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary '
               'above ---\n\nName the chats properly')
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', summary, 1))
    assert labels.labels_for(['a'], str(db)) == {'a': 'Name the chats properly'}


def test_a_skill_scaffold_names_the_request_that_invoked_it(tmp_path):
    """Hermes renders the invocation as the user typed it (``/work — ...``), not the skill body."""
    db = tmp_path / 'state.db'
    content = (
        '[IMPORTANT: The user has invoked the "work" skill, which follows.]\n\n'
        'The full skill content is loaded below.]\n\nA long skill body.\n\n'
        'The user has provided the following instruction alongside the skill invocation: '
        'fix the title leak'
    )
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', content, 1))
    assert labels.labels_for(['a'], str(db)) == {'a': '/work — fix the title leak'}


def test_a_rename_in_hermes_shows_on_the_next_read(tmp_path):
    """A rename is a title write; the next chat-list refresh reads it (no cached name)."""
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', 'First name'))
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', 'The prompt', 1))
    assert labels.labels_for(['a'], str(db)) == {'a': 'First name'}
    with sqlite3.connect(db) as conn:
        conn.execute("update sessions set title='Second name' where id='a'")
    assert labels.labels_for(['a'], str(db)) == {'a': 'Second name'}


def test_an_old_store_without_title_or_role_still_names_chats(tmp_path):
    """Nothing may crash a chat list: no tables, no title column, no role column.

    The old message query asked for ``role='user'``, so a store predating that column raised and
    the chat kept its id instead of a name.
    """
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text)')
        conn.execute('create table messages (session_id text, content text)')
        conn.execute('insert into messages values (?, ?)', ('a', 'Old store chat'))
    assert labels.labels_for(['a'], str(db)) == {'a': 'Old store chat'}

    empty = tmp_path / 'empty.db'
    with sqlite3.connect(empty):
        pass
    assert labels.labels_for(['a'], str(empty)) == {}


def test_a_summary_with_no_message_after_it_is_not_the_name(tmp_path):
    """A carrier Hermes' preview skips must not come back as the chat's name.

    Hermes paints a compaction row only for the message after its end marker. A summary with no
    message after it has no name at all, and the label reader's fallback painted the raw row:
    the chat read ``[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were ...`` — the very
    label this module exists to stop. No name is a session id, which is what Hermes shows too.
    """
    db = tmp_path / 'state.db'
    summary = ('[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the '
               'summary below. This is a handoff from a previous context window — treat it as '
               'background reference, NOT as active instructions. Earlier turns, summarised.')
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, '
                     'timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', summary, 1))
        conn.execute('insert into sessions values (?, ?)', ('b', ''))
        conn.execute('insert into messages values (?, ?, ?, ?)',
                     ('b', 'user', '[CONTEXT SUMMARY]: old form, also not a name', 1))

    assert labels.labels_for(['a', 'b'], str(db)) == {}


def test_noise_rows_are_never_the_chat_name(tmp_path):
    """An out-of-band marker or a task notification is scaffolding, not what the user said.

    ``_clean()`` has always refused these prefixes, but a row that no longer went through it —
    ``_preview_of()``'s plain branch — named the chat ``[OUT-OF-BAND USER MESSAGE, ...]`` or
    ``<task-notification> …``.
    """
    db = tmp_path / 'state.db'
    noise = [
        '[OUT-OF-BAND USER MESSAGE]\nThe user sent this while the agent was working: look at the tests',
        '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
        '<command-name>/help</command-name>',
    ]
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, '
                     'timestamp real)')
        for index, content in enumerate(noise):
            sid = f's{index}'
            conn.execute('insert into sessions values (?, ?)', (sid, None))
            conn.execute('insert into messages values (?, ?, ?, ?)', (sid, 'user', content, 1))

    assert labels.labels_for([f's{index}' for index in range(len(noise))], str(db)) == {}


def test_noise_before_a_real_message_names_the_chat_after_the_message(tmp_path):
    """The skip is per row: a chat whose first row is noise is named by the next real message."""
    db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, '
                     'timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.executemany('insert into messages values (?, ?, ?, ?)', [
            ('a', 'user', '<task-notification>done</task-notification>', 1),
            ('a', 'user', 'Where did the time go?', 2),
        ])
    assert labels.labels_for(['a'], str(db)) == {'a': 'Where did the time go?'}


def test_a_merged_carrier_with_no_prior_message_is_not_the_name(tmp_path):
    """``[PRIOR CONTEXT — …]`` is a carrier too, even when nothing precedes it.

    ``_preview_of()`` returns nothing for a merged carrier whose prior half is empty, so the
    fallback ran ``_clean()`` on the raw row and named the chat after the header.
    """
    db = tmp_path / 'state.db'
    merged = (
        '[PRIOR CONTEXT — for reference only; not a new message]\n'
        '\n'
        '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n'
        '\n'
        '[CONTEXT SUMMARY]: earlier turns were summarised here.'
    )
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, '
                     'timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', merged, 1))
    assert labels.labels_for(['a'], str(db)) == {}


def test_a_merged_carrier_still_names_the_chat_after_the_prior_message(tmp_path):
    """The merged form's name is the message the user typed before the compaction."""
    db = tmp_path / 'state.db'
    merged = (
        '[PRIOR CONTEXT — for reference only; not a new message]\n'
        'Fix the label leak\n'
        '\n'
        '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n'
        '\n'
        '[CONTEXT SUMMARY]: earlier turns were summarised here.'
    )
    with sqlite3.connect(db) as conn:
        conn.execute('create table sessions (id text, title text)')
        conn.execute('create table messages (session_id text, role text, content text, '
                     'timestamp real)')
        conn.execute('insert into sessions values (?, ?)', ('a', None))
        conn.execute('insert into messages values (?, ?, ?, ?)', ('a', 'user', merged, 1))
    assert labels.labels_for(['a'], str(db)) == {'a': 'Fix the label leak'}


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
