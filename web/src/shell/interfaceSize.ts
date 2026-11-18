/**
 * Interface size: how large the whole viewer draws itself, so more of it fits on a smaller screen.
 *
 * The size is a display preference, not part of what you are looking at: Reset View deliberately
 * leaves it alone (see `isModePrefKey` in modePrefs.ts — this name is not in that allow list), and
 * it follows the mode it was chosen in, like every other view preference.
 *
 * Values are stored as "100", "90" and "80" under the mode's own key (`omni.interfaceSize` in the
 * browser, `omni.hermes.interfaceSize` in the docked pane). A frame with no shared storage reads
 * the default every time and still works for the life of the page: App keeps it in state.
 */

import type { InterfaceMode } from './mode';
import { readScopedPref, scopedStorageKey, writeScopedPref } from './modePrefs';

/** The sizes Settings offers, largest first. */
export const INTERFACE_SIZES = [100, 90, 80] as const;

export type InterfaceSize = (typeof INTERFACE_SIZES)[number];

/**
 * 90% is the default. It fits about a tenth more on the same screen with every label still the
 * size it was designed at, which is what "make it smaller so more fits" asks for without turning
 * the map into a page of small print; 100% is the old size, 80% is for a small window.
 */
export const DEFAULT_INTERFACE_SIZE: InterfaceSize = 90;

/** The preference's name inside its mode's namespace. */
export const INTERFACE_SIZE_PREF = 'interfaceSize';

/** CSS custom property the app root reads for its zoom (styles.css). */
export const INTERFACE_SCALE_VAR = '--ui-scale';

export function interfaceSizeKey(mode: InterfaceMode): string {
  return scopedStorageKey(INTERFACE_SIZE_PREF, mode);
}

export function isInterfaceSize(value: unknown): value is InterfaceSize {
  return value === 100 || value === 90 || value === 80;
}

/** The stored size for `mode`, or the default when nothing valid is stored. */
export function readInterfaceSize(
  mode: InterfaceMode,
  storage?: Pick<Storage, 'getItem'>,
): InterfaceSize {
  const raw = readScopedPref(INTERFACE_SIZE_PREF, mode, storage);
  if (raw === null) return DEFAULT_INTERFACE_SIZE;
  const parsed = Number(raw);
  return isInterfaceSize(parsed) ? parsed : DEFAULT_INTERFACE_SIZE;
}

export function writeInterfaceSize(
  mode: InterfaceMode,
  size: InterfaceSize,
  storage?: Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>,
): void {
  if (!isInterfaceSize(size)) return;
  writeScopedPref(INTERFACE_SIZE_PREF, mode, String(size), storage);
}

/** 100 → 1, 90 → 0.9, 80 → 0.8. */
export function interfaceZoom(size: InterfaceSize): number {
  return size / 100;
}

/**
 * The zoom the page is drawn at right now.
 *
 * A `position: fixed` box inside the zoomed app root is laid out in the root's own pixels, so an
 * overlay that measures a target with `getBoundingClientRect` (window pixels) has to divide the
 * measurement, and its viewport, by this to line up. Read from the root's inline style rather than
 * through a React context: the overlays run their measuring in effects that also fire on scroll
 * and resize, where a stale prop would put the ring a zoom-step away from its target.
 */
export function currentInterfaceScale(): number {
  if (typeof document === 'undefined') return 1;
  try {
    const raw = document.documentElement.style.getPropertyValue(INTERFACE_SCALE_VAR).trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

/** Put the size on the document: the CSS variable the app root scales by, plus a marker for tests. */
export function applyInterfaceSize(size: InterfaceSize): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(INTERFACE_SCALE_VAR, String(interfaceZoom(size)));
  document.documentElement.dataset.uiSize = String(size);
}
