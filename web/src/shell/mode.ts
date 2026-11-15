/**
 * Which interface the page is showing — and the one way it can know.
 *
 * Hermes mode is chosen by an EXPLICIT marker in the URL (`?host=hermes`), added by the desktop
 * page when it builds the viewer's src. Being inside an iframe is deliberately not evidence: a
 * browser tab, an embedded dashboard or a different host's frame are all web mode until they say
 * otherwise. A wrong guess here would hand one host's saved layout to another.
 *
 * The marker outranks a remembered choice, so the docked page always comes back in Hermes mode;
 * a plain browser tab (no marker) remembers what the reader last picked.
 */

export type InterfaceMode = 'web' | 'hermes';

export const HOST_PARAM = 'host';
export const HERMES_HOST = 'hermes';
export const WEB_HOST = 'web';

/** Browser-only memory of the mode the reader picked. Never written by a marker-pinned page. */
export const MODE_STORAGE_KEY = 'omni.mode';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = ReadableStorage & Partial<Pick<Storage, 'setItem'>>;

function defaultStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    // A sandboxed frame has an opaque origin: touching localStorage throws.
    return undefined;
  }
}

export function isInterfaceMode(value: unknown): value is InterfaceMode {
  return value === 'web' || value === 'hermes';
}

/**
 * The explicit host marker, or null when the URL does not carry one.
 *
 * `?host=web` is accepted as a marker too, so a link can pin the browser layout even in a host
 * that remembered Hermes. Any other value is not a mode: it is ignored rather than guessed at.
 */
export function markedMode(search: string): InterfaceMode | null {
  try {
    const host = new URLSearchParams(search).get(HOST_PARAM);
    if (host === HERMES_HOST) return 'hermes';
    if (host === WEB_HOST) return 'web';
    return null;
  } catch {
    return null;
  }
}

/** The mode a URL names, defaulting to web. No iframe, user-agent or path inference. */
export function modeFromSearch(search: string): InterfaceMode {
  return markedMode(search) ?? 'web';
}

export function readStoredMode(storage?: ReadableStorage): InterfaceMode | null {
  const store = storage ?? defaultStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(MODE_STORAGE_KEY);
    return isInterfaceMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredMode(mode: InterfaceMode, storage?: WritableStorage): void {
  const store = storage ?? defaultStorage();
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Storage full or blocked: the choice still applies to this page.
  }
}

/**
 * Initial mode for a given URL and store. A marker wins; otherwise the remembered browser choice;
 * otherwise web. A refused or full store degrades to the same answer without throwing.
 */
export function initialMode(search: string, storage?: ReadableStorage): InterfaceMode {
  const marked = markedMode(search);
  if (marked) return marked;
  return readStoredMode(storage) ?? 'web';
}

export function initialModeFromLocation(): InterfaceMode {
  if (typeof window === 'undefined') return 'web';
  try {
    return initialMode(window.location.search);
  } catch {
    return 'web';
  }
}

/** True when the URL carries an explicit marker, which pins the starting mode on every load. */
export function isHostPinnedFromLocation(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return markedMode(window.location.search) !== null;
  } catch {
    return false;
  }
}

/**
 * The same URL without the host marker, for links that leave the host (the browser tab).
 * Such a tab is web mode: it must not inherit the desktop pane's Hermes marker.
 */
export function withoutHostMarker(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.delete(HOST_PARAM);
    return url.toString();
  } catch {
    return href;
  }
}
