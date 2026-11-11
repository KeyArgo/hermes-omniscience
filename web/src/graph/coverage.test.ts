import { describe, it, expect } from "vitest";
import type { OmniEvent } from "../types";
import { buildCoverage } from "./coverage";

function makeEvent(overrides: Partial<OmniEvent>): OmniEvent {
  return {
    rowid: 1,
    event_id: "evt-1",
    schema: "omni.v1",
    boot_id: "boot-1",
    seq: 1,
    ts: 1700000000000,
    kind: "session.start",
    session_id: "sess-root",
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: null,
    ...overrides,
  };
}

describe("buildCoverage", () => {
  it("reports complete when everything is paired and loaded", () => {
    const events: OmniEvent[] = [
      makeEvent({ event_id: "e1", kind: "session.start", seq: 1 }),
      makeEvent({
        event_id: "e2",
        kind: "turn.start",
        turn_id: "t1",
        seq: 2,
      }),
      makeEvent({
        event_id: "e3",
        kind: "llm.request",
        turn_id: "t1",
        api_request_id: "req-1",
        seq: 3,
        attrs: { model: "m", provider: "p", message_count: 1, tool_count: 0 },
      }),
      makeEvent({
        event_id: "e4",
        kind: "llm.response",
        turn_id: "t1",
        api_request_id: "req-1",
        seq: 4,
        attrs: {
          duration_s: 1,
          usage: { prompt_tokens: 10, cache_read_tokens: 0, output_tokens: 5 },
        },
      }),
      makeEvent({
        event_id: "e5",
        kind: "turn.end",
        turn_id: "t1",
        seq: 5,
      }),
      makeEvent({ event_id: "e6", kind: "session.end", seq: 6 }),
    ];

    const result = buildCoverage(events, true);
    expect(result.complete).toBe(true);
    expect(result.dropped).toBe(0);
    expect(result.unpairedRequests).toBe(0);
    expect(result.unpairedResponses).toBe(0);
    expect(result.turnsWithoutEnd).toBe(0);
    expect(result.usageMissing).toBe(0);
    expect(result.notes).toEqual([]);
    expect(result.kinds.length).toBeGreaterThan(0);
  });

  it("sums dropped counts from omni.dropped attrs", () => {
    const events: OmniEvent[] = [
      makeEvent({
        event_id: "d1",
        kind: "omni.dropped",
        seq: 1,
        attrs: { count: 12 },
      }),
      makeEvent({
        event_id: "d2",
        kind: "omni.dropped",
        seq: 2,
        attrs: JSON.stringify({ count: 3 }),
      }),
    ];
    const result = buildCoverage(events, true);
    expect(result.dropped).toBe(15);
    expect(result.complete).toBe(false);
    expect(result.notes.some((n) => n.includes("skipped 15 steps"))).toBe(true);
  });

  it("counts dropped markers when count is absent", () => {
    const events: OmniEvent[] = [
      makeEvent({ event_id: "d1", kind: "omni.dropped", seq: 1, attrs: null }),
      makeEvent({ event_id: "d2", kind: "omni.dropped", seq: 2, attrs: {} }),
    ];
    const result = buildCoverage(events, true);
    expect(result.dropped).toBe(2);
  });

  it("detects unpaired requests and turns without end", () => {
    const events: OmniEvent[] = [
      makeEvent({
        event_id: "r1",
        kind: "llm.request",
        api_request_id: "req-1",
        seq: 1,
        attrs: { model: "m" },
      }),
      makeEvent({
        event_id: "r2",
        kind: "llm.request",
        api_request_id: "req-2",
        seq: 2,
        attrs: { model: "m" },
      }),
      makeEvent({
        event_id: "resp1",
        kind: "llm.response",
        api_request_id: "req-1",
        seq: 3,
        attrs: { usage: { prompt_tokens: 1, output_tokens: 1 } },
      }),
      makeEvent({
        event_id: "t1",
        kind: "turn.start",
        turn_id: "turn-a",
        seq: 4,
      }),
    ];
    const result = buildCoverage(events, true);
    expect(result.unpairedRequests).toBe(1);
    expect(result.turnsWithoutEnd).toBe(1);
    expect(result.complete).toBe(false);
    expect(
      result.notes.some((n) => n.includes("no recorded answer")),
    ).toBe(true);
    expect(result.notes.some((n) => n.includes("no recorded end"))).toBe(true);
  });

  it("counts responses without usage and responses without request", () => {
    const events: OmniEvent[] = [
      makeEvent({
        event_id: "resp1",
        kind: "llm.response",
        api_request_id: "req-x",
        seq: 1,
        attrs: { duration_s: 1 },
      }),
      makeEvent({
        event_id: "resp2",
        kind: "llm.response",
        api_request_id: "req-y",
        seq: 2,
        attrs: { usage: {} },
      }),
    ];
    const result = buildCoverage(events, true);
    expect(result.usageMissing).toBe(2);
    expect(result.unpairedResponses).toBe(2);
  });

  it("adds a note when not all events are loaded", () => {
    const result = buildCoverage([], false);
    expect(result.complete).toBe(false);
    expect(
      result.notes.some((n) => n.includes("Only the newest events are loaded")),
    ).toBe(true);
  });

  it("aggregates kind counts sorted by count", () => {
    const events: OmniEvent[] = [
      makeEvent({ event_id: "a", kind: "tool.end", seq: 1 }),
      makeEvent({ event_id: "b", kind: "tool.end", seq: 2 }),
      makeEvent({ event_id: "c", kind: "session.start", seq: 3 }),
    ];
    const result = buildCoverage(events, true);
    expect(result.kinds[0]).toEqual({ kind: "tool.end", count: 2 });
    expect(result.kinds.some((k) => k.kind === "session.start")).toBe(true);
  });
});
