/**
 * View preferences kept per interface mode.
 *
 * The browser's keys are the ones that shipped (`omni.preset`, `omni.compact`,
 * `omni.layout.<preset>`, `omni.theme`, `omni.view`, `omni.panel.<id>.*`): an existing reader's
 * choices are read exactly as before and nothing is copied, renamed or overwritten. Hermes gets
 * its own parallel keys under `omni.hermes.*`, so a split-pane pane cannot inherit — or clobber —
 * the full browser workspace.
 *
 * A missing Hermes preference starts from the Hermes defaults, never from the web value: that is
 * the safe migration. If a reader has `omni.preset = everything` from the browser, opening the
 * docked page must still be Simple and readable.
 *
 * `isModePrefKey` is also Reset View's allow list. Storage that is not a per-mode view preference
 * (privacy choices, session-list preferences, the follow list, the token's session state) is never
 * a mode key, so Reset View cannot remove it.
 */

import type { Preset } from './layoutPrefs';
import type { InterfaceMode } from './mode';

export const WEB_PRESET_KEY = 'omni.preset';
export const HERMES_PRESET_KEY = 'omni.hermes.preset';
export const WEB_COMPACT_KEY = 'omni.compact';
export const HERMES_COMPACT_KEY = 'omni.hermes.compact';
export const WEB_LAYOUT_PREFIX = 'omni.layout.';
export const HERMES_LAYOUT_PREFIX = 'omni.hermes.layout.';
export const WEB_PANEL_PREFIX = 'omni.panel.';
export const HERMES_PANEL_PREFIX = 'omni.hermes.panel.';

/**
 * Every view preference whose value must not cross modes. Web keeps the exact key it has always
 * used; Hermes reads and writes the parallel `omni.hermes.*` key. The list is explicit so Reset
 * View can tell these keys apart from storage that belongs to something else (the recording's
 * session list, privacy choices, another mode).
 */
export const MODE_VIEW_KEYS = [
  'theme',
  'view',
  'defaultView',
  'mapStyle',
  'miniView',
  'showTitles',
  'showContext',
  'followNewest',
  'railMode',
  // Legacy rail flags. They were shared by both modes before rail state followed the panel
  // layout; they are still listed so an old web value is cleaned up by Reset View.
  'leftCollapsed',
  'rightCollapsed',
] as const;

export type ModeViewKey = (typeof MODE_VIEW_KEYS)[number];

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = ReadableStorage & Partial<Pick<Storage, 'setItem'>>;

function defaultStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function presetKey(mode: InterfaceMode): string {
  return mode === 'hermes' ? HERMES_PRESET_KEY : WEB_PRESET_KEY;
}

export function compactKey(mode: InterfaceMode): string {
  return mode === 'hermes' ? HERMES_COMPACT_KEY : WEB_COMPACT_KEY;
}

/**
 * Simple is the default in both places. The web default is the one that shipped and stays put;
 * the Hermes default is stated here rather than borrowed, so a future web change cannot silently
 * make the embedded pane denser. This is the "readable Hermes" half of the redesign.
 */
export const DEFAULT_PRESET: Record<InterfaceMode, Preset> = {
  web: 'simple',
  hermes: 'simple',
};

export function defaultPreset(mode: InterfaceMode): Preset {
  return DEFAULT_PRESET[mode];
}

/**
 * Hermes never starts compact: the old default zoomed the docked page to 82%, which is what made
 * it hard to read. The browser keeps its existing behaviour (compact only when embedded).
 */
export function defaultCompact(mode: InterfaceMode, embedded: boolean): boolean {
  return mode === 'hermes' ? false : embedded;
}

export function readPreset(mode: InterfaceMode, storage?: ReadableStorage): Preset {
  const store = storage ?? defaultStorage();
  if (!store) return defaultPreset(mode);
  try {
    const raw = store.getItem(presetKey(mode));
    if (raw === 'simple' || raw === 'standard' || raw === 'everything') return raw;
  } catch {
    // Storage unavailable: the mode's default is a working layout.
  }
  return defaultPreset(mode);
}

export function writePreset(mode: InterfaceMode, preset: Preset, storage?: WritableStorage): void {
  const store = storage ?? defaultStorage();
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(presetKey(mode), preset);
  } catch {
    // Storage full or blocked; the layout still applies to this page.
  }
}

export function readCompact(
  mode: InterfaceMode,
  embedded: boolean,
  storage?: ReadableStorage,
): boolean {
  const store = storage ?? defaultStorage();
  if (!store) return defaultCompact(mode, embedded);
  try {
    const raw = store.getItem(compactKey(mode));
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Storage unavailable.
  }
  return defaultCompact(mode, embedded);
}

export function writeCompact(mode: InterfaceMode, compact: boolean, storage?: WritableStorage): void {
  const store = storage ?? defaultStorage();
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(compactKey(mode), compact ? '1' : '0');
  } catch {
    // Storage full or blocked.
  }
}

/**
 * The storage key for one mode-scoped preference. Web mode keeps the shipped bare key so existing
 * readers are unaffected; Hermes gets `omni.hermes.<name>`.
 */
export function scopedStorageKey(name: string, mode: InterfaceMode): string {
  return mode === 'hermes' ? `omni.hermes.${name}` : `omni.${name}`;
}

export function readScopedPref(
  name: string,
  mode: InterfaceMode,
  storage?: ReadableStorage,
): string | null {
  const store = storage ?? defaultStorage();
  if (!store) return null;
  try {
    return store.getItem(scopedStorageKey(name, mode));
  } catch {
    // Storage unavailable: the caller's default applies.
    return null;
  }
}

export function writeScopedPref(
  name: string,
  mode: InterfaceMode,
  value: string,
  storage?: WritableStorage,
): void {
  const store = storage ?? defaultStorage();
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(scopedStorageKey(name, mode), value);
  } catch {
    // Storage full or blocked; the choice still applies to this page.
  }
}

export function readScopedBool(
  name: string,
  mode: InterfaceMode,
  fallback: boolean,
  storage?: ReadableStorage,
): boolean {
  const raw = readScopedPref(name, mode, storage);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

export function writeScopedBool(
  name: string,
  mode: InterfaceMode,
  value: boolean,
  storage?: WritableStorage,
): void {
  writeScopedPref(name, mode, value ? '1' : '0', storage);
}

/**
 * Does this key hold a resettable view preference for `mode`? Reset View uses this as an allow
 * list: only a key that answers yes is removed. Everything else — the API token's session state,
 * privacy choices and dismissals, chat-list sort/group/collapse, the follow list, usage windows,
 * problem acknowledgements, the remembered mode, and the other mode's keys — is left alone.
 *
 * `omni.hermes.*` is never a web key even though the string also starts with `omni.`.
 */
export function isModePrefKey(key: string, mode: InterfaceMode): boolean {
  const prefix = mode === 'hermes' ? 'omni.hermes.' : 'omni.';
  if (!key.startsWith(prefix)) return false;
  if (mode === 'web' && key.startsWith('omni.hermes.')) return false;
  const rest = key.slice(prefix.length);
  if (rest === 'preset' || rest === 'compact') return true;
  if (rest.startsWith('layout.')) return true;
  if (rest.startsWith('panel.')) return true;
  return (MODE_VIEW_KEYS as readonly string[]).includes(rest);
}

export function isAnyModePrefKey(key: string): boolean {
  return isModePrefKey(key, 'web') || isModePrefKey(key, 'hermes');
}
