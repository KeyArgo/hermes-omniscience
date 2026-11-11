import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';
import { tokenHeaders } from '../token';
import './PrivacyView.css';

export interface PrivacyRun {
  event_id: string;
  ts: number;
  tool: string;
  cls: string;
  label: string;
  tone: 'high' | 'low';
  session_id: string | null;
  chat_title?: string | null;
  turn_id: string | null;
  status: string | null;
  duration_ms: number | null;
}

export interface PrivacyFlag {
  file: string;
  flagged_at: number | null;
  flagged_at_local: string | null;
  session_id: string | null;
  event_id: string | null;
  tool: string | null;
  note: string;
}

const PERIODS: { value: number; label: string }[] = [
  { value: 1 / 24, label: 'Last hour' },
  { value: 1, label: '24 hours' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 0, label: 'All' },
];

function ago(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

/**
 * The permanent record of every privacy-relevant tool run — the live strip is only its newest
 * item. This is also where a wide file sweep or a network call can be flagged on its own, without
 * waiting for an alert to be on screen.
 */
export function PrivacyView({ onOpenChat }: { onOpenChat: (sessionId: string) => void }) {
  const [days, setDays] = useState(1);
  const [runs, setRuns] = useState<PrivacyRun[]>([]);
  const [flags, setFlags] = useState<PrivacyFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (window: number) => {
    setError(null);
    try {
      const [runsResponse, flagsResponse] = await Promise.all([
        fetch(`${API_BASE}/privacy?days=${window}`, { headers: { ...tokenHeaders() } }),
        fetch(`${API_BASE}/privacy/flags`, { headers: { ...tokenHeaders() } }),
      ]);
      if (!runsResponse.ok) throw new Error(`the viewer answered ${runsResponse.status}`);
      const runsBody = (await runsResponse.json()) as { runs?: PrivacyRun[] };
      setRuns(Array.isArray(runsBody.runs) ? runsBody.runs : []);
      if (flagsResponse.ok) {
        const flagsBody = (await flagsResponse.json()) as { flags?: PrivacyFlag[] };
        setFlags(Array.isArray(flagsBody.flags) ? flagsBody.flags : []);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'could not read the record');
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const run of runs) by[run.cls] = (by[run.cls] ?? 0) + 1;
    return by;
  }, [runs]);

  const flag = async (run: PrivacyRun) => {
    if (!run.session_id) return;
    setBusy(run.event_id);
    try {
      const response = await fetch(`${API_BASE}/privacy/flag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tokenHeaders() },
        body: JSON.stringify({ session_id: run.session_id, event_id: run.event_id }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; flag?: string } | null;
      setNote(body?.ok ? `Flagged ${run.tool}: ${body.flag}` : 'The viewer could not write that flag.');
      if (body?.ok) void load(days);
    } catch {
      setNote('Could not reach the viewer to flag that.');
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now() / 1000;

  return (
    <div className="pv-root">
      <header className="pv-head">
        <h2>Privacy</h2>
        <p className="pv-sub">
          Every tool run that drove a browser, this desktop, swept many files, called the network or reached an MCP
          server. The strip in the title bar is only the newest one; this is the record. Flag any of them to write a
          file with the action, the chat, the steps around it and both clock times.
        </p>
        <div className="pv-periods" role="group" aria-label="Period">
          {PERIODS.map((period) => (
            <button
              key={period.label}
              type="button"
              className={`pv-period${days === period.value ? ' is-on' : ''}`}
              aria-pressed={days === period.value}
              onClick={() => setDays(period.value)}
            >
              {period.label}
            </button>
          ))}
        </div>
        <p className="pv-counts">
          {runs.length} runs
          {Object.keys(counts).length
            ? ` · ${Object.entries(counts)
                .map(([cls, n]) => `${n} ${cls}`)
                .join(' · ')}`
            : ''}
          {flags.length ? ` · ${flags.length} flagged` : ''}
        </p>
      </header>

      {error ? <p className="pv-error">Could not read the record: {error}</p> : null}
      {note ? <p className="pv-note">{note}</p> : null}

      {runs.length === 0 && !error ? (
        <p className="pv-empty">Nothing privacy-relevant in this period.</p>
      ) : (
        <table className="pv-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col">Tool</th>
              <th scope="col">Chat</th>
              <th scope="col">Took</th>
              <th scope="col"> </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.event_id} className={run.tone === 'high' ? 'is-high' : 'is-low'}>
                <td title={new Date(run.ts * 1000).toLocaleString()}>{ago(now - run.ts)}</td>
                <td>{run.label}</td>
                <td className="pv-tool">{run.tool}</td>
                <td>
                  {run.session_id ? (
                    <button type="button" className="pv-link" onClick={() => onOpenChat(run.session_id as string)}>
                      {run.chat_title || (run.session_id as string).slice(0, 14) + "…"}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{run.duration_ms === null ? '—' : `${(run.duration_ms / 1000).toFixed(1)}s`}</td>
                <td>
                  <button
                    type="button"
                    className="pv-flag"
                    disabled={busy === run.event_id || !run.session_id}
                    onClick={() => void flag(run)}
                  >
                    {busy === run.event_id ? 'Flagging…' : 'Flag'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {flags.length ? (
        <section className="pv-flags">
          <h3>Flagged</h3>
          <ul>
            {flags.slice(0, 10).map((entry) => (
              <li key={entry.file}>
                <b>{entry.tool || 'action'}</b> · {entry.flagged_at_local} · {entry.file}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
