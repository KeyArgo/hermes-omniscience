import type { OmniEvent } from '../types';

const BOOT = 'boot-1';
const ROOT = 'root-1';
const CHILD = 'child-1';

function ev(rowid: number, kind: string, partial: Partial<OmniEvent> = {}): OmniEvent {
  return {
    rowid,
    event_id: `evt-${rowid}`,
    schema: 'omni.v1',
    boot_id: BOOT,
    seq: rowid,
    ts: 1762400000 + rowid,
    kind,
    session_id: ROOT,
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: {},
    ...partial,
  };
}

/**
 * A compact, realistic root trace (~25 events): two normal turns, one LLM
 * error followed by a successful retry, a subagent with its own turn, a
 * running LLM request, and both sessions ending cleanly.
 */
export const fixtureEvents: OmniEvent[] = [
  ev(1, 'session.start', {
    attrs: { platform: 'cli', model: 'claude-sonnet-4' },
  }),
  ev(2, 'turn.start', {
    turn_id: 't1',
    attrs: { platform: 'cli', model: 'claude-sonnet-4', is_first_turn: true, user_chars: 84 },
  }),
  ev(3, 'llm.request', {
    turn_id: 't1',
    api_request_id: 'r1',
    attrs: {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      api_mode: 'stream',
      message_count: 2,
      tool_count: 1,
      approx_input_tokens: 1200,
      max_tokens: 4096,
      started_at: 1762400003,
    },
  }),
  ev(4, 'tool.end', {
    event_id: 'tool-read-1',
    turn_id: 't1',
    api_request_id: 'r1',
    tool_call_id: 'call-1',
    attrs: { tool_name: 'read_file', duration_ms: 42, result_chars: 900 },
  }),
  ev(5, 'llm.response', {
    turn_id: 't1',
    api_request_id: 'r1',
    attrs: {
      duration_s: 1.8,
      finish_reason: 'stop',
      response_model: 'claude-sonnet-4',
      usage: { input_tokens: 1200, output_tokens: 300 },
      tool_call_count: 1,
    },
  }),
  ev(6, 'turn.end', {
    turn_id: 't1',
    status: 'ok',
    attrs: { model: 'claude-sonnet-4', assistant_chars: 410 },
  }),
  ev(7, 'turn.start', {
    turn_id: 't2',
    attrs: { platform: 'cli', model: 'claude-sonnet-4', is_first_turn: false },
  }),
  ev(8, 'llm.request', {
    turn_id: 't2',
    api_request_id: 'r2',
    attrs: {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      approx_input_tokens: 1400,
      max_tokens: 4096,
      retry_count: 0,
    },
  }),
  ev(9, 'llm.error', {
    turn_id: 't2',
    api_request_id: 'r2',
    attrs: {
      duration_s: 0.4,
      status_code: 429,
      retryable: true,
      reason: 'rate_limit',
      error_type: 'RateLimitError',
    },
  }),
  ev(10, 'llm.response', {
    turn_id: 't2',
    api_request_id: 'r2',
    attrs: {
      duration_s: 2.1,
      finish_reason: 'tool_calls',
      response_model: 'claude-sonnet-4',
      usage: { input_tokens: 1400, output_tokens: 250 },
      tool_call_count: 1,
    },
  }),
  ev(11, 'tool.end', {
    event_id: 'tool-term-2',
    turn_id: 't2',
    api_request_id: 'r2',
    tool_call_id: 'call-2',
    status: 'error',
    attrs: { tool_name: 'terminal', duration_ms: 120, error_type: 'timeout', result_chars: 0 },
  }),
  ev(12, 'turn.end', {
    turn_id: 't2',
    status: 'ok',
    attrs: { model: 'claude-sonnet-4', assistant_chars: 220 },
  }),
  ev(13, 'subagent.start', {
    turn_id: 't2',
    subagent_id: 'sa-1',
    attrs: {
      child_session_id: CHILD,
      child_subagent_id: 'sa-1',
      parent_turn_id: 't2',
      role: 'researcher',
      goal_chars: 120,
    },
  }),
  ev(14, 'session.start', {
    event_id: 'evt-child-start',
    session_id: CHILD,
    parent_session_id: ROOT,
    attrs: { platform: 'cli', model: 'claude-haiku' },
  }),
  ev(15, 'turn.start', {
    event_id: 'evt-child-turn-start',
    session_id: CHILD,
    parent_session_id: ROOT,
    turn_id: 't3',
    attrs: { platform: 'cli', model: 'claude-haiku', is_first_turn: true },
  }),
  ev(16, 'llm.request', {
    event_id: 'evt-child-llm-req',
    session_id: CHILD,
    parent_session_id: ROOT,
    turn_id: 't3',
    api_request_id: 'r3',
    attrs: { model: 'claude-haiku', provider: 'anthropic', approx_input_tokens: 800 },
  }),
  ev(17, 'tool.end', {
    event_id: 'tool-grep-3',
    session_id: CHILD,
    parent_session_id: ROOT,
    turn_id: 't3',
    api_request_id: 'r3',
    tool_call_id: 'call-3',
    attrs: { tool_name: 'grep', duration_ms: 15, result_chars: 64 },
  }),
  ev(18, 'llm.response', {
    event_id: 'evt-child-llm-resp',
    session_id: CHILD,
    parent_session_id: ROOT,
    turn_id: 't3',
    api_request_id: 'r3',
    attrs: {
      duration_s: 0.9,
      finish_reason: 'stop',
      usage: { input_tokens: 800, output_tokens: 120 },
    },
  }),
  ev(19, 'turn.end', {
    event_id: 'evt-child-turn-end',
    session_id: CHILD,
    parent_session_id: ROOT,
    turn_id: 't3',
    status: 'ok',
    attrs: { model: 'claude-haiku' },
  }),
  ev(20, 'subagent.stop', {
    subagent_id: 'sa-1',
    attrs: {
      child_session_id: CHILD,
      child_status: 'completed',
      duration_ms: 3500,
      tool_count: 1,
    },
  }),
  ev(21, 'session.end', {
    event_id: 'evt-child-session-end',
    session_id: CHILD,
    parent_session_id: ROOT,
    status: 'completed',
    attrs: { completed: true, interrupted: false },
  }),
  ev(22, 'turn.start', {
    turn_id: 't4',
    attrs: { platform: 'cli', model: 'claude-sonnet-4', is_first_turn: false },
  }),
  ev(23, 'llm.request', {
    turn_id: 't4',
    api_request_id: 'r4',
    attrs: { model: 'claude-sonnet-4', provider: 'anthropic', approx_input_tokens: 2100 },
  }),
  ev(24, 'tool.end', {
    event_id: 'tool-write-4',
    turn_id: 't4',
    api_request_id: 'r4',
    tool_call_id: 'call-4',
    attrs: { tool_name: 'write_file', duration_ms: 20, result_chars: 12 },
  }),
  ev(25, 'session.end', {
    status: 'completed',
    attrs: { completed: true, interrupted: false },
  }),
];
