import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../types';
import {
  chatWindowCounts,
  inChatWindow,
  sortChats,
  sortSessions,
  withinChatWindow,
  windowAppliesTo,
  workingSessionId,
  WORKING_WINDOW_S,
} from './sessions';

function chat(id: string, last: number | null, first: number | null = last, events = 10): SessionMeta {
  return { id, last_ts: last, first_ts: first, events };
}

describe('sortSessions', () => {
  const rows = [chat('mid', 1000), chat('new', 3000), chat('old', 500)];

  it('most recent puts the freshest chat first', () => {
    expect(sortSessions(rows, 'recent').map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('oldest first is the exact reverse', () => {
    expect(sortSessions(rows, 'oldest').map((s) => s.id)).toEqual(['old', 'mid', 'new']);
  });

  it('busiest uses the step count, then recency for ties', () => {
    const bySteps = [chat('a', 10, 10, 5), chat('b', 20, 20, 50), chat('c', 30, 30, 5)];
    expect(sortSessions(bySteps, 'busiest').map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('never mutates the array it was given', () => {
    const input = [chat('x', 1), chat('y', 2)];
    const copy = input.map((s) => s.id);
    sortSessions(input, 'recent');
    expect(input.map((s) => s.id)).toEqual(copy);
  });

  it('a chat with no timestamps sorts last, not first', () => {
    const mixed = [chat('none', null, null), chat('real', 100)];
    expect(sortSessions(mixed, 'recent').map((s) => s.id)).toEqual(['real', 'none']);
  });

  it('equal recency is broken by the chat start, stably', () => {
    const tied = [chat('older-start', 500, 100), chat('later-start', 500, 400)];
    expect(sortSessions(tied, 'recent').map((s) => s.id)).toEqual(['later-start', 'older-start']);
    expect(sortSessions(tied, 'oldest').map((s) => s.id)).toEqual(['older-start', 'later-start']);
  });

  it('handles an empty list', () => {
    expect(sortSessions([], 'recent')).toEqual([]);
  });
});

describe('workingSessionId', () => {
  const now = 10_000;

  it('picks the freshest chat inside the window', () => {
    const rows = [chat('quiet', now - 500), chat('busy', now - 5), chat('recent', now - 40)];
    expect(workingSessionId(rows, now)).toBe('busy');
  });

  it('returns null when every chat is older than the window', () => {
    const rows = [chat('a', now - WORKING_WINDOW_S - 1), chat('b', now - 900)];
    expect(workingSessionId(rows, now)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(workingSessionId([], now)).toBeNull();
  });

  it('ignores timestamps in the future (clock skew must not pin a chat forever)', () => {
    expect(workingSessionId([chat('skewed', now + 5000)], now)).toBeNull();
  });

  it('ignores chats with no timestamp at all', () => {
    expect(workingSessionId([chat('none', null, null)], now)).toBeNull();
  });

  it('a custom window widens or narrows what counts', () => {
    const rows = [chat('a', now - 120)];
    expect(workingSessionId(rows, now)).toBeNull();
    expect(workingSessionId(rows, now, 300)).toBe('a');
  });
});

describe('sortChats', () => {
  const a: SessionMeta = { id: 'a', prompt_max: 20_000, output: 100, calls: 9, last_ts: 300 };
  const b: SessionMeta = { id: 'b', prompt_max: 200_000, output: 50, calls: 3, last_ts: 100 };
  const c: SessionMeta = { id: 'c', prompt_max: null, output: 900, calls: 40, last_ts: 200 };

  it('biggest context first is the default question: what needs fixing', () => {
    expect(sortChats([a, b, c], 'context').map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('recent orders by the last event', () => {
    expect(sortChats([a, b, c], 'recent').map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('output and calls order by their own total', () => {
    expect(sortChats([a, b, c], 'output').map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(sortChats([a, b, c], 'calls').map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('ranks by the context now, so a compacted chat stops being the expensive one', () => {
    const big: SessionMeta = { id: 'big', prompt_max: 400_000, prompt_now: 50_000, last_ts: 1 };
    const live: SessionMeta = { id: 'live', prompt_max: 300_000, prompt_now: 300_000, last_ts: 2 };
    expect(sortChats([big, live], 'context').map((s) => s.id)).toEqual(['live', 'big']);
  });

  it('breaks ties by recency and never mutates its input', () => {
    const x: SessionMeta = { id: 'x', prompt_max: 5, last_ts: 1 };
    const y: SessionMeta = { id: 'y', prompt_max: 5, last_ts: 9 };
    const input = [x, y];
    expect(sortChats(input, 'context').map((s) => s.id)).toEqual(['y', 'x']);
    expect(input.map((s) => s.id)).toEqual(['x', 'y']);
  });
});

describe('chat window', () => {
  // 15:00 local, so "six hours ago" is still today and "eighteen hours ago" is yesterday.
  const NOW = Math.floor(new Date(2026, 10, 9, 15, 0, 0).getTime() / 1000);
  const rows = [
    chat('now', NOW - 120),
    chat('twenty-min', NOW - 20 * 60),
    chat('two-hours', NOW - 2 * 3600),
    chat('six-hours', NOW - 6 * 3600),
    chat('yesterday', NOW - 18 * 3600),
    chat('undated', null, null),
  ];

  it('the last hour keeps only what ran in the last hour', () => {
    expect(withinChatWindow(rows, 'hour', NOW).map((c) => c.id)).toEqual(['now', 'twenty-min']);
  });

  it('today keeps everything since local midnight and no further back', () => {
    expect(withinChatWindow(rows, 'today', NOW).map((c) => c.id)).toEqual([
      'now', 'twenty-min', 'two-hours', 'six-hours',
    ]);
  });

  it('all chats keeps everything, including a chat with no timestamp', () => {
    expect(withinChatWindow(rows, 'all', NOW).map((c) => c.id)).toEqual([
      'now', 'twenty-min', 'two-hours', 'six-hours', 'yesterday', 'undated',
    ]);
  });

  it('an undated chat is never presented as recent', () => {
    expect(inChatWindow(chat('undated', null, null), 'hour', NOW)).toBe(false);
    expect(inChatWindow(chat('undated', null, null), 'today', NOW)).toBe(false);
  });

  it('the chat already open stays in the list even when it is older than the window', () => {
    expect(withinChatWindow(rows, 'hour', NOW, 'two-hours').map((c) => c.id)).toEqual([
      'now', 'twenty-min', 'two-hours',
    ]);
  });

  it('counts what each window would show so an empty hour can offer the next step', () => {
    expect(chatWindowCounts(rows, NOW)).toEqual({ hour: 2, today: 4, all: 6 });
  });

  it('the window belongs to "biggest context now" and to no other ranking', () => {
    // A chat that went quiet hours ago can honestly top a history ranking; it must not be
    // presented as the heaviest context today.
    expect(windowAppliesTo('context')).toBe(true);
    expect(windowAppliesTo('recent')).toBe(false);
    expect(windowAppliesTo('output')).toBe(false);
    expect(windowAppliesTo('calls')).toBe(false);
  });

  it('does not mutate the list it is given', () => {
    const input = [chat('a', NOW), chat('b', NOW - 9000)];
    withinChatWindow(input, 'hour', NOW);
    expect(input.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
