import { describe, expect, it } from "vitest";
import { buildHelpers, type HelperRow } from "./orchestration";
import type { OmniEvent } from "../types";

let seqCounter = 1000;

function mk(partial: Partial<OmniEvent>): OmniEvent {
  seqCounter += 1;
  return {
    rowid: seqCounter,
    event_id: `ev-${seqCounter}`,
    schema: "omni.v1",
    boot_id: "boot-1",
    seq: seqCounter,
    ts: 0,
    kind: "turn.start",
    session_id: null,
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

describe("buildHelpers", () => {
  it("returns empty result with no helper events", () => {
    const events = [mk({ kind: "session.start", ts: 0, session_id: "root" })];
    const res = buildHelpers(events, "root", 999);
    expect(res.helpers).toEqual([]);
    expect(res.maxParallel).toBe(0);
    expect(res.notes).toEqual([]);
  });

  it("builds a single helper with llm and tool stats", () => {
    const events: OmniEvent[] = [
      mk({ kind: "session.start", ts: 0, session_id: "root" }),
      mk({ kind: "turn.start", ts: 1, session_id: "root", turn_id: "t1" }),
      mk({
        kind: "subagent.start",
        ts: 2,
        session_id: "root",
        turn_id: "t1",
        attrs: { child_session_id: "h1", role: "researcher" },
      }),
      mk({
        kind: "llm.request",
        ts: 3,
        session_id: "h1",
        parent_session_id: "root",
        attrs: { model: "deepseek-v4.1-flash" },
      }),
      mk({
        kind: "llm.response",
        ts: 4,
        session_id: "h1",
        attrs: { response_model: "deepseek-v4.1-flash", usage: { prompt_tokens: 100, output_tokens: 50 } },
      }),
      mk({ kind: "tool.end", ts: 5, session_id: "h1", status: "ok", attrs: { tool_name: "search" } }),
      mk({
        kind: "subagent.stop",
        ts: 6,
        session_id: "root",
        attrs: { child_session_id: "h1", child_status: "completed" },
      }),
    ];
    const res = buildHelpers(events, "root", 999);
    expect(res.helpers).toHaveLength(1);
    const h = res.helpers[0];
    expect(h.sessionId).toBe("h1");
    expect(h.role).toBe("researcher");
    expect(h.start).toBe(2);
    expect(h.end).toBe(6);
    expect(h.status).toBe("completed");
    expect(h.modelCalls).toBe(1);
    expect(h.tools).toBe(1);
    expect(h.failed).toBe(0);
    expect(h.models).toEqual(["deepseek-v4.1-flash"]);
    expect(h.tokensIn).toBe(100);
    expect(h.tokensOut).toBe(50);
    expect(h.parentTurnIndex).toBe(0);
    expect(res.maxParallel).toBe(1);
    expect(res.notes).toContain("1 helper ran, up to 1 at the same time.");
    expect(res.notes).toContain("Helpers used deepseek-v4.1-flash.");
  });

  it("computes maxParallel for overlapping helpers", () => {
    const events: OmniEvent[] = [
      mk({ kind: "subagent.start", ts: 0, session_id: "root", attrs: { child_session_id: "a" } }),
      mk({ kind: "subagent.start", ts: 1, session_id: "root", attrs: { child_session_id: "b" } }),
      mk({ kind: "subagent.start", ts: 2, session_id: "root", attrs: { child_session_id: "c" } }),
      mk({ kind: "subagent.stop", ts: 3, session_id: "root", attrs: { child_session_id: "a", child_status: "ok" } }),
      mk({ kind: "subagent.stop", ts: 4, session_id: "root", attrs: { child_session_id: "b", child_status: "ok" } }),
      mk({ kind: "subagent.stop", ts: 5, session_id: "root", attrs: { child: "c", child_status: "ok" } }),
    ];
    const res = buildHelpers(events, "root", 999);
    expect(res.helpers).toHaveLength(3);
    expect(res.maxParallel).toBe(3);
    expect(res.notes[0]).toBe("3 helpers ran, up to 3 at the same time.");
  });

  it("nests helpers whose parent is another helper", () => {
    const events: OmniEvent[] = [
      mk({ kind: "subagent.start", ts: 0, session_id: "root", attrs: { child_session_id: "outer" } }),
      mk({
        kind: "subagent.start",
        ts: 1,
        session_id: "outer",
        parent_session_id: "root",
        attrs: { child_session_id: "inner" },
      }),
      mk({ kind: "subagent.stop", ts: 2, session_id: "outer", attrs: { child_session_id: "inner", child_status: "ok" } }),
      mk({ kind: "subagent.stop", ts: 3, session_id: "root", attrs: { child_session_id: "outer", child_status: "ok" } }),
    ];
    const res = buildHelpers(events, "root", 999);
    expect(res.helpers).toHaveLength(1);
    expect(res.helpers[0].sessionId).toBe("outer");
    expect(res.helpers[0].children).toHaveLength(1);
    expect(res.helpers[0].children[0].sessionId).toBe("inner");
  });

  it("counts failed tool calls and llm errors, and reports them", () => {
    const events: OmniEvent[] = [
      mk({ kind: "subagent.start", ts: 0, session_id: "root", attrs: { child_session_id: "h" } }),
      mk({ kind: "llm.error", ts: 1, session_id: "h", attrs: { reason: "rate limit" } }),
      mk({ kind: "tool.end", ts: 2, session_id: "h", status: "error", attrs: {} }),
      mk({ kind: "tool.end", ts: 3, session_id: "h", status: "ok", attrs: {} }),
      mk({ kind: "subagent.stop", ts: 4, session_id: "root", attrs: { child_session_id: "h", child_status: "failed" } }),
    ];
    const res = buildHelpers(events, "root", 999);
    const h = res.helpers[0] as HelperRow;
    expect(h.failed).toBe(2);
    expect(h.tools).toBe(2);
    expect(h.status).toBe("failed");
    expect(res.notes).toContain("1 helper had at least one failed step.");
  });

  it("treats helpers without a stop event as still running", () => {
    const events: OmniEvent[] = [
      mk({ kind: "subagent.start", ts: 0, session_id: "root", attrs: { child_session_id: "h" } }),
      mk({ kind: "tool.end", ts: 5, session_id: "h", status: "ok", attrs: {} }),
    ];
    const res = buildHelpers(events, "root", 100);
    const h = res.helpers[0];
    expect(h.end).toBe(5);
    expect(h.status).toBe("ended");
  });

  it("parses string-encoded attrs JSON", () => {
    const events: OmniEvent[] = [
      mk({
        kind: "subagent.start",
        ts: 0,
        session_id: "root",
        attrs: JSON.stringify({ child_session_id: "h", role: "writer" }),
      }),
      mk({
        kind: "subagent.stop",
        ts: 2,
        session_id: "root",
        attrs: JSON.stringify({ child_session_id: "h", child_status: "completed" }),
      }),
    ];
    const res = buildHelpers(events, "root", 999);
    expect(res.helpers[0].role).toBe("writer");
    expect(res.helpers[0].status).toBe("completed");
  });
});
