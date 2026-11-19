import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HIDE_DELAY_MS,
  createPageVisibility,
  pageVisible,
  resetSharedPageVisibility,
  subscribePageVisible,
  usePageVisible,
  type IntersectionWatch,
} from './usePageVisible';

/**
 * Just enough `document` for the store: the two properties it reads, the element it observes, and
 * a visibilitychange event it can fire. No DOM, no jsdom — the module only touches these.
 */
class FakeDocument {
  visibilityState: string;
  hidden: boolean;
  documentElement = { tag: 'html' } as unknown as Element;
  private listeners = new Set<() => void>();

  constructor(visible = true) {
    this.visibilityState = visible ? 'visible' : 'hidden';
    this.hidden = !visible;
  }

  addEventListener(type: string, listener: () => void) {
    if (type === 'visibilitychange') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    if (type === 'visibilitychange') this.listeners.delete(listener);
  }

  /** What the browser does: flip both properties, then fire one visibilitychange. */
  setVisible(next: boolean) {
    this.visibilityState = next ? 'visible' : 'hidden';
    this.hidden = !next;
    for (const listener of Array.from(this.listeners)) listener();
  }

  get listenerCount() {
    return this.listeners.size;
  }
}

/** A stand-in for the IntersectionObserver the module wires to documentElement. */
function fakeWatch() {
  const watchers: ((intersecting: boolean) => void)[] = [];
  let unsubscribed = 0;
  const watch: IntersectionWatch = (onChange) => {
    watchers.push(onChange);
    return () => {
      unsubscribed += 1;
      const index = watchers.indexOf(onChange);
      if (index >= 0) watchers.splice(index, 1);
    };
  };
  return {
    watch,
    /** What an iframe going display:none, or a pane scrolling out of view, reports. */
    report(intersecting: boolean) {
      for (const watcher of Array.from(watchers)) watcher(intersecting);
    },
    get watching() {
      return watchers.length;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

/** A global IntersectionObserver replacement that records what it was asked to watch. */
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];
  observed: Element[] = [];
  disconnected = false;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    StubIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {
    /* not used */
  }

  disconnect() {
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  emit(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function build(visible = true) {
  const doc = new FakeDocument(visible);
  const watch = fakeWatch();
  const store = createPageVisibility({ doc, observe: watch.watch });
  const seen: boolean[] = [];
  store.subscribe(() => seen.push(store.get()));
  return { doc, watch, store, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSharedPageVisibility();
});

describe('page visibility', () => {
  it('starts visible and says nothing until something changes', () => {
    const { store, seen } = build();
    expect(store.get()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(store.get()).toBe(true);
    expect(seen).toEqual([]);
  });

  it('reports a page that loads hidden straight away, without waiting for the debounce', () => {
    const { store } = build(false);
    expect(store.get()).toBe(false);
  });

  it('waits 1.5 s before calling the page hidden', () => {
    const { doc, store, seen } = build();
    doc.setVisible(false);
    expect(store.get()).toBe(true);
    vi.advanceTimersByTime(HIDE_DELAY_MS - 1);
    expect(store.get()).toBe(true);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(store.get()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('never reports hidden for a flicker shorter than the debounce', () => {
    const { doc, store, seen } = build();
    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS - 200);
    doc.setVisible(true);
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3);
    expect(store.get()).toBe(true);
    expect(seen).toEqual([]);
  });

  it('comes back the instant the page is visible again', () => {
    const { doc, store, seen } = build();
    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(store.get()).toBe(false);
    doc.setVisible(true);
    // No timers advanced: visible is immediate, or the page would sit silent while being read.
    expect(store.get()).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it('treats a pane that is scrolled out of sight as hidden even while the document is visible', () => {
    const { doc, watch, store, seen } = build();
    expect(doc.visibilityState).toBe('visible');
    watch.report(false);
    expect(store.get()).toBe(true);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(store.get()).toBe(false);
    expect(seen).toEqual([false]);
    watch.report(true);
    expect(store.get()).toBe(true);
  });

  it('stays hidden while the document is hidden, whatever the observer reports', () => {
    const { doc, watch, store, seen } = build();
    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(store.get()).toBe(false);
    // A hidden document can still report its box as intersecting.
    watch.report(true);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(store.get()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('does not fire twice for the same answer', () => {
    const { doc, watch, store, seen } = build();
    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    doc.setVisible(false);
    watch.report(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(store.get()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('falls back to document.visibilityState when IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const doc = new FakeDocument(true);
    // No `observe` option: the module decides, and there is nothing to observe with.
    const store = createPageVisibility({ doc });
    expect(store.get()).toBe(true);
    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(store.get()).toBe(false);
    doc.setVisible(true);
    expect(store.get()).toBe(true);
    store.stop();
  });

  it('observes documentElement with a real IntersectionObserver and unobserves on stop', () => {
    StubIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);
    const doc = new FakeDocument(true);
    const store = createPageVisibility({ doc });
    const observer = StubIntersectionObserver.instances[0];
    expect(observer.options).toEqual({ threshold: 0 });
    expect(observer.observed).toEqual([doc.documentElement]);

    observer.emit(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(store.get()).toBe(false);
    observer.emit(true);
    expect(store.get()).toBe(true);

    store.stop();
    expect(observer.disconnected).toBe(true);
    expect(doc.listenerCount).toBe(0);
  });

  it('unsubscribes cleanly', () => {
    const { doc, watch, store, seen } = build();
    const stop = store.subscribe(() => seen.push(store.get()));
    stop();
    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(seen).toEqual([false]);
    store.stop();
    expect(watch.unsubscribed).toBe(1);
  });
});

describe('the shared store', () => {
  function installDocument(visible = true) {
    const doc = new FakeDocument(visible);
    vi.stubGlobal('document', doc);
    resetSharedPageVisibility();
    return doc;
  }

  it('answers true when there is no document at all', () => {
    expect(typeof document).toBe('undefined');
    expect(pageVisible()).toBe(true);
    const stop = subscribePageVisible(() => {
      throw new Error('nothing can change without a document');
    });
    stop();
  });

  it('follows the page through the non-React getter and subscription', () => {
    const doc = installDocument();
    const seen: boolean[] = [];
    const stop = subscribePageVisible(() => seen.push(pageVisible()));
    expect(pageVisible()).toBe(true);

    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(pageVisible()).toBe(false);
    expect(seen).toEqual([false]);

    doc.setVisible(true);
    expect(pageVisible()).toBe(true);
    expect(seen).toEqual([false, true]);
    stop();
  });

  it('gives React the same answer through usePageVisible', () => {
    const doc = installDocument();
    function Probe() {
      return <span>{usePageVisible() ? 'showing' : 'put away'}</span>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>showing</span>');
    doc.setVisible(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>put away</span>');
  });

  it('keeps the hide debounce at 1.5 s', () => {
    expect(HIDE_DELAY_MS).toBe(1500);
  });
});
