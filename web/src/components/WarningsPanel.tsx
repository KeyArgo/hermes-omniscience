import type { GNode } from '../graph/reduce';
import type { Warning } from '../types';

interface WarningsPanelProps {
  warnings: Warning[];
  nodes: GNode[];
  onSelectNode: (id: string) => void;
}

export function groupWarnings(warnings: Warning[]): Warning[][] {
  const groups = new Map<string, Warning[]>();
  for (const warning of warnings) {
    const key = JSON.stringify([warning.title, warning.what_happened, warning.what_it_means, warning.severity, warning.session_id]);
    const group = groups.get(key);
    if (group) group.push(warning);
    else groups.set(key, [warning]);
  }
  return [...groups.values()];
}

export function WarningsPanel({ warnings, nodes, onSelectNode }: WarningsPanelProps) {
  if (warnings.length === 0) return null;

  const jumpTo = (warning: Warning) => {
    const wanted = new Set(warning.event_ids);
    if (wanted.size === 0) return;
    const node = nodes.find((candidate) => candidate.eventIds.some((id) => wanted.has(id)));
    if (node) onSelectNode(node.id);
  };
  const hasVisibleNode = (warning: Warning) => {
    const wanted = new Set(warning.event_ids);
    return nodes.some((candidate) => candidate.eventIds.some((id) => wanted.has(id)));
  };

  return (
    <section className="warnings" aria-label="Things worth a look">
      <h2 className="warnings-title">Things worth a look</h2>
      <p className="warnings-sub">
        Patterns found in up to the latest 2,000 recorded events. Select an available warning to
        highlight it on the map. Older activity may not be included.
      </p>
      <ul className="warnings-list">
        {groupWarnings(warnings).map((group, index) => {
          const warning = group[0];
          return (
          <li key={`${warning.title}-${index}`}>
            <button
              type="button"
              className="warning-item"
              onClick={() => jumpTo(warning)}
              disabled={!hasVisibleNode(warning)}
              title={hasVisibleNode(warning) ? 'Show the first map box these events belong to.' : 'No linked event is visible in the current graph.'}
            >
              <span className={`warning-severity severity-${warning.severity}`}>
                {warning.severity}
              </span>
              <span className="warning-body">
                <strong className="warning-title">{warning.title}</strong>
                {group.length > 1 ? <span>{group.length} matching warnings</span> : null}
                <span className="warning-happened">{warning.what_happened}</span>
                <span className="warning-meaning">{warning.what_it_means}</span>
                {warning.what_to_do ? (
                  <span className="warning-todo">
                    <b>What to do:</b> {warning.what_to_do}
                  </span>
                ) : null}
              </span>
            </button>
            {group.length > 1 ? (
              <details className="warning-occurrences">
                <summary>Show each occurrence</summary>
                {group.map((occurrence, occurrenceIndex) => (
                  <button type="button" key={occurrenceIndex} onClick={() => jumpTo(occurrence)} disabled={!hasVisibleNode(occurrence)} title={hasVisibleNode(occurrence) ? 'Show on graph' : 'No linked event is visible in the current graph.'}>
                    Occurrence {occurrenceIndex + 1}{occurrence.event_ids.length ? ` · ${occurrence.event_ids.length} linked event${occurrence.event_ids.length === 1 ? '' : 's'}` : ' · no linked events'}
                  </button>
                ))}
              </details>
            ) : null}
          </li>
        ); })}
      </ul>
    </section>
  );
}
