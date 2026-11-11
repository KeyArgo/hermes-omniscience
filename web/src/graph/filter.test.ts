import { describe, expect, it } from 'vitest';
import { filterGraph } from './filter';
import type { GEdge, GEdgeType, GNode, GNodeType, GStatus, Graph } from './reduce';

function node(id: string, type: GNodeType, status: GStatus = 'ok'): GNode {
  return {
    id,
    type,
    label: id,
    status,
    firstRowid: 0,
    eventIds: [`${id}-ev`],
    data: { status, label: id, events: [] },
  };
}

function edge(id: string, source: string, target: string, kind: GEdgeType): GEdge {
  return { id, source, target, kind, animated: false, dashed: false, firstRowid: 0 };
}

function sampleGraph(): Graph {
  return {
    nodes: [
      node('session:s1', 'session'),
      node('turn:t1', 'turn'),
      node('llm:l1', 'llm'),
      node('llm:l2', 'llm', 'error'),
      node('tool:tc1', 'tool'),
      node('tool:tc2', 'tool', 'error'),
      node('gap:g1', 'gap', 'unknown'),
    ],
    edges: [
      edge('e1', 'session:s1', 'turn:t1', 'session-turn'),
      edge('e2', 'turn:t1', 'llm:l1', 'turn-llm'),
      edge('e3', 'llm:l1', 'tool:tc1', 'llm-tool'),
      edge('e4', 'llm:l1', 'tool:tc2', 'llm-tool'),
      edge('e5', 'turn:t1', 'gap:g1', 'gap'),
    ],
  };
}

function ids(graph: Graph): string[] {
  return graph.nodes.map((n) => n.id);
}

describe('filterGraph — hideTools', () => {
  it('removes tool nodes and edges touching them', () => {
    const out = filterGraph(sampleGraph(), true, false, false);
    expect(ids(out)).not.toContain('tool:tc1');
    expect(ids(out)).not.toContain('tool:tc2');
    expect(ids(out)).toContain('llm:l1');
    expect(out.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e5']);
  });

  it('keeps tool nodes when disabled', () => {
    const out = filterGraph(sampleGraph(), false, false, false);
    expect(ids(out)).toContain('tool:tc1');
    expect(ids(out)).toContain('tool:tc2');
    expect(out.edges).toHaveLength(5);
  });
});

describe('filterGraph — hideLlms', () => {
  it('removes llm nodes (and their dangling edges)', () => {
    const out = filterGraph(sampleGraph(), false, true, false);
    expect(ids(out)).not.toContain('llm:l1');
    expect(ids(out)).not.toContain('llm:l2');
    expect(ids(out)).toContain('tool:tc1');
    // tools are re-linked to the turn their model call belonged to
    expect(out.edges.map((e) => e.id)).toEqual(['e1', 'bridge:turn:t1->tool:tc1', 'bridge:turn:t1->tool:tc2', 'e5']);
  });
});

describe('filterGraph — errorsOnly', () => {
  it('keeps failures, gaps and the path that leads to them', () => {
    const out = filterGraph(sampleGraph(), false, false, true);
    expect(ids(out).sort()).toEqual(['gap:g1', 'llm:l1', 'llm:l2', 'session:s1', 'tool:tc2', 'turn:t1']);
    expect(out.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e4', 'e5']);
  });

  it('keeps a failed tool visible even when tools are hidden', () => {
    const out = filterGraph(sampleGraph(), true, false, true);
    expect(ids(out)).toContain('tool:tc2');
    expect(ids(out)).not.toContain('tool:tc1');
  });

  it('keeps an error-to-gap edge when both ends survive', () => {
    const graph: Graph = {
      nodes: [node('llm:l1', 'llm', 'error'), node('gap:g1', 'gap', 'unknown')],
      edges: [edge('e1', 'llm:l1', 'gap:g1', 'gap')],
    };
    const out = filterGraph(graph, false, false, true);
    expect(out.edges.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('filterGraph — edge integrity', () => {
  it('every result edge has both ends among result nodes', () => {
    const graph = sampleGraph();
    for (const [hideTools, hideLlms, errorsOnly] of [
      [false, false, false],
      [true, false, false],
      [false, true, false],
      [true, true, false],
      [false, false, true],
      [true, true, true],
    ] as const) {
      const out = filterGraph(graph, hideTools, hideLlms, errorsOnly);
      const kept = new Set(ids(out));
      for (const e of out.edges) {
        expect(kept.has(e.source), `${e.id} source ${e.source}`).toBe(true);
        expect(kept.has(e.target), `${e.id} target ${e.target}`).toBe(true);
      }
    }
  });
});

describe('filterGraph — purity', () => {
  it('does not mutate the input graph', () => {
    const graph = sampleGraph();
    const before = structuredClone(graph);
    filterGraph(graph, true, true, false);
    filterGraph(graph, false, false, true);
    filterGraph(graph, false, false, false);
    expect(graph).toEqual(before);
  });
});
