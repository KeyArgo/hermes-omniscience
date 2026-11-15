import type { GNode } from './reduce';

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
