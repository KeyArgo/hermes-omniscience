import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../types';
import { groupSessions, GROUP_MODES } from './grouping';

const NOW = new Date(2026, 10, 9, 18, 0, 0).getTime() / 1000; // 9 Nov 2026, 18:00 local

function session(id: string, lastTs: number | null): SessionMeta {
  return {
    id,
    label: id,
    source: 'local',
    archived: null,
    first_ts: lastTs,
    last_ts: lastTs,
    events: 1,
    model: 'm',
    status: 'ok',
  } as SessionMeta;
}

const at = (daysAgo: number): number => NOW - daysAgo * 86_400;

describe('groupSessions', () => {
  it('offers day, week, month and flat', () => {
    expect(GROUP_MODES.map((mode) => mode.value)).toEqual(['day', 'week', 'month', 'none']);
  });

  it('gives the last hour its own bucket, above today', () => {
    const groups = groupSessions(
      [session('now', NOW - 300), session('earlier', NOW - 7200), session('yest', at(1))],
      'day',
      NOW,
    );
    expect(groups.map((group) => group.label)).toEqual(['Last hour', 'Today', 'Yesterday']);
  });

  it('names today and yesterday rather than a date', () => {
    // Two hours ago is still today but no longer "the last hour".
    const groups = groupSessions([session('a', NOW - 7200), session('b', at(1))], 'day', NOW);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday']);
  });

  it('uses a weekday and date further back, inside the same year', () => {
    const groups = groupSessions([session('a', at(5))], 'day', NOW);
    // 9 Nov 2026 is a Monday, so five days earlier is Wednesday 4 November. The label follows the
    // reader's locale, so assert the facts it must carry rather than one locale's punctuation.
    expect(groups[0].label).toContain('Wed');
    expect(groups[0].label).toContain('4');
    expect(groups[0].label).toContain('Nov');
    expect(groups[0].label).not.toContain('2026');
  });

  it('adds the year once the date is not this year', () => {
    const groups = groupSessions([session('a', NOW - 400 * 86_400)], 'day', NOW);
    expect(groups[0].label).toMatch(/2025$/);
  });

  it('buckets whole weeks, Monday first', () => {
    const groups = groupSessions([session('a', at(0)), session('b', at(3)), session('c', at(9))], 'week', NOW);
    expect(groups).toHaveLength(3);
    expect(groups[0].label).toBe('This week');
    expect(groups[1].label).toBe('Last week');
    // Nine days before Monday 9 Nov is Sunday 1 Nov, whose week starts Monday 26 October.
    expect(groups[2].label).toMatch(/^Week of .*26/);
  });

  it('buckets whole months by name', () => {
    const groups = groupSessions([session('a', at(0)), session('b', at(20)), session('c', at(70))], 'month', NOW);
    expect(groups.map((group) => group.label)).toEqual(['This month', 'October 2026', 'August 2026']);
  });

  it('keeps the caller\u2019s order inside and across buckets', () => {
    const groups = groupSessions(
      [session('new', at(0)), session('older', at(40)), session('alsoNew', at(0))],
      'day',
      NOW,
    );
    expect(groups.map((group) => group.sessions.map((s) => s.id))).toEqual([
      ['new', 'alsoNew'],
      ['older'],
    ]);
  });

  it('puts sessions with no recorded time last, and never drops one', () => {
    const groups = groupSessions([session('a', NOW - 7200), session('b', null)], 'day', NOW);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'No recorded time']);
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(2);
  });

  it('returns one unnamed bucket in flat mode', () => {
    const groups = groupSessions([session('a', at(0)), session('b', at(30))], 'none', NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('');
    expect(groups[0].sessions).toHaveLength(2);
  });

  it('is empty for no sessions', () => {
    expect(groupSessions([], 'day', NOW)).toEqual([]);
  });
});
