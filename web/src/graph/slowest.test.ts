import { describe, expect, it } from 'vitest';
import type { GNode } from './reduce';
import { nodeDurationSeconds, topSlowest } from './slowest';

function node(overrides: Partial<GNode> & { id: string }): GNode {
  return {
    type: 'tool',
    label: overrides.id,
    status: 'ok',
    firstRowid: 0,
    eventIds: [],
    data: { status: 'ok', label: overrides.id, events: [] },
    ...overrides,
  } as GNode;
}

function timed(id: string, data: Record<string, unknown>, index: number): GNode {
  return node({
    id,
    firstRowid: index,
    data: { status: 'ok', label: id, events: [], ...data },
  });
}

const plain = (id: string, index: number): GNode =>
  node({ id, firstRowid: index, data: { status: 'ok', label: id, events: [] } });

describe('topSlowest()', () => {
  const graph = {
    nodes: [
      timed('a', { duration_s: 1.5 }, 0),
      timed('b', { duration_ms: 42000 }, 1), // 42 s via ms
      plain('turn-x', 2), // wrong type
      timed('c', { duration_s: 42.1 }, 3),
      timed('d', {}, 4), // no duration -> skipped
      plain('llm-nodedur', 5), // llm without duration -> skipped
      timed('e', { duration_s: 3 }, 6),
    ],
  };

  it('orders slowest first, seconds and milliseconds alike', () => {
    const ids = topSlowest(graph).map((entry) => entry.node.id);
    expect(ids).toEqual(['c', 'b', 'e', 'a']);
    const seconds = topSlowest(graph).map((entry) => entry.seconds);
    expect(seconds).toEqual([42.1, 42, 3, 1.5]);
  });

  it('skips nodes without a measured duration instead of treating them as 0', () => {
    const entries = topSlowest(graph, 10);
    expect(entries.map((entry) => entry.node.id)).not.toContain('d');
    expect(entries.map((entry) => entry.node.id)).not.toContain('llm-nodedur');
    expect(entries.map((entry) => entry.node.id)).not.toContain('turn-x');
    // every returned entry has a positive measured duration
    for (const entry of entries) expect(entry.seconds).toBeGreaterThan(0);
    // duration-less nodes are not ranked as 0 (they would sort last, not vanish)
    expect(nodeDurationSeconds(plain('d', 0))).toBeUndefined();
  });

  it('limits results to n', () => {
    expect(topSlowest(graph, 2).map((entry) => entry.node.id)).toEqual(['c', 'b']);
    expect(topSlowest(graph, 1).map((entry) => entry.node.id)).toEqual(['c']);
    expect(topSlowest(graph, 0)).toEqual([]);
  });

  it('defaults to n = 5', () => {
    const many = {
      nodes: Array.from({ length: 8 }, (_, i) =>
        timed(`n${i}`, { duration_s: i + 1 }, i),
      ),
    };
    expect(topSlowest(many)).toHaveLength(5);
    expect(topSlowest(many).map((entry) => entry.seconds)).toEqual([8, 7, 6, 5, 4]);
  });

  it('does not mutate the input graph', () => {
    const nodes = [
      timed('a', { duration_s: 2 }, 0),
      timed('b', { duration_s: 1 }, 1),
      plain('t', 2),
    ];
    const snapshot = JSON.stringify(nodes);
    topSlowest({ nodes }, 3);
    expect(JSON.stringify(nodes)).toBe(snapshot);
  });

  it('ties keep graph order (stable)', () => {
    const tied = {
      nodes: [
        timed('first', { duration_s: 2 }, 0),
        timed('second', { duration_ms: 2000 }, 1),
        timed('third', { duration_s: 2 }, 2),
      ],
    };
    expect(topSlowest(tied, 3).map((entry) => entry.node.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('handles empty graphs and negative n', () => {
    expect(topSlowest({ nodes: [] })).toEqual([]);
    expect(topSlowest(graph, -1)).toEqual([]);
  });
});
