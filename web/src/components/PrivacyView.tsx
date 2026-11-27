import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../api';
import { tokenHeaders } from '../token';
import { notifyViewerUnreachable, viewerReadFailure } from '../shell/viewerSignal';
import './PrivacyView.css';

export interface PrivacyRun {
  event_id: string;
  ts: number;
  /** Exact local clock time, as the viewer recorded it. */
  at?: string | null;
  tool: string;
  cls: string;
  label: string;
  /** Why this class is on the page, in plain words (server-side, beside the class labels). */
  why?: string;
  /** Metadata only: the host of a URL, a file count, or an MCP server name. */
  touched?: string | null;
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

/** The row's exact local clock time, and how long ago it was. */
export function privacyWhen(run: PrivacyRun, nowSeconds: number): { exact: string; ago: string } {
  return {
    exact: run.at || new Date(run.ts * 1000).toLocaleString(),
    ago: ago(nowSeconds - run.ts),
  };
}

/** Why this step is on the Privacy page, plus what it touched when the metadata says. */
export function privacyWhy(run: PrivacyRun): string {
  const reason = `${run.label}: ${run.why || 'touches this machine or the outside world.'}`;
  return run.touched ? `${reason} Touched ${run.touched}` : reason;
}

type OpenStep = (sessionId: string, eventId: string) => void;

export function PrivacyStepRow({ run, onOpenStep, children }: {
  run: PrivacyRun;
  onOpenStep?: OpenStep;
  children?: React.ReactNode;
}) {
  const canOpen = Boolean(run.session_id?.trim() && onOpenStep);
  const open = () => {
    if (canOpen && run.session_id) onOpenStep?.(run.session_id, run.event_id);
  };
  return (
    <tr
      className={`${run.tone === 'high' ? 'is-high' : 'is-low'}${canOpen ? ' is-clickable' : ''}`}
      data-event-id={run.event_id}
      tabIndex={canOpen ? 0 : undefined}
      title={canOpen ? 'Open this step on the map, with its details' : undefined}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) open();
      }}
      onKeyDown={(event) => {
        if (!canOpen || (event.key !== 'Enter' && event.key !== ' ')) return;
        if ((event.target as HTMLElement).closest('button')) return;
        event.preventDefault();
        open();
      }}
    >
      {children}
    </tr>
  );
}

export function PrivacyView({
  onOpenChat,
  onOpenStep,
}: {
  onOpenChat: (sessionId: string) => void;
  /** Open one exact step: select its chat, switch to the map and put the details panel on it. */
  onOpenStep?: OpenStep;
}) {
  const [days, setDays] = useState(7);
  const [runs, setRuns] = useState<PrivacyRun[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [flags, setFlags] = useState<PrivacyFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadId = useRef(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (window: number) => {
    const id = ++loadId.current;
    setLoading(true);
    setRuns([]);
    setTruncated(false);
    setError(null);
    // Flags are optional; a slow or unavailable flags request must not hide the actual runs.
    void fetch(`${API_BASE}/privacy/flags`, { headers: { ...tokenHeaders() }, signal: AbortSignal.timeout(15000) })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { flags?: PrivacyFlag[] } | null) => {
        if (id === loadId.current && body && Array.isArray(body.flags)) setFlags(body.flags);
      }).catch(() => {});
    try {
      const runsResponse = await fetch(`${API_BASE}/privacy?days=${window}`, {
        headers: { ...tokenHeaders() }, signal: AbortSignal.timeout(15000),
      });
      if (!runsResponse.ok) throw new Error(`the viewer answered ${runsResponse.status}`);
      const runsBody = (await runsResponse.json()) as { runs?: PrivacyRun[]; truncated?: boolean };
      if (!Array.isArray(runsBody.runs)) throw new Error('the viewer returned an unreadable record');
      if (id === loadId.current) {
        setRuns(runsBody.runs);
        setTruncated(runsBody.truncated === true);
      }
    } catch (failure) {
      if (id === loadId.current) {
        // A stopped viewer is reported to the host (which restarts it) and read as a sentence,
        // not as a raw "Failed to fetch".
        setError(viewerReadFailure(failure, 'could not read the record'));
      }
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
    return () => { loadId.current += 1; };
  }, [days, load]);

  /** Which runs are flagged now, so each row offers Flag or Unflag. */
  const flagByEvent = useMemo(() => {
    const by = new Map<string, string>();
    for (const entry of flags) if (entry.event_id) by.set(entry.event_id, entry.file);
    return by;
  }, [flags]);

  const unflag = async (file: string, busyKey: string) => {
    setBusy(busyKey);
    try {
      const ok = await unflagFile(file);
      setNote(ok ? 'Unflagged. The saved file was moved aside, not deleted.' : 'The viewer could not unflag that.');
      if (ok) setFlags((current) => current.filter((entry) => entry.file !== file));
    } finally {
      setBusy(null);
    }
  };

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
          Recorded tool runs that drove a browser, this desktop, swept many files, called the network or reached an MCP
          server. The strip in the title bar is only the newest one; this is the record. Each row says when it ran and
          why it is listed. Click a row to open that exact step on the map; flag one to write a file with the action,
          the chat, the steps around it and both clock times.
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
          {loading ? 'Loading privacy records…' : `${runs.length} runs`}
          {Object.keys(counts).length
            ? ` · ${Object.entries(counts)
                .map(([cls, n]) => `${n} ${cls}`)
                .join(' · ')}`
            : ''}
          {flags.length ? ` · ${flags.length} flagged` : ''}
        </p>
        {truncated && <p>Only the newest 5,000 tool steps in this period were checked. Older matches may be missing.</p>}
      </header>

      {error ? <p className="pv-error">Could not read the record: {error} <button type="button" onClick={() => { notifyViewerUnreachable(); void load(days); }}>Retry</button></p> : null}
      {note ? <p className="pv-note">{note}</p> : null}

      {loading || error ? null : runs.length === 0 ? (
        <p className="pv-empty">{truncated ? 'No matches among the checked steps.' : 'Nothing privacy-relevant in this period. Choose a longer period to see older activity.'}</p>
      ) : (
        <table className="pv-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Why it is listed</th>
              <th scope="col">Tool</th>
              <th scope="col">Chat</th>
              <th scope="col">Took</th>
              <th scope="col"> </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <PrivacyStepRow key={run.event_id} run={run} onOpenStep={onOpenStep}>
                <td className="pv-when">
                  <span className="pv-at">{privacyWhen(run, now).exact}</span>
                  <span className="pv-ago">{privacyWhen(run, now).ago}</span>
                </td>
                <td className="pv-why">{privacyWhy(run)}</td>
                <td className="pv-tool">{run.tool}</td>
                <td>
                  {run.session_id ? (
                    <button
                      type="button"
                      className="pv-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenChat(run.session_id as string);
                      }}
                    >
                      {run.chat_title || (run.session_id as string).slice(0, 14) + "…"}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{run.duration_ms === null ? '—' : `${(run.duration_ms / 1000).toFixed(1)}s`}</td>
                <td>
                  {flagByEvent.has(run.event_id) ? (
                    <button
                      type="button"
                      className="pv-flag is-flagged"
                      disabled={busy === run.event_id}
                      aria-pressed={true}
                      title="Flagged. Press to take the flag off; its saved file is kept aside."
                      onClick={(event) => {
                        event.stopPropagation();
                        void unflag(flagByEvent.get(run.event_id) as string, run.event_id);
                      }}
                    >
                      {busy === run.event_id ? 'Unflagging…' : 'Unflag'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pv-flag"
                      disabled={busy === run.event_id || !run.session_id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void flag(run);
                      }}
                    >
                      {busy === run.event_id ? 'Flagging…' : 'Flag'}
                    </button>
                  )}
                </td>
              </PrivacyStepRow>
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
                <b>{entry.tool || 'action'}</b> · {entry.flagged_at_local} · {entry.file}{' '}
                <button
                  type="button"
                  className="pv-flag is-flagged"
                  disabled={busy === entry.file}
                  onClick={() => void unflag(entry.file, entry.file)}
                >
                  {busy === entry.file ? 'Unflagging…' : 'Unflag'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Take one flag off the list. The viewer keeps its file aside rather than deleting it. */
export async function unflagFile(file: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/privacy/unflag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeaders() },
      body: JSON.stringify({ file }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    return response.ok && body?.ok === true;
  } catch {
    return false;
  }
}
