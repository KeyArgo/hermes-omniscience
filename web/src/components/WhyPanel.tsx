import { useRef, useState } from 'react';
import { fetchDiagnose, type Diagnose } from '../api';

/** null = nothing known yet; 'error' = the viewer could not be reached. */
export type WhyAnswerValue = Diagnose | 'error' | null;

interface WhyState {
  key: string;
  answer: WhyAnswerValue;
  stepHidden: boolean;
}

/** An answer belongs to one run: a new session or a different failure count invalidates it. */
export function whyKey(root: string | null, failedCount: number): string {
  return `${root ?? ''}|${failedCount}`;
}

export function shownState(state: WhyState, key: string): WhyState {
  if (state.key === key) {
    return state;
  }
  return { key: '', answer: null, stepHidden: false };
}

interface WhyAnswerProps {
  answer: WhyAnswerValue;
  stepHidden: boolean;
  onSelectEvent: (eventId: string) => boolean;
  onStepFound: (found: boolean) => void;
}

export function WhyAnswer({ answer, stepHidden, onSelectEvent, onStepFound }: WhyAnswerProps) {
  if (answer === null) return null;
  if (answer === 'error') {
    return <p className="why-answer">{"Couldn't reach the viewer."}</p>;
  }
  if (answer.status === 'no_failure') {
    return <p className="why-answer">No failure was found in the events reviewed. The record may be incomplete.</p>;
  }
  if (answer.status === 'insufficient') {
    const missing = answer.missing.join(', ');
    return <p className="why-answer">{`Not enough recorded data to say why. Missing: ${missing}.`}</p>;
  }
  const failingEventId = answer.evidence_event_ids[0] ?? null;
  const previousEventId = answer.previous_step?.event_id ?? null;
  const beforeTool = answer.previous_step?.tool ?? answer.previous_step?.kind ?? 'unknown';
  const beforeDuration = answer.previous_step?.duration_ms ?? '?';
  const show = (eventId: string) => onStepFound(onSelectEvent(eventId));
  return (
    <div className="why-answer">
      <p>{answer.sentence}</p>
      <p>{`Step before it: ${beforeTool} (${beforeDuration} ms)`}</p>
      {failingEventId ? (
        <button type="button" className="why-link" onClick={() => show(failingEventId)}>
          Show failing step
        </button>
      ) : null}
      {previousEventId ? (
        <button type="button" className="why-link" onClick={() => show(previousEventId)}>
          Show step before
        </button>
      ) : null}
      {stepHidden ? <p>That step isn't on the map right now (a filter may hide it).</p> : null}
    </div>
  );
}

interface WhyPanelProps {
  root: string | null;
  failedCount: number;
  onSelectEvent: (eventId: string) => boolean;
}

export function WhyPanel({ root, failedCount, onSelectEvent }: WhyPanelProps) {
  const [state, setState] = useState<WhyState>({ key: '', answer: null, stepHidden: false });
  const requestRef = useRef(0);
  const key = whyKey(root, failedCount);
  const shown = shownState(state, key);

  if (failedCount === 0) return null;

  const ask = () => {
    if (!root) return;
    requestRef.current += 1;
    const requestId = requestRef.current;
    void fetchDiagnose(root).then((diagnose) => {
      if (requestId !== requestRef.current) return;
      setState({ key, answer: diagnose ?? 'error', stepHidden: false });
    });
  };

  return (
    <section className="why" aria-label="Why did this run fail?">
      <button type="button" className="slowest-row" onClick={ask}>
        Why did this run fail?
      </button>
      <WhyAnswer
        answer={shown.answer}
        stepHidden={shown.stepHidden}
        onSelectEvent={onSelectEvent}
        onStepFound={(found) => setState((current) => ({ ...current, stepHidden: !found }))}
      />
    </section>
  );
}
