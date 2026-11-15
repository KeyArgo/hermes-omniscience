// Mounted only by dev/runlist-keyboard-harness.mjs in a Vite dev server. It is not part of the
// app bundle: no production entry imports it. It mounts the shipped RunList against synthetic
// turn rows shaped like the real ones: the row ids are positional ("turn:3" for the fourth
// message on screen), exactly as graph/rows.ts builds them, while each message's events keep
// their own ids. Prepending older messages therefore renumbers every row, which is what the
// identity checks are about.
//
// Around the list sit the controls the browser check needs: a focusable control before and after
// it (so Tab can be shown to enter and leave), a button that removes the first message, one that
// appends a message a moment later (trimming the loaded window), one that prepends older
// messages a moment later, and two fixture sizes.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunList } from '../src/components/RunList';
import type { StepRow, TurnRow } from '../src/graph/rows';
import '../src/styles.css';
import '../src/theme/tokens.css';
import '../src/theme/pass4-motion.css';

/** Small enough that every row is mounted; the count the interaction checks start from. */
const SHORT = 12;
/** Longer than RunList's 400-row window, so the list hides an earlier page behind a button. */
const LONG = 450;
/** The message that kept no steps: no turn ids and no step ids to name it by. */
const EMPTY = 4;
/** The message whose first step is still waiting for its response when the page loads. */
const LIVE = 2;
/** The message whose turn carries no event ids; its steps still do. */
const NO_TURN_IDS = 6;
/** The message whose steps are replaced by filter placeholders while a filter is on. */
const PLACEHOLDER = 5;
/** The two steps that sit before any message; the second is the newer one. */
const PRE_OLD = 90;
const PRE_NEW = 91;

const ids = (count: number) => Array.from({ length: count }, (_, i) => i);

/** One step for message `data` while it sits at `pos`. Ids are positional, like rows.ts' own. */
function makeStep(data: number, pos: number, s: number, responded: boolean): StepRow {
  const eventIds = [`ev-${data}-${s}`];
  // A live request gains its response: the group grows at the end, its first id does not move.
  if (responded && data === LIVE && s === 0) eventIds.push(`ev-${data}-${s}-response`);
  return {
    id: `t${pos}:s${s}`,
    kind: s === 0 ? 'llm' : 'tool',
    label: s === 0 ? 'model call' : 'terminal',
    detail: s === 0 ? `model-${data}` : `run ${data}.${s}`,
    start: 1762400000 + data * 10 + s,
    seconds: 0.4 + s,
    status: 'ok',
    badges: [],
    eventIds,
    repeat: 1,
  };
}

/** A "N tools hidden" row, as graph/rows.ts' filter builds it: no events, id suffixed by kind. */
function gapStep(pos: number, which: 'tools' | 'llms'): StepRow {
  const count = which === 'tools' ? 2 : 1;
  return {
    id: `turn:${pos}:gap:${which}`,
    kind: 'gap',
    label: which === 'tools' ? `+${count} tools hidden` : `+${count} model calls hidden`,
    detail: '',
    start: 1762400000 + PLACEHOLDER * 10,
    seconds: null,
    status: 'ok',
    badges: [],
    eventIds: [],
    repeat: count,
  };
}

function makeTurn(
  data: number,
  pos: number,
  responded: boolean,
  hideTools: boolean,
  hideLlms: boolean,
  dupIds: boolean,
): TurnRow {
  const placeholders = [
    ...(hideTools ? [gapStep(pos, 'tools')] : []),
    ...(hideLlms ? [gapStep(pos, 'llms')] : []),
  ];
  const normalSteps = data === EMPTY
    ? []
    : [
        makeStep(data, pos, 0, responded),
        makeStep(data, pos, 1, responded),
        makeStep(data, pos, 2, responded),
      ];
  // A filter replaces the steps on screen but leaves the message's own events alone, exactly as
  // applyFilter does, so the message keeps its identity while placeholders come and go.
  const steps = data === PLACEHOLDER && placeholders.length > 0 ? placeholders : normalSteps;
  // Two messages can carry the same recorded id (a re-read page, a duplicated event).
  const sharedIds = dupIds && data === 2 ? ['ev-0-0'] : null;
  return {
    id: `turn:${pos}`,
    index: pos,
    label: `Message ${pos + 1} · 20:33`,
    start: 1762400000 + data * 10,
    seconds: 3,
    status: 'ok',
    summary: data === EMPTY ? 'nothing kept' : `${steps.length} steps`,
    badges: [],
    steps,
    eventIds: sharedIds ?? (data === NO_TURN_IDS ? [] : (normalSteps[0]?.eventIds ?? [])),
  };
}

/**
 * The steps before the first message. Once a prepend reveals a turn.start between them, only the
 * older one is left here — the newer one belongs to the real message that is now first.
 */
function makePreTurn(
  pos: number,
  revealed: boolean,
  merged: boolean,
  warn: boolean,
  appended: boolean,
): TurnRow {
  const steps = revealed
    ? [makeStep(PRE_OLD, pos, 0, false)]
    : [makeStep(PRE_OLD, pos, 0, false), makeStep(PRE_NEW, pos, 1, false)];
  if (appended && !revealed) {
    // A live event lands before the first message: the row grows at the end.
    steps.push(makeStep(92, pos, 1, false));
  }
  if (merged && !revealed) {
    // An older call of the same tool is prepended: it merges into this group, which is now
    // anchored by the older event while the group is the same row.
    const last = steps[steps.length - 1];
    steps[steps.length - 1] = {
      ...last,
      label: `${last.label} ×2`,
      repeat: 2,
      eventIds: ['ev-89-1', ...last.eventIds],
    };
  }
  return {
    id: 'turn:pre',
    index: 0,
    label: 'Before the first message',
    start: 1762400000 + PRE_OLD * 10,
    seconds: 2,
    status: warn ? 'warn' : 'ok',
    summary: `${steps.length} steps`,
    badges: [],
    steps,
    eventIds: steps.flatMap((step) => step.eventIds),
  };
}

/** The message the prepend reveals: its own turn.start, then the pre-turn's newest step. */
function makeRevealedTurn(pos: number): TurnRow {
  const step = makeStep(PRE_NEW, pos, 1, false);
  return {
    id: `turn:${pos}`,
    index: pos,
    label: `Message ${pos + 1} · 20:33`,
    start: 1762400000 + PRE_OLD * 10 + 5,
    seconds: 4,
    status: 'ok',
    summary: '1 step',
    badges: [],
    steps: [step],
    eventIds: ['ev-revealed-start', ...step.eventIds],
  };
}

function Harness() {
  const [messages, setMessages] = useState<number[]>(() => ids(SHORT));
  const [responded, setResponded] = useState(false);
  const [showPre, setShowPre] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [hideTools, setHideTools] = useState(false);
  const [hideLlms, setHideLlms] = useState(false);
  const [merged, setMerged] = useState(false);
  const [preWarn, setPreWarn] = useState(false);
  const [preAppended, setPreAppended] = useState(false);
  const [dupIds, setDupIds] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Remounting resets the list's own state (open turns, the earlier window, the tab stop).
  const [runKey, setRunKey] = useState(0);

  const rows: TurnRow[] = [];
  let pos = 0;
  if (showPre) rows.push(makePreTurn(pos++, revealed, merged, preWarn, preAppended));
  if (showPre && revealed) rows.push(makeRevealedTurn(pos++));
  for (const data of messages) {
    rows.push(makeTurn(data, pos++, responded, hideTools, hideLlms, dupIds));
  }

  const reset = (count: number, pre = false) => {
    setMessages(ids(count));
    setResponded(false);
    setShowPre(pre);
    setRevealed(false);
    setMerged(false);
    setPreWarn(false);
    setPreAppended(false);
    setDupIds(false);
    setHideTools(false);
    setHideLlms(false);
    setSelectedEventId(null);
    setRunKey((key) => key + 1);
  };

  /** Three messages where the first and the third carry the same recorded id. */
  const resetDup = () => {
    reset(0);
    setMessages([0, 1, 2]);
    setDupIds(true);
  };

  return (
    <StrictMode>
      <div style={{ padding: 12 }}>
        <button id="before" type="button">
          before list
        </button>
        <div className="graph-surface rl-surface" style={{ height: 360, overflowY: 'auto' }}>
          <RunList
            key={runKey}
            rows={rows}
            selectedEventId={selectedEventId}
            playing={false}
            onSelectEvent={setSelectedEventId}
          />
        </div>
        <button id="after" type="button">
          after list
        </button>
        <button
          id="drop-later"
          type="button"
          onClick={() => window.setTimeout(() => setMessages((m) => m.filter((d) => d !== 0)), 700)}
        >
          drop the first message in a moment
        </button>
        <button
          id="append-later"
          type="button"
          onClick={() => window.setTimeout(() => setMessages((m) => [...m, 1000 + m.length]), 700)}
        >
          append a message in a moment
        </button>
        <button
          id="prepend-later"
          type="button"
          onClick={() => window.setTimeout(() => setMessages((m) => [900, 901, ...m]), 700)}
        >
          prepend two older messages in a moment
        </button>
        <button
          id="respond-later"
          type="button"
          onClick={() => window.setTimeout(() => setResponded(true), 700)}
        >
          answer the live request in a moment
        </button>
        <button id="fixture-pre" type="button" onClick={() => reset(SHORT, true)}>
          fixture with a row before the first message
        </button>
        <button
          id="fixture-pre-warn"
          type="button"
          onClick={() => {
            reset(SHORT, true);
            setPreWarn(true);
          }}
        >
          fixture with a warning before the first message
        </button>
        <button
          id="pre-append-later"
          type="button"
          onClick={() => window.setTimeout(() => setPreAppended(true), 700)}
        >
          append a pre-message event in a moment
        </button>
        <button
          id="reveal-later"
          type="button"
          onClick={() => window.setTimeout(() => setRevealed(true), 700)}
        >
          reveal a turn.start in a moment
        </button>
        <button
          id="merge-later"
          type="button"
          onClick={() => window.setTimeout(() => setMerged(true), 700)}
        >
          merge an older call into the pre-message group in a moment
        </button>
        <button id="hide-tools" type="button" onClick={() => setHideTools((on) => !on)}>
          hide tools
        </button>
        <button id="hide-llms" type="button" onClick={() => setHideLlms((on) => !on)}>
          hide model calls
        </button>
        <button id="fixture-dup" type="button" onClick={resetDup}>
          fixture with two messages sharing an event id
        </button>
        <button id="fixture-short" type="button" onClick={() => reset(SHORT)}>
          short fixture
        </button>
        <button id="fixture-long" type="button" onClick={() => reset(LONG)}>
          long fixture
        </button>
        <div
          id="state"
          data-selected={selectedEventId ?? 'none'}
          data-turns={rows.length}
          data-messages={messages.length}
          data-responded={responded ? '1' : '0'}
          data-revealed={revealed ? '1' : '0'}
          data-tools={hideTools ? '1' : '0'}
          data-llms={hideLlms ? '1' : '0'}
          data-merged={merged ? '1' : '0'}
          data-preapp={preAppended ? '1' : '0'}
        />
      </div>
    </StrictMode>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
