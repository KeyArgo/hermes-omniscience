/**
 * Whether somebody is actually looking at this page.
 *
 * The page is often open without being looked at: a background browser tab, a minimised Hermes
 * window, or the pane scrolled out of sight inside Hermes Desktop. In the last case the page sits
 * in a sandboxed iframe with an opaque origin, so the parent cannot send it a message — but the
 * page can still work it out for itself:
 *
 *   • `document.visibilityState` says whether the document is the one being shown, and
 *   • an IntersectionObserver on `document.documentElement` says whether its box is on screen at
 *     all. An iframe that is `display: none`, or clipped/scrolled out of its parent's viewport,
 *     reports `isIntersecting: false` even while the document itself claims to be visible.
 *
 * Both must agree before anything live (the socket, the polling timers) is allowed to run.
 *
 * Going hidden is debounced: a layout change can drop the document out of view for a frame or
 * two, and dropping the live socket for that would cost a reconnect (plus a replayed backlog) for
 * nothing. Going visible is immediate — the reader is looking, so the page has to be current.
 *
 * Two shapes are exported on purpose. `usePageVisible()` is for React. `pageVisible()` and
 * `subscribePageVisible()` are for effects and plain modules: a timer that must not be cleared and
 * rebuilt on every render can ask the same store without becoming a render dependency.
 */

import { useSyncExternalStore } from 'react';

/** The slice of `document` this module touches, so a test can stand one up without a DOM. */
export interface VisibilityDocument {
  visibilityState?: string;
  hidden?: boolean;
  documentElement?: Element | null;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Watches whether the document's element is on screen. Returns an unsubscribe function, and
 * reports the first state synchronously before returning so a caller never starts out guessing.
 */
export type IntersectionWatch = (onChange: (intersecting: boolean) => void) => () => void;

export interface PageVisibilityOptions {
  doc?: VisibilityDocument;
  /** How long a hide must last before it counts. 0 disables the debounce. */
  hideDelayMs?: number;
  /** `null` disables observation entirely and leaves `document.visibilityState` in charge. */
  observe?: IntersectionWatch | null;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface PageVisibility {
  /** True only when the document is visible AND its element is on screen. */
  get(): boolean;
  subscribe(listener: () => void): () => void;
  stop(): void;
}

/** 1.5 s: long enough to ride out a layout flicker, short enough to be quiet in practice. */
export const HIDE_DELAY_MS = 1500;

function documentIsVisible(doc: VisibilityDocument): boolean {
  if (typeof doc.visibilityState === 'string' && doc.visibilityState.length > 0) {
    return doc.visibilityState === 'visible';
  }
  // Older/edge environments only fill in `hidden`.
  return doc.hidden !== true;
}

/**
 * The default watcher: observe the document's own element. Threshold 0 means "any part on
 * screen", which is what a pane peeking out of a collapsed sidebar looks like.
 */
function intersectionWatch(doc: VisibilityDocument): IntersectionWatch | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  const target = doc.documentElement;
  if (!target) return null;
  return (onChange) => {
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) onChange(entry.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  };
}

/**
 * The whole mechanism, with its environment injected. The singleton below is one of these wired to
 * the real document; tests build their own with a fake document, a fake observer and fake timers.
 */
export function createPageVisibility(options: PageVisibilityOptions = {}): PageVisibility {
  const doc = options.doc ?? (globalThis.document as unknown as VisibilityDocument);
  const hideDelayMs = options.hideDelayMs ?? HIDE_DELAY_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((id) => globalThis.clearTimeout(id));
  const observe =
    options.observe === undefined ? intersectionWatch(doc) : options.observe;

  const listeners = new Set<() => void>();
  // Starting state: believe the document's own answer now, and let the first observer callback
  // correct it. Waiting for a callback would leave a page that loads hidden "visible" for a frame.
  let intersecting = true;
  let visible = documentIsVisible(doc);
  // `visible` and `intersecting` are the raw inputs; `reported` is what subscribers see, which
  // trails them by the hide debounce.
  let reported = visible;
  let hideTimer: number | undefined;

  const emit = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const cancelHide = () => {
    if (hideTimer !== undefined) {
      clearTimer(hideTimer);
      hideTimer = undefined;
    }
  };

  const recompute = () => {
    const wanted = visible && intersecting;
    if (wanted) {
      // Visible is immediate: the reader is looking, so the page has to catch up now.
      cancelHide();
      if (!reported) {
        reported = true;
        emit();
      }
      return;
    }
    if (!reported || hideTimer !== undefined) return;
    hideTimer = setTimer(() => {
      hideTimer = undefined;
      if (visible && intersecting) return;
      if (!reported) return;
      reported = false;
      emit();
    }, hideDelayMs);
  };

  const onVisibilityChange = () => {
    visible = documentIsVisible(doc);
    recompute();
  };

  doc.addEventListener('visibilitychange', onVisibilityChange);
  const stopObserving = observe
    ? observe((next) => {
        intersecting = next;
        recompute();
      })
    : null;

  return {
    get: () => reported,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      cancelHide();
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      stopObserving?.();
      listeners.clear();
    },
  };
}

let shared: PageVisibility | null = null;

function sharedVisibility(): PageVisibility {
  if (!shared) shared = createPageVisibility();
  return shared;
}

/** True only when the page is visible and on screen. Safe to call outside a browser. */
export function pageVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return sharedVisibility().get();
}

/** Subscribe to changes of `pageVisible()`. Returns an unsubscribe function. */
export function subscribePageVisible(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  return sharedVisibility().subscribe(listener);
}

/** The React read of the same answer. Re-renders the caller when it changes. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribePageVisible, pageVisible, pageVisible);
}

/** Drops the shared store so a test can build a new one against its own fake document. */
export function resetSharedPageVisibility(): void {
  shared?.stop();
  shared = null;
}
