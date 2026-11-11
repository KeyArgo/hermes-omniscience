import { attrsOf, type GNode } from '../graph/reduce';
import { summarizeNode, type NodeSummary } from '../graph/sentences';
import { TIPS } from './tooltips';

function value(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'not reported';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function timestamp(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'not reported';
  return `${new Date(ts * 1000).toISOString()} (epoch ${ts.toFixed(3)})`;
}

const EVENT_FIELDS = [
  'rowid',
  'event_id',
  'kind',
  'ts',
  'boot_id',
  'seq',
  'session_id',
  'parent_session_id',
  'turn_id',
  'api_request_id',
  'tool_call_id',
  'subagent_id',
  'status',
] as const;

export function Inspector({ node, onClose }: { node: GNode | null; onClose?: () => void }) {
  if (!node) {
    return (
      <div className="inspector">
        <div className="rail-head">
          <span>inspector</span>
          {onClose ? (
            <button
              type="button"
              className="inspector-close"
              onClick={onClose}
              title="Close the inspector"
              aria-label="Close the inspector"
            >
              ×
            </button>
          ) : null}
        </div>
        <div className="inspector-empty">
          Click any box on the map to see, in plain words, what happened there — what it was, how
          long it took and whether it succeeded.
        </div>
      </div>
    );
  }

  const summary: NodeSummary = summarizeNode(node);
  const recordedTimes = node.data.events.map((event) => event.ts).filter((ts) => Number.isFinite(ts) && ts > 0);
  const firstObserved = recordedTimes.length ? Math.min(...recordedTimes) : null;

  return (
    <div className="inspector">
      <div className="rail-head">
        <span>inspector</span>
        <span className="rail-head-right">
          <span
            className={`status-pill status-${node.status}`}
            title={TIPS.statusBox(node.status)}
          >
            {node.status}
          </span>
          {onClose ? (
            <button
              type="button"
              className="inspector-close"
              onClick={onClose}
              title="Close the inspector"
              aria-label="Close the inspector"
            >
              ×
            </button>
          ) : null}
        </span>
      </div>
      <div className="inspector-scroll">
        <div className="inspector-title">
          <span className="inspector-kind" title={TIPS.kindBox(node.type)}>
            {whatIsThis(node)}
          </span>
        </div>

        {summary.problem ? (
          <div className="what-went-wrong">
            <div className="www-head">What went wrong</div>
            {summary.problem.lines.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        ) : null}

        <p className="inspector-sentence">{summary.headline}</p>
        <p className="inspector-capture-note">
          Omniscience records metadata for this step. The message, command, output, and error text are not included in this recording.
        </p>

        <table className="kv friendly">
          <tbody>
            <tr title="Earliest event recorded for this box; it may not be when the work started.">
              <th>First observed</th>
              <td>{firstObserved === null ? 'Not recorded' : new Date(firstObserved * 1000).toLocaleString()}</td>
            </tr>
            {summary.rows.map((row) => (
              <tr key={row.label}>
                <th>{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <details className="tech-details">
          <summary title="Raw fields, event ids and events — what the recorder stored.">
            Technical details
          </summary>
          <div className="inspector-title mono">{node.label}</div>
          <div className="mono inspector-id">{node.id}</div>

          <h3>fields</h3>
          <table className="kv">
            <tbody>
              <tr>
                <th>type</th>
                <td>{node.type}</td>
              </tr>
              <tr>
                <th>first_rowid</th>
                <td className="mono">{node.firstRowid}</td>
              </tr>
              {Object.entries(node.data)
                .filter(([key]) => key !== 'events' && key !== 'sublabel')
                .map(([key, entry]) => (
                  <tr key={key}>
                    <th>{key}</th>
                    <td className={key === 'status' ? `status-text status-${node.status}` : undefined}>
                      {value(entry)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>

          <h3>
            event ids <span className="muted">({node.eventIds.length})</span>
          </h3>
          <ul className="event-ids mono">
            {node.eventIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>

          <h3>
            events <span className="muted">({node.data.events.length})</span>
          </h3>
          {node.data.events.map((event) => (
            <article className="event-card" key={event.event_id}>
              <div className="event-card-head">
                <span className="event-kind">{event.kind}</span>
                <span className="mono muted">{event.event_id}</span>
              </div>
              <table className="kv compact">
                <tbody>
                  {EVENT_FIELDS.map((field) => (
                    <tr key={field}>
                      <th>{field}</th>
                      <td className={field === 'event_id' ? 'mono' : undefined}>
                        {field === 'ts' ? timestamp(event.ts) : value(event[field])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="attrs-label">attrs</div>
              <pre className="attrs">{JSON.stringify(attrsOf(event), null, 2)}</pre>
            </article>
          ))}
          {node.data.events.length === 0 ? (
            <div className="inspector-empty">no events attached to this node</div>
          ) : null}
        </details>
      </div>
    </div>
  );
}

function whatIsThis(node: GNode): string {
  switch (node.type) {
    case 'llm':
      return 'Model call';
    case 'tool':
      return 'Tool';
    case 'turn':
      return 'Turn';
    case 'session':
      return 'Session';
    case 'gap':
      return 'Events lost';
    default:
      return 'Step';
  }
}
