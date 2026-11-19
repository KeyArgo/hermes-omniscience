// Counting probe for the "quiet when hidden" checks: how many fetches the page makes and how many
// live sockets it holds, measured from inside the page.
//
// Installed with addInitScript, so the traps are in place before any page script runs — including
// before dev/premium-mock.ts replaces `window.fetch` and `window.WebSocket` with its synthetic
// viewer. Both properties are installed as getter/setter pairs, so the harness assigning its own
// implementations is wrapped rather than lost.
//
// Only sockets that look like the viewer's live feed (`…/live?root=…`) are counted: the Vite dev
// client opens one HMR socket of its own, which has nothing to do with the page being looked at.

export async function installProbe(page) {
  await page.addInitScript(() => {
    const counts = { fetches: 0, opened: 0, closed: 0, open: 0, maxOpen: 0, otherSockets: 0 };
    const sockets = [];
    window.__quiet = { counts, sockets };

    // ---- fetch ----
    let rawFetch = window.fetch;
    const wrapFetch = (fn) => (...args) => {
      counts.fetches += 1;
      return fn.apply(window, args);
    };
    let countedFetch = wrapFetch(rawFetch);
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      get: () => countedFetch,
      set: (fn) => {
        rawFetch = fn;
        countedFetch = wrapFetch(fn);
      },
    });

    // ---- WebSocket ----
    let rawSocket = window.WebSocket;
    let countedSocket = null;
    const build = (ctor) => {
      const Counting = function (url, protocols) {
        const socket = protocols === undefined ? new ctor(url) : new ctor(url, protocols);
        const parsed = new URL(String(url), window.location.origin);
        if (!parsed.pathname.endsWith('/live')) {
          counts.otherSockets += 1;
          return socket;
        }
        const entry = {
          url: String(url),
          root: parsed.searchParams.get('root'),
          after: Number(parsed.searchParams.get('after') ?? '-1'),
          closed: false,
        };
        sockets.push(entry);
        counts.opened += 1;
        counts.open += 1;
        counts.maxOpen = Math.max(counts.maxOpen, counts.open);
        const close = socket.close.bind(socket);
        socket.close = (...args) => {
          if (!entry.closed) {
            entry.closed = true;
            counts.closed += 1;
            counts.open -= 1;
            entry.openAfterClose = counts.open;
          }
          return close(...args);
        };
        return socket;
      };
      Counting.prototype = ctor.prototype;
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        if (key in ctor) Counting[key] = ctor[key];
      }
      return Counting;
    };
    countedSocket = build(rawSocket);
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      get: () => countedSocket,
      set: (ctor) => {
        rawSocket = ctor;
        countedSocket = build(ctor);
      },
    });
  });
}

/** A snapshot of the counters, plus the raw socket log. */
export async function readProbe(page) {
  return page.evaluate(() => ({
    ...window.__quiet.counts,
    sockets: window.__quiet.sockets.map((entry) => ({ ...entry })),
  }));
}

/**
 * Fake the page being hidden the way the browser does it: the two document properties plus one
 * visibilitychange event. The real IntersectionObserver keeps reporting the page as on screen,
 * which is exactly the case that used to keep the socket open.
 */
export async function setFakeHidden(page, hidden) {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (next ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
