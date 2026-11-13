import { describe, expect, it } from 'vitest';
import { installSafeStorage, __testing } from './storage';

/**
 * The embedded page runs in the SDK's SandboxedFrame, where `window.localStorage` throws. These
 * tests pin the shim that keeps such a page alive.
 */

function opaqueOriginTarget(): { localStorage?: Storage } {
  const target: { localStorage?: Storage } = {};
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: the operation is insecure');
    },
  });
  return target;
}

describe('installSafeStorage', () => {
  it('gives an opaque-origin page a working store instead of a throw', () => {
    const target = opaqueOriginTarget();
    installSafeStorage(target);
    target.localStorage!.setItem('omni.view', 'map');
    expect(target.localStorage!.getItem('omni.view')).toBe('map');
    expect(target.localStorage!.length).toBe(1);
    expect(target.localStorage!.key(0)).toBe('omni.view');
    target.localStorage!.removeItem('omni.view');
    expect(target.localStorage!.getItem('omni.view')).toBeNull();
  });

  it('keeps a working localStorage exactly as it is', () => {
    const items = new Map<string, string>([['omni.theme', 'paper']]);
    const real = {
      get length() {
        return items.size;
      },
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
      key: () => null,
    } as unknown as Storage;
    const target: { localStorage?: Storage } = { localStorage: real };
    installSafeStorage(target);
    expect(target.localStorage).toBe(real);
    expect(target.localStorage!.getItem('omni.theme')).toBe('paper');
  });

  it('survives a context that has no localStorage property at all', () => {
    const target: { localStorage?: Storage } = {};
    installSafeStorage(target);
    target.localStorage!.setItem('omni.preset', '1');
    expect(target.localStorage!.getItem('omni.preset')).toBe('1');
  });

  it('the memory store starts empty for every install', () => {
    const first = __testing.memoryStorage();
    first.setItem('a', '1');
    const second = __testing.memoryStorage();
    expect(second.getItem('a')).toBeNull();
  });
});
