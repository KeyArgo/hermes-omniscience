/**
 * Telling the Hermes page that this viewer cannot be reached.
 *
 * The viewer stops when the Hermes process that started it exits, or after ten idle minutes. An
 * open page then finds nothing listening: fetch rejects with "Failed to fetch" and the live socket
 * closes. Inside Hermes the page that embedded this frame can start the viewer again, so the page
 * says so with one message — `omniscience:viewer-unreachable` — and the host restarts the viewer
 * and reloads the frame with the fresh key. The message carries nothing else: no key, no URL.
 *
 * In a plain browser tab there is no host to ask (window.parent is the page itself), so the same
 * failure is shown as a sentence instead of a raw transport error: the viewer stopped, and opening
 * Omniscience in Hermes starts it again.
 */

export const VIEWER_UNREACHABLE = 'omniscience:viewer-unreachable';

export const VIEWER_STOPPED_MESSAGE =
  'The viewer stopped. Open Omniscience in Hermes to start it again.';

interface ParentLike {
  postMessage: (message: unknown, targetOrigin: string) => void;
}

/**
 * Ask the host frame to bring the viewer back. A no-op in a top-level browser tab, and silent
 * when there is no parent at all — the caller still shows its own error either way.
 */
export function notifyViewerUnreachable(win?: { parent?: unknown }): void {
  try {
    const scope =
      win ?? (typeof window === 'undefined' ? undefined : (window as unknown as { parent?: unknown }));
    const parent = scope?.parent as ParentLike | undefined;
    // A page that is its own parent is a browser tab: nobody is listening.
    if (!parent || parent === scope) return;
    parent.postMessage({ type: VIEWER_UNREACHABLE }, '*');
  } catch {
    /* the frame went away */
  }
}

/**
 * Whether a fetch rejection means "nothing is listening" rather than a bad answer. Each browser
 * words it differently: Chrome/Edge "Failed to fetch", Safari "Load failed", Firefox
 * "NetworkError when attempting to fetch resource", undici "fetch failed". An abort or a timeout
 * is the page's own decision, not a stopped viewer.
 */
export function isViewerUnreachableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message);
}

/** The sentence a person reads: the stopped-viewer explanation, or the error's own words. */
export function viewerErrorText(error: unknown, fallback: string): string {
  if (isViewerUnreachableError(error)) return VIEWER_STOPPED_MESSAGE;
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

/**
 * One read failure, handled: a stopped viewer is reported to the host (which restarts it and
 * reloads this frame) and reads as the stopped-viewer sentence; every other error keeps its own
 * words. This is what a view's catch block calls, so the report and the text cannot drift apart.
 */
export function viewerReadFailure(error: unknown, fallback: string): string {
  if (isViewerUnreachableError(error)) notifyViewerUnreachable();
  return viewerErrorText(error, fallback);
}
