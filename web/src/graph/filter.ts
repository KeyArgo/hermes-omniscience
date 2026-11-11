import type { GEdge, GNode, Graph } from './reduce';

const isFailure = (node: GNode): boolean => node.status === 'error' || node.status === 'failed';

/**
 * Filters run on the unfolded graph (before busy turns are folded), so hidden kinds really leave
 * the map. Removing a node links its parents straight to its children, so hiding model calls still
 * shows which turn each tool belongs to. "Errors only" keeps failures, lost-event markers and the
 * path that leads to them (session, turn, model call), so a failure is never shown out of context.
 */
export function filterGraph(
  graph: Graph,
  hideTools: boolean,
  hideLlms: boolean,
  errorsOnly: boolean,
): Graph {
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = parents.get(edge.target);
    if (list) list.push(edge.source);
    else parents.set(edge.target, [edge.source]);
  }

  let onPath: Set<string> | null = null;
  if (errorsOnly) {
    onPath = new Set();
    const stack = graph.nodes.filter((node) => isFailure(node) || node.type === 'gap').map((node) => node.id);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (onPath.has(id)) continue;
      onPath.add(id);
      stack.push(...(parents.get(id) ?? []));
    }
  }

  const hidden = (node: GNode): boolean => {
    if (onPath && !onPath.has(node.id)) return true;
    // A failed step stays visible under "errors only" even when its kind is hidden.
    if (errorsOnly && isFailure(node)) return false;
    return (hideTools && node.type === 'tool') || (hideLlms && node.type === 'llm');
  };
  const nodes = graph.nodes.filter((node) => !hidden(node));
  const kept = new Set(nodes.map((node) => node.id));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  // Nearest kept ancestors of a node, walking up through removed ones.
  const keptAncestors = (id: string, seen = new Set<string>()): string[] => {
    const out: string[] = [];
    for (const parent of parents.get(id) ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (kept.has(parent)) out.push(parent);
      else if (byId.has(parent)) out.push(...keptAncestors(parent, seen));
    }
    return out;
  };

  const edges: GEdge[] = [];
  const seenIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!kept.has(edge.target)) continue;
    if (kept.has(edge.source)) {
      if (!seenIds.has(edge.id)) {
        seenIds.add(edge.id);
        edges.push(edge);
      }
      continue;
    }
    for (const source of keptAncestors(edge.source)) {
      const id = `bridge:${source}->${edge.target}`;
      if (seenIds.has(id) || source === edge.target) continue;
      seenIds.add(id);
      edges.push({ ...edge, id, source });
    }
  }
  return { nodes, edges };
}
