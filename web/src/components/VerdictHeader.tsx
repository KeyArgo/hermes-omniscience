import type { Verdict } from '../graph/verdict';
import { formatDuration } from '../graph/format';
import './VerdictHeader.css';

const levelColors: Record<Verdict['level'], string> = {
  ok: 'var(--green)',
  slow: 'var(--amber)',
  failing: 'var(--red)',
  running: 'var(--cyan)',
  empty: 'var(--muted)',
};

const levelLabels: Record<Verdict['level'], string> = {
  ok: 'OK',
  slow: 'Delays',
  failing: 'Failing',
  running: 'Running',
  empty: 'Empty',
};

export function VerdictHeader({
  verdict,
  onJump,
  onSummary,
}: {
  verdict: Verdict;
  onJump: (eventId: string) => void;
  onSummary?: () => void;
}) {
  const { level, headline, reasons, timeSplit, worstEventId } = verdict;

  const totalSeconds = timeSplit.reduce((sum, t) => sum + t.seconds, 0);

  return (
    <div className="vh-container">
      <div className="vh-left">
        <div className="vh-top-row">
          <span
            className="vh-pill"
            style={{ backgroundColor: levelColors[level], color: 'var(--panel)' }}
          >
            {levelLabels[level]}
          </span>
          <span className="vh-headline">{headline}</span>
        </div>
        {reasons.length > 0 && (
          <ul className="vh-reasons">
            {reasons.map((reason, i) => (
              <li key={i} className="vh-reason">{reason}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="vh-right">
        {timeSplit.length > 0 && (
          <div className="vh-time-bar-container">
            <div className="vh-time-bar">
              {timeSplit.map((seg, i) => {
                const pct = totalSeconds > 0 ? (seg.seconds / totalSeconds) * 100 : 0;
                const colors = ['var(--cyan)', 'var(--green)', 'var(--amber)'];
                return (
                  <div
                    key={i}
                    className="vh-time-seg"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: colors[i % colors.length],
                    }}
                    title={`${seg.label}: ${formatDuration(seg.seconds)}`}
                  />
                );
              })}
            </div>
            <div className="vh-legend">
              {timeSplit.map((seg, i) => {
                const colors = ['var(--cyan)', 'var(--green)', 'var(--amber)'];
                return (
                  <span key={i} className="vh-legend-item">
                    <span
                      className="vh-legend-dot"
                      style={{ backgroundColor: colors[i % colors.length] }}
                    />
                    {seg.label} {formatDuration(seg.seconds)}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {onSummary ? (
          <button className="vh-show-me" onClick={onSummary} title="Read the whole chat in plain words">
            summary
          </button>
        ) : worstEventId ? (
          <button
            className="vh-show-me"
            onClick={() => onJump(worstEventId!)}
          >
            show me
          </button>
        ) : null}
      </div>
    </div>
  );
}
