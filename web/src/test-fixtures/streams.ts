import fc from 'fast-check';
import type { OmniEvent } from '../types';

export const SESSIONS = ['s1', 's2', 's3'] as const;
export const TURNS = ['t1', 't2', 't3', 't4'] as const;
export const APIS = ['r1', 'r2', 'r3'] as const;
export const BOOT_IDS = ['boot-1', 'boot-2', 'boot-3'] as const;
export const CHILDREN = ['c1', 'c2'] as const;

export const KINDS = [
  'session.start',
  'session.end',
  'turn.start',
  'turn.end',
  'llm.request',
  'llm.response',
  'llm.error',
  'tool.end',
  'subagent.start',
  'subagent.stop',
  'omni.dropped',
] as const;

export type Kind = (typeof KINDS)[number];

let manualCounter = 0;

export function makeEvent(
  rowid: number,
  kind: string,
  overrides: Partial<OmniEvent> = {},
): OmniEvent {
  manualCounter += 1;
  return {
    rowid,
    event_id: `mx-${manualCounter}-${rowid}`,
    schema: 'omni.v1',
    boot_id: BOOT_IDS[0],
    seq: rowid,
    ts: 1762400000 + rowid,
    kind,
    session_id: SESSIONS[0],
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: {},
    ...overrides,
  };
}

/** Deterministic builder used by both the fixed streams and the fast-check arbitrary. */
export interface StreamInputs {
  kinds: readonly string[];
  jumps: readonly boolean[];
  flagsB: readonly boolean[];
  randA: readonly number[];
  randB: readonly number[];
  bootCount: number;
}

const pick = <T>(list: readonly T[], n: number): T => list[Math.abs(n) % list.length];
const at = (list: readonly number[], i: number): number => list[Math.abs(i) % list.length];
const flagAt = (list: readonly boolean[], i: number): boolean =>
  list[Math.abs(i) % list.length];

const JUNK_ATTRS: readonly (Record<string, unknown> | string | number | null)[] = [
  null,
  'not json at all',
  '42',
  'null',
  '[1,2,3]',
  '{"tool_name":"surprise"}',
  7,
];

function attrsFor(
  i: number,
  kind: string,
  inputs: StreamInputs,
  turnKey: string,
): OmniEvent['attrs'] {
  // Every 11th event gets malformed/odd attrs so the "never throws" path sees junk too.
  if (at(inputs.randA, i + 59) % 11 === 0) {
    // Deliberately not narrowed: this fixture exists to hand the reader wrong-typed attrs.
    return pick(JUNK_ATTRS, at(inputs.randB, i)) as unknown as OmniEvent['attrs'];
  }
  switch (kind) {
    case 'session.start':
      return { platform: 'cli', model: 'model-a', user_chars: at(inputs.randA, i) % 500 };
    case 'session.end':
      return { completed: flagAt(inputs.flagsB, i + 3), interrupted: false };
    case 'turn.start':
      return { platform: 'cli', model: 'model-a', is_first_turn: i === 0 };
    case 'turn.end':
      return { model: 'model-a', assistant_chars: at(inputs.randA, i + 1) % 900 };
    case 'llm.request':
      return {
        model: 'model-a',
        provider: 'anthropic',
        api_mode: 'stream',
        approx_input_tokens: at(inputs.randA, i + 2) % 4000,
        max_tokens: 4096,
        retry_count: at(inputs.randA, i + 3) % 3,
      };
    case 'llm.response':
      return {
        duration_s: (at(inputs.randA, i + 4) % 500) / 100,
        finish_reason: 'stop',
        response_model: 'model-b',
        usage: {
          input_tokens: at(inputs.randA, i + 5) % 3000,
          output_tokens: at(inputs.randA, i + 6) % 900,
        },
        tool_call_count: 0,
      };
    case 'llm.error':
      return {
        duration_s: 0.5,
        status_code: pick([429, 500, 503], at(inputs.randA, i + 7)),
        retryable: true,
        reason: 'rate_limit',
        error_type: 'RateLimitError',
      };
    case 'tool.end':
      return {
        tool_name: pick(['read_file', 'write_file', 'terminal', 'grep'], at(inputs.randA, i + 8)),
        duration_ms: at(inputs.randA, i + 9) % 900,
        result_chars: at(inputs.randB, i) % 2000,
      };
    case 'subagent.start': {
      const attrs: Record<string, unknown> = {
        child_session_id: pick(CHILDREN, at(inputs.randA, i + 10)),
        role: 'researcher',
        goal_chars: 80,
      };
      if (flagAt(inputs.flagsB, i + 11)) {
        attrs.parent_turn_id = turnKey;
      }
      return attrs;
    }
    case 'subagent.stop':
      return {
        child_session_id: pick(CHILDREN, at(inputs.randA, i + 13)),
        child_status: pick(['completed', 'ok', 'error', 'weird'], at(inputs.randA, i + 14)),
        duration_ms: at(inputs.randA, i + 15) % 5000,
        tool_count: at(inputs.randA, i + 16) % 10,
      };
    case 'omni.dropped':
      return { count: 1 + (at(inputs.randA, i + 17) % 50), since_seq: at(inputs.randB, i + 5) };
    default:
      return {};
  }
}

export function buildStream(inputs: StreamInputs): OmniEvent[] {
  const n = inputs.kinds.length;
  const events: OmniEvent[] = [];
  let seq = at(inputs.randA, 0) % 10;
  for (let i = 0; i < n; i += 1) {
    const kind = inputs.kinds[i];
    const rowid = i + 1;
    seq += flagAt(inputs.jumps, i) ? 2 + (at(inputs.randA, i + 31) % 40) : 1;
    // Turn ids are derived from the session so a turn never straddles two sessions
    // (real ids embed the session; D10 says treat them as opaque, uniqueness still holds).
    const sessionId = flagAt(inputs.flagsB, i + 21) ? null : pick(SESSIONS, at(inputs.randA, i));
    const turnKey = sessionId
      ? `${sessionId}-${TURNS[at(inputs.randA, i + 5) % TURNS.length]}`
      : `x${at(inputs.randA, i + 5) % TURNS.length}`;
    const ev: OmniEvent = {
      rowid,
      event_id: `g-${i}-${kind}`,
      schema: 'omni.v1',
      boot_id: BOOT_IDS[at(inputs.randA, i + 61) % inputs.bootCount],
      seq,
      ts: 1762400000 + rowid,
      kind,
      session_id: sessionId,
      parent_session_id: null,
      turn_id: null,
      api_request_id: null,
      tool_call_id: null,
      subagent_id: null,
      status: null,
      attrs: {},
    };
    switch (kind) {
      case 'turn.start':
      case 'turn.end':
      case 'llm.request':
      case 'llm.response':
      case 'llm.error':
      case 'tool.end':
        ev.turn_id = turnKey;
        break;
      default:
        break;
    }
    switch (kind) {
      case 'llm.request':
      case 'llm.response':
      case 'llm.error':
      case 'tool.end':
        ev.api_request_id = pick(APIS, at(inputs.randA, i + 17));
        break;
      default:
        break;
    }
    if (kind === 'tool.end') {
      ev.tool_call_id = `tc-${at(inputs.randA, i + 23) % 20}`;
    }
    if (kind === 'turn.end') ev.status = pick(['ok', 'ok', 'error'], at(inputs.randB, i + 9));
    if (kind === 'tool.end') ev.status = pick([null, 'ok', 'error'], at(inputs.randB, i + 3));
    if (kind === 'subagent.start') {
      if (flagAt(inputs.flagsB, i + 25)) {
        ev.turn_id = turnKey;
      }
      ev.subagent_id = `sa-${at(inputs.randA, i + 27) % 6}`;
    }
    if (kind === 'subagent.stop') ev.subagent_id = `sa-${at(inputs.randA, i + 28) % 6}`;
    ev.attrs = attrsFor(i, kind, inputs, turnKey);
    events.push(ev);
  }
  return events;
}

const BOOL_ARRAY = fc.array(fc.boolean(), { minLength: 200, maxLength: 200 });
const INT_ARRAY = fc.array(fc.integer({ min: 0, max: 1000 }), {
  minLength: 200,
  maxLength: 200,
});

/** Random plausible omni.v1 event streams: rowids 1..n ascending, unique event_ids. */
export const eventStreams: fc.Arbitrary<OmniEvent[]> = fc
  .tuple(
    fc.integer({ min: 1, max: 140 }),
    fc.array(fc.constantFrom(...KINDS), { minLength: 140, maxLength: 140 }),
    BOOL_ARRAY,
    BOOL_ARRAY,
    INT_ARRAY,
    INT_ARRAY,
    fc.integer({ min: 1, max: 3 }),
  )
  .map(([n, kinds, jumps, flagsB, randA, randB, bootCount]) =>
    buildStream({ kinds: kinds.slice(0, n), jumps, flagsB, randA, randB, bootCount }),
  );

/** Same shape but capped at 45 events — for prefix/O(n^2)-style properties. */
export const eventStreamsSmall: fc.Arbitrary<OmniEvent[]> = fc
  .tuple(
    fc.integer({ min: 1, max: 45 }),
    fc.array(fc.constantFrom(...KINDS), { minLength: 45, maxLength: 45 }),
    BOOL_ARRAY,
    BOOL_ARRAY,
    INT_ARRAY,
    INT_ARRAY,
    fc.integer({ min: 1, max: 3 }),
  )
  .map(([n, kinds, jumps, flagsB, randA, randB, bootCount]) =>
    buildStream({ kinds: kinds.slice(0, n), jumps, flagsB, randA, randB, bootCount }),
  );

/** Streams that are guaranteed to contain at least one omni.dropped event. */
export const streamsIncludingDropped: fc.Arbitrary<OmniEvent[]> = eventStreams.map((evs) => {
  if (evs.some((e) => e.kind === 'omni.dropped')) return evs;
  const rowid = evs.length + 1;
  return [
    ...evs,
    {
      ...makeEvent(rowid, 'omni.dropped', { seq: (evs[evs.length - 1]?.seq ?? 0) + 9 }),
      event_id: `g-drop-${rowid}`,
    },
  ];
});

/** Streams with big seq jumps but no omni.dropped markers. */
export const streamsWithoutDropped: fc.Arbitrary<OmniEvent[]> = eventStreams
  .map((evs) => evs.filter((e) => e.kind !== 'omni.dropped'))
  .map((evs) =>
    evs.map((e, i) => ({
      ...e,
      seq: (i + 1) * 3 + (i % 3 === 0 ? 500 : 0),
    })),
  );

const CYCLE: Kind[] = [
  'session.start',
  'turn.start',
  'llm.request',
  'tool.end',
  'llm.response',
  'turn.end',
  'subagent.start',
  'subagent.stop',
  'omni.dropped',
  'session.end',
];

/** Fixed 5k-event stream for perf tests. Deterministic, spread across sessions/boots. */
export function streamOf(n: number): OmniEvent[] {
  const events: OmniEvent[] = [];
  for (let i = 0; i < n; i += 1) {
    const kind = CYCLE[i % CYCLE.length];
    const ev: OmniEvent = {
      rowid: i + 1,
      event_id: `perf-${i}`,
      schema: 'omni.v1',
      boot_id: BOOT_IDS[i % 3],
      seq: i + 1,
      ts: 1762400000 + i,
      kind,
      session_id: `s${i % 8}`,
      parent_session_id: null,
      turn_id: null,
      api_request_id: null,
      tool_call_id: null,
      subagent_id: null,
      status: null,
      attrs: {},
    };
    if (kind === 'turn.start' || kind === 'turn.end') ev.turn_id = `t${i % 37}`;
    if (
      kind === 'llm.request' ||
      kind === 'llm.response' ||
      kind === 'llm.error' ||
      kind === 'tool.end'
    ) {
      ev.turn_id = `t${i % 37}`;
      ev.api_request_id = `r${i % 89}`;
    }
    if (kind === 'tool.end') {
      ev.tool_call_id = `tc${i % 17}`;
      ev.attrs = { tool_name: 'grep', duration_ms: i % 500, result_chars: i % 100 };
    }
    if (kind === 'subagent.start') {
      ev.turn_id = `t${i % 37}`;
      ev.attrs = { child_session_id: `pc${i % 11}`, parent_turn_id: `t${i % 37}`, role: 'qa' };
    }
    if (kind === 'subagent.stop') {
      ev.attrs = { child_session_id: `pc${i % 11}`, child_status: 'completed' };
    }
    if (kind === 'omni.dropped') ev.attrs = { count: i % 9, since_seq: i };
    if (kind === 'session.end') ev.attrs = { completed: true, interrupted: false };
    events.push(ev);
  }
  return events;
}
