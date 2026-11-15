import { describe, expect, it } from 'vitest';
import {
  chatsEscapeCloses,
  drawerOpensOnChatsClick,
  headerLayout,
  shortcutsBlockedByOverlay,
  shouldRescueChatsFocus,
  shouldRescueWorkspaceFocus,
  shouldRestoreDialogOpener,
  shouldReturnDialogFocus,
  workspaceEscapeCloses,
} from './App';

const escape = { key: 'Escape', defaultPrevented: false };

describe('workspace sheet Escape layering', () => {
  it('closes while focus is on the Workspace control or inside the sheet', () => {
    const base = { onControl: false, inPanel: false, nestedOverlay: false };
    expect(workspaceEscapeCloses(escape, { ...base, onControl: true })).toBe(true);
    expect(workspaceEscapeCloses(escape, { ...base, inPanel: true })).toBe(true);
  });

  it('leaves the sheet open when focus is somewhere else on the page', () => {
    expect(
      workspaceEscapeCloses(escape, { onControl: false, inPanel: false, nestedOverlay: false }),
    ).toBe(false);
  });

  it('lets a nested dialog or menu own Escape instead of closing both layers', () => {
    expect(
      workspaceEscapeCloses(escape, { onControl: false, inPanel: true, nestedOverlay: true }),
    ).toBe(false);
  });

  it('ignores Escape another handler already consumed and keys that are not Escape', () => {
    const context = { onControl: true, inPanel: true, nestedOverlay: false };
    expect(workspaceEscapeCloses({ key: 'Escape', defaultPrevented: true }, context)).toBe(false);
    expect(workspaceEscapeCloses({ key: 'Enter', defaultPrevented: false }, context)).toBe(false);
  });
});

describe('Chats Escape scope', () => {
  const context = { narrow: true, open: true, onControl: false, inPanel: true };

  it('closes the narrow drawer from its button or from inside the list', () => {
    expect(chatsEscapeCloses(escape, context)).toBe(true);
    expect(chatsEscapeCloses(escape, { ...context, inPanel: false, onControl: true })).toBe(true);
  });

  it('never folds the persistent wide column', () => {
    expect(chatsEscapeCloses(escape, { ...context, narrow: false })).toBe(false);
    expect(
      chatsEscapeCloses(escape, { narrow: false, open: true, onControl: true, inPanel: true }),
    ).toBe(false);
  });

  it('does nothing when the list is already closed or a dialog handled the key', () => {
    expect(chatsEscapeCloses(escape, { ...context, open: false })).toBe(false);
    expect(chatsEscapeCloses({ key: 'Escape', defaultPrevented: true }, context)).toBe(false);
    expect(chatsEscapeCloses({ key: 'x', defaultPrevented: false }, context)).toBe(false);
  });
});

describe('Chats drawer session is scoped to the drawer width', () => {
  it('does not arm a drawer when Chats is used on a wide window', () => {
    expect(drawerOpensOnChatsClick(false)).toBe(false);
    expect(drawerOpensOnChatsClick(true)).toBe(true);
  });
});

describe('breakpoint focus rescue', () => {
  it('returns focus to Chats only when the list is no longer shown', () => {
    expect(shouldRescueChatsFocus(false, true, false)).toBe(true);
    expect(shouldRescueChatsFocus(false, false, true)).toBe(true);
    expect(shouldRescueChatsFocus(true, true, true)).toBe(false);
    expect(shouldRescueChatsFocus(false, false, false)).toBe(false);
  });

  it('rescues workspace focus only when the sheet/toggle owned it and nothing else will', () => {
    expect(shouldRescueWorkspaceFocus(false, false, false, true)).toBe(true);
    expect(shouldRescueWorkspaceFocus(true, false, false, true)).toBe(false);
    expect(shouldRescueWorkspaceFocus(false, true, false, true)).toBe(false);
    expect(shouldRescueWorkspaceFocus(false, false, true, true)).toBe(false);
    expect(shouldRescueWorkspaceFocus(false, false, false, false)).toBe(false);
  });
});

describe('dialog focus return', () => {
  it('waits for every dialog in a chain to close', () => {
    expect(shouldReturnDialogFocus(false, true)).toBe(true);
    expect(shouldReturnDialogFocus(true, true)).toBe(false);
    expect(shouldReturnDialogFocus(false, false)).toBe(false);
  });

  it('uses a remembered opener only while it is still a real page element', () => {
    expect(shouldRestoreDialogOpener(true, true, false)).toBe(true);
    expect(shouldRestoreDialogOpener(true, false, false)).toBe(false);
    expect(shouldRestoreDialogOpener(true, true, true)).toBe(false);
    expect(shouldRestoreDialogOpener(false, true, false)).toBe(false);
  });
});

describe('global shortcut overlay guard', () => {
  const base = {
    panelsOpen: false,
    helpOpen: false,
    settingsOpen: false,
    privacyOpen: false,
    insightOpen: false,
    tourActive: false,
  };

  it('allows page shortcuts only when no overlay is on screen', () => {
    expect(shortcutsBlockedByOverlay(base)).toBe(false);
  });

  it('blocks shortcuts behind every dialog and the Tour', () => {
    for (const key of [
      'panelsOpen',
      'helpOpen',
      'settingsOpen',
      'privacyOpen',
      'insightOpen',
      'tourActive',
    ] as const) {
      expect(shortcutsBlockedByOverlay({ ...base, [key]: true })).toBe(true);
    }
  });
});

describe('header layout at laptop widths', () => {
  it('always exposes a Tour target for the Panels stop', () => {
    expect(headerLayout(true).panelsTourAnchor).toBe('workspace');
    expect(headerLayout(false).panelsTourAnchor).toBe('panels');
  });

  it('keeps exactly the icon Reset in the Workspace sheet and leaves the wide pair alone', () => {
    const compact = headerLayout(true);
    const wide = headerLayout(false);
    expect(compact.showResetIcon).toBe(true);
    expect(compact.showResetChip).toBe(false);
    expect(wide.showResetIcon).toBe(true);
    expect(wide.showResetChip).toBe(true);
  });

  it('keeps Follow Newest and Timeline/Links inline on laptop widths, not phone widths', () => {
    expect(headerLayout(true, false).quickControlsInline).toBe(true);
    expect(headerLayout(true, true).quickControlsInline).toBe(false);
    expect(headerLayout(false, false).quickControlsInline).toBe(false);
  });
});
