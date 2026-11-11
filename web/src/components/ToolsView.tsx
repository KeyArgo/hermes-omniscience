import { useMemo, useState } from "react";
import type { OmniEvent } from "../types";
import { buildToolStats, fmtSeconds, fmtCount } from "../graph/tools";
import "./ToolsView.css";

interface Props {
  events: OmniEvent[];
  rootSessionId: string | null;
  onSelectEvent: (eventId: string) => void;
}

export function ToolsView({ events, rootSessionId, onSelectEvent }: Props) {
  const { tools, byServer, notes } = useMemo(
    () => buildToolStats(events, rootSessionId),
    [events, rootSessionId],
  );
  const [failIdx, setFailIdx] = useState<Record<string, number>>({});

  const maxTotal = tools.reduce((m, t) => Math.max(m, t.totalSeconds), 0);

  if (tools.length === 0) {
    return (
      <div className="tl-wrap">
        <div className="tl-empty">No tool calls were recorded for this session.</div>
      </div>
    );
  }

  return (
    <div className="tl-wrap">
      {notes.length > 0 && (
        <ul className="tl-notes">
          {notes.map((n, i) => (
            <li key={i} className="tl-note">
              {n}
            </li>
          ))}
        </ul>
      )}

      {byServer.length > 0 && (
        <div className="tl-servers">
          {byServer.map((s) => (
            <span key={s.server} className="tl-server">
              <span className="tl-server-name">{s.server}</span>
              <span className="tl-server-count">{fmtCount(s.calls)} calls</span>
              {s.failed > 0 && <span className="tl-server-fail">{fmtCount(s.failed)} failed</span>}
            </span>
          ))}
        </div>
      )}

      <div className="tl-table" role="table" aria-label="Tools used">
        <div className="tl-head" role="row">
          <span className="tl-col tl-col-name" role="columnheader">Tool</span>
          <span className="tl-col tl-col-num" role="columnheader">Calls</span>
          <span className="tl-col tl-col-num" role="columnheader">Failed</span>
          <span className="tl-col tl-col-bar" role="columnheader">Share of time</span>
          <span className="tl-col tl-col-num" role="columnheader">Median</span>
          <span className="tl-col tl-col-num" role="columnheader">Max</span>
          <span className="tl-col tl-col-num" role="columnheader">Longest run</span>
          <span className="tl-col tl-col-args" role="columnheader">Settings</span>
        </div>

        {tools.map((t) => {
          const share = maxTotal > 0 ? t.totalSeconds / maxTotal : 0;
          const idx = failIdx[t.name] ?? 0;
          const hasFails = t.failEventIds.length > 0;
          return (
            <div
              key={`${t.name}\u0000${t.server ?? ""}`}
              className="tl-row"
              role="row"
              tabIndex={0}
              onClick={() => onSelectEvent(t.lastEventId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectEvent(t.lastEventId);
                }
              }}
            >
              <span className="tl-col tl-col-name" role="cell">
                <span className="tl-name">{t.name}</span>
                {t.server && <span className="tl-pill">{t.server}</span>}
              </span>
              <span className="tl-col tl-col-num" role="cell">{fmtCount(t.calls)}</span>
              <span className={"tl-col tl-col-num" + (t.failed > 0 ? " tl-fail" : "")} role="cell">
                {fmtCount(t.failed)}
              </span>
              <span className="tl-col tl-col-bar" role="cell">
                <span className="tl-bar-track">
                  <span className="tl-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
                </span>
                <span className="tl-bar-label">{fmtSeconds(t.totalSeconds)}</span>
              </span>
              <span className="tl-col tl-col-num" role="cell">
                {t.medianSeconds == null ? "—" : fmtSeconds(t.medianSeconds)}
              </span>
              <span className="tl-col tl-col-num" role="cell">
                {t.maxSeconds == null ? "—" : fmtSeconds(t.maxSeconds)}
              </span>
              <span className="tl-col tl-col-num" role="cell">{fmtCount(t.longestRun)}</span>
              <span className="tl-col tl-col-args" role="cell">
                {t.argNames.length > 0 ? (
                  <span className="tl-args">{t.argNames.join(", ")}</span>
                ) : (
                  <span className="tl-dim">—</span>
                )}
                {hasFails && (
                  <button
                    type="button"
                    className="tl-failbtn"
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = (idx + 1) % t.failEventIds.length;
                      setFailIdx((prev) => ({ ...prev, [t.name]: next }));
                      onSelectEvent(t.failEventIds[next]);
                    }}
                  >
                    show failures ({idx + 1}/{t.failEventIds.length})
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ToolsView;
