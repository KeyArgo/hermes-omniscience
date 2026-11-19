import { describe, expect, it } from 'vitest';
import {
  VIEWER_STOPPED_MESSAGE,
  VIEWER_UNREACHABLE,
  isViewerUnreachableError,
  notifyViewerUnreachable,
  viewerErrorText,
  viewerReadFailure,
} from './viewerSignal';

describe('notifyViewerUnreachable', () => {
  it('asks the host frame to bring the viewer back, with nothing but the type', () => {
    const sent: unknown[] = [];
    const parent = { postMessage: (m: unknown) => sent.push(m) };
    notifyViewerUnreachable({ parent });
    expect(sent).toEqual([{ type: VIEWER_UNREACHABLE }]);
    expect(VIEWER_UNREACHABLE).toBe('omniscience:viewer-unreachable');
  });

  it('says nothing in a top-level browser tab (its own parent)', () => {
    const sent: unknown[] = [];
    const scope: { parent?: unknown } = { parent: { postMessage: (m: unknown) => sent.push(m) } };
    scope.parent = scope; // window.parent === window
    notifyViewerUnreachable(scope);
    expect(sent).toEqual([]);
  });

  it('says nothing when there is no parent, and survives a parent that throws', () => {
    expect(() => notifyViewerUnreachable({})).not.toThrow();
    expect(() => notifyViewerUnreachable(undefined)).not.toThrow();
    const hostile = { parent: { postMessage: () => { throw new Error('gone'); } } };
    expect(() => notifyViewerUnreachable(hostile)).not.toThrow();
  });
});

describe('isViewerUnreachableError', () => {
  it('recognises the transport rejection of every browser', () => {
    expect(isViewerUnreachableError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isViewerUnreachableError(new TypeError('Load failed'))).toBe(true);
    expect(isViewerUnreachableError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isViewerUnreachableError(new TypeError('fetch failed'))).toBe(true);
  });

  it('does not mistake the page\'s own abort, timeout or a bad answer for a stopped viewer', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    const timeout = new Error('The operation timed out.');
    timeout.name = 'TimeoutError';
    expect(isViewerUnreachableError(abort)).toBe(false);
    expect(isViewerUnreachableError(timeout)).toBe(false);
    expect(isViewerUnreachableError(new Error('401 Unauthorized'))).toBe(false);
    expect(isViewerUnreachableError(new Error('The chat list did not answer within 30s'))).toBe(false);
    expect(isViewerUnreachableError(null)).toBe(false);
    expect(isViewerUnreachableError('Failed to fetch')).toBe(false);
  });
});

describe('viewerErrorText', () => {
  it('replaces a raw transport error with the stopped-viewer sentence', () => {
    expect(viewerErrorText(new TypeError('Failed to fetch'), 'could not read the recording'))
      .toBe(VIEWER_STOPPED_MESSAGE);
    expect(VIEWER_STOPPED_MESSAGE).toBe('The viewer stopped. Open Omniscience in Hermes to start it again.');
  });

  it('keeps every other error\'s own words', () => {
    expect(viewerErrorText(new Error('the viewer answered 500'), 'fallback')).toBe('the viewer answered 500');
    expect(viewerErrorText(null, 'fallback')).toBe('fallback');
    expect(viewerErrorText(new Error(''), 'fallback')).toBe('fallback');
  });
});

describe('viewerReadFailure (what a view catch block calls)', () => {
  it('reports a stopped viewer to the host AND reads as the sentence, in one step', () => {
    const sent: unknown[] = [];
    const win = { parent: { postMessage: (m: unknown) => sent.push(m) } };
    const text = viewerReadFailure(new TypeError('Failed to fetch'), 'could not read the recording');
    // No window in scope here means no host; pass the frame explicitly through the same path
    // the views use by stubbing the global window the module reads.
    expect(text).toBe(VIEWER_STOPPED_MESSAGE);
    expect(sent).toEqual([]);
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = win;
    try {
      const framed = viewerReadFailure(new TypeError('Failed to fetch'), 'could not read the recording');
      expect(framed).toBe(VIEWER_STOPPED_MESSAGE);
      expect(sent).toEqual([{ type: VIEWER_UNREACHABLE }]);
    } finally {
      if (previous === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previous;
    }
  });

  it('does not report an ordinary bad answer, and keeps its words', () => {
    const sent: unknown[] = [];
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { parent: { postMessage: (m: unknown) => sent.push(m) } };
    try {
      expect(viewerReadFailure(new Error('the viewer answered 500'), 'fallback')).toBe('the viewer answered 500');
      expect(sent).toEqual([]);
    } finally {
      if (previous === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previous;
    }
  });
});
