import type { OmniEvent } from "../types";

export interface ContextCall {
  eventId: string;
  ts: number;
  turnIndex: number;
  prompt: number | null;
  cached: number | null;
  messages: number | null;
  tools: number | null;
  output: number | null;
}

/** A step where the context fell back — a compaction, whenever one happened. */
export interface ContextDrop {
  /** Index into `ContextResult.calls`. */
  index: number;
  from: number;
  to: number;
  saved: number;
}

export interface ContextSummary {
  first: number | null;
  last: number | null;
  growthPerTurn: number | null;
  biggestJump: { from: number; to: number; eventId: string } | null;
  drops: ContextDrop[];
  notes: string[];
}

export interface ContextResult {
  calls: ContextCall[];
  summary: ContextSummary;
}

function parseAttrs(attrs: OmniEvent["attrs"]): Record<string, unknown> {
  if (attrs == null) return {};
  if (typeof attrs === "string") {
    try {
      const parsed = JSON.parse(attrs);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof attrs === "object") return attrs as Record<string, unknown>;
  return {};
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function buildContext(events: OmniEvent[], rootSessionId: string | null): ContextResult {
  const mainEvents = rootSessionId
    ? events.filter((e) => e.session_id === rootSessionId)
    : events;

  const sorted = [...mainEvents].sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  // Assign turn index by walking turn.start events in time order.
  let currentTurn = -1;
  const calls: ContextCall[] = [];

  // The recorder puts real usage on llm.response; pair it with its request by api_request_id.
  const responseUsage = new Map<string, Record<string, unknown>>();
  for (const e of sorted) {
    if (e.kind !== "llm.response" || !e.api_request_id) continue;
    const u = parseAttrs(e.attrs).usage;
    if (u && typeof u === "object") responseUsage.set(e.api_request_id, u as Record<string, unknown>);
  }

  for (const e of sorted) {
    if (e.kind === "turn.start") {
      currentTurn += 1;
      continue;
    }
    if (e.kind !== "llm.request") continue;

    const attrs = parseAttrs(e.attrs);
    const usage =
      (e.api_request_id ? responseUsage.get(e.api_request_id) : undefined) ??
      (attrs.usage && typeof attrs.usage === "object" ? (attrs.usage as Record<string, unknown>) : null);

    const promptTokens = usage ? num(usage.prompt_tokens) : null;
    const approx = num(attrs.approx_input_tokens);
    const prompt = promptTokens != null ? promptTokens : approx;

    const cached = usage ? num(usage.cache_read_tokens) : null;
    const messages = num(attrs.message_count);
    const tools = num(attrs.tool_count);
    const output = usage ? num(usage.output_tokens) : null;

    calls.push({
      eventId: e.event_id,
      ts: e.ts,
      turnIndex: currentTurn >= 0 ? currentTurn : 0,
      prompt,
      cached,
      messages,
      tools,
      output,
    });
  }

  const withPrompt = calls.filter((c) => c.prompt != null) as Array<
    ContextCall & { prompt: number }
  >;

  const first = withPrompt.length ? withPrompt[0].prompt : null;
  const last = withPrompt.length ? withPrompt[withPrompt.length - 1].prompt : null;

  // Biggest jump between consecutive calls.
  let biggestJump: ContextSummary["biggestJump"] = null;
  for (let i = 1; i < withPrompt.length; i++) {
    const from = withPrompt[i - 1].prompt;
    const to = withPrompt[i].prompt;
    const delta = to - from;
    if (biggestJump == null || delta > biggestJump.to - biggestJump.from) {
      biggestJump = { from, to, eventId: withPrompt[i].eventId };
    }
  }

  // growthPerTurn: median prompt increase between consecutive turns' first calls.
  const firstCallPerTurn = new Map<number, number>();
  for (const c of withPrompt) {
    if (!firstCallPerTurn.has(c.turnIndex)) {
      firstCallPerTurn.set(c.turnIndex, c.prompt);
    }
  }
  const turnPrompts = [...firstCallPerTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => p);
  const turnDeltas: number[] = [];
  for (let i = 1; i < turnPrompts.length; i++) {
    turnDeltas.push(turnPrompts[i] - turnPrompts[i - 1]);
  }
  const growthPerTurn = median(turnDeltas);

  // Same thresholds the token view uses: a drop has to be both big and steep,
  // so cached-token wobble is never called a compaction.
  const drops: ContextDrop[] = [];
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1].prompt;
    const cur = calls[i].prompt;
    if (prev == null || cur == null) continue;
    if (prev - cur > 1000 && cur < prev * 0.75) {
      drops.push({ index: i, from: prev, to: cur, saved: prev - cur });
    }
  }

  const notes: string[] = [];
  if (first != null && last != null) {
    notes.push(
      `Each model call now re-sends about ${fmt(last)} tokens; it started at ${fmt(first)}.`
    );
  }
  if (biggestJump) {
    const jump = biggestJump.to - biggestJump.from;
    const idx = withPrompt.findIndex((c) => c.eventId === biggestJump!.eventId);
    notes.push(
      `The biggest jump (+${fmt(jump)} tokens) happened at message ${idx + 1}.`
    );
  }
  if (growthPerTurn != null) {
    notes.push(`On average each message adds about ${fmt(growthPerTurn)} tokens.`);
  }
  if (drops.length > 0) {
    const last = drops[drops.length - 1];
    notes.push(
      drops.length === 1
        ? `It dropped back once, saving ${fmt(last.saved)} tokens on that call.`
        : drops.length === 2
          ? `It dropped back twice; the last one saved ${fmt(last.saved)} tokens.`
          : `It dropped back ${drops.length} times; the last one saved ${fmt(last.saved)} tokens.`
    );
  }

  return { calls, summary: { first, last, growthPerTurn, biggestJump, drops, notes } };
}
