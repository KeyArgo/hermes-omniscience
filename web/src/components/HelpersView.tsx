import { useMemo } from "react";
import type { OmniEvent } from "../types";
import { buildHelpers, type HelperRow } from "../graph/orchestration";
import "./HelpersView.css";

interface Props {
  events: OmniEvent[];
  rootSessionId: string | null;
  onSelectEvent: (eventId: string) => void;
}

interface FlatLane {
  row: HelperRow;
  depth: number;
}

function flatten(rows: HelperRow[], depth: number, out: FlatLane[]): void {
  for (const r of rows) {
    out.push({ row: r, depth });
    flatten(r.children, depth + 1, out);
  }
}

function fmtTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "hp-bar--fail";
  if (s.includes("run")) return "hp-bar--run";
  return "hp-bar--ok";
}

export default function HelpersView({ events, rootSessionId, onSelectEvent }: Props) {
  const nowTs = useMemo(() => {
    let latest = 0;
    for (const ev of events) {
      if (typeof ev.ts === "number" && ev.ts > latest) latest = ev.ts;
    }
    return latest || Date.now() / 1000;
  }, [events]);

  const { helpers, maxParallel, notes } = useMemo(
    () => buildHelpers(events, rootSessionId, nowTs),
    [events, rootSessionId, nowTs],
  );

  const lanes = useMemo(() => {
    const out: FlatLane[] = [];
    flatten(helpers, 0, out);
    return out;
  }, [helpers]);

  const bounds = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const lane of lanes) {
      if (lane.row.start < min) min = lane.row.start;
      const e = lane.row.end ?? nowTs;
      if (e > max) max = e;
      if (lane.row.start > max) max = lane.row.start;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (max - min < 1) max = min + 1;
    return { min, max };
  }, [lanes, nowTs]);

  if (lanes.length === 0) {
    return (
      <section className="hp" aria-label="Helper agents">
        <p className="hp-empty">This chat did not start any helper agents.</p>
      </section>
    );
  }

  const span = bounds ? bounds.max - bounds.min : 1;

  const pct = (t: number): number => ((t - (bounds ? bounds.min : 0)) / span) * 100;

  return (
    <section className="hp" aria-label="Helper agents">
      <header className="hp-head">
        <h2 className="hp-title">Helper agents</h2>
        <span className="hp-parallel">
          up to {maxParallel} at the same time
        </span>
      </header>

      {notes.length > 0 && (
        <ul className="hp-notes">
          {notes.map((n, i) => (
            <li key={i} className="hp-note">
              {n}
            </li>
          ))}
        </ul>
      )}

      <div className="hp-lane-area">
        {bounds && (
          <div className="hp-axis" aria-hidden="true">
            <span className="hp-axis-tick">{fmtTime(bounds.min)}</span>
            <span className="hp-axis-tick hp-axis-tick--mid">{fmtTime(bounds.min + span / 2)}</span>
            <span className="hp-axis-tick hp-axis-tick--end">{fmtTime(bounds.max)}</span>
          </div>
        )}
        {lanes.map(({ row, depth }) => {
          const left = Math.max(0, Math.min(100, pct(row.start)));
          const endT = row.end ?? nowTs;
          const right = Math.max(0, Math.min(100, pct(endT)));
          const width = Math.max(1.5, right - left);
          const model = row.models.length > 0 ? row.models[0] : "no model calls";
          const label = `${row.role ?? "helper"} · ${model} · ${row.modelCalls} call${row.modelCalls === 1 ? "" : "s"} · ${row.tools} tool${row.tools === 1 ? "" : "s"}`;
          return (
            <div
              key={row.sessionId}
              className="hp-lane"
              style={{ paddingLeft: `${depth * 14}px` }}
            >
              <button
                type="button"
                className="hp-bar-btn"
                onClick={() => onSelectEvent(row.startEventId)}
                title={`${label} — ${row.status}`}
              >
                <span className="hp-lane-label">{label}</span>
                <span className="hp-track">
                  <span
                    className={`hp-bar ${statusClass(row.status)}${row.end === null ? " hp-bar--open" : ""}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                </span>
                <span className={`hp-status hp-status--${statusClass(row.status).replace("hp-bar--", "")}`}>
                  {row.end === null ? "running" : row.status}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
