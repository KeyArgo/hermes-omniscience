import { describe, expect, test } from 'vitest';
import { windowGraph, DEFAULT_WINDOW } from './window';
import type { GNode, Graph } from './reduce';

function node(id: string, rowid: number, type: GNode['type'] = 'tool'): GNode {
  return {
    id,
    type,
    label: id,
    status: 'ok',
    firstRowid: rowid,
    eventIds: [`e${rowid}`],
    data: { status: 'ok', label: id, events: [] },
  };
}

function graph(count: number, extras: GNode[] = []): Graph {
  const nodes = [...extras, ...Array.from({ length: count }, (_, i) => node(`n${i}`, i + 10))];
  const edges = nodes.slice(1).map((n, i) => ({
    id: `e${i}`,
    source: nodes[i].id,
    target: n.id,
    kind: 'llm-tool' as const,
    animated: false,
    dashed: false,
    firstRowid: n.firstRowid,
  }));
  return { nodes, edges };
}

describe('windowGraph', () => {
  test('a small graph is returned untouched', () => {
    const g = graph(20);
    const out = windowGraph(g, 300);
    expect(out.truncated).toBe(0);
    expect(out.graph).toBe(g);
  });

  test('a huge graph is cut to the limit and reports what it hid', () => {
    const g = graph(4000);
    const out = windowGraph(g, 300);
    expect(out.graph.nodes.length).toBeLessThanOrEqual(300);
    expect(out.truncated).toBe(4000 - out.graph.nodes.length);
  });

  test('the window keeps the newest steps, not the oldest', () => {
    const g = graph(1000);
    const out = windowGraph(g, 100);
    const kept = new Set(out.graph.nodes.map((n) => n.id));
    expect(kept.has('n999')).toBe(true);
    expect(kept.has('n0')).toBe(false);
  });

  test('gap and session nodes survive the cut', () => {
    const g = graph(1000, [node('gap@1', 1, 'gap'), node('session', 2, 'session')]);
    const out = windowGraph(g, 50);
    const kept = new Set(out.graph.nodes.map((n) => n.id));
    expect(kept.has('gap@1')).toBe(true);
    expect(kept.has('session')).toBe(true);
  });

  test('edges are dropped when an endpoint is dropped', () => {
    const g = graph(1000);
    const out = windowGraph(g, 50);
    const ids = new Set(out.graph.nodes.map((n) => n.id));
    expect(out.graph.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  test('default window is used when no limit is given', () => {
    const out = windowGraph(graph(DEFAULT_WINDOW + 50));
    expect(out.graph.nodes.length).toBeLessThanOrEqual(DEFAULT_WINDOW);
  });
});
