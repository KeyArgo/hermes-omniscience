import { describe, expect, it } from 'vitest';
import { VIEW_RESET, isResetPanelKey, resetStorageKeys } from './viewReset';
import { detailsRailShown } from './detailsPanel';
import { layoutStorageKey } from './layoutPrefs';

describe('Reset view restores the defaults of the view', () => {
  it('clears the selected step, so the details panel closes with it', () => {
    expect(VIEW_RESET.selectedNodeId).toBeNull();
    expect(detailsRailShown(VIEW_RESET.selectedNodeId, VIEW_RESET.railMode)).toBe(false);
  });

  it('closes the side panels: the mini panel is off and the rail is folded', () => {
    expect(VIEW_RESET.railMode).toBe('details');
    expect(VIEW_RESET.railFolded).toBe(true);
  });

  it('un-minimizes the card, leaves "Expand details" and returns to the map on live', () => {
    expect(VIEW_RESET.statusMinimized).toBe(false);
    expect(VIEW_RESET.focusedArea).toBeNull();
    expect(VIEW_RESET.view).toBe('graph');
    expect(VIEW_RESET.replayIndex).toBeNull();
    expect(VIEW_RESET.playing).toBe(false);
  });

  it('clears the filters back to showing everything', () => {
    expect(VIEW_RESET.hideTools).toBe(false);
    expect(VIEW_RESET.hideLlms).toBe(false);
    expect(VIEW_RESET.errorsOnly).toBe(false);
  });
});

describe('Reset view touches storage it does not own', () => {
  it("removes only this mode's panel layout for its preset", () => {
    expect(resetStorageKeys('hermes', 'simple')).toEqual(['omni.hermes.layout.simple']);
    expect(resetStorageKeys('web', 'simple')).toEqual([layoutStorageKey('simple', 'web')]);
    // The keys it must never remove: the look, the size and the other mode's layout.
    for (const key of resetStorageKeys('hermes', 'simple')) {
      expect(key).not.toContain('theme');
      expect(key).not.toContain('accent');
      expect(key).not.toContain('interface');
      expect(key.startsWith('omni.layout.')).toBe(false);
    }
  });

  it('forgets panel heights and folds, and only in this mode', () => {
    expect(isResetPanelKey('omni.panel.context-lane.h', 'web')).toBe(true);
    expect(isResetPanelKey('omni.hermes.panel.context-lane.h', 'hermes')).toBe(true);
    // The other mode keeps its geometry, and the look is not geometry.
    expect(isResetPanelKey('omni.hermes.panel.context-lane.h', 'web')).toBe(false);
    expect(isResetPanelKey('omni.panel.context-lane.h', 'hermes')).toBe(false);
    expect(isResetPanelKey('omni.theme', 'web')).toBe(false);
    expect(isResetPanelKey('omni.hermes.interfaceSize', 'hermes')).toBe(false);
  });
});
