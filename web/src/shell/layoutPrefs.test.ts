import { describe, expect, it } from 'vitest';
import {
  PANELS,
  isVisible,
  readOverrides,
  toggle,
  type Overrides,
  type Preset,
} from './layoutPrefs';

const empty: Overrides = { hidden: [], shown: [] };

describe('defaults per preset', () => {
  it('simple hides chats and briefing', () => {
    expect(isVisible('chats', 'simple', empty)).toBe(false);
    expect(isVisible('briefing', 'simple', empty)).toBe(false);
    expect(isVisible('hints', 'simple', empty)).toBe(true);
  });

  it('standard shows chats and inspector', () => {
    expect(isVisible('chats', 'standard', empty)).toBe(true);
    expect(isVisible('inspector', 'standard', empty)).toBe(true);
    expect(isVisible('legend', 'standard', empty)).toBe(false);
  });

  it('everything shows every panel except the view hints', () => {
    for (const p of PANELS) {
      expect(isVisible(p.id, 'everything', empty)).toBe(p.id !== 'hints');
    }
  });
});

describe('toggle', () => {
  it('round-trips back to default and removes the override', () => {
    const preset: Preset = 'standard';
    const once = toggle('chats', preset, empty);
    expect(isVisible('chats', preset, once)).toBe(false);
    expect(once.hidden).toContain('chats');

    const twice = toggle('chats', preset, once);
    expect(isVisible('chats', preset, twice)).toBe(true);
    expect(twice.hidden).not.toContain('chats');
    expect(twice.shown).not.toContain('chats');
  });

  it('does not mutate the input', () => {
    const input: Overrides = { hidden: [], shown: [] };
    toggle('legend', 'standard', input);
    expect(input).toEqual({ hidden: [], shown: [] });
  });
});

describe('readOverrides', () => {
  it('returns empty when storage throws', () => {
    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
    };
    expect(readOverrides('simple', throwing)).toEqual({ hidden: [], shown: [] });
  });

  it('returns empty on bad JSON', () => {
    const store = { getItem: () => '{not json' };
    expect(readOverrides('simple', store)).toEqual({ hidden: [], shown: [] });
  });

  it('reads valid overrides', () => {
    const store = {
      getItem: () => JSON.stringify({ hidden: ['chats'], shown: ['legend'] }),
    };
    expect(readOverrides('standard', store)).toEqual({
      hidden: ['chats'],
      shown: ['legend'],
    });
  });
});

describe('what each preset opens with', () => {
  it('Simple opens on the map, without the token chart docked under it', () => {
    // The chart used to default into Simple, which took ~200 px of the stage and left the map a
    // 355 px strip that could not be fitted. See GraphView's MIN_FIT_ZOOM comment.
    expect(isVisible('context', 'simple', { hidden: [], shown: [] })).toBe(false);
    expect(isVisible('context', 'standard', { hidden: [], shown: [] })).toBe(true);
    expect(isVisible('context', 'everything', { hidden: [], shown: [] })).toBe(true);
  });
});
