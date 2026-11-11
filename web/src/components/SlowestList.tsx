import type { GNode } from '../graph/reduce';
import { topSlowest } from '../graph/slowest';
import { formatDuration } from '../graph/format';

/** A short label for a slowest-list row, e.g. "terminal tool" / model name. */
function rowLabel(node: GNode): string {
  const name = node.data.label;
  if (typeof name === 'string' && name.trim() !== '') return name;
  if (node.type === 'llm') return 'model call';
  return 'tool';
}

export function SlowestList({
  nodes,
  onSelect,
}: {
  nodes: GNode[];
  onSelect: (nodeId: string) => void;
}) {
  const slowest = topSlowest({ nodes }, 5);

  if (slowest.length === 0) {
    return (
      <div className="inspector">
        <div className="rail-head">
          <span>inspector</span>
        </div>
        <div className="inspector-empty">
          Click any box on the map to see what happened there — no measured step durations in this
          view yet.
        </div>
      </div>
    );
  }

  return (
    <div className="inspector">
      <div className="rail-head">
        <span>inspector</span>
      </div>
      <div className="slowest" title="The steps that took the longest. Click one to see it on the map.">
        <div className="slowest-head">Longest steps</div>
        <ul className="slowest-list">
          {slowest.map(({ node, seconds }) => (
            <li key={node.id}>
              <button
                type="button"
                className="slowest-row"
                onClick={() => onSelect(node.id)}
                title="Select this step on the map and show its details."
              >
                <span className="slowest-label">{rowLabel(node)}</span>
                <span className="mono slowest-time">{formatDuration(seconds)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
