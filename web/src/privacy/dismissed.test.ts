import { describe, expect, it } from 'vitest';
import { addDismissed, readDismissed } from './dismissed';

function store(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_: string, next: string) => {
      value = next;
    },
    value: () => value,
  };
}

describe('dismissed privacy alerts', () => {
  it('reads nothing when there is nothing stored', () => {
    expect(readDismissed(store())).toEqual([]);
  });

  it('survives a reload, which is the whole point', () => {
    const s = store();
    addDismissed('evt-1', s);
    // A fresh read, as after a page load.
    expect(readDismissed(s)).toEqual(['evt-1']);
  });

  it('keeps the newest first and does not duplicate', () => {
    const s = store(JSON.stringify(['evt-1']));
    expect(addDismissed('evt-1', s)).toEqual(['evt-1']);
    expect(addDismissed('evt-2', s)).toEqual(['evt-2', 'evt-1']);
  });

  it('forgets the oldest once it has kept sixty', () => {
    const many = JSON.stringify(Array.from({ length: 60 }, (_, i) => `old-${i}`));
    const next = addDismissed('newest', store(many));
    expect(next).toHaveLength(60);
    expect(next[0]).toBe('newest');
    expect(next).not.toContain('old-59');
  });

  it('ignores a corrupted entry instead of throwing', () => {
    expect(readDismissed(store('not json'))).toEqual([]);
  });
});
