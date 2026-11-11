/**
 * Busy-turn collapsing: a turn with many model-call / tool children becomes one
 * summary box, so a 60-call run no longer renders as a tiny unreadable column.
 *
 * Pure like reduce()/layout(): no clock, no randomness, input never mutated.
 * Gap nodes and helper (child-session) nodes are kept as they are.
 */
import { layout, type GEdge, type GNode, type GNodeType, type GStatus, type Graph } from './reduce';

/** A turn with more than this many model-call/tool children is folded. */
export const COLLAPSE_THRESHOLD = 6;

/** Node type introduced by collapseBusyTurns. */
export const GROUP_NODE_TYPE: GNodeType = 'group';

export interface GroupCounts {
  llm: number;
  tools: number;
  failed: number;
  running: boolean;
}

export function isGroupNode(node: GNode): boolean {
  return node.type === GROUP_NODE_TYPE;
}

/** The turn id a group node was built from (`group:<turnId>` -> `<turnId>`). */
export function turnIdOfGroup(groupId: string): string {
  return groupId.startsWith('group:') ? groupId.slice('group:'.length) : groupId;
}

export function groupNodeId(turnId: string): string {
  return `group:${turnId}`;
}

function labelFor(counts: GroupCounts): string {
  const parts = [`${counts.llm} model call${counts.llm === 1 ? '' : 's'}`, `${counts.tools} tool${counts.tools === 1 ? '' : 's'}`];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(' · ');
}

function worstStatus(statuses: GStatus[]): GStatus {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('interrupted')) return 'interrupted';
  if (statuses.includes('blocked')) return 'blocked';
  return 'ok';
}

/**
 * Fold every busy turn's llm/tool children into one `group` node unless the
 * turn id is listed in expandedTurnIds. Edges are rewired to the group, deduped,
 * self-loop free; then layout() re-runs so positions are fresh.
 */
export function collapseBusyTurns(graph: Graph, expandedTurnIds?: ReadonlySet<string>): Graph {
  const folded = foldBusyTurns(graph, expandedTurnIds);
  return folded === graph ? graph : layout(folded);
}

/** collapseBusyTurns without the layout pass, so callers can fold before windowing. */
export function foldBusyTurns(graph: Graph, expandedTurnIds?: ReadonlySet<string>): Graph {
  const expanded = expandedTurnIds ?? new Set<string>();

  // turn id -> every llm/tool node reachable from it through llm/tool nodes
  // (tools hang off model calls, model calls hang off the turn)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = out.get(edge.source);
    if (list) list.push(edge.target);
    else out.set(edge.source, [edge.target]);
  }
  const childrenByTurn = new Map<string, GNode[]>();
  for (const turn of graph.nodes) {
    if (turn.type !== 'turn') continue;
    const found = new Map<string, GNode>();
    const stack = [...(out.get(turn.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      const node = byId.get(id);
      if (!node || found.has(id) || (node.type !== 'llm' && node.type !== 'tool')) continue;
      found.set(id, node);
      stack.push(...(out.get(id) ?? []));
    }
    if (found.size > 0) childrenByTurn.set(turn.id, [...found.values()]);
  }

  const folded = new Map<string, GNode[]>(); // turn id -> children being removed
  for (const [turnId, children] of childrenByTurn) {
    if (children.length > COLLAPSE_THRESHOLD && !expanded.has(turnId) && !expanded.has(turnId.replace(/^turn:/, ''))) {
      folded.set(turnId, children);
    }
  }
  if (folded.size === 0) return graph;

  const removedIds = new Set<string>();
  for (const children of folded.values()) {
    for (const child of children) removedIds.add(child.id);
  }

  const nodes: GNode[] = [];
  const groupFirstRowid = new Map<string, number>();
  for (const node of graph.nodes) {
    if (removedIds.has(node.id)) continue;
    nodes.push(node);
  }
  for (const [turnId, children] of folded) {
    const turnNode = graph.nodes.find((candidate) => candidate.id === turnId);
    const firstRowid = children.reduce(
      (min, child) => Math.min(min, child.firstRowid),
      turnNode?.firstRowid ?? Number.MAX_SAFE_INTEGER,
    );
    groupFirstRowid.set(`group:${turnId}`, firstRowid);
    const statuses = children.map((child) => child.status);
    const counts: GroupCounts = {
      llm: children.filter((child) => child.type === 'llm').length,
      tools: children.filter((child) => child.type === 'tool').length,
      failed: statuses.filter((status) => status === 'error' || status === 'failed').length,
      running: statuses.includes('running'),
    };
    const status = worstStatus(statuses);
    const label = labelFor(counts);
    const group: GNode = {
      id: `group:${turnId}`,
      type: 'group',
      label,
      status,
      firstRowid,
      eventIds: children.flatMap((child) => child.eventIds),
      data: {
        status,
        label,
        turn_id: turnId.startsWith('turn:') ? turnId.slice('turn:'.length) : turnId,
        collapsed: true,
        counts: { ...counts },
        events: [],
        children: children.map((child) => child.id),
      },
    };
    nodes.push(group);
  }

  // a removed child endpoint maps to the group of the turn that owned it
  const groupOf = new Map<string, string>();
  for (const [turnId, children] of folded) {
    for (const child of children) groupOf.set(child.id, groupNodeId(turnId));
  }
  const remap = (endpoint: string): string => groupOf.get(endpoint) ?? endpoint;

  const edges: GEdge[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const nextSource = remap(edge.source);
    const target = remap(edge.target);
    if (nextSource === target) continue; // no self-loops
    const id = `edge:${nextSource}->${target}`;
    if (seen.has(id)) continue; // no duplicates
    seen.add(id);
    edges.push({ ...edge, id, source: nextSource, target });
  }

  return { nodes, edges };
}

/** Nodes that a collapsed group stands in for — used to expand selection targets. */
export function groupMembers(graph: Graph, groupId: string): string[] {
  const group = graph.nodes.find((node) => node.id === groupId);
  const members = group?.data.children;
  return Array.isArray(members) ? members.filter((id): id is string => typeof id === 'string') : [];
}
