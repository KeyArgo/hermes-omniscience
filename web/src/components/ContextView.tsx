import { shouldLogScale } from '../graph/scale';
import { useEffect, useMemo, useRef, useState } from "react";
import { buildContext, type ContextCall } from "../graph/context";
import type { OmniEvent } from "../types";
import "./ContextView.css";

interface Props {
  events: OmniEvent[];
  rootSessionId: string | null;
  onSelectEvent: (eventId: string) => void;
  /**
   * Draw the small version that sits under a chat's summary: fewer gridlines, no
   * per-point dots on busy chats, and an expand control to read it at full size.
   */
  compact?: boolean;
}

const FULL_HEIGHT = 220;
const INLINE_HEIGHT = 132;
const FULL_PAD = { top: 16, right: 16, bottom: 28, left: 52 };
const INLINE_PAD = { top: 10, right: 12, bottom: 22, left: 44 };
/** Bottom of a logarithmic axis: real chats do not live below this, so do not spend height there. */
const LOG_FLOOR = 1000;

/** Full precision, for tooltips and the "up to N tokens" sentence. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Axis labels are short on purpose. "512,251" needs about 44px at this size and the label sits
 * inside the plot's left padding, so the full number was clipped against the edge and read as a
 * cropped figure. "512k" is unmistakable and fits; the exact value is one hover away.
 */
/** A clock time in the reader's own timezone, from a recorder timestamp in seconds. */
function clock(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtAxis(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export function ContextView({ events, rootSessionId, onSelectEvent, compact = false }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Esc closes the enlarged chart, like every other panel overlay here.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const { calls, summary } = useMemo(
    () => buildContext(events, rootSessionId),
    [events, rootSessionId]
  );

  const height = compact ? INLINE_HEIGHT : FULL_HEIGHT;
  const PAD = compact ? INLINE_PAD : FULL_PAD;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;

  const maxPrompt = useMemo(() => {
    let m = 0;
    for (const c of calls) if (c.prompt != null && c.prompt > m) m = c.prompt;
    return m || 1;
  }, [calls]);

  // A linear axis is set by the peak, so after a compaction a 60k chat next to its own 517k peak
  // collapses into a flat line at the bottom and the picture says "nothing is happening". When the
  // newest size is a small fraction of the peak, the axis goes logarithmic: both ends stay visible
  // and every tick is labelled, so nothing is exaggerated — the exact numbers are unchanged.
  const lastValue = useMemo(() => {
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      if (calls[i].prompt != null) return calls[i].prompt as number;
    }
    return null;
  }, [calls]);
  // The peak alone decides a linear axis, so one enormous first call flattens everything after it
  // into a line along the floor of an empty box. Comparing the peak with the *median* call catches
  // that shape — a single outlier — where comparing it with the last call misses it whenever the
  // chat ended big. Every tick stays labelled, so a log axis hides no numbers.
  const medianPrompt = useMemo(() => {
    const values = calls.map((c) => c.prompt).filter((v): v is number => typeof v === 'number' && v > 0);
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }, [calls]);
  const logScale = shouldLogScale(maxPrompt, medianPrompt, lastValue);

  const xFor = (i: number) =>
    calls.length <= 1 ? PAD.left + plotW / 2 : PAD.left + (i / (calls.length - 1)) * plotW;
  // The log axis is anchored at 1k rather than at 1: below a thousand tokens nothing in a real
  // chat lives, and anchoring at 1 spends most of the height on a range nobody is in.
  const logShare = (v: number) => {
    const floor = Math.log10(LOG_FLOOR);
    const ceiling = Math.log10(Math.max(LOG_FLOOR * 10, maxPrompt));
    const value = Math.log10(Math.max(LOG_FLOOR, v));
    return Math.min(1, Math.max(0, (value - floor) / (ceiling - floor)));
  };
  const yFor = (v: number) => {
    if (!logScale) return PAD.top + plotH - (v / maxPrompt) * plotH;
    return PAD.top + plotH - logShare(v) * plotH;
  };
  /** The value each gridline marks, given its position up the axis. */
  const axisValue = (share: number) => {
    if (!logScale) return Math.round(share * maxPrompt);
    const floor = Math.log10(LOG_FLOOR);
    const ceiling = Math.log10(Math.max(LOG_FLOOR * 10, maxPrompt));
    return Math.round(Math.pow(10, floor + share * (ceiling - floor)));
  };

  // Turn boundary ticks: index where turnIndex changes.
  const boundaries = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < calls.length; i++) {
      if (calls[i].turnIndex !== calls[i - 1].turnIndex) out.push(i);
    }
    return out;
  }, [calls]);

  const linePath = useMemo(() => {
    const pts = calls
      .map((c, i) => (c.prompt != null ? `${xFor(i)},${yFor(c.prompt)}` : null))
      .filter(Boolean) as string[];
    return pts.length ? "M" + pts.join(" L") : "";
  }, [calls, width, maxPrompt, height]);

  const areaPath = useMemo(() => {
    const pts = calls
      .map((c, i) => (c.prompt != null ? `${xFor(i)},${yFor(c.prompt)}` : null))
      .filter(Boolean) as string[];
    if (!pts.length) return "";
    const firstX = xFor(calls.findIndex((c) => c.prompt != null));
    const lastIdx = calls.map((c) => c.prompt).lastIndexOf(null) === -1 ? calls.length - 1 : calls.length - 1;
    const lastX = xFor(lastIdx);
    const base = PAD.top + plotH;
    return `M${firstX},${base} L${pts.join(" L")} L${lastX},${base} Z`;
  }, [calls, width, maxPrompt, height]);

  const cachedPath = useMemo(() => {
    const pts = calls
      .map((c, i) =>
        c.prompt != null && c.cached != null ? `${xFor(i)},${yFor(c.cached)}` : null
      )
      .filter(Boolean) as string[];
    if (!pts.length) return "";
    const firstIdx = calls.findIndex((c) => c.prompt != null && c.cached != null);
    const lastIdx = calls.reduce((acc, c, i) => (c.prompt != null && c.cached != null ? i : acc), firstIdx);
    const firstX = xFor(firstIdx);
    const lastX = xFor(lastIdx);
    const base = PAD.top + plotH;
    return `M${firstX},${base} L${pts.join(" L")} L${lastX},${base} Z`;
  }, [calls, width, maxPrompt, height]);

  const hovered: ContextCall | null = hover != null ? calls[hover] ?? null : null;
  // Dots on every call turn a 400-call chat into a smear; the line carries it.
  const showDots = calls.length <= (compact ? 90 : 220);
  const timeTicks = useMemo(() => {
    if (calls.length === 0) return [];
    const positions = compact ? [0, 1] : [0, 0.5, 1];
    return positions.map((share, position) => {
      const index = Math.round(share * (calls.length - 1));
      const anchor: "start" | "middle" | "end" =
        position === 0 ? "start" : position === positions.length - 1 ? "end" : "middle";
      return { index, label: clock(calls[index]?.ts), anchor };
    });
  }, [calls, compact]);
  // Linear: even fractions. Log: whole decades, so the labels are numbers a reader recognises
  // instead of whatever a midpoint happens to be (1 / 719 / 517k was the first attempt).
  const ticks = useMemo(() => {
    if (!logScale) return compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
    const decades = [LOG_FLOOR, 10_000, 100_000, 1_000_000].filter((v) => v < maxPrompt);
    return [...decades.map(logShare), 1];
  }, [logScale, compact, maxPrompt]);

  const scaleNote = logScale ? (
    <div className="cx-scale-note" title="A linear axis would squash everything after a compaction into a flat line. Every gridline is labelled, so the shape is still exact.">
      vertical axis is logarithmic here — the peak before compaction and the size now both stay
      visible
    </div>
  ) : null;

  const chart = (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Prompt tokens per model call, ${calls.length} calls, up to ${fmt(maxPrompt)} tokens${
        logScale ? ", log scale so small values stay visible" : ""
      }`}
    >
      {ticks.map((f) => {
        const y = PAD.top + plotH - f * plotH;
        const val = axisValue(f);
        return (
          <g key={f}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} className="cx-grid" />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" className="cx-axis">
              {fmtAxis(val)}
            </text>
          </g>
        );
      })}

      {boundaries.map((i) => (
        <line
          key={i}
          x1={xFor(i)}
          x2={xFor(i)}
          y1={PAD.top}
          y2={PAD.top + plotH}
          className="cx-bound"
        />
      ))}

      {/* Where the context fell back — drawn, not just described. */}
      {summary.drops.map((drop) => (
        <g key={`drop-${drop.index}`}>
          <line
            x1={xFor(drop.index)}
            x2={xFor(drop.index)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="cx-drop"
          />
          <circle
            cx={xFor(drop.index)}
            cy={yFor(drop.to)}
            r={compact ? 3.5 : 4.5}
            className="cx-drop-dot"
          />
        </g>
      ))}

      {/* The whole plot is a hover target: reading a value should not require hitting a 3px dot. */}
      <rect
        x={PAD.left}
        y={PAD.top}
        width={plotW}
        height={plotH}
        fill="transparent"
        style={{ pointerEvents: "all" }}
        onMouseMove={(event) => {
          const box = (event.currentTarget as SVGRectElement).getBoundingClientRect();
          if (box.width <= 0) return;
          const share = (event.clientX - box.left) / box.width;
          const index = Math.round(share * Math.max(0, calls.length - 1));
          setHover(Math.max(0, Math.min(calls.length - 1, index)));
        }}
        onMouseLeave={() => setHover(null)}
      />

      <path d={areaPath} className="cx-area" />
      <path d={cachedPath} className="cx-cached" />
      <path d={linePath} className="cx-line" />

      {showDots
        ? calls.map((c, i) =>
            c.prompt != null ? (
              <circle
                key={c.eventId}
                cx={xFor(i)}
                cy={yFor(c.prompt)}
                r={hover === i ? 5 : compact ? 2.5 : 3}
                className="cx-point"
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => onSelectEvent(c.eventId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectEvent(c.eventId);
                  }
                }}
              />
            ) : null
          )
        : null}

      {hovered && hovered.prompt != null && (
        <g pointerEvents="none">
          <line
            x1={xFor(hover!)}
            x2={xFor(hover!)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="cx-hover-line"
          />
          <g
            transform={`translate(${Math.min(
              xFor(hover!) + 8,
              width - PAD.right - 178
            )}, ${Math.max(PAD.top, Math.min(height - PAD.bottom - 78, yFor(hovered.prompt) - 40))})`}
          >
            <rect width={178} height={78} rx={6} className="cx-tip-bg" />
            <text x={8} y={15} className="cx-tip cx-tip-head">
              {clock(hovered.ts)} · call #{hover! + 1}
            </text>
            <text x={8} y={32} className="cx-tip">
              Context: {fmt(hovered.prompt)}
            </text>
            <text x={8} y={48} className="cx-tip">
              Cached: {hovered.cached != null ? fmt(hovered.cached) : "—"}
            </text>
            <text x={8} y={64} className="cx-tip">
              Msgs: {hovered.messages ?? "—"} · Tools: {hovered.tools ?? "—"}
            </text>
          </g>
        </g>
      )}

      {/* Horizontal scale: when this happened, in the reader's own clock. */}
      {timeTicks.map((tick) => (
        <text
          key={tick.index}
          x={xFor(tick.index)}
          y={height - 8}
          textAnchor={tick.anchor}
          className="cx-axis cx-axis-time"
        >
          {tick.label}
        </text>
      ))}
    </svg>
  );

  const notes = (
    <div className="cx-notes">
      {summary.notes.length === 0 ? (
        <div className="cx-note cx-note-empty">No model calls recorded yet.</div>
      ) : (
        summary.notes.map((n, i) => (
          <div className="cx-note" key={i}>
            {n}
          </div>
        ))
      )}
    </div>
  );

  if (!compact) {
    return (
      <div className="cx-wrap" ref={wrapRef}>
        {notes}
        {scaleNote}
        <div className="cx-chart">{chart}</div>
      </div>
    );
  }

  return (
    <div className="cx-wrap cx-inline" ref={wrapRef}>
      <div className="cx-inline-head">
        <span className="cx-inline-title">Context per call</span>
        <button
          type="button"
          className="cx-expand"
          onClick={() => setExpanded(true)}
          aria-label="Show this chart larger"
          title="Show this chart larger, centred. Esc closes it."
        >
          ⤢
        </button>
      </div>
      {notes}
      {scaleNote}
      <div className="cx-chart">{chart}</div>

      {expanded ? (
        <div
          className="cx-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Context per call, enlarged"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
        >
          <div className="cx-overlay-card">
            <div className="cx-overlay-head">
              <span>Context per call</span>
              <button
                type="button"
                className="cx-close"
                onClick={() => setExpanded(false)}
                aria-label="Close"
              >
                Esc
              </button>
            </div>
            <ContextView
              events={events}
              rootSessionId={rootSessionId}
              onSelectEvent={(id) => {
                setExpanded(false);
                onSelectEvent(id);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
