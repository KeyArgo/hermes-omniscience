import type { RunSummary, NowStep, TimeSplit } from '../graph/summary';
import { runSentence } from '../graph/summary';
import { formatDuration, formatNumber, formatTokens } from '../graph/format';

export interface SummaryBarProps {
  summary: RunSummary;
  nowStep: NowStep | null;
  /** Ticking clock in epoch seconds, for the "right now" elapsed time. */
  nowTs: number;
  split: TimeSplit;
  failedNodeCount: number;
  onNextError: () => void;
  onPrevError: () => void;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

export function SummaryBar({
  summary,
  nowStep,
  split,
  failedNodeCount,
  onNextError,
  onPrevError,
}: SummaryBarProps) {
  const wall = summary.wallSeconds;
  const statusClass = summary.isRunning
    ? 'is-running'
    : summary.errorCount > 0
      ? 'is-error'
      : summary.isInterrupted
        ? 'is-warn'
        : 'is-ok';

  const now = nowStep && summary.isRunning ? nowStep.label : null;

  const segments = [
    {
      key: 'llm',
      label: 'Model calls',
      seconds: split.llmSeconds,
      color: 'var(--violet, #a78bfa)',
    },
    {
      key: 'tool',
      label: 'Tools',
      seconds: split.toolSeconds,
      color: 'var(--dim, #4a5a6c)',
    },
    {
      key: 'waiting',
      label: 'Between turns',
      seconds: split.waitingSeconds,
      color: 'var(--muted, #64748b)',
      title: 'Time between recorded turns; the reason for the gap is not known.',
    },
    {
      key: 'other',
      label: 'Other / unknown',
      seconds: split.otherSeconds,
      color: 'var(--line-2, #273547)',
      title: 'Time outside measured model calls and tools; its cause is not known.',
    },
  ].filter(
    (
      segment,
    ): segment is {
      key: string;
      label: string;
      seconds: number;
      color: string;
      title?: string;
    } => typeof segment.seconds === 'number' && segment.seconds > 0,
  );

  const known = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  const partialNote = split.partial
    ? summary.isRunning
      ? 'the run is still going, so this is incomplete'
      : 'some durations were not reported, so this is incomplete'
    : null;

  return (
    <div className="summary-bar">
      <p className="summary-sentence">{runSentence(summary, split)}</p>
      <div className="summary-line">
        <span className={`summary-status ${statusClass}`}>{summary.statusWord}</span>
        <span className="summary-item" title="Total time from the first recorded step to the last one.">
          took <b className="mono">{wall !== null ? formatDuration(wall) : 'not reported'}</b>
        </span>
        <span
          className="summary-item"
          title="How many times the agent asked the AI model. Tokens are the amount of text sent and received."
        >
          model calls <b className="mono">{formatNumber(summary.modelCalls)}</b>
        </span>
        <span
          className="summary-item"
          title={
            summary.tokensPartial
              ? 'Token totals come only from the calls that reported them — some did not.'
              : 'Tokens are the amount of text sent to / received from the model. Totals only include calls that reported them.'
          }
        >
          tokens <b className="mono">
            {formatTokens(summary.tokensIn)} in · {formatTokens(summary.tokensOut)} out
          </b>
          {summary.tokensPartial ? <i className="summary-hint"> (partial)</i> : null}
        </span>
        <span
          className="summary-item"
          title="Tool = an action like running a command or reading a file."
        >
          tools <b className="mono">{formatNumber(summary.toolCalls)}</b>
        </span>
        {summary.failedTools > 0 ? (
          <span className="summary-item warn-text" title="Tools that ended in an error (shown red on the map).">
            failed tools <b className="mono">{formatNumber(summary.failedTools)}</b>
          </span>
        ) : null}
        <span
          className="summary-item"
          title="Helper agents are sub-agents the agent started for part of the job."
        >
          helpers <b className="mono">{formatNumber(summary.helperAgents)}</b>
        </span>
        {summary.lostEvents > 0 ? (
          <span
            className="summary-item warn-text"
            title="Lost: steps the recorder had to skip because it fell behind. The map shows where."
          >
            lost <b className="mono">{formatNumber(summary.lostEvents)}</b>
          </span>
        ) : null}
        {summary.errorCount > 0 && failedNodeCount > 0 ? (
          <>
            <button
              type="button"
              className="summary-prev-error"
              onClick={onPrevError}
              title="Show the failure that happened before the one selected."
            >
              ◀ Earlier failure
            </button>
            <button
              type="button"
              className="summary-next-error"
              onClick={onNextError}
              title="Show the failure that happened after the one selected."
            >
              Later failure ▶
            </button>
          </>
        ) : null}
      </div>

      {now ? (
        <div className="now-line" title="No end was recorded for this step. It may have stopped or the record may be incomplete.">
          <span className="now-pulse" aria-hidden="true" /> No end recorded: {now}
        </div>
      ) : null}

      {segments.length > 0 ? (
        <div
          className={`time-split ${split.partial ? 'is-partial' : ''}`}
          title="Where the time went: share of total run time spent inside model calls, tools, and elsewhere. Only reported durations count."
        >
          <span className="time-split-label">where the time went</span>
          <span className="time-split-bar">
            {segments.map((segment) => (
              <span
                key={segment.key}
                className="time-split-seg"
                style={{
                  width: `${pct(segment.seconds, known)}%`,
                  background: segment.color,
                }}
                title={
                  `${segment.label}: ${formatDuration(segment.seconds)} (${Math.round(pct(segment.seconds, known))}% of recorded time)` +
                  (segment.title ? `. ${segment.title}` : '')
                }
              />
            ))}
          </span>
          <span className="time-split-key">
            {segments.map((segment) => (
              <span key={segment.key} className="time-split-key-item">
                <i className="split-swatch" style={{ background: segment.color }} />
                {segment.label.toLowerCase()} {formatDuration(segment.seconds)} ·{' '}
                {Math.round(pct(segment.seconds, known))}%
              </span>
            ))}
          </span>
          {partialNote ? <span className="time-split-partial">({partialNote})</span> : null}
        </div>
      ) : null}
    </div>
  );
}
