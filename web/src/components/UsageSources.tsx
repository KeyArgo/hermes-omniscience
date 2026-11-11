import { useState } from 'react';
import type { UsageSourceStatus } from '../types';
import { setSourceEnabled } from '../api';
import { compactNum } from '../graph/usage';

/**
 * The consent switches. Off is not "hidden" — switching a harness off deletes the rows that were
 * imported from it, so the page cannot show what the owner has not allowed.
 */
export function UsageSources({
  sources,
  onChanged,
}: {
  sources: UsageSourceStatus[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const detected = sources.filter(
    (s) => s.available && !s.enabled && s.measurable !== false && s.declared !== true,
  );
  const anyOn = sources.some((s) => s.enabled);

  async function flip(source: UsageSourceStatus, enabled: boolean) {
    setBusy(source.id);
    setError(null);
    try {
      const next = await setSourceEnabled(source.id, enabled);
      if (next.length) onChanged();
      else onChanged();
    } catch (err) {
      setError(`${source.label}: ${err instanceof Error ? err.message : 'the switch failed'}`);
    } finally {
      setBusy(null);
    }
  }

  async function turnOnDetected() {
    for (const source of detected) {
      // Sequential on purpose: each one scans a real transcript tree, and stacking five of those
      // at once turns the page into a spinner with no progress.
      await flip(source, true);
    }
  }

  return (
    <section className="us-panel us-sources">
      <h3 className="us-h">
        Where the numbers come from
        <span className="us-hint-inline">
          {anyOn ? `${sources.filter((s) => s.enabled).length} switched on` : 'Hermes only'}
        </span>
      </h3>
      <p className="us-notes">
        Other agents keep their own histories. Each switch reads only token counts, model, time and
        the session id from that tool’s transcripts — never a prompt, a reply or a file’s contents.
        Off means the rows are deleted, not hidden.
      </p>
      <ul className="us-source-list">
        {sources.map((source) => (
          <li key={source.id} className={`us-source ${source.enabled ? 'is-on' : ''}`}>
            <label className="us-source-main">
              <input
                type="checkbox"
                checked={source.enabled}
                disabled={!source.available || source.measurable === false || source.declared === true || busy !== null}
                onChange={(event) => void flip(source, event.target.checked)}
              />
              <span className="us-source-name">{source.label}</span>
              {busy === source.id ? (
                <span className="us-source-state">reading…</span>
              ) : source.enabled ? (
                <span className="us-source-state">
                  {compactNum(source.imported)} {source.imported === 1 ? 'call' : 'calls'}
                </span>
              ) : (source.measurable === false || source.declared === true) ? (
                <span className="us-source-state is-off">no token data</span>
              ) : source.available ? (
                <span className="us-source-state">
                  {source.disk_files} file{source.disk_files === 1 ? '' : 's'} available
                </span>
              ) : source.declared ? (
                <span className="us-source-state is-off">no local usage to read</span>
              ) : (
                <span className="us-source-state is-off">not found on this machine</span>
              )}
            </label>
            <span className="us-source-note">{source.note}</span>
          </li>
        ))}
      </ul>
      <div className="us-source-actions">
        <button
          type="button"
          className="us-retry"
          onClick={() => void turnOnDetected()}
          disabled={!detected.length || busy !== null}
          title="Switch on every harness found on this machine, one at a time."
        >
          {busy !== null && detected.length ? 'importing…' : `Enable ${detected.length || 'all'} detected`}
        </button>
        <button type="button" className="us-retry" onClick={onChanged} disabled={busy !== null}>
          refresh numbers
        </button>
      </div>
      {error ? <p className="us-error">{error}</p> : null}
    </section>
  );
}
