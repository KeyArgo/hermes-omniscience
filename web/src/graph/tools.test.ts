import { describe, it, expect } from "vitest";
import type { OmniEvent } from "../types";
import { buildToolStats } from "./tools";

function ev(partial: Partial<OmniEvent> & { rowid: number; event_id: string; kind: string }): OmniEvent {
  return {
    schema: "omni",
    boot_id: "boot",
    seq: partial.rowid,
    ts: 1000 + partial.rowid,
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

function toolEnd(
  rowid: number,
  name: string,
  opts: {
    session?: string;
    status?: string;
    duration_ms?: number;
    result_chars?: number;
    mcp_server?: string;
    arg_names?: string[];
  } = {},
): OmniEvent {
  return ev({
    rowid,
    event_id: `e${rowid}`,
    kind: "tool.end",
    session_id: opts.session ?? "root",
    attrs: {
      tool_name: name,
      status: opts.status ?? "ok",
      duration_ms: opts.duration_ms ?? 1000,
      result_chars: opts.result_chars ?? 10,
      ...(opts.mcp_server ? { mcp_server: opts.mcp_server } : {}),
      ...(opts.arg_names ? { arg_names: opts.arg_names } : {}),
    },
  });
}

describe("buildToolStats", () => {
  it("aggregates calls, failures, durations and args", () => {
    const events: OmniEvent[] = [
      toolEnd(1, "read_file", { duration_ms: 1000, result_chars: 50, arg_names: ["path"] }),
      toolEnd(2, "read_file", { duration_ms: 3000, result_chars: 100, arg_names: ["path", "offset"] }),
      toolEnd(3, "read_file", { duration_ms: 2000, status: "error", result_chars: 0 }),
      toolEnd(4, "write_file", { duration_ms: 500, result_chars: 20, arg_names: ["path", "content"] }),
    ];
    const { tools } = buildToolStats(events, "root");
    expect(tools[0].name).toBe("read_file");
    expect(tools[0].calls).toBe(3);
    expect(tools[0].failed).toBe(1);
    expect(tools[0].totalSeconds).toBeCloseTo(6);
    expect(tools[0].medianSeconds).toBeCloseTo(2);
    expect(tools[0].maxSeconds).toBeCloseTo(3);
    expect(tools[0].resultChars).toBe(150);
    expect(tools[0].argNames).toEqual(["offset", "path"]);
    expect(tools[0].lastEventId).toBe("e3");
    expect(tools[0].failEventIds).toEqual(["e3"]);
    expect(tools[1].name).toBe("write_file");
  });

  it("includes helper sessions via subagent.start and parent_session_id", () => {
    const events: OmniEvent[] = [
      ev({ rowid: 1, event_id: "s1", kind: "subagent.start", session_id: "root", attrs: { child_session_id: "child" } }),
      toolEnd(2, "bash", { session: "child", duration_ms: 100 }),
      toolEnd(3, "grep", { session: "helper", duration_ms: 100 }),
      ev({ rowid: 4, event_id: "h1", kind: "session.start", session_id: "helper", parent_session_id: "root" }),
    ];
    const { tools } = buildToolStats(events, "root");
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["bash", "grep"]);
  });

  it("computes longest consecutive run", () => {
    const events: OmniEvent[] = [
      toolEnd(1, "terminal"),
      toolEnd(2, "terminal"),
      toolEnd(3, "terminal"),
      toolEnd(4, "other"),
      toolEnd(5, "terminal"),
    ];
    const { tools, notes } = buildToolStats(events, "root");
    const terminal = tools.find((t) => t.name === "terminal")!;
    expect(terminal.longestRun).toBe(3);
    expect(notes.some((n) => n.includes("terminal was called 3 times in a row at most."))).toBe(true);
  });

  it("groups by MCP server and notes it", () => {
    const events: OmniEvent[] = [
      toolEnd(1, "search", { mcp_server: "github" }),
      toolEnd(2, "issue", { mcp_server: "github" }),
      toolEnd(3, "read", { mcp_server: "slack" }),
    ];
    const { byServer, notes } = buildToolStats(events, "root");
    expect(byServer).toEqual([
      { server: "github", calls: 2, failed: 0 },
      { server: "slack", calls: 1, failed: 0 },
    ]);
    expect(notes.some((n) => n.includes("3 tools come from MCP server github, slack."))).toBe(true);
  });

  it("parses attrs given as a JSON string", () => {
    const events: OmniEvent[] = [
      ev({
        rowid: 1,
        event_id: "e1",
        kind: "tool.end",
        session_id: "root",
        attrs: JSON.stringify({ tool_name: "curl", status: "ok", duration_ms: 2500, result_chars: 7 }),
      }),
    ];
    const { tools } = buildToolStats(events, "root");
    expect(tools[0].name).toBe("curl");
    expect(tools[0].medianSeconds).toBeCloseTo(2.5);
    expect(tools[0].resultChars).toBe(7);
  });

  it("returns empty tools and a note when nothing recorded", () => {
    const { tools, notes } = buildToolStats([], "root");
    expect(tools).toEqual([]);
    expect(notes.some((n) => n.includes("No tool calls were recorded"))).toBe(true);
  });

  it("sorts by calls descending", () => {
    const events: OmniEvent[] = [
      toolEnd(1, "a"),
      toolEnd(2, "b"),
      toolEnd(3, "b"),
      toolEnd(4, "b"),
    ];
    const { tools } = buildToolStats(events, "root");
    expect(tools.map((t) => t.name)).toEqual(["b", "a"]);
  });
});
