import type { ChatPrefs, OmniEvent, SessionMeta, UsageReport, Warning } from './types';
import { tokenHeaders, withToken, wsSubprotocol } from './token';

export const API_BASE = '/api/v1';
export const EVENT_PAGE_SIZE = 2000;

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, { headers: { accept: 'application/json', ...tokenHeaders() } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<unknown>;
}

function arrayFrom(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record[key])) return record[key] as unknown[];
    if (Array.isArray(record.events)) return record.events as unknown[];
    if (Array.isArray(record.data)) return record.data as unknown[];
  }
  return [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function normalizeSession(raw: unknown): SessionMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id =
    text(record.id) ??
    text(record.session_id) ??
    text(record.root_session_id) ??
    text(record.root);
  if (!id) return null;
  return {
    id,
    label: text(record.label),
    source: text(record.source),
    archived: typeof record.archived === 'boolean' ? record.archived : null,
    first_ts: numberOrNull(record.first_ts),
    last_ts: numberOrNull(record.last_ts),
    events: numberOrNull(record.events ?? record.event_count ?? record.count),
    model: text(record.model),
    status: text(record.status),
    calls: numberOrNull(record.calls),
    cached: numberOrNull(record.cached),
    fresh: numberOrNull(record.fresh),
    output: numberOrNull(record.output),
    prompt_max: numberOrNull(record.prompt_max),
    // The newest prompt is what the next message pays for; dropping it here made every row fall
    // back to the lifetime peak, which is why a compacted chat kept showing its old high-water mark.
    prompt_now: numberOrNull(record.prompt_now),
    tools: numberOrNull(record.tools),
    mcp_calls: numberOrNull(record.mcp_calls),
    skills: numberOrNull(record.skills),
    aux_calls: numberOrNull(record.aux_calls),
    subagents: numberOrNull(record.subagents),
    compactions: numberOrNull(record.compactions),
  };
}

export function normalizeEvent(raw: unknown): OmniEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const rowid = numberOrNull(record.rowid);
  const eventId = text(record.event_id);
  if (rowid === null || !eventId) return null;
  return {
    rowid,
    event_id: eventId,
    schema: text(record.schema) ?? 'omni.v1',
    boot_id: text(record.boot_id) ?? '',
    seq: numberOrNull(record.seq) ?? rowid,
    ts: numberOrNull(record.ts) ?? 0,
    kind: text(record.kind) ?? 'unknown',
    session_id: text(record.session_id),
    parent_session_id: text(record.parent_session_id),
    turn_id: text(record.turn_id),
    api_request_id: text(record.api_request_id),
    tool_call_id: text(record.tool_call_id),
    subagent_id: text(record.subagent_id),
    status: text(record.status),
    attrs:
      record.attrs && typeof record.attrs === 'object'
        ? (record.attrs as Record<string, unknown>)
        : typeof record.attrs === 'string'
          ? record.attrs
          : null,
  };
}

export async function fetchSessions(): Promise<SessionMeta[]> {
  const payload = await getJson(`${API_BASE}/sessions?limit=200`);
  return arrayFrom(payload, 'sessions')
    .map(normalizeSession)
    .filter((session): session is SessionMeta => session !== null);
}

/**
 * The Usage page. One request per period change — this is a destination you navigate to, not
 * a panel that polls, and the server aggregates the whole window on each call.
 */
export async function fetchUsage(days: number): Promise<UsageReport> {
  const payload = await getJson(`${API_BASE}/usage?days=${encodeURIComponent(String(days))}`);
  const record = (payload ?? {}) as Record<string, unknown>;
  return {
    days: typeof record.days === 'number' ? record.days : days,
    generated_at: typeof record.generated_at === 'number' ? record.generated_at : Date.now() / 1000,
    since: typeof record.since === 'number' ? record.since : 0,
    totals: (record.totals ?? {}) as UsageReport['totals'],
    daily: Array.isArray(record.daily) ? (record.daily as UsageReport['daily']) : [],
    daily_models: Array.isArray(record.daily_models)
      ? (record.daily_models as UsageReport['daily_models'])
      : [],
    models: Array.isArray(record.models) ? (record.models as UsageReport['models']) : [],
    harnesses: Array.isArray(record.harnesses)
      ? (record.harnesses as UsageReport['harnesses'])
      : [],
    hourly: Array.isArray(record.hourly) ? (record.hourly as number[]) : Array(24).fill(0),
    weekday_hour: Array.isArray(record.weekday_hour)
      ? (record.weekday_hour as number[][])
      : Array.from({ length: 7 }, () => Array(24).fill(0)),
    time_metrics: (record.time_metrics ?? {
      sessions: 0, active_s: 0, longest_s: 0, peak_concurrent: 0,
    }) as UsageReport['time_metrics'],
    sources: Array.isArray(record.sources)
      ? (record.sources as UsageReport['sources'])
      : [],
    cache: (record.cache ?? {
      read: 0, fresh: 0, hit_rate: null, saved_usd: null, priced_share: null,
    }) as UsageReport['cache'],
    context: (record.context ?? {
      histogram: [], compactions: [], context_tokens: 0, calls_with_context: 0,
    }) as UsageReport['context'],
    chats: Array.isArray(record.chats) ? (record.chats as UsageReport['chats']) : [],
    cost_available: record.cost_available === true,
  };
}

export async function fetchEvents(root: string, after = 0, before?: number): Promise<OmniEvent[]> {
  const payload = await getJson(
    `${API_BASE}/events?root=${encodeURIComponent(root)}&after=${after}&limit=${EVENT_PAGE_SIZE}&tail=true${before === undefined ? '' : `&before=${before}`}`,
  );
  return arrayFrom(payload, 'events')
    .map(normalizeEvent)
    .filter((event): event is OmniEvent => event !== null)
    .sort((a, b) => a.rowid - b.rowid);
}

function normalizeWarning(raw: unknown): Warning | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const title = text(record.title);
  const whatHappened = text(record.what_happened);
  const whatItMeans = text(record.what_it_means);
  if (!title || !whatHappened || !whatItMeans) return null;
  const eventIds = Array.isArray(record.event_ids)
    ? record.event_ids
        .map((id) => text(id))
        .filter((id): id is string => id !== null)
    : [];
  return {
    title,
    what_happened: whatHappened,
    what_it_means: whatItMeans,
    severity: text(record.severity) ?? 'info',
    event_ids: eventIds,
    session_id: text(record.session_id),
  };
}

export async function fetchWarnings(root: string): Promise<Warning[]> {
  try {
    const payload = await getJson(`${API_BASE}/warnings?root=${encodeURIComponent(root)}`);
    return arrayFrom(payload, 'warnings')
      .map(normalizeWarning)
      .filter((warning): warning is Warning => warning !== null);
  } catch {
    return [];
  }
}

export interface DiagnosePreviousStep {
  kind: string | null;
  tool: string | null;
  duration_ms: number | null;
  event_id: string | null;
}

/** Answer from GET /api/v1/diagnose (viewer/omniscience_viewer/diagnose.py). */
export type Diagnose =
  | {
      status: 'explained';
      failed_kind: string | null;
      failed_tool: string | null;
      error_type: string | null;
      duration_ms: number | null;
      session_id: string | null;
      previous_step: DiagnosePreviousStep | null;
      evidence_event_ids: string[];
      sentence: string;
    }
  | { status: 'no_failure'; events: number | null }
  | { status: 'insufficient'; missing: string[] };

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => text(item)).filter((item): item is string => item !== null);
}

function insufficientDiagnose(missing: string[]): Diagnose {
  return { status: 'insufficient', missing: missing.length > 0 ? missing : ['response'] };
}

export function normalizeDiagnose(raw: unknown): Diagnose {
  if (!raw || typeof raw !== 'object') {
    return insufficientDiagnose([]);
  }
  const record = raw as Record<string, unknown>;
  const status = text(record.status);
  if (status === 'no_failure') {
    return { status: 'no_failure', events: numberOrNull(record.events) };
  }
  if (status === 'insufficient') {
    return insufficientDiagnose(stringArray(record.missing));
  }
  const sentence = text(record.sentence);
  if (status !== 'explained' || !sentence) {
    return insufficientDiagnose([]);
  }
  const previousRaw = record.previous_step;
  let previousStep: DiagnosePreviousStep | null = null;
  if (previousRaw && typeof previousRaw === 'object') {
    const previous = previousRaw as Record<string, unknown>;
    previousStep = {
      kind: text(previous.kind),
      tool: text(previous.tool),
      duration_ms: numberOrNull(previous.duration_ms),
      event_id: text(previous.event_id),
    };
  }
  return {
    status: 'explained',
    failed_kind: text(record.failed_kind),
    failed_tool: text(record.failed_tool),
    error_type: text(record.error_type),
    duration_ms: numberOrNull(record.duration_ms),
    session_id: text(record.session_id),
    previous_step: previousStep,
    evidence_event_ids: stringArray(record.evidence_event_ids),
    sentence,
  };
}

/** Returns null when the viewer cannot be reached (transport error). */
export async function fetchDiagnose(root: string): Promise<Diagnose | null> {
  try {
    const payload = await getJson(`${API_BASE}/diagnose?root=${encodeURIComponent(root)}`);
    return normalizeDiagnose(payload);
  } catch {
    return null;
  }
}

export function liveUrl(root: string, after: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return withToken(`${protocol}//${window.location.host}${API_BASE}/live?root=${encodeURIComponent(root)}&after=${after}`);
}

/** The subprotocol string to pass as `new WebSocket(url, [subprotocol])`, or null. */
export function liveSubprotocol(): string | null {
  return wsSubprotocol();
}

function normalizePrefs(raw: unknown): ChatPrefs {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const digest = (record.digest && typeof record.digest === "object" ? record.digest : {}) as Record<
    string,
    unknown
  >;
  const detail = digest.detail;
  return {
    digest: {
      enabled: typeof digest.enabled === "boolean" ? digest.enabled : true,
      detail: detail === "brief" || detail === "full" ? detail : "standard",
    },
  };
}

export async function getPrefs(): Promise<ChatPrefs> {
  return normalizePrefs(await getJson(`${API_BASE}/prefs`));
}

export async function setPrefs(patch: {
  digest?: { enabled?: boolean; detail?: "brief" | "standard" | "full" };
}): Promise<ChatPrefs> {
  const response = await fetch(`${API_BASE}/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...tokenHeaders() },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return normalizePrefs(await response.json());
}

export interface ModelLatency {
  /** The provider the request was actually sent to (nous, opencode-go, …) — a rate limit or a
   * queue belongs to the account, not the model name. */
  provider: string;
  model: string;
  calls: number;
  p50_s: number | null;
  p95_s: number | null;
  max_s: number | null;
  ttfb_p50_s: number | null;
  over_30s: number;
  errors: number;
  rate_limited: number;
  timeouts: number;
  other_errors: number;
  /** Requests that needed a retry before they succeeded. */
  retried: number;
  /** Context drops (compactions) seen while this model was in use. */
  compactions: number;
  last_seen: number | null;
}

export interface ProviderLatency {
  provider: string;
  models: number;
  calls: number;
  errors: number;
  rate_limited: number;
  timeouts: number;
  retried: number;
  compactions: number;
  p95_s: number | null;
  worst_model: string | null;
  last_seen: number | null;
}

export interface LatencyReport {
  models: ModelLatency[];
  providers: ProviderLatency[];
}

const EMPTY_LATENCY: LatencyReport = { models: [], providers: [] };

/** Observed latency per provider and model, from the recorder's own timings. No probing.
 *  `windowSeconds` limits the lookback (0 = everything ever recorded). */
export async function fetchLatency(windowSeconds = 0): Promise<LatencyReport> {
  try {
    const response = await fetch(`${API_BASE}/latency?window=${Math.max(0, Math.round(windowSeconds))}`, {
      headers: { accept: 'application/json', ...tokenHeaders() },
    });
    if (!response.ok) return EMPTY_LATENCY;
    const body = (await response.json()) as Partial<LatencyReport>;
    return {
      models: Array.isArray(body.models) ? body.models : [],
      providers: Array.isArray(body.providers) ? body.providers : [],
    };
  } catch {
    return EMPTY_LATENCY;
  }
}

/** Observed latency per model, from the recorder's own timings. No probing, no traffic. */

/** One model the machine can already call, as listed by its provider. */
export interface InsightChoice {
  provider: string;
  model: string;
  /** The model Hermes itself uses. */
  default?: boolean;
  /** Has completed calls in this recording (rate limits under a fifth of its traffic). */
  working?: boolean;
  /** The picker's starting choice: cheapest model that has actually answered here. */
  recommended?: boolean;
  /** Why it is recommended, in words. */
  why?: string;
}

export interface InsightModels {
  models: InsightChoice[];
  unavailable: { provider: string; reason: string }[];
}

/** The models Hermes itself is authenticated for. Never a typed-in list. */
export async function fetchInsightModels(): Promise<InsightModels> {
  try {
    const body = (await getJson(`${API_BASE}/insight/models`)) as Partial<InsightModels>;
    return {
      models: Array.isArray(body.models) ? body.models : [],
      unavailable: Array.isArray(body.unavailable) ? body.unavailable : [],
    };
  } catch {
    return { models: [], unavailable: [{ provider: 'hermes', reason: 'the viewer did not answer' }] };
  }
}

export interface InsightReport {
  markdown: string;
  model: string;
  provider: string;
  days: number;
  took_s: number;
  generated_at: number;
  finish_reason?: string | null;
  usage: Record<string, unknown>;
}

/** Ask one of the operator's own models to read the recording and write it up. */
export async function askInsight(
  choice: InsightChoice,
  days: number,
): Promise<{ report: InsightReport | null; error: string | null }> {
  try {
    const response = await fetch(`${API_BASE}/insight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...tokenHeaders() },
      body: JSON.stringify({ provider: choice.provider, model: choice.model, days }),
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        /* a non-JSON error body keeps the status line */
      }
      return { report: null, error: detail };
    }
    return { report: (await response.json()) as InsightReport, error: null };
  } catch (exc) {
    return { report: null, error: exc instanceof Error ? exc.message : String(exc) };
  }
}

/** Which build is answering: version from the manifest, commit from the stamp. */
export interface BuildInfo {
  version: string;
  /** The release this tree is heading to, e.g. "1.0.0" while the build reads "1.0.0-dev.183". */
  release?: string;
  channel?: string;
  commit: string;
  commit_short: string;
  commit_date: string | null;
  built_at: string | null;
  dirty: boolean | null;
  build: string;
}

export async function fetchVersion(): Promise<BuildInfo | null> {
  try {
    const response = await fetch(`${API_BASE}/version`, {
      headers: { accept: 'application/json', ...tokenHeaders() },
    });
    if (!response.ok) return null;
    return (await response.json()) as BuildInfo;
  } catch {
    return null;
  }
}

/** The build the viewer is serving right now; used to notice that this tab is out of date. */
export async function fetchBuildId(): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/ping`, { headers: { accept: 'application/json', ...tokenHeaders() } });
    if (!response.ok) return null;
    const body = (await response.json()) as { build?: unknown };
    return typeof body.build === 'string' ? body.build : null;
  } catch {
    return null;
  }
}

/**
 * Download a spreadsheet-ready CSV export (metadata only). Uses the viewer key like every request.
 *
 * In a browser this is a normal download. Inside the Hermes desktop app an `<a download>` can be
 * silently swallowed (no download shelf, no dialog), which is what "Export CSV doesn't work"
 * looks like — so when the page is allowed to save files, ask for a destination with the File
 * System Access API and write the bytes there. The caller gets the filename back either way.
 */
export async function downloadCsv(
  table: 'steps' | 'chats' | 'models',
  root: string | null,
): Promise<{ name: string; savedWithPicker: boolean }> {
  const query = root ? `?root=${encodeURIComponent(root)}` : '';
  const response = await fetch(`${API_BASE}/export/${table}.csv${query}`, { headers: tokenHeaders() });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `omniscience-${table}.csv`;
  const blob = await response.blob();

  const picker = (window as { showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(window, {
        suggestedName: name,
        types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { name: handle.name || name, savedWithPicker: true };
    } catch (error) {
      // The user cancelled: not an error, and no second copy should be dropped anywhere.
      if ((error as { name?: string })?.name === 'AbortError') {
        return { name, savedWithPicker: true };
      }
      // Anything else (no permission, embedded frame): fall through to the plain download.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name, savedWithPicker: false };
}

export async function fetchSourceStatus(): Promise<UsageReport['sources']> {
  const payload = await getJson(`${API_BASE}/usage/sources`);
  const record = (payload ?? {}) as Record<string, unknown>;
  return Array.isArray(record.sources) ? (record.sources as UsageReport['sources']) : [];
}

export async function setSourceEnabled(
  source: string,
  enabled: boolean,
): Promise<UsageReport['sources']> {
  const response = await fetch(`${API_BASE}/usage/sources`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...tokenHeaders() },
    body: JSON.stringify({ source, enabled }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const record = (await response.json()) as Record<string, unknown>;
  return Array.isArray(record.sources) ? (record.sources as UsageReport['sources']) : [];
}

/** One failure, explained from the recorded rows: what, why, and what to do. */
export interface FailureExplanation {
  event_id: string | null;
  ts: number | null;
  kind: string;
  tool: string | null;
  status: string | null;
  error_type: string | null;
  reason: string | null;
  status_code: number | null;
  model: string | null;
  provider: string | null;
  prompt_tokens: number | null;
  rate_limits_before: number;
  headline: string;
  why: string[];
  actions: string[];
}

/** Why the run stopped where it did. Not a failure row: an unanswered request is a flow fact. */
export interface StopExplanation {
  stopped: boolean;
  reason: string;
  event_id: string | null;
  headline: string;
  why: string[];
  actions: string[];
}

export interface FailureReport {
  root: string | null;
  window: number;
  truncated: boolean;
  failures: FailureExplanation[];
  stop: StopExplanation | null;
}

const EMPTY_FAILURES: FailureReport = {
  root: null,
  window: 0,
  truncated: false,
  failures: [],
  stop: null,
};

/** Every failure in a run, explained. Read-only and derived from the recording. */
export async function fetchFailures(root: string): Promise<FailureReport> {
  try {
    const body = (await getJson(`${API_BASE}/failures?root=${encodeURIComponent(root)}`)) as Partial<FailureReport>;
    return {
      root: body.root ?? root,
      window: typeof body.window === 'number' ? body.window : 0,
      truncated: body.truncated === true,
      failures: Array.isArray(body.failures) ? body.failures : [],
      stop: body.stop && typeof body.stop === 'object' ? (body.stop as StopExplanation) : null,
    };
  } catch {
    return EMPTY_FAILURES;
  }
}
