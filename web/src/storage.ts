/**
 * localStorage, or a memory stand-in when the browser refuses to hand one over.
 *
 * The desktop app embeds this page in the SDK's `SandboxedFrame`, whose guest gets an OPAQUE
 * origin. In that document `window.localStorage` does not return a store — touching it throws
 * `SecurityError` — and every setting this page remembers is read during the first render, so one
 * throw is a blank page instead of a graph.
 *
 * Nothing here is data: the recording lives on the server, and these keys are view preferences
 * (which tab, which theme, whether the rail is folded). Inside a sandbox they simply do not
 * outlive the page, which is the right trade for a page that must still work.
 */

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => (items.has(key) ? (items.get(key) as string) : null),
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, String(value));
    },
  } as Storage;
}

/** Install a working store on `target` when its own localStorage is unreachable (no-op if fine). */
export function installSafeStorage(target: { localStorage?: Storage } = globalThis as never): void {
  try {
    const store = target.localStorage;
    if (store) {
      // Some broken contexts hand back an object that throws on first use rather than on access.
      store.getItem('omni.probe');
      return;
    }
  } catch {
    /* an opaque origin: fall through to the memory store */
  }
  try {
    Object.defineProperty(target, 'localStorage', { configurable: true, value: memoryStorage() });
  } catch {
    /* nothing else to do: the page still renders, settings just do not persist */
  }
}

export const __testing = { memoryStorage };
