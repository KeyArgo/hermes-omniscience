import type { OmniEvent } from "../types";

export type WatcherKind =
  | "failures"
  | "rate_limits"
  | "model_switches"
  | "compaction"
  | "slow"
  | "fresh_tokens"
  | "tool"
  | "skill"
  | "helpers"
  | "mcp";

export interface Watcher {
  id: string;
  kind: WatcherKind;
  target?: string;
  threshold?: number;
}

export interface WatchHit {
  at: number;
  eventId: string;
  text: string;
}

export interface WatchResult {
  watcher: Watcher;
  label: string;
  tip: string;
  hits: WatchHit[];
  count: number;
  lastAt: number | null;
  lastEventId: string | null;
  tone: "ok" | "warn" | "bad";
  summary: string;
  spark: number[];
}

export const WATCHER_PRESETS: {
  kind: WatcherKind;
  label: string;
  tip: string;
  threshold?: number;
  needsTarget?: boolean;
}[] = [
  {
    kind: "failures",
    label: "failures",
    tip: "tool failures and model call errors",
  },
  {
    kind: "rate_limits",
    label: "rate limits",
    tip: "429s and rate limit errors from the model provider",
  },
  {
    kind: "model_switches",
    label: "model switches",
    tip: "responses that came from a different model than requested",
  },
  {
    kind: "compaction",
    label: "compaction",
    tip: "big drops in prompt size, a sign context was compacted",
  },
  {
    kind: "slow",
    label: "slow steps",
    tip: "tool calls or model responses slower than the threshold",
    threshold: 30,
  },
  {
    kind: "fresh_tokens",
    label: "fresh tokens",
    tip: "prompt tokens not served from cache, a cost signal",
  },
  {
    kind: "tool",
    label: "tool",
    tip: "every run of a specific tool",
    needsTarget: true,
  },
  {
    kind: "skill",
    label: "skill",
    tip: "loads of a specific skill",
    needsTarget: true,
  },
  {
    kind: "helpers",
    label: "helpers",
    tip: "subagents spawned during the chat",
  },
  {
    kind: "mcp",
    label: "mcp calls",
    tip: "tool calls routed through an MCP server",
  },
];

export const DEFAULT_WATCHERS: Watcher[] = [
  { id: "failures", kind: "failures" },
  { id: "rate_limits", kind: "rate_limits" },
  { id: "model_switches", kind: "model_switches" },
  { id: "compaction", kind: "compaction" },
  { id: "slow:30", kind: "slow", threshold: 30 },
  { id: "fresh_tokens", kind: "fresh_tokens" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseAttrs(event: OmniEvent): Record<string, unknown> {
  const raw = event.attrs;
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      const rec = asRecord(parsed);
      return rec ?? {};
    } catch {
      return {};
    }
  }
  const rec = asRecord(raw);
  return rec ?? {};
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    const rounded = Math.round(m * 10) / 10;
    return `${sign}${trimZero(rounded)}M`;
  }
  if (abs >= 1000) {
    const k = abs / 1000;
    const rounded = Math.round(k * 10) / 10;
    return `${sign}${trimZero(rounded)}k`;
  }
  return `${sign}${Math.round(abs)}`;
}

function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function eventTime(e: OmniEvent): number {
  const t = num(e.ts);
  return t === null ? 0 : t;
}

function cmpTime(a: OmniEvent, b: OmniEvent): number {
  return eventTime(a) - eventTime(b);
}

function isChatLlmResponse(e: OmniEvent): boolean {
  return e.kind === "llm.response";
}

function usageOf(e: OmniEvent): Record<string, unknown> | null {
  const attrs = parseAttrs(e);
  return asRecord(attrs["usage"]);
}

function promptTokens(e: OmniEvent): number {
  const usage = usageOf(e);
  if (!usage) return 0;
  const n = num(usage["prompt_tokens"]);
  return n === null ? 0 : n;
}

function cacheReadTokens(e: OmniEvent): number {
  const usage = usageOf(e);
  if (!usage) return 0;
  const n = num(usage["cache_read_tokens"]);
  return n === null ? 0 : n;
}

function buildSpark(
  events: OmniEvent[],
  hits: WatchHit[],
): number[] {
  const buckets = new Array<number>(16).fill(0);
  if (events.length === 0) return buckets;
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const e of events) {
    const t = eventTime(e);
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return buckets;
  const range = maxTs - minTs;
  for (const hit of hits) {
    let idx: number;
    if (range <= 0) {
      idx = 0;
    } else {
      const rel = (hit.at - minTs) / range;
      idx = Math.floor(rel * 16);
      if (idx < 0) idx = 0;
      if (idx > 15) idx = 15;
    }
    buckets[idx] += 1;
  }
  return buckets;
}

function finalize(
  watcher: Watcher,
  label: string,
  tip: string,
  hits: WatchHit[],
  events: OmniEvent[],
  tone: "ok" | "warn" | "bad",
  summary: string,
): WatchResult {
  const sorted = [...hits].sort((a, b) => a.at - b.at);
  const last = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  return {
    watcher,
    label,
    tip,
    hits: sorted,
    count: sorted.length,
    lastAt: last ? last.at : null,
    lastEventId: last ? last.eventId : null,
    tone,
    summary,
    spark: buildSpark(events, sorted),
  };
}

function emptyResult(watcher: Watcher, events: OmniEvent[]): WatchResult {
  return finalize(
    watcher,
    watcherLabel(watcher),
    watcherTip(watcher),
    [],
    events,
    "ok",
    "0",
  );
}

export function watcherLabel(w: Watcher): string {
  switch (w.kind) {
    case "failures":
      return "failures";
    case "rate_limits":
      return "rate limits";
    case "model_switches":
      return "model switches";
    case "compaction":
      return "compaction";
    case "slow": {
      const t = w.threshold ?? 30;
      return `slower than ${t}s`;
    }
    case "fresh_tokens":
      return "fresh tokens";
    case "tool":
      return w.target ? `tool · ${w.target}` : "tool";
    case "skill":
      return w.target ? `skill · ${w.target}` : "skill";
    case "helpers":
      return "helpers";
    case "mcp":
      return "mcp calls";
    default:
      return w.kind;
  }
}

export function watcherTip(w: Watcher): string {
  const preset = WATCHER_PRESETS.find((p) => p.kind === w.kind);
  if (preset) return preset.tip;
  return "watcher";
}

function plural(n: number, word: string, pluralWord?: string): string {
  if (n === 1) return `1 ${word}`;
  return `${n} ${pluralWord ?? `${word}s`}`;
}

function collectFailures(events: OmniEvent[]): WatchHit[] {
  const hits: WatchHit[] = [];
  for (const e of events) {
    if (e.kind === "tool.end") {
      if (e.status !== null && e.status !== "ok") {
        const attrs = parseAttrs(e);
        const toolName = str(attrs["tool_name"]) ?? "tool";
        hits.push({
          at: eventTime(e),
          eventId: e.event_id,
          text: `${toolName} failed`,
        });
      }
    } else if (e.kind === "llm.error") {
      const attrs = parseAttrs(e);
      const reason = str(attrs["reason"]);
      const detail = reason ? `: ${reason}` : "";
      hits.push({
        at: eventTime(e),
        eventId: e.event_id,
        text: `model call failed${detail}`,
      });
    }
  }
  return hits;
}

function isRateLimitError(e: OmniEvent): boolean {
  if (e.kind !== "llm.error") return false;
  const attrs = parseAttrs(e);
  const code = num(attrs["status_code"]);
  if (code !== null && code === 429) return true;
  const reason = str(attrs["reason"]);
  if (reason !== null && reason.toLowerCase().includes("rate")) return true;
  return false;
}

function collectRateLimits(events: OmniEvent[]): WatchHit[] {
  const hits: WatchHit[] = [];
  for (const e of events) {
    if (isRateLimitError(e)) {
      hits.push({
        at: eventTime(e),
        eventId: e.event_id,
        text: "rate limited",
      });
    }
  }
  return hits;
}

function collectModelSwitches(events: OmniEvent[]): WatchHit[] {
  const requested = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== "llm.request") continue;
    const key = e.api_request_id;
    if (key === null || key === undefined) continue;
    const attrs = parseAttrs(e);
    const model = str(attrs["model"]);
    if (model !== null) requested.set(key, model);
  }
  const hits: WatchHit[] = [];
  for (const e of events) {
    if (!isChatLlmResponse(e)) continue;
    const key = e.api_request_id;
    if (key === null || key === undefined) continue;
    const asked = requested.get(key);
    if (asked === undefined) continue;
    const attrs = parseAttrs(e);
    const answered = str(attrs["response_model"]);
    if (answered === null) continue;
    if (answered === asked) continue;
    hits.push({
      at: eventTime(e),
      eventId: e.event_id,
      text: `asked ${asked}, answered by ${answered}`,
    });
  }
  return hits;
}

function collectCompaction(events: OmniEvent[]): WatchHit[] {
  const responses = events
    .filter(isChatLlmResponse)
    .sort(cmpTime);
  const steps: { e: OmniEvent; prompt: number }[] = [];
  for (const e of responses) {
    const p = promptTokens(e);
    if (p > 0) steps.push({ e, prompt: p });
  }
  const hits: WatchHit[] = [];
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const cur = steps[i];
    const drop = prev.prompt - cur.prompt;
    if (drop > 1000 && cur.prompt < prev.prompt * 0.75) {
      hits.push({
        at: eventTime(cur.e),
        eventId: cur.e.event_id,
        text: `context ${formatTokens(prev.prompt)} -> ${formatTokens(cur.prompt)}`,
      });
    }
  }
  return hits;
}

function collectSlow(events: OmniEvent[], thresholdS: number): WatchHit[] {
  const hits: WatchHit[] = [];
  const limitMs = thresholdS * 1000;
  for (const e of events) {
    if (e.kind === "tool.end") {
      const attrs = parseAttrs(e);
      const durMs = num(attrs["duration_ms"]);
      if (durMs === null || durMs <= limitMs) continue;
      const toolName = str(attrs["tool_name"]) ?? "tool";
      hits.push({
        at: eventTime(e),
        eventId: e.event_id,
        text: `${toolName} took ${Math.round(durMs / 1000)}s`,
      });
    } else if (isChatLlmResponse(e)) {
      const attrs = parseAttrs(e);
      const durS = num(attrs["duration_s"]);
      if (durS === null || durS <= thresholdS) continue;
      hits.push({
        at: eventTime(e),
        eventId: e.event_id,
        text: `model response took ${Math.round(durS)}s`,
      });
    }
  }
  return hits;
}

function collectTool(events: OmniEvent[], target: string): { hits: WatchHit[]; anyFailed: boolean } {
  const hits: WatchHit[] = [];
  let anyFailed = false;
  for (const e of events) {
    if (e.kind !== "tool.end") continue;
    const attrs = parseAttrs(e);
    const toolName = str(attrs["tool_name"]);
    if (toolName === null || toolName !== target) continue;
    const failed = e.status !== null && e.status !== "ok";
    if (failed) anyFailed = true;
    hits.push({
      at: eventTime(e),
      eventId: e.event_id,
      text: failed ? `${target} failed` : `${target} ran`,
    });
  }
  return { hits, anyFailed };
}

function collectSkill(events: OmniEvent[], target: string): WatchHit[] {
  const hits: WatchHit[] = [];
  for (const e of events) {
    if (e.kind !== "skill.event") continue;
    const attrs = parseAttrs(e);
    const action = str(attrs["action"]);
    if (action === null || action !== "loaded") continue;
    const skillName = str(attrs["skill_name"]);
    if (skillName === null || skillName !== target) continue;
    hits.push({
      at: eventTime(e),
      eventId: e.event_id,
      text: `loaded ${target}`,
    });
  }
  return hits;
}

function collectHelpers(events: OmniEvent[]): WatchHit[] {
  const hits: WatchHit[] = [];
  for (const e of events) {
    if (e.kind !== "subagent.start") continue;
    hits.push({
      at: eventTime(e),
      eventId: e.event_id,
      text: "helper started",
    });
  }
  return hits;
}

function collectMcp(events: OmniEvent[]): WatchHit[] {
  const hits: WatchHit[] = [];
  for (const e of events) {
    if (e.kind !== "tool.end") continue;
    const attrs = parseAttrs(e);
    const server = str(attrs["mcp_server"]);
    if (server === null || server.length === 0) continue;
    const toolName = str(attrs["tool_name"]) ?? "tool";
    hits.push({
      at: eventTime(e),
      eventId: e.event_id,
      text: `${server}: ${toolName}`,
    });
  }
  return hits;
}

function freshTokensStats(
  events: OmniEvent[],
): { total: number; perCall: { at: number; fresh: number }[] } {
  const responses = events
    .filter(isChatLlmResponse)
    .sort(cmpTime);
  let total = 0;
  const perCall: { at: number; fresh: number }[] = [];
  for (const e of responses) {
    const p = promptTokens(e);
    const c = cacheReadTokens(e);
    const fresh = p - c;
    if (fresh <= 0) continue;
    total += fresh;
    perCall.push({ at: eventTime(e), fresh });
  }
  return { total, perCall };
}

function freshSpark(
  events: OmniEvent[],
  perCall: { at: number; fresh: number }[],
): number[] {
  const buckets = new Array<number>(16).fill(0);
  if (events.length === 0) return buckets;
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const e of events) {
    const t = eventTime(e);
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return buckets;
  const range = maxTs - minTs;
  for (const call of perCall) {
    let idx: number;
    if (range <= 0) {
      idx = 0;
    } else {
      const rel = (call.at - minTs) / range;
      idx = Math.floor(rel * 16);
      if (idx < 0) idx = 0;
      if (idx > 15) idx = 15;
    }
    buckets[idx] += call.fresh;
  }
  return buckets;
}

export function buildWatchReport(
  events: OmniEvent[],
  watchers: Watcher[],
  options?: { nowTs?: number },
): WatchResult[] {
  void options;
  const results: WatchResult[] = [];
  for (const watcher of watchers) {
    results.push(buildOne(events, watcher));
  }
  return results;
}

function buildOne(events: OmniEvent[], watcher: Watcher): WatchResult {
  switch (watcher.kind) {
    case "failures": {
      const hits = collectFailures(events);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        hits.length > 0 ? "bad" : "ok",
        hits.length > 0 ? plural(hits.length, "failure") : "0",
      );
    }
    case "rate_limits": {
      const hits = collectRateLimits(events);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        hits.length > 0 ? "warn" : "ok",
        hits.length > 0 ? plural(hits.length, "rate limit") : "0",
      );
    }
    case "model_switches": {
      const hits = collectModelSwitches(events);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        "warn",
        hits.length > 0 ? plural(hits.length, "switch") : "0",
      );
    }
    case "compaction": {
      const hits = collectCompaction(events);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        "warn",
        hits.length > 0 ? plural(hits.length, "compaction") : "0",
      );
    }
    case "slow": {
      const threshold = watcher.threshold ?? 30;
      const hits = collectSlow(events, threshold);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        "warn",
        hits.length > 0 ? plural(hits.length, "slow step") : "0",
      );
    }
    case "fresh_tokens": {
      const { total, perCall } = freshTokensStats(events);
      const result = finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        [],
        events,
        "ok",
        total > 0 ? `${formatTokens(total)} new` : "0",
      );
      result.spark = freshSpark(events, perCall);
      return result;
    }
    case "tool": {
      const target = watcher.target;
      if (target === undefined || target === null || target === "") {
        return emptyResult(watcher, events);
      }
      const { hits, anyFailed } = collectTool(events, target);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        anyFailed ? "bad" : "warn",
        hits.length > 0 ? plural(hits.length, "call") : "0",
      );
    }
    case "skill": {
      const target = watcher.target;
      if (target === undefined || target === null || target === "") {
        return emptyResult(watcher, events);
      }
      const hits = collectSkill(events, target);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        "warn",
        hits.length > 0 ? plural(hits.length, "load") : "0",
      );
    }
    case "helpers": {
      const hits = collectHelpers(events);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        "warn",
        hits.length > 0 ? plural(hits.length, "helper") : "0",
      );
    }
    case "mcp": {
      const hits = collectMcp(events);
      return finalize(
        watcher,
        watcherLabel(watcher),
        watcherTip(watcher),
        hits,
        events,
        "warn",
        hits.length > 0 ? plural(hits.length, "call") : "0",
      );
    }
    default:
      return emptyResult(watcher, events);
  }
}


/** Something in this chat the user could choose to watch. */
export interface WatchCandidate {
  id: string;
  kind: WatcherKind;
  label: string;
  /** How often it appears in the events on screen, so the useful ones come first. */
  count: number;
  target?: string;
}

function candidateKey(kind: WatcherKind, target: string): string {
  return `${kind}:${target}`;
}

/**
 * What the user could add, discovered from the chat that is on screen.
 *
 * Typing a tool name blind is how a watchlist ends up full of things that never
 * run. This reads the events already loaded and offers the tools, MCP servers and
 * skills that actually appear, busiest first, minus the ones already watched.
 */
export function watchCandidates(events: OmniEvent[], active: Watcher[]): WatchCandidate[] {
  const taken = new Set(
    active.map((w) => (w.target ? candidateKey(w.kind, w.target) : w.kind))
  );
  const counts = new Map<string, WatchCandidate>();

  const bump = (kind: WatcherKind, target: string | null, label?: string) => {
    if (!target) return;
    const id = candidateKey(kind, target);
    if (taken.has(id)) return;
    const existing = counts.get(id);
    if (existing) {
      existing.count += 1;
      return;
    }
    counts.set(id, { id, kind, label: label ?? target, count: 1, target });
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const raw = event.attrs;
    const attrs: Record<string, unknown> =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (event.kind === "tool.end") {
      const tool = typeof attrs.tool_name === "string" ? attrs.tool_name : null;
      const server = typeof attrs.mcp_server === "string" ? attrs.mcp_server : null;
      bump("tool", tool);
      bump("mcp", server);
    } else if (event.kind === "skill.event") {
      const skill = typeof attrs.skill_name === "string" ? attrs.skill_name : null;
      bump("skill", skill);
    }
  }

  return [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}
