import { useEffect, useRef, useState } from "react";
import type { TurnRow, StepRow } from "../graph/rows";
import type { Verdict } from "../graph/verdict";
import { formatDuration } from "../graph/format";
import "./MiniLive.css";

export function lastSteps(
  rows: TurnRow[],
  n: number
): { turn: TurnRow | null; steps: StepRow[] } {
  if (!rows || rows.length === 0) {
    return { turn: null, steps: [] };
  }
  const turn = rows[rows.length - 1];
  const steps = n > 0 ? turn.steps.slice(-n) : [];
  return { turn, steps };
}

function stepIcon(kind: StepRow["kind"]): string {
  switch (kind) {
    case "llm":
      return "◆";
    case "tool":
      return "▸";
    case "helper":
      return "◎";
    case "error":
      return "✕";
    case "gap":
      return "·";
    default:
      return "·";
  }
}


function verdictDotClass(level: Verdict["level"]): string {
  switch (level) {
    case "ok":
      return "ml-dot ml-dot-ok";
    case "slow":
      return "ml-dot ml-dot-warn";
    case "failing":
      return "ml-dot ml-dot-error";
    case "running":
      return "ml-dot ml-dot-running";
    case "empty":
      return "ml-dot ml-dot-dim";
    default:
      return "ml-dot ml-dot-ok";
  }
}

function stepDurationText(step: StepRow, nowTs: number): string {
  if (step.status === "running") {
    return formatDuration(nowTs - step.start) + " so far";
  }
  if (step.seconds != null) {
    return formatDuration(step.seconds);
  }
  return "";
}

function turnElapsedText(turn: TurnRow, nowTs: number): string {
  if (turn.status === "running") {
    return formatDuration(nowTs - turn.start) + " so far";
  }
  if (turn.seconds != null) {
    return formatDuration(turn.seconds);
  }
  return "";
}

/** ?actions=0: the Hermes pane draws its own buttons (they call Hermes directly). */
const hideActions = (() => {
  try {
    return new URLSearchParams(window.location.search).get('actions') === '0';
  } catch {
    return false;
  }
})();

export function MiniLive({
  verdict,
  rows,
  nowTs,
  live,
  onOpenFull,
  onOpenBrowser,
  onSelectEvent,
}: {
  verdict: Verdict;
  rows: TurnRow[];
  nowTs: number;
  live: boolean;
  onOpenFull: () => void;
  onOpenBrowser: () => void;
  onSelectEvent: (eventId: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [frozenRows, setFrozenRows] = useState<TurnRow[]>(rows);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!paused) {
      setFrozenRows(rows);
    }
  }, [rows, paused]);

  const displayRows = paused ? frozenRows : rows;
  const { turn, steps } = lastSteps(displayRows, 8);

  useEffect(() => {
    if (!paused && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [steps, paused]);

  const handleTogglePause = () => {
    if (!paused) {
      setFrozenRows(rows);
    }
    setPaused((p) => !p);
  };

  const handleStepClick = (step: StepRow) => {
    const last = step.eventIds[step.eventIds.length - 1];
    if (last) {
      onSelectEvent(last);
    }
  };

  return (
    <div className="ml-root">
      {displayRows.length > 0 ? (
        <div className="ml-status">
          <span className={verdictDotClass(verdict.level)} aria-hidden="true" />
          <span className="ml-headline">{verdict.headline}</span>
        </div>
      ) : null}

      {!live && displayRows.length > 0 && (
        <div className="ml-notlive">Not live — showing the last recording.</div>
      )}

      {displayRows.length === 0 ? (
        <div className="ml-empty">
          Not recorded yet. This chat may have started before Omniscience was on; your next message appears here as it happens.
        </div>
      ) : (
        <>
          {turn && (
            <div className="ml-now">
              <span className="ml-now-label">Now:</span>{" "}
              <span className="ml-now-text">
                {turn.label}
                {turn.status === "running"
                  ? " · " + turnElapsedText(turn, nowTs)
                  : turn.summary
                    ? " · " + turn.summary
                    : ""}
              </span>
            </div>
          )}

          {turn && turn.badges.length > 0 && (
            <div className="ml-badges">
              {turn.badges.map((b, i) => (
                <span key={i} className="ml-badge">
                  {b}
                </span>
              ))}
            </div>
          )}

          <div className="ml-steps" ref={listRef}>
            {steps.length === 0 ? (
              <div className="ml-steps-empty">no steps yet</div>
            ) : (
              steps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className="ml-step"
                  onClick={() => handleStepClick(step)}
                >
                  <span className="ml-step-icon" aria-hidden="true">
                    {stepIcon(step.kind)}
                  </span>
                  <span className="ml-step-label">{step.label}</span>
                  {step.status === "running" ? (
                    <span className="ml-step-running" aria-hidden="true" />
                  ) : null}
                  <span className="ml-step-dur">
                    {stepDurationText(step, nowTs)}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="ml-pause-row">
            <button
              type="button"
              className="ml-pause"
              onClick={handleTogglePause}
            >
              {paused ? "resume" : "pause"}
            </button>
          </div>
        </>
      )}

      {hideActions ? null : <div className="ml-actions">
        <button type="button" className="ml-btn" onClick={onOpenFull}>
          Open full view
        </button>
        <button type="button" className="ml-btn" onClick={onOpenBrowser}>
          Open in browser ↗
        </button>
      </div>}
    </div>
  );
}
