/**
 * "Slowest steps" — navigation to the steps that took the longest.
 *
 * Pure and deterministic, same contract as summary.ts: no clock, no
 * randomness. Only nodes of type llm or tool with a *measured* duration
 * (duration_s or duration_ms) qualify; nodes without one are skipped, never
 * treated as 0. Durations are normalized to seconds; ties keep graph order.
 */
import type { GNode } from './reduce';

export interface SlowestEntry {
  node: GNode;
  /** Measured duration in seconds. */
  seconds: number;
}

/** duration in seconds, or undefined when the node has none. */
export function nodeDurationSeconds(node: GNode): number | undefined {
  if (node.type !== 'llm' && node.type !== 'tool') return undefined;
  const durationS = node.data.duration_s;
  if (typeof durationS === 'number' && Number.isFinite(durationS)) return durationS;
  const durationMs = node.data.duration_ms;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) return durationMs / 1000;
  return undefined;
}

/**
 * The n slowest llm/tool nodes with a measured duration, slowest first.
 * Stable: equal durations keep the input's node order. The input graph is
 * not mutated.
 */
export function topSlowest(graph: { nodes: GNode[] }, n = 5): SlowestEntry[] {
  const entries: SlowestEntry[] = [];
    for (const node of graph.nodes) {
    const seconds = nodeDurationSeconds(node);
    if (seconds === undefined) continue;
    entries.push({ node, seconds });
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.seconds - a.entry.seconds || a.index - b.index)
    .slice(0, Math.max(0, n))
    .map(({ entry }) => entry);
}
