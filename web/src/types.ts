export type OmniAttrs = Record<string, unknown> | string | null;

export interface OmniEvent {
  rowid: number;
  event_id: string;
  schema: string;
  boot_id: string;
  seq: number;
  ts: number;
  kind: string;
  session_id: string | null;
  parent_session_id: string | null;
  turn_id: string | null;
  api_request_id: string | null;
  tool_call_id: string | null;
  subagent_id: string | null;
  status: string | null;
  attrs: OmniAttrs;
}

/** A plain-English warning from GET /api/v1/warnings. */
export interface Warning {
  title: string;
  what_happened: string;
  what_it_means: string;
  /** What to do about it: the cause and the next action, in plain words. */
  what_to_do?: string;
  severity: string;
  event_ids: string[];
  session_id: string | null;
}

export interface SessionMeta {
  id: string;
  label?: string | null;
  source?: string | null;
  archived?: boolean | null;
  first_ts?: number | null;
  last_ts?: number | null;
  events?: number | null;
  model?: string | null;
  status?: string | null;
  /** Token and activity totals, computed by the viewer from the recording. */
  calls?: number | null;
  cached?: number | null;
  fresh?: number | null;
  output?: number | null;
  prompt_max?: number | null;
  /** The context as it stands now — after a compaction this drops, unlike the peak. */
  prompt_now?: number | null;
  tools?: number | null;
  mcp_calls?: number | null;
  skills?: number | null;
  aux_calls?: number | null;
  subagents?: number | null;
  compactions?: number | null;
}

/** Settings shared with the Hermes plugin: these change what the chat posts. */
export interface ChatPrefs {
  digest: {
    enabled: boolean;
    detail: "brief" | "standard" | "full";
  };
}

/** One row of GET /api/v1/usage — the Usage page. */
export interface UsageTotals {
  calls: number;
  chats: number;
  prompt: number;
  fresh: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  tool_calls: number;
  errors: number;
  aux_calls: number;
  cost: number;
}

export interface UsageDay extends UsageTotals {
  day: string;
}

export interface UsageDayModel {
  day: string;
  model: string;
  prompt: number;
  output: number;
  calls: number;
}

export interface UsageModel {
  model: string;
  calls: number;
  prompt: number;
  fresh: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  errors: number;
  p50_s: number | null;
  p95_s: number | null;
  ttfb_median_s: number | null;
  cost: number | null;
  rates: { in: number; out: number; cache: number } | null;
}

export interface UsageChat {
  id: string;
  calls: number;
  prompt: number;
  prompt_now: number;
  prompt_max: number;
  cache_read: number;
  output: number;
  tools: number;
  first_ts: number;
  last_ts: number;
  p95_s: number | null;
  cost: number | null;
}


export interface UsageHarness {
  source: string;
  calls: number;
  prompt: number;
  fresh: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  models: string[];
}

export interface UsageTimeMetrics {
  sessions: number;
  active_s: number;
  longest_s: number;
  peak_concurrent: number;
}

export interface UsageSourceStatus {
  id: string;
  label: string;
  enabled: boolean;
  available: boolean;
  /** A client this page knows about but cannot read (no local usage log). Never switchable. */
  declared?: boolean;
  imported: number;
  disk_files: number;
  disk_bytes: number;
  note: string;
  last_scan: number | null;
  /** false = the client is named here but keeps no token data we can read. */
  measurable?: boolean;
}

export interface UsageReport {
  days: number;
  generated_at: number;
  since: number;
  totals: UsageTotals;
  daily: UsageDay[];
  daily_models: UsageDayModel[];
  models: UsageModel[];
  cache: {
    read: number;
    fresh: number;
    hit_rate: number | null;
    saved_usd: number | null;
    priced_share: number | null;
  };
  context: {
    histogram: { band: string; calls: number }[];
    compactions: { session: string; before: number; after: number }[];
    context_tokens: number;
    calls_with_context: number;
  };
  chats: UsageChat[];
  cost_available: boolean;
  harnesses: UsageHarness[];
  hourly: number[];
  weekday_hour: number[][];
  time_metrics: UsageTimeMetrics;
  sources: UsageSourceStatus[];
}
