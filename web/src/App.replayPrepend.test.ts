import { describe, expect, it } from 'vitest';
import type { OmniEvent } from './types';
import { countPrependedEvents, replayAfterPrepend } from './App';

function ev(rowid: number): OmniEvent {
  return {
    rowid,
    event_id: `evt-${rowid}`,
    schema: 'omni.v1',
    boot_id: 'boot',
    seq: rowid,
    ts: 1762400000 + rowid,
    kind: 'llm.request',
    session_id: 'root',
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: {},
  };
}

describe('load earlier while replaying', () => {
  it('shifts an active replay past the prepended steps and leaves live replay live', () => {
    expect(replayAfterPrepend(12, 5)).toBe(17);
    expect(replayAfterPrepend(0, 5)).toBe(5);
    expect(replayAfterPrepend(12, 0)).toBe(12);
    expect(replayAfterPrepend(null, 5)).toBeNull();
    // A malformed count is no reason to move the replay.
    expect(replayAfterPrepend(12, -3)).toBe(12);
    expect(replayAfterPrepend(12, Number.NaN)).toBe(12);
  });

  it('counts only steps that are new and really in front of the loaded window', () => {
    const existing = [ev(10), ev(11), ev(12)];
    expect(countPrependedEvents(existing, [ev(7), ev(8), ev(9)])).toBe(3);
    // A page that overlaps the loaded window only contributes the steps before it.
    expect(countPrependedEvents(existing, [ev(8), ev(9), ev(10), ev(11)])).toBe(2);
    // A repeated rowid in one page is one step; appendEvents drops the repeat.
    expect(countPrependedEvents(existing, [ev(8), ev(8)])).toBe(1);
    // Nothing in front, nothing to shift.
    expect(countPrependedEvents(existing, [ev(10), ev(11)])).toBe(0);
    expect(countPrependedEvents(existing, [])).toBe(0);
    // With nothing loaded yet, every finite earlier step is a prepend.
    expect(countPrependedEvents([], [ev(1), ev(2)])).toBe(2);
  });

  it('keeps the replay boundary on the same recorded step after earlier steps load', () => {
    const loaded = [ev(10), ev(11), ev(12), ev(13), ev(14)];
    const earlier = [ev(5), ev(6), ev(7), ev(8), ev(9)];
    const merged = [...earlier, ...loaded];
    const shift = countPrependedEvents(loaded, earlier);

    for (const replay of [1, 3, 5]) {
      // The boundary is the last replayed step: it must still be the same recorded step, now with
      // the newly loaded older steps included in front of it (that is what loading earlier is for).
      const before = loaded[replay - 1].event_id;
      const after = replayAfterPrepend(replay, shift) ?? merged.length;
      expect(merged.slice(0, after).at(-1)?.event_id).toBe(before);
      expect(merged.slice(0, after).map((event) => event.event_id)).toEqual(
        [...earlier, ...loaded.slice(0, replay)].map((event) => event.event_id),
      );
    }

    // Replay at zero is the boundary before the previously loaded first step. After the older steps
    // are inserted, that same boundary sits just past them, so they are what it replays; it does not
    // slide to the start of the larger recording.
    const atZero = replayAfterPrepend(0, shift) ?? merged.length;
    expect(merged.slice(0, atZero).map((event) => event.event_id)).toEqual(
      earlier.map((event) => event.event_id),
    );
    expect(atZero).toBe(shift);
  });
});
