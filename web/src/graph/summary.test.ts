import { describe, expect, it } from 'vitest';
import type { OmniEvent } from '../types';
import { fixtureEvents } from './fixture';
import type { RunSummary, TimeSplit } from './summary';
import {
  computeRunSummary,
  computeTimeSplit,
  rootSessionOf,
  runningNow,
  runSentence,
} from './summary';

function ev(rowid: number, kind: string, partial: Partial<OmniEvent> = {}): OmniEvent {
  return {
    rowid,
    event_id: `evt-${rowid}`,
    schema: 'omni.v1',
    boot_id: 'boot-test',
    seq: rowid,
    ts: 1762400000 + rowid,
    kind,
    session_id: 'root-1',
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

describe('run summary', () => {
  const full = computeRunSummary(fixtureEvents);

  it('counts model calls, tools, helpers and lost events', () => {
    // 4 model calls (r1, r2, r3, r4), 4 tool ends, 1 helper agent, 0 lost
    expect(full.modelCalls).toBe(4);
    expect(full.toolCalls).toBe(4);
    expect(full.failedTools).toBe(1);
    expect(full.helperAgents).toBe(1);
    expect(full.lostEvents).toBe(0);
    expect(full.hasEvents).toBe(true);
  });

  it('sums tokens only from reported usage', () => {
    // r1: 1200/300, r2: 1400/250, r3: 800/120, r4: still running (no usage to add)
    expect(full.tokensIn).toBe(3400);
    expect(full.tokensOut).toBe(670);
    expect(full.tokensPartial).toBe(false);

    // a finished response without usage marks the totals partial
    const missing = computeRunSummary([
      fixtureEvents[0],
      fixtureEvents[1],
      fixtureEvents[2],
      { ...fixtureEvents[4], attrs: { duration_s: 1.8, finish_reason: 'stop' } },
      fixtureEvents[5],
    ]);
    expect(missing.tokensIn).toBeNull();
    expect(missing.tokensPartial).toBe(true);

    const partial = computeRunSummary([
      ...fixtureEvents.slice(0, 5),
      fixtureEvents[7], // a second request
      { ...fixtureEvents[9], api_request_id: 'r5', attrs: { duration_s: 1, usage: { output_tokens: 10 } } },
    ]);
    expect(partial.tokensPartial).toBe(true);
  });

  it('falls back to top-level attrs independently for input and output tokens', () => {
    const req = { ...fixtureEvents[7], api_request_id: 'fx', attrs: { model: 'claude-x' } };
    const resp = {
      ...fixtureEvents[9],
      api_request_id: 'fx',
      attrs: { duration_s: 1, usage: { output_tokens: 250 }, input_tokens: 900 },
    };
    const summary = computeRunSummary([fixtureEvents[0], req, resp]);
    expect(summary.tokensIn).toBe(900);
    expect(summary.tokensOut).toBe(250);

    // and the other way: usage has input only, top-level attrs carry output
    const resp2 = {
      ...fixtureEvents[9],
      api_request_id: 'fy',
      attrs: { duration_s: 1, usage: { input_tokens: 100 }, output_tokens: 40 },
    };
    const req2 = { ...fixtureEvents[7], api_request_id: 'fy', attrs: { model: 'claude-x' } };
    const summary2 = computeRunSummary([fixtureEvents[0], req2, resp2]);
    expect(summary2.tokensIn).toBe(100);
    expect(summary2.tokensOut).toBe(40);
  });

  it('never counts one token value twice across usage and attrs', () => {
    const req = { ...fixtureEvents[7], api_request_id: 'fz', attrs: { model: 'claude-x' } };
    const resp = {
      ...fixtureEvents[9],
      api_request_id: 'fz',
      attrs: {
        duration_s: 1,
        usage: { input_tokens: 100, output_tokens: 30 },
        input_tokens: 100,
        output_tokens: 30,
      },
    };
    const summary = computeRunSummary([fixtureEvents[0], req, resp]);
    expect(summary.tokensIn).toBe(100);
    expect(summary.tokensOut).toBe(30);
  });

  it('gives the status in words', () => {
    expect(full.statusWord).toBe('Finished with 2 errors');
    expect(full.isRunning).toBe(false);

    const open = computeRunSummary(fixtureEvents.slice(0, 8));
    expect(open.statusWord).toBe('Running');
    expect(open.isRunning).toBe(true);
  });

  it('lets a dropped marker from another session neither pick the root nor end the run', () => {
    // Finished root session, then a late omni.dropped marker that (like older
    // synth data) carries an unrelated session_id.
    const finished = [
      fixtureEvents[0], // session.start root-1
      fixtureEvents[1], // turn.start t1
      fixtureEvents[24], // session.end root-1, completed
      {
        ...fixtureEvents[25],
        kind: 'omni.dropped',
        event_id: 'dropped-other',
        seq: 30,
        session_id: 'other-root-9',
        parent_session_id: null,
        attrs: { count: 3, since_seq: 22 },
      },
    ];
    const summary = computeRunSummary(finished);
    expect(rootSessionOf(finished)).toBe('root-1');
    expect(summary.statusWord).toBe('Finished');
    expect(summary.isRunning).toBe(false);
    expect(summary.lostEvents).toBe(3);
  });

  it('marks interrupted runs', () => {
    const interrupted = fixtureEvents.map((event) =>
      event.kind === 'session.end' && event.status === 'completed'
        ? { ...event, status: 'interrupted', attrs: { interrupted: true, completed: false } }
        : event,
    );
    expect(computeRunSummary(interrupted).statusWord).toBe('Interrupted');
  });

  it('reports wall time from first to last event', () => {
    const first = fixtureEvents[0].ts;
    const last = fixtureEvents[fixtureEvents.length - 1].ts;
    expect(full.wallSeconds).toBeCloseTo(last - first, 5);
  });

  it('says "not reported" (null) when nothing was reported', () => {
    const nothing = computeRunSummary([]);
    expect(nothing.tokensIn).toBeNull();
    expect(nothing.tokensOut).toBeNull();
    expect(nothing.statusWord).toBe('No data');
    expect(nothing.modelCalls).toBe(0);
    expect(nothing.hasEvents).toBe(false);
  });
});

describe('lost events', () => {
  it('counts explicit drop markers', () => {
    const dropped = computeRunSummary([
      { ...fixtureEvents[0], kind: 'omni.dropped', attrs: { count: 7, since_seq: 2 } },
    ]);
    expect(dropped.lostEvents).toBe(7);
  });

  it('does not treat seq gaps as lost events', () => {
    // seq is per gateway process and shared by all sessions, so jumps are normal.
    const events = [
      { ...fixtureEvents[0], seq: 1 },
      { ...fixtureEvents[1], seq: 50 },
      { ...fixtureEvents[2], seq: 120 },
    ];
    expect(computeRunSummary(events).lostEvents).toBe(0);
  });

  it('counts one omni.dropped marker with count 3 as 3 lost events', () => {
    const events = [
      { ...fixtureEvents[0], seq: 1 },
      { ...fixtureEvents[1], seq: 50 },
      { ...fixtureEvents[2], kind: 'omni.dropped', seq: 120, attrs: { count: 3 } },
    ];
    expect(computeRunSummary(events).lostEvents).toBe(3);
  });
});

describe('root detection', () => {
  it('uses the first session without a parent', () => {
    expect(rootSessionOf(fixtureEvents)).toBe('root-1');
    expect(rootSessionOf([])).toBeNull();
  });
});

describe('runningNow', () => {
  it('identifies the newest model call still waiting on the model', () => {
    const step = runningNow(fixtureEvents.slice(0, 8));
    expect(step).not.toBeNull();
    expect(step?.kind).toBe('llm');
    expect(step?.label).toContain('Waiting on claude-sonnet-4');
    expect(step?.sinceTs).toBe(fixtureEvents[7].ts);
  });

  it('returns null when every call is closed', () => {
    // events 1..7: turn 1 fully done, no open request
    expect(runningNow(fixtureEvents.slice(0, 7))).toBeNull();
  });

  it('recognises a helper agent running a model call', () => {
    // events 1..17 end inside the child's turn: its request is open
    const step = runningNow(fixtureEvents.slice(0, 17));
    expect(step?.kind).toBe('helper-llm');
    expect(step?.label).toContain('Helper agent');
    expect(step?.label).toContain('claude-haiku');
  });

  it('reports a working helper even when its model call closed', () => {
    // up to and including the child's response (still no subagent.stop)
    const step = runningNow(fixtureEvents.slice(0, 19));
    expect(step?.kind).toBe('helper');
    expect(step?.label).toContain('role: researcher');
  });

  it('reports no working helper once it stopped (start then stop)', () => {
    const start = ev(1, 'subagent.start', {
      subagent_id: 'sa-9',
      attrs: { child_session_id: 'child-9', role: 'scout' },
    });
    const stop = ev(2, 'subagent.stop', {
      subagent_id: 'sa-9',
      attrs: { child_session_id: 'child-9' },
    });
    expect(runningNow([start, stop])).toBeNull();
  });

  it('returns the older helper when the newer one already stopped', () => {
    const older = ev(1, 'subagent.start', {
      subagent_id: 'sa-old',
      attrs: { child_session_id: 'child-old', role: 'researcher' },
    });
    const newer = ev(2, 'subagent.start', {
      subagent_id: 'sa-new',
      attrs: { child_session_id: 'child-new', role: 'scout' },
    });
    const stop = ev(3, 'subagent.stop', {
      subagent_id: 'sa-new',
      attrs: { child_session_id: 'child-new' },
    });
    const step = runningNow([older, newer, stop]);
    expect(step?.kind).toBe('helper');
    expect(step?.label).toContain('role: researcher');
  });

  it('ignores stop order in the list, not just rowid (later stop wins on rowid)', () => {
    // stop listed before its own start: the start has a higher rowid, so no later stop exists
    const stop = ev(1, 'subagent.stop', {
      subagent_id: 'sa-9',
      attrs: { child_session_id: 'child-9' },
    });
    const start = ev(2, 'subagent.start', {
      subagent_id: 'sa-9',
      attrs: { child_session_id: 'child-9', role: 'scout' },
    });
    const step = runningNow([stop, start]);
    expect(step?.kind).toBe('helper');
    expect(step?.label).toContain('role: scout');
  });
});

describe('time split', () => {
  it('splits wall time across model calls, tools and the rest', () => {
    const split = computeTimeSplit(fixtureEvents);
    // r1 1.8 + r2 2.1 + r3 0.9, r4 running no duration
    expect(split.llmSeconds).toBeCloseTo(4.8, 5);
    // 42 + 120 + 15 + 20 ms
    expect(split.toolSeconds).toBeCloseTo(0.197, 5);
    const wall = split.summary.wallSeconds ?? 0;
    expect(
      split.llmSeconds + split.toolSeconds + split.waitingSeconds + (split.otherSeconds ?? 0),
    ).toBeCloseTo(wall, 1);
  });

  it('counts the gap between a turn.end and the next turn.start as waiting', () => {
    const events = [
      ev(1, 'turn.start', { turn_id: 't1', ts: 1000 }),
      ev(2, 'turn.end', { turn_id: 't1', ts: 1060 }),
      ev(3, 'turn.start', { turn_id: 't2', ts: 1660 }),
      ev(4, 'turn.end', { turn_id: 't2', ts: 1720 }),
      ev(5, 'session.end', {
        ts: 1720,
        status: 'completed',
        attrs: { completed: true, interrupted: false },
      }),
    ];
    const split = computeTimeSplit(events);
    expect(split.waitingSeconds).toBe(600);
    expect(split.otherSeconds).toBe(120);
  });

  it('gives zero waiting for a single turn', () => {
    const split = computeTimeSplit([
      ev(1, 'turn.start', { turn_id: 't1', ts: 1000 }),
      ev(2, 'turn.end', { turn_id: 't1', ts: 1060 }),
      ev(3, 'session.end', {
        ts: 1060,
        status: 'completed',
        attrs: { completed: true, interrupted: false },
      }),
    ]);
    expect(split.waitingSeconds).toBe(0);
  });

  it('gives zero waiting when a turn timestamp is missing', () => {
    const missingEnd = computeTimeSplit([
      ev(1, 'turn.end', { turn_id: 't1', ts: Number.NaN }),
      ev(2, 'turn.start', { turn_id: 't2', ts: 1660 }),
    ]);
    expect(missingEnd.waitingSeconds).toBe(0);

    const missingStart = computeTimeSplit([
      ev(1, 'turn.end', { turn_id: 't1', ts: 1000 }),
      ev(2, 'turn.start', { turn_id: 't2', ts: Number.NaN }),
    ]);
    expect(missingStart.waitingSeconds).toBe(0);
  });

  it('flags an empty split when no durations were reported', () => {
    const split = computeTimeSplit([]);
    expect(split.empty).toBe(true);
    expect(split.partial).toBe(true);
  });

  it('is not partial once everything ended and durations are known', () => {
    const events = [
      fixtureEvents[0],
      fixtureEvents[1],
      fixtureEvents[2],
      fixtureEvents[3],
      fixtureEvents[4],
      { ...fixtureEvents[24], ts: fixtureEvents[4].ts + 1 },
    ];
    const split = computeTimeSplit(events);
    expect(split.partial).toBe(false);
    expect(split.llmSeconds).toBeCloseTo(1.8, 5);
    expect(split.otherSeconds).toBeCloseTo(5 - 1.8 - 0.042, 3);
  });
});

describe('run sentence', () => {
  function summary(partial: Partial<RunSummary> = {}): RunSummary {
    return {
      statusWord: 'Finished',
      isRunning: false,
      isInterrupted: false,
      errorCount: 0,
      hasEvents: true,
      wallSeconds: 4080,
      firstTs: 0,
      lastTs: 4080,
      modelCalls: 214,
      tokensIn: null,
      tokensOut: null,
      tokensPartial: false,
      toolCalls: 206,
      failedTools: 0,
      helperAgents: 0,
      lostEvents: 0,
      ...partial,
    };
  }

  function split(partial: Partial<TimeSplit> = {}): TimeSplit {
    return {
      llmSeconds: 0,
      toolSeconds: 0,
      waitingSeconds: 0,
      otherSeconds: null,
      summary: summary(),
      partial: false,
      empty: false,
      ...partial,
    };
  }

  it('describes a run that is still going', () => {
    const run = summary({
      statusWord: 'Running',
      isRunning: true,
      wallSeconds: 600,
      modelCalls: 3,
      toolCalls: 2,
    });
    const sentence = runSentence(run, split({ llmSeconds: 200, toolSeconds: 100, summary: run }));
    expect(sentence).toContain('No end was recorded for this run');
    expect(sentence).toContain('3 model calls and 2 tool uses');
    expect(sentence).toContain('No problems were recorded.');
    expect(sentence).not.toContain('took');
  });

  it('describes a finished run with no problems and the time split', () => {
    const run = summary();
    const sentence = runSentence(
      run,
      split({ toolSeconds: 63, waitingSeconds: 19, otherSeconds: 18, summary: run }),
    );
    expect(sentence).toContain('Recorded activity spans 1 h 8 min');
    expect(sentence).toContain('214 model calls and 206 tool uses');
    expect(sentence).toContain('No problems were recorded.');
    expect(sentence).toContain('Most of the time went to tools (63%)');
    expect(sentence).toContain('19% was waiting for you');
  });

  it('names failed tools and model errors', () => {
    const run = summary({
      statusWord: 'Finished with 2 errors',
      errorCount: 2,
      failedTools: 1,
    });
    const sentence = runSentence(run, split({ summary: run }));
    expect(sentence).toContain('1 tool failed.');
    expect(sentence).toContain('1 model error was recorded.');
    expect(sentence).not.toContain('No problems were recorded.');
  });

  it('does not claim "no problems" when a failed tool disagrees with the error counter', () => {
    // The counters can disagree (a failed tool whose error was never counted). The old code judged
    // "no problems" from errorCount alone, so this run printed both claims at once.
    const run = summary({ errorCount: 0, failedTools: 1 });
    const sentence = runSentence(run, split({ summary: run }));
    expect(sentence).toContain('1 tool failed.');
    expect(sentence).not.toContain('No problems were recorded.');
  });

  it('mentions lost events in words', () => {
    const run = summary({ lostEvents: 3 });
    const sentence = runSentence(run, split({ summary: run }));
    expect(sentence).toContain('3 recorded events were lost');
    expect(sentence).not.toContain('No problems were recorded.');
  });

  it('omits durations that were not reported', () => {
    const run = summary({ wallSeconds: null, modelCalls: 3, toolCalls: 2 });
    const sentence = runSentence(
      run,
      split({ empty: true, summary: run, otherSeconds: null }),
    );
    expect(sentence).toContain('Activity was recorded');
    expect(sentence).toContain('3 model calls and 2 tool uses');
    expect(sentence).toContain('No problems were recorded.');
    expect(sentence).not.toContain('took');
    expect(sentence).not.toContain('not reported');
    expect(sentence).not.toContain('0 model calls');
  });
});

// --- bug hunt round 3 (2026-11-09): the run bar counted only the fresh part of the input -----
describe('run summary token arithmetic', () => {
  it('counts the whole prompt, not just the fresh part, when a provider reports both', () => {
    const events = [
      ev(1, 'llm.request', { api_request_id: 'r1', attrs: { model: 'm' } }),
      ev(2, 'llm.response', {
        api_request_id: 'r1',
        attrs: { usage: { prompt_tokens: 151000, cache_read_tokens: 150500, input_tokens: 500, output_tokens: 20 } },
      }),
    ];
    expect(computeRunSummary(events).tokensIn).toBe(151000);
  });

  it('adds the cached part back when only input_tokens is reported', () => {
    const events = [
      ev(1, 'llm.request', { api_request_id: 'r1', attrs: { model: 'm' } }),
      ev(2, 'llm.response', {
        api_request_id: 'r1',
        attrs: { usage: { input_tokens: 500, cache_read_tokens: 150500, output_tokens: 20 } },
      }),
    ];
    expect(computeRunSummary(events).tokensIn).toBe(151000);
  });
});
