import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERFACE_SIZE,
  INTERFACE_SCALE_VAR,
  INTERFACE_SIZES,
  interfaceSizeKey,
  interfaceZoom,
  isInterfaceSize,
  readInterfaceSize,
  writeInterfaceSize,
} from './interfaceSize';
import { isModePrefKey } from './modePrefs';

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

describe('interface size preference', () => {
  it('offers 100, 90 and 80, largest first', () => {
    expect([...INTERFACE_SIZES]).toEqual([100, 90, 80]);
    for (const size of INTERFACE_SIZES) expect(isInterfaceSize(size)).toBe(true);
    for (const other of [0, 95, 75, -90, 1.1]) expect(isInterfaceSize(other)).toBe(false);
  });

  it('defaults to 90% when nothing is stored', () => {
    expect(DEFAULT_INTERFACE_SIZE).toBe(90);
    expect(readInterfaceSize('web', fakeStorage())).toBe(90);
    expect(readInterfaceSize('hermes', fakeStorage())).toBe(90);
  });

  it('defaults when storage throws (a frame with no storage of its own)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('storage is blocked');
      },
    };
    expect(readInterfaceSize('hermes', throwing)).toBe(90);
  });

  it('round-trips every offered size', () => {
    for (const size of INTERFACE_SIZES) {
      const store = fakeStorage();
      writeInterfaceSize('web', size, store);
      expect(store.map.get('omni.interfaceSize')).toBe(String(size));
      expect(readInterfaceSize('web', store)).toBe(size);
    }
  });

  it('keeps each mode on its own key, so the pane cannot overwrite the browser', () => {
    expect(interfaceSizeKey('web')).toBe('omni.interfaceSize');
    expect(interfaceSizeKey('hermes')).toBe('omni.hermes.interfaceSize');
    const store = fakeStorage({ 'omni.interfaceSize': '100' });
    expect(readInterfaceSize('web', store)).toBe(100);
    // Nothing stored for Hermes yet: the pane starts at its own default, not the browser's 100.
    expect(readInterfaceSize('hermes', store)).toBe(90);
  });

  it('ignores a stored value that is not one of the three sizes', () => {
    for (const raw of ['', '0', '95', '0.9', 'large', '-80', '900']) {
      expect(readInterfaceSize('web', fakeStorage({ 'omni.interfaceSize': raw }))).toBe(90);
    }
  });

  it('refuses to write a size it does not offer', () => {
    const store = fakeStorage();
    writeInterfaceSize('web', 95 as unknown as 90, store);
    expect(store.map.has('omni.interfaceSize')).toBe(false);
  });

  it('turns each size into the zoom the root uses', () => {
    expect(interfaceZoom(100)).toBe(1);
    expect(interfaceZoom(90)).toBe(0.9);
    expect(interfaceZoom(80)).toBe(0.8);
  });

  it('names the CSS variable the app root reads', () => {
    expect(INTERFACE_SCALE_VAR).toBe('--ui-scale');
  });

  it("is not one of Reset View's keys: it is how big the page draws, not what it shows", () => {
    expect(isModePrefKey('omni.interfaceSize', 'web')).toBe(false);
    expect(isModePrefKey('omni.hermes.interfaceSize', 'hermes')).toBe(false);
  });
});
