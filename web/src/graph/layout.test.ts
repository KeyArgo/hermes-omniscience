import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fixtureEvents } from './fixture';
import { layout, NODE_SIZE, reduce } from './reduce';
import { eventStreamsSmall, makeEvent } from '../test-fixtures/streams';

function finitePositions(nodeIds: number): void {
  expect(nodeIds).toBeGreaterThan(0);
}

describe('layout — determinism', () => {
  it('layout of the same graph twice is deep-equal', () => {
    const graph = reduce(fixtureEvents);
    expect(layout(graph)).toEqual(layout(graph));
  });

  it('layout of a re-reduced stream is deep-equal (replay reproducibility)', () => {
    const a = layout(reduce(fixtureEvents));
    const b = layout(reduce([...fixtureEvents].reverse()));
    expect(a).toEqual(b);
  });

  it('random streams always lay out identically for the same input', () => {
    fc.assert(
      fc.property(eventStreamsSmall, (evs) => {
        expect(layout(reduce(evs))).toEqual(layout(reduce(evs)));
      }),
      { seed: 24680, numRuns: 40 },
    );
  });
});

describe('layout — position validity', () => {
  it('no NaN or Infinity anywhere in the fixture layout', () => {
    const laid = layout(reduce(fixtureEvents));
    finitePositions(laid.nodes.length);
    for (const node of laid.nodes) {
      expect(node.position, `node ${node.id} unpositioned`).toBeDefined();
      expect(Number.isFinite(node.position!.x)).toBe(true);
      expect(Number.isFinite(node.position!.y)).toBe(true);
      expect(Number.isNaN(node.position!.x)).toBe(false);
      expect(Number.isNaN(node.position!.y)).toBe(false);
    }
  });

  it('random streams never produce NaN positions', () => {
    fc.assert(
      fc.property(eventStreamsSmall, (evs) => {
        const laid = layout(reduce(evs));
        for (const node of laid.nodes) {
          expect(node.position).toBeDefined();
          expect(Number.isFinite(node.position!.x)).toBe(true);
          expect(Number.isFinite(node.position!.y)).toBe(true);
        }
      }),
      { seed: 555, numRuns: 50 },
    );
  });

  it('every node type present in streams has a known size', () => {
    fc.assert(
      fc.property(eventStreamsSmall, (evs) => {
        for (const node of reduce(evs).nodes) {
          expect(NODE_SIZE[node.type]).toBeDefined();
        }
      }),
      { seed: 99, numRuns: 50 },
    );
  });

  it('isolated nodes (sessions without edges, gaps without anchors) still get positions', () => {
    const graph = reduce([
      makeEvent(1, 'omni.dropped', { session_id: null, seq: 77, attrs: { count: 1 } }),
      makeEvent(2, 'session.start', { session_id: 'lonely-1' }),
      makeEvent(3, 'session.start', { session_id: 'lonely-2' }),
    ]);
    const laid = layout(graph);
    const ids = new Set(laid.nodes.map((n) => n.id));
    expect(ids.has('session:lonely-1')).toBe(true);
    expect(ids.has('session:lonely-2')).toBe(true);
    expect(ids.has('gap:boot-1:77')).toBe(true);
    for (const node of laid.nodes) {
      expect(Number.isFinite(node.position!.x)).toBe(true);
      expect(Number.isFinite(node.position!.y)).toBe(true);
    }
  });

  it('empty graph lays out to empty', () => {
    expect(layout({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });
});

describe('layout — layering and purity', () => {
  it('left-to-right: sources sit strictly left of targets on the fixture', () => {
    const laid = layout(reduce(fixtureEvents));
    const byId = new Map(laid.nodes.map((n) => [n.id, n]));
    for (const edge of laid.edges) {
      const s = byId.get(edge.source)!;
      const t = byId.get(edge.target)!;
      expect(s.position!.x).toBeLessThan(t.position!.x);
    }
  });

  it('layout does not mutate the input graph', () => {
    const graph = reduce(fixtureEvents);
    const before = JSON.stringify(graph);
    const laid = layout(graph);
    expect(JSON.stringify(graph)).toBe(before);
    expect(graph.nodes.every((n) => n.position === undefined)).toBe(true);
    expect(laid.edges).toEqual(graph.edges);
    expect(laid.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
  });

  it('layout preserves node payloads and only adds positions', () => {
    const graph = reduce(fixtureEvents);
    const laid = layout(graph);
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const stripped = { ...laid.nodes[i] };
      delete stripped.position;
      expect(stripped).toEqual(graph.nodes[i]);
    }
  });
});
