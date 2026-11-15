import { describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures/streams';
import { reduce } from './reduce';
import { nodeForEvent } from './selection';

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
