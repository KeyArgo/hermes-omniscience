import { describe, expect, it } from 'vitest';
import {
  PANELS,
  isVisible,
  layoutStorageKey,
  readOverrides,
  toggle,
  toggleStored,
  writeOverrides,
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

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    map,
  };
}

describe('scoped panel layouts', () => {
  it('keeps the shipped web key and namespaces Hermes', () => {
    expect(layoutStorageKey('standard')).toBe('omni.layout.standard');
    expect(layoutStorageKey('standard', 'web')).toBe('omni.layout.standard');
    expect(layoutStorageKey('standard', 'hermes')).toBe('omni.hermes.layout.standard');
  });

  it('reads the stored web layout under the old key', () => {
    const storage = fakeStorage({
      'omni.layout.standard': JSON.stringify({ hidden: ['chats'], shown: [] }),
    });
    expect(readOverrides('standard', storage, 'web')).toEqual({ hidden: ['chats'], shown: [] });
    // Same preset, different mode: a fresh layout, not the browser's.
    expect(readOverrides('standard', storage, 'hermes')).toEqual({ hidden: [], shown: [] });
  });

  it('writes each mode under its own key without touching the other', () => {
    const storage = fakeStorage({
      'omni.layout.simple': JSON.stringify({ hidden: [], shown: ['legend'] }),
    });
    writeOverrides('simple', { hidden: ['chats'], shown: [] }, storage, 'hermes');

    expect(JSON.parse(storage.map.get('omni.hermes.layout.simple') as string)).toEqual({
      hidden: ['chats'],
      shown: [],
    });
    expect(JSON.parse(storage.map.get('omni.layout.simple') as string)).toEqual({
      hidden: [],
      shown: ['legend'],
    });
  });

  it('degrades to an empty layout when the store is blocked', () => {
    const denied = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(readOverrides('everything', denied, 'hermes')).toEqual({ hidden: [], shown: [] });
    expect(() =>
      writeOverrides('everything', { hidden: ['legend'], shown: [] }, denied, 'hermes'),
    ).not.toThrow();
  });
});

describe('cross-tab toggles merge instead of overwriting', () => {
  it('keeps an earlier tab’s hidden panel when a later tab shows another one', () => {
    // Before the fix each tab wrote the overrides object it had loaded at mount, so the second
    // tab's write erased the first tab's hidden Status line. Every toggle now reads the stored
    // layout first, which is the only copy that includes both tabs' work.
    const storage = fakeStorage();
    toggleStored('status', 'simple', storage, 'hermes');
    const afterSecond = toggleStored('legend', 'simple', storage, 'hermes').overrides;

    expect(afterSecond.hidden).toEqual(['status']);
    expect(afterSecond.shown).toEqual(['legend']);
    expect(readOverrides('simple', storage, 'hermes')).toEqual({
      hidden: ['status'],
      shown: ['legend'],
    });
  });

  it('does not lose a change the other tab made to the same preset in the other mode', () => {
    const storage = fakeStorage({
      'omni.layout.simple': JSON.stringify({ hidden: ['chats'], shown: [] }),
    });
    toggleStored('legend', 'simple', storage, 'hermes');
    expect(readOverrides('simple', storage, 'web')).toEqual({ hidden: ['chats'], shown: [] });
    expect(readOverrides('simple', storage, 'hermes')).toEqual({ hidden: [], shown: ['legend'] });
  });

  it('leaves a preset alone when another preset is toggled', () => {
    const storage = fakeStorage({
      'omni.layout.standard': JSON.stringify({ hidden: [], shown: ['legend'] }),
    });
    toggleStored('status', 'simple', storage);
    expect(readOverrides('standard', storage)).toEqual({ hidden: [], shown: ['legend'] });
  });

  it('reports a write that did not land, so memory can drive the session', () => {
    // A full or private-mode store can be read but not written. The toggle must still undo itself
    // from the in-memory layout instead of re-reading the same stored value forever.
    const storage = {
      getItem: () => null,
      setItem() {
        throw new Error('quota exceeded');
      },
    };
    const first = toggleStored('status', 'simple', storage, 'hermes');
    expect(first.persisted).toBe(false);
    expect(isVisible('status', 'simple', first.overrides)).toBe(false);

    const second = toggleStored('legend', 'simple', storage, 'hermes', first.overrides);
    expect(second.persisted).toBe(false);
    expect(isVisible('status', 'simple', second.overrides)).toBe(false);
    expect(isVisible('legend', 'simple', second.overrides)).toBe(true);

    const third = toggleStored('status', 'simple', storage, 'hermes', second.overrides);
    expect(isVisible('status', 'simple', third.overrides)).toBe(true);
    expect(isVisible('legend', 'simple', third.overrides)).toBe(true);
  });
});
