import type { OmniEvent } from '../types';
import { groupMembers } from './collapse';
import type { GNode, Graph } from './reduce';

const TYPE_PRIORITY: Record<string, number> = {
  tool: 4,
  llm: 3,
  gap: 2,
  turn: 1,
  bundle: 0,
  session: -1,
};

/**
 * The node that most specifically owns an event. Session and turn nodes deliberately aggregate
 * their descendants' event ids, so a plain `.find()` returns the session. The smallest event set
 * wins; type priority breaks ties.
 */
export function nodeForEvent(nodes: readonly GNode[], eventId: string): GNode | null {
  let best: GNode | null = null;
  for (const node of nodes) {
    if (!node.eventIds.includes(eventId)) continue;
    if (!best || node.eventIds.length < best.eventIds.length) {
      best = node;
      continue;
    }
    if (node.eventIds.length === best.eventIds.length) {
      const next = TYPE_PRIORITY[node.type] ?? 0;
      const current = TYPE_PRIORITY[best.type] ?? 0;
      if (next > current) best = node;
    }
  }
  return best;
}

export function privacyStepTarget(
  eventId: string, events: OmniEvent[], fullGraph: Graph, baseGraph: Graph, graph: Graph,
  replaying = false,
): { node: string } | { turn: string } | { reason: string } {
  const node = nodeForEvent(fullGraph.nodes, eventId);
  if (!node) {
    if (!events.some((step) => step.event_id === eventId)) {
      return { reason: 'This step is outside the loaded page of this chat.' };
    }
    return { reason: replaying ? 'This step is outside the current replay. Return to Live to see it.'
      : 'The map has no node for this recorded step.' };
  }
  const group = baseGraph.nodes.find((item) =>
    item.type === 'group' && groupMembers(baseGraph, item.id).includes(node.id));
  if (typeof group?.data.turn_id === 'string') return { turn: group.data.turn_id };
  if (!baseGraph.nodes.some((shown) => shown.id === node.id)) {
    return { reason: 'This step is outside the current map window.' };
  }
  if (!graph.nodes.some((shown) => shown.id === node.id)) {
    return { reason: 'The current map filters hide this step.' };
  }
  return { node: node.id };
}
