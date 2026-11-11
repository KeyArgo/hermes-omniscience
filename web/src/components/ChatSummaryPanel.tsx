import { useMemo } from 'react';
import type { OmniEvent } from '../types';
import { summariseChat } from '../graph/chatSummary';
import { Tip } from './Tip';
import './ChatSummaryPanel.css';

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

const OUTCOME_LABEL: Record<string, string> = {
  ok: 'Went well',
  mixed: 'Some errors',
  failed: 'Failed',
  running: 'Still running',
  empty: 'Nothing recorded',
};

/**
 * The whole chat in one short read: what it did, how it went, what to change next time.
 *
 * Collapsed it is a single line, so it never competes with the steps below it; opened it gives
 * the plain-English version of the chat for anyone who does not want to read a timeline.
 */
export function ChatSummaryPanel({
  events,
  rootSessionId,
  open,
  onToggle,
  onJump,
}: {
  events: OmniEvent[];
  rootSessionId: string | null;
  open: boolean;
  onToggle: () => void;
  onJump?: (eventId: string) => void;
}) {
  const summary = useMemo(() => summariseChat(events, rootSessionId), [events, rootSessionId]);
  // The last thing that actually failed, so the summary can take you straight to it.
  const lastFailureId = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const status = events[i]?.status;
      if (
        status === 'error' ||
        status === 'failed' ||
        status === 'timeout' ||
        status === 'blocked'
      ) {
        return events[i].event_id;
      }
    }
    return null;
  }, [events]);
  if (events.length === 0) return null;

  const { headline, outcome, went, improve, facts } = summary;

  return (
    <section className={`cs-panel cs-panel-${outcome}`}>
      <button
        type="button"
        className="cs-head"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? 'Fold the summary away' : 'Read the whole chat in plain words'}
      >
        <span className={`cs-chip cs-chip-${outcome}`}>{OUTCOME_LABEL[outcome] ?? outcome}</span>
        <span className="cs-headline">{headline}</span>
        <span className="cs-facts mono">
          <Tip text="Model calls, tool runs, and the largest context this chat ever sent." side="top">
            <span>
              {facts.modelCalls} {facts.modelCalls === 1 ? 'call' : 'calls'} ·{' '}
              {facts.toolCalls} {facts.toolCalls === 1 ? 'tool' : 'tools'} ·{' '}
              {abbrev(facts.peakContext)} peak
            </span>
          </Tip>
        </span>
        <span className="cs-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <div className="cs-body">
          <ul className="cs-went">
            {went.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>

          {improve.length > 0 ? (
            <div className="cs-improve">
              <span className="cs-improve-title">What to change next time</span>
              <ul>
                {improve.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          ) : summary.outcome === 'ok' ? (
            <p className="cs-clear">
              Nothing worth changing: this chat stayed small and finished without errors.
            </p>
          ) : null}

          {facts.compactions > 0 || facts.failures > 0 ? (
            <div className="cs-tags">
              {facts.compactions > 0 ? (
                <span className="cs-tag">
                  {facts.compactions} compaction{facts.compactions === 1 ? '' : 's'}
                </span>
              ) : null}
              {facts.failures > 0 ? (
                lastFailureId && onJump ? (
                  <button type="button" className="cs-tag cs-tag-action" onClick={() => onJump(lastFailureId)}>
                    {facts.failures} failure{facts.failures === 1 ? '' : 's'} — go to the last one
                  </button>
                ) : (
                  <span className="cs-tag">{facts.failures} failure{facts.failures === 1 ? '' : 's'}</span>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
