/**
 * A synthetic, fully populated viewer for the interface checks.
 *
 * `dev/app-events-mock.ts` exists to prove the event-window state machine: two chats, a couple of
 * rows each. The visual slice needs the opposite — enough plausible recording for every panel to
 * have something real to draw: several turns, tools, a rate-limit retry, a subagent, and a
 * context series that spikes and compacts. This module supplies exactly that.
 *
 * Everything is generated in the page. There is no database, no network and no real recording.
 * The values are obviously synthetic (fixed models, round token counts) so a screenshot can never
 * be mistaken for somebody's real session.
 */
import type { OmniEvent, SessionMeta } from '../src/types';

const NOW = Math.floor(Date.now() / 1000);
const ROOT = 'root-1';
const CHILD = 'child-1';

function event(
  rowid: number,
  kind: string,
  partial: Partial<OmniEvent> = {},
): OmniEvent {
  return {
    rowid,
    event_id: `synthetic-${rowid}`,
    schema: 'omni.v1',
    boot_id: 'synthetic-boot',
    seq: rowid,
    ts: NOW - 900 + rowid * 3,
    kind,
    session_id: ROOT,
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: {},
    ...partial,
  };
}

/** Context per call: grows, spikes, then a compaction cuts it back. */
const PROMPT_SERIES = [1400, 2100, 3400, 5200, 8100, 12400, 17800, 5200, 7000, 9600, 13100];
const MODELS = ['claude-sonnet-4', 'claude-sonnet-4', 'claude-sonnet-4', 'claude-sonnet-4', 'gpt-5'];

function buildRootEvents(): OmniEvent[] {
  const events: OmniEvent[] = [];
  let rowid = 1;
  events.push(
    event(rowid++, 'session.start', { attrs: { platform: 'cli', model: MODELS[0] } }),
  );
  const turns = PROMPT_SERIES.length;
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn + 1}`;
    const requestId = `req-${turn + 1}`;
    const model = MODELS[Math.min(turn, MODELS.length - 1)];
    const prompt = PROMPT_SERIES[turn];
    events.push(
      event(rowid++, 'turn.start', {
        turn_id: turnId,
        attrs: {
          platform: 'cli',
          model,
          is_first_turn: turn === 0,
          user_chars: 120 + turn * 18,
        },
      }),
      event(rowid++, 'llm.request', {
        turn_id: turnId,
        api_request_id: requestId,
        attrs: {
          model,
          provider: 'synthetic',
          api_mode: 'stream',
          message_count: 2 + turn * 2,
          tool_count: 4,
          approx_input_tokens: prompt,
          max_tokens: 8192,
          retry_count: 0,
        },
      }),
    );

    // One rate limit, then the retry that succeeded. Recovered, not fatal.
    if (turn === 4) {
      events.push(
        event(rowid++, 'llm.error', {
          turn_id: turnId,
          api_request_id: requestId,
          attrs: {
            duration_s: 0.6,
            status_code: 429,
            retryable: true,
            reason: 'rate_limit',
            error_type: 'RateLimitError',
          },
        }),
      );
    }

    // Tools for this turn. One terminal call fails on turn 3; the rest succeed.
    const tools = ['read_file', 'terminal', 'grep'];
    for (let tool = 0; tool < (turn % 3 === 0 ? 3 : 2); tool += 1) {
      const name = tools[(turn + tool) % tools.length];
      const failed = turn === 3 && tool === 1;
      events.push(
        event(rowid++, 'tool.end', {
          turn_id: turnId,
          api_request_id: requestId,
          tool_call_id: `call-${turn}-${tool}`,
          status: failed ? 'error' : 'ok',
          attrs: {
            tool_name: name,
            duration_ms: failed ? 3500 : 40 + ((turn * 37 + tool * 53) % 900),
            result_chars: failed ? 0 : 400 + turn * 120,
            ...(failed ? { error_type: 'timeout' } : {}),
          },
        }),
      );
    }

    events.push(
      event(rowid++, 'llm.response', {
        turn_id: turnId,
        api_request_id: requestId,
        status: 'ok',
        attrs: {
          duration_s: 0.9 + turn * 0.35,
          finish_reason: 'stop',
          response_model: model,
          usage: {
            input_tokens: prompt,
            output_tokens: 180 + turn * 30,
            cache_read_tokens: Math.round(prompt * 0.45),
          },
          tool_call_count: 2,
        },
      }),
      event(rowid++, 'turn.end', {
        turn_id: turnId,
        status: 'ok',
        attrs: { model, assistant_chars: 300 + turn * 40 },
      }),
    );
  }

  // A helper agent with its own short run.
  events.push(
    event(rowid++, 'subagent.start', {
      turn_id: 'turn-5',
      subagent_id: 'sa-1',
      attrs: {
        child_session_id: CHILD,
        child_subagent_id: 'sa-1',
        parent_turn_id: 'turn-5',
        role: 'researcher',
        goal_chars: 160,
      },
    }),
    event(rowid++, 'session.start', {
      session_id: CHILD,
      parent_session_id: ROOT,
      attrs: { platform: 'cli', model: 'claude-haiku' },
    }),
    event(rowid++, 'turn.start', {
      session_id: CHILD,
      parent_session_id: ROOT,
      turn_id: 'child-turn',
      attrs: { platform: 'cli', model: 'claude-haiku', is_first_turn: true },
    }),
    event(rowid++, 'llm.request', {
      session_id: CHILD,
      parent_session_id: ROOT,
      turn_id: 'child-turn',
      api_request_id: 'child-req',
      attrs: { model: 'claude-haiku', provider: 'synthetic', approx_input_tokens: 900 },
    }),
    event(rowid++, 'tool.end', {
      session_id: CHILD,
      parent_session_id: ROOT,
      turn_id: 'child-turn',
      api_request_id: 'child-req',
      tool_call_id: 'child-call',
      attrs: { tool_name: 'grep', duration_ms: 18, result_chars: 220 },
    }),
    event(rowid++, 'llm.response', {
      session_id: CHILD,
      parent_session_id: ROOT,
      turn_id: 'child-turn',
      api_request_id: 'child-req',
      attrs: {
        duration_s: 0.7,
        finish_reason: 'stop',
        usage: { input_tokens: 900, output_tokens: 90 },
      },
    }),
    event(rowid++, 'turn.end', {
      session_id: CHILD,
      parent_session_id: ROOT,
      turn_id: 'child-turn',
      status: 'ok',
      attrs: { model: 'claude-haiku' },
    }),
    event(rowid++, 'session.end', {
      session_id: CHILD,
      parent_session_id: ROOT,
      status: 'completed',
      attrs: { completed: true, interrupted: false },
    }),
    event(rowid++, 'subagent.stop', {
      subagent_id: 'sa-1',
      attrs: {
        child_session_id: CHILD,
        child_status: 'completed',
        duration_ms: 4200,
        tool_count: 1,
      },
    }),
    event(rowid++, 'session.end', {
      status: 'completed',
      attrs: { completed: true, interrupted: false },
    }),
  );
  return events;
}

/** A shorter second chat, so the list has a real alternative to select. */
function buildSecondEvents(): OmniEvent[] {
  const events: OmniEvent[] = [];
  let rowid = 1;
  const session = 'root-2';
  events.push(
    event(rowid++, 'session.start', {
      session_id: session,
      attrs: { platform: 'cli', model: 'claude-sonnet-4' },
    }),
  );
  for (let turn = 0; turn < 4; turn += 1) {
    events.push(
      event(rowid++, 'turn.start', {
        session_id: session,
        turn_id: `b-turn-${turn}`,
        attrs: { platform: 'cli', model: 'claude-sonnet-4', is_first_turn: turn === 0 },
      }),
      event(rowid++, 'llm.request', {
        session_id: session,
        turn_id: `b-turn-${turn}`,
        api_request_id: `b-req-${turn}`,
        attrs: {
          model: 'claude-sonnet-4',
          provider: 'synthetic',
          approx_input_tokens: 1200 + turn * 1600,
        },
      }),
    );
    events.push(
      event(rowid++, 'tool.end', {
        session_id: session,
        turn_id: `b-turn-${turn}`,
        api_request_id: `b-req-${turn}`,
        tool_call_id: `b-call-${turn}`,
        status: turn === 2 ? 'error' : 'ok',
        attrs: {
          tool_name: turn === 2 ? 'terminal' : 'read_file',
          duration_ms: turn === 2 ? 2800 : 90,
          result_chars: turn === 2 ? 0 : 640,
        },
      }),
      event(rowid++, 'llm.response', {
        session_id: session,
        turn_id: `b-turn-${turn}`,
        api_request_id: `b-req-${turn}`,
        attrs: {
          duration_s: 1.2 + turn * 0.2,
          finish_reason: 'stop',
          usage: { input_tokens: 1200 + turn * 1600, output_tokens: 160 },
        },
      }),
      event(rowid++, 'turn.end', {
        session_id: session,
        turn_id: `b-turn-${turn}`,
        status: 'ok',
        attrs: { model: 'claude-sonnet-4' },
      }),
    );
  }
  events.push(
    event(rowid++, 'session.end', {
      session_id: session,
      status: 'completed',
      attrs: { completed: true },
    }),
  );
  return events;
}

function buildThirdEvents(): OmniEvent[] {
  const session = 'root-3';
  return Array.from({ length: 6 }, (_, index) =>
    event(index + 1, index === 0 ? 'session.start' : index % 2 === 0 ? 'llm.request' : 'turn.start', {
      session_id: session,
      turn_id: index === 0 ? null : `c-turn-${index}`,
      api_request_id: index % 2 === 0 ? `c-req-${index}` : null,
      attrs:
        index % 2 === 0
          ? { model: 'claude-haiku', provider: 'synthetic', approx_input_tokens: 700 + index * 300 }
          : { platform: 'cli', model: 'claude-haiku' },
    }),
  );
}

export const SHOWCASE_EVENTS: Record<string, OmniEvent[]> = {
  [ROOT]: buildRootEvents(),
  'root-2': buildSecondEvents(),
  'root-3': buildThirdEvents(),
};

export const SHOWCASE_SESSIONS: SessionMeta[] = [
  {
    id: ROOT,
    label: 'Research assistant',
    source: 'cli',
    first_ts: NOW - 900,
    last_ts: NOW - 4,
    events: SHOWCASE_EVENTS[ROOT].length,
    model: 'claude-sonnet-4',
    status: 'completed',
    calls: 11,
    prompt_max: 17800,
    prompt_now: 13100,
    tools: 18,
    subagents: 1,
  },
  {
    id: 'root-2',
    label: 'Code review',
    source: 'cli',
    first_ts: NOW - 2400,
    last_ts: NOW - 180,
    events: SHOWCASE_EVENTS['root-2'].length,
    model: 'claude-sonnet-4',
    status: 'completed',
    calls: 4,
    prompt_max: 6000,
    prompt_now: 6000,
    tools: 4,
  },
  {
    id: 'root-3',
    label: 'Planning session',
    source: 'cli',
    first_ts: NOW - 7200,
    last_ts: NOW - 3600,
    events: SHOWCASE_EVENTS['root-3'].length,
    model: 'claude-haiku',
    status: 'completed',
    calls: 3,
    prompt_max: 1600,
    prompt_now: 1600,
    tools: 0,
  },
];

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

/** The live socket: opens, accepts frames, and never sends anything on its own. */
class SyntheticSocket {
  static all: SyntheticSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    SyntheticSocket.all.push(this);
    window.setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  close(): void {
    this.readyState = 3;
  }

  send(): void {
    /* the App does not send */
  }

  deliver(payload: unknown): boolean {
    if (this.readyState !== 1) return false;
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    return true;
  }
}

export interface ShowcaseHarness {
  calls: string[];
  events: Record<string, OmniEvent[]>;
  sessions: SessionMeta[];
}

declare global {
  interface Window {
    __showcase: ShowcaseHarness;
    __showcaseAppend: () => number;
  }
}

/** Two rows for a live-append camera test: one new turn and its model request. */
const LIVE_APPEND: OmniEvent[] = [
  event(9001, 'turn.start', {
    turn_id: 'turn-live',
    attrs: { platform: 'cli', model: MODELS[0] },
  }),
  event(9002, 'llm.request', {
    turn_id: 'turn-live',
    api_request_id: 'req-live',
    attrs: { model: MODELS[0], provider: 'synthetic', approx_input_tokens: 1200 },
  }),
];

/** Only loaded by `?busy=N`: N turns with eight tools each, so Fold can be exercised. */
function busyTurn(index: number): OmniEvent[] {
  const turn = `turn-busy-${index}`;
  const request = `req-busy-${index}`;
  const base = 9100 + index * 100;
  const rows: OmniEvent[] = [
    event(base, 'turn.start', {
      turn_id: turn,
      attrs: { platform: 'cli', model: MODELS[0] },
    }),
    event(base + 1, 'llm.request', {
      turn_id: turn,
      api_request_id: request,
      attrs: { model: MODELS[0], provider: 'synthetic', approx_input_tokens: 1800 },
    }),
  ];
  for (let tool = 0; tool < 8; tool += 1) {
    rows.push(
      event(base + 2 + tool, 'tool.end', {
        turn_id: turn,
        api_request_id: request,
        tool_call_id: `busy-${index}-${tool}`,
        status: tool === 0 ? 'error' : 'ok',
        attrs: {
          tool_name: tool === 0 ? 'busy-fail' : tool === 1 ? 'busy-slow' : 'grep',
          duration_ms: tool === 1 ? 5000 : 20 + tool,
        },
      }),
    );
  }
  return rows;
}

export function installShowcaseViewer(): ShowcaseHarness {
  const calls: string[] = [];
  const harness: ShowcaseHarness = {
    calls,
    events: SHOWCASE_EVENTS,
    sessions: SHOWCASE_SESSIONS,
  };
  const busyCount = Number(new URLSearchParams(window.location.search).get('busy') ?? '0');
  if (Number.isFinite(busyCount) && busyCount > 0) {
    const busy = Array.from({ length: busyCount }, (_, index) => busyTurn(index + 1)).flat();
    harness.events = {
      ...SHOWCASE_EVENTS,
      [ROOT]: [...SHOWCASE_EVENTS[ROOT], ...busy],
    };
  }

  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const parsed = new URL(url, window.location.origin);
    const path = parsed.pathname;
    if (path.endsWith('/sessions')) return respond(200, { sessions: SHOWCASE_SESSIONS });
    if (path.endsWith('/events')) {
      const root = parsed.searchParams.get('root') ?? '';
      const rows = harness.events[root] ?? [];
      const before = parsed.searchParams.get('before');
      // A switching chat can answer slowly; the camera regression appears when the old graph goes
      // empty before the new rows arrive. Only the test harness sets this.
      if (new URLSearchParams(window.location.search).get('slow') === '1' && root !== ROOT) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      }
      // Every row is loaded in one page here: the checks are about the interface, not pagination.
      return respond(200, { events: before === null ? rows : [] });
    }
    if (path.endsWith('/warnings')) return respond(200, { warnings: [] });
    if (path.endsWith('/failures')) {
      const root = parsed.searchParams.get('root') ?? '';
      return respond(200, { failures: [], root });
    }
    if (path.endsWith('/diagnose')) return respond(200, { status: 'no_failure' });
    if (path.endsWith('/insight')) return respond(200, { state: 'none' });
    if (path.endsWith('/ping')) return respond(200, { build: 'synthetic' });
    if (path.endsWith('/version')) {
      return respond(200, {
        version: '0.0.0-preview',
        release: '0.0.0',
        channel: 'dev',
        commit: 'synthetic',
        commit_short: 'synth',
        commit_date: '2026-11-14T00:00:00Z',
        built_at: '2026-11-14T00:00:00Z',
        dirty: false,
        build: 'synthetic',
      });
    }
    if (path.endsWith('/prefs')) return respond(200, { digest: { enabled: true, detail: 'standard' } });
    return respond(200, {});
  };

  window.__showcase = harness;
  window.__showcaseAppend = () =>
    SyntheticSocket.all.reduce(
      (sent, socket) => (socket.deliver({ type: 'events', events: LIVE_APPEND }) ? sent + 1 : sent),
      0,
    );
  window.fetch = fakeFetch as unknown as typeof fetch;
  window.WebSocket = SyntheticSocket as unknown as typeof WebSocket;
  return harness;
}
