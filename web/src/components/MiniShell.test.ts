import { describe, it, expect } from 'vitest';
import { sessionsNewestFirst } from './MiniShell';
import type { SessionMeta } from '../types';

function mk(id: string, last_ts?: number | null): SessionMeta {
  return { id, last_ts: last_ts === undefined ? null : last_ts };
}

describe('sessionsNewestFirst', () => {
  it('sorts newest first by last_ts', () => {
    const list = [mk('a', 100), mk('b', 300), mk('c', 200)];
    const out = sessionsNewestFirst(list);
    expect(out.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('places null/undefined/NaN last_ts last, in original order', () => {
    const list = [
      mk('n1', null),
      mk('a', 100),
      mk('n2'),
      mk('b', 300),
      mk('n3', Number.NaN),
    ];
    const out = sessionsNewestFirst(list);
    expect(out.map((s) => s.id)).toEqual(['b', 'a', 'n1', 'n2', 'n3']);
  });

  it('is stable for equal timestamps', () => {
    const list = [mk('x', 50), mk('y', 50), mk('z', 50)];
    const out = sessionsNewestFirst(list);
    expect(out.map((s) => s.id)).toEqual(['x', 'y', 'z']);
  });

  it('does not mutate the input array', () => {
    const list = [mk('a', 100), mk('b', 200)];
    const snapshot = list.map((s) => s.id);
    sessionsNewestFirst(list);
    expect(list.map((s) => s.id)).toEqual(snapshot);
  });

  it('handles empty list', () => {
    expect(sessionsNewestFirst([])).toEqual([]);
  });
});
