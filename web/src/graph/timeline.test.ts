import { describe, it, expect } from 'vitest';
import { buildTimeline } from './timeline';
import type { OmniEvent } from '../types';

function ev(partial: Partial<OmniEvent>): OmniEvent {
  return {
    rowid: 0,
    event_id: partial.event_id ?? 'e',
    schema: 'omni',
    boot_id: 'b',
    seq: 0,
    ts: 0,
    kind: '',
    session_id: null,
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: null,
    ...partial,
  };
}

describe('buildTimeline', () => {
  it('detects fallback when response_model differs from request model', () => {
    const events = [
      ev({
        event_id: 'r1',
        kind: 'llm.request',
        ts: 100,
        api_request_id: 'req1',
        attrs: { model: 'gpt-6.1-sol', provider: 'openai-codex' },
      }),
      ev({
        event_id: 'resp1',
        kind: 'llm.response',
        ts: 120,
        api_request_id: 'req1',
        status: 'ok',
        attrs: {
          duration_s: 20,
          ttfb_s: 3,
          started_at: 100,
          ended_at: 120,
          response_model: 'GLM-5.3-Flash-EXL3',
        },
      }),
    ];
    const t = buildTimeline(events, 200);
    const bar = t.bars.find((b) => b.kind === 'llm')!;
    expect(bar.fallback).toBe(true);
    expect(bar.requestedModel).toBe('gpt-6.1-sol');
    expect(bar.model).toBe('GLM-5.3-Flash-EXL3');
    expect(bar.status).toBe('ok');
    expect(bar.start).toBe(100);
    expect(bar.end).toBe(120);
  });

  it('attaches 429 error to the llm bar and marks status error when no response', () => {
    const events = [
      ev({
        event_id: 'r1',
        kind: 'llm.request',
        ts: 100,
        api_request_id: 'req1',
        attrs: { model: 'gpt-6.1-sol' },
      }),
      ev({
        event_id: 'err1',
        kind: 'llm.error',
        ts: 102,
        api_request_id: 'req1',
        status: 'error',
        attrs: { duration_s: 1.93, error_type: 'RateLimitError', reason: 'rate_limit', retryable: true, status_code: 429 },
      }),
    ];
    const t = buildTimeline(events, 200);
    const bar = t.bars.find((b) => b.kind === 'llm')!;
    expect(bar.status).toBe('error');
    expect(bar.errors.length).toBe(1);
    expect(bar.errors[0].statusCode).toBe(429);
    expect(bar.errors[0].reason).toBe('rate_limit');
    expect(bar.end).toBe(102);
  });

  it('marks a bar running when there is a request but no response or error', () => {
    const events = [
      ev({
        event_id: 'r1',
        kind: 'llm.request',
        ts: 100,
        api_request_id: 'req1',
        attrs: { model: 'gpt-6.1-sol' },
      }),
    ];
    const t = buildTimeline(events, 150);
    const bar = t.bars.find((b) => b.kind === 'llm')!;
    expect(bar.status).toBe('running');
    expect(bar.end).toBe(150);
  });

  it('computes tool bar times from started_at and duration_ms', () => {
    const events = [
      ev({
        event_id: 't1',
        kind: 'tool.end',
        ts: 1000,
        status: 'ok',
        attrs: { tool_name: 'terminal', duration_ms: 16222, started_at: 983.778, result_chars: 1130 },
      }),
    ];
    const t = buildTimeline(events, 2000);
    const bar = t.bars.find((b) => b.kind === 'tool')!;
    expect(bar.label).toBe('terminal');
    expect(bar.start).toBeCloseTo(983.778, 3);
    expect(bar.end).toBe(1000);
    expect(bar.status).toBe('ok');
  });

  it('builds a helper bar from subagent start/stop', () => {
    const events = [
      ev({ event_id: 's1', kind: 'subagent.start', ts: 50, session_id: 'child', subagent_id: 'sub1' }),
      ev({ event_id: 's2', kind: 'subagent.stop', ts: 80, session_id: 'child', subagent_id: 'sub1' }),
    ];
    const t = buildTimeline(events, 100);
    const bar = t.bars.find((b) => b.kind === 'helper')!;
    expect(bar.start).toBe(50);
    expect(bar.end).toBe(80);
    expect(bar.status).toBe('ok');
    expect(t.lanes).toContain('helpers');
  });

  it('produces rate-limit and fallback findings', () => {
    const events = [
      ev({ event_id: 'r1', kind: 'llm.request', ts: 100, api_request_id: 'req1', attrs: { model: 'gpt-6.1-sol' } }),
      ev({ event_id: 'e1', kind: 'llm.error', ts: 102, api_request_id: 'req1', status: 'error', attrs: { reason: 'rate_limit', status_code: 429 } }),
      ev({ event_id: 'r2', kind: 'llm.request', ts: 110, api_request_id: 'req2', attrs: { model: 'gpt-6.1-sol' } }),
      ev({ event_id: 'resp2', kind: 'llm.response', ts: 130, api_request_id: 'req2', status: 'ok', attrs: { duration_s: 20, started_at: 110, ended_at: 130, response_model: 'GLM-5.3-Flash-EXL3' } }),
    ];
    const t = buildTimeline(events, 200);
    const joined = t.findings.join(' | ');
    expect(joined).toMatch(/rate-limited \(429\)/);
    expect(joined).toMatch(/switched from gpt-6.1-sol to GLM-5.3-Flash-EXL3/);
    expect(joined).toMatch(/fallback/);
  });

  it('parses attrs given as a JSON string', () => {
    const events = [
      ev({
        event_id: 'r1',
        kind: 'llm.request',
        ts: 100,
        api_request_id: 'req1',
        attrs: JSON.stringify({ model: 'gpt-6.1-sol' }),
      }),
      ev({
        event_id: 'resp1',
        kind: 'llm.response',
        ts: 120,
        api_request_id: 'req1',
        status: 'ok',
        attrs: JSON.stringify({ duration_s: 20, started_at: 100, ended_at: 120, response_model: 'gpt-6.1-sol' }),
      }),
    ];
    const t = buildTimeline(events, 200);
    const bar = t.bars.find((b) => b.kind === 'llm')!;
    expect(bar.model).toBe('gpt-6.1-sol');
    expect(bar.fallback).toBe(false);
    expect(bar.status).toBe('ok');
  });
});

// --- bug hunt round 4 (2026-11-09): a response-only call ran forward in time ---------------
describe('buildTimeline — model call with only a response', () => {
  it('ends the bar at the response, not a duration after it', () => {
    const events = [
      ev({
        event_id: 'resp-only',
        kind: 'llm.response',
        api_request_id: 'r1',
        ts: 1000,
        attrs: { model: 'm', duration_s: 4 },
      }),
    ];
    const t = buildTimeline(events);
    const bar = t.bars.find((b) => b.lane === 'model calls');
    expect(bar).toBeDefined();
    if (!bar) throw new Error('model call bar missing');
    expect(bar.end).toBeLessThanOrEqual(1000);
    expect(bar.start).toBeCloseTo(996, 5);
  });
});
