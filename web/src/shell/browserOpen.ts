/**
 * Asking the Hermes page to open this viewer in the user's web browser.
 *
 * A sandboxed frame cannot open windows itself, so it asks its parent. The request names only the
 * chat and the view: the viewer key is never put in a message (a message to an opaque-origin
 * parent has to go to "*"), and the Hermes page builds the link from its own copy of the key.
 * Hermes answers whether its browser launch worked; no answer means there is no Hermes page
 * listening (an older plugin, or some other host), which is reported, not guessed at.
 */

export const OPEN_WEB = 'omniscience:open-web';
export const OPEN_WEB_RESULT = 'omniscience:open-web-result';

export type BrowserOpenResult = 'opened' | 'failed' | 'no-answer';

export interface BrowserOpenRequest {
  session: string | null;
  view: string | null;
}

interface MessageTarget {
  postMessage: (message: unknown, targetOrigin: string) => void;
}

interface MessageSource {
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
}

let counter = 0;

export function requestBrowserOpen(
  request: BrowserOpenRequest,
  {
    parent,
    listenOn,
    timeoutMs = 5000,
  }: { parent: MessageTarget; listenOn: MessageSource; timeoutMs?: number },
): Promise<BrowserOpenResult> {
  counter += 1;
  const requestId = `open-${Date.now().toString(36)}-${counter}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BrowserOpenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listenOn.removeEventListener('message', onMessage);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      // Only our parent answers, and only for this request.
      if (event.source !== (parent as unknown)) return;
      const data = event.data as { type?: unknown; requestId?: unknown; ok?: unknown } | null;
      if (!data || data.type !== OPEN_WEB_RESULT || data.requestId !== requestId) return;
      finish(data.ok === true ? 'opened' : 'failed');
    };
    const timer = setTimeout(() => finish('no-answer'), timeoutMs);
    listenOn.addEventListener('message', onMessage);
    try {
      parent.postMessage(
        { type: OPEN_WEB, requestId, session: request.session, view: request.view },
        '*',
      );
    } catch {
      finish('no-answer');
    }
  });
}
