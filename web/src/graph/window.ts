/**
 * Windowing: a graph too large to draw legibly is cut down to its newest steps.
 *
 * React Flow renders one DOM node per graph node; a 10,000-event session produces thousands of
 * nodes and the browser's main thread stalls for seconds. Showing the last N steps keeps the map
 * readable and the UI responsive, and `truncated` lets the UI say what was left out.
 *
 * Pure: input is never mutated, and the same graph always yields the same window.
 */
import type { GEdge, GNode, Graph } from './reduce';

export const DEFAULT_WINDOW = 300;

export interface Windowed {
  graph: Graph;
  truncated: number;
}

function keeps(node: GNode): boolean {
  // gap and helper-session nodes carry context; keep them even when outside the window
  return node.type === 'gap' || node.type === 'session';
}

export function windowGraph(graph: Graph, limit = DEFAULT_WINDOW): Windowed {
  if (limit <= 0 || graph.nodes.length <= limit) {
    return { graph, truncated: 0 };
  }

  const extra = graph.nodes.filter(keeps);
  const movable = graph.nodes.filter((n) => !keeps(n));
  const room = Math.max(1, limit - extra.length);
  const newestFirst = [...movable].sort((a, b) => b.firstRowid - a.firstRowid);
  const keep = new Set(newestFirst.slice(0, room).map((n) => n.id));
  for (const n of extra) keep.add(n.id);

  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const kept = new Set(nodes.map((n) => n.id));
  const edges: GEdge[] = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target));

  return { graph: { nodes, edges }, truncated: graph.nodes.length - nodes.length };
}
