import { useState } from 'react';
import { NodeTooltip } from './tooltips';

const TYPES = [
  { kind: 'session', label: 'Session', hint: 'One conversation with the agent.' },
  { kind: 'turn', label: 'Turn', hint: 'One message from you + the agent working on it.' },
  { kind: 'llm', label: 'Model call', hint: 'The agent asking the AI model; tokens = text sent/received.' },
  { kind: 'tool', label: 'Tool', hint: 'An action like running a command or reading a file.' },
  { kind: 'group', label: 'Folded turn', hint: 'A busy turn folded into one summary box. Click to expand.' },
  { kind: 'gap', label: 'Events lost', hint: 'Steps not recorded because the recorder fell behind.' },
] as const;

const COLORS = [
  { dot: 'status-ok', word: 'OK / done' },
  { dot: 'status-running', word: 'Running' },
  { dot: 'status-error', word: 'Failed' },
  { dot: 'status-lost', word: 'Lost / warning' },
] as const;

export function Legend() {
  const [open, setOpen] = useState(true);

  return (
    <div className={`legend ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="legend-toggle"
        onClick={() => setOpen((value) => !value)}
        title={open ? 'Hide the legend' : 'Show the legend: what the boxes and colors mean'}
      >
        {open ? '▾ legend' : '▸ legend'}
      </button>
      {open ? (
        <div className="legend-items">
          {TYPES.map((item) => (
            <span key={item.kind} className="legend-item" title={item.hint}>
              <span className={`legend-kind legend-kind-${item.kind}`}>{item.label}</span>
            </span>
          ))}
          <span className="legend-sep" />
          {COLORS.map((color) => (
            <NodeTooltip key={color.dot} text={color.word}>
              <span className="legend-item">
                <span className={`legend-dot ${color.dot}`} />
              </span>
            </NodeTooltip>
          ))}
          <span className="legend-item" title="Moving blue line: the target has no recorded end; it may have stopped or its end event may be missing.">
            Moving blue line: no end recorded
          </span>
        </div>
      ) : null}
    </div>
  );
}
