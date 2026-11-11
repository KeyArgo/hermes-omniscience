import type { OmniEvent } from '../types';

export type BarKind = 'llm' | 'tool' | 'helper';

export interface TimeBar {
  id: string;
  kind: BarKind;
  lane: string;
  start: number;
  end: number;
  label: string;
  status: 'ok' | 'error' | 'running';
  model?: string;
  requestedModel?: string;
  fallback: boolean;
  ttfb?: number;
  errors: { reason: string; statusCode?: number; at: number }[];
  eventIds: string[];
}

export interface Timeline {
  start: number;
  end: number;
  bars: TimeBar[];
  lanes: string[];
  findings: string[];
}

const LANE_MODEL = 'model calls';
const LANE_TOOLS = 'tools';
const LANE_HELPERS = 'helpers';
/** No event for this long means the chat is not live. */
const STALE_AFTER_S = 300;

function parseAttrs(attrs: OmniEvent['attrs']): Record<string, unknown> {
  if (attrs == null) return {};
  if (typeof attrs === 'string') {
    try {
      const parsed = JSON.parse(attrs);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof attrs === 'object') return attrs as Record<string, unknown>;
  return {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmtDur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m ${String(r).padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
}

export function buildTimeline(events: OmniEvent[], nowTs?: number): Timeline {
  const list = Array.isArray(events) ? events : [];

  let lastTs = 0;
  for (const e of list) {
    if (typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > lastTs) lastTs = e.ts;
  }
  const clock = typeof nowTs === 'number' && Number.isFinite(nowTs) ? nowTs : lastTs;
  // An unfinished step only runs on to "now" while the chat is live; an old interrupted chat
  // would otherwise stretch one bar across days and squash everything else.
  const now = clock - lastTs > STALE_AFTER_S ? lastTs : clock;

  // ---- LLM bars (one per api_request_id) ----
  interface LlmAgg {
    reqTs?: number;
    reqModel?: string;
    provider?: string;
    respTs?: number;
    respModel?: string;
    startedAt?: number;
    endedAt?: number;
    durationS?: number;
    ttfb?: number;
    errors: { reason: string; statusCode?: number; at: number }[];
    eventIds: string[];
  }
  const llmMap = new Map<string, LlmAgg>();
  const llmOrder: string[] = [];

  // ---- Tool bars ----
  const toolBars: TimeBar[] = [];

  // ---- Helper bars ----
  interface HelperAgg {
    start?: number;
    end?: number;
    eventIds: string[];
  }
  const helperMap = new Map<string, HelperAgg>();
  const helperOrder: string[] = [];

  for (const e of list) {
    const a = parseAttrs(e.attrs);
    const kind = e.kind;

    if (kind === 'llm.request' || kind === 'llm.response' || kind === 'llm.error') {
      const id = e.api_request_id;
      if (!id) continue;
      let agg = llmMap.get(id);
      if (!agg) {
        agg = { errors: [], eventIds: [] };
        llmMap.set(id, agg);
        llmOrder.push(id);
      }
      agg.eventIds.push(e.event_id);
      if (kind === 'llm.request') {
        agg.reqTs = e.ts;
        agg.reqModel = str(a.model) ?? agg.reqModel;
        agg.provider = str(a.provider) ?? agg.provider;
      } else if (kind === 'llm.response') {
        agg.respTs = e.ts;
        agg.respModel = str(a.response_model) ?? agg.respModel;
        agg.startedAt = num(a.started_at) ?? agg.startedAt;
        agg.endedAt = num(a.ended_at) ?? agg.endedAt;
        agg.durationS = num(a.duration_s) ?? agg.durationS;
        agg.ttfb = num(a.ttfb_s) ?? agg.ttfb;
      } else if (kind === 'llm.error') {
        const reason = str(a.reason) ?? str(a.error_type) ?? 'error';
        const statusCode = num(a.status_code);
        agg.errors.push({ reason, statusCode, at: e.ts });
      }
    } else if (kind === 'tool.end') {
      const durationMs = num(a.duration_ms);
      const startedAt = num(a.started_at);
      const end = e.ts;
      const start = startedAt ?? (durationMs != null ? e.ts - durationMs / 1000 : e.ts);
      const status: TimeBar['status'] = e.status === 'ok' ? 'ok' : 'error';
      const label = str(a.tool_name) ?? 'tool';
      toolBars.push({
        id: `tool:${e.event_id}`,
        kind: 'tool',
        lane: LANE_TOOLS,
        start,
        end,
        label,
        status,
        fallback: false,
        errors: [],
        eventIds: [e.event_id],
      });
    } else if (kind === 'subagent.start' || kind === 'subagent.stop') {
      const sid = e.subagent_id ?? e.session_id;
      if (!sid) continue;
      let agg = helperMap.get(sid);
      if (!agg) {
        agg = { eventIds: [] };
        helperMap.set(sid, agg);
        helperOrder.push(sid);
      }
      agg.eventIds.push(e.event_id);
      if (kind === 'subagent.start') agg.start = e.ts;
      else agg.end = e.ts;
    }
  }

  const llmBars: TimeBar[] = [];
  for (const id of llmOrder) {
    const agg = llmMap.get(id)!;
    const hasResponse = agg.respTs != null;
    const hasError = agg.errors.length > 0;

    // When only the response was recorded, the call still started a duration earlier - the bar
    // must not begin at the response and run forward into the future.
    const start =
      agg.startedAt ??
      agg.reqTs ??
      (agg.durationS != null && agg.respTs != null ? agg.respTs - agg.durationS : (agg.respTs ?? now));
    let end: number;
    let status: TimeBar['status'];

    if (hasResponse) {
      end = agg.endedAt ?? (agg.durationS != null ? start + agg.durationS : (agg.respTs ?? now));
      status = 'ok';
    } else if (hasError) {
      end = agg.errors.reduce((m, x) => Math.max(m, x.at), start);
      status = 'error';
    } else {
      end = now;
      status = 'running';
    }

    const model = agg.respModel ?? agg.reqModel;
    const requestedModel = agg.reqModel;
    const fallback = !!(agg.respModel && agg.reqModel && agg.respModel !== agg.reqModel);

    llmBars.push({
      id: `llm:${id}`,
      kind: 'llm',
      lane: LANE_MODEL,
      start,
      end,
      label: model ?? 'model call',
      status,
      model,
      requestedModel,
      fallback,
      ttfb: agg.ttfb,
      errors: agg.errors,
      eventIds: agg.eventIds,
    });
  }

  const helperBars: TimeBar[] = [];
  for (const sid of helperOrder) {
    const agg = helperMap.get(sid)!;
    const start = agg.start ?? agg.end ?? now;
    const end = agg.end ?? now;
    const status: TimeBar['status'] = agg.end != null ? 'ok' : 'running';
    helperBars.push({
      id: `helper:${sid}`,
      kind: 'helper',
      lane: LANE_HELPERS,
      start,
      end,
      label: 'helper',
      status,
      fallback: false,
      errors: [],
      eventIds: agg.eventIds,
    });
  }

  const bars = [...llmBars, ...toolBars, ...helperBars].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const hasModel = llmBars.length > 0;
  const hasTools = toolBars.length > 0;
  const hasHelpers = helperBars.length > 0;
  const lanes: string[] = [];
  if (hasModel) lanes.push(LANE_MODEL);
  if (hasTools) lanes.push(LANE_TOOLS);
  if (hasHelpers) lanes.push(LANE_HELPERS);

  let start = Infinity;
  let end = -Infinity;
  for (const b of bars) {
    if (b.start < start) start = b.start;
    if (b.end > end) end = b.end;
  }
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = start;
  if (end <= start) end = start + 1;

  // ---- findings ----
  const findings: string[] = [];

  // rate limits
  const rateLimitBars = llmBars.filter((b) =>
    b.errors.some((er) => er.statusCode === 429 || er.reason === 'rate_limit')
  );
  if (rateLimitBars.length > 0) {
    const providers = [...new Set(rateLimitBars.map((b) => llmMap.get(b.id.slice('llm:'.length))?.provider).filter(
      (p): p is string => !!p,
    ))].sort();
    findings.push(
      `${rateLimitBars.length} model call${rateLimitBars.length === 1 ? ' was' : 's were'} rate-limited (429)` +
        (providers.length > 0 ? ` by ${providers.join(', ')}.` : '.'),
    );
  }

  // fallbacks
  const fallbackPairs = new Map<string, number>();
  for (const b of llmBars) {
    if (!b.fallback) continue;
    const pair = `${b.requestedModel} to ${b.model}`;
    fallbackPairs.set(pair, (fallbackPairs.get(pair) ?? 0) + 1);
  }
  for (const [pair, count] of [...fallbackPairs].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 2)) {
    findings.push(`Hermes switched from ${pair} ${count} time${count === 1 ? '' : 's'} (fallback).`);
  }

  // slowest first reply
  const ttfbVals = llmBars
    .map((b) => b.ttfb)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (ttfbVals.length >= 3) {
    let maxTtfb = -Infinity;
    let maxModel = '';
    for (const b of llmBars) {
      if (typeof b.ttfb === 'number' && b.ttfb > maxTtfb) {
        maxTtfb = b.ttfb;
        maxModel = b.model ?? 'model';
      }
    }
    const med = median(ttfbVals);
    findings.push(
      `Longest wait for the first word: ${fmtDur(maxTtfb)} (${maxModel}); typical is ${fmtNum(Math.round(med * 10) / 10)}s.`
    );
  }

  // slowest model call
  if (llmBars.length > 0) {
    let maxDur = -Infinity;
    for (const b of llmBars) {
      const d = b.end - b.start;
      if (d > maxDur) maxDur = d;
    }
    findings.push(`The longest model call took ${fmtDur(maxDur)}.`);
  }

  return {
    start,
    end,
    bars,
    lanes,
    findings: findings.slice(0, 5),
  };
}
