import { describe, expect, it } from 'vitest';
import { fixtureEvents } from './fixture';
import { reduce } from './reduce';
import { makeEvent, streamOf } from '../test-fixtures/streams';

function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(-8);
}

describe('edge cases — degenerate inputs', () => {
  it('empty input yields an empty graph', () => {
    expect(reduce([])).toEqual({ nodes: [], edges: [] });
  });

  it('events with null session_id create no session nodes but still build turns/llm/tools', () => {
    const toolEv = makeEvent(3, 'tool.end', {
      session_id: null,
      turn_id: 't9',
      api_request_id: 'r9',
      tool_call_id: 'c9',
      attrs: { tool_name: 'grep' },
    });
    const evs = [
      makeEvent(1, 'turn.start', { session_id: null, turn_id: 't9' }),
      makeEvent(2, 'llm.request', { session_id: null, turn_id: 't9', api_request_id: 'r9' }),
      toolEv,
    ];
    const graph = reduce(evs);
    expect(graph.nodes.some((n) => n.type === 'session')).toBe(false);
    expect(graph.nodes.map((n) => n.id)).toEqual(['turn:t9', 'llm:r9', `tool:${toolEv.event_id}`]);
    for (const edge of graph.edges) {
      expect(graph.nodes.some((n) => n.id === edge.source)).toBe(true);
      expect(graph.nodes.some((n) => n.id === edge.target)).toBe(true);
    }
  });

  it('unknown kinds never produce typed nodes beyond the session', () => {
    const evs = [
      makeEvent(1, 'session.start'),
      makeEvent(2, 'alien.kind', { turn_id: 'tX', api_request_id: 'rX' }),
      makeEvent(3, 'omni.droppedX', { attrs: { count: 5 } }),
    ];
    const graph = reduce(evs);
    expect(graph.nodes.map((n) => n.id)).toEqual(['session:s1']);
    expect(graph.edges).toEqual([]);
  });

  it('unknown kind with null session produces nothing at all', () => {
    const graph = reduce([makeEvent(1, 'alien.kind', { session_id: null })]);
    expect(graph).toEqual({ nodes: [], edges: [] });
  });
});

describe('edge cases — attrs handling', () => {
  it('attrs as a JSON-encoded string are parsed for labels', () => {
    const ev = makeEvent(1, 'session.start', {
      attrs: JSON.stringify({ platform: 'tui', model: 'model-z' }),
    });
    const graph = reduce([ev]);
    const node = graph.nodes[0];
    expect(node.label).toBe('tui · model-z');
    expect(node.data.sublabel).toBe('s1');
  });

  it('attrs as broken JSON degrade to the id-based labels, never throw', () => {
    const ev = makeEvent(1, 'tool.end', {
      tool_call_id: 'call-broken',
      attrs: '{ not: valid json',
    });
    const graph = reduce([ev]);
    const tool = graph.nodes.find((n) => n.type === 'tool');
    expect(tool?.label).toBe('call-broken');
    expect(tool?.status).toBe('ok');
  });

  it('attrs as JSON scalar literals behave like empty attrs', () => {
    for (const raw of ['42', 'null', '"str"', 'true', '[1,2]']) {
      const ev = makeEvent(1, 'llm.response', {
        api_request_id: 'rS',
        attrs: raw,
      });
      const graph = reduce([ev]);
      const llm = graph.nodes.find((n) => n.id === 'llm:rS');
      expect(llm?.status).toBe('ok');
      expect(llm?.data.model).toBeUndefined();
      expect(llm?.data.duration_s).toBeUndefined();
    }
  });

  it('attrs as null behave like empty attrs', () => {
    const graph = reduce([
      makeEvent(1, 'subagent.start', { subagent_id: null, attrs: null }),
      makeEvent(2, 'session.start', { session_id: 's2', attrs: null }),
    ]);
    // subagent.start without any child reference is a no-op beyond the session attach.
    expect(graph.nodes.map((n) => n.id)).toEqual(['session:s1', 'session:s2']);
  });

  it('non-object numeric attrs do not crash the attribute access', () => {
    const graph = reduce([makeEvent(1, 'llm.request', { api_request_id: 'rN', attrs: 7 as never })]);
    expect(graph.nodes.some((n) => n.id === 'llm:rN')).toBe(true);
  });
});

describe('edge cases — subagents and tools', () => {
  it('subagent.start falls back to subagent_id when child_session_id is missing', () => {
    const graph = reduce([
      makeEvent(1, 'subagent.start', { subagent_id: 'sa-fall', attrs: { role: 'x' } }),
    ]);
    expect(graph.nodes.some((n) => n.id === 'session:sa-fall')).toBe(true);
  });

  it('subagent.start with no child reference at all is dropped silently', () => {
    const graph = reduce([
      makeEvent(1, 'session.start'),
      makeEvent(2, 'subagent.start', { subagent_id: null, attrs: {} }),
    ]);
    expect(graph.nodes.map((n) => n.id)).toEqual(['session:s1']);
    expect(graph.edges).toEqual([]);
  });

  it('subagent.stop creates the child node and defaults to completed', () => {
    const graph = reduce([makeEvent(1, 'subagent.stop', { attrs: null, subagent_id: 'sa-dflt' })]);
    const child = graph.nodes.find((n) => n.id === 'session:sa-dflt');
    expect(child?.status).toBe('completed');
  });

  it('duplicate event ids on the same tool dedupe attached events', () => {
    const base = makeEvent(1, 'tool.end', { tool_call_id: 'dup-1', attrs: { tool_name: 'ls' } });
    const again = { ...base, rowid: 2, attrs: { tool_name: 'ls' } };
    const graph = reduce([base, again]);
    const tool = graph.nodes.find((n) => n.id === `tool:${base.event_id}`);
    expect(tool?.eventIds).toEqual([base.event_id]);
    expect(tool?.data.events).toHaveLength(1);
  });

  it('tool errors are detected from error_type even when status says ok', () => {
    const graph = reduce([
      makeEvent(1, 'tool.end', {
        status: 'ok',
        attrs: { tool_name: 'boom', error_type: 'TimeoutError' },
      }),
    ]);
    const tool = graph.nodes.find((n) => n.type === 'tool');
    expect(tool?.status).toBe('error');
    expect(tool?.data.error_type).toBe('TimeoutError');
  });

  it('blocked tools keep the blocked status', () => {
    const graph = reduce([
      makeEvent(1, 'tool.end', { status: 'blocked', attrs: { tool_name: 'danger' } }),
    ]);
    expect(graph.nodes.find((n) => n.type === 'tool')?.status).toBe('blocked');
  });
});

describe('edge cases — ids and labels', () => {
  it('long turn ids stay in technical details while the label is reader-facing', () => {
    const graph = reduce([makeEvent(1, 'turn.start', { turn_id: 'sess:task:abcdef12' })]);
    const turn = graph.nodes.find((n) => n.id === 'turn:sess:task:abcdef12');
    expect(turn?.label).toMatch(/^Message 1 · /);
    expect(turn?.data.turn_id).toBe('sess:task:abcdef12');
  });

  it('llm events without api_request_id key the node by event_id', () => {
    const ev = makeEvent(1, 'llm.request', { api_request_id: null });
    const graph = reduce([ev]);
    const llm = graph.nodes.find((n) => n.type === 'llm');
    expect(llm?.id).toBe(`llm:${ev.event_id}`);
    expect(llm?.label).toBe(`llm ${shortId(ev.event_id)}`);
  });

  it('two boots get distinct gap nodes even with identical seq', () => {
    const graph = reduce([
      makeEvent(1, 'session.start', { boot_id: 'boot-A' }),
      makeEvent(2, 'omni.dropped', { boot_id: 'boot-A', seq: 4, attrs: { count: 3 } }),
      makeEvent(3, 'omni.dropped', { boot_id: 'boot-B', seq: 4, attrs: { count: 4 } }),
    ]);
    expect(graph.nodes.filter((n) => n.type === 'gap').map((n) => n.id)).toEqual([
      'gap:boot-A:4',
      'gap:boot-B:4',
    ]);
  });

  it('repeated omni.dropped with same boot+seq yields a single gap node', () => {
    const graph = reduce([
      makeEvent(1, 'session.start'),
      makeEvent(2, 'omni.dropped', { seq: 50, attrs: { count: 2 } }),
      makeEvent(3, 'omni.dropped', { seq: 50, attrs: { count: 2 } }),
    ]);
    const gaps = graph.nodes.filter((n) => n.type === 'gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].eventIds).toHaveLength(2);
  });

  it('omni.dropped without attrs is labelled "events lost"', () => {
    const graph = reduce([
      makeEvent(1, 'session.start'),
      makeEvent(2, 'omni.dropped', { seq: 60, attrs: null }),
    ]);
    expect(graph.nodes.find((n) => n.type === 'gap')?.label).toBe('events lost');
  });
});

describe('edge cases — session status', () => {
  it('interrupted wins over completed and status', () => {
    const graph = reduce([
      makeEvent(1, 'session.start'),
      makeEvent(2, 'session.end', {
        status: 'completed',
        attrs: { completed: true, interrupted: true },
      }),
    ]);
    expect(graph.nodes[0].status).toBe('interrupted');
  });

  it('session.end without hints lands on ok', () => {
    const graph = reduce([makeEvent(1, 'session.start')]);
    const open = graph.nodes[0];
    expect(open.status).toBe('running');
    const closed = reduce([
      makeEvent(1, 'session.start'),
      makeEvent(2, 'session.end', { attrs: {} }),
    ]).nodes[0];
    expect(closed.status).toBe('ok');
  });
});

describe('edge cases — scale', () => {
  it('a 5,000-event stream reduces deterministically in well under a second', () => {
    const events = streamOf(5000);
    expect(events).toHaveLength(5000);
    const t0 = performance.now();
    const graph = reduce(events);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(graph.nodes.length).toBeGreaterThan(100);
    expect(graph.edges.length).toBeGreaterThan(100);
    expect(reduce(events)).toEqual(graph);
  });

  it('a 5,000-event single-session stream stays under a second too', () => {
    const events = streamOf(2000).map((e, i) => ({
      ...e,
      kind: e.kind === 'omni.dropped' ? 'turn.end' : e.kind, // gap markers have no session
      session_id: 'solo',
      event_id: `solo-${i}`,
      attrs: e.kind === 'omni.dropped' ? {} : e.attrs,
    }));
    const t0 = performance.now();
    const graph = reduce(events);
    expect(performance.now() - t0).toBeLessThan(1000);
    const solo = graph.nodes.find((n) => n.id === 'session:solo');
    expect(solo?.eventIds).toHaveLength(2000);
  });

  it('full fixture prefix replay keeps references valid', () => {
    for (let k = 0; k <= fixtureEvents.length; k += 1) {
      const graph = reduce(fixtureEvents.slice(0, k));
      const ids = new Set(graph.nodes.map((n) => n.id));
      for (const edge of graph.edges) {
        expect(ids.has(edge.source)).toBe(true);
        expect(ids.has(edge.target)).toBe(true);
      }
    }
  });
});
