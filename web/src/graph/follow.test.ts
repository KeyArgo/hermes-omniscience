import { describe, expect, it } from "vitest";
import type { OmniEvent } from "../types";
import {
  DEFAULT_WATCHERS,
  WATCHER_PRESETS,
  buildWatchReport,
  formatTokens,
  watcherLabel,
  watcherTip,
  watchCandidates,
  type Watcher,
} from "./follow";

let seq = 0;

function ev(partial: Partial<OmniEvent> & { kind: string }): OmniEvent {
  seq += 1;
  return {
    rowid: seq,
    schema: "omni.v1",
    boot_id: "b",
    seq,
    tool_call_id: null,
    subagent_id: null,
    event_id: partial.event_id ?? `e${seq}`,
    ts: partial.ts ?? seq,
    kind: partial.kind,
    session_id: partial.session_id ?? "root",
    parent_session_id: partial.parent_session_id ?? null,
    turn_id: partial.turn_id ?? null,
    api_request_id: partial.api_request_id ?? null,
    status: partial.status ?? null,
    attrs: partial.attrs ?? null,
  };
}

function tool(opts: {
  name: string;
  ok?: boolean;
  ms?: number;
  ts?: number;
  mcp?: string;
  id?: string;
}): OmniEvent {
  return ev({
    kind: "tool.end",
    event_id: opts.id,
    ts: opts.ts,
    status: opts.ok === false ? "error" : "ok",
    attrs: {
      tool_name: opts.name,
      duration_ms: opts.ms ?? 120,
      error_type: opts.ok === false ? "tool_error" : undefined,
      mcp_server: opts.mcp,
    },
  });
}

function llm(opts: {
  id: string;
  ts?: number;
  prompt?: number;
  cacheRead?: number;
  model?: string;
  duration?: number;
}): OmniEvent[] {
  const out: OmniEvent[] = [
    ev({
      kind: "llm.request",
      api_request_id: opts.id,
      ts: opts.ts,
      attrs: { model: opts.model ?? "model-a", provider: "p" },
    }),
  ];
  out.push(
    ev({
      kind: "llm.response",
      api_request_id: opts.id,
      event_id: `${opts.id}-res`,
      ts: opts.ts,
      attrs: {
        response_model: opts.model ?? "model-a",
        provider: "p",
        duration_s: opts.duration ?? 2,
        usage: {
          prompt_tokens: opts.prompt ?? 1000,
          cache_read_tokens: opts.cacheRead ?? 0,
          output_tokens: 20,
        },
      },
    })
  );
  return out;
}

const one = (results: ReturnType<typeof buildWatchReport>, kind: Watcher["kind"]) => {
  const found = results.find((r) => r.watcher.kind === kind);
  if (!found) throw new Error(`no watcher for ${kind}`);
  return found;
};

describe("formatTokens", () => {
  it("keeps small numbers plain and abbreviates big ones", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1.5k");
    // Big numbers may be rendered as k or M; either is readable, NaN is not.
    expect(formatTokens(1200000)).toMatch(/^1\.2M$|^1200k$/);
  });
});

describe("watcher labels and tips", () => {
  it("names a targeted watcher by its target", () => {
    const w: Watcher = { id: "tool:terminal", kind: "tool", target: "terminal" };
    expect(watcherLabel(w)).toContain("terminal");
    expect(watcherTip(w).length).toBeGreaterThan(10);
  });

  it("has a preset for every default watcher", () => {
    for (const watcher of DEFAULT_WATCHERS) {
      expect(WATCHER_PRESETS.some((p) => p.kind === watcher.kind)).toBe(true);
    }
  });
});

describe("buildWatchReport — failures", () => {
  const events = [tool({ name: "terminal", ok: true }), tool({ name: "patch", ok: false })];

  it("counts failed tool calls and marks them bad", () => {
    const r = one(buildWatchReport(events, DEFAULT_WATCHERS), "failures");
    expect(r.count).toBe(1);
    expect(r.tone).toBe("bad");
    expect(r.hits[0].text).toContain("patch");
  });

  it("stays quiet when nothing failed", () => {
    const r = one(buildWatchReport([tool({ name: "terminal" })], DEFAULT_WATCHERS), "failures");
    expect(r.count).toBe(0);
    expect(r.tone).toBe("ok");
    expect(r.lastAt).toBeNull();
  });

  it("counts model errors too", () => {
    const events2 = [
      ev({
        kind: "llm.error",
        attrs: { reason: "timeout", status_code: 504 },
      }),
    ];
    expect(one(buildWatchReport(events2, DEFAULT_WATCHERS), "failures").count).toBe(1);
  });
});

describe("buildWatchReport — rate limits", () => {
  it("finds a 429 and ignores other errors", () => {
    const events = [
      ev({ kind: "llm.error", attrs: { reason: "too many requests", status_code: 429 } }),
      ev({ kind: "llm.error", attrs: { reason: "boom", status_code: 500 } }),
      ...llm({ id: "ok", prompt: 500 }),
    ];
    const r = one(buildWatchReport(events, DEFAULT_WATCHERS), "rate_limits");
    expect(r.count).toBe(1);
  });

  it("can detect a rate limit by reason text alone", () => {
    const events = [ev({ kind: "llm.error", attrs: { reason: "rate_limit exceeded" } })];
    expect(one(buildWatchReport(events, DEFAULT_WATCHERS), "rate_limits").count).toBe(1);
  });
});

describe("buildWatchReport — model switches", () => {
  it("flags a fallback and names both models", () => {
    const events = [
      ev({ kind: "llm.request", api_request_id: "a", attrs: { model: "gpt" } }),
      ev({
        kind: "llm.response",
        api_request_id: "a",
        attrs: { response_model: "glm", usage: { prompt_tokens: 10 } },
      }),
    ];
    const r = one(buildWatchReport(events, DEFAULT_WATCHERS), "model_switches");
    expect(r.count).toBe(1);
    expect(r.hits[0].text).toContain("gpt");
    expect(r.hits[0].text).toContain("glm");
  });

  it("does not flag a normal answer", () => {
    const events = [
      ev({ kind: "llm.request", api_request_id: "a", attrs: { model: "gpt" } }),
      ev({ kind: "llm.response", api_request_id: "a", attrs: { response_model: "gpt" } }),
    ];
    expect(one(buildWatchReport(events, DEFAULT_WATCHERS), "model_switches").count).toBe(0);
  });
});

describe("buildWatchReport — compaction", () => {
  it("finds a big prompt drop", () => {
    const events = [
      ...llm({ id: "1", ts: 10, prompt: 80000, cacheRead: 70000 }),
      ...llm({ id: "2", ts: 20, prompt: 50000, cacheRead: 0 }),
    ];
    const r = one(buildWatchReport(events, DEFAULT_WATCHERS), "compaction");
    expect(r.count).toBe(1);
    expect(r.hits[0].text).toContain("80");
    expect(r.hits[0].text).toContain("50");
    expect(r.lastEventId).toBe("2-res");
  });

  it("ignores a small wobble", () => {
    const events = [
      ...llm({ id: "1", ts: 10, prompt: 20000 }),
      ...llm({ id: "2", ts: 20, prompt: 19400 }),
    ];
    expect(one(buildWatchReport(events, DEFAULT_WATCHERS), "compaction").count).toBe(0);
  });

  it("never counts a background call's tiny prompt as a compaction", () => {
    const events = [
      ...llm({ id: "1", ts: 10, prompt: 60000, cacheRead: 50000 }),
      ev({
        kind: "aux.request",
        api_request_id: "bg",
        ts: 15,
        attrs: { aux_task: "title_generation", model: "small" },
      }),
      ev({
        kind: "aux.response",
        api_request_id: "bg",
        ts: 16,
        attrs: { aux_task: "title_generation", usage: { prompt_tokens: 300 } },
      }),
      ...llm({ id: "2", ts: 20, prompt: 61000, cacheRead: 60000 }),
    ];
    expect(one(buildWatchReport(events, DEFAULT_WATCHERS), "compaction").count).toBe(0);
  });
});

describe("buildWatchReport — slow steps", () => {
  it("uses the threshold and reports seconds", () => {
    const events = [
      tool({ name: "terminal", ms: 45000 }),
      tool({ name: "grep", ms: 500 }),
      ...llm({ id: "slow", ts: 30, duration: 61 }),
    ];
    const watchers: Watcher[] = [{ id: "slow:30", kind: "slow", threshold: 30 }];
    const r = one(buildWatchReport(events, watchers), "slow");
    expect(r.count).toBe(2);
    expect(r.hits.some((h) => h.text.includes("45"))).toBe(true);
  });

  it("defaults to 30 seconds when no threshold is given", () => {
    const events = [tool({ name: "terminal", ms: 20000 })];
    expect(one(buildWatchReport(events, [{ id: "slow", kind: "slow" }]), "slow").count).toBe(0);
  });
});

describe("buildWatchReport — fresh tokens", () => {
  it("sums prompt minus cache and reports no hits", () => {
    const events = [
      ...llm({ id: "1", ts: 10, prompt: 1000, cacheRead: 800 }),
      ...llm({ id: "2", ts: 20, prompt: 2000, cacheRead: 1500 }),
    ];
    const r = one(buildWatchReport(events, DEFAULT_WATCHERS), "fresh_tokens");
    expect(r.hits).toHaveLength(0);
    expect(r.summary).toContain("700");
  });
});

describe("buildWatchReport — targeted watchers", () => {
  it("counts a named tool and marks failures", () => {
    const events = [tool({ name: "terminal" }), tool({ name: "terminal", ok: false }), tool({ name: "grep" })];
    const r = one(buildWatchReport(events, [{ id: "tool:terminal", kind: "tool", target: "terminal" }]), "tool");
    expect(r.count).toBe(2);
    expect(r.tone).toBe("bad");
  });

  it("counts skill loads by name", () => {
    const events = [
      ev({ kind: "skill.event", attrs: { skill_name: "github", action: "loaded" } }),
      ev({ kind: "skill.event", attrs: { skill_name: "github", action: "loaded" } }),
      ev({ kind: "skill.event", attrs: { skill_name: "pdf", action: "loaded" } }),
    ];
    const r = one(buildWatchReport(events, [{ id: "skill:github", kind: "skill", target: "github" }]), "skill");
    expect(r.count).toBe(2);
  });

  it("counts MCP calls and names the server", () => {
    const events = [tool({ name: "mcp__linear__create_issue", mcp: "linear" })];
    const r = one(buildWatchReport(events, [{ id: "mcp", kind: "mcp" }]), "mcp");
    expect(r.count).toBe(1);
    expect(r.hits[0].text).toContain("linear");
  });

  it("counts helper agents", () => {
    const events = [ev({ kind: "subagent.start", attrs: { child_session_id: "c1" } })];
    expect(one(buildWatchReport(events, [{ id: "helpers", kind: "helpers" }]), "helpers").count).toBe(1);
  });
});

describe("buildWatchReport — robustness", () => {
  it("always returns 16 spark buckets", () => {
    const r = buildWatchReport([tool({ name: "terminal", ok: false })], DEFAULT_WATCHERS);
    for (const result of r) expect(result.spark).toHaveLength(16);
  });

  it("reads attributes that arrive as a JSON string", () => {
    const events = [
      ev({
        kind: "tool.end",
        status: "error",
        attrs: JSON.stringify({ tool_name: "patch", duration_ms: 10, error_type: "tool_error" }),
      }),
    ];
    expect(one(buildWatchReport(events, DEFAULT_WATCHERS), "failures").count).toBe(1);
  });

  it("ignores malformed JSON and non-finite numbers instead of throwing", () => {
    const events = [
      ev({ kind: "tool.end", attrs: "{not json" }),
      ev({ kind: "tool.end", attrs: { tool_name: "x", duration_ms: null } }),
      ev({ kind: "llm.response", attrs: { usage: { prompt_tokens: "NaN" } } }),
    ];
    const r = buildWatchReport(events, DEFAULT_WATCHERS);
    expect(Array.isArray(r)).toBe(true);
    for (const result of r) {
      expect(Number.isFinite(result.count)).toBe(true);
      expect(Number.isFinite(result.summary.length)).toBe(true);
    }
  });

  it("returns zero hits for an unknown watcher kind instead of throwing", () => {
    const r = buildWatchReport([tool({ name: "x" })], [{ id: "weird", kind: "weird" as Watcher["kind"] }]);
    expect(r).toHaveLength(1);
    expect(r[0].count).toBe(0);
  });

  it("keeps hits in time order and points lastAt at the newest", () => {
    const events = [
      tool({ name: "a", ok: false, ts: 300, id: "late" }),
      tool({ name: "b", ok: false, ts: 100, id: "early" }),
    ];
    const r = one(buildWatchReport(events, DEFAULT_WATCHERS), "failures");
    expect(r.hits.map((h) => h.eventId)).toEqual(["early", "late"]);
    expect(r.lastAt).toBe(300);
    expect(r.lastEventId).toBe("late");
  });
});

describe("watchCandidates", () => {
  const events: OmniEvent[] = [
    ev({ kind: "tool.end", attrs: { tool_name: "bash" } }),
    ev({ kind: "tool.end", attrs: { tool_name: "bash" } }),
    ev({ kind: "tool.end", attrs: { tool_name: "read_file" } }),
    ev({ kind: "tool.end", attrs: { tool_name: "bash" } }),
    ev({ kind: "tool.end", attrs: { tool_name: "gh_issue", mcp_server: "github" } }),
    ev({ kind: "tool.end", attrs: { tool_name: "gh_pr", mcp_server: "github" } }),
    ev({ kind: "skill.event", attrs: { skill_name: "github" } }),
    ev({ kind: "llm.response", attrs: { response_model: "m" } }),
  ];

  it("offers what actually ran, busiest first", () => {
    const found = watchCandidates(events, []);
    const tools = found.filter((c) => c.kind === "tool").map((c) => c.label);
    expect(tools).toEqual(["bash", "gh_issue", "gh_pr", "read_file"]);
    expect(found[0]).toMatchObject({ kind: "tool", label: "bash", count: 3 });
  });

  it("separates MCP servers from plain tools", () => {
    const found = watchCandidates(events, []);
    const mcp = found.find((c) => c.kind === "mcp");
    expect(mcp).toMatchObject({ label: "github", count: 2 });
    expect(found.find((c) => c.kind === "skill" && c.label === "github")).toBeDefined();
  });

  it("leaves out what is already watched", () => {
    const active: Watcher[] = [{ id: "tool:bash", kind: "tool", target: "bash" }];
    const tools = watchCandidates(events, active).filter((c) => c.kind === "tool").map((c) => c.label);
    expect(tools).not.toContain("bash");
    expect(tools).toContain("read_file");
  });

  it("ignores events with no usable name and never invents one", () => {
    const junk = [
      ev({ kind: "tool.end", attrs: null }),
      ev({ kind: "tool.end", attrs: { tool_name: 42 } }),
      ev({ kind: "skill.event", attrs: "not-an-object" }),
    ];
    expect(watchCandidates(junk, [])).toEqual([]);
  });

  it("is empty for an empty chat", () => {
    expect(watchCandidates([], [])).toEqual([]);
  });

  it("gives every candidate an id that can be watched directly", () => {
    for (const candidate of watchCandidates(events, [])) {
      expect(candidate.id).toBe(`${candidate.kind}:${candidate.target}`);
    }
  });
});
