/**
 * The right-hand details panel: when it is there, and what takes it away.
 *
 * The panel is a detail view, not a column the page always owns. It is drawn only while it has
 * something to show — a selected step, or the mini panel's watch list — and there is no reserved
 * column, strip or empty frame when there is nothing selected. Clicking a step opens it; the × in
 * its head, Escape, or a click on empty map space closes it, because all three end with no
 * selected step. The old page kept the column (and a 360 px empty inspector) after the selection
 * was cleared, which is what "the frame never goes away" looked like.
 */

export type RailMode = 'details' | 'follow';

/**
 * Where every closing path lands: nothing selected, and the rail folded away with it. The mode
 * goes back to details too — the mini panel (`railMode: 'follow'`) keeps the rail on screen with
 * nothing selected, so a close that forgot the mode left it "shown": Escape became a no-op and
 * the desktop `‹ Details` strip unmounted the rail instead of opening it.
 */
export const DETAILS_CLOSED = {
  selectedNodeId: null,
  railMode: 'details',
  railFolded: true,
} as const;

/**
 * Is the details rail on screen? Only a selected step or the mini panel gives it something to
 * show; with neither, the workspace is two columns and the rail is not rendered at all.
 */
export function detailsRailShown(selectedNodeId: string | null, railMode: RailMode): boolean {
  return selectedNodeId !== null || railMode === 'follow';
}

/**
 * The workspace class that stops the grid reserving a third column for a rail that is not there.
 * The class is what makes "no right column" true in the layout, not just in the DOM.
 */
export function detailsWorkspaceClass(railShown: boolean): string {
  return railShown ? '' : ' no-details';
}

export interface DetailsEscapeContext {
  /** A Panels/Help/Settings/Privacy dialog is open: it owns Escape. */
  anyDialogOpen: boolean;
  /** An open menu (Filters, Actions, Help) is layered above the page. */
  menuOpen: boolean;
  /** The tour drives its own Escape to move between stops. */
  tourActive: boolean;
  /** The caret is in a field; Escape belongs to what is being typed. */
  typing: boolean;
  /** "Expand details" or "Expand view" is on: Escape restores the drawn layout first. */
  areaFocused: boolean;
}

/**
 * Escape closes the details panel — and only the details panel. The innermost layer wins: a
 * dialog, a menu, the tour, an expanded area or a text field handles Escape itself, and a handler
 * that already consumed the key (event.defaultPrevented) is not overruled.
 *
 * The expanded area matters most: this listener is registered before the area handler, so a key
 * it took would close the panel and leave the area expanded over an empty page. Declining here
 * lets the area collapse, and the next Escape (no area focused) closes the panel.
 */
export function escapeClosesDetails(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>,
  context: DetailsEscapeContext,
  hasSelection: boolean,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (!hasSelection) return false;
  if (context.anyDialogOpen || context.menuOpen || context.tourActive) return false;
  if (context.areaFocused) return false;
  return !context.typing;
}

/**
 * Has the selected step left the graph? True only for a step that was drawn and is now gone —
 * a filter (Hide tool steps, Errors only) or the replay slider moving back past it. The panel
 * closes with it, because at 700 px and below the drawer hides without a selection while its
 * scrim stays and covers the page.
 *
 * `seenInGraph` is the id the graph last held. A step that has not appeared yet is still
 * arriving (the graph is rebuilt in a worker, and expanding a turn re-draws it), so it is not a
 * step that went away.
 */
export function selectionLeftGraph(
  selectedNodeId: string | null,
  nodeIds: readonly string[],
  seenInGraph: string | null,
): boolean {
  if (selectedNodeId === null) return false;
  if (nodeIds.includes(selectedNodeId)) return false;
  return seenInGraph === selectedNodeId;
}

/** Is the focused element a text field, so Escape means "leave what I am typing"? */
export function isTypingTarget(target: Element | null): boolean {
  // Read the shape rather than using `instanceof HTMLElement`: this helper is also exercised in a
  // DOM-less test process, where there is no HTMLElement to test against.
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (element as HTMLInputElement).type;
  return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'range';
}
