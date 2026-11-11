import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTimeline } from '../graph/timeline';
import type { OmniEvent } from '../types';
import type { TimeBar } from '../graph/timeline';
import './TimeView.css';

interface Props {
  events: OmniEvent[];
  nowTs: number;
  onSelectEvent: (eventId: string) => void;
}

const LANE_HEIGHT = 22;
const LABEL_WIDTH = 90;

function fmtTick(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m ${String(r).padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function barTitle(bar: TimeBar): string {
  const parts: string[] = [bar.label];
  if (bar.model) {
    if (bar.fallback && bar.requestedModel) {
      parts.push(`requested ${bar.requestedModel}, answered by ${bar.model}`);
    } else {
      parts.push(`model ${bar.model}`);
    }
  }
  parts.push(`duration ${fmtTick(bar.end - bar.start)}`);
  if (typeof bar.ttfb === 'number') parts.push(`ttfb ${fmtTick(bar.ttfb)}`);
  if (bar.errors.length) {
    const errs = bar.errors.map((e) => `${e.reason}${e.statusCode ? ` ${e.statusCode}` : ''}`);
    parts.push(`errors: ${errs.join(', ')}`);
  }
  return parts.join(' · ');
}

export function TimeView({ events, nowTs, onSelectEvent }: Props) {
  const timeline = useMemo(() => buildTimeline(events, nowTs), [events, nowTs]);
  const [zoom, setZoom] = useState(1);

  const total = Math.max(1e-6, timeline.end - timeline.start);
  // Zoom 1x fits the whole run into the visible width.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(800);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setTrackWidth(Math.max(200, el.clientWidth - LABEL_WIDTH - 8)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const span = trackWidth * zoom;
  const px = (seconds: number) => (seconds / total) * span;

  return (
    <div className="tv-root">
      <div className="tv-findings">
        {timeline.findings.length === 0 ? (
          <div className="tv-findings-empty">No provider problems recorded in the loaded events.</div>
        ) : (
          <ul className="tv-findings-list">
            {timeline.findings.map((f, i) => (
              <li key={i} className="tv-finding">
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="tv-controls">
        <label className="tv-zoom-label">
          zoom
          <input
            className="tv-zoom"
            type="range"
            min={1}
            max={50}
            step={1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <span className="tv-zoom-val">{zoom}x</span>
        </label>
      </div>

      <div className="tv-scroll" ref={scrollRef}>
        <div className="tv-inner" style={{ width: `calc(${LABEL_WIDTH}px + ${span}px)` }}>
          {/* time axis */}
          <div className="tv-axis-row">
            <div className="tv-axis-label" />
            <div className="tv-axis-track" style={{ width: `${span}px` }}>
              {Array.from({ length: 7 }, (_, i) => {
                const frac = i / 6;
                return (
                  <div key={i} className="tv-tick" style={{ left: `${frac * 100}%` }}>
                    <span className="tv-tick-line" />
                    <span className="tv-tick-text">{fmtTick(total * frac)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* lanes */}
          {timeline.lanes.map((lane) => (
            <div key={lane} className="tv-lane-row" style={{ height: LANE_HEIGHT }}>
              <div className="tv-lane-label">{lane}</div>
              <div className="tv-lane-track" style={{ width: `${span}px` }}>
                {timeline.bars
                  .filter((b) => b.lane === lane)
                  .map((bar) => {
                    const left = px(bar.start - timeline.start);
                    const width = Math.max(2, px(bar.end - bar.start));
                    const cls = [
                      'tv-bar',
                      `tv-bar-${bar.kind}`,
                      bar.status === 'error' ? 'tv-bar-error' : '',
                      bar.status === 'running' ? 'tv-bar-running' : '',
                      bar.fallback ? 'tv-bar-fallback' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <div
                        key={bar.id}
                        className={cls}
                        style={{ left, width }}
                        title={barTitle(bar)}
                        onClick={() => {
                          const id = bar.eventIds[bar.eventIds.length - 1];
                          if (id) onSelectEvent(id);
                        }}
                      >
                        {bar.errors.map((e, i) => {
                          const at = ((e.at - bar.start) / Math.max(1e-6, bar.end - bar.start)) * 100;
                          return (
                            <span
                              key={i}
                              className="tv-tick-mark"
                              style={{ left: `${Math.min(100, Math.max(0, at))}%` }}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
