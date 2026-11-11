import { describe, expect, it } from 'vitest';
import type { OmniEvent } from '../types';
import { summariseChat } from './chatSummary';

let seq = 0;

function ev(kind: string, attrs: Record<string, unknown> | string | null, extra: Partial<OmniEvent> = {}): OmniEvent {
  seq += 1;
  return {
    rowid: seq,
    event_id: `e${seq}`,
    schema: 1,
    boot_id: 'b',
    seq,
    ts: 1_000 + seq,
    kind,
    session_id: 'root',
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs,
    ...extra,
  } as OmniEvent;
}

const response = (prompt: number, out: number, model = 'm') =>
  ev('llm.response', { usage: { prompt_tokens: prompt, output_tokens: out }, model });

describe('summariseChat — outcome', () => {
  it('says empty when there is nothing recorded', () => {
    const s = summariseChat([], 'root');
    expect(s.outcome).toBe('empty');
    expect(s.facts.modelCalls).toBe(0);
  });

  it('says running when the last model event is a request with no answer', () => {
    const s = summariseChat([response(1000, 10), ev('llm.request', { model: 'm' })], 'root');
    expect(s.outcome).toBe('running');
  });

  it('says failed when the last model event is an error', () => {
    const s = summariseChat([response(1000, 10), ev('llm.error', { reason: 'timeout', error_type: 'APIConnectionError' }, { status: 'error' })], 'root');
    expect(s.outcome).toBe('failed');
    expect(s.improve.join(' ')).toMatch(/timeout|provider/i);
  });

  it('says mixed when something failed but the chat went on', () => {
    const s = summariseChat(
      [ev('tool.end', { tool_name: 'terminal' }, { status: 'error' }), response(1000, 10)],
      'root',
    );
    expect(s.outcome).toBe('mixed');
  });

  it('says ok when nothing failed', () => {
    expect(summariseChat([response(1000, 10)], 'root').outcome).toBe('ok');
  });
});

describe('summariseChat — facts', () => {
  it('counts calls, tools, tokens and the peak context', () => {
    const events = [
      ev('llm.request', { model: 'm' }),
      response(1_000, 20),
      ev('llm.request', { model: 'm' }),
      response(150_000, 40),
      ev('tool.end', { tool_name: 'terminal', duration_ms: 3000 }),
      ev('tool.end', { tool_name: 'read_file', duration_ms: 9000 }),
    ];
    const { facts } = summariseChat(events, 'root');
    expect(facts.modelCalls).toBe(2);
    expect(facts.toolCalls).toBe(2);
    expect(facts.tokensIn).toBe(151_000);
    expect(facts.tokensOut).toBe(60);
    expect(facts.peakContext).toBe(150_000);
    expect(facts.slowestTool).toBe('read_file');
    expect(facts.models).toEqual(['m']);
    expect(facts.seconds).toBeGreaterThan(0);
  });

  it('reads a usage block written as a JSON string', () => {
    const { facts } = summariseChat(
      [ev('llm.response', JSON.stringify({ usage: { prompt_tokens: 500, output_tokens: 7 } }))],
      'root',
    );
    expect(facts.tokensIn).toBe(500);
    expect(facts.tokensOut).toBe(7);
  });

  it('survives junk attrs without throwing', () => {
    const events = [ev('llm.response', null), ev('tool.end', 'not json'), ev('llm.request', {})];
    expect(() => summariseChat(events, 'root')).not.toThrow();
  });

  it('is pure: the same input twice gives the same summary', () => {
    const events = [response(2000, 10), ev('tool.end', { tool_name: 'terminal' })];
    expect(summariseChat(events, 'root')).toEqual(summariseChat(events, 'root'));
  });
});

describe('summariseChat — what to improve', () => {
  it('flags a big context and suggests compacting', () => {
    const s = summariseChat([response(150_000, 10)], 'root');
    expect(s.improve.join(' ')).toMatch(/compact/i);
  });

  it('names a tool that ran over and over', () => {
    const events = [1, 2, 3, 4, 5, 6].map(() => ev('tool.end', { tool_name: 'terminal' }));
    const s = summariseChat(events, 'root');
    expect(s.facts.repeatedTool?.times ?? 0).toBeGreaterThanOrEqual(2);
    expect(s.improve.join(' ')).toContain('terminal');
  });

  it('never gives more than three suggestions', () => {
    const events = [
      response(200_000, 10),
      ...[1, 2, 3, 4, 5, 6].map(() => ev('tool.end', { tool_name: 'terminal' }, { status: 'error' })),
      ev('llm.error', { label: 'boom' }),
    ];
    expect(summariseChat(events, 'root').improve.length).toBeLessThanOrEqual(3);
  });

  it('says nothing to improve when the chat was clean and small', () => {
    expect(summariseChat([response(900, 10)], 'root').improve).toEqual([]);
  });
});

describe('summariseChat — the explanation', () => {
  it('always gives at least two sentences when there are events', () => {
    expect(summariseChat([response(1000, 10)], 'root').went.length).toBeGreaterThanOrEqual(2);
  });

  it('does not shout: no all-caps words in the headline', () => {
    const s = summariseChat([response(1000, 10)], 'root');
    expect(s.headline).not.toMatch(/\b[A-Z]{4,}\b/);
  });
});

// --- bug hunt round 3 (2026-11-09) ------------------------------------------------

describe('summariseChat — claims the events do not support', () => {
  it('does not call a blocked tool run a success', () => {
    // 'blocked' is a first-class status in the graph (amber "Blocked"); the summary counted
    // only error/failed/timeout, so a permission-blocked run read "Everything it tried succeeded".
    const s = summariseChat(
      [response(1000, 10), ev('tool.end', { tool_name: 'terminal' }, { status: 'blocked' })],
      'root',
    );
    expect(s.outcome).not.toBe('ok');
    expect(s.went.join(' ')).not.toMatch(/Everything it tried succeeded/i);
  });

  it('is not "still running" once the session has ended', () => {
    const s = summariseChat(
      [response(1000, 10), ev('llm.request', { model: 'm' }), ev('session.end', { end_reason: 'completed' })],
      'root',
    );
    expect(s.outcome).not.toBe('running');
    expect(s.headline).not.toMatch(/still running/i);
    // The answer never arrived, so this must not read as a clean finish either.
    expect(s.outcome).toBe('failed');
    expect(s.went.join(' ')).not.toMatch(/Everything it tried succeeded/i);
  });

  it('does not invent a compaction from a helper call with a smaller prompt', () => {
    // A helper session sends a small prompt of its own; mixing it into the root's series made
    // every helper look like a context drop.
    const s = summariseChat(
      [
        response(80000, 100),
        ev('llm.response', { usage: { prompt_tokens: 5000, output_tokens: 50 } },
           { session_id: 'helper', parent_session_id: 'root' }),
      ],
      'root',
    );
    expect(s.facts.compactions).toBe(0);
  });
});

describe('summariseChat — a helper ending does not end the chat', () => {
  it('stays running when the session.end belongs to a helper', () => {
    const s = summariseChat(
      [
        response(1000, 10),
        ev('llm.request', { model: 'm' }),
        ev('session.end', { end_reason: 'completed' }, { session_id: 'helper', parent_session_id: 'root' }),
      ],
      'root',
    );
    expect(s.outcome).toBe('running');
  });
});
