import { useEffect, useMemo, useState } from 'react';
import { fetchFailures, type FailureExplanation, type StopExplanation } from '../api';
import './FailurePanel.css';

/**
 * What actually went wrong, in the order it happened.
 *
 * The recorder keeps no error text, so an answer here can only use the structured rows: which
 * tool, which status, which error type, how long it ran against that tool's own median, how much
 * context the model call was carrying, and how many rate limits came just before. Each answer says
 * what happened, why, and what to do — and when the rows do not support a cause, it says that
 * instead of guessing.
 */
export function FailurePanel({
  root,
  failureCount,
  selectedEventId,
  onSelectEvent,
  onPrev,
  onNext,
}: {
  root: string | null;
  failureCount: number;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [rows, setRows] = useState<FailureExplanation[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [stop, setStop] = useState<StopExplanation | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!root) {
      setRows([]);
      return;
    }
    let stopped = false;
    void (async () => {
      const report = await fetchFailures(root);
      if (stopped) return;
      setRows(report.failures);
      setTruncated(report.truncated);
      setStop(report.stop);
    })();
    return () => {
      stopped = true;
    };
  }, [root, failureCount]);

  // Nothing selected means "what just went wrong": the newest failure, not the first one in the
  // run. A stopped message is explained by the failure nearest to the stop.
  const index = useMemo(() => {
    if (!rows || rows.length === 0) return -1;
    const found = rows.findIndex((row) => row.event_id === selectedEventId);
    return found >= 0 ? found : rows.length - 1;
  }, [rows, selectedEventId]);

  const current = index >= 0 ? rows?.[index] : null;
  const position = index >= 0 ? index + 1 : 0;
  const newest = index >= 0 && index === (rows?.length ?? 0) - 1;

  return (
    <section className={`failure-panel ${open ? 'is-open' : ''}`}>
      <header className="fp-head">
        <button type="button" className="fp-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="fp-caret">{open ? '▾' : '▸'}</span>
          {failureCount} failure{failureCount === 1 ? '' : 's'}
          {current ? (
            <span className="fp-what">
              {' '}· {position} of {failureCount}
              {newest ? ' (the newest)' : ''} · {current.headline.toLowerCase()}
            </span>
          ) : null}
        </button>
        <div className="fp-nav">
          <button type="button" onClick={onPrev} title="Show the failure before this one.">‹ Earlier</button>
          <button type="button" onClick={onNext} title="Show the next failure.">Later ›</button>
        </div>
      </header>

      {open ? (
        rows === null ? (
          <p className="fp-wait">Reading the recorded failures…</p>
        ) : rows.length === 0 ? (
          <p className="fp-wait">
            No failure rows in the events loaded. The window holds the newest records, so an older
            failure may be outside it.
          </p>
        ) : current ? (
          <div className="fp-body">
            {stop && stop.stopped ? (
              <div className="fp-stop">
                <h4 className="fp-title">{stop.headline}</h4>
                <ul className="fp-list">
                  {stop.why.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <ol className="fp-list fp-stop-actions">
                  {stop.actions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            <h4 className="fp-title">{current.headline}</h4>
            <p className="fp-meta">
              {current.tool ? `${current.tool} · ` : ''}
              {current.status ? `${current.status} · ` : ''}
              {current.error_type ? `${current.error_type} · ` : ''}
              {current.ts ? new Date(current.ts * 1000).toLocaleTimeString() : ''}
              {current.model ? ` · ${current.model}` : ''}
            </p>

            <div className="fp-cols">
              <div>
                <h5 className="fp-sub">Why</h5>
                <ul className="fp-list">
                  {current.why.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h5 className="fp-sub">What to do</h5>
                <ol className="fp-list">
                  {current.actions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="fp-foot">
              <button
                type="button"
                className="fp-link"
                onClick={() => current.event_id && onSelectEvent(current.event_id)}
              >
                Show this step
              </button>
              {truncated ? (
                <span className="fp-note">
                  Only the newest events were read; an earlier failure may be outside this window.
                </span>
              ) : null}
            </div>
          </div>
        ) : null
      ) : null}
    </section>
  );
}
