import { describe, it, expect } from 'vitest';
import { buildVerdict } from './verdict';
import type { OmniEvent } from '../types';

function makeEvent(overrides: Partial<OmniEvent> & { rowid: number; event_id: string; ts: number; kind: string }): OmniEvent {
  return {
    schema: 'omni.v1',
    boot_id: 'b',
    seq: overrides.rowid,
    session_id: null,
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: null,
    ...overrides,
  };
}

function ev(partial: Partial<OmniEvent> & { kind: OmniEvent["kind"]; ts: number }): OmniEvent {
  return {
    event_id: partial.event_id ?? `e-${partial.kind}-${partial.ts}`,
    kind: partial.kind,
    ts: partial.ts,
    rowid: partial.rowid ?? partial.ts,
    session_id: partial.session_id ?? "s1",
    attrs: partial.attrs ?? null,
    status: partial.status ?? null,
    api_request_id: partial.api_request_id ?? null,
    parent_session_id: partial.parent_session_id ?? null,
  } as OmniEvent;
}

describe('buildVerdict', () => {
  it('returns empty for no events', () => {
    const v = buildVerdict([], 1000);
    expect(v.level).toBe('empty');
    expect(v.headline).toContain('No events');
    expect(v.reasons).toEqual([]);
    expect(v.timeSplit).toEqual([]);
    expect(v.worstEventId).toBeNull();
  });

  it('returns ok for a simple successful chat', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 103, kind: 'llm.response', api_request_id: 'r1', attrs: { duration_s: 2, ttfb_s: 0.5, started_at: 101, ended_at: 103, finish_reason: 'stop', response_model: 'gpt-4', usage: { prompt_tokens: 100, cache_read_tokens: 0, output_tokens: 50 } } }),
      makeEvent({ rowid: 4, event_id: 'e4', ts: 104, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('ok');
    expect(v.headline).toContain('OK');
    expect(v.headline).toContain('1 message');
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.worstEventId).toBeNull();
  });

  it('detects failing from unresolved llm error', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 102, kind: 'llm.error', api_request_id: 'r1', attrs: { duration_s: 1, error_type: 'http', reason: 'server_error', retryable: false, status_code: 500 } }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('failing');
    expect(v.headline).toContain('Failing');
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.worstEventId).toBe('e3');
  });

  it('detects failing from tool error in last turn', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'tool.end', tool_call_id: 'tc1', status: 'error', attrs: { tool_name: 'terminal', duration_ms: 500, started_at: 100, result_chars: 0, error_type: 'exit_code' } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 102, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('failing');
    expect(v.headline).toContain('Failing');
    expect(v.reasons.some(r => r.includes('terminal'))).toBe(true);
  });

  it('detects running when last turn not ended and recent', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
    ];
    const v = buildVerdict(events, 200); // 100s ago, < 300
    expect(v.level).toBe('running');
    expect(v.headline).toContain('Running');
  });

  it('detects slow from rate limit', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 102, kind: 'llm.error', api_request_id: 'r1', attrs: { duration_s: 1, error_type: 'http', reason: 'rate_limit', retryable: true, status_code: 429 } }),
      makeEvent({ rowid: 4, event_id: 'e4', ts: 103, kind: 'llm.request', api_request_id: 'r2', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 1 } }),
      makeEvent({ rowid: 5, event_id: 'e5', ts: 105, kind: 'llm.response', api_request_id: 'r2', attrs: { duration_s: 2, ttfb_s: 0.5, started_at: 103, ended_at: 105, finish_reason: 'stop', response_model: 'gpt-4', usage: { prompt_tokens: 100, cache_read_tokens: 0, output_tokens: 50 } } }),
      makeEvent({ rowid: 6, event_id: 'e6', ts: 106, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('slow');
    expect(v.reasons.some(r => r.includes('rate-limited'))).toBe(true);
    expect(v.reasons.some(r => r.includes('429'))).toBe(true);
  });

  it('detects slow from fallback', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-6.1-sol', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-6.1-sol', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 103, kind: 'llm.response', api_request_id: 'r1', attrs: { duration_s: 2, ttfb_s: 0.5, started_at: 101, ended_at: 103, finish_reason: 'stop', response_model: 'GLM-5.3-Flash-EXL3', usage: { prompt_tokens: 100, cache_read_tokens: 0, output_tokens: 50 } } }),
      makeEvent({ rowid: 4, event_id: 'e4', ts: 104, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('slow');
    expect(v.reasons.some(r => r.includes('switched from gpt-6.1-sol to GLM-5.3-Flash-EXL3'))).toBe(true);
    expect(v.reasons.some(r => r.includes('fallback'))).toBe(true);
  });

  it('detects slow from high ttfb', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 135, kind: 'llm.response', api_request_id: 'r1', attrs: { duration_s: 34, ttfb_s: 35, started_at: 101, ended_at: 135, finish_reason: 'stop', response_model: 'gpt-4', usage: { prompt_tokens: 100, cache_read_tokens: 0, output_tokens: 50 } } }),
      makeEvent({ rowid: 4, event_id: 'e4', ts: 136, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('slow');
    expect(v.reasons.some(r => r.includes('Longest wait for the first word'))).toBe(true);
  });

  it('counts consecutive same-tool calls', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'tool.end', tool_call_id: 'tc1', status: 'error', attrs: { tool_name: 'terminal', duration_ms: 100, started_at: 100, result_chars: 0, error_type: 'exit_code' } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 102, kind: 'tool.end', tool_call_id: 'tc2', status: 'error', attrs: { tool_name: 'terminal', duration_ms: 100, started_at: 101, result_chars: 0, error_type: 'exit_code' } }),
      makeEvent({ rowid: 4, event_id: 'e4', ts: 103, kind: 'tool.end', tool_call_id: 'tc3', status: 'error', attrs: { tool_name: 'terminal', duration_ms: 100, started_at: 102, result_chars: 0, error_type: 'exit_code' } }),
      makeEvent({ rowid: 5, event_id: 'e5', ts: 104, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('failing');
    expect(v.reasons.some(r => r.includes('terminal failed 3 times'))).toBe(true);
    expect(v.reasons.some(r => r.includes('3 calls in a row'))).toBe(true);
  });

  it('handles attrs as JSON string', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: JSON.stringify({ model: 'gpt-4', platform: 'web' }) }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: JSON.stringify({ model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 }) }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 103, kind: 'llm.response', api_request_id: 'r1', attrs: JSON.stringify({ duration_s: 2, ttfb_s: 0.5, started_at: 101, ended_at: 103, finish_reason: 'stop', response_model: 'gpt-4', usage: { prompt_tokens: 100, cache_read_tokens: 0, output_tokens: 50 } }) }),
      makeEvent({ rowid: 4, event_id: 'e4', ts: 104, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).toBe('ok');
    expect(v.headline).toContain('OK');
  });

  it('builds timeSplit correctly', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
      makeEvent({ rowid: 3, event_id: 'e3', ts: 106, kind: 'llm.response', api_request_id: 'r1', attrs: { duration_s: 5, ttfb_s: 0.5, started_at: 101, ended_at: 106, finish_reason: 'stop', response_model: 'gpt-4', usage: { prompt_tokens: 100, cache_read_tokens: 0, output_tokens: 50 } } }),
      makeEvent({ rowid: 4, event_id: 'e4', ts: 107, kind: 'tool.end', tool_call_id: 'tc1', status: 'ok', attrs: { tool_name: 'search', duration_ms: 3000, started_at: 106, result_chars: 500 } }),
      makeEvent({ rowid: 5, event_id: 'e5', ts: 108, kind: 'turn.end' }),
      makeEvent({ rowid: 6, event_id: 'e6', ts: 113, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 7, event_id: 'e7', ts: 114, kind: 'turn.end' }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.timeSplit.length).toBe(3);
    const model = v.timeSplit.find(t => t.label === 'model');
    const tools = v.timeSplit.find(t => t.label === 'tools');
    const waiting = v.timeSplit.find(t => t.label === 'waiting');
    expect(model?.seconds).toBe(5);
    expect(tools?.seconds).toBe(3);
    expect(waiting?.seconds).toBe(5); // 113 - 108
  });

  it('detects interrupted last turn', () => {
    const events: OmniEvent[] = [
      makeEvent({ rowid: 1, event_id: 'e1', ts: 100, kind: 'turn.start', attrs: { model: 'gpt-4', platform: 'web' } }),
      makeEvent({ rowid: 2, event_id: 'e2', ts: 101, kind: 'llm.request', api_request_id: 'r1', attrs: { model: 'gpt-4', provider: 'openai', approx_input_tokens: 100, retry_count: 0 } }),
    ];
    const v = buildVerdict(events, 500); // 400s ago > 300
    expect(v.level).toBe('failing');
    expect(v.reasons.some(r => r.includes('stopped without finishing'))).toBe(true);
  });

  it("DOES mark error as recovered when same api_request_id gets a later response", () => {
    const events: OmniEvent[] = [
      ev({ kind: "turn.start", ts: 50 }),
      ev({ kind: "llm.error", ts: 100, api_request_id: "A", attrs: { retryable: true, reason: "rate_limit" } }),
      ev({ kind: "llm.response", ts: 105, api_request_id: "A" }),
      ev({ kind: "turn.end", ts: 200 }),
    ];
    const v = buildVerdict(events, 1000);
    // Error A recovered by same-id response → not unresolved → not failing
    expect(v.level).not.toBe("failing");
  });

  it("does NOT flag interrupted when last turn has its own end", () => {
    const events: OmniEvent[] = [
      ev({ kind: "turn.start", ts: 100 }),
      ev({ kind: "turn.end", ts: 200 }),
      ev({ kind: "turn.start", ts: 300 }),
      ev({ kind: "turn.end", ts: 400 }),
    ];
    const v = buildVerdict(events, 1000);
    expect(v.level).toBe("ok");
  });

  it("is not failing when the message finished normally after an unrelated error", () => {
    // The message went on and ended normally, so the error is a delay, not a failure.
    // Error for api_request_id "A" at t=100 (retryable). Unrelated response for "B" at t=105.
    const events: OmniEvent[] = [
      ev({ kind: "turn.start", ts: 50 }),
      ev({ kind: "llm.error", ts: 100, api_request_id: "A", attrs: { retryable: true, reason: "rate_limit" } }),
      ev({ kind: "llm.response", ts: 105, api_request_id: "B" }),
      ev({ kind: "turn.end", ts: 200 }),
    ];
    const v = buildVerdict(events, 1000);
    // Error A has no matching response → unresolved → failing
    expect(v.level).toBe("slow");
  });

  it("flags interrupted when last turn has no end and is stale, even if an earlier turn ended", () => {
    // Turn A: start=100, end=200. Turn B: start=300, no end. nowTs=1000 (stale >300s from last event at 300).
    const events: OmniEvent[] = [
      ev({ kind: "turn.start", ts: 100 }),
      ev({ kind: "turn.end", ts: 200 }),
      ev({ kind: "turn.start", ts: 300 }),
    ];
    const v = buildVerdict(events, 1000);
    // lastTurnStart=300, matchingEnd: find turnEnd with ts>=300 → none → matchingEnd=null → isInterrupted=true
    expect(v.level).toBe("failing");
    expect(v.reasons.some(r => r.includes("stopped without finishing"))).toBe(true);
  });
});

// --- bug hunt round 4 (2026-11-09): a blocked tool run is not "OK" ----------------------
describe('buildVerdict — a turn with no end marker', () => {
  it('is finished, not failing, when the last reply was an answer with no tool calls', () => {
    // The owner's own case: the answer arrived, Hermes never recorded turn.end, and the header
    // claimed the message "stopped without finishing" while the failure panel said otherwise.
    const events: OmniEvent[] = [
      ev({ kind: 'turn.start', ts: 100 }),
      ev({ kind: 'llm.request', ts: 101 }),
      ev({ kind: 'llm.response', ts: 110, attrs: { tool_call_count: 0, finish_reason: 'stop' } }),
    ];
    const v = buildVerdict(events, 1000);
    expect(v.level).toBe('ok');
    expect(v.headline.toLowerCase()).not.toContain('without finishing');
    expect(v.headline.toLowerCase()).not.toContain('stopped');
  });

  it('is failing when the last reply asked for a tool and no tool ran', () => {
    const events: OmniEvent[] = [
      ev({ kind: 'turn.start', ts: 100 }),
      ev({ kind: 'llm.request', ts: 101 }),
      ev({ kind: 'llm.response', ts: 110, attrs: { tool_call_count: 1, finish_reason: 'tool_calls' } }),
    ];
    expect(buildVerdict(events, 1000).level).toBe('failing');
  });

  it('is failing when a request went unanswered', () => {
    const events: OmniEvent[] = [
      ev({ kind: 'turn.start', ts: 100 }),
      ev({ kind: 'llm.request', ts: 101 }),
    ];
    expect(buildVerdict(events, 1000).level).toBe('failing');
  });

  it('counts the failures that happened before a clean ending', () => {
    const events: OmniEvent[] = [
      ev({ kind: 'turn.start', ts: 100 }),
      ev({ kind: 'tool.end', ts: 102, status: 'error', attrs: { tool_name: 'memory' } }),
      ev({ kind: 'turn.end', ts: 105 }),
      ev({ kind: 'turn.start', ts: 200 }),
      ev({ kind: 'llm.response', ts: 210, attrs: { tool_call_count: 0, finish_reason: 'stop' } }),
    ];
    const v = buildVerdict(events, 1000);
    expect(v.level).toBe('ok');
    expect(v.headline).toContain('1 earlier step failed');
  });
});

describe('buildVerdict — blocked tools', () => {
  it('does not report OK when the last turn ended with a blocked tool', () => {
    const events = [
      ev({ kind: 'turn.start', ts: 100 }),
      ev({ kind: 'llm.request', ts: 101, api_request_id: 'r1' }),
      ev({ kind: 'llm.response', ts: 102, api_request_id: 'r1', attrs: { usage: { prompt_tokens: 100 } } }),
      ev({ kind: 'tool.end', ts: 103, tool_call_id: 'c1', status: 'blocked', attrs: { tool_name: 'terminal' } }),
      ev({ kind: 'turn.end', ts: 104 }),
    ];
    const v = buildVerdict(events, 200);
    expect(v.level).not.toBe('ok');
  });
});
