import type { OmniEvent } from "../types";

export interface CallTokens {
  id: string;
  start: number;
  model: string;
  provider: string | null;
  role: "main" | "background" | "helper";
  task: string | null;
  cached: number;
  fresh: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** What the model was sent: cached + fresh. This is the context size. */
  prompt: number;
  seconds: number | null;
  ttfb: number | null;
  outPerSec: number | null;
  inPerSec: number | null;
  eventId: string;
}

/**
 * A context compaction seen from the outside: the next call sent a much smaller
 * prompt than the one before it. Nothing in the recording says "compaction"
 * happened, so this is what the provider's own numbers show.
 */
export interface CompactionMark {
  /** Start time of the call after the drop. */
  at: number;
  /** The call after the drop, so the UI can select it. */
  eventId: string;
  before: number;
  after: number;
  saved: number;
  /** Share of the input that came from cache, before and after. */
  beforeCacheShare: number | null;
  afterCacheShare: number | null;
  /** New (uncached) tokens the call after the drop had to process. */
  freshAfter: number;
  model: string;
}

export interface PromptPoint {
  at: number;
  prompt: number;
  eventId: string;
}

/** A drop this big (and this steep) is a compaction, not a wobble. */
export const COMPACTION_MIN_DROP = 1000;
export const COMPACTION_MIN_RATIO = 0.25;

export interface ModelTotals {
  model: string;
  provider: string | null;
  calls: number;
  cached: number;
  fresh: number;
  output: number;
  medianOutPerSec: number | null;
  medianTtfb: number | null;
  medianInPerSec: number | null;
}

export interface TokenReport {
  calls: CallTokens[];
  byModel: ModelTotals[];
  totals: {
    cached: number;
    fresh: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    cacheShare: number | null;
  };
  notes: string[];
  /** Context size over time: the chat's own calls only, in order. */
  promptSeries: PromptPoint[];
  compactions: CompactionMark[];
  activity: ChatActivity;
}

/** Everything a chat did, not just its model calls. */
export interface ChatActivity {
  llmCalls: number;
  tools: number;
  mcpCalls: number;
  skills: number;
  auxCalls: number;
  subagents: number;
  skillNames: string[];
  mcpServers: string[];
}

type Attrs = Record<string, unknown>;

function parseAttrs(raw: OmniEvent["attrs"]): Attrs {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Attrs) : {};
    } catch {
      return {};
    }
  }
  return raw;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function share(c: CallTokens): number | null {
  const total = c.cached + c.fresh;
  return total > 0 ? c.cached / total : null;
}

/**
 * Find context compactions in a chat's own calls.
 *
 * The recorder keeps no "compaction" event, so this reads the provider's own
 * numbers: a call whose prompt is much smaller than the call before it means
 * context was dropped between them. Background calls are skipped — they send a
 * few hundred tokens and would look like a compaction every time.
 */
export function detectCompactions(calls: CallTokens[]): CompactionMark[] {
  // Only the chat's own calls: a helper session's prompt is its own context and reads as a drop.
  const main = calls
    .filter((c) => c.role === "main" && c.prompt > 0)
    .sort((a, b) => a.start - b.start);

  const marks: CompactionMark[] = [];
  for (let i = 1; i < main.length; i += 1) {
    const before = main[i - 1];
    const after = main[i];
    const drop = before.prompt - after.prompt;
    if (drop <= COMPACTION_MIN_DROP) continue;
    if (after.prompt >= before.prompt * (1 - COMPACTION_MIN_RATIO)) continue;
    marks.push({
      at: after.start,
      eventId: after.eventId,
      before: before.prompt,
      after: after.prompt,
      saved: drop,
      beforeCacheShare: share(before),
      afterCacheShare: share(after),
      freshAfter: after.fresh,
      model: after.model,
    });
  }
  return marks;
}

/** Count everything the chat did, so the token view is not only model calls. */
export function buildChatActivity(events: OmniEvent[]): ChatActivity {
  const activity: ChatActivity = {
    llmCalls: 0,
    tools: 0,
    mcpCalls: 0,
    skills: 0,
    auxCalls: 0,
    subagents: 0,
    skillNames: [],
    mcpServers: [],
  };
  const skills = new Set<string>();
  const servers = new Set<string>();

  for (const ev of events) {
    const attrs = parseAttrs(ev.attrs);
    switch (ev.kind) {
      case "llm.response":
        activity.llmCalls += 1;
        break;
      case "aux.response":
        activity.auxCalls += 1;
        break;
      case "tool.end": {
        activity.tools += 1;
        const server = str(attrs.mcp_server);
        if (server) {
          activity.mcpCalls += 1;
          servers.add(server);
        }
        break;
      }
      case "skill.event": {
        activity.skills += 1;
        const name = str(attrs.skill_name);
        if (name) skills.add(name);
        break;
      }
      case "subagent.start":
        activity.subagents += 1;
        break;
      default:
        break;
    }
  }

  activity.skillNames = [...skills].sort();
  activity.mcpServers = [...servers].sort();
  return activity;
}

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function fmtRate(x: number): string {
  return `${Math.round(x).toLocaleString()}`;
}



function deriveTokens(usage: Attrs | null): {
  cached: number;
  fresh: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
} {
  const u = usage ?? {};
  const cacheRead = num(u.cache_read_tokens) ?? 0;
  const cacheWrite = num(u.cache_write_tokens) ?? 0;
  const output = num(u.output_tokens) ?? 0;
  const reasoning = num(u.reasoning_tokens) ?? 0;

  let prompt = num(u.prompt_tokens);
  if (prompt === null) {
    const input = num(u.input_tokens) ?? 0;
    prompt = input + cacheRead;
  }

  const cached = cacheRead;
  const fresh = Math.max(0, prompt - cacheRead);

  return { cached, fresh, cacheWrite, output, reasoning };
}

export function buildTokenReport(
  events: OmniEvent[],
  rootSessionId: string | null
): TokenReport {
  // Pair requests and responses by api_request_id.
  const requests = new Map<string, { ev: OmniEvent; attrs: Attrs }>();
  const responses = new Map<string, { ev: OmniEvent; attrs: Attrs }>();

  for (const ev of events) {
    const attrs = parseAttrs(ev.attrs);
    if (ev.kind === "llm.request" || ev.kind === "aux.request") {
      if (ev.api_request_id) requests.set(ev.api_request_id, { ev, attrs });
    } else if (ev.kind === "llm.response" || ev.kind === "aux.response") {
      if (ev.api_request_id) responses.set(ev.api_request_id, { ev, attrs });
    }
  }

  const ids = new Set<string>([...requests.keys(), ...responses.keys()]);

  const calls: CallTokens[] = [];

  for (const id of ids) {
    const req = requests.get(id);
    const res = responses.get(id);
    const reqAttrs = req?.attrs ?? {};
    const resAttrs = res?.attrs ?? {};

    const isAux =
      req?.ev.kind === "aux.request" || res?.ev.kind === "aux.response";

    const model =
      str(resAttrs.response_model) ??
      str(reqAttrs.model) ??
      str(resAttrs.model) ??
      "unknown";
    // A fallback answer came from a different model; the request's provider is not its provider.
    const fellBack =
      !!str(resAttrs.response_model) && !!str(reqAttrs.model) && str(resAttrs.response_model) !== str(reqAttrs.model);
    const provider = fellBack ? null : (str(reqAttrs.provider) ?? str(resAttrs.provider) ?? null);

    const usage =
      resAttrs.usage && typeof resAttrs.usage === "object"
        ? (resAttrs.usage as Attrs)
        : null;

    const { cached, fresh, cacheWrite, output, reasoning } =
      deriveTokens(usage);

    const seconds = num(resAttrs.duration_s);
    const ttfb = num(resAttrs.ttfb_s);

    let outPerSec: number | null = null;
    if (
      seconds !== null &&
      ttfb !== null &&
      seconds > 0 &&
      ttfb > 0 &&
      output > 0
    ) {
      const gen = seconds - ttfb;
      if (gen > 0) outPerSec = output / gen;
    }

    let inPerSec: number | null = null;
    if (ttfb !== null && ttfb > 0) {
      const inputTotal = cached + fresh;
      if (inputTotal > 0) {
        inPerSec = inputTotal / ttfb;
      }
    }

    // Determine role.
    let role: CallTokens["role"] = "main";
    let task: string | null = null;
    if (isAux) {
      role = "background";
      task = str(reqAttrs.aux_task) ?? str(resAttrs.aux_task) ?? null;
    } else {
      const ev = req?.ev ?? res?.ev;
      if (ev) {
        const sid = ev.session_id;
        const pid = ev.parent_session_id;
        if (sid !== rootSessionId && pid) {
          role = "helper";
        }
      }
    }

    const start =
      num(resAttrs.started_at) ??
      num(reqAttrs.started_at) ??
      req?.ev.ts ??
      res?.ev.ts ??
      0;

    const eventId = res?.ev.event_id ?? req?.ev.event_id ?? id;

    calls.push({
      id,
      start,
      model,
      provider,
      role,
      task,
      cached,
      fresh,
      cacheWrite,
      output,
      reasoning,
      prompt: cached + fresh,
      seconds,
      ttfb,
      outPerSec,
      inPerSec,
      eventId,
    });
  }

  calls.sort((a, b) => a.start - b.start);

  // Totals.
  let cached = 0;
  let fresh = 0;
  let cacheWrite = 0;
  let output = 0;
  let reasoning = 0;
  for (const c of calls) {
    cached += c.cached;
    fresh += c.fresh;
    cacheWrite += c.cacheWrite;
    output += c.output;
    reasoning += c.reasoning;
  }
  const cacheShare =
    cached + fresh > 0 ? cached / (cached + fresh) : null;

  // By model.
  const modelMap = new Map<
    string,
    {
      provider: string | null;
      calls: number;
      cached: number;
      fresh: number;
      output: number;
      outPerSec: number[];
      ttfb: number[];
      inPerSec: number[];
    }
  >();
  for (const c of calls) {
    const key = c.model;
    let entry = modelMap.get(key);
    if (!entry) {
      entry = {
        provider: c.provider,
        calls: 0,
        cached: 0,
        fresh: 0,
        output: 0,
        outPerSec: [],
        ttfb: [],
        inPerSec: [],
      };
      modelMap.set(key, entry);
    }
    entry.calls += 1;
    entry.cached += c.cached;
    entry.fresh += c.fresh;
    entry.output += c.output;
    if (c.outPerSec !== null) entry.outPerSec.push(c.outPerSec);
    if (c.ttfb !== null) entry.ttfb.push(c.ttfb);
    if (c.inPerSec !== null) entry.inPerSec.push(c.inPerSec);
  }

  const byModel: ModelTotals[] = [];
  for (const [model, e] of modelMap) {
    byModel.push({
      model,
      provider: e.provider,
      calls: e.calls,
      cached: e.cached,
      fresh: e.fresh,
      output: e.output,
      medianOutPerSec: median(e.outPerSec),
      medianTtfb: median(e.ttfb),
      medianInPerSec: median(e.inPerSec),
    });
  }
  byModel.sort((a, b) => b.calls - a.calls);

  // Notes.
  const notes: string[] = [];

  if (cacheShare !== null) {
    notes.push(
      `${fmtPct(cacheShare)} of the input was reused from the provider's cache, so it did not need to be processed again.`
    );
  }

  let lastCall: CallTokens | null = null;
  for (const c of calls) {
    if (c.role === "main") lastCall = c;
  }
  if (lastCall) {
    const lastInput = lastCall.cached + lastCall.fresh;
    if (lastInput > 0) {
      notes.push(
        `Each new message re-sends the whole chat; the last call sent ${fmtInt(
          lastInput
        )} input tokens.`
      );
    }
  }

  // Pick a model with a meaningful median output rate.
  let rateModel: ModelTotals | null = null;
  for (const m of byModel) {
    if (m.medianOutPerSec !== null && m.calls >= 1) {
      if (
        rateModel === null ||
        (m.medianOutPerSec ?? 0) > (rateModel.medianOutPerSec ?? 0)
      ) {
        rateModel = m;
      }
    }
  }
  if (rateModel && rateModel.medianOutPerSec !== null) {
    notes.push(
      `${rateModel.model} wrote about ${fmtRate(
        rateModel.medianOutPerSec
      )} tokens per second (median).`
    );
  }

  const auxTasks = new Set<string>();
  let auxCalls = 0;
  for (const c of calls) {
    if (c.role === "background") {
      auxCalls += 1;
      if (c.task) auxTasks.add(c.task);
    }
  }
  if (auxCalls > 0) {
    const taskList = [...auxTasks].join(", ");
    notes.push(
      `Background tasks (${taskList}) made ${fmtInt(auxCalls)} model calls.`
    );
  }

  return {
    calls,
    byModel,
    totals: { cached, fresh, cacheWrite, output, reasoning, cacheShare },
    notes: notes.slice(0, 4),
    promptSeries: calls
      .filter((c) => c.role !== "background" && c.prompt > 0)
      .map((c) => ({ at: c.start, prompt: c.prompt, eventId: c.eventId })),
    compactions: detectCompactions(calls),
    activity: buildChatActivity(events),
  };
}
