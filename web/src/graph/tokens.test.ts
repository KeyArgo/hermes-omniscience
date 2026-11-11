import { describe, it, expect } from "vitest";
import type { OmniEvent } from "../types";
import { buildChatActivity, buildTokenReport } from "./tokens";

function ev(partial: Partial<OmniEvent> & { kind: string }): OmniEvent {
  return {
    rowid: 0,
    schema: "omni.v1",
    boot_id: "b",
    seq: 0,
    tool_call_id: null,
    subagent_id: null,
    event_id: partial.event_id ?? "e",
    ts: partial.ts ?? 0,
    kind: partial.kind,
    session_id: partial.session_id ?? null,
    parent_session_id: partial.parent_session_id ?? null,
    turn_id: partial.turn_id ?? null,
    api_request_id: partial.api_request_id ?? null,
    status: partial.status ?? null,
    attrs: partial.attrs ?? null,
  };
}

function pair(opts: {
  id: string;
  model: string;
  provider?: string;
  usage?: Record<string, unknown>;
  duration_s?: number;
  ttfb_s?: number;
  started_at?: number;
  session_id?: string | null;
  parent_session_id?: string | null;
  kind?: "llm" | "aux";
  aux_task?: string;
}): OmniEvent[] {
  const kind = opts.kind ?? "llm";
  const reqAttrs: Record<string, unknown> = {
    model: opts.model,
    provider: opts.provider,
  };
  if (opts.aux_task) reqAttrs.aux_task = opts.aux_task;
  const resAttrs: Record<string, unknown> = {
    response_model: opts.model,
    provider: opts.provider,
  };
  if (opts.usage) resAttrs.usage = opts.usage;
  if (opts.duration_s !== undefined) resAttrs.duration_s = opts.duration_s;
  if (opts.ttfb_s !== undefined) resAttrs.ttfb_s = opts.ttfb_s;
  if (opts.started_at !== undefined) resAttrs.started_at = opts.started_at;
  if (opts.aux_task) resAttrs.aux_task = opts.aux_task;

  return [
    ev({
      kind: `${kind}.request`,
      event_id: `${opts.id}-req`,
      api_request_id: opts.id,
      session_id: opts.session_id ?? "root",
      parent_session_id: opts.parent_session_id ?? null,
      attrs: reqAttrs,
    }),
    ev({
      kind: `${kind}.response`,
      event_id: `${opts.id}-res`,
      api_request_id: opts.id,
      session_id: opts.session_id ?? "root",
      parent_session_id: opts.parent_session_id ?? null,
      attrs: resAttrs,
    }),
  ];
}

describe("buildTokenReport", () => {
  it("computes cached/fresh math", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { prompt_tokens: 1000, cache_read_tokens: 400, output_tokens: 50 },
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].cached).toBe(400);
    expect(r.calls[0].fresh).toBe(600);
    expect(r.totals.cached).toBe(400);
    expect(r.totals.fresh).toBe(600);
  });

  it("never lets fresh go below zero", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { prompt_tokens: 100, cache_read_tokens: 400, output_tokens: 10 },
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].fresh).toBe(0);
  });

  it("uses input_tokens + cache_read when prompt_tokens missing", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { input_tokens: 300, cache_read_tokens: 200, output_tokens: 20 },
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].cached).toBe(200);
    expect(r.calls[0].fresh).toBe(300);
  });

  it("handles missing usage gracefully", () => {
    const events = pair({ id: "a", model: "M" });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].cached).toBe(0);
    expect(r.calls[0].fresh).toBe(0);
    expect(r.calls[0].output).toBe(0);
    expect(r.calls[0].outPerSec).toBeNull();
  });

  it("assigns roles: background, helper, main", () => {
    const events = [
      ...pair({ id: "m", model: "Main", session_id: "root" }),
      ...pair({
        id: "h",
        model: "Helper",
        session_id: "sub",
        parent_session_id: "root",
      }),
      ...pair({
        id: "b",
        model: "Bg",
        kind: "aux",
        aux_task: "title_generation",
      }),
    ];
    const r = buildTokenReport(events, "root");
    const byId = new Map(r.calls.map((c) => [c.id, c]));
    expect(byId.get("m")?.role).toBe("main");
    expect(byId.get("h")?.role).toBe("helper");
    expect(byId.get("b")?.role).toBe("background");
    expect(byId.get("b")?.task).toBe("title_generation");
  });

  it("computes outPerSec = output/(duration - ttfb)", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { output_tokens: 100 },
      duration_s: 5,
      ttfb_s: 1,
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].outPerSec).toBeCloseTo(25);
  });

  it("outPerSec null when ttfb or duration missing", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { output_tokens: 100 },
      duration_s: 5,
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].outPerSec).toBeNull();
  });

  it("computes byModel medians", () => {
    const events = [
      ...pair({
        id: "a",
        model: "M",
        usage: { output_tokens: 100 },
        duration_s: 5,
        ttfb_s: 1,
      }),
      ...pair({
        id: "b",
        model: "M",
        usage: { output_tokens: 200 },
        duration_s: 5,
        ttfb_s: 1,
      }),
    ];
    const r = buildTokenReport(events, "root");
    const m = r.byModel.find((x) => x.model === "M");
    expect(m?.calls).toBe(2);
    expect(m?.medianOutPerSec).toBeCloseTo(37.5);
  });

  it("parses attrs as JSON string", () => {
    const events = [
      ev({
        kind: "llm.request",
        event_id: "a-req",
        api_request_id: "a",
        session_id: "root",
        attrs: JSON.stringify({ model: "M", provider: "P" }),
      }),
      ev({
        kind: "llm.response",
        event_id: "a-res",
        api_request_id: "a",
        session_id: "root",
        attrs: JSON.stringify({
          response_model: "M",
          usage: { prompt_tokens: 500, cache_read_tokens: 100, output_tokens: 30 },
        }),
      }),
    ];
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].model).toBe("M");
    expect(r.calls[0].provider).toBe("P");
    expect(r.calls[0].cached).toBe(100);
    expect(r.calls[0].fresh).toBe(400);
  });

  it("notes contain no forbidden words", () => {
    const events = [
      ...pair({
        id: "a",
        model: "M",
        usage: { prompt_tokens: 1000, cache_read_tokens: 800, output_tokens: 100 },
        duration_s: 3,
        ttfb_s: 1,
      }),
      ...pair({ id: "b", model: "Bg", kind: "aux", aux_task: "compression" }),
    ];
    const r = buildTokenReport(events, "root");
    const joined = r.notes.join(" ").toLowerCase();
    expect(joined).not.toContain("slow");
    expect(joined).not.toContain("fast");
    expect(joined).not.toContain("blame");
  });

  it("cacheShare is null when no input", () => {
    const events = pair({ id: "a", model: "M" });
    const r = buildTokenReport(events, "root");
    expect(r.totals.cacheShare).toBeNull();
  });
});

describe("buildTokenReport inPerSec", () => {
  it("computes inPerSec = (cached + fresh) / ttfb when ttfb > 0", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { prompt_tokens: 1000, cache_read_tokens: 400, output_tokens: 50 },
      ttfb_s: 2,
    });
    const r = buildTokenReport(events, "root");
    // cached=400, fresh=600, total input=1000, ttfb=2 => inPerSec=500
    expect(r.calls[0].inPerSec).toBeCloseTo(500);
  });

  it("inPerSec is null when ttfb is null", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { prompt_tokens: 1000, cache_read_tokens: 400, output_tokens: 50 },
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].inPerSec).toBeNull();
  });

  it("inPerSec is null when ttfb is 0", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { prompt_tokens: 1000, cache_read_tokens: 400, output_tokens: 50 },
      ttfb_s: 0,
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].inPerSec).toBeNull();
  });

  it("inPerSec is null when no input tokens", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { output_tokens: 50 },
      ttfb_s: 1,
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].inPerSec).toBeNull();
  });

  it("computes medianInPerSec for byModel", () => {
    const events = [
      ...pair({
        id: "a",
        model: "M",
        usage: { prompt_tokens: 1000, cache_read_tokens: 0, output_tokens: 50 },
        ttfb_s: 2,
      }),
      ...pair({
        id: "b",
        model: "M",
        usage: { prompt_tokens: 2000, cache_read_tokens: 0, output_tokens: 50 },
        ttfb_s: 2,
      }),
    ];
    const r = buildTokenReport(events, "root");
    const m = r.byModel.find((x) => x.model === "M");
    expect(m?.medianInPerSec).toBeCloseTo(750);
  });

  it("includes aux calls in inPerSec calculation", () => {
    const events = pair({
      id: "a",
      model: "Bg",
      kind: "aux",
      aux_task: "title_generation",
      usage: { prompt_tokens: 500, cache_read_tokens: 100, output_tokens: 20 },
      ttfb_s: 1,
    });
    const r = buildTokenReport(events, "root");
    const call = r.calls[0];
    expect(call.role).toBe("background");
    // cached=100, fresh=400, total=500, ttfb=1 => inPerSec=500
    expect(call.inPerSec).toBeCloseTo(500);
  });

describe("prompt size and compactions", () => {
  it("records prompt as everything the model was sent", () => {
    const events = pair({
      id: "a",
      model: "M",
      usage: { prompt_tokens: 5000, cache_read_tokens: 4000, output_tokens: 10 },
    });
    const r = buildTokenReport(events, "root");
    expect(r.calls[0].prompt).toBe(5000);
  });

  it("flags a big drop in prompt size as a compaction", () => {
    const events = [
      ...pair({
        id: "a",
        model: "M",
        started_at: 100,
        usage: { prompt_tokens: 80000, cache_read_tokens: 70000, output_tokens: 10 },
      }),
      ...pair({
        id: "b",
        model: "M",
        started_at: 200,
        usage: { prompt_tokens: 50000, cache_read_tokens: 0, output_tokens: 10 },
      }),
    ];
    const r = buildTokenReport(events, "root");
    expect(r.compactions).toHaveLength(1);
    const mark = r.compactions[0];
    expect(mark.before).toBe(80000);
    expect(mark.after).toBe(50000);
    expect(mark.saved).toBe(30000);
    expect(mark.eventId).toBe("b-res");
    // The whole 50k had to be processed fresh after the context was reset.
    expect(mark.freshAfter).toBe(50000);
    expect(mark.beforeCacheShare).toBeCloseTo(0.875);
    expect(mark.afterCacheShare).toBe(0);
  });

  it("ignores a drop too small to be a reset", () => {
    const events = [
      ...pair({
        id: "a",
        model: "M",
        started_at: 100,
        usage: { prompt_tokens: 20000, cache_read_tokens: 0, output_tokens: 10 },
      }),
      ...pair({
        id: "b",
        model: "M",
        started_at: 200,
        usage: { prompt_tokens: 19400, cache_read_tokens: 0, output_tokens: 10 },
      }),
    ];
    expect(buildTokenReport(events, "root").compactions).toHaveLength(0);
  });

  it("ignores a shallow drop (not enough of the context went away)", () => {
    const events = [
      ...pair({
        id: "a",
        model: "M",
        started_at: 100,
        usage: { prompt_tokens: 100000, cache_read_tokens: 0, output_tokens: 10 },
      }),
      ...pair({
        id: "b",
        model: "M",
        started_at: 200,
        usage: { prompt_tokens: 80000, cache_read_tokens: 0, output_tokens: 10 },
      }),
    ];
    expect(buildTokenReport(events, "root").compactions).toHaveLength(0);
  });

  it("does not read a background call's tiny prompt as a compaction", () => {
    const events = [
      ...pair({
        id: "a",
        model: "M",
        started_at: 100,
        usage: { prompt_tokens: 60000, cache_read_tokens: 50000, output_tokens: 10 },
      }),
      ...pair({
        id: "bg",
        model: "Title",
        kind: "aux",
        aux_task: "title_generation",
        started_at: 150,
        usage: { prompt_tokens: 300, cache_read_tokens: 0, output_tokens: 8 },
      }),
      ...pair({
        id: "b",
        model: "M",
        started_at: 200,
        usage: { prompt_tokens: 61000, cache_read_tokens: 60000, output_tokens: 10 },
      }),
    ];
    const r = buildTokenReport(events, "root");
    expect(r.compactions).toHaveLength(0);
    // The context line only follows the chat itself.
    expect(r.promptSeries.map((p) => p.prompt)).toEqual([60000, 61000]);
  });

  it("keeps the context line in time order", () => {
    const events = [
      ...pair({
        id: "late",
        model: "M",
        started_at: 300,
        usage: { prompt_tokens: 3000, cache_read_tokens: 0, output_tokens: 5 },
      }),
      ...pair({
        id: "early",
        model: "M",
        started_at: 100,
        usage: { prompt_tokens: 2000, cache_read_tokens: 0, output_tokens: 5 },
      }),
    ];
    const r = buildTokenReport(events, "root");
    expect(r.promptSeries.map((p) => p.prompt)).toEqual([2000, 3000]);
  });
});

describe("buildChatActivity", () => {
  it("counts tools, MCP calls, skills and background calls", () => {
    const events: OmniEvent[] = [
      ev({ kind: "llm.response", event_id: "l1" }),
      ev({ kind: "aux.response", event_id: "a1", attrs: { aux_task: "approval" } }),
      ev({ kind: "tool.end", event_id: "t1", attrs: { tool_name: "terminal" } }),
      ev({
        kind: "tool.end",
        event_id: "t2",
        attrs: { tool_name: "mcp__linear__create_issue", mcp_server: "linear" },
      }),
      ev({ kind: "skill.event", event_id: "s1", attrs: { skill_name: "github", action: "loaded" } }),
      ev({ kind: "skill.event", event_id: "s2", attrs: { skill_name: "github", action: "loaded" } }),
      ev({ kind: "subagent.start", event_id: "g1" }),
    ];
    const activity = buildChatActivity(events);
    expect(activity.llmCalls).toBe(1);
    expect(activity.auxCalls).toBe(1);
    expect(activity.tools).toBe(2);
    expect(activity.mcpCalls).toBe(1);
    expect(activity.mcpServers).toEqual(["linear"]);
    expect(activity.skills).toBe(2);
    // Two loads of one skill is one skill.
    expect(activity.skillNames).toEqual(["github"]);
    expect(activity.subagents).toBe(1);
  });

  it("survives events with no attributes", () => {
    const activity = buildChatActivity([ev({ kind: "tool.end" })]);
    expect(activity.tools).toBe(1);
    expect(activity.mcpServers).toEqual([]);
  });
});

});

// --- bug hunt round 3 (2026-11-09): helper calls are not the chat's context -------------
describe("compactions ignore helper calls", () => {
  it("does not mark a compaction when a helper sends a smaller prompt", () => {
    const events = [
      ...pair({ id: "main-1", model: "m", usage: { prompt_tokens: 80000 }, started_at: 1 }),
      ...pair({
        id: "helper-1", model: "m", usage: { prompt_tokens: 5000 }, started_at: 2,
        session_id: "helper", parent_session_id: "root",
      }),
    ];
    const r = buildTokenReport(events, "root");
    expect(r.calls.some((c) => c.role === "helper")).toBe(true);
    expect(r.compactions).toHaveLength(0);
  });
});
