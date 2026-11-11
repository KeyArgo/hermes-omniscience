import { useCallback, useEffect, useState } from 'react';
import { API_BASE, askInsight, fetchInsightModels, type InsightChoice } from '../api';
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

const PICK_KEY = 'omni.insightModel';

function ago(ts: number | null): string {
  if (typeof ts !== 'number') return '';
  const age = Math.max(0, Date.now() / 1000 - ts);
  if (age < 3600) return `${Math.round(age / 60)} min ago`;
  if (age < 86400) return `${Math.round(age / 3600)} h ago`;
  return `${Math.round(age / 86400)} d ago`;
}

function splitPick(raw: string): InsightChoice | null {
  const index = raw.indexOf(':');
  if (index < 1) return null;
  return { provider: raw.slice(0, index), model: raw.slice(index + 1) };
}

/**
 * The Concerns page: what deserves attention in a period, counted.
 *
 * Two halves, deliberately separate: the counts come from the recording and are always there, and
 * the written summary is asked of the operator's own model, only when the button is pressed. A page
 * that quietly sends recordings to a provider on every visit would be the opposite of the point.
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
      const saved = window.localStorage.getItem(PICK_KEY) ?? '';
      let choice = splitPick(saved);
      if (!choice) {
        const models = await fetchInsightModels();
        const first = models.models[0];
        choice = first ? { provider: first.provider, model: first.model } : null;
      }
      if (!choice) {
        setFailed('No model is available to ask. Choose one in Settings.');
        return;
      }
      const result = await askInsight(choice, days);
      if (result.error) setFailed(result.error);
      setAnswer(result.report?.markdown ?? null);
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
          title="Ask the model chosen for Ask a model in Settings to read this period and write up what needs attention. Nothing is sent until you press this."
        >
          {busy ? 'Asking…' : 'Ask the model to summarise these'}
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
