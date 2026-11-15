import { describe, expect, it } from 'vitest';
import modeSource from './mode.ts?raw';
import {
  HERMES_HOST,
  HOST_PARAM,
  MODE_STORAGE_KEY,
  initialMode,
  isInterfaceMode,
  markedMode,
  modeFromSearch,
  readStoredMode,
  withoutHostMarker,
  writeStoredMode,
  type InterfaceMode,
} from './mode';

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

describe('the explicit host marker', () => {
  it('reads Hermes only from ?host=hermes', () => {
    expect(modeFromSearch('?host=hermes')).toBe('hermes');
    expect(markedMode('?host=hermes')).toBe('hermes');
    expect(modeFromSearch('')).toBe('web');
  });

  it('accepts ?host=web as an explicit web pin', () => {
    expect(modeFromSearch('?host=web')).toBe('web');
    expect(markedMode('?host=web')).toBe('web');
  });

  it('ignores unknown, empty and differently-cased values instead of guessing', () => {
    for (const search of ['?host=', '?host=Hermes', '?host=desktop', '?host=iframe', '?mini=1']) {
      expect(markedMode(search)).toBeNull();
      expect(modeFromSearch(search)).toBe('web');
    }
  });

  it('does not treat a session or mini query as a host', () => {
    expect(modeFromSearch('?session=abc&mini=1')).toBe('web');
    // The docked pane is a frame with mini=1 AND the explicit marker: the marker decides.
    expect(modeFromSearch('?mini=1&host=hermes')).toBe('hermes');
  });

  it('never infers Hermes from being framed', () => {
    // Source-level, like the desktop plugin tests: the defect would be the inference itself.
    expect(modeSource).not.toMatch(/window\.top/);
    expect(modeSource).not.toMatch(/window\.self/);
    expect(modeSource).not.toMatch(/frameElement/);
  });
});

describe('initial mode', () => {
  it('defaults a browser with no marker and no memory to web', () => {
    expect(initialMode('')).toBe('web');
    expect(initialMode('', fakeStorage())).toBe('web');
  });

  it('lets an explicit marker outrank a remembered choice', () => {
    const storage = fakeStorage({ [MODE_STORAGE_KEY]: 'web' });
    expect(initialMode('?host=hermes', storage)).toBe('hermes');
    const other = fakeStorage({ [MODE_STORAGE_KEY]: 'hermes' });
    expect(initialMode('?host=web', other)).toBe('web');
  });

  it('remembers a browser choice when there is no marker', () => {
    expect(initialMode('', fakeStorage({ [MODE_STORAGE_KEY]: 'hermes' }))).toBe('hermes');
    expect(initialMode('?session=x', fakeStorage({ [MODE_STORAGE_KEY]: 'web' }))).toBe('web');
  });

  it('ignores a stored value that is not a mode', () => {
    expect(readStoredMode(fakeStorage({ [MODE_STORAGE_KEY]: 'desktop' }))).toBeNull();
    expect(initialMode('', fakeStorage({ [MODE_STORAGE_KEY]: 'desktop' }))).toBe('web');
  });

  it('survives storage that throws on read and on write', () => {
    const denied = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    };
    expect(readStoredMode(denied)).toBeNull();
    expect(initialMode('?host=hermes', denied)).toBe('hermes');
    expect(initialMode('', denied)).toBe('web');
    expect(() => writeStoredMode('hermes', denied)).not.toThrow();
  });
});

describe('remembered mode', () => {
  it('round-trips a valid mode and rejects junk', () => {
    const storage = fakeStorage();
    writeStoredMode('hermes', storage);
    expect(storage.map.get(MODE_STORAGE_KEY)).toBe('hermes');
    expect(readStoredMode(storage)).toBe('hermes');
    storage.map.set(MODE_STORAGE_KEY, 'not-a-mode');
    expect(readStoredMode(storage)).toBeNull();
  });

  it('narrows unknown strings through the type guard', () => {
    const values: unknown[] = ['web', 'hermes', 'WEB', null, 1];
    const kept = values.filter((value): value is InterfaceMode => isInterfaceMode(value));
    expect(kept).toEqual(['web', 'hermes']);
  });
});

describe('leaving the host', () => {
  it('drops the marker and keeps every other parameter', () => {
    const url = withoutHostMarker(
      `http://127.0.0.1:8797/?${HOST_PARAM}=${HERMES_HOST}&session=abc&t=key&mini=1#x`,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.has(HOST_PARAM)).toBe(false);
    expect(parsed.searchParams.get('session')).toBe('abc');
    expect(parsed.searchParams.get('t')).toBe('key');
    expect(parsed.searchParams.get('mini')).toBe('1');
    expect(parsed.hash).toBe('#x');
  });

  it('leaves a URL without a marker alone', () => {
    const url = 'http://127.0.0.1:8797/?session=abc';
    expect(withoutHostMarker(url)).toBe(url);
  });

  it('returns non-URL input untouched rather than throwing', () => {
    expect(withoutHostMarker('not a url')).toBe('not a url');
  });
});
