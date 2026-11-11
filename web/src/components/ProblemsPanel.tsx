import { useEffect, useMemo, useState } from 'react';
import { fetchFailures, type FailureExplanation } from '../api';
import { acknowledge, readAck, unseen, type Ack } from '../problems/ack';
import './ProblemsPanel.css';

// One record, not one per chat: acknowledging problems means "I have read these", and a reload
// that lands on a different chat must not resurrect what was just dismissed.
const ACK_KEY = 'omni.problemsAck';

function when(ts: number | null): string {
  if (typeof ts !== 'number') return '';
  const age = Math.max(0, Date.now() / 1000 - ts);
  if (age < 60) return `${Math.round(age)}s ago`;
  if (age < 3600) return `${Math.round(age / 60)} min ago`;
  if (age < 86400) return `${Math.round(age / 3600)} h ago`;
  return `${Math.round(age / 86400)} d ago`;
}

/**
 * Follow Problems: one button, minimised by default, that opens the issues in this chat.
 *
 * Every issue comes with what happened, why and what to do, all written from the recording — the
 * same answers the failure panel gives, in the place a reader is already looking. Acknowledging all
 * of them folds the panel and remembers them by what makes each one that problem, so the same tool
 * failing the same way does not come back; anything new does, and the newest issue stays open.
 */
export function ProblemsPanel({
  root,
  onSelectEvent,
  onAskModel,
}: {
  root: string | null;
  onSelectEvent: (eventId: string) => boolean;
  onAskModel: () => void;
}) {
  const [failures, setFailures] = useState<FailureExplanation[]>([]);
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState<Ack | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [seenCount, setSeenCount] = useState(0);

  useEffect(() => {
    setAck(readAck(window.localStorage.getItem(ACK_KEY)));
  }, [root]);

  useEffect(() => {
    let cancelled = false;
    if (!root) {
      setFailures([]);
      return;
    }
    fetchFailures(root)
      .then((report) => {
        if (!cancelled) setFailures(report.failures ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailures([]);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const fresh = useMemo(() => unseen(failures, ack), [failures, ack]);

  // A new problem is worth interrupting for; the same ones are not.
  useEffect(() => {
    if (fresh.length > seenCount && fresh.length > 0) setOpen(true);
    setSeenCount(fresh.length);
  }, [fresh.length, seenCount]);

  useEffect(() => {
    if (!expanded && fresh.length) setExpanded(fresh[0].event_id ?? null);
  }, [fresh, expanded]);

  const ackAll = () => {
    const next = acknowledge(failures, Date.now() / 1000);
    window.localStorage.setItem(ACK_KEY, JSON.stringify(next));
    setAck(next);
    setOpen(false);
  };

  if (!root) return null;

  const count = fresh.length;

  return (
    <div className={`pp-root${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`pp-pill${count ? ' has-problems' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          count
            ? `${count} problem${count === 1 ? '' : 's'} since you last acknowledged`
            : 'No new problems in this chat'
        }
      >
        <span className="pp-dot" aria-hidden="true" />
        {count ? `${count} problem${count === 1 ? '' : 's'}` : 'No new problems'}
      </button>

      {open ? (
        <div className="pp-body" role="dialog" aria-label="Problems in this chat">
          <header className="pp-head">
            <strong>Problems</strong>
            <span className="pp-sub">
              {failures.length} recorded{count ? ` · ${count} new` : ' · all acknowledged'}
            </span>
            <button type="button" className="pp-close" onClick={() => setOpen(false)} aria-label="Close problems">
              ✕
            </button>
          </header>

          {failures.length === 0 ? (
            <p className="pp-empty">Nothing failed in this chat.</p>
          ) : (
            <ul className="pp-list">
              {fresh.slice(0, 8).map((problem, index) => {
                const id = problem.event_id ?? `${index}`;
                const isOpen = expanded === id || (index === 0 && expanded === null);
                return (
                  <li key={id} className={`pp-item${isOpen ? ' is-open' : ''}`}>
                    <button
                      type="button"
                      className="pp-row"
                      aria-expanded={isOpen}
                      onClick={() => {
                        setExpanded(isOpen ? null : id);
                        if (problem.event_id) onSelectEvent(problem.event_id);
                      }}
                    >
                      <span className="pp-title">{problem.headline}</span>
                      <span className="pp-when">{when(problem.ts)}</span>
                    </button>
                    {isOpen ? (
                      <div className="pp-detail">
                        {problem.why.length ? (
                          <ul className="pp-why">
                            {problem.why.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        ) : null}
                        {problem.actions.length ? (
                          <ol className="pp-actions">
                            {problem.actions.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ol>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <footer className="pp-foot">
            <button type="button" className="pp-btn" onClick={ackAll} disabled={!failures.length}>
              Acknowledge all
            </button>
            <button
              type="button"
              className="pp-btn"
              onClick={onAskModel}
              title="Ask the model chosen in Settings to read this run and write it up. The advice under each problem is written from the recording itself."
            >
              Ask the model
            </button>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
