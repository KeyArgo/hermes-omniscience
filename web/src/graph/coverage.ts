import type { OmniEvent } from "../types";

export interface CoverageKindCount {
  kind: string;
  count: number;
}

export interface CoverageResult {
  dropped: number;
  unpairedRequests: number;
  unpairedResponses: number;
  turnsWithoutEnd: number;
  usageMissing: number;
  kinds: CoverageKindCount[];
  complete: boolean;
  notes: string[];
}

function parseAttrs(attrs: OmniEvent["attrs"]): Record<string, unknown> {
  if (attrs == null) return {};
  if (typeof attrs === "string") {
    try {
      const parsed: unknown = JSON.parse(attrs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  return attrs;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function buildCoverage(
  events: OmniEvent[],
  loadedAll: boolean,
): CoverageResult {
  const kindCounts = new Map<string, number>();
  let dropped = 0;
  let droppedMarkers = 0;

  const requests = new Map<string, OmniEvent>();
  const answeredRequestIds = new Set<string>();
  const responsesWithoutRequest: OmniEvent[] = [];
  let usageMissing = 0;

  const turnStarts = new Map<string, OmniEvent>();
  const turnEnds = new Set<string>();

  for (const ev of events) {
    kindCounts.set(ev.kind, (kindCounts.get(ev.kind) ?? 0) + 1);

    if (ev.kind === "omni.dropped") {
      droppedMarkers += 1;
      const attrs = parseAttrs(ev.attrs);
      const count = toNumber(attrs.count);
      if (count !== null && count > 0) {
        dropped += count;
      } else {
        dropped += 1;
      }
    }

    if (ev.kind === "llm.request") {
      const key = ev.api_request_id ?? ev.event_id;
      requests.set(key, ev);
    }

    if (ev.kind === "llm.response" || ev.kind === "llm.error") {
      if (ev.api_request_id && requests.has(ev.api_request_id)) {
        answeredRequestIds.add(ev.api_request_id);
      } else if (ev.kind === "llm.response") {
        responsesWithoutRequest.push(ev);
      }
      if (ev.kind === "llm.response") {
        const attrs = parseAttrs(ev.attrs);
        const usage = attrs.usage;
        const hasUsage =
          usage !== null &&
          typeof usage === "object" &&
          !Array.isArray(usage) &&
          Object.keys(usage as Record<string, unknown>).length > 0;
        if (!hasUsage) usageMissing += 1;
      }
    }

    if (ev.kind === "turn.start" && ev.turn_id) {
      turnStarts.set(ev.turn_id, ev);
    }
    if (ev.kind === "turn.end" && ev.turn_id) {
      turnEnds.add(ev.turn_id);
    }
  }

  let unpairedRequests = 0;
  for (const [key] of requests) {
    if (!answeredRequestIds.has(key)) unpairedRequests += 1;
  }

  let turnsWithoutEnd = 0;
  for (const [turnId] of turnStarts) {
    if (!turnEnds.has(turnId)) turnsWithoutEnd += 1;
  }

  const unpairedResponses = responsesWithoutRequest.length;

  const kinds: CoverageKindCount[] = Array.from(kindCounts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const notes: string[] = [];

  if (dropped > 0) {
    notes.push(
      `The recorder fell behind and skipped ${plural(dropped, "step", "steps")}.`,
    );
  }

  if (unpairedRequests > 0) {
    notes.push(
      `${plural(unpairedRequests, "model call has", "model calls have")} no recorded answer (the chat may have been stopped).`,
    );
  }

  if (unpairedResponses > 0) {
    notes.push(
      `${plural(unpairedResponses, "model answer has", "model answers have")} no matching request in the loaded events.`,
    );
  }

  if (turnsWithoutEnd > 0) {
    notes.push(
      `${plural(turnsWithoutEnd, "turn has", "turns have")} no recorded end (the chat may have been stopped).`,
    );
  }

  if (usageMissing > 0) {
    notes.push(
      `${plural(usageMissing, "model answer is", "model answers are")} missing token usage details.`,
    );
  }

  if (!loadedAll) {
    notes.push("Only the newest events are loaded; totals cover what is loaded.");
  }

  const complete =
    loadedAll &&
    dropped === 0 &&
    unpairedRequests === 0 &&
    unpairedResponses === 0 &&
    turnsWithoutEnd === 0 &&
    usageMissing === 0;

  return {
    dropped,
    unpairedRequests,
    unpairedResponses,
    turnsWithoutEnd,
    usageMissing,
    kinds,
    complete,
    notes,
  };
}
