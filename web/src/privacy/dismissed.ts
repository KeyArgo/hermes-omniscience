/**
 * Dismissed privacy alerts must stay dismissed.
 *
 * A dismissal is a statement about a specific recorded run ("I have seen this browser call"), so it
 * is keyed by event id and kept across reloads. Without this the strip came back on every refresh,
 * which reads as a button that does nothing.
 */

const KEY = 'omni.privacyDismissed';
const LIMIT = 60;

export function readDismissed(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const store = storage ?? window.localStorage;
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function addDismissed(id: string, storage?: Pick<Storage, 'getItem' | 'setItem'>): string[] {
  const store = storage ?? window.localStorage;
  const next = [id, ...readDismissed(store).filter((existing) => existing !== id)].slice(0, LIMIT);
  try {
    store.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the dismissal lasts for this page only */
  }
  return next;
}
