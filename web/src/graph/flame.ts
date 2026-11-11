import type { OmniEvent } from "../types";

export interface FlameBlock {
  id: string;
  depth: number;
  start: number;
  end: number;
  label: string;
  kind: "chat" | "turn" | "model" | "tool" | "background" | "helper";
  status: "ok" | "error" | "running";
  eventIds: string[];
}

export interface FlameResult {
  start: number;
  end: number;
  blocks: FlameBlock[];
}

interface Attrs {
  [k: string]: unknown;
}

function parseAttrs(a: OmniEvent["attrs"]): Attrs {
  if (a == null) return {};
  if (typeof a === "string") {
    try {
      const v = JSON.parse(a);
      return v && typeof v === "object" ? (v as Attrs) : {};
    } catch {
      return {};
    }
  }
  return a;
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
  return typeof v === "string" ? v : null;
}

function tsToMs(ts: number): number {
  // ts is expected in seconds (epoch). Normalize to ms.
  if (ts > 1e12) return ts; // already ms
  return ts * 1000;
}

interface TurnSpan {
  turnId: string;
  start: number;
  end: number;
  eventIds: string[];
  status: "ok" | "error" | "running";
}

interface ChildSpan {
  sessionId: string;
  start: number;
  end: number;
  eventIds: string[];
  status: "ok" | "error" | "running";
}

export function buildFlame(
  events: OmniEvent[],
  rootSessionId: string | null,
  nowTs: number
): FlameResult {
  const now = tsToMs(nowTs);
  const blocks: FlameBlock[] = [];

  // Sort by ts for deterministic processing.
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  // Determine root session if not provided: session with no parent that has events.
  let root = rootSessionId;
  if (!root) {
    for (const e of sorted) {
      if (e.session_id && !e.parent_session_id) {
        root = e.session_id;
        break;
      }
    }
  }

  // Collect helper (child) sessions.
  const childSessions = new Set<string>();
  for (const e of sorted) {
    if (e.session_id && e.parent_session_id && e.parent_session_id === root) {
      childSessions.add(e.session_id);
    }
  }

  // Turn spans keyed by turn_id.
  const turns = new Map<string, TurnSpan>();
  // Track turn start order for placement.
  const turnOrder: string[] = [];

  // Model/tool/background blocks (depth 2) grouped by turn.
  interface Leaf {
    turnId: string | null;
    start: number;
    end: number;
    label: string;
    kind: "model" | "tool" | "background";
    status: "ok" | "error" | "running";
    eventIds: string[];
  }
  const leaves: Leaf[] = [];

  // Helper spans (depth 3) grouped by session, placed under active turn.
  const helpers: ChildSpan[] = [];

  // Track open requests for pairing.
  const openLlm = new Map<string, { start: number; eventIds: string[]; turnId: string | null }>();
  const openAux = new Map<string, { start: number; eventIds: string[]; turnId: string | null; task: string | null }>();

  // Helper session open tracking.
  const helperOpen = new Map<string, { start: number; eventIds: string[] }>();

  // Chat overall bounds.
  let chatStart = Infinity;
  let chatEnd = -Infinity;
  const chatEventIds: string[] = [];
  let chatError = false;

  for (const e of sorted) {
    const t = tsToMs(e.ts);
    const attrs = parseAttrs(e.attrs);
    const isRoot = e.session_id === root;
    const isChild = e.session_id != null && childSessions.has(e.session_id);

    if (isRoot) {
      if (t < chatStart) chatStart = t;
      if (t > chatEnd) chatEnd = t;
      chatEventIds.push(e.event_id);
    }

    if (isChild) {
      // Helper session events: track start/stop.
      if (e.kind === "subagent.start" || e.kind === "turn.start") {
        if (!helperOpen.has(e.session_id!)) {
          helperOpen.set(e.session_id!, { start: t, eventIds: [e.event_id] });
        } else {
          helperOpen.get(e.session_id!)!.eventIds.push(e.event_id);
        }
      } else if (e.kind === "subagent.stop" || e.kind === "turn.end") {
        const o = helperOpen.get(e.session_id!);
        if (o) {
          o.eventIds.push(e.event_id);
          helpers.push({
            sessionId: e.session_id!,
            start: o.start,
            end: t,
            eventIds: o.eventIds,
            status: e.status === "error" ? "error" : "ok",
          });
          helperOpen.delete(e.session_id!);
        }
      } else {
        const o = helperOpen.get(e.session_id!);
        if (o) o.eventIds.push(e.event_id);
      }
      continue;
    }

    if (!isRoot) continue;

    switch (e.kind) {
      case "turn.start": {
        const tid = e.turn_id ?? `turn-${e.rowid}`;
        if (!turns.has(tid)) {
          turns.set(tid, {
            turnId: tid,
            start: t,
            end: t,
            eventIds: [e.event_id],
            status: "running",
          });
          turnOrder.push(tid);
        } else {
          turns.get(tid)!.eventIds.push(e.event_id);
        }
        break;
      }
      case "turn.end": {
        const tid = e.turn_id ?? `turn-${e.rowid}`;
        const span = turns.get(tid);
        if (span) {
          span.end = t;
          span.eventIds.push(e.event_id);
          span.status = e.status === "error" ? "error" : "ok";
        } else {
          turns.set(tid, {
            turnId: tid,
            start: t,
            end: t,
            eventIds: [e.event_id],
            status: e.status === "error" ? "error" : "ok",
          });
          turnOrder.push(tid);
        }
        break;
      }
      case "llm.request": {
        const rid = e.api_request_id ?? `req-${e.rowid}`;
        openLlm.set(rid, { start: t, eventIds: [e.event_id], turnId: e.turn_id });
        break;
      }
      case "llm.response": {
        const rid = e.api_request_id ?? `req-${e.rowid}`;
        const o = openLlm.get(rid);
        const startedAt = num(attrs.started_at);
        const endedAt = num(attrs.ended_at);
        const durS = num(attrs.duration_s);
        const model = str(attrs.response_model) ?? "model";
        let start = o ? o.start : t;
        let end = t;
        if (startedAt != null) start = tsToMs(startedAt);
        if (endedAt != null) end = tsToMs(endedAt);
        else if (durS != null) end = start + durS * 1000;
        const eventIds = o ? [...o.eventIds, e.event_id] : [e.event_id];
        leaves.push({
          turnId: e.turn_id ?? o?.turnId ?? null,
          start,
          end,
          label: model,
          kind: "model",
          status: e.status === "error" ? "error" : "ok",
          eventIds,
        });
        openLlm.delete(rid);
        break;
      }
      case "llm.error": {
        const rid = e.api_request_id ?? `req-${e.rowid}`;
        const o = openLlm.get(rid);
        const start = o ? o.start : t;
        const eventIds = o ? [...o.eventIds, e.event_id] : [e.event_id];
        leaves.push({
          turnId: e.turn_id ?? o?.turnId ?? null,
          start,
          end: t,
          label: "llm error",
          kind: "model",
          status: "error",
          eventIds,
        });
        openLlm.delete(rid);
        break;
      }
      case "tool.end": {
        const toolName = str(attrs.tool_name) ?? "tool";
        const durMs = num(attrs.duration_ms);
        const startedAt = num(attrs.started_at);
        let start = t;
        let end = t;
        if (startedAt != null) start = tsToMs(startedAt);
        if (durMs != null) end = start + durMs;
        else if (startedAt != null) end = t;
        leaves.push({
          turnId: e.turn_id,
          start,
          end,
          label: toolName,
          kind: "tool",
          status: e.status === "error" ? "error" : "ok",
          eventIds: [e.event_id],
        });
        break;
      }
      case "aux.request": {
        const rid = e.api_request_id ?? `aux-${e.rowid}`;
        openAux.set(rid, {
          start: t,
          eventIds: [e.event_id],
          turnId: e.turn_id,
          task: str(attrs.aux_task),
        });
        break;
      }
      case "aux.response": {
        const rid = e.api_request_id ?? `aux-${e.rowid}`;
        const o = openAux.get(rid);
        const startedAt = num(attrs.started_at);
        const endedAt = num(attrs.ended_at);
        const durS = num(attrs.duration_s);
        const task = str(attrs.aux_task) ?? o?.task ?? "aux";
        let start = o ? o.start : t;
        let end = t;
        if (startedAt != null) start = tsToMs(startedAt);
        if (endedAt != null) end = tsToMs(endedAt);
        else if (durS != null) end = start + durS * 1000;
        const eventIds = o ? [...o.eventIds, e.event_id] : [e.event_id];
        leaves.push({
          turnId: e.turn_id ?? o?.turnId ?? null,
          start,
          end,
          label: task,
          kind: "background",
          status: e.status === "error" ? "error" : "ok",
          eventIds,
        });
        openAux.delete(rid);
        break;
      }
      default:
        break;
    }
  }

  // Close any open helpers at now.
  for (const [sid, o] of helperOpen) {
    helpers.push({
      sessionId: sid,
      start: o.start,
      end: now,
      eventIds: o.eventIds,
      status: "running",
    });
  }

  // Close open turns at now.
  for (const tid of turnOrder) {
    const span = turns.get(tid)!;
    if (span.status === "running") {
      span.end = Math.max(span.end, now);
    }
  }

  // Determine chat bounds.
  if (!Number.isFinite(chatStart)) {
    chatStart = now;
    chatEnd = now;
  }
  if (chatEnd < chatStart) chatEnd = chatStart;
  // Extend to include leaves/helpers.
  for (const l of leaves) {
    if (l.start < chatStart) chatStart = l.start;
    if (l.end > chatEnd) chatEnd = l.end;
  }
  for (const h of helpers) {
    if (h.start < chatStart) chatStart = h.start;
    if (h.end > chatEnd) chatEnd = h.end;
  }
  if (chatEnd <= chatStart) chatEnd = chatStart + 1000;

  // Chat block (depth 0).
  blocks.push({
    id: "chat",
    depth: 0,
    start: chatStart,
    end: chatEnd,
    label: "chat",
    kind: "chat",
    status: chatError ? "error" : "ok",
    eventIds: chatEventIds,
  });

  // Turn blocks (depth 1).
  const turnSpans: TurnSpan[] = [];
  for (const tid of turnOrder) {
    const span = turns.get(tid)!;
    if (span.end <= span.start) span.end = span.start + 1;
    turnSpans.push(span);
    blocks.push({
      id: `turn:${tid}`,
      depth: 1,
      start: span.start,
      end: span.end,
      label: `turn ${tid}`,
      kind: "turn",
      status: span.status,
      eventIds: span.eventIds,
    });
  }

  // Assign leaves to turns (depth 2). If turnId null, place under nearest turn by time.
  function findTurnAt(t: number): TurnSpan | null {
    let best: TurnSpan | null = null;
    for (const s of turnSpans) {
      if (t >= s.start && t <= s.end) {
        if (!best || s.start > best.start) best = s;
      }
    }
    if (best) return best;
    // fallback: nearest preceding turn
    for (const s of turnSpans) {
      if (s.start <= t && (!best || s.start > best.start)) best = s;
    }
    return best;
  }

  for (const l of leaves) {
    const turn = l.turnId ? turns.get(l.turnId) ?? findTurnAt(l.start) : findTurnAt(l.start);
    const turnKey = turn ? turn.turnId : "none";
    if (l.end <= l.start) l.end = l.start + 1;
    blocks.push({
      id: `${l.kind}:${turnKey}:${l.eventIds[0]}`,
      depth: 2,
      start: l.start,
      end: l.end,
      label: l.label,
      kind: l.kind,
      status: l.status,
      eventIds: l.eventIds,
    });
  }

  // Helper blocks (depth 3), placed under active turn at their start.
  for (const h of helpers) {
    const turn = findTurnAt(h.start);
    const turnKey = turn ? turn.turnId : "none";
    if (h.end <= h.start) h.end = h.start + 1;
    blocks.push({
      id: `helper:${turnKey}:${h.sessionId}`,
      depth: 3,
      start: h.start,
      end: h.end,
      label: `helper ${h.sessionId.slice(0, 8)}`,
      kind: "helper",
      status: h.status,
      eventIds: h.eventIds,
    });
  }

  return { start: chatStart, end: chatEnd, blocks };
}
