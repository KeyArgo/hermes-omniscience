import { describe, it, expect } from "vitest";
import { buildContext } from "./context";
import type { OmniEvent } from "../types";

function ev(partial: Partial<OmniEvent> & Pick<OmniEvent, "event_id" | "kind">): OmniEvent {
  return {
    rowid: 0,
    schema: "omni",
    boot_id: "b",
    seq: 0,
    ts: 0,
    session_id: "root",
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: null,
    ...partial,
  };
}

describe("buildContext", () => {
  it("builds calls in time order with usage prompt tokens", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "t1", kind: "turn.start", ts: 1, seq: 1 }),
      ev({
        event_id: "r1",
        kind: "llm.request",
        ts: 2,
        seq: 2,
        attrs: {
          model: "m",
          provider: "p",
          message_count: 2,
          tool_count: 3,
          approx_input_tokens: 100,
          retry_count: 0,
          usage: { prompt_tokens: 1000, cache_read_tokens: 400, output_tokens: 50 },
        },
      }),
      ev({ event_id: "t2", kind: "turn.start", ts: 3, seq: 3 }),
      ev({
        event_id: "r2",
        kind: "llm.request",
        ts: 4,
        seq: 4,
        attrs: {
          model: "m",
          provider: "p",
          message_count: 4,
          tool_count: 3,
          approx_input_tokens: 200,
          retry_count: 0,
          usage: { prompt_tokens: 1500, cache_read_tokens: 1000, output_tokens: 60 },
        },
      }),
    ];
    const { calls, summary } = buildContext(events, "root");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      eventId: "r1",
      turnIndex: 0,
      prompt: 1000,
      cached: 400,
      messages: 2,
      tools: 3,
      output: 50,
    });
    expect(calls[1].turnIndex).toBe(1);
    expect(summary.first).toBe(1000);
    expect(summary.last).toBe(1500);
    expect(summary.biggestJump).toEqual({ from: 1000, to: 1500, eventId: "r2" });
    expect(summary.growthPerTurn).toBe(500);
    expect(summary.notes.length).toBeGreaterThan(0);
  });

  it("falls back to approx_input_tokens when usage missing", () => {
    const events: OmniEvent[] = [
      ev({
        event_id: "r1",
        kind: "llm.request",
        ts: 1,
        attrs: { approx_input_tokens: 321 },
      }),
    ];
    const { calls } = buildContext(events, "root");
    expect(calls[0].prompt).toBe(321);
    expect(calls[0].cached).toBeNull();
  });

  it("parses attrs as JSON string", () => {
    const events: OmniEvent[] = [
      ev({
        event_id: "r1",
        kind: "llm.request",
        ts: 1,
        attrs: JSON.stringify({
          approx_input_tokens: 50,
          usage: { prompt_tokens: 77, cache_read_tokens: 10, output_tokens: 5 },
        }),
      }),
    ];
    const { calls } = buildContext(events, "root");
    expect(calls[0].prompt).toBe(77);
    expect(calls[0].cached).toBe(10);
  });

  it("ignores events from other sessions", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "r1", kind: "llm.request", ts: 1, session_id: "other", attrs: { approx_input_tokens: 1 } }),
      ev({ event_id: "r2", kind: "llm.request", ts: 2, session_id: "root", attrs: { approx_input_tokens: 2 } }),
    ];
    const { calls } = buildContext(events, "root");
    expect(calls.map((c) => c.eventId)).toEqual(["r2"]);
  });

  it("returns empty summary when no calls", () => {
    const { calls, summary } = buildContext([], "root");
    expect(calls).toEqual([]);
    expect(summary.first).toBeNull();
    expect(summary.last).toBeNull();
    expect(summary.growthPerTurn).toBeNull();
    expect(summary.biggestJump).toBeNull();
    expect(summary.notes).toEqual([]);
  });

  it("computes median growth across multiple turns", () => {
    const mk = (id: string, ts: number, seq: number, prompt: number): OmniEvent[] => [
      ev({ event_id: id + "-t", kind: "turn.start", ts, seq }),
      ev({
        event_id: id,
        kind: "llm.request",
        ts: ts + 1,
        seq: seq + 1,
        attrs: { usage: { prompt_tokens: prompt, cache_read_tokens: 0, output_tokens: 1 } },
      }),
    ];
    const events = [
      ...mk("a", 1, 1, 100),
      ...mk("b", 10, 10, 200),
      ...mk("c", 20, 20, 210),
      ...mk("d", 30, 30, 220),
    ];
    const { summary } = buildContext(events, "root");
    // deltas: 100, 10, 10 -> median 10
    expect(summary.growthPerTurn).toBe(10);
  });
});

describe("context drops", () => {
  const call = (id: string, ts: number, prompt: number): OmniEvent =>
    ev({
      event_id: id,
      kind: "llm.request",
      ts,
      seq: ts,
      attrs: { model: "m", usage: { prompt_tokens: prompt, cache_read_tokens: 0, output_tokens: 1 } },
    });

  it("marks a steep, large drop and leaves a small wobble alone", () => {
    const { summary } = buildContext(
      [call("a", 1, 100_000), call("b", 2, 120_000), call("c", 3, 40_000), call("d", 4, 41_200)],
      "root"
    );
    expect(summary.drops).toHaveLength(1);
    expect(summary.drops[0]).toMatchObject({ index: 2, from: 120_000, to: 40_000, saved: 80_000 });
    expect(summary.notes.some((n) => n.includes("dropped back once"))).toBe(true);
  });

  it("counts several compactions and reports the last one", () => {
    const { summary } = buildContext(
      [
        call("a", 1, 100_000),
        call("b", 2, 30_000),
        call("c", 3, 90_000),
        call("d", 4, 20_000),
      ],
      "root"
    );
    expect(summary.drops).toHaveLength(2);
    const note = summary.notes.find((n) => n.includes("dropped back"));
    expect(note).toBeDefined();
    expect(note).toContain("twice");
    expect(note).toContain("70,000");
  });

  it("never calls a shallow dip a compaction", () => {
    // 1000 tokens saved is not enough, and 80% is not steep enough.
    const { summary } = buildContext([call("a", 1, 100_000), call("b", 2, 99_000)], "root");
    expect(summary.drops).toEqual([]);
    const shallow = buildContext([call("a", 1, 100_000), call("b", 2, 95_000)], "root").summary;
    expect(shallow.drops).toEqual([]);
  });
});
