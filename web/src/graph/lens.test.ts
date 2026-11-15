import { describe, expect, it } from 'vitest';
import type { OmniEvent } from '../types';
import {
  LENS_MAX_GROUPS,
  buildLensGroups,
  buildLensView,
  LENS_MAX_TEXT_CHARS,
  chooseGroupIndices,
  groupIndexForEvent,
  lensCategoryOf,
  lensCursorIndex,
  lensReplayState,
  lensStatusOf,
  lensTypeText,
  replayPrefixCount,
  seekIndexForGroup,
  selectLensView,
} from './lens';

function ev(index: number, kind: string, partial: Partial<OmniEvent> = {}): OmniEvent {
  return {
    rowid: index + 1,
    event_id: `evt-${index}`,
    schema: 'omni.v1',
    boot_id: 'boot',
    seq: index + 1,
    ts: 1762400000 + index,
    kind,
    session_id: 'root',
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: {},
    ...partial,
  };
}

function tool(index: number, name: string, partial: Partial<OmniEvent> = {}): OmniEvent {
  return ev(index, 'tool.end', { attrs: { tool_name: name, duration_ms: 20 }, ...partial });
}

describe('run lens ordering and grouping', () => {
  it('keeps recorded order and merges only adjacent events with the same kind, tool and status', () => {
    const events = [
      tool(0, 'terminal'),
      tool(1, 'terminal'),
      tool(2, 'read_file'),
      ev(3, 'llm.request'),
      ev(4, 'llm.response'),
      tool(5, 'terminal'),
    ];
    const view = buildLensView(events, { timezoneOffsetMinutes: 0 });

    expect(view.groups.map((group) => [group.kind, group.toolName, group.count, group.firstIndex, group.lastIndex])).toEqual([
      ['tool.end', 'terminal', 2, 0, 1],
      ['tool.end', 'read_file', 1, 2, 2],
      ['llm.request', null, 1, 3, 3],
      ['llm.response', null, 1, 4, 4],
      ['tool.end', 'terminal', 1, 5, 5],
    ]);
    expect(view.groups.reduce((total, group) => total + group.count, 0)).toBe(events.length);
    expect(view.sampled).toBe(false);
    expect(view.omittedEvents).toBe(0);
  });

  it('is deterministic: the same input produces deeply equal output', () => {
    const events = [tool(0, 'terminal'), tool(1, 'terminal'), ev(2, 'llm.error', { status: 'error' }), ev(3, 'turn.end', { status: 'ok' })];
    const first = buildLensView(events, { replayIndex: 2, selectedEventId: 'evt-0', timezoneOffsetMinutes: 0 });
    const second = buildLensView(events, { replayIndex: 2, selectedEventId: 'evt-0', timezoneOffsetMinutes: 0 });
    expect(second).toEqual(first);
  });

  it('selects from cached groups exactly as the one-call builder does', () => {
    const events = Array.from({ length: 40 }, (_, index) => tool(index, index % 2 ? 'terminal' : 'read_file'));
    const groups = buildLensGroups(events, 0);
    const cached = selectLensView(groups, events.length, { replayIndex: 11, selectedEventId: 'evt-7' });
    const oneCall = buildLensView(events, {
      replayIndex: 11,
      selectedEventId: 'evt-7',
      timezoneOffsetMinutes: 0,
    });
    expect(cached).toEqual(oneCall);
    expect(groups).toHaveLength(40);
    expect(cached.groups.length).toBeLessThanOrEqual(LENS_MAX_GROUPS);
  });

  it('does not reorder or drop events with duplicate, missing or zero timestamps', () => {
    const events = [
      tool(0, 'terminal', { ts: 100 }),
      tool(1, 'terminal', { ts: 100 }),
      tool(2, 'read_file', { ts: 0 }),
      tool(3, 'read_file', { ts: Number.NaN }),
      ev(4, 'llm.request', { ts: 0 }),
      ev(5, 'turn.end', { ts: 900 }),
    ];
    const view = buildLensView(events, { timezoneOffsetMinutes: 0 });
    expect(view.groups).toHaveLength(4);
    expect(view.groups[0]).toMatchObject({ count: 2, firstIndex: 0, lastIndex: 1, missingTimeCount: 0 });
    expect(view.groups[0].timeRangeLabel).toBe('00:01');
    expect(view.groups[1]).toMatchObject({ count: 2, firstIndex: 2, lastIndex: 3, missingTimeCount: 2 });
    expect(view.groups[1].timeLabel).toBe('time not recorded');
    expect(view.groups[2]).toMatchObject({ firstIndex: 4, missingTimeCount: 1 });
    expect(view.groups[3]).toMatchObject({ firstIndex: 5, timeLabel: '00:15' });
    expect(view.groups.flatMap((group) => group.eventIds)).toEqual(events.map((event) => event.event_id));
  });

  it('labels a group from the first time it does have, and says how many are missing', () => {
    const view = buildLensView(
      [tool(0, 'terminal', { ts: 0 }), tool(1, 'terminal', { ts: 100 }), tool(2, 'terminal', { ts: 160 })],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({
      count: 3,
      missingTimeCount: 1,
      firstTs: 100,
      lastTs: 160,
      timeRangeLabel: '00:01–00:02',
    });
  });

  it('keeps different tool names apart instead of collapsing them into one tool bucket', () => {
    const view = buildLensView([tool(0, 'terminal'), tool(1, 'read_file'), tool(2, 'browser_navigate')], {
      timezoneOffsetMinutes: 0,
    });
    expect(view.groups).toHaveLength(3);
    expect(view.groups.map((group) => group.toolName)).toEqual(['terminal', 'read_file', 'browser_navigate']);
    expect(view.groups.map(lensTypeText)).toEqual([
      'Tool call ended · terminal',
      'Tool call ended · read_file',
      'Tool call ended · browser_navigate',
    ]);
  });
});

describe('run lens bounds and sampling', () => {
  it('caps the set, keeps recorded order and includes first, last, selected and failure moments', () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: 'terminal' },
        status: index === 30 ? 'error' : null,
      }),
    );
    const view = buildLensView(events, {
      maxGroups: 8,
      selectedEventId: 'evt-44',
      replayIndex: 22,
      timezoneOffsetMinutes: 0,
    });

    expect(view.limit).toBe(8);
    expect(view.totalGroups).toBe(60);
    expect(view.groups.length).toBeLessThanOrEqual(8);
    expect(view.sampled).toBe(true);
    expect(view.omittedGroups).toBe(60 - view.groups.length);
    expect(view.groups[0].firstIndex).toBe(0);
    expect(view.groups.at(-1)?.lastIndex).toBe(59);
    expect(view.groups.some((group) => group.firstIndex === 30 && group.failure)).toBe(true);
    expect(view.groups.some((group) => group.firstIndex === 44)).toBe(true);
    expect(view.groups.map((group) => group.firstIndex)).toEqual(
      [...view.groups.map((group) => group.firstIndex)].sort((a, b) => a - b),
    );
    expect(view.groups.reduce((total, group) => total + group.count, 0) + view.omittedEvents).toBe(60);
    expect(view.omittedEvents).toBeGreaterThan(0);

    const again = buildLensView(events, {
      maxGroups: 8,
      selectedEventId: 'evt-44',
      replayIndex: 22,
      timezoneOffsetMinutes: 0,
    });
    expect(again).toEqual(view);
  });

  it('honours tiny and invalid caps without growing past the cap or overflowing the run', () => {
    const groups = Array.from({ length: 20 }, () => ({ failure: false }));
    expect(chooseGroupIndices(groups, 1, -1, -1)).toEqual([0]);
    expect(chooseGroupIndices(groups, 0, -1, -1)).toHaveLength(1);
    expect(chooseGroupIndices(groups, 3, -1, -1)).toEqual([0, 10, 19]);
    expect(chooseGroupIndices(groups, Number.NaN, -1, -1)).toHaveLength(LENS_MAX_GROUPS);
    expect(chooseGroupIndices([], 8, -1, -1)).toEqual([]);
  });

  it('spreads the sample across the whole run instead of stopping halfway', () => {
    const groups = Array.from({ length: 60 }, () => ({ failure: false }));
    const indices = chooseGroupIndices(groups, LENS_MAX_GROUPS, -1, -1);

    expect(indices).toHaveLength(LENS_MAX_GROUPS);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(59);
    // One marker every few groups all the way out, not 29 positions of empty space at the end.
    const gaps = indices.slice(1).map((index, at) => index - indices[at]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6);
    expect(indices.some((index) => index > 30 && index < 59)).toBe(true);
  });

  it('lets Next reach a moment past the old halfway stop', () => {
    const groups = Array.from({ length: 60 }, () => ({ failure: false }));
    const indices = chooseGroupIndices(groups, LENS_MAX_GROUPS, -1, -1);
    const afterThirty = indices.findIndex((index) => index > 30);
    expect(afterThirty).toBeGreaterThan(0);
    expect(indices[afterThirty]).toBeLessThan(59);
  });

  it('keeps explicit failures that fit and says how many the sample leaves out', () => {
    const failureAt = new Set([3, 30, 50]);
    const fits = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: 'terminal' },
        status: failureAt.has(index) ? 'error' : 'ok',
      }),
    );
    const kept = buildLensView(fits, { maxGroups: LENS_MAX_GROUPS, timezoneOffsetMinutes: 0 });
    expect(kept.groups.filter((group) => group.failure).map((group) => group.firstIndex)).toEqual([3, 30, 50]);
    expect(kept.omittedFailures).toBe(0);

    const manyFailures = new Set(Array.from({ length: 19 }, (_, index) => index * 3));
    const crowded = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: 'terminal' },
        status: manyFailures.has(index) ? 'error' : 'ok',
      }),
    );
    const sampled = buildLensView(crowded, { maxGroups: LENS_MAX_GROUPS, timezoneOffsetMinutes: 0 });
    const shownFailures = sampled.groups.filter((group) => group.failure).length;
    expect(shownFailures).toBeGreaterThan(0);
    expect(shownFailures + sampled.omittedFailures).toBe(19);
    expect(sampled.omittedFailures).toBeGreaterThan(0);
    // Failures that are kept are spread over the run rather than clipped at the start.
    expect(sampled.groups.some((group) => group.failure && group.firstIndex > 30)).toBe(true);
  });

  it('counts omitted failure moment groups, not omitted failing steps', () => {
    const events: OmniEvent[] = [];
    let row = 0;
    for (let groupIndex = 0; groupIndex < 30; groupIndex += 1) {
      if (groupIndex === 15) {
        // Four adjacent failed terminal steps are one moment, not four.
        for (let step = 0; step < 4; step += 1) {
          events.push(tool(row, 'terminal', { status: 'error' }));
          row += 1;
        }
      } else {
        events.push(ev(row, groupIndex % 2 === 0 ? 'llm.request' : 'turn.end'));
        row += 1;
      }
    }
    const groups = buildLensGroups(events, 0);
    expect(groups).toHaveLength(30);
    expect(groups[15]).toMatchObject({ count: 4, failure: true });

    const view = selectLensView(groups, events.length, { maxGroups: 2 });
    expect(view.groups.map((group) => group.firstIndex)).toEqual([
      0,
      groups[29].firstIndex,
    ]);
    expect(view.omittedFailures).toBe(1);
    // The omitted failing moment stands for four steps, so the two counts differ.
    expect(view.omittedEvents).toBeGreaterThanOrEqual(4);
    expect(view.omittedEvents).not.toBe(view.omittedFailures);
  });

  it('leaves the even fill out when failure moments reach the cap, so the sample can cluster', () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: 'terminal' },
        status: index < 20 ? 'error' : 'ok',
      }),
    );
    const groups = buildLensGroups(events, 0);
    const chosen = chooseGroupIndices(groups, LENS_MAX_GROUPS, -1, -1);
    expect(chosen).toHaveLength(LENS_MAX_GROUPS);
    const gaps = chosen.slice(1).map((index, at) => index - chosen[at]);
    // An even 16-marker fill over 60 groups never leaves a gap this wide; the failure picks took
    // the slots and the even fill was skipped, so "sampled across the recording" would be a lie.
    expect(Math.max(...gaps)).toBeGreaterThan(10);
    // Most of the 16 slots went to failure moments clustered at the start of the run.
    expect(chosen.filter((index) => groups[index].failure).length).toBeGreaterThanOrEqual(13);
  });

  it('marks only groups that genuinely contain an explicit failure', () => {
    const view = buildLensView(
      [
        ev(0, 'llm.request', { status: 'error' }),
        ev(1, 'llm.request', { status: 'unknown_word' }),
        ev(2, 'llm.request', { status: null }),
        ev(3, 'tool.end', { status: 'failed', attrs: { tool_name: 'terminal' } }),
        ev(4, 'llm.error', { status: null }),
      ],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups.map((group) => [group.status, group.tone, group.failure])).toEqual([
      ['error', 'error', true],
      ['unknown_word', 'unknown', false],
      [null, 'unknown', false],
      ['failed', 'error', true],
      [null, 'unknown', false],
    ]);
  });

  it('bounds a 5,000-event stream to the marker cap without one element per event', () => {
    const events = Array.from({ length: 5_000 }, (_, index) =>
      ev(index, index % 3 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: index % 2 === 0 ? 'terminal' : 'read_file' },
      }),
    );
    const view = buildLensView(events, { maxGroups: LENS_MAX_GROUPS, timezoneOffsetMinutes: 0 });
    expect(view.totalGroups).toBe(5_000);
    expect(view.totalEvents).toBe(5_000);
    expect(view.groups).toHaveLength(LENS_MAX_GROUPS);
    expect(view.sampled).toBe(true);
    expect(view.groups[0].firstIndex).toBe(0);
    expect(view.groups.at(-1)?.lastIndex).toBe(4_999);
    expect(view.groups.reduce((total, group) => total + group.count, 0) + view.omittedEvents).toBe(5_000);

    // The sample has to reach the far half of the recording, not stop near 2,500.
    const indices = view.groups.map((group) => group.firstIndex);
    const gaps = indices.slice(1).map((index, at) => index - indices[at]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(400);
    expect(indices.some((index) => index > 2_500 && index < 4_999)).toBe(true);
  });
});

describe('run lens privacy', () => {
  it('never copies private attributes, models, prompts, arguments or outputs', () => {
    const secret = {
      user_text: 'PRIVATE-USER-TEXT',
      assistant_text: 'PRIVATE-ASSISTANT-TEXT',
      prompt: 'PRIVATE-PROMPT',
      messages: [{ content: 'PRIVATE-MESSAGE' }],
      args: { api_key: 'PRIVATE-API-KEY' },
      result: 'PRIVATE-TOOL-OUTPUT',
      model: 'PRIVATE-MODEL-NAME',
      status: 'error',
    };
    const events = [
      ev(0, 'tool.end', { attrs: { tool_name: 'terminal', ...secret }, status: null }),
      ev(1, 'llm.response', { attrs: secret, status: null }),
    ];
    const serialized = JSON.stringify(buildLensView(events, { timezoneOffsetMinutes: 0 }));
    for (const value of [
      'PRIVATE-USER-TEXT',
      'PRIVATE-ASSISTANT-TEXT',
      'PRIVATE-PROMPT',
      'PRIVATE-MESSAGE',
      'PRIVATE-API-KEY',
      'PRIVATE-TOOL-OUTPUT',
      'PRIVATE-MODEL-NAME',
    ]) {
      expect(serialized).not.toContain(value);
    }
    // A status tucked into attrs is not the recorded status field: the lens must not promote it.
    const view = buildLensView(events, { timezoneOffsetMinutes: 0 });
    expect(view.groups.every((group) => group.status === null && group.tone === 'unknown')).toBe(true);
  });
});

describe('run lens replay semantics', () => {
  const events = [
    tool(0, 'terminal'),
    tool(1, 'terminal'),
    ev(2, 'llm.request'),
    ev(3, 'llm.response'),
    ev(4, 'turn.end', { status: 'ok' }),
    ev(5, 'session.end', { status: 'completed' }),
  ];

  it('clamps the replay prefix instead of copying the Array.slice edge cases', () => {
    expect(replayPrefixCount(null, 6)).toBe(6);
    expect(replayPrefixCount(-3, 6)).toBe(0);
    expect(replayPrefixCount(99, 6)).toBe(6);
    expect(replayPrefixCount(2.9, 6)).toBe(2);
    expect(replayPrefixCount(Number.NaN, 6)).toBe(6);
    // The viewer now uses this same clamp, so the ring and the replay cannot disagree. A raw
    // Array.slice would answer 3 and 0 for these two values.
    expect([0, 1, 2, 3, 4, 5].slice(0, -3)).toHaveLength(3);
    expect([0, 1, 2, 3, 4, 5].slice(0, Number.NaN)).toHaveLength(0);
  });

  it('treats an index at or past the total as live, and a negative index as replay at zero', () => {
    const live = buildLensView(events, { replayIndex: 6, timezoneOffsetMinutes: 0 });
    expect(live.replayIndex).toBeNull();
    expect(live.replayCount).toBe(6);
    expect(live.groups.every((group) => group.replayState === 'all')).toBe(true);

    const zero = buildLensView(events, { replayIndex: -2, timezoneOffsetMinutes: 0 });
    expect(zero.replayIndex).toBe(0);
    expect(zero.replayCount).toBe(0);
    expect(zero.groups.every((group) => group.replayState === 'none')).toBe(true);
  });

  it('calls a group all, partial or none relative to the prefix', () => {
    const group = { firstIndex: 1, lastIndex: 2 };
    expect(lensReplayState(group, null, 6)).toBe('all');
    expect(lensReplayState(group, 3, 6)).toBe('all');
    expect(lensReplayState(group, 2, 6)).toBe('partial');
    expect(lensReplayState(group, 1, 6)).toBe('none');
    expect(lensReplayState(group, 0, 6)).toBe('none');
  });

  it('seeks to the end of a group and returns live at the end of the recording', () => {
    expect(seekIndexForGroup({ lastIndex: 0 }, 6)).toBe(1);
    expect(seekIndexForGroup({ lastIndex: 2 }, 6)).toBe(3);
    expect(seekIndexForGroup({ lastIndex: 5 }, 6)).toBeNull();
    expect(seekIndexForGroup({ lastIndex: 0 }, 0)).toBeNull();
  });

  it('finds the replay cursor and the selected group', () => {
    const groups = [
      { firstIndex: 0 },
      { firstIndex: 1 },
      { firstIndex: 3 },
      { firstIndex: 5 },
    ];
    expect(lensCursorIndex(groups, null, 6)).toBe(3);
    expect(lensCursorIndex(groups, 0, 6)).toBe(-1);
    expect(lensCursorIndex(groups, 1, 6)).toBe(0);
    expect(lensCursorIndex(groups, 4, 6)).toBe(2);
    expect(lensCursorIndex([], null, 6)).toBe(-1);

    const view = buildLensView(events, { replayIndex: 3, selectedEventId: 'evt-3', timezoneOffsetMinutes: 0 });
    expect(view.replayCount).toBe(3);
    expect(view.groups.map((group) => group.replayState)).toEqual(['all', 'all', 'none', 'none', 'none']);
    expect(view.selectedGroupIndex).toBe(2);
    expect(view.cursorGroupIndex).toBe(1);
    expect(groupIndexForEvent(view.groups, 'evt-3')).toBe(2);
    expect(groupIndexForEvent(view.groups, 'missing')).toBe(-1);
    expect(groupIndexForEvent(view.groups, null)).toBe(-1);
  });
});

describe('run lens recorded text', () => {
  it('falls back to attrs.tool when tool_name is empty, matching the Python labels', () => {
    const view = buildLensView(
      [ev(0, 'tool.end', { attrs: { tool_name: '', tool: 'terminal' } })],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups[0].toolName).toBe('terminal');
  });

  it('bounds free-text statuses and tool names and strips control characters', () => {
    const noisyStatus = `line\none ${'x'.repeat(200)}`;
    const noisyTool = `term${'y'.repeat(200)}`;
    const view = buildLensView(
      [ev(0, 'tool.end', { status: noisyStatus, attrs: { tool_name: noisyTool } })],
      { timezoneOffsetMinutes: 0 },
    );
    const group = view.groups[0];
    // The recorded value stays intact for grouping; only the display text is bounded.
    expect(group.status).toBe(noisyStatus.trim());
    expect(group.statusLabel.length).toBeLessThanOrEqual(LENS_MAX_TEXT_CHARS);
    expect(group.statusLabel).not.toContain('\n');
    const type = lensTypeText(group);
    expect(type).not.toContain('\n');
    expect(type).toContain('…');
    expect(type.length).toBeLessThanOrEqual(LENS_MAX_TEXT_CHARS * 2 + 3);
  });

  it('keeps a recorded range from running backwards when timestamps regress', () => {
    // Two adjacent steps for the same tool: recorded order says 1000 then 940.
    const view = buildLensView(
      [tool(0, 'terminal', { ts: 1000 }), tool(1, 'terminal', { ts: 940 })],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups[0]).toMatchObject({ count: 2, firstTs: 940, lastTs: 1000 });
    expect(view.groups[0].timeLabel).toBe('00:15');
    expect(view.groups[0].timeRangeLabel).toBe('00:15–00:16');
    expect(view.groups[0].timeRangeLabel).not.toMatch(/^(\d\d:\d\d)–\1$/);
  });

  it('shows one time, not a same-minute range, when both ends display alike', () => {
    const view = buildLensView(
      [tool(0, 'terminal', { ts: 100 }), tool(1, 'terminal', { ts: 110 })],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups[0]).toMatchObject({ firstTs: 100, lastTs: 110 });
    expect(view.groups[0].timeRangeLabel).toBe('00:01');
  });

  it('names the date when a group crosses local midnight', () => {
    const start = Date.UTC(2026, 0, 3, 23, 58) / 1000;
    const view = buildLensView(
      [
        ev(0, 'tool.end', { ts: start, attrs: { tool_name: 'terminal' } }),
        ev(1, 'tool.end', { ts: start + 5 * 60, attrs: { tool_name: 'terminal' } }),
      ],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups[0].timeRangeLabel).toBe('Jan 3 23:58–Jan 4 00:03');
  });

  it('names the year when a group crosses a new year', () => {
    const start = Date.UTC(2025, 11, 31, 23, 58) / 1000;
    const view = buildLensView(
      [
        ev(0, 'tool.end', { ts: start, attrs: { tool_name: 'terminal' } }),
        ev(1, 'tool.end', { ts: start + 5 * 60, attrs: { tool_name: 'terminal' } }),
      ],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups[0].timeRangeLabel).toBe('Dec 31 2025 23:58–Jan 1 2026 00:03');
  });

  it('keeps the short clock range for a group inside one local day', () => {
    const start = Date.UTC(2026, 0, 3, 23, 50) / 1000;
    const view = buildLensView(
      [
        ev(0, 'tool.end', { ts: start, attrs: { tool_name: 'terminal' } }),
        ev(1, 'tool.end', { ts: start + 5 * 60, attrs: { tool_name: 'terminal' } }),
      ],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups[0].timeRangeLabel).toBe('23:50–23:55');
  });
});

describe('run lens edge cases', () => {
  it('handles an empty recording without inventing a moment', () => {
    const view = buildLensView([], { timezoneOffsetMinutes: 0 });
    expect(view).toMatchObject({
      totalEvents: 0,
      totalGroups: 0,
      groups: [],
      sampled: false,
      omittedGroups: 0,
      omittedEvents: 0,
      selectedGroupIndex: -1,
      cursorGroupIndex: -1,
      replayCount: 0,
    });
  });

  it('handles a single event and group counts', () => {
    const view = buildLensView([tool(0, 'terminal')], { timezoneOffsetMinutes: 0 });
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({ count: 1, firstIndex: 0, lastIndex: 0, replayState: 'all' });
  });

  it('keeps unfamiliar kinds and statuses visible instead of guessing', () => {
    const view = buildLensView(
      [ev(0, 'future.event', { status: 'deferred' }), ev(1, 'omni.dropped')],
      { timezoneOffsetMinutes: 0 },
    );
    expect(view.groups[0]).toMatchObject({
      category: 'other',
      categoryLabel: 'other',
      kind: 'future.event',
      status: 'deferred',
      tone: 'unknown',
      failure: false,
    });
    expect(view.groups[0].statusLabel).toBe('deferred');
    expect(view.groups[1].category).toBe('lost');
    expect(view.groups[1].statusLabel).toBe('status not recorded');
    expect(lensCategoryOf('llm.error')).toBe('model');
    expect(lensCategoryOf('tool.end')).toBe('tool');
    expect(lensCategoryOf('subagent.stop')).toBe('helper');
    expect(lensCategoryOf('aux.response')).toBe('background');
  });

  it('gives an unlabelled recorded step a readable type instead of a blank marker', () => {
    const view = buildLensView([ev(0, '')], { timezoneOffsetMinutes: 0 });
    expect(lensTypeText(view.groups[0])).toBe('Recorded step');
  });

  it('keeps the recorded word for success-like statuses and never treats unknown as error', () => {
    expect(lensStatusOf('completed')).toEqual({ status: 'completed', statusLabel: 'completed', tone: 'ok', failure: false });
    expect(lensStatusOf('failed')).toEqual({ status: 'failed', statusLabel: 'failed', tone: 'error', failure: true });
    expect(lensStatusOf('in_progress').tone).toBe('running');
    expect(lensStatusOf('interrupted').tone).toBe('stopped');
    expect(lensStatusOf(null)).toEqual({
      status: null,
      statusLabel: 'status not recorded',
      tone: 'unknown',
      failure: false,
    });
    expect(lensStatusOf('   ').tone).toBe('unknown');
  });
});
