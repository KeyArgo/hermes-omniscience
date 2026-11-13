import { useCallback, useEffect, useState } from 'react';
import { API_BASE, fetchInsight } from '../api';
import { tokenHeaders } from '../token';
import './ConcernsView.css';

interface ConcernItem {
  kind: 'privacy' | 'failure';
  cls: string | null;
  label: string;
  tone: string;
  count: number;
  sessions: number;
  first_ts: number | null;
  last_ts: number | null;
  tool?: string | null;
  tools?: string[];
  error_type?: string | null;
}

interface ConcernsReport {
  days: number;
  items: ConcernItem[];
  counts: { privacy: number; failures: number };
}

const PERIODS: { value: number; label: string }[] = [
  { value: 1 / 24, label: 'Past hour' },
  { value: 1, label: 'Past 24 hours' },
  { value: 30, label: 'Past month' },
];

function ago(ts: number | null): string {
  if (typeof ts !== 'number') return '';
  const age = Math.max(0, Date.now() / 1000 - ts);
  if (age < 3600) return `${Math.round(age / 60)} min ago`;
  if (age < 86400) return `${Math.round(age / 3600)} h ago`;
  return `${Math.round(age / 86400)} d ago`;
}

/**
 * The Concerns page: what deserves attention in a period, counted.
 *
 * Two halves, deliberately separate: the counts come from the recording and are always there, and
 * the written summary is the one Hermes already wrote (`/omni insight`), read back from beside the
 * recording. The viewer holds no key, so a page visit can never send anything to a provider.
 */
export function ConcernsView() {
  const [days, setDays] = useState(1);
  const [report, setReport] = useState<ConcernsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async (window: number) => {
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/concerns?days=${window}`, { headers: { ...tokenHeaders() } });
      if (!response.ok) throw new Error(`the viewer answered ${response.status}`);
      setReport((await response.json()) as ConcernsReport);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'could not read the recording');
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const ask = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const state = await fetchInsight();
      if (!state.report) {
        setAnswer(null);
        setFailed(state.hint || 'No writeup yet. Run /omni insight in Hermes, then try again.');
        return;
      }
      setAnswer(state.report.markdown);
    } finally {
      setBusy(false);
    }
  };

  const items = report?.items ?? [];

  return (
    <div className="cv-root">
      <header className="cv-head">
        <h2>Concerns</h2>
        <p className="cv-sub">
          Grouped, not listed: what called a browser or this desktop, what swept many files, what reached
          the network or an MCP server, and what failed — with how often and in how many chats. The Privacy
          page has the individual rows.
        </p>
        <div className="cv-periods" role="group" aria-label="Period">
          {PERIODS.map((period) => (
            <button
              key={period.label}
              type="button"
              className={`cv-period${days === period.value ? ' is-on' : ''}`}
              aria-pressed={days === period.value}
              onClick={() => setDays(period.value)}
            >
              {period.label}
            </button>
          ))}
        </div>
        <p className="cv-counts">
          {report ? `${report.counts.privacy} privacy calls · ${report.counts.failures} failures` : 'reading…'}
        </p>
      </header>

      {error ? <p className="cv-error">Could not read the recording: {error}</p> : null}

      <section className="cv-ai">
        <button
          type="button"
          className="cv-ask"
          onClick={() => void ask()}
          disabled={busy}
          title="Show the writeup Hermes saved for this recording. The model call happens inside Hermes (/omni insight); the viewer never reaches a provider."
        >
          {busy ? 'Reading…' : 'Show the latest writeup'}
        </button>
        {failed ? <p className="cv-error">{failed}</p> : null}
        {answer ? <div className="cv-answer">{answer}</div> : null}
      </section>

      {items.length === 0 && !error && report ? (
        <p className="cv-empty">Nothing concerning in this period.</p>
      ) : (
        <ul className="cv-list">
          {items.map((item) => (
            <li key={`${item.kind}-${item.cls}-${item.label}`} className={`cv-item is-${item.tone}`}>
              <div className="cv-item-main">
                <span className="cv-label">{item.label}</span>
                <span className="cv-meta">
                  {item.count}× in {item.sessions} chat{item.sessions === 1 ? '' : 's'}
                  {item.last_ts ? ` · last ${ago(item.last_ts)}` : ''}
                </span>
              </div>
              {item.tools?.length ? <div className="cv-tools">{item.tools.join(' · ')}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
