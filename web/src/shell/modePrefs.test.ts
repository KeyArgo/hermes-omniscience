import { describe, expect, it } from 'vitest';
import {
  HERMES_COMPACT_KEY,
  HERMES_LAYOUT_PREFIX,
  HERMES_PANEL_PREFIX,
  HERMES_PRESET_KEY,
  MODE_VIEW_KEYS,
  WEB_COMPACT_KEY,
  WEB_LAYOUT_PREFIX,
  WEB_PANEL_PREFIX,
  WEB_PRESET_KEY,
  compactKey,
  defaultCompact,
  defaultPreset,
  isAnyModePrefKey,
  isModePrefKey,
  presetKey,
  readCompact,
  readPreset,
  readScopedBool,
  readScopedPref,
  scopedStorageKey,
  writeCompact,
  writePreset,
  writeScopedBool,
  writeScopedPref,
} from './modePrefs';

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

describe('per-mode keys', () => {
  it('keeps the shipped web keys exactly where they were', () => {
    expect(presetKey('web')).toBe('omni.preset');
    expect(compactKey('web')).toBe('omni.compact');
    expect(WEB_PRESET_KEY).toBe('omni.preset');
    expect(WEB_COMPACT_KEY).toBe('omni.compact');
    expect(WEB_LAYOUT_PREFIX).toBe('omni.layout.');
  });

  it('gives Hermes its own namespace', () => {
    expect(presetKey('hermes')).toBe('omni.hermes.preset');
    expect(compactKey('hermes')).toBe('omni.hermes.compact');
    expect(HERMES_PRESET_KEY).not.toBe(WEB_PRESET_KEY);
    expect(HERMES_LAYOUT_PREFIX.startsWith(WEB_LAYOUT_PREFIX)).toBe(false);
  });
});

describe('defaults', () => {
  it('starts Hermes on Simple and not compact', () => {
    expect(defaultPreset('hermes')).toBe('simple');
    expect(defaultCompact('hermes', true)).toBe(false);
    expect(defaultCompact('hermes', false)).toBe(false);
  });

  it('preserves the browser default that shipped', () => {
    expect(defaultPreset('web')).toBe('simple');
    // The browser's compact default is unchanged: compact only when embedded.
    expect(defaultCompact('web', true)).toBe(true);
    expect(defaultCompact('web', false)).toBe(false);
  });
});

describe('reading existing web preferences', () => {
  it('reads a stored web preset and ignores it in Hermes', () => {
    const storage = fakeStorage({ [WEB_PRESET_KEY]: 'everything' });
    expect(readPreset('web', storage)).toBe('everything');
    // Missing Hermes key: Hermes default, NOT the browser's Everything.
    expect(readPreset('hermes', storage)).toBe('simple');
  });

  it('reads a stored web compact flag and leaves Hermes uncompact', () => {
    const storage = fakeStorage({ [WEB_COMPACT_KEY]: '1' });
    expect(readCompact('web', false, storage)).toBe(true);
    expect(readCompact('hermes', false, storage)).toBe(false);
  });

  it('ignores an unknown stored preset', () => {
    expect(readPreset('web', fakeStorage({ [WEB_PRESET_KEY]: 'huge' }))).toBe(defaultPreset('web'));
  });
});

describe('writes stay inside their mode', () => {
  it('writes Hermes values without touching the web keys', () => {
    const storage = fakeStorage({ [WEB_PRESET_KEY]: 'everything', [WEB_COMPACT_KEY]: '1' });
    writePreset('hermes', 'standard', storage);
    writeCompact('hermes', false, storage);

    expect(storage.map.get(HERMES_PRESET_KEY)).toBe('standard');
    expect(storage.map.get(HERMES_COMPACT_KEY)).toBe('0');
    expect(storage.map.get(WEB_PRESET_KEY)).toBe('everything');
    expect(storage.map.get(WEB_COMPACT_KEY)).toBe('1');
  });

  it('writes web values without touching the Hermes keys', () => {
    const storage = fakeStorage({
      [HERMES_PRESET_KEY]: 'simple',
      [HERMES_COMPACT_KEY]: '0',
    });
    writePreset('web', 'everything', storage);
    writeCompact('web', true, storage);

    expect(storage.map.get(WEB_PRESET_KEY)).toBe('everything');
    expect(storage.map.get(WEB_COMPACT_KEY)).toBe('1');
    expect(storage.map.get(HERMES_PRESET_KEY)).toBe('simple');
    expect(storage.map.get(HERMES_COMPACT_KEY)).toBe('0');
  });

  it('reads back what each mode wrote, independently', () => {
    const storage = fakeStorage();
    writePreset('web', 'everything', storage);
    writePreset('hermes', 'standard', storage);
    expect(readPreset('web', storage)).toBe('everything');
    expect(readPreset('hermes', storage)).toBe('standard');
  });
});

describe('storage unavailable', () => {
  it('falls back to the mode defaults instead of throwing', () => {
    const denied = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(readPreset('hermes', denied)).toBe('simple');
    expect(readCompact('web', true, denied)).toBe(true);
    expect(() => writePreset('web', 'standard', denied)).not.toThrow();
    expect(() => writeCompact('hermes', false, denied)).not.toThrow();
  });
});

describe('reset classification', () => {
  it('recognises each mode’s own layout and view keys only', () => {
    const webKeys = [
      'omni.preset',
      'omni.compact',
      'omni.layout.simple',
      'omni.layout.everything',
      'omni.theme',
      'omni.view',
      'omni.defaultView',
      'omni.mapStyle',
      'omni.miniView',
      'omni.railMode',
      'omni.followNewest',
      'omni.showTitles',
      'omni.showContext',
      'omni.leftCollapsed',
      'omni.rightCollapsed',
      'omni.panel.context-lane.h',
      'omni.panel.context-lane.folded',
    ];
    const hermesKeys = [
      'omni.hermes.preset',
      'omni.hermes.compact',
      'omni.hermes.layout.simple',
      'omni.hermes.theme',
      'omni.hermes.view',
      'omni.hermes.defaultView',
      'omni.hermes.mapStyle',
      'omni.hermes.miniView',
      'omni.hermes.railMode',
      'omni.hermes.followNewest',
      'omni.hermes.showTitles',
      'omni.hermes.showContext',
      'omni.hermes.panel.context-lane.h',
    ];

    for (const key of webKeys) {
      expect(isModePrefKey(key, 'web'), key).toBe(true);
      expect(isModePrefKey(key, 'hermes'), key).toBe(false);
    }
    for (const key of hermesKeys) {
      expect(isModePrefKey(key, 'hermes'), key).toBe(true);
      expect(isModePrefKey(key, 'web'), key).toBe(false);
    }
  });

  it('never resets privacy, the remembered mode, session preferences or unknown keys', () => {
    // These are storage the page must keep: a Reset View that erased them would silently turn
    // privacy alerts back on, re-show dismissed alerts, or reorder the reader's chat list.
    const kept = [
      'omni.mode',
      'omni.tourSeen',
      'omni.privacyAlerts',
      'omni.privacyDismissed',
      'omni.problemsAck',
      'omni.sessionSort',
      'omni.sessionGroup',
      'omni.sessionCollapsed',
      'omni.follow',
      'omni.rates',
      'omni.usageDays',
      'omni.latencyWindow',
      'omni.tokensSort',
      'omni.tokensWindow',
      'omni.t',
      'omni.keyRecoveredAt',
      'omni.someFutureKey',
      'other.preset',
      'omnihermes.theme',
    ];
    for (const key of kept) {
      expect(isModePrefKey(key, 'web'), key).toBe(false);
      expect(isModePrefKey(key, 'hermes'), key).toBe(false);
      expect(isAnyModePrefKey(key), key).toBe(false);
    }
  });

  it('lists every per-mode view key under both namespaces', () => {
    expect(MODE_VIEW_KEYS).toContain('theme');
    expect(WEB_PANEL_PREFIX).toBe('omni.panel.');
    expect(HERMES_PANEL_PREFIX).toBe('omni.hermes.panel.');
    for (const name of MODE_VIEW_KEYS) {
      expect(isModePrefKey(`omni.${name}`, 'web'), name).toBe(true);
      expect(isModePrefKey(`omni.hermes.${name}`, 'hermes'), name).toBe(true);
    }
  });
});

describe('scoped view preferences', () => {
  it('keeps the shipped web key and namespaces Hermes', () => {
    expect(scopedStorageKey('theme', 'web')).toBe('omni.theme');
    expect(scopedStorageKey('theme', 'hermes')).toBe('omni.hermes.theme');
    expect(scopedStorageKey('view', 'web')).toBe('omni.view');
    expect(scopedStorageKey('panel.context-lane.h', 'hermes')).toBe(
      'omni.hermes.panel.context-lane.h',
    );
  });

  it('reads a value written by the same mode and never the other mode', () => {
    const storage = fakeStorage({ 'omni.theme': 'paper' });
    expect(readScopedPref('theme', 'web', storage)).toBe('paper');
    expect(readScopedPref('theme', 'hermes', storage)).toBeNull();

    writeScopedPref('theme', 'hermes', 'console', storage);
    expect(readScopedPref('theme', 'hermes', storage)).toBe('console');
    expect(readScopedPref('theme', 'web', storage)).toBe('paper');
  });

  it('round-trips booleans without touching the other mode', () => {
    const storage = fakeStorage({ 'omni.showTitles': '0' });
    expect(readScopedBool('showTitles', 'web', true, storage)).toBe(false);
    expect(readScopedBool('showTitles', 'hermes', true, storage)).toBe(true);

    writeScopedBool('showTitles', 'hermes', false, storage);
    expect(storage.map.get('omni.hermes.showTitles')).toBe('0');
    expect(storage.map.get('omni.showTitles')).toBe('0');
  });

  it('falls back to the caller default when storage is blocked', () => {
    const denied = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(readScopedPref('view', 'hermes', denied)).toBeNull();
    expect(readScopedBool('followNewest', 'web', false, denied)).toBe(false);
    expect(() => writeScopedPref('theme', 'hermes', 'paper', denied)).not.toThrow();
    expect(() => writeScopedBool('showContext', 'hermes', true, denied)).not.toThrow();
  });
});
