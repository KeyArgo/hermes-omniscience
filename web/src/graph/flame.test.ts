import { describe, it, expect } from "vitest";
import { buildFlame } from "./flame";
import type { OmniEvent } from "../types";

function ev(partial: Partial<OmniEvent> & { rowid: number; event_id: string; ts: number; kind: string }): OmniEvent {
  return {
    schema: 'omni.v1',
    boot_id: 'b',
    seq: partial.rowid,
    session_id: null,
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: null,
    ...partial,
  } as OmniEvent;
}

describe("buildFlame", () => {
  it("builds chat, turn, model, tool, background, helper blocks", () => {
    const root = "root-sess";
    const events: OmniEvent[] = [
      ev({ rowid: 1, event_id: "e1", ts: 1000, kind: "turn.start", session_id: root, turn_id: "t1" }),
      ev({
        rowid: 2,
        event_id: "e2",
        ts: 1001,
        kind: "llm.request",
        session_id: root,
        turn_id: "t1",
        api_request_id: "r1",
      }),
      ev({
        rowid: 3,
        event_id: "e3",
        ts: 1005,
        kind: "llm.response",
        session_id: root,
        turn_id: "t1",
        api_request_id: "r1",
        attrs: { started_at: 1001, ended_at: 1005, duration_s: 4, response_model: "gpt-x" },
      }),
      ev({
        rowid: 4,
        event_id: "e4",
        ts: 1006,
        kind: "tool.end",
        session_id: root,
        turn_id: "t1",
        attrs: { tool_name: "search", duration_ms: 2000, started_at: 1006 },
      }),
      ev({
        rowid: 5,
        event_id: "e5",
        ts: 1007,
        kind: "aux.request",
        session_id: root,
        turn_id: "t1",
        api_request_id: "a1",
        attrs: { aux_task: "summarize" },
      }),
      ev({
        rowid: 6,
        event_id: "e6",
        ts: 1010,
        kind: "aux.response",
        session_id: root,
        turn_id: "t1",
        api_request_id: "a1",
        attrs: { aux_task: "summarize", started_at: 1007, ended_at: 1010, duration_s: 3 },
      }),
      ev({
        rowid: 7,
        event_id: "e7",
        ts: 1008,
        kind: "subagent.start",
        session_id: "child-1",
        parent_session_id: root,
        attrs: { child_session_id: "child-1" },
      }),
      ev({
        rowid: 8,
        event_id: "e8",
        ts: 1012,
        kind: "subagent.stop",
        session_id: "child-1",
        parent_session_id: root,
        attrs: { child_session_id: "child-1" },
      }),
      ev({ rowid: 9, event_id: "e9", ts: 1015, kind: "turn.end", session_id: root, turn_id: "t1" }),
    ];

    const res = buildFlame(events, root, 1020);
    expect(res.start).toBeLessThan(res.end);
    const kinds = new Set(res.blocks.map((b) => b.kind));
    expect(kinds.has("chat")).toBe(true);
    expect(kinds.has("turn")).toBe(true);
    expect(kinds.has("model")).toBe(true);
    expect(kinds.has("tool")).toBe(true);
    expect(kinds.has("background")).toBe(true);
    expect(kinds.has("helper")).toBe(true);

    const chat = res.blocks.find((b) => b.kind === "chat")!;
    expect(chat.depth).toBe(0);
    const turn = res.blocks.find((b) => b.kind === "turn")!;
    expect(turn.depth).toBe(1);
    const model = res.blocks.find((b) => b.kind === "model")!;
    expect(model.depth).toBe(2);
    expect(model.label).toBe("gpt-x");
    const helper = res.blocks.find((b) => b.kind === "helper")!;
    expect(helper.depth).toBe(3);
  });

  it("marks error status", () => {
    const root = "root";
    const events: OmniEvent[] = [
      ev({ rowid: 1, event_id: "e1", ts: 1000, kind: "turn.start", session_id: root, turn_id: "t1" }),
      ev({
        rowid: 2,
        event_id: "e2",
        ts: 1001,
        kind: "llm.request",
        session_id: root,
        turn_id: "t1",
        api_request_id: "r1",
      }),
      ev({
        rowid: 3,
        event_id: "e3",
        ts: 1002,
        kind: "llm.error",
        session_id: root,
        turn_id: "t1",
        api_request_id: "r1",
        status: "error",
      }),
      ev({ rowid: 4, event_id: "e4", ts: 1003, kind: "turn.end", session_id: root, turn_id: "t1", status: "error" }),
    ];
    const res = buildFlame(events, root, 1010);
    const model = res.blocks.find((b) => b.kind === "model")!;
    expect(model.status).toBe("error");
    const turn = res.blocks.find((b) => b.kind === "turn")!;
    expect(turn.status).toBe("error");
  });

  it("handles empty events", () => {
    const res = buildFlame([], null, 1000);
    expect(res.blocks.length).toBe(1);
    expect(res.blocks[0].kind).toBe("chat");
  });
});
