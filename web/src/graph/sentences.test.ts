import { describe, expect, it } from 'vitest';
import { fixtureEvents } from './fixture';
import { reduce } from './reduce';
import { summarizeNode } from './sentences';

describe('inspector sentence builder', () => {
  const graph = reduce(fixtureEvents);
  const byId = (id: string) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`missing node ${id}`);
    return node;
  };

  it('describes an ok model call in one sentence', () => {
    const summary = summarizeNode(byId('llm:r1'));
    expect(summary.headline).toContain('Asked claude-sonnet-4');
    expect(summary.headline).toContain('sent 1,200 tokens in');
    expect(summary.headline).toContain('got 300 tokens back');
    expect(summary.headline).toContain('took 1.8 s');
    expect(summary.headline.endsWith('Finished OK.')).toBe(true);
    expect(summary.problem).toBeUndefined();
    const labels = summary.rows.map((row) => row.label);
    expect(labels).toEqual(['Took', 'Sent', 'Received', 'Status', 'Started at', 'Privacy']);
    expect(summary.rows.find((r) => r.label === 'Sent')?.value).toBe('1,200 tokens');
  });

  it('describes a failed model call with a "what went wrong" digest', () => {
    // fixture r2 slew an error then got a response — craft an error-only call
    const errorOnly = reduce([
      fixtureEvents[0],
      { ...fixtureEvents[7] }, // llm.request r2
      fixtureEvents[8], // llm.error
    ]);
    const node = errorOnly.nodes.find((n) => n.id === 'llm:r2');
    if (!node) throw new Error('missing node');
    const summary = summarizeNode(node);
    expect(summary.problem).toBeDefined();
    expect(summary.problem?.lines.join(' ')).toContain('RateLimitError');
    expect(summary.problem?.lines.join(' ')).toContain('status 429');
    expect(summary.problem?.lines.join(' ')).toContain('after 400 ms');
    expect(summary.headline).toContain('claude-sonnet-4');
  });

  it('says the request failed without a duration when none was reported', () => {
    const errorOnly = reduce([
      fixtureEvents[0],
      { ...fixtureEvents[7] }, // llm.request r2
      {
        ...fixtureEvents[8],
        attrs: { status_code: 429, reason: 'rate_limit', error_type: 'RateLimitError' },
      },
    ]);
    const node = errorOnly.nodes.find((n) => n.id === 'llm:r2');
    if (!node) throw new Error('missing node');
    const summary = summarizeNode(node);
    const lines = summary.problem?.lines.join(' ') ?? '';
    expect(lines).toContain('The request to claude-sonnet-4 failed.');
    expect(lines).not.toContain('0 ms');
  });

  it('shows "not reported" instead of zero for a call without usage', () => {
    // a minimal finished call that reported no usage at all
    const skeleton = fixtureEvents[0];
    const req = {
      ...fixtureEvents[7],
      rowid: 2,
      event_id: 'plain-req',
      turn_id: 't1',
      api_request_id: 'plain',
      attrs: { model: 'claude-plain' },
    };
    const resp = {
      ...fixtureEvents[9],
      rowid: 3,
      event_id: 'plain-resp',
      turn_id: 't1',
      api_request_id: 'plain',
      attrs: { duration_s: 0.5, finish_reason: 'stop' },
    };
    const plainGraph = reduce([skeleton, req, resp]);
    const node = plainGraph.nodes.find((n) => n.id === 'llm:plain');
    if (!node) throw new Error('missing node');
    const summary = summarizeNode(node);
    expect(summary.rows.find((r) => r.label === 'Sent')?.value).toBe('not reported');
    expect(summary.rows.find((r) => r.label === 'Received')?.value).toBe('not reported');
    expect(summary.headline).toContain('Usage was not reported');
  });

  it('describes a tool call', () => {
    const summary = summarizeNode(byId('tool:tool-read-1'));
    expect(summary.headline).toBe('Ran the read_file tool — took 42 ms — OK.');
    expect(summary.rows.map((r) => r.label)).toContain('Started at');
  });

  it('describes a failed tool with an error digest', () => {
    const summary = summarizeNode(byId('tool:tool-term-2'));
    expect(summary.headline).toContain('terminal tool');
    expect(summary.headline).toContain('failed');
    expect(summary.headline).toContain('timeout');
    expect(summary.problem?.lines.join(' ')).toContain('timeout');
  });

  it('describes a helper agent session', () => {
    const summary = summarizeNode(byId('session:child-1'));
    expect(summary.headline).toContain('Started a helper agent');
    expect(summary.headline).toContain('finished: completed');
    const roleRow = summary.rows.find((r) => r.label === 'Role');
    expect(roleRow?.value).toBe('researcher');
  });

  it('computes the helper "Took" fallback only from two finite timestamps', () => {
    // no subagent.stop duration, but both timestamps present -> falls back to the span
    const spanGraph = reduce([
      fixtureEvents[0],
      { ...fixtureEvents[12], rowid: 2, ts: 100, attrs: { child_session_id: 'child-span', role: 'scout' } },
      {
        ...fixtureEvents[19],
        rowid: 3,
        ts: 101,
        attrs: { child_session_id: 'child-span', child_status: 'completed' },
      },
    ]);
    const spanNode = spanGraph.nodes.find((n) => n.id === 'session:child-span');
    if (!spanNode) throw new Error('missing node');
    const spanSummary = summarizeNode(spanNode);
    expect(spanSummary.rows.find((r) => r.label === 'Took')?.value).toBe('1.0 s');

    // one timestamp missing -> never a false 0
    const missingGraph = reduce([
      fixtureEvents[0],
      { ...fixtureEvents[12], rowid: 2, attrs: { child_session_id: 'child-missing', role: 'scout' } },
      {
        ...fixtureEvents[19],
        rowid: 3,
        ts: null as unknown as number,
        attrs: { child_session_id: 'child-missing', child_status: 'completed' },
      },
    ]);
    const missingNode = missingGraph.nodes.find((n) => n.id === 'session:child-missing');
    if (!missingNode) throw new Error('missing node');
    const missingSummary = summarizeNode(missingNode);
    expect(missingSummary.rows.find((r) => r.label === 'Took')?.value).toBe('not reported');
  });

  it('shows "not reported" for a single-event helper instead of a false 0', () => {
    const singleGraph = reduce([
      fixtureEvents[0],
      { ...fixtureEvents[12], rowid: 2, ts: 500, attrs: { child_session_id: 'child-single', role: 'scout' } },
    ]);
    const singleNode = singleGraph.nodes.find((n) => n.id === 'session:child-single');
    if (!singleNode) throw new Error('missing node');
    const singleSummary = summarizeNode(singleNode);
    expect(singleSummary.rows.find((r) => r.label === 'Took')?.value).toBe('not reported');
  });

  it('describes the root session in plain words', () => {
    const summary = summarizeNode(byId('session:root-1'));
    expect(summary.headline).toContain('conversation with your Hermes agent');
    expect(summary.headline).toContain('claude-sonnet-4');
  });

  it('describes a lost-steps node', () => {
    const dropped = reduce([fixtureEvents[0], ...fixtureEvents.slice(1).slice(0, 1), {
      ...fixtureEvents[0],
      rowid: 3,
      seq: 9,
      event_id: 'drop-marker',
      kind: 'omni.dropped',
      attrs: { count: 3, since_seq: 5 },
    }]);
    const gap = dropped.nodes.find((n) => n.type === 'gap');
    if (!gap) throw new Error('missing gap');
    const summary = summarizeNode(gap);
    expect(summary.headline).toContain('not recorded');
    expect(summary.rows.find((r) => r.label === 'Steps not recorded')?.value).toBe('3');
  });

  it('says plainly what a tool node did not record', () => {
    const summary = summarizeNode(byId('tool:tool-read-1'));
    expect(summary.rows.map((r) => r.value)).toContain(
      "Recorded: the tool's name, timing, result status and error type. Not recorded: the command, its arguments or its output (kept private).",
    );
  });

  it('says plainly what a model call node did not record', () => {
    const summary = summarizeNode(byId('llm:r1'));
    expect(summary.rows.map((r) => r.value)).toContain(
      'Recorded: model, timing and token counts. Not recorded: the prompt or the answer text (kept private).',
    );
  });

  it('says a turn whose finish was not recorded ended with the run', () => {
    const turn = byId('turn:t4');
    expect(turn.status).toBe('unknown');
    const summary = summarizeNode(turn);
    expect(summary.headline).toContain(
      "This message's finish wasn't recorded; the run ended afterwards.",
    );
  });

  it('does not add that note to a turn that recorded its finish', () => {
    const summary = summarizeNode(byId('turn:t1'));
    expect(summary.headline).not.toContain("finish wasn't recorded");
  });

  it('says plainly what a turn node did not record', () => {
    const summary = summarizeNode(byId('turn:t1'));
    expect(summary.rows.map((r) => r.value)).toContain(
      "Your message and the agent's reply are not recorded; only timing and counts are.",
    );
  });
});
