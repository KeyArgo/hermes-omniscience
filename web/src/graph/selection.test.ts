import { describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures/streams';
import { reduce } from './reduce';
import { foldBusyTurns } from './collapse';
import { filterGraph } from './filter';
import { windowGraph } from './window';
import { nodeForEvent, privacyStepTarget } from './selection';

describe('nodeForEvent', () => {
  it('returns the most specific node, not the session that aggregates it', () => {
    const events = [
      makeEvent(1, 'session.start'),
      makeEvent(2, 'turn.start', { turn_id: 't1' }),
      makeEvent(3, 'llm.request', { turn_id: 't1', api_request_id: 'r1' }),
      makeEvent(4, 'tool.end', {
        turn_id: 't1',
        api_request_id: 'r1',
        tool_call_id: 'c1',
        event_id: 'evt-tool',
        attrs: { tool_name: 'grep', duration_ms: 10 },
      }),
    ];
    const graph = reduce(events);
    const node = nodeForEvent(graph.nodes, 'evt-tool');
    expect(node?.type).toBe('tool');
    expect(node?.id).toBe('tool:evt-tool');
  });

  it('returns the session when the event is the session start', () => {
    const graph = reduce([makeEvent(1, 'session.start')]);
    const node = nodeForEvent(graph.nodes, graph.nodes[0].eventIds[0]);
    expect(node?.type).toBe('session');
  });

  it('returns null for an event that is not in the graph', () => {
    const graph = reduce([makeEvent(1, 'session.start')]);
    expect(nodeForEvent(graph.nodes, 'missing')).toBeNull();
  });
});

describe('opening a Privacy step', () => {
  const events = [
    makeEvent(1, 'turn.start', { turn_id: 'busy' }),
    ...Array.from({ length: 10 }, (_, i) => makeEvent(i + 2, 'tool.end', {
      turn_id: 'busy', event_id: `step-${i}`,
    })),
  ];
  const fullGraph = reduce(events);
  const folded = foldBusyTurns(fullGraph);
  const empty = reduce([]);

  it('opens the owning turn and selects the exact tool after expansion', () => {
    expect(privacyStepTarget('step-0', events, fullGraph, folded, folded)).toEqual({ turn: 'busy' });
    expect(privacyStepTarget('step-0', events, fullGraph, fullGraph, fullGraph)).toEqual({ node: 'tool:step-0' });
  });

  it('explains where an unavailable step stopped being visible', () => {
    const small = windowGraph(fullGraph, 2).graph;
    const filtered = filterGraph(fullGraph, true, false, false);
    expect(privacyStepTarget('older', events, fullGraph, fullGraph, fullGraph)).toEqual({ reason: expect.stringContaining('loaded page') });
    expect(privacyStepTarget('step-0', events, empty, empty, empty, true)).toEqual({ reason: expect.stringContaining('replay') });
    expect(privacyStepTarget('step-0', events, fullGraph, small, small)).toEqual({ reason: expect.stringContaining('map window') });
    expect(privacyStepTarget('step-0', events, fullGraph, fullGraph, filtered)).toEqual({ reason: expect.stringContaining('filters') });
  });
});
