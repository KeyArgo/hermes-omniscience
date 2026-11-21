import { describe, expect, it } from 'vitest';
import {
  DETAILS_CLOSED,
  detailsRailShown,
  detailsWorkspaceClass,
  escapeClosesDetails,
  isTypingTarget,
  selectionLeftGraph,
} from './detailsPanel';

const escape = { key: 'Escape', defaultPrevented: false };
const quiet = {
  anyDialogOpen: false,
  menuOpen: false,
  tourActive: false,
  typing: false,
  areaFocused: false,
};

describe('the details rail is only there while it has something to show', () => {
  it('is drawn for a selected step, and gone when nothing is selected', () => {
    expect(detailsRailShown('llm:req-10', 'details')).toBe(true);
    expect(detailsRailShown(null, 'details')).toBe(false);
  });

  it('is drawn for the mini panel even with nothing selected — that is its watch list', () => {
    expect(detailsRailShown(null, 'follow')).toBe(true);
  });

  it('tells the workspace not to reserve a third column when the rail is gone', () => {
    expect(detailsWorkspaceClass(true)).toBe('');
    expect(detailsWorkspaceClass(false)).toBe(' no-details');
  });
});

describe('closing the details panel', () => {
  it('ends the selection and folds the rail, so neither the panel nor a strip is left behind', () => {
    expect(DETAILS_CLOSED.selectedNodeId).toBeNull();
    expect(DETAILS_CLOSED.railFolded).toBe(true);
    expect(detailsRailShown(DETAILS_CLOSED.selectedNodeId, 'details')).toBe(false);
    expect(detailsWorkspaceClass(detailsRailShown(DETAILS_CLOSED.selectedNodeId, 'details')))
      .toBe(' no-details');
  });

  it('Escape closes it while a step is selected', () => {
    expect(escapeClosesDetails(escape, quiet, true)).toBe(true);
  });

  it('Escape does nothing when no step is selected, or the key is not Escape', () => {
    expect(escapeClosesDetails(escape, quiet, false)).toBe(false);
    expect(escapeClosesDetails({ key: 'Enter', defaultPrevented: false }, quiet, true)).toBe(false);
  });

  it('lets the innermost layer own Escape', () => {
    expect(escapeClosesDetails(escape, { ...quiet, anyDialogOpen: true }, true)).toBe(false);
    expect(escapeClosesDetails(escape, { ...quiet, menuOpen: true }, true)).toBe(false);
    expect(escapeClosesDetails(escape, { ...quiet, tourActive: true }, true)).toBe(false);
    expect(escapeClosesDetails(escape, { ...quiet, typing: true }, true)).toBe(false);
    expect(escapeClosesDetails({ key: 'Escape', defaultPrevented: true }, quiet, true)).toBe(false);
  });

  it('leaves an expanded area first, and closes the panel only on the next Escape', () => {
    // "Expand details" / "Expand view" puts the panel (or the stage) over the rest of the page.
    // Escape there means "come back to the drawn layout" — the details listener runs first, so
    // without this it wiped the selection and left the area expanded over an empty page.
    expect(escapeClosesDetails(escape, { ...quiet, areaFocused: true }, true)).toBe(false);
    // The second Escape finds no expanded area and closes the panel as it always did.
    expect(escapeClosesDetails(escape, quiet, true)).toBe(true);
  });

  it('closing from the mini panel closes it, rather than leaving the rail in mini mode', () => {
    // `railMode === 'follow'` keeps the rail on screen with nothing selected, so a close that
    // forgot the mode left it "shown": Escape was a no-op and the ‹ Details strip unmounted it.
    expect(DETAILS_CLOSED.railMode).toBe('details');
    expect(detailsRailShown(DETAILS_CLOSED.selectedNodeId, DETAILS_CLOSED.railMode)).toBe(false);
  });

  it('closes a selection the graph no longer holds, but not one still arriving', () => {
    const ids = ['llm:a', 'tool:b'];
    // Still on the map: nothing to do.
    expect(selectionLeftGraph('llm:a', ids, 'llm:a')).toBe(false);
    // Selected before the re-run that will draw it (a collapsed group, a new chat): an expanded
    // turn belongs to no node until the worker replies, so a selection that was never there is
    // not a selection that "went away".
    expect(selectionLeftGraph('llm:a', ['tool:b'], null)).toBe(false);
    // It was drawn and then left — a filter, Errors only, or the replay slider moved back past
    // it. At 700 px the drawer hides while its scrim stays, so the panel must close with it.
    expect(selectionLeftGraph('llm:a', ['tool:b'], 'llm:a')).toBe(true);
    expect(selectionLeftGraph(null, ['tool:b'], 'llm:a')).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('treats the fields a reader types in as typing, and buttons as not', () => {
    expect(isTypingTarget(null)).toBe(false);
    const input = (type: string) => ({ tagName: 'INPUT', type, isContentEditable: false }) as unknown as Element;
    expect(isTypingTarget(input('text'))).toBe(true);
    expect(isTypingTarget(input('search'))).toBe(true);
    expect(isTypingTarget(input('checkbox'))).toBe(false);
    expect(isTypingTarget(input('range'))).toBe(false);
    const tag = (name: string) => ({ tagName: name, isContentEditable: false }) as unknown as Element;
    expect(isTypingTarget(tag('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(tag('BUTTON'))).toBe(false);
  });
});
