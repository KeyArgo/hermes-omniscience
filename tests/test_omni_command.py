import json
import sqlite3

import omniscience
from omniscience.command import diagnose_current


def test_command_scopes_to_calling_session_and_reports_evidence(tmp_path):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', [
            ('event-a', 'chat-a', 'tool.end', 'error', json.dumps({'tool_name': 'search'})),
            ('event-b', 'chat-b', 'llm.error', 'error', '{}'),
        ])
    result = diagnose_current(str(db), 'chat-a', mode="full")
    assert 'search tool failed (event event-a)' in result
    assert 'event-b' not in result
    assert 'cause cannot be determined' in result
    assert 'No other session was inspected' in diagnose_current(str(db), None)


def test_command_marks_limited_history_and_never_infers_success(tmp_path):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', [(str(i), 'a', 'tool.end', 'ok', '{}') for i in range(501)])
    result = diagnose_current(str(db), 'a', mode="full")
    assert '500 recent recorded events' in result
    assert 'Earlier events were not reviewed' in result
    assert 'does not establish that the run succeeded' in result


def test_plugin_registers_command_for_calling_session(tmp_path, monkeypatch):
    class Context:
        def register_hook(self, name, callback):
            pass

        def register_command(self, name, handler, **kwargs):
            self.name, self.handler = name, handler

    monkeypatch.setenv('OMNISCIENCE_DB', str(tmp_path / 'events.db'))
    ctx = Context()
    omniscience.register(ctx)
    try:
        assert ctx.name == 'omni'
        assert 'No other session was inspected' in ctx.handler('', session_id=None)
    finally:
        omniscience._store.close()


def test_more_than_3_failures_shows_most_recent(tmp_path):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        events = []
        for i in range(6):
            events.append((f'fail-{i}', 'chat-a', 'llm.error', 'error', '{}'))
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', events)
    result = diagnose_current(str(db), 'chat-a', mode="full")
    assert '6 recorded failure event(s) in this portion (showing 3 most recent):' in result
    assert 'fail-5' in result
    assert 'fail-4' in result
    assert 'fail-3' in result
    assert 'fail-2' not in result


def test_chat_size_from_two_pairs(tmp_path):
    db = tmp_path / 'events.db'
    req1 = json.dumps({
        'model': 'gpt-5.6-terra',
        'provider': 'openai-codex',
        'message_count': 137,
        'tool_count': 22,
        'approx_input_tokens': 154764,
        'api_call_count': 4,
    })
    resp1 = json.dumps({
        'usage': {
            'prompt_tokens': 150629,
            'cache_read_tokens': 150016,
            'cache_write_tokens': 0,
            'input_tokens': 613,
            'output_tokens': 102,
            'reasoning_tokens': 0,
            'total_tokens': 150731,
        },
        'duration_s': 6.04,
        'ttfb_s': 1.74,
    })
    req2 = json.dumps({
        'model': 'gpt-5.6-terra',
        'provider': 'openai-codex',
        'message_count': 139,
        'tool_count': 22,
        'approx_input_tokens': 155000,
        'api_call_count': 5,
    })
    resp2 = json.dumps({
        'usage': {
            'prompt_tokens': 151000,
            'cache_read_tokens': 150500,
            'cache_write_tokens': 0,
            'input_tokens': 500,
            'output_tokens': 200,
            'reasoning_tokens': 10,
            'total_tokens': 151200,
        },
        'duration_s': 5.0,
        'ttfb_s': 1.0,
    })
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        # Insert in order: turn.start, req1, resp1, req2, resp2 (oldest to newest)
        # But rows are fetched newest-first, so we insert oldest first and they come back newest first
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', [
            ('ts1', 'chat-a', 'turn.start', 'ok', '{}'),
            ('req1', 'chat-a', 'llm.request', 'ok', req1),
            ('resp1', 'chat-a', 'llm.response', 'ok', resp1),
            ('req2', 'chat-a', 'llm.request', 'ok', req2),
            ('resp2', 'chat-a', 'llm.response', 'ok', resp2),
        ])
    result = diagnose_current(str(db), 'chat-a', mode="full")
    # 1 user message, 2 model calls
    assert 'Chat size: 1 user messages, 2 model calls in reviewed events' in result
    # Latest request (req2) carried 139 messages and 22 tool definitions
    assert 'latest request carried 139 messages and 22 tool definitions (model gpt-5.6-terra via openai-codex)' in result
    # Latest model call (resp2) sent 151,000 prompt tokens: 150,500 reused from cache, 500 new; reply 200 output tokens (10 reasoning)
    assert 'Latest model call sent 151,000 prompt tokens: 150,500 reused from cache, 500 new; reply 200 output tokens (10 reasoning)' in result
    # Growth: earliest (resp1) sent 150,629; latest (resp2) sent 151,000
    assert 'Earliest reviewed call sent 150,629 prompt tokens; latest sent 151,000' in result
    # Average: (150629+151000)//2 = 150814, (102+200)//2 = 151
    assert 'Average per model call in reviewed events: 150,814 prompt tokens, 151 output tokens' in result
    # Last user message: no turn.start after resp2, so all responses are after ts1
    # Actually ts1 is oldest, so in newest-first order: resp2, req2, resp1, req1, ts1
    # Events before first turn.start (ts1 at index 4) are indices 0-3: resp2, req2, resp1, req1
    # llm.response events among those: resp2, resp1 -> 2 calls
    # Total prompt tokens: 151000 + 150629 = 301629
    assert 'Last user message used 2 model calls totalling 301,629 prompt tokens' in result


def test_cost_included(tmp_path):
    db = tmp_path / 'events.db'
    state_db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.execute('insert into events values (?, ?, ?, ?, ?)', ('e1', 'chat-a', 'tool.end', 'ok', '{}'))
    with sqlite3.connect(state_db) as conn:
        conn.execute('create table sessions (id text, cost_status text, estimated_cost_usd real, actual_cost_usd real)')
        conn.execute('insert into sessions values (?, ?, ?, ?)', ('chat-a', 'included', None, None))
    result = diagnose_current(str(db), 'chat-a', state_db_path=str(state_db), mode="full")
    assert 'Cost: Hermes marks this chat as included in your plan, so no per-message price is recorded.' in result


def test_cost_estimated_with_per_call_average(tmp_path):
    db = tmp_path / 'events.db'
    state_db = tmp_path / 'state.db'
    req = json.dumps({
        'model': 'gpt-5.6-terra',
        'provider': 'openai-codex',
        'message_count': 10,
        'tool_count': 5,
        'approx_input_tokens': 1000,
        'api_call_count': 1,
    })
    resp = json.dumps({
        'usage': {
            'prompt_tokens': 1000,
            'cache_read_tokens': 0,
            'cache_write_tokens': 0,
            'input_tokens': 1000,
            'output_tokens': 100,
            'reasoning_tokens': 0,
            'total_tokens': 1100,
        },
        'duration_s': 1.0,
        'ttfb_s': 0.5,
    })
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', [
            ('req1', 'chat-a', 'llm.request', 'ok', req),
            ('resp1', 'chat-a', 'llm.response', 'ok', resp),
        ])
    with sqlite3.connect(state_db) as conn:
        conn.execute('create table sessions (id text, cost_status text, estimated_cost_usd real, actual_cost_usd real)')
        conn.execute('insert into sessions values (?, ?, ?, ?)', ('chat-a', 'estimated', 0.05, None))
    result = diagnose_current(str(db), 'chat-a', state_db_path=str(state_db), mode="full")
    assert 'Cost so far (Hermes ESTIMATE): $0.0500 for the whole chat' in result
    assert 'about $0.0500 per model call on average' in result


def test_bad_json_and_missing_usage_no_crash(tmp_path):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', [
            ('e1', 'chat-a', 'llm.request', 'ok', 'not json'),
            ('e2', 'chat-a', 'llm.response', 'ok', '{"usage": "not a dict"}'),
            ('e3', 'chat-a', 'llm.response', 'ok', '{"usage": {"prompt_tokens": "not int"}}'),
            ('e4', 'chat-a', 'turn.start', 'ok', '{}'),
        ])
    result = diagnose_current(str(db), 'chat-a', mode="full")
    # Should not crash and should not contain fabricated numbers
    assert 'Chat size' in result
    assert '1 user messages' in result
    assert '1 model calls' in result  # e1 is a request even with unreadable attrs
    # No fabricated token numbers
    assert 'prompt tokens' not in result or 'Not recorded' in result


def test_light_mode_default(tmp_path):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', [
            ('e1', 'chat-a', 'tool.end', 'ok', '{}'),
        ])
    result = diagnose_current(str(db), 'chat-a')
    assert 'Omniscience (light):' in result
    assert 'Type /omni full for the detailed report.' in result
    assert 'Chat size:' not in result


def test_light_mode_with_failures(tmp_path):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.executemany('insert into events values (?, ?, ?, ?, ?)', [
            ('e1', 'chat-a', 'llm.error', 'error', '{}'),
        ])
    result = diagnose_current(str(db), 'chat-a')
    assert '1 recorded failure(s)' in result
    assert 'Type /omni full for the detailed report.' in result


def test_light_mode_hides_included_cost(tmp_path):
    db = tmp_path / 'events.db'
    state_db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.execute('insert into events values (?, ?, ?, ?, ?)', ('e1', 'chat-a', 'tool.end', 'ok', '{}'))
    with sqlite3.connect(state_db) as conn:
        conn.execute('create table sessions (id text, cost_status text, estimated_cost_usd real, actual_cost_usd real)')
        conn.execute('insert into sessions values (?, ?, ?, ?)', ('chat-a', 'included', None, None))
    result = diagnose_current(str(db), 'chat-a', state_db_path=str(state_db))
    assert 'Cost so far' not in result
    assert 'included' not in result


def test_light_mode_shows_estimate_cost(tmp_path):
    db = tmp_path / 'events.db'
    state_db = tmp_path / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.execute('insert into events values (?, ?, ?, ?, ?)', ('e1', 'chat-a', 'tool.end', 'ok', '{}'))
    with sqlite3.connect(state_db) as conn:
        conn.execute('create table sessions (id text, cost_status text, estimated_cost_usd real, actual_cost_usd real)')
        conn.execute('insert into sessions values (?, ?, ?, ?)', ('chat-a', 'estimated', 0.05, None))
    result = diagnose_current(str(db), 'chat-a', state_db_path=str(state_db))
    assert 'Cost so far (Hermes ESTIMATE): $0.0500.' in result


def test_omni_command_parses_full(tmp_path, monkeypatch):
    class Context:
        def register_hook(self, name, callback):
            pass

        def register_command(self, name, handler, **kwargs):
            self.name, self.handler = name, handler

    monkeypatch.setenv('OMNISCIENCE_DB', str(tmp_path / 'events.db'))
    # Write the event before register(): the store creates its schema on a background thread.
    with sqlite3.connect(tmp_path / 'events.db') as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.execute('insert into events values (?, ?, ?, ?, ?)', ('e1', 'chat-a', 'tool.end', 'ok', '{}'))
    ctx = Context()
    omniscience.register(ctx)
    try:

        result_full = ctx.handler('full', session_id='chat-a')
        assert 'Chat size:' in result_full

        result_light = ctx.handler('', session_id='chat-a')
        assert 'Omniscience (light):' in result_light
    finally:
        omniscience._store.close()


def test_light_mode_links_quoted_session_id(tmp_path, monkeypatch):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.execute('insert into events values (?, ?, ?, ?, ?)', ('e1', 'chat/a', 'tool.end', 'ok', '{}'))

    # Mock viewer up
    monkeypatch.setattr(omniscience, '_viewer_up', lambda url: True)

    monkeypatch.setattr(omniscience, '_store', None)
    monkeypatch.setenv('OMNISCIENCE_DB', str(db))
    result = omniscience._omni_command('', session_id='chat/a')
    assert 'session=chat%2Fa' in result


def test_light_mode_viewer_down(tmp_path, monkeypatch):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.execute('insert into events values (?, ?, ?, ?, ?)', ('e1', 'chat-a', 'tool.end', 'ok', '{}'))

    # Mock viewer down
    monkeypatch.setattr(omniscience, '_viewer_up', lambda url: False)

    monkeypatch.setattr(omniscience, '_store', None)
    monkeypatch.setenv('OMNISCIENCE_DB', str(db))
    result = omniscience._omni_command('', session_id='chat-a')
    assert 'the Omniscience viewer is not running' in result


def test_unpriced_model_placeholder_cost_is_not_shown(tmp_path):
    db = tmp_path / 'events.db'
    with sqlite3.connect(db) as conn:
        conn.execute('create table events (event_id text, session_id text, kind text, status text, attrs text)')
        conn.execute('insert into events values (?, ?, ?, ?, ?)', ('e1', 'chat-a', 'tool.end', 'ok', '{}'))
    state_db = tmp_path / 'state.db'
    with sqlite3.connect(state_db) as conn:
        conn.execute('create table sessions (id text, cost_status text, estimated_cost_usd real, actual_cost_usd real)')
        conn.execute('insert into sessions values (?, ?, ?, ?)', ('chat-a', 'unknown', 0.0, None))
    full = diagnose_current(str(db), 'chat-a', state_db_path=str(state_db), mode='full')
    light = diagnose_current(str(db), 'chat-a', state_db_path=str(state_db))
    assert 'Hermes has no price for this model' in full
    assert '$' not in full and '$' not in light


def _events_db(path):
    with sqlite3.connect(path) as conn:
        conn.execute('create table events (rowid integer primary key, event_id text, schema text, boot_id text, seq integer, '
                     'ts real, kind text, session_id text, parent_session_id text, turn_id text, api_request_id text, '
                     'tool_call_id text, subagent_id text, status text, attrs text)')
        for i, (sid, parent) in enumerate([('chat-a', None), ('chat-a', None), ('helper-1', 'chat-a'), ('chat-b', None)]):
            conn.execute('insert into events (event_id, ts, kind, session_id, parent_session_id, status, attrs) '
                         'values (?, ?, ?, ?, ?, ?, ?)', (f'e{i}', 1.0 + i, 'tool.end', sid, parent, 'ok', '{}'))


def test_privacy_commands_pause_forget_and_report(tmp_path, monkeypatch):
    from omniscience.privacy import PausedSessions

    db = tmp_path / 'events.db'
    _events_db(db)
    monkeypatch.setattr(omniscience, '_store', None)
    monkeypatch.setattr(omniscience, '_paused', PausedSessions(str(db)))
    monkeypatch.setenv('OMNISCIENCE_DB', str(db))

    assert 'OFF' in omniscience._omni_command('off', session_id='chat-a')
    assert omniscience._paused.is_paused('chat-a')
    # a paused chat's hooks are not recorded
    calls = []
    monkeypatch.setattr(omniscience, '_store', type('S', (), {'submit': lambda self, h, k: calls.append(h)})())
    omniscience._make_callback('post_tool_call')(session_id='chat-a', tool_name='terminal')
    omniscience._make_callback('post_tool_call')(session_id='chat-b', tool_name='terminal')
    assert calls == ['post_tool_call']
    monkeypatch.setattr(omniscience, '_store', None)
    assert 'ON' in omniscience._omni_command('on', session_id='chat-a')

    ask = omniscience._omni_command('forget', session_id='chat-a')
    assert 'confirm' in ask
    with sqlite3.connect(db) as conn:
        assert conn.execute('select count(*) from events').fetchone()[0] == 4  # nothing deleted yet
    done = omniscience._omni_command('forget  CONFIRM', session_id='chat-a')
    assert 'deleted 3' in done
    with sqlite3.connect(db) as conn:
        assert [r[0] for r in conn.execute('select session_id from events')] == ['chat-b']

    report = omniscience._omni_command('privacy', session_id='chat-b')
    assert str(db) in report


def test_forget_confirm_says_so_when_the_delete_failed(tmp_path, monkeypatch):
    """A failed delete must not be reported as "deleted 0 recorded steps" (which reads as success).

    Before the fix, forget_session swallowed the sqlite error and returned 0, so a chat whose
    rows were still in the database was reported as deleted.
    """
    db = tmp_path / 'events.db'
    _events_db(db)
    monkeypatch.setattr(omniscience, '_store', None)
    monkeypatch.setenv('OMNISCIENCE_DB', str(db))

    # Break the file between the ask and the confirmation: the delete cannot succeed.
    db.write_bytes(b'this is not a sqlite database')
    answer = omniscience._omni_command('forget confirm', session_id='chat-a')
    assert 'could not delete' in answer.lower()
    assert 'deleted 0' not in answer


def _usage_db(db, usage):
    import json as _json
    with sqlite3.connect(db) as conn:
        conn.execute("create table events (event_id text, session_id text, kind text, status text, attrs text)")
        conn.executemany("insert into events values (?, ?, ?, ?, ?)", [
            ("ts1", "chat-a", "turn.start", "ok", "{}"),
            ("req1", "chat-a", "llm.request", "ok", _json.dumps({"model": "m", "provider": "p"})),
            ("resp1", "chat-a", "llm.response", "ok", _json.dumps({"usage": usage, "duration_s": 1.0})),
        ])


def test_new_input_is_the_prompt_minus_what_was_reused(tmp_path):
    """Some providers report input_tokens as the whole input (cached included).

    The report printed it as "new", so a call with 100 prompt / 80 cached said 100 were new.
    """
    db = tmp_path / "events.db"
    _usage_db(db, {"prompt_tokens": 100, "cache_read_tokens": 80, "input_tokens": 100,
                   "output_tokens": 7})
    result = diagnose_current(str(db), "chat-a", mode="full")
    assert "20 new" in result, result
    assert "100 new" not in result


def test_a_call_count_never_covers_more_calls_than_were_measured(tmp_path):
    """"2 model calls totalling N tokens" counted a response with no usage in the call count."""
    import json as _json
    db = tmp_path / "events.db"
    with sqlite3.connect(db) as conn:
        conn.execute("create table events (event_id text, session_id text, kind text, status text, attrs text)")
        conn.executemany("insert into events values (?, ?, ?, ?, ?)", [
            ("ts1", "chat-a", "turn.start", "ok", "{}"),
            ("req1", "chat-a", "llm.request", "ok", _json.dumps({"model": "m", "provider": "p"})),
            # The newest response reports a prompt size; the older one never did.
            ("resp1", "chat-a", "llm.response", "ok", _json.dumps({"duration_s": 1.0})),
            ("resp2", "chat-a", "llm.response", "ok", _json.dumps({"usage": {"prompt_tokens": 500}, "duration_s": 1.0})),
        ])
    result = diagnose_current(str(db), "chat-a", mode="light")
    # The count is what was used; the note says how much of it was measured.
    assert "2 calls (1 reported usage) totalling 500 tokens" in result, result


def test_one_recorded_call_is_not_described_as_every_call(tmp_path):
    """The light report claimed what "each model call now sends" from a single sample."""
    db = tmp_path / "events.db"
    _usage_db(db, {"prompt_tokens": 100, "cache_read_tokens": 80, "output_tokens": 7})
    result = diagnose_current(str(db), "chat-a", mode="light")
    assert "Each model call now sends" not in result
    assert "The latest model call sent 100 tokens" in result


def test_forgetting_a_chat_also_clears_its_pause(tmp_path, monkeypatch):
    """The paused list kept the id after /omni forget, so a resumed chat stayed silently unrecorded."""
    from omniscience.privacy import PausedSessions

    db = tmp_path / 'events.db'
    _events_db(db)
    monkeypatch.setattr(omniscience, '_store', None)
    monkeypatch.setattr(omniscience, '_paused', PausedSessions(str(db)))
    monkeypatch.setenv('OMNISCIENCE_DB', str(db))

    omniscience._omni_command('off', session_id='chat-a')
    assert omniscience._paused.is_paused('chat-a')
    omniscience._omni_command('forget confirm', session_id='chat-a')
    assert not omniscience._paused.is_paused('chat-a')


def test_forget_says_so_when_the_pause_could_not_be_cleared(tmp_path, monkeypatch):
    db = tmp_path / 'events.db'
    _events_db(db)
    monkeypatch.setattr(omniscience, '_store', None)
    monkeypatch.setenv('OMNISCIENCE_DB', str(db))

    class Stuck:
        def is_paused(self, session_id):
            return True

        def resume(self, session_id):
            return False

    monkeypatch.setattr(omniscience, '_paused', Stuck())
    answer = omniscience._omni_command('forget confirm', session_id='chat-a')
    assert 'could not be cleared' in answer
