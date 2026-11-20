/**
 * What Reset view puts back, and what it deliberately leaves alone.
 *
 * Reset view is about where you are looking, not about how the page is configured: it clears the
 * selected step, closes the details rail and the mini panel, unfolds the status card, brings the
 * map back to its default camera and puts the panel layout back to the defaults of the preset you
 * are in (it does not switch presets, and it only touches the mode on screen).
 *
 * It never touches the recording, the Settings switches (compact text, chat titles, Follow newest,
 * default view, the context strip, interface size) or the theme and accent — those are choices
 * about how Omniscience looks, and a reader who presses Reset after losing the panel did not ask
 * for a different look. Only the panel-layout key for the preset is removed, which is why
 * `resetStorageKeys` is an allow list of one rather than a sweep of every per-mode key.
 */

import type { Preset } from './layoutPrefs';
import { layoutStorageKey } from './layoutPrefs';
import { HERMES_PANEL_PREFIX, WEB_PANEL_PREFIX } from './modePrefs';
import type { InterfaceMode } from './mode';
import type { RailMode } from './detailsPanel';
import type { ViewMode } from '../components/SettingsPanel';

export interface ViewResetState {
  /** No step selected: the details rail has nothing to show and closes with it. */
  selectedNodeId: null;
  /** The panel starts on Inspect again, not on the mini panel's watch list. */
  railMode: RailMode;
  /** Folded, so a stale rail cannot reopen folded open behind a fresh selection. */
  railFolded: boolean;
  /** The map, where the camera reset is visible. */
  view: ViewMode;
  /** Leave the "Expand details" full-page view along with the panel. */
  focusedArea: null;
  /** Un-minimize the status card. */
  statusMinimized: boolean;
  hideTools: boolean;
  hideLlms: boolean;
  errorsOnly: boolean;
  /** Back to live: a replay cursor is a place in the recording, not a layout. */
  replayIndex: null;
  playing: boolean;
}

export const VIEW_RESET: ViewResetState = {
  selectedNodeId: null,
  railMode: 'details',
  railFolded: true,
  view: 'graph',
  focusedArea: null,
  statusMinimized: false,
  hideTools: false,
  hideLlms: false,
  errorsOnly: false,
  replayIndex: null,
  playing: false,
};

/**
 * The stored keys Reset view removes. One key: the panel layout for the preset on screen.
 * Everything else in this mode's namespace — theme, accent, interface size, view, map style,
 * the follow list — stays exactly as the reader left it.
 */
export function resetStorageKeys(mode: InterfaceMode, preset: Preset): string[] {
  return [layoutStorageKey(preset, mode)];
}

/**
 * Panel heights and folds are part of the layout, so Reset view forgets them too. They are stored
 * per panel under this mode's own prefix, which is why this is a prefix test rather than another
 * fixed key: the panels on screen are not known until the recording is read.
 */
export function isResetPanelKey(key: string, mode: InterfaceMode): boolean {
  return key.startsWith(mode === 'hermes' ? HERMES_PANEL_PREFIX : WEB_PANEL_PREFIX);
}
