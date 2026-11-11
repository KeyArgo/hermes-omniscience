import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OmniEvent } from "../types";
import { buildFlame, type FlameBlock } from "../graph/flame";
import "./FlameView.css";

const ROW_H = 22;
const MIN_BLOCK_PX = 1;
const LABEL_MIN_PX = 40;
const MAX_ZOOM = 50;

interface Props {
  events: OmniEvent[];
  rootSessionId: string | null;
  nowTs: number;
  onSelectEvent: (eventId: string) => void;
}

interface ViewState {
  zoom: number;
  panX: number;
}

function kindColor(kind: FlameBlock["kind"]): string {
  switch (kind) {
    case "turn":
      return "#6b7280";
    case "model":
      return "var(--cyan)";
    case "tool":
      return "#64748b";
    case "background":
      return "#a78bfa";
    case "helper":
      return "var(--amber)";
    case "chat":
      return "#374151";
    default:
      return "var(--muted)";
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

export function FlameView({ events, rootSessionId, nowTs, onSelectEvent }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 400 });
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; panX: number } | null>(null);
  const pinchRef = useRef<{ dist: number; zoom: number; centerX: number } | null>(null);

  const flame = useMemo(
    () => buildFlame(events, rootSessionId, nowTs),
    [events, rootSessionId, nowTs]
  );

  const maxDepth = useMemo(() => {
    let m = 0;
    for (const b of flame.blocks) if (b.depth > m) m = b.depth;
    return m;
  }, [flame]);

  const totalRows = maxDepth + 1;
  const contentHeight = totalRows * ROW_H + 8;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const span = Math.max(1, flame.end - flame.start);
  const baseScale = size.w / span;

  const clampPan = useCallback(
    (panX: number, zoom: number): number => {
      const scaledSpan = span * baseScale * zoom;
      const maxPan = Math.max(0, scaledSpan - size.w);
      return Math.min(0, Math.max(-maxPan, panX));
    },
    [span, baseScale, size.w]
  );

  const zoomAt = useCallback(
    (factor: number, clientX: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const localX = clientX - rect.left;
      setView((prev) => {
        const newZoom = Math.min(MAX_ZOOM, Math.max(1, prev.zoom * factor));
        // world coordinate under cursor before zoom
        const worldX = (localX - prev.panX) / (baseScale * prev.zoom);
        const newPanX = localX - worldX * baseScale * newZoom;
        return { zoom: newZoom, panX: clampPan(newPanX, newZoom) };
      });
    },
    [baseScale, clampPan]
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      zoomAt(factor, e.clientX);
    },
    [zoomAt]
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, panX: view.panX };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [view.panX]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      setView((prev) => ({ ...prev, panX: clampPan(d.panX + dx, prev.zoom) }));
    },
    [clampPan]
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const centerX = (t0.clientX + t1.clientX) / 2;
      pinchRef.current = { dist, zoom: view.zoom, centerX };
    }
  }, [view.zoom]);

  const onTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length === 2 && pinchRef.current) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const factor = dist / pinchRef.current.dist;
        zoomAt(factor, pinchRef.current.centerX);
      }
    },
    [zoomAt]
  );

  const onTouchEnd = useCallback(() => {
    pinchRef.current = null;
  }, []);

  const onDoubleClick = useCallback(
    (block: FlameBlock) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const blockStartPx = (block.start - flame.start) * baseScale;
      const blockEndPx = (block.end - flame.start) * baseScale;
      const blockW = Math.max(MIN_BLOCK_PX, blockEndPx - blockStartPx);
      const targetZoom = Math.min(MAX_ZOOM, Math.max(1, size.w / Math.max(1, blockW)));
      const centerWorld = (block.start + block.end) / 2 - flame.start;
      const newPanX = size.w / 2 - centerWorld * baseScale * targetZoom;
      setView({ zoom: targetZoom, panX: clampPan(newPanX, targetZoom) });
      void rect;
    },
    [flame.start, baseScale, size.w, clampPan]
  );

  const onSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const z = Number(e.target.value);
      const el = containerRef.current;
      const centerX = el ? el.clientWidth / 2 : size.w / 2;
      setView((prev) => {
        const worldX = (centerX - prev.panX) / (baseScale * prev.zoom);
        const newPanX = centerX - worldX * baseScale * z;
        return { zoom: z, panX: clampPan(newPanX, z) };
      });
    },
    [baseScale, clampPan, size.w]
  );

  // Visible world range for culling.
  const visibleStart = flame.start + (-view.panX) / (baseScale * view.zoom);
  const visibleEnd = flame.start + (size.w - view.panX) / (baseScale * view.zoom);

  const visibleBlocks = useMemo(() => {
    const out: FlameBlock[] = [];
    for (const b of flame.blocks) {
      if (b.end < visibleStart || b.start > visibleEnd) continue;
      out.push(b);
    }
    return out;
  }, [flame.blocks, visibleStart, visibleEnd]);

  const scale = baseScale * view.zoom;

  return (
    <div className="fl-root">
      <div className="fl-toolbar">
        <span className="fl-zoom-label">zoom {view.zoom.toFixed(1)}x</span>
        <input
          className="fl-slider"
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.1}
          value={view.zoom}
          onChange={onSlider}
          aria-label="zoom"
        />
        <button
          className="fl-reset"
          onClick={() => setView({ zoom: 1, panX: 0 })}
          type="button"
        >
          reset
        </button>
      </div>
      <div
        ref={containerRef}
        className="fl-canvas"
        style={{ height: contentHeight }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <svg
          className="fl-svg"
          width={size.w}
          height={contentHeight}
          viewBox={`0 0 ${size.w} ${contentHeight}`}
        >
          {visibleBlocks.map((b) => {
            const x = (b.start - flame.start) * scale + view.panX;
            const w = Math.max(MIN_BLOCK_PX, (b.end - b.start) * scale);
            const y = b.depth * ROW_H + 4;
            const isError = b.status === "error";
            const isRunning = b.status === "running";
            const fill = kindColor(b.kind);
            const selected = selectedId === b.id;
            const labelChars = Math.floor((w - 8) / 6.5);
            const showLabel = w > LABEL_MIN_PX && labelChars > 2;
            const label = showLabel ? truncate(b.label, labelChars) : "";
            const dur = b.end - b.start;
            const title = `${b.label} — ${fmtDuration(dur)}${b.kind === "model" || b.kind === "tool" ? "" : ""}`;
            return (
              <g key={b.id}>
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={ROW_H - 4}
                  rx={2}
                  fill={fill}
                  fillOpacity={isRunning ? 0.55 : 0.85}
                  stroke={isError ? "var(--red)" : selected ? "var(--text)" : "var(--line-2)"}
                  strokeWidth={isError || selected ? 1.5 : 0.5}
                  className="fl-block"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(b.id);
                    const last = b.eventIds[b.eventIds.length - 1];
                    if (last) onSelectEvent(last);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onDoubleClick(b);
                  }}
                >
                  <title>{title}</title>
                </rect>
                {showLabel && (
                  <text
                    x={x + 4}
                    y={y + ROW_H / 2 - 2}
                    className="fl-label"
                    pointerEvents="none"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
