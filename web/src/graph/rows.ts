import type { OmniEvent } from "../types";
import { formatDuration } from "./format";

export interface StepRow {
  id: string;
  kind: "llm" | "tool" | "helper" | "background" | "error" | "gap";
  label: string;
  detail: string;
  start: number;
  seconds: number | null;
  status: "ok" | "error" | "running" | "warn";
  badges: string[];
  eventIds: string[];
  repeat: number;
  /** Set on a folded "model call → tool" loop row: what it stands for. */
  counts?: { llm: number; tools: number; failed: number };
}

export interface TurnRow {
  id: string;
  index: number;
  label: string;
  start: number;
  seconds: number | null;
  status: "ok" | "error" | "running" | "warn";
  summary: string;
  badges: string[];
  steps: StepRow[];
  eventIds: string[];
}

export interface RowFilter {
  hideTools: boolean;
  hideLlms: boolean;
  errorsOnly: boolean;
}

type Usage = {
  prompt_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
};

type ParsedAttrs = Record<string, unknown>;

function parseAttrs(attrs: OmniEvent["attrs"]): ParsedAttrs {
  if (!attrs) return {};
  if (typeof attrs === "string") {
    try {
      const parsed = JSON.parse(attrs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ParsedAttrs;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof attrs === "object" && !Array.isArray(attrs)) {
    return attrs as ParsedAttrs;
  }
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

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtSeconds(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return "";
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m} min ${rem} s`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function sortEvents(events: OmniEvent[]): OmniEvent[] {
  return [...events].sort((a, b) => a.ts - b.ts || a.rowid - b.rowid);
}

function pickRootSession(events: OmniEvent[]): string | null {
  const starts = events.filter((e) => e.kind === "session.start");
  for (const s of starts) {
    if (s.session_id && !s.parent_session_id) return s.session_id;
  }
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.session_id) counts.set(e.session_id, (counts.get(e.session_id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [sid, c] of counts) {
    if (c > bestCount) {
      best = sid;
      bestCount = c;
    }
  }
  return best;
}

function buildUsageDetail(usage: Usage | null, ttfb: number | null): string {
  const parts: string[] = [];
  if (usage) {
    if (typeof usage.prompt_tokens === "number") parts.push(`${fmtInt(usage.prompt_tokens)} in`);
    if (typeof usage.output_tokens === "number") parts.push(`${fmtInt(usage.output_tokens)} out`);
  }
  if (ttfb != null) parts.push(`ttfb ${ttfb.toFixed(1)} s`);
  return parts.join(" · ");
}

function buildLlmStep(
  req: OmniEvent | null,
  resp: OmniEvent | null,
  errs: OmniEvent[],
  id: string
): StepRow {
  const reqAttrs = req ? parseAttrs(req.attrs) : {};
  const respAttrs = resp ? parseAttrs(resp.attrs) : {};
  const model = str(respAttrs.response_model) ?? str(reqAttrs.model) ?? "model";
  const requested = str(reqAttrs.model);
  const fallback = resp && requested && model !== requested;

  const usage = (respAttrs.usage as Usage | undefined) ?? null;
  const ttfb = num(respAttrs.ttfb_s);
  const detail = buildUsageDetail(usage, ttfb);

  const badges: string[] = [];
  if (fallback) badges.push(`fallback from ${requested}`);

  let rateLimited = 0;
  let status: StepRow["status"] = "ok";
  const eventIds: string[] = [];
  if (req) eventIds.push(req.event_id);
  if (resp) eventIds.push(resp.event_id);
  for (const e of errs) {
    eventIds.push(e.event_id);
    const ea = parseAttrs(e.attrs);
    const reason = str(ea.reason);
    const code = num(ea.status_code);
    if (reason === "rate_limit") {
      rateLimited += 1;
      status = "warn";
    } else {
      status = "error";
    }
    if (code != null) badges.push(String(code));
  }
  if (rateLimited > 0) badges.push(`rate-limited ×${rateLimited}`);

  const retry = num(reqAttrs.retry_count);
  if (retry != null && retry > 0) badges.push(`retry ×${retry}`);

  if (resp) {
    const fr = str(respAttrs.finish_reason);
    // "stop" and "tool_calls" are the normal endings; only unusual ones (e.g. "length") are worth a badge.
    if (fr && fr !== "stop" && fr !== "tool_calls") badges.push(fr);
  }

  if (ttfb != null && ttfb > 30 && status === "ok") status = "warn";

  const start = req?.ts ?? resp?.ts ?? (errs[0]?.ts ?? 0);
  const seconds =
    num(respAttrs.duration_s) ??
    (resp && req ? Math.max(0, resp.ts - req.ts) : null) ??
    (errs.length ? num(parseAttrs(errs[errs.length - 1].attrs).duration_s) : null);

  return {
    id,
    kind: "llm",
    label: model,
    detail,
    start,
    seconds,
    status,
    badges,
    eventIds,
    repeat: 1,
  };
}

function buildToolStep(ev: OmniEvent, id: string): StepRow {
  const a = parseAttrs(ev.attrs);
  const tool = str(a.tool_name) ?? "tool";
  const durMs = num(a.duration_ms);
  const detail = durMs != null ? formatDuration(durMs / 1000) : "";
  const errType = str(a.error_type);
  const status: StepRow["status"] =
    ev.status === "error" || errType ? "error" : "ok";
  const badges: string[] = [];
  if (errType) badges.push(errType);
  return {
    id,
    kind: "tool",
    label: tool,
    detail,
    start: ev.ts,
    seconds: durMs != null ? durMs / 1000 : null,
    status,
    badges,
    eventIds: [ev.event_id],
    repeat: 1,
  };
}

function buildErrorStep(ev: OmniEvent, id: string): StepRow {
  const a = parseAttrs(ev.attrs);
  const reason = str(a.reason) ?? str(a.error_type) ?? "error";
  const code = num(a.status_code);
  const badges: string[] = [];
  if (code != null) badges.push(String(code));
  const status: StepRow["status"] = reason === "rate_limit" ? "warn" : "error";
  return {
    id,
    kind: "error",
    label: reason,
    detail: "",
    start: ev.ts,
    seconds: num(a.duration_s),
    status,
    badges,
    eventIds: [ev.event_id],
    repeat: 1,
  };
}

function buildBackgroundStep(
  req: OmniEvent | null,
  resp: OmniEvent | null,
  id: string
): StepRow {
  const reqAttrs = req ? parseAttrs(req.attrs) : {};
  const respAttrs = resp ? parseAttrs(resp.attrs) : {};
  const auxTask = str(reqAttrs.aux_task) ?? str(respAttrs.aux_task) ?? "unknown";
  const model = str(respAttrs.response_model) ?? str(reqAttrs.model) ?? "model";
  const duration = num(respAttrs.duration_s);
  const detail = `${model} · ${fmtSeconds(duration)}`;
  const status: StepRow["status"] =
    resp?.status === "error" || str(respAttrs.error_type) ? "error" : "ok";
  const badges: string[] = [];
  const errType = str(respAttrs.error_type);
  if (errType) badges.push(errType);
  const start = req?.ts ?? resp?.ts ?? 0;
  const eventIds: string[] = [];
  if (req) eventIds.push(req.event_id);
  if (resp) eventIds.push(resp.event_id);
  return {
    id,
    kind: "background",
    label: `background: ${auxTask}`,
    detail,
    start,
    seconds: duration,
    status,
    badges,
    eventIds,
    repeat: 1,
  };
}

function buildSkillStep(ev: OmniEvent, id: string): StepRow {
  const a = parseAttrs(ev.attrs);
  const action = str(a.action) ?? "unknown";
  const skillName = str(a.skill_name) ?? "unknown";
  return {
    id,
    kind: "background",
    label: `skill: ${skillName} (${action})`,
    detail: "",
    start: ev.ts,
    seconds: null,
    status: "ok",
    badges: [],
    eventIds: [ev.event_id],
    repeat: 1,
  };
}

function mergeConsecutiveTools(steps: StepRow[]): StepRow[] {
  const out: StepRow[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "tool" &&
      s.kind === "tool" &&
      prev.label.replace(/ ×\d+$/, "") === s.label &&
      prev.status === s.status
    ) {
      const total =
        (prev.seconds ?? 0) + (s.seconds ?? 0);
      prev.repeat += 1;
      prev.seconds = total > 0 ? total : prev.seconds;
      if (prev.seconds != null) prev.detail = `${formatDuration(prev.seconds)} total`;
      prev.label = `${s.label} ×${prev.repeat}`;
      prev.eventIds = prev.eventIds.concat(s.eventIds);
      const mergedBadges = new Set([...prev.badges, ...s.badges]);
      prev.badges = Array.from(mergedBadges);
    } else {
      out.push({ ...s, eventIds: [...s.eventIds], badges: [...s.badges] });
    }
  }
  return out;
}

function summarize(steps: StepRow[], seconds: number | null): string {
  let modelCalls = 0;
  let tools = 0;
  let failed = 0;
  let background = 0;
  for (const s of steps) {
    if (s.counts) {
      modelCalls += s.counts.llm;
      tools += s.counts.tools;
      failed += s.counts.failed;
    } else if (s.kind === "llm") {
      modelCalls += 1;
    } else if (s.kind === "tool") {
      tools += s.repeat;
    } else if (s.kind === "background") {
      background += 1;
    }
    if (!s.counts && s.status === "error") failed += s.kind === "tool" ? s.repeat : 1;
  }
  const parts: string[] = [];
  if (modelCalls) parts.push(`${modelCalls} model call${modelCalls === 1 ? "" : "s"}`);
  if (tools) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (background) parts.push(`${background} background`);
  if (failed) parts.push(`${failed} failed`);
  const dur = fmtSeconds(seconds);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

function turnStatus(steps: StepRow[]): TurnRow["status"] {
  let hasError = false;
  let hasWarn = false;
  for (const s of steps) {
    if (s.status === "error") hasError = true;
    if (s.status === "warn") hasWarn = true;
  }
  if (hasError) return "error";
  if (hasWarn) return "warn";
  return "ok";
}

const SESSION_LIFECYCLE_KINDS = new Set(["session.start", "session.end"]);

function isStepEvent(e: OmniEvent): boolean {
  return !SESSION_LIFECYCLE_KINDS.has(e.kind);
}

export function buildRows(events: OmniEvent[], nowTs: number): TurnRow[] {
  const sorted = sortEvents(events);
  const root = pickRootSession(sorted);
  if (!root) return [];

  const rootEvents = sorted.filter((e) => e.session_id === root);

  // Helper sessions: group subagent.start/stop by child session_id.
  const helpers = new Map<
    string,
    { start: OmniEvent; stop: OmniEvent | null }
  >();
  for (const e of sorted) {
    if (e.kind === "subagent.start" && e.session_id) {
      helpers.set(e.session_id, { start: e, stop: null });
    } else if (e.kind === "subagent.stop" && e.session_id) {
      const h = helpers.get(e.session_id);
      if (h) h.stop = e;
      else helpers.set(e.session_id, { start: e, stop: e });
    }
  }

  // Build turn boundaries from turn.start / turn.end.
  type Turn = {
    start: number;
    end: number | null;
    events: OmniEvent[];
    helpers: { start: number; stop: number | null; ev: OmniEvent }[];
  };
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const preTurn: OmniEvent[] = [];

  for (const e of rootEvents) {
    if (e.kind === "turn.start") {
      current = { start: e.ts, end: null, events: [e], helpers: [] };
      turns.push(current);
    } else if (e.kind === "turn.end") {
      if (current) {
        current.end = e.ts;
        current.events.push(e);
      } else {
        if (isStepEvent(e)) preTurn.push(e);
      }
    } else if (current) {
      current.events.push(e);
    } else {
      if (isStepEvent(e)) preTurn.push(e);
    }
  }

  // Place helpers into the turn active at subagent.start (by parent_session_id === root).
  for (const [, h] of helpers) {
    if (h.start.parent_session_id !== root) continue;
    const t = h.start.ts;
    let target: Turn | null = null;
    for (const turn of turns) {
      const end = turn.end ?? Infinity;
      if (t >= turn.start && t <= end) {
        target = turn;
        break;
      }
    }
    if (!target) {
      if (turns.length === 0) {
        preTurn.push(h.start);
        if (h.stop) preTurn.push(h.stop);
        continue;
      }
      const last = turns[turns.length - 1];
      if (t >= last.start) target = last;
      else target = turns[0];
    }
    target.helpers.push({
      start: h.start.ts,
      stop: h.stop ? h.stop.ts : null,
      ev: h.start,
    });
  }

  const buildStepsForEvents = (
    evs: OmniEvent[],
    helperList: { start: number; stop: number | null; ev: OmniEvent }[],
    idPrefix: string
  ): StepRow[] => {
    const steps: StepRow[] = [];

    // Group llm.request by api_request_id
    const reqMap = new Map<string, OmniEvent>();
    const respMap = new Map<string, OmniEvent>();
    const errMap = new Map<string, OmniEvent[]>();
    const toolEvents: OmniEvent[] = [];
    const auxReqMap = new Map<string, OmniEvent>();
    const auxRespMap = new Map<string, OmniEvent>();
    const skillEvents: OmniEvent[] = [];

    for (const e of evs) {
      if (e.kind === "llm.request") {
        const key = e.api_request_id ?? e.event_id;
        reqMap.set(key, e);
      } else if (e.kind === "llm.response") {
        const key = e.api_request_id ?? e.event_id;
        respMap.set(key, e);
      } else if (e.kind === "llm.error") {
        const key = e.api_request_id ?? e.event_id;
        const arr = errMap.get(key) ?? [];
        arr.push(e);
        errMap.set(key, arr);
      } else if (e.kind === "tool.end") {
        toolEvents.push(e);
      } else if (e.kind === "aux.request") {
        const key = e.api_request_id ?? e.event_id;
        auxReqMap.set(key, e);
      } else if (e.kind === "aux.response") {
        const key = e.api_request_id ?? e.event_id;
        auxRespMap.set(key, e);
      } else if (e.kind === "skill.event") {
        skillEvents.push(e);
      }
    }

    // Collect all api_request_ids present
    const keys = new Set<string>([
      ...reqMap.keys(),
      ...respMap.keys(),
      ...errMap.keys(),
    ]);

    // Build a combined timeline of step "anchors" so ordering is by start time.
    type Anchor = { ts: number; order: number; build: () => StepRow };
    const anchors: Anchor[] = [];
    let order = 0;

    for (const key of keys) {
      const req = reqMap.get(key) ?? null;
      const resp = respMap.get(key) ?? null;
      const errs = errMap.get(key) ?? [];
      const hasResp = !!resp;
      const hasReq = !!req;
      // If there are errors but no response and no request => orphan error step.
      if (!hasResp && !hasReq && errs.length) {
        for (const e of errs) {
          const ev = e;
          anchors.push({
            ts: ev.ts,
            order: order++,
            build: () => buildErrorStep(ev, `${idPrefix}:err:${ev.event_id}`),
          });
        }
        continue;
      }
      const startTs = req?.ts ?? resp?.ts ?? errs[0]?.ts ?? 0;
      anchors.push({
        ts: startTs,
        order: order++,
        build: () =>
          buildLlmStep(req, resp, errs, `${idPrefix}:llm:${key}`),
      });
    }

    for (const e of toolEvents) {
      anchors.push({
        ts: e.ts,
        order: order++,
        build: () => buildToolStep(e, `${idPrefix}:tool:${e.event_id}`),
      });
    }

    // Aux/background steps
    const auxKeys = new Set<string>([
      ...auxReqMap.keys(),
      ...auxRespMap.keys(),
    ]);
    for (const key of auxKeys) {
      const req = auxReqMap.get(key) ?? null;
      const resp = auxRespMap.get(key) ?? null;
      const startTs = req?.ts ?? resp?.ts ?? 0;
      anchors.push({
        ts: startTs,
        order: order++,
        build: () =>
          buildBackgroundStep(req, resp, `${idPrefix}:bg:${key}`),
      });
    }

    for (const e of skillEvents) {
      anchors.push({
        ts: e.ts,
        order: order++,
        build: () => buildSkillStep(e, `${idPrefix}:skill:${e.event_id}`),
      });
    }

    for (const h of helperList) {
      anchors.push({
        ts: h.start,
        order: order++,
        build: () => {
          const seconds = h.stop != null ? h.stop - h.start : null;
          return {
            id: `${idPrefix}:helper:${h.ev.event_id}`,
            kind: "helper",
            label: "helper",
            detail: "",
            start: h.start,
            seconds,
            status: "ok",
            badges: [],
            eventIds: [h.ev.event_id],
            repeat: 1,
          };
        },
      });
    }

    anchors.sort((a, b) => a.ts - b.ts || a.order - b.order);
    for (const a of anchors) steps.push(a.build());

    return foldRounds(mergeConsecutiveTools(steps));
  };

  const result: TurnRow[] = [];

  // Pre-turn steps — only create if there are actual step events
  if (preTurn.length) {
    const steps = buildStepsForEvents(preTurn, [], "pre");
    if (steps.length > 0) {
      const start = preTurn[0]?.ts ?? 0;
      const lastTs = preTurn[preTurn.length - 1]?.ts ?? start;
      const seconds = lastTs - start;
      const status = turnStatus(steps);
      result.push({
        id: "turn:pre",
        index: 0,
        label: "Before the first message",
        start,
        seconds,
        status,
        summary: summarize(steps, seconds),
        badges: [],
        steps,
        eventIds: preTurn.map((e) => e.event_id),
      });
    }
  }

  turns.forEach((turn, i) => {
    const steps = buildStepsForEvents(turn.events, turn.helpers, `t${i}`);
    const start = turn.start;
    const end = turn.end;
    let seconds: number | null = null;
    let status = turnStatus(steps);

    if (end != null) {
      seconds = end - start;
    } else {
      // running if last event < 300s ago
      const lastEventTs = turn.events.length
        ? turn.events[turn.events.length - 1].ts
        : start;
      if (nowTs - lastEventTs < 300) {
        status = "running";
        seconds = null;
      } else {
        seconds = lastEventTs - start;
      }
    }

    const badges: string[] = [];
    const anyFallback = steps.some((s) =>
      s.badges.some((b) => b.startsWith("fallback"))
    );
    const anyRate = steps.some((s) =>
      s.badges.some((b) => b.startsWith("rate-limited"))
    );
    if (anyFallback) badges.push("fallback");
    if (anyRate) badges.push("rate-limited");

    result.push({
      id: `turn:${i}`,
      index: i,
      label: `Message ${i + 1} · ${fmtClock(start)}`,
      start,
      seconds,
      status,
      summary: summarize(steps, seconds),
      badges,
      steps,
      eventIds: turn.events.map((e) => e.event_id),
    });
  });

  return result;
}

export function applyFilter(rows: TurnRow[], f: RowFilter): TurnRow[] {
  return rows.map((turn) => {
    let steps = turn.steps;
    let summary = turn.summary;

    if (f.errorsOnly) {
      const kept = steps.filter(
        (s) => s.status === "error" || s.status === "warn"
      );
      if (kept.length === 0) {
        return {
          ...turn,
          steps: [],
          summary: "no problems",
        };
      }
      steps = kept;
      summary = summarize(kept, turn.seconds);
      return { ...turn, steps, summary };
    }

    let hiddenTools = 0;
    let hiddenLlms = 0;
    const kept: StepRow[] = [];
    for (const s of steps) {
      if (f.hideTools && s.kind === "tool") {
        hiddenTools += s.repeat;
        continue;
      }
      if (f.hideLlms && s.kind === "llm") {
        hiddenLlms += 1;
        continue;
      }
      kept.push(s);
    }

    const gapSteps: StepRow[] = [];
    if (hiddenTools > 0) {
      gapSteps.push({
        id: `${turn.id}:gap:tools`,
        kind: "gap",
        label: `+${hiddenTools} tools hidden`,
        detail: "",
        start: turn.start,
        seconds: null,
        status: "ok",
        badges: [],
        eventIds: [],
        repeat: hiddenTools,
      });
    }
    if (hiddenLlms > 0) {
      gapSteps.push({
        id: `${turn.id}:gap:llms`,
        kind: "gap",
        label: `+${hiddenLlms} model calls hidden`,
        detail: "",
        start: turn.start,
        seconds: null,
        status: "ok",
        badges: [],
        eventIds: [],
        repeat: hiddenLlms,
      });
    }

    const finalSteps = kept.concat(gapSteps);
    return { ...turn, steps: finalSteps, summary };
  });
}

/** Fewest repeats before model-call → tool rounds are folded into one row. */
const MIN_ROUNDS = 3;

/**
 * Agents often loop "ask the model → run a tool → ask again". Each round alternates kinds, so
 * same-tool merging never fires; fold a run of rounds that use the same tool into one row.
 */
function foldRounds(steps: StepRow[]): StepRow[] {
  const toolOf = (s: StepRow) => s.label.replace(/ ×\d+$/, "");
  const out: StepRow[] = [];
  let i = 0;
  while (i < steps.length) {
    const a = steps[i];
    const b = steps[i + 1];
    if (a && b && a.kind === "llm" && b.kind === "tool") {
      const tool = toolOf(b);
      let j = i;
      while (j + 1 < steps.length && steps[j].kind === "llm" && steps[j + 1].kind === "tool" && toolOf(steps[j + 1]) === tool) {
        j += 2;
      }
      const rounds = (j - i) / 2;
      if (rounds >= MIN_ROUNDS) {
        const group = steps.slice(i, j);
        const llms = group.filter((s) => s.kind === "llm");
        const tools = group.filter((s) => s.kind === "tool");
        const toolRuns = tools.reduce((n, s) => n + s.repeat, 0);
        const failed = tools.filter((s) => s.status === "error").reduce((n, s) => n + s.repeat, 0);
        const seconds = group.reduce((n, s) => n + (s.seconds ?? 0), 0);
        const status: StepRow["status"] = group.some((s) => s.status === "error")
          ? "error"
          : group.some((s) => s.status === "running")
            ? "running"
            : group.some((s) => s.status === "warn")
              ? "warn"
              : "ok";
        const models = [...new Set(llms.map((s) => s.label))];
        out.push({
          id: `${a.id}:rounds`,
          kind: "tool",
          label: `${models.length === 1 ? models[0] : "model"} → ${tool} ×${rounds}`,
          detail: `${llms.length} model calls · ${toolRuns} ${tool} runs${failed ? ` · ${failed} failed` : ""}${seconds > 0 ? ` · ${formatDuration(seconds)}` : ""}`,
          start: a.start,
          seconds: seconds > 0 ? seconds : null,
          status,
          badges: [...new Set(group.flatMap((s) => s.badges))],
          eventIds: group.flatMap((s) => s.eventIds),
          repeat: rounds,
          counts: { llm: llms.length, tools: toolRuns, failed: failed + llms.filter((s) => s.status === "error").length },
        });
        i = j;
        continue;
      }
    }
    out.push(a);
    i += 1;
  }
  return out;
}
