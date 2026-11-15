import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RunList,
  StepLine,
  TurnLine,
  autoExpandKeys,
  handoffKey,
  keyedTurns,
  movedRow,
  moveRowFocus,
  resolveRovingKey,
  rovingKeys,
  rowLedger,
  stepRowKey,
  turnIdentity,
  turnOfRowKey,
  turnRowKey,
} from './RunList';
import { applyFilter, buildRows } from '../graph/rows';
import type { OmniEvent } from '../types';
import type { StepRow, TurnRow } from '../graph/rows';

const step: StepRow = {
  id: 'turn:1:llm',
  kind: 'llm',
  label: 'model call',
  detail: 'claude',
  start: 1762400000,
  seconds: 1.4,
  status: 'ok',
  badges: ['2k tok'],
  eventIds: ['ev-1'],
  repeat: 1,
};

const step2: StepRow = {
  ...step,
  id: 'turn:1:tool',
  kind: 'tool',
  label: 'tool',
  detail: 'terminal',
  eventIds: ['ev-2'],
};

const turn: TurnRow = {
  id: 'turn:1',
  index: 1,
  label: 'You',
  start: 1762400000,
  seconds: 1.4,
  status: 'ok',
  summary: 'one model call',
  badges: ['1 step'],
  steps: [step],
  eventIds: ['ev-1'],
};

const twoStepTurn: TurnRow = {
  ...turn,
  id: 'turn:3',
  steps: [step, step2],
  eventIds: ['ev-3'],
  badges: ['2 steps'],
};

const emptyTurn: TurnRow = {
  ...turn,
  id: 'turn:2',
  summary: 'nothing kept',
  badges: [],
  steps: [],
  eventIds: [],
};

/** The opening tag of the turn header, so attribute checks cannot match another element. */
function headTag(html: string): string {
  return html.match(/<div[^>]*class="rl-turn-head"[^>]*>/)?.[0] ?? '';
}

/** Every opening tag that holds the single roving tab stop, in document order. */
function tabStops(html: string): string[] {
  return html.match(/<div[^>]*tabindex="0"[^>]*>/g) ?? [];
}

const noop = () => {};

/** A recorded event with only the parts these tests care about set. */
const ev = (
  partial: Partial<OmniEvent> & { event_id: string; ts: number; kind: string },
): OmniEvent =>
  ({
    rowid: 0,
    session_id: 'root',
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: null,
    ...partial,
  }) as OmniEvent;

const renderTurn = (t: TurnRow, expanded = false, activeKey: string | null = null) => {
  const [{ key, stepKeys }] = keyedTurns([t]);
  return renderToStaticMarkup(
    <TurnLine
      turn={t}
      rowKey={key}
      stepKeys={stepKeys}
      expanded={expanded}
      onToggle={noop}
      selectedEventId={null}
      onSelectEvent={noop}
      activeKey={activeKey}
    />,
  );
};

/** The header props TurnLine actually renders, so the real handlers can be exercised. */
function headerProps(t: TurnRow, expanded = false) {
  const [{ key, stepKeys }] = keyedTurns([t]);
  const element = TurnLine({
    turn: t,
    rowKey: key,
    stepKeys,
    expanded,
    onToggle: noop,
    selectedEventId: null,
    onSelectEvent: noop,
    activeKey: turnRowKey(key),
  });
  return element.props.children[0].props as {
    role?: string;
    tabIndex?: number;
    tabindex?: string;
    'aria-expanded'?: boolean;
    'aria-controls'?: string;
    'data-rl-key'?: string;
    onClick?: () => void;
    onKeyDown?: (e: Record<string, unknown>) => void;
  };
}

describe('roving tabindex maths', () => {
  it('moves one row at a time and stops at the ends instead of wrapping', () => {
    expect(moveRowFocus(0, 'ArrowDown', 5)).toBe(1);
    expect(moveRowFocus(3, 'ArrowUp', 5)).toBe(2);
    expect(moveRowFocus(4, 'ArrowDown', 5)).toBe(4);
    expect(moveRowFocus(0, 'ArrowUp', 5)).toBe(0);
  });

  it('jumps to the first and last row on Home and End', () => {
    expect(moveRowFocus(3, 'Home', 9)).toBe(0);
    expect(moveRowFocus(3, 'End', 9)).toBe(8);
  });

  it('enters a list that has no current row', () => {
    expect(moveRowFocus(-1, 'ArrowDown', 4)).toBe(0);
    expect(moveRowFocus(-1, 'ArrowUp', 4)).toBe(3);
  });

  it('has nowhere to go in an empty list, and leaves other keys alone', () => {
    expect(moveRowFocus(-1, 'ArrowDown', 0)).toBe(-1);
    expect(moveRowFocus(2, 'Enter', 4)).toBe(2);
    expect(moveRowFocus(2, 'Tab', 4)).toBe(2);
    expect(moveRowFocus(2, 'a', 4)).toBe(2);
  });
});

describe('row identity', () => {
  const NOW = 1762400500;

  /** A recorded message: turn.start, one tool step, turn.end. Its ids stay with the events. */
  const message = (base: number): OmniEvent[] => [
    ev({ event_id: `evt-${base}`, ts: 100 + base, kind: 'turn.start' }),
    ev({
      event_id: `evt-${base + 1}`,
      ts: 101 + base,
      kind: 'tool.end',
      status: 'ok',
      attrs: { tool_name: 'terminal', duration_ms: 10 },
    }),
    ev({ event_id: `evt-${base + 2}`, ts: 102 + base, kind: 'turn.end' }),
  ];

  it('names a message by its recorded events, not by where it sat when they loaded', () => {
    const loaded = [...message(10), ...message(20)];
    const earlier = message(4);
    const before = buildRows(loaded, NOW);
    const after = buildRows([...earlier, ...loaded], NOW);

    // The positional ids really do move: this is the bug, against the real row builder.
    expect(before.map((r) => r.id)).toEqual(['turn:0', 'turn:1']);
    expect(after.map((r) => r.id)).toEqual(['turn:0', 'turn:1', 'turn:2']);

    const msgBefore = before.find((r) => r.eventIds.includes('evt-11'));
    const msgAfter = after.find((r) => r.eventIds.includes('evt-11'));
    expect(msgBefore?.id).toBe('turn:0');
    expect(msgAfter?.id).toBe('turn:1');

    // The identity the list keys its state by does not move, so an open turn stays open on the
    // same message and the focused row still points at the same content.
    expect(turnIdentity(msgBefore as TurnRow)).toBe(turnIdentity(msgAfter as TurnRow));
    const keyBefore = keyedTurns(before).find((k) => k.turn === msgBefore)?.key;
    const keyAfter = keyedTurns(after).find((k) => k.turn === msgAfter)?.key;
    expect(keyBefore).toBe(keyAfter);
    expect(keyBefore).toBe('e:evt-10'); // the message's turn.start event, not its position
  });

  it('also holds when only an earlier window of the same events is loaded (replay)', () => {
    const all = [...message(10), ...message(20)];
    const full = buildRows(all, NOW);
    const prefix = buildRows(all.slice(0, 3), NOW);
    expect(full).toHaveLength(2);
    expect(prefix).toHaveLength(1);
    expect(turnIdentity(prefix[0])).toBe(turnIdentity(full[0]));
  });

  it('keeps a step’s identity when a live request gains its response', () => {
    const start = ev({ event_id: 'ts-1', ts: 100, kind: 'turn.start' });
    const req = ev({
      event_id: 'req-1',
      ts: 101,
      kind: 'llm.request',
      api_request_id: 'a1',
      attrs: { model: 'm' },
    });
    const resp = ev({
      event_id: 'resp-1',
      ts: 102,
      kind: 'llm.response',
      api_request_id: 'a1',
      attrs: { model: 'm', duration_s: 1 },
    });

    const before = buildRows([start, req], NOW);
    const after = buildRows([start, req, resp], NOW);
    // The group really did grow: the response is appended after the request.
    expect(before[0].steps[0].eventIds).toEqual(['req-1']);
    expect(after[0].steps[0].eventIds).toEqual(['req-1', 'resp-1']);

    expect(keyedTurns(before)[0].key).toBe(keyedTurns(after)[0].key);
    expect(keyedTurns(before)[0].stepKeys[0]).toBe(keyedTurns(after)[0].stepKeys[0]);
  });

  it('keeps a merged tool group’s identity as another call joins it', () => {
    const start = ev({ event_id: 'ts-2', ts: 100, kind: 'turn.start' });
    const tool = (n: number) =>
      ev({
        event_id: `tool-${n}`,
        ts: 100 + n,
        kind: 'tool.end',
        status: 'ok',
        attrs: { tool_name: 'terminal', duration_ms: 100 },
      });

    const one = buildRows([start, tool(1)], NOW);
    const two = buildRows([start, tool(1), tool(2)], NOW);
    // The merged row relabels itself and grows its ids as the group grows.
    expect(one[0].steps[0].label).toBe('terminal');
    expect(two[0].steps[0].label).toBe('terminal ×2');
    expect(one[0].steps[0].eventIds).toEqual(['tool-1']);
    expect(two[0].steps[0].eventIds).toEqual(['tool-1', 'tool-2']);

    expect(keyedTurns(one)[0].stepKeys[0]).toBe(keyedTurns(two)[0].stepKeys[0]);
  });

  it('holds the pre-message row’s key while older steps are added in front of it', () => {
    const toolAt = (id: string, ts: number) =>
      ev({
        event_id: id,
        ts,
        kind: 'tool.end',
        status: 'ok',
        attrs: { tool_name: 'terminal', duration_ms: 10 },
      });

    const loaded = [toolAt('tool-6', 106), ...message(10)];
    const before = rowLedger(buildRows(loaded, NOW));
    const after = rowLedger(buildRows([toolAt('tool-2', 102), ...loaded], NOW));

    expect(before.keyed[0].turn.id).toBe('turn:pre');
    expect(after.keyed[0].turn.id).toBe('turn:pre');
    expect(turnIdentity(before.keyed[0].turn)).toBe('pre');
    expect(turnIdentity(after.keyed[0].turn)).toBe('pre');
    // The newest event is the row's anchor for migration, and it did not move.
    expect(before.keyed[0].anchor).toBe('tool-6');
    expect(after.keyed[0].anchor).toBe('tool-6');
  });

  it('holds the same key when a newer step arrives at the end, so a closed row stays closed', () => {
    const toolAt = (id: string, ts: number) =>
      ev({
        event_id: id,
        ts,
        kind: 'tool.end',
        status: 'ok',
        attrs: { tool_name: 'terminal', duration_ms: 10 },
      });

    const before = rowLedger(buildRows([toolAt('tool-6', 106)], NOW));
    const after = rowLedger(buildRows([toolAt('tool-6', 106), toolAt('tool-8', 108)], NOW));

    // The row really did grow at the end…
    expect(before.keyed[0].turn.eventIds).toEqual(['tool-6']);
    expect(after.keyed[0].turn.eventIds).toEqual(['tool-6', 'tool-8']);
    // …its anchor moved to the newer event…
    expect(before.keyed[0].anchor).toBe('tool-6');
    expect(after.keyed[0].anchor).toBe('tool-8');
    // …and its key did not, so nothing treats it as a new turn (no auto-expand, no remount).
    expect(before.keyed[0].key).toBe('pre');
    expect(after.keyed[0].key).toBe('pre');
    expect(movedRow(turnRowKey('pre'), before.keyed[0].anchor, after)).toBeNull();
  });

  it('moves a pre-message step’s identity with its events when a merge absorbs an older call', () => {
    const toolAt = (id: string, ts: number) =>
      ev({
        event_id: id,
        ts,
        kind: 'tool.end',
        status: 'ok',
        attrs: { tool_name: 'terminal', duration_ms: 10 },
      });

    const before = rowLedger(buildRows([toolAt('tool-6', 106)], NOW));
    const after = rowLedger(buildRows([toolAt('tool-2', 102), toolAt('tool-6', 106)], NOW));

    // The merged group is re-anchored by the older call, so its key changes…
    const oldKey = stepRowKey(before.keyed[0].key, before.keyed[0].stepKeys[0]);
    const newKey = stepRowKey(after.keyed[0].key, after.keyed[0].stepKeys[0]);
    expect(oldKey).not.toBe(newKey);
    // …and the event that named it still names the same content, so state can follow it.
    expect(movedRow(oldKey, before.keyed[0].stepAnchors[0], after)).toBe(newKey);
  });

  it('follows the newest pre-message events when a prepend reveals a turn.start', () => {
    const toolAt = (id: string, ts: number) =>
      ev({
        event_id: id,
        ts,
        kind: 'tool.end',
        status: 'ok',
        attrs: { tool_name: 'terminal', duration_ms: 10 },
      });

    // Two pre-message steps, the second newer, and no turn.start in the loaded window.
    const before = rowLedger(buildRows([toolAt('tool-1', 102), toolAt('tool-2', 109)], NOW));
    expect(before.keyed.map((k) => k.turn.id)).toEqual(['turn:pre']);
    expect(before.keyed[0].key).toBe('pre');
    expect(before.keyed[0].anchor).toBe('tool-2');

    // An older page arrives with a turn.start between the two: the newer step is now a real message.
    const revealed = ev({ event_id: 'ts-105', ts: 105, kind: 'turn.start' });
    const after = rowLedger(buildRows([revealed, toolAt('tool-1', 102), toolAt('tool-2', 109)], NOW));
    expect(after.keyed.map((k) => k.turn.id)).toEqual(['turn:pre', 'turn:0']);
    // The row keeps its key (it is still the slot before the first message)…
    expect(after.keyed[0].key).toBe('pre');
    // …but the event that anchored it now belongs to the real message, so state follows it there.
    expect(after.keyed[0].anchor).toBe('tool-1');
    expect(movedRow(turnRowKey('pre'), before.keyed[0].anchor, after)).toBe(
      turnRowKey(after.keyed[1].key),
    );
    expect(after.keyed[1].key).toBe('e:ts-105');
  });

  it('keeps filter placeholders apart and keeps their keys when a filter toggles', () => {
    const withTool: TurnRow = {
      ...turn,
      steps: [step, { ...step2, kind: 'tool' as const }],
    };
    const filter = (hideTools: boolean, hideLlms: boolean) =>
      rowLedger(applyFilter([withTool], { hideTools, hideLlms, errorsOnly: false })).keyed[0]
        .stepKeys;

    const toolsOnly = filter(true, false);
    const llmsOnly = filter(false, true);
    const both = filter(true, true);

    // Distinct rows, distinct keys — the two placeholders never share one.
    expect(toolsOnly).toEqual(['e:ev-1', 'i:gap:tools']);
    expect(llmsOnly).toEqual(['e:ev-2', 'i:gap:llms']);
    expect(both).toEqual(['i:gap:tools', 'i:gap:llms']);
    // Toggling the other filter leaves each placeholder's key exactly where it was.
    expect(both[0]).toBe(toolsOnly[1]);
    expect(both[1]).toBe(llmsOnly[1]);
  });

  it('keeps identity off the values that change while a turn runs', () => {
    const running: TurnRow = {
      ...emptyTurn,
      eventIds: [],
      steps: [],
      status: 'running',
      seconds: null,
      summary: '',
    };
    const finished: TurnRow = {
      ...running,
      status: 'ok',
      seconds: 4.2,
      summary: '1 model call · 4.2s',
    };
    expect(keyedTurns([running])[0].key).toBe(keyedTurns([finished])[0].key);
  });

  it('keeps rows with duplicated recorded ids apart, in list order, across a prepend', () => {
    const a: TurnRow = { ...turn, eventIds: ['dup'] };
    const b: TurnRow = { ...twoStepTurn, eventIds: ['dup'] };
    const keys = keyedTurns([a, b]).map((k) => k.key);
    expect(new Set(keys).size).toBe(2);
    const older: TurnRow = { ...emptyTurn, id: 'turn:9', eventIds: ['older'] };
    expect(keyedTurns([older, a, b]).map((k) => k.key).slice(1)).toEqual(keys);
  });

  it('falls back to the step ids, then to the clock, when a turn has none', () => {
    const viaSteps: TurnRow = { ...turn, eventIds: [], steps: [{ ...step, eventIds: ['ev-9'] }] };
    expect(turnIdentity(viaSteps)).toBe('e:ev-9');

    const bare: TurnRow = { ...emptyTurn, eventIds: [], steps: [] };
    expect(turnIdentity(bare)).toContain(String(bare.start));
    // Two rows on the same clock with nothing recorded still get their own keys, in list order,
    // and keep them when an older row is put in front.
    const twin: TurnRow = { ...bare, id: 'turn:7' };
    const [first, second] = keyedTurns([bare, twin]);
    expect(first.key).not.toBe(second.key);
    const older: TurnRow = { ...emptyTurn, id: 'turn:8', eventIds: ['older'], start: 1 };
    expect(keyedTurns([older, bare, twin]).map((k) => k.key).slice(1)).toEqual([
      first.key,
      second.key,
    ]);
  });

  it('keeps two unrecorded steps of the same kind and clock apart inside their turn', () => {
    const a: StepRow = { ...step, id: 'turn:1:x', eventIds: [] };
    const b: StepRow = { ...a, id: 'turn:1:y' };
    const [{ stepKeys }] = keyedTurns([{ ...turn, steps: [a, b] }]);
    expect(stepKeys).toHaveLength(2);
    expect(new Set(stepKeys).size).toBe(2);
  });

  it('keeps two steps with the same recorded id apart inside their turn', () => {
    const twinStep: StepRow = { ...step, id: 'turn:1:twin', eventIds: ['ev-1'] };
    const [{ stepKeys }] = keyedTurns([{ ...turn, steps: [step, twinStep] }]);
    expect(stepKeys).toHaveLength(2);
    expect(new Set(stepKeys).size).toBe(2);
  });

  it('escapes separators so a step key still names its own turn', () => {
    const key = stepRowKey('turn:1/x', 'a/b');
    expect(key.slice(2).split('/')).toHaveLength(2);
    expect(handoffKey(key, [key], [turnRowKey('turn:1/x')])).toBe(turnRowKey('turn:1/x'));
  });
});

describe('roving row set', () => {
  it('offers a turn with steps, then its steps once it is open', () => {
    const keyed = keyedTurns([turn, twoStepTurn, emptyTurn]);
    const [first, second] = keyed;
    expect(rovingKeys(keyed, new Set())).toEqual([turnRowKey(first.key), turnRowKey(second.key)]);
    expect(rovingKeys(keyed, new Set([second.key]))).toEqual([
      turnRowKey(first.key),
      turnRowKey(second.key),
      stepRowKey(second.key, second.stepKeys[0]),
      stepRowKey(second.key, second.stepKeys[1]),
    ]);
  });

  it('never makes a turn with nothing to reveal a stop', () => {
    const keyed = keyedTurns([emptyTurn]);
    expect(rovingKeys(keyed, new Set([keyed[0].key]))).toEqual([]);
  });

  it('keeps the reader’s row while it exists and falls back to the first row after', () => {
    const keyed = keyedTurns([turn, twoStepTurn]);
    const [first] = keyed;
    const keys = rovingKeys(keyed, new Set([first.key]));
    const stepKey = stepRowKey(first.key, first.stepKeys[0]);
    expect(resolveRovingKey(keys, stepKey)).toBe(stepKey);
    expect(resolveRovingKey(keys, turnRowKey('gone'))).toBe(turnRowKey(first.key));
    expect(resolveRovingKey([], turnRowKey(first.key))).toBeNull();
    expect(resolveRovingKey(keys, null)).toBe(turnRowKey(first.key));
  });
});

describe('focus handoff when the focused row goes', () => {
  // Plain keys: handoffKey only reasons about the order of the keys it is given.
  const closed = ['t:a', 't:b', 't:c'];
  const opened = ['t:a', 's:a/one', 's:a/two', 't:b'];

  it('puts a step’s focus back on the turn that closed around it', () => {
    expect(handoffKey('s:a/two', opened, closed)).toBe('t:a');
  });

  it('moves to the next surviving row when the focused turn is removed', () => {
    expect(handoffKey('t:a', closed, ['t:b', 't:c'])).toBe('t:b');
  });

  it('moves to the previous row when the last row is removed', () => {
    expect(handoffKey('t:c', closed, ['t:a', 't:b'])).toBe('t:b');
  });

  it('skips over rows that went with it, in both directions', () => {
    const before = [...opened, 't:b', 't:c'];
    // The whole open turn and its neighbour vanish: the next surviving row wins.
    expect(handoffKey('s:a/two', before, ['t:c'])).toBe('t:c');
    // Nothing after it survives: the nearest row before it is used.
    expect(handoffKey('t:c', before, ['t:b'])).toBe('t:b');
  });

  it('takes a step whose turn went as well to the nearest surviving row, not its old head', () => {
    expect(handoffKey('s:a/one', opened, ['t:b'])).toBe('t:b');
  });

  it('falls back to the first row when the lost row was never in the previous order', () => {
    expect(handoffKey('t:gone', closed, ['t:b'])).toBe('t:b');
  });

  it('has nowhere to go when the list is empty', () => {
    expect(handoffKey('t:a', closed, [])).toBeNull();
  });
});

describe('duplicate recorded ids', () => {
  const a: TurnRow = { ...turn, eventIds: ['dup'] };
  const b: TurnRow = { ...twoStepTurn, id: 'turn:4', eventIds: ['dup'], start: 1762400020 };

  it('gives the two rows their own keys, qualified by their clocks', () => {
    const [ka, kb] = keyedTurns([a, b]).map((k) => k.key);
    expect(ka).toBe('e:dup#1762400000');
    expect(kb).toBe('e:dup#1762400020');
    // A prepend does not touch either.
    const older: TurnRow = { ...emptyTurn, id: 'turn:9', eventIds: ['older'], start: 1 };
    expect(keyedTurns([older, a, b]).map((k) => k.key).slice(1)).toEqual([ka, kb]);
  });

  it('never renames a surviving duplicate onto the dropped one’s key', () => {
    const [dropped] = keyedTurns([a, b]).map((k) => k.key);
    const [survivor] = keyedTurns([b]);
    // It does change key when it is no longer a duplicate, but never to the dropped row's key,
    // so React cannot hand the dropped row's node to it.
    expect(survivor.key).not.toBe(dropped);
  });

  it('does not guess where a shared id went, so state cannot jump to the other row', () => {
    const ledger = rowLedger([a, b]);
    expect(ledger.turnAmbiguous.has('dup')).toBe(true);
    expect(ledger.turnOwnerRow.get('dup')).toBe('');
    expect(movedRow(turnRowKey('e:dup#1762400000'), 'dup', ledger)).toBeNull();

    // A unique id is followed as before.
    const single = rowLedger([{ ...a, eventIds: ['solo'] }, b]);
    expect(single.turnAmbiguous.has('solo')).toBe(false);
    expect(movedRow(turnRowKey('e:gone'), 'solo', single)).toBe(turnRowKey('e:solo'));
  });

  it('recovers the turn a row key belongs to', () => {
    expect(turnOfRowKey(turnRowKey('pre'))).toBe('pre');
    expect(turnOfRowKey(stepRowKey('pre', 'e:ev-91-1'))).toBe('pre');
    expect(turnOfRowKey('nonsense')).toBeNull();
  });
});

describe('auto-open rule', () => {
  const NOW = 1762400500;
  const keyMap = (rows: TurnRow[]) => new Map(keyedTurns(rows).map((k) => [k.turn, k.key]));

  it('opens a warning turn once, and not again when it grows', () => {
    const warn: TurnRow = { ...turn, status: 'warn' };
    expect(autoExpandKeys([warn], keyMap([warn]), new Set())).toEqual(['e:ev-1']);

    // One more step, same message: the key does not move, so nothing is treated as new.
    const grown: TurnRow = { ...warn, steps: [step, step2] };
    expect([...keyMap([grown]).values()]).toEqual(['e:ev-1']);
    expect(autoExpandKeys([grown], keyMap([grown]), new Set(['e:ev-1']))).toEqual([]);
  });

  it('leaves healthy turns closed', () => {
    expect(autoExpandKeys([turn], keyMap([turn]), new Set())).toEqual([]);
  });

  it('does not reopen the pre-message warning when a newer event appends', () => {
    const toolAt = (id: string, ts: number): OmniEvent =>
      ev({
        event_id: id,
        ts,
        kind: 'tool.end',
        status: 'ok',
        attrs: { tool_name: 'terminal', duration_ms: 10 },
      });
    const warn = (rows: TurnRow[]) => rows.map((r) => ({ ...r, status: 'warn' as const }));

    const before = warn(buildRows([toolAt('tool-6', 106)], NOW));
    const after = warn(buildRows([toolAt('tool-6', 106), toolAt('tool-8', 108)], NOW));
    expect(before[0].eventIds).toEqual(['tool-6']);
    expect(after[0].eventIds).toEqual(['tool-6', 'tool-8']);

    const seen = new Set(autoExpandKeys(before, keyMap(before), new Set()));
    expect([...seen]).toEqual(['pre']);
    expect(autoExpandKeys(after, keyMap(after), seen)).toEqual([]);
  });
});

describe('RunList turn headers', () => {
  it('exposes a turn with steps as a focusable disclosure, not a mouse-only div', () => {
    const html = renderToStaticMarkup(
      <RunList rows={[turn]} selectedEventId={null} playing={false} onSelectEvent={noop} />,
    );
    const head = headTag(html);
    expect(head).toContain('role="button"');
    expect(head).toContain('aria-expanded="false"');
    // Collapsed: there is no region to point aria-controls at yet.
    expect(head).not.toContain('aria-controls');
    expect(html).not.toContain('class="rl-steps"');
  });

  it('states that it is expanded and points at the steps it opened', () => {
    const html = renderTurn(turn, true);
    const head = headTag(html);
    expect(head).toContain('aria-expanded="true"');
    expect(head).toContain('aria-controls="rl-steps-turn-1"');
    expect(html).toContain('id="rl-steps-turn-1"');
    expect(html).toContain('class="rl-steps"');
  });

  it('leaves a turn with nothing to reveal as a plain, non-focusable row', () => {
    const html = renderToStaticMarkup(
      <RunList rows={[emptyTurn]} selectedEventId={null} playing={false} onSelectEvent={noop} />,
    );
    expect(html).toContain('class="rl-turn-head"');
    // No dead control: no button role, no tab stop, no expanded state, no handlers.
    const head = headTag(html);
    expect(head).not.toContain('role=');
    expect(head).not.toContain('tabindex');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('aria-controls');
    // The list itself is only a programmatic focus target, never a Tab stop.
    expect(html).toContain('class="rl-root"');
    expect(html).not.toContain('tabindex="0"');

    const headProps = headerProps(emptyTurn);
    expect(headProps.role).toBeUndefined();
    expect(headProps.tabIndex).toBeUndefined();
    expect(headProps.onClick).toBeUndefined();
    expect(headProps.onKeyDown).toBeUndefined();
  });

  it('hides the caret glyph from the accessible name, adding no stray text', () => {
    expect(renderTurn(turn)).toContain('<span class="rl-caret" aria-hidden="true">▸</span>');
  });
});

describe('RunList tab order', () => {
  it('gives a long run exactly one tab stop, not one per turn', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ...turn,
      id: `turn:${i + 10}`,
      eventIds: [`ev-${i}`],
    }));
    const html = renderToStaticMarkup(
      <RunList rows={rows} selectedEventId={null} playing={false} onSelectEvent={noop} />,
    );
    expect((html.match(/class="rl-turn-head"/g) ?? []).length).toBe(40);
    const stops = tabStops(html);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain('tabindex="0"');
    expect(stops[0]).toContain(`data-rl-key="${turnRowKey('e:ev-0')}"`);
  });

  it('keeps every other mounted row reachable but out of the tab order', () => {
    const html = renderTurn(twoStepTurn, true, turnRowKey(turnIdentity(twoStepTurn)));
    expect((html.match(/data-rl-key=/g) ?? []).length).toBe(3); // head plus two steps
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBe(2);
    expect(headTag(html)).toContain('tabindex="0"');
  });

  it('moves the single tab stop to the row the reader is on, including a step', () => {
    const stepKey = stepRowKey('e:ev-3', 'e:ev-2');
    const html = renderTurn(twoStepTurn, true, stepKey);
    expect(headTag(html)).toContain('tabindex="-1"');
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    const selectedTag = html.match(new RegExp(`<div[^>]*data-rl-key="${stepKey}"[^>]*>`))?.[0];
    expect(selectedTag).toContain('tabindex="0"');
  });

  it('does not add a tab stop for rows outside an open turn', () => {
    const html = renderToStaticMarkup(
      <RunList rows={[turn, emptyTurn, twoStepTurn]} selectedEventId={null} playing={false} onSelectEvent={noop} />,
    );
    expect(tabStops(html)).toHaveLength(1);
    expect(html).not.toContain('class="rl-steps"');
  });
});

describe('RunList turn header handlers', () => {
  function head() {
    const toggle = vi.fn();
    const [{ key, stepKeys }] = keyedTurns([turn]);
    const element = TurnLine({
      turn,
      rowKey: key,
      stepKeys,
      expanded: false,
      onToggle: toggle,
      selectedEventId: null,
      onSelectEvent: noop,
      activeKey: turnRowKey(key),
    });
    return { toggle, props: element.props.children[0].props };
  }

  it('toggles on click, Enter and Space through the handlers it renders', () => {
    const { toggle, props } = head();
    const preventDefault = vi.fn();

    props.onClick();
    expect(toggle).toHaveBeenCalledTimes(1);

    props.onKeyDown({ key: 'Enter', preventDefault });
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(preventDefault).not.toHaveBeenCalled();

    props.onKeyDown({ key: ' ', preventDefault });
    expect(toggle).toHaveBeenCalledTimes(3);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores held keys and shortcut combinations, and other keys', () => {
    const { toggle, props } = head();
    const preventDefault = vi.fn();

    props.onKeyDown({ key: 'Enter', repeat: true, preventDefault });
    props.onKeyDown({ key: ' ', repeat: true, preventDefault });
    props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault });
    props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault });
    props.onKeyDown({ key: ' ', altKey: true, preventDefault });
    for (const key of ['Tab', 'ArrowDown', 'a', 'Escape']) {
      props.onKeyDown({ key, preventDefault });
    }

    expect(toggle).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('RunList steps', () => {
  it('makes each step a focusable button-like row', () => {
    const html = renderToStaticMarkup(
      <StepLine
        step={step}
        selectedEventId={null}
        onSelectEvent={noop}
        rowKey={stepRowKey('turn:1', step.id)}
        activeKey={stepRowKey('turn:1', step.id)}
      />,
    );
    const tag = html.match(/<div[^>]*class="rl-step[^"]*"[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('role="button"');
    expect(tag).toContain('tabindex="0"');
    expect(tag).not.toContain('aria-current');
    expect(html).toContain('class="rl-step-icon" aria-hidden="true"');
  });

  it('marks the selected step as current for the reader', () => {
    const html = renderToStaticMarkup(
      <StepLine
        step={step}
        selectedEventId="ev-1"
        onSelectEvent={noop}
        rowKey={stepRowKey('turn:1', step.id)}
        activeKey={null}
      />,
    );
    expect(html).toContain('data-selected="1"');
    expect(html).toContain('aria-current="true"');
    // A row the reader is not on is still not a Tab stop.
    expect(html).toContain('tabindex="-1"');
  });

  it('selects its last event on click, Enter and Space', () => {
    const select = vi.fn();
    const props = StepLine({
      step,
      selectedEventId: null,
      onSelectEvent: select,
      rowKey: stepRowKey('turn:1', step.id),
      activeKey: null,
    }).props;
    const preventDefault = vi.fn();
    const keyDown = props.onKeyDown as (e: Record<string, unknown>) => void;

    props.onClick();
    expect(select).toHaveBeenLastCalledWith('ev-1');

    keyDown({ key: 'Enter', preventDefault });
    expect(select).toHaveBeenCalledTimes(2);

    keyDown({ key: ' ', preventDefault });
    expect(select).toHaveBeenCalledTimes(3);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores held and modified keys on a step', () => {
    const select = vi.fn();
    const props = StepLine({
      step,
      selectedEventId: null,
      onSelectEvent: select,
      rowKey: stepRowKey('turn:1', step.id),
      activeKey: null,
    }).props;
    const keyDown = props.onKeyDown as (e: Record<string, unknown>) => void;
    const preventDefault = vi.fn();

    keyDown({ key: 'Enter', repeat: true, preventDefault });
    keyDown({ key: ' ', repeat: true, preventDefault });
    keyDown({ key: 'Enter', ctrlKey: true, preventDefault });
    keyDown({ key: ' ', altKey: true, preventDefault });

    expect(select).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not fail on a step with no event to select', () => {
    const select = vi.fn();
    const bare: StepRow = { ...step, id: 'turn:1:gap', kind: 'gap', eventIds: [] };
    const props = StepLine({
      step: bare,
      selectedEventId: null,
      onSelectEvent: select,
      rowKey: stepRowKey('turn:1', bare.id),
      activeKey: null,
    }).props;

    props.onClick();
    (props.onKeyDown as (e: Record<string, unknown>) => void)({
      key: 'Enter',
      preventDefault: noop,
    });

    expect(select).not.toHaveBeenCalled();
  });
});
