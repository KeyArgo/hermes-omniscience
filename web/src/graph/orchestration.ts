import type { OmniEvent } from "../types";

export interface HelperRow {
  sessionId: string;
  parentTurnIndex: number | null;
  role: string | null;
  start: number;
  end: number | null;
  status: string;
  modelCalls: number;
  tools: number;
  failed: number;
  models: string[];
  tokensIn: number;
  tokensOut: number;
  startEventId: string;
  children: HelperRow[];
}

interface Draft {
  row: HelperRow;
  parentSessionId: string | null;
  turnId: string | null;
  stopSeen: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON; ignore */
    }
  }
  return {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

// Provider-aware input token calculation, matching the token report.
function inputTokens(usage: Record<string, unknown>): number {
  const prompt = usage.prompt_tokens;
  if (typeof prompt === "number" && Number.isFinite(prompt)) return prompt;
  const input = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_tokens);
  return input + cacheRead;
}

export function buildHelpers(
  events: OmniEvent[],
  rootSessionId: string | null,
  nowTs: number,
): { helpers: HelperRow[]; maxParallel: number; notes: string[] } {
  const notes: string[] = [];
  const bySession = new Map<string, Draft>();

  const starts: OmniEvent[] = [];
  const stops = new Map<string, OmniEvent[]>();

  for (const ev of events) {
    if (ev.kind === "subagent.start") {
      starts.push(ev);
    } else if (ev.kind === "subagent.stop") {
      const attrs = asRecord(ev.attrs);
      const child = str(attrs.child_session_id);
      if (child) {
        const list = stops.get(child);
        if (list) list.push(ev);
        else stops.set(child, [ev]);
      }
    }
  }

  // Create a draft row per subagent.start, in event order.
  for (const start of starts) {
    const attrs = asRecord(start.attrs);
    const child = str(attrs.child_session_id) ?? `unknown-${start.event_id}`;
    const existing = bySession.get(child);
    if (existing) continue;
    const row: HelperRow = {
      sessionId: child,
      parentTurnIndex: null,
      role: str(attrs.role),
      start: typeof start.ts === "number" ? start.ts : nowTs,
      end: null,
      status: "running",
      modelCalls: 0,
      tools: 0,
      failed: 0,
      models: [],
      tokensIn: 0,
      tokensOut: 0,
      startEventId: start.event_id,
      children: [],
    };
    bySession.set(child, {
      row,
      parentSessionId: start.session_id,
      turnId: start.turn_id,
      stopSeen: false,
    });
  }

  // Fold helper activity (llm / tool events whose session belongs to a helper).
  for (const ev of events) {
    if (ev.kind !== "llm.request" && ev.kind !== "llm.response" && ev.kind !== "llm.error" && ev.kind !== "tool.end") {
      continue;
    }
    const sid = ev.session_id;
    if (!sid || sid === rootSessionId) continue;
    const draft = bySession.get(sid);
    if (!draft) continue;
    if (ev.kind === "llm.request") {
      draft.row.modelCalls += 1;
      const model = str(asRecord(ev.attrs).model);
      if (model) pushUnique(draft.row.models, model);
    } else if (ev.kind === "llm.response") {
      const attrs = asRecord(ev.attrs);
      const usage = asRecord(attrs.usage);
      draft.row.tokensIn += inputTokens(usage);
      draft.row.tokensOut += num(usage.output_tokens);
      const model = str(attrs.response_model);
      if (model) pushUnique(draft.row.models, model);
    } else if (ev.kind === "llm.error") {
      draft.row.failed += 1;
    } else {
      // tool.end
      draft.row.tools += 1;
      if (ev.status === "error") draft.row.failed += 1;
    }
    if (typeof ev.ts === "number" && ev.ts > draft.row.start) {
      // keep start as the subagent.start ts; activity only extends end below
    }
  }

  // Apply stops and derive end/status; also capture activity-based end fallback.
  const activityEnd = new Map<string, number>();
  for (const ev of events) {
    const sid = ev.session_id;
    if (!sid) continue;
    const draft = bySession.get(sid);
    if (!draft) continue;
    if (
      ev.kind === "llm.response" ||
      ev.kind === "llm.error" ||
      ev.kind === "tool.end" ||
      ev.kind === "turn.end" ||
      ev.kind === "session.end"
    ) {
      if (typeof ev.ts === "number") {
        const prev = activityEnd.get(sid);
        if (prev === undefined || ev.ts > prev) activityEnd.set(sid, ev.ts);
      }
    }
  }

  for (const [sid, stopList] of stops) {
    const draft = bySession.get(sid);
    if (!draft) continue;
    const stop = stopList[0];
    draft.row.end = typeof stop.ts === "number" ? stop.ts : null;
    const attrs = asRecord(stop.attrs);
    const childStatus = str(attrs.child_status) ?? str(attrs.status);
    draft.row.status = childStatus ?? "ended";
    draft.stopSeen = true;
  }

  for (const draft of bySession.values()) {
    if (draft.row.end === null) {
      const act = activityEnd.get(draft.row.sessionId);
      if (act !== undefined) {
        draft.row.end = act;
        if (!draft.stopSeen) draft.row.status = "ended";
      } else {
        draft.row.end = null;
        draft.row.status = draft.stopSeen ? draft.row.status : "running";
      }
    }
    if (draft.row.end !== null && draft.row.end < draft.row.start) {
      draft.row.end = draft.row.start;
    }
  }

  // Resolve parent turn index via turn.start ordering in the parent session.
  const turnIndex = new Map<string, number>();
  let counter = 0;
  for (const ev of events) {
    if (ev.kind === "turn.start") {
      const key = `${ev.session_id ?? "?"}#${ev.turn_id ?? "?"}`;
      if (!turnIndex.has(key)) {
        turnIndex.set(key, counter);
        counter += 1;
      }
    }
  }
  for (const draft of bySession.values()) {
    if (draft.turnId) {
      const idx = turnIndex.get(`${draft.parentSessionId ?? "?"}#${draft.turnId}`);
      draft.row.parentTurnIndex = idx ?? null;
    }
  }

  // Nest: a helper whose parent session is another helper becomes its child.
  const roots: HelperRow[] = [];
  const ordered = [...bySession.values()].sort((a, b) => a.row.start - b.row.start);
  const placed = new Set<string>();
  for (const draft of ordered) {
    const parentSid = draft.parentSessionId;
    if (parentSid && bySession.has(parentSid)) {
      const parentDraft = bySession.get(parentSid);
      if (parentDraft && parentDraft.row.sessionId !== draft.row.sessionId) {
        parentDraft.row.children.push(draft.row);
        placed.add(draft.row.sessionId);
      }
    }
  }
  for (const draft of ordered) {
    if (!placed.has(draft.row.sessionId)) roots.push(draft.row);
  }

  // maxParallel: sweep over start/end intervals of all helpers (incl. nested).
  const all: HelperRow[] = [];
  const walk = (rows: HelperRow[]) => {
    for (const r of rows) {
      all.push(r);
      walk(r.children);
    }
  };
  walk(roots);
  let maxParallel = 0;
  if (all.length > 0) {
    const points: Array<{ t: number; d: number }> = [];
    for (const r of all) {
      points.push({ t: r.start, d: 1 });
      if (r.end !== null) points.push({ t: r.end, d: -1 });
    }
    points.sort((a, b) => a.t - b.t || b.d - a.d);
    let cur = 0;
    for (const p of points) {
      cur += p.d;
      if (cur > maxParallel) maxParallel = cur;
    }
  }

  // Notes (neutral, measured facts only).
    if (all.length > 0) {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    notes.push(
      `${all.length} helper${all.length === 1 ? "" : "s"} ran, up to ${maxParallel} at the same time.`,
    );
    const failedRows = all.filter((r) => r.failed > 0);
    if (failedRows.length > 0) {
      notes.push(
        `${plural(failedRows.length, "helper")} had at least one failed step.`,
      );
    }
    const runningRows = all.filter((r) => r.end === null);
    if (runningRows.length > 0) {
      notes.push(`${plural(runningRows.length, "helper")} ${runningRows.length === 1 ? "is" : "are"} still running.`);
    }
    const models: string[] = [];
    for (const r of all) for (const m of r.models) pushUnique(models, m);
    if (models.length > 1) {
      notes.push(`Helpers used ${models.join(" and ")}.`);
    } else if (models.length === 1) {
      notes.push(`Helpers used ${models[0]}.`);
    }
  }

  return { helpers: roots, maxParallel, notes };
}
