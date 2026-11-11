import { describe, it, expect } from "vitest";
import type { OmniEvent } from "../types";
import { buildRows, applyFilter } from "./rows";

function ev(partial: Partial<OmniEvent> & { event_id: string; ts: number; kind: string }): OmniEvent {
  return {
    rowid: 0,
    session_id: "root",
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

const NOW = 1_000_000;

describe("buildRows", () => {
  it("merges consecutive identical tool steps with repeat", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "tool1", ts: 102, kind: "tool.end", status: "ok", attrs: { tool_name: "terminal", duration_ms: 100 } }),
      ev({ event_id: "tool2", ts: 103, kind: "tool.end", status: "ok", attrs: { tool_name: "terminal", duration_ms: 200 } }),
      ev({ event_id: "tool3", ts: 104, kind: "tool.end", status: "ok", attrs: { tool_name: "terminal", duration_ms: 300 } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    expect(rows).toHaveLength(1);
    const tools = rows[0].steps.filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].label).toBe("terminal ×3");
    expect(tools[0].repeat).toBe(3);
    expect(tools[0].seconds).toBeCloseTo(0.6, 5);
  });

  it("adds fallback badge when response_model differs", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "gpt-6.1-sol" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "gpt-6.1-sol" } }),
      ev({ event_id: "r1", ts: 102, kind: "llm.request", api_request_id: "a1", attrs: { model: "gpt-6.1-sol", provider: "p", approx_input_tokens: 100, retry_count: 0 } }),
      ev({ event_id: "resp1", ts: 105, kind: "llm.response", api_request_id: "a1", attrs: { duration_s: 3, ttfb_s: 1, finish_reason: "stop", response_model: "gpt-4", usage: { prompt_tokens: 100, output_tokens: 20 } } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const llm = rows[0].steps.find((s) => s.kind === "llm");
    expect(llm).toBeDefined();
    expect(llm!.badges.some((b) => b.startsWith("fallback from gpt-6.1-sol"))).toBe(true);
    expect(llm!.label).toBe("gpt-4");
  });

  it("adds rate-limited badge from llm.error", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "r1", ts: 102, kind: "llm.request", api_request_id: "a1", attrs: { model: "m", provider: "p", approx_input_tokens: 100, retry_count: 0 } }),
      ev({ event_id: "e1", ts: 103, kind: "llm.error", api_request_id: "a1", attrs: { duration_s: 1, error_type: "http", reason: "rate_limit", retryable: true, status_code: 429 } }),
      ev({ event_id: "e2", ts: 104, kind: "llm.error", api_request_id: "a1", attrs: { duration_s: 1, error_type: "http", reason: "rate_limit", retryable: true, status_code: 429 } }),
      ev({ event_id: "resp1", ts: 106, kind: "llm.response", api_request_id: "a1", attrs: { duration_s: 2, ttfb_s: 1, finish_reason: "stop", response_model: "m", usage: { prompt_tokens: 100, output_tokens: 10 } } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const llm = rows[0].steps.find((s) => s.kind === "llm");
    expect(llm).toBeDefined();
    expect(llm!.badges.some((b) => b === "rate-limited ×2")).toBe(true);
    expect(llm!.badges.some((b) => b === "429")).toBe(true);
    expect(llm!.status).toBe("warn");
  });

  it("creates a helper step in the active parent turn", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "sub1", ts: 102, kind: "subagent.start", session_id: "child", parent_session_id: "root", attrs: {} }),
      ev({ event_id: "sub1e", ts: 108, kind: "subagent.stop", session_id: "child", parent_session_id: "root", attrs: {} }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const helper = rows[0].steps.find((s) => s.kind === "helper");
    expect(helper).toBeDefined();
    expect(helper!.seconds).toBeCloseTo(6, 5);
  });

  it("places steps before first turn.start into a pre-turn row", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "tool0", ts: 101, kind: "tool.end", status: "ok", attrs: { tool_name: "boot", duration_ms: 50 } }),
      ev({ event_id: "t1", ts: 105, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    expect(rows[0].label).toBe("Before the first message");
    expect(rows[0].steps.some((s) => s.label === "boot")).toBe(true);
  });

  it("parses attrs given as JSON string", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: JSON.stringify({ model: "m" }) }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: JSON.stringify({ model: "m" }) }),
      ev({ event_id: "tool1", ts: 102, kind: "tool.end", status: "ok", attrs: JSON.stringify({ tool_name: "grep", duration_ms: 123 }) }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const tool = rows[0].steps.find((s) => s.kind === "tool");
    expect(tool!.label).toBe("grep");
    expect(tool!.detail).toBe("123 ms");
  });
});

describe("applyFilter", () => {
  const baseEvents: OmniEvent[] = [
    ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
    ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
    ev({ event_id: "r1", ts: 102, kind: "llm.request", api_request_id: "a1", attrs: { model: "m", provider: "p", approx_input_tokens: 100, retry_count: 0 } }),
    ev({ event_id: "resp1", ts: 105, kind: "llm.response", api_request_id: "a1", attrs: { duration_s: 2, ttfb_s: 1, finish_reason: "stop", response_model: "m", usage: { prompt_tokens: 100, output_tokens: 10 } } }),
    ev({ event_id: "tool1", ts: 106, kind: "tool.end", status: "ok", attrs: { tool_name: "ls", duration_ms: 10 } }),
    ev({ event_id: "tool2", ts: 107, kind: "tool.end", status: "ok", attrs: { tool_name: "cat", duration_ms: 10 } }),
    ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
  ];

  it("never removes turns when hiding tools", () => {
    const rows = buildRows(baseEvents, NOW);
    const filtered = applyFilter(rows, { hideTools: true, hideLlms: false, errorsOnly: false });
    expect(filtered).toHaveLength(rows.length);
    const gap = filtered[0].steps.find((s) => s.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap!.label).toContain("tools hidden");
  });

  it("errorsOnly marks clean turns as no problems with empty steps", () => {
    const rows = buildRows(baseEvents, NOW);
    const filtered = applyFilter(rows, { hideTools: false, hideLlms: false, errorsOnly: true });
    expect(filtered).toHaveLength(rows.length);
    expect(filtered[0].steps).toHaveLength(0);
    expect(filtered[0].summary).toBe("no problems");
  });
});

describe("buildRows loop folding", () => {
  it("folds model call → same tool rounds into one row and keeps turn counts", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
    ];
    for (let i = 0; i < 4; i += 1) {
      const id = `r${i}`;
      events.push(ev({ event_id: `${id}q`, ts: 102 + i * 3, kind: "llm.request", api_request_id: id, attrs: { model: "GLM" } }));
      events.push(ev({ event_id: `${id}p`, ts: 103 + i * 3, kind: "llm.response", api_request_id: id, status: "ok", attrs: { duration_s: 1, response_model: "GLM" } }));
      events.push(ev({ event_id: `${id}t`, ts: 104 + i * 3, kind: "tool.end", status: i === 2 ? "error" : "ok", attrs: { tool_name: "terminal", duration_ms: 1000 } }));
    }
    events.push(ev({ event_id: "t1e", ts: 120, kind: "turn.end" }));
    const [turn] = buildRows(events, NOW);
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].label).toBe("GLM → terminal ×4");
    expect(turn.steps[0].status).toBe("error");
    expect(turn.summary).toContain("4 model calls");
    expect(turn.summary).toContain("4 tools");
    expect(turn.summary).toContain("1 failed");
  });
});

describe("buildRows background steps", () => {
  it("creates a background step for aux.request/aux.response pair", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "aux1", ts: 102, kind: "aux.request", api_request_id: "aux-a", attrs: { aux_task: "title_generation", model: "small-model", provider: "p" } }),
      ev({ event_id: "aux1r", ts: 104, kind: "aux.response", api_request_id: "aux-a", status: "ok", attrs: { aux_task: "title_generation", duration_s: 2, started_at: 102, ended_at: 104, response_model: "small-model", usage: { prompt_tokens: 50, output_tokens: 10 } } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const bg = rows[0].steps.find((s) => s.kind === "background");
    expect(bg).toBeDefined();
    expect(bg!.label).toBe("background: title_generation");
    expect(bg!.detail).toContain("small-model");
    expect(bg!.detail).toContain("2.0 s");
    expect(bg!.status).toBe("ok");
    expect(rows[0].summary).toContain("1 background");
  });

  it("marks background step as error when status is error", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "aux1", ts: 102, kind: "aux.request", api_request_id: "aux-a", attrs: { aux_task: "compression", model: "small-model", provider: "p" } }),
      ev({ event_id: "aux1r", ts: 104, kind: "aux.response", api_request_id: "aux-a", status: "error", attrs: { aux_task: "compression", duration_s: 1, started_at: 102, ended_at: 103, response_model: "small-model", error_type: "timeout" } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const bg = rows[0].steps.find((s) => s.kind === "background");
    expect(bg).toBeDefined();
    expect(bg!.status).toBe("error");
    expect(bg!.badges).toContain("timeout");
  });

  it("creates a background step for skill.event", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "sk1", ts: 102, kind: "skill.event", attrs: { action: "loaded", skill_name: "web-search" } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const bg = rows[0].steps.find((s) => s.kind === "background");
    expect(bg).toBeDefined();
    expect(bg!.label).toBe("skill: web-search (loaded)");
    expect(bg!.status).toBe("ok");
    expect(rows[0].summary).toContain("1 background");
  });

  it("background steps do not count as model calls in summary", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "aux1", ts: 102, kind: "aux.request", api_request_id: "aux-a", attrs: { aux_task: "vision", model: "vision-model", provider: "p" } }),
      ev({ event_id: "aux1r", ts: 104, kind: "aux.response", api_request_id: "aux-a", status: "ok", attrs: { aux_task: "vision", duration_s: 1.5, response_model: "vision-model" } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    expect(rows[0].summary).not.toContain("model call");
    expect(rows[0].summary).toContain("1 background");
  });

  it("background steps are not merged into tool loops", () => {
    const events: OmniEvent[] = [
      ev({ event_id: "s", ts: 100, kind: "session.start", attrs: { model: "m" } }),
      ev({ event_id: "t1", ts: 101, kind: "turn.start", attrs: { model: "m" } }),
      ev({ event_id: "aux1", ts: 102, kind: "aux.request", api_request_id: "aux-a", attrs: { aux_task: "title_generation", model: "small", provider: "p" } }),
      ev({ event_id: "aux1r", ts: 103, kind: "aux.response", api_request_id: "aux-a", status: "ok", attrs: { aux_task: "title_generation", duration_s: 0.5, response_model: "small" } }),
      ev({ event_id: "tool1", ts: 104, kind: "tool.end", status: "ok", attrs: { tool_name: "ls", duration_ms: 10 } }),
      ev({ event_id: "t1e", ts: 110, kind: "turn.end" }),
    ];
    const rows = buildRows(events, NOW);
    const bgSteps = rows[0].steps.filter((s) => s.kind === "background");
    const toolSteps = rows[0].steps.filter((s) => s.kind === "tool");
    expect(bgSteps).toHaveLength(1);
    expect(toolSteps).toHaveLength(1);
    // They should be separate steps, not merged
    expect(rows[0].steps).toHaveLength(2);
  });
});

function evq(partial: Partial<OmniEvent> & { kind: OmniEvent["kind"]; ts: number }): OmniEvent {
  return {
    event_id: partial.event_id ?? `e-${partial.kind}-${partial.ts}`,
    kind: partial.kind,
    ts: partial.ts,
    rowid: partial.rowid ?? partial.ts,
    session_id: partial.session_id ?? "s1",
    attrs: partial.attrs ?? null,
    status: partial.status ?? null,
    api_request_id: partial.api_request_id ?? null,
    parent_session_id: partial.parent_session_id ?? null,
  } as OmniEvent;
}

describe("buildRows – finding 4: negative duration clamped to zero", () => {
  it("clamps negative resp.ts - req.ts to 0", () => {
    // req at ts=1000, resp at ts=999 (clock skew), no duration_s attr
    const events: OmniEvent[] = [
      evq({ kind: "session.start", ts: 0, session_id: "s1" }),
      evq({ kind: "turn.start", ts: 998, session_id: "s1" }),
      evq({ kind: "llm.request", ts: 1000, session_id: "s1", api_request_id: "r1" }),
      evq({ kind: "llm.response", ts: 999, session_id: "s1", api_request_id: "r1" }),
      evq({ kind: "turn.end", ts: 1001, session_id: "s1" }),
    ];
    const rows = buildRows(events, 2000);
    const turn = rows.find(r => r.id === "turn:0");
    expect(turn).toBeDefined();
    const llmStep = turn!.steps.find(s => s.kind === "llm");
    expect(llmStep).toBeDefined();
    // seconds should be 0, not -1
    expect(llmStep!.seconds).toBe(0);
  });
});

describe("buildRows – finding 7: stale turn without end gets seconds from last event", () => {
  it("turn with only turn.start and stale last event gets seconds, not null", () => {
    // turn.start at t=1000, no further events, nowTs=1400 (stale >300s)
    const events: OmniEvent[] = [
      evq({ kind: "session.start", ts: 0, session_id: "s1" }),
      evq({ kind: "turn.start", ts: 1000, session_id: "s1" }),
    ];
    const rows = buildRows(events, 1400);
    const turn = rows.find(r => r.id === "turn:0");
    expect(turn).toBeDefined();
    // Not running (stale), seconds should be lastEventTs - start = 1000 - 1000 = 0
    expect(turn!.status).not.toBe("running");
    expect(turn!.seconds).toBe(0);
  });

  it("turn with only turn.start and recent last event is running with null seconds", () => {
    const events: OmniEvent[] = [
      evq({ kind: "session.start", ts: 0, session_id: "s1" }),
      evq({ kind: "turn.start", ts: 1000, session_id: "s1" }),
    ];
    const rows = buildRows(events, 1200); // 200s ago, < 300
    const turn = rows.find(r => r.id === "turn:0");
    expect(turn).toBeDefined();
    expect(turn!.status).toBe("running");
    expect(turn!.seconds).toBeNull();
  });
});

