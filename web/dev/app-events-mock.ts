/**
 * A synthetic viewer for dev/app-events-harness.mjs.
 *
 * The harness mounts the real App (see app-events-harness.tsx) and this module stands in for the
 * two things an App-level check needs: the HTTP endpoints it fetches and the live socket it opens.
 * Nothing here touches a real viewer, a database or the network: every row is fixture metadata
 * built in the page, and every reply is handed out by the plan the check script sets.
 *
 * The plan is deliberately data, not functions, so the Playwright script can rewrite it mid-visit:
 *
 *   window.__harness.plan.earlier.A = [{ status: 500 }, { rows: window.__harness.page([...], 1999) }]
 *
 * `hold: true` leaves that reply pending until `releaseOne()`, which is how a request is kept in
 * flight while the check switches chats and comes back.
 */

/** One page of events, as the viewer sends it: real rows interleaved with unreadable ones. */
export function page(valid: Array<Record<string, unknown>>, invalid: number): unknown[] {
  const rows: unknown[] = [...valid];
  for (let index = 0; index < invalid; index += 1) {
    rows.push(index % 2 === 0 ? null : { event_id: '' });
  }
  return rows;
}

/** A recorded event row, the same shape GET /api/v1/events returns. */
export function eventRow(rowid: number, overrides: Record<string, unknown> = {}) {
  return {
    rowid,
    event_id: `evt-${rowid}`,
    schema: 'omni.v1',
    boot_id: 'harness',
    seq: rowid,
    ts: 1762400000 + rowid,
    kind: 'llm.request',
    session_id: 'A',
    status: 'ok',
    attrs: {},
    ...overrides,
  };
}

export interface EarlierReply {
  status?: number;
  rows?: unknown[];
  /** Answer only when the check calls releaseOne(). */
  hold?: boolean;
}

export type FirstPagePlan = { status: number } | { rows: unknown[] };

export interface SessionPlan {
  id: string;
  label: string;
  events: number;
  last_ts: number;
}

export interface HarnessPlan {
  sessions: SessionPlan[];
  /** Reply for the first page (GET /events without `before`), per root. */
  first: Record<string, FirstPagePlan>;
  /** Queued replies for GET /events?before=..., one shifted per request, per root. */
  earlier: Record<string, EarlierReply[]>;
}

export interface Harness {
  plan: HarnessPlan;
  /** Every URL the App asked for, in order. */
  calls: string[];
  pushLive(payload: unknown): number;
  releaseOne(): number;
  heldCount(): number;
  eventRow: typeof eventRow;
  page: typeof page;
}

declare global {
  interface Window {
    __harness: Harness;
  }
}

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

function replyBody(reply: EarlierReply | FirstPagePlan): Response {
  if ('status' in reply && typeof reply.status === 'number' && !('rows' in reply)) {
    return respond(reply.status, { detail: 'harness' });
  }
  return respond(200, (reply as EarlierReply).rows ?? []);
}

/** A socket the App can open; the check pushes `events` frames into it. */
class SyntheticSocket {
  static all: SyntheticSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    SyntheticSocket.all.push(this);
    // The App connects after its first page settles; opening on the next task keeps the order.
    window.setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  close(): void {
    this.readyState = 3;
  }

  deliver(payload: unknown): boolean {
    if (this.readyState !== 1) return false;
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    return true;
  }
}

export function installSyntheticViewer(): Harness {
  const held: Array<() => void> = [];
  // A first page that fails on purpose, chosen from the URL so it is set before the App mounts.
  const failFirst = new URLSearchParams(window.location.search).get('harnessFailFirst');

  const plan: HarnessPlan = {
    sessions: [
      { id: 'A', label: 'Chat A', events: 5, last_ts: 2000 },
      { id: 'B', label: 'Chat B', events: 5, last_ts: 1000 },
    ],
    first: {
      A: { rows: [eventRow(901), eventRow(902)] },
      B: { rows: [eventRow(501, { session_id: 'B' }), eventRow(502, { session_id: 'B' })] },
    },
    earlier: {},
  };
  if (failFirst) plan.first[failFirst] = { status: 503 };

  const calls: string[] = [];

  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const parsed = new URL(url, window.location.origin);
    const path = parsed.pathname;
    if (path.endsWith('/sessions')) {
      return respond(200, { sessions: plan.sessions });
    }
    if (path.endsWith('/events')) {
      const root = parsed.searchParams.get('root') ?? '';
      if (parsed.searchParams.get('before') === null) {
        return replyBody(plan.first[root] ?? { rows: [] });
      }
      const queue = plan.earlier[root] ?? [];
      const next = queue.shift();
      if (!next) return respond(200, []);
      if (next.hold) {
        return new Promise<Response>((resolve) => {
          held.push(() => resolve(replyBody(next)));
        });
      }
      return replyBody(next);
    }
    if (path.endsWith('/ping')) return respond(200, { build: 'harness' });
    if (path.endsWith('/version')) {
      return respond(200, {
        version: '0.0.0-harness',
        release: '0.0.0',
        channel: 'dev',
        commit: 'harness',
        commit_short: 'harness',
        commit_date: '2026-11-13T00:00:00Z',
        built_at: '2026-11-13T00:00:00Z',
        dirty: false,
        build: 'harness',
      });
    }
    if (path.endsWith('/warnings')) return respond(200, { warnings: [] });
    return respond(200, {});
  };

  const harness: Harness = {
    plan,
    calls,
    pushLive(payload: unknown): number {
      return SyntheticSocket.all.reduce(
        (sent, socket) => (socket.deliver(payload) ? sent + 1 : sent),
        0,
      );
    },
    releaseOne(): number {
      const resolve = held.shift();
      resolve?.();
      return held.length;
    },
    heldCount(): number {
      return held.length;
    },
    eventRow,
    page,
  };

  window.__harness = harness;
  window.fetch = fakeFetch as unknown as typeof fetch;
  window.WebSocket = SyntheticSocket as unknown as typeof WebSocket;
  return harness;
}
