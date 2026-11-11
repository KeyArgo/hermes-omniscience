import type { OmniEvent } from "../types";

export interface ToolStat {
  name: string;
  server: string | null;
  calls: number;
  failed: number;
  totalSeconds: number;
  medianSeconds: number | null;
  maxSeconds: number | null;
  resultChars: number;
  longestRun: number;
  argNames: string[];
  lastEventId: string;
  failEventIds: string[];
}

function parseAttrs(e: OmniEvent): Record<string, unknown> {
  if (e.attrs == null) return {};
  if (typeof e.attrs === "string") {
    try {
      const p = JSON.parse(e.attrs);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return e.attrs;
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
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmtSeconds(n: number): string {
  if (n >= 100) return `${Math.round(n)}s`;
  if (n >= 10) return `${n.toFixed(1)}s`;
  if (n >= 1) return `${n.toFixed(2)}s`;
  return `${n.toFixed(3)}s`;
}

function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

interface Acc {
  name: string;
  server: string | null;
  calls: number;
  failed: number;
  totalSeconds: number;
  durations: number[];
  resultChars: number;
  longestRun: number;
  curRun: number;
  argSet: Set<string>;
  lastEventId: string;
  failEventIds: string[];
}

export function buildToolStats(
  events: OmniEvent[],
  rootSessionId: string | null,
): { tools: ToolStat[]; byServer: { server: string; calls: number; failed: number }[]; notes: string[] } {
  const sessions = new Set<string>();
  if (rootSessionId) sessions.add(rootSessionId);
  for (const e of events) {
    if (e.kind === "subagent.start") {
      const a = parseAttrs(e);
      const child = str(a.child_session_id);
      if (child) sessions.add(child);
    }
    if (e.parent_session_id) {
      sessions.add(e.parent_session_id);
      if (e.session_id) sessions.add(e.session_id);
    }
  }

  const relevant = events.filter((e) => {
    if (e.kind !== "tool.end") return false;
    if (e.session_id == null) return false;
    return sessions.has(e.session_id);
  });

  const acc = new Map<string, Acc>();
  const lastByTool = new Map<string, number>();

  for (const e of relevant) {
    const a = parseAttrs(e);
    const name = str(a.tool_name) ?? "unknown";
    const server = str(a.mcp_server);
    const key = `${name}\u0000${server ?? ""}`;

    let s = acc.get(key);
    if (!s) {
      s = {
        name,
        server,
        calls: 0,
        failed: 0,
        totalSeconds: 0,
        durations: [],
        resultChars: 0,
        longestRun: 0,
        curRun: 0,
        argSet: new Set<string>(),
        lastEventId: e.event_id,
        failEventIds: [],
      };
      acc.set(key, s);
    }

    s.calls += 1;
    s.lastEventId = e.event_id;

    const status = str(a.status);
    if (status === "error") {
      s.failed += 1;
      s.failEventIds.push(e.event_id);
    }

    const durMs = num(a.duration_ms);
    if (durMs != null) {
      const sec = durMs / 1000;
      s.totalSeconds += sec;
      s.durations.push(sec);
    }

    const rc = num(a.result_chars);
    if (rc != null) s.resultChars += rc;

    const argNames = a.arg_names;
    if (Array.isArray(argNames)) {
      for (const an of argNames) {
        if (typeof an === "string" && an.length > 0) s.argSet.add(an);
      }
    }

    const prev = lastByTool.get(name);
    if (prev != null && prev === e.rowid - 1) {
      s.curRun += 1;
    } else {
      s.curRun = 1;
    }
    if (s.curRun > s.longestRun) s.longestRun = s.curRun;
    lastByTool.set(name, e.rowid);
  }

  const tools: ToolStat[] = [];
  for (const s of acc.values()) {
    tools.push({
      name: s.name,
      server: s.server,
      calls: s.calls,
      failed: s.failed,
      totalSeconds: s.totalSeconds,
      medianSeconds: median(s.durations),
      maxSeconds: s.durations.length ? Math.max(...s.durations) : null,
      resultChars: s.resultChars,
      longestRun: s.longestRun,
      argNames: [...s.argSet].sort(),
      lastEventId: s.lastEventId,
      failEventIds: s.failEventIds,
    });
  }

  tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const serverMap = new Map<string, { calls: number; failed: number }>();
  for (const t of tools) {
    if (!t.server) continue;
    const cur = serverMap.get(t.server) ?? { calls: 0, failed: 0 };
    cur.calls += t.calls;
    cur.failed += t.failed;
    serverMap.set(t.server, cur);
  }
  const byServer = [...serverMap.entries()]
    .map(([server, v]) => ({ server, calls: v.calls, failed: v.failed }))
    .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));

  const notes: string[] = [];
  const maxRun = tools.reduce((m, t) => Math.max(m, t.longestRun), 0);
  if (maxRun >= 2) {
    const t = tools.find((x) => x.longestRun === maxRun);
    if (t) notes.push(`${t.name} was called ${fmtCount(maxRun)} times in a row at most.`);
  }
  if (byServer.length > 0) {
    const totalMcpTools = tools.filter((t) => t.server).length;
    const servers = byServer.map((s) => s.server).join(", ");
    notes.push(`${fmtCount(totalMcpTools)} tools come from MCP server ${servers}.`);
  }
  const totalCalls = tools.reduce((m, t) => m + t.calls, 0);
  const totalFailed = tools.reduce((m, t) => m + t.failed, 0);
  if (totalCalls > 0) {
    notes.push(`${fmtCount(totalCalls)} tool calls recorded, ${fmtCount(totalFailed)} reported an error.`);
  }
  if (tools.length === 0) {
    notes.push("No tool calls were recorded for this session.");
  }

  return { tools, byServer, notes };
}

export { fmtSeconds, fmtCount };
