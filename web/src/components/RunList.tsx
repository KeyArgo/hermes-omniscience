import { useEffect, useMemo, useRef, useState } from "react";
import type { StepRow, TurnRow } from "../graph/rows";
import "./RunList.css";

const KIND_ICON: Record<StepRow["kind"], string> = {
  llm: "◆",
  tool: "▸",
  helper: "◎",
  background: "◌",
  error: "✕",
  gap: "…",
};

const STATUS_CLASS: Record<StepRow["status"], string> = {
  ok: "rl-ok",
  warn: "rl-warn",
  error: "rl-error",
  running: "rl-running",
};

function fmtDur(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return "";
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

function StepLine({
  step,
  selectedEventId,
  onSelectEvent,
}: {
  step: StepRow;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
}) {
  const lastId = step.eventIds[step.eventIds.length - 1];
  const selected = selectedEventId != null && step.eventIds.includes(selectedEventId);
  return (
    <div
      data-selected={selected ? "1" : undefined}
      className={`rl-step ${STATUS_CLASS[step.status]}${selected ? " rl-selected" : ""}`}
      onClick={() => lastId && onSelectEvent(lastId)}
    >
      <span className="rl-step-icon">{KIND_ICON[step.kind]}</span>
      <span className="rl-step-label">{step.label}</span>
      {step.detail ? <span className="rl-step-detail">{step.detail}</span> : null}
      <span className="rl-step-spacer" />
      {step.badges.map((b, i) => (
        <span key={i} className="rl-pill">
          {b}
        </span>
      ))}
      <span className="rl-step-dur">{fmtDur(step.seconds)}</span>
    </div>
  );
}

function TurnLine({
  turn,
  expanded,
  onToggle,
  selectedEventId,
  onSelectEvent,
}: {
  turn: TurnRow;
  expanded: boolean;
  onToggle: () => void;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
}) {
  const dimmed = turn.summary === "no problems";
  return (
    <div className={`rl-turn${dimmed ? " rl-dim" : ""}`}>
      <div className="rl-turn-head" onClick={onToggle}>
        <span className={`rl-caret${expanded ? " rl-caret-open" : ""}`}>▸</span>
        <span className={`rl-dot rl-dot-${turn.status}`} />
        <span className="rl-turn-label">{turn.label}</span>
        <span className="rl-turn-spacer" />
        {turn.badges.map((b, i) => (
          <span key={i} className="rl-pill">
            {b}
          </span>
        ))}
        <span className="rl-turn-summary">{turn.summary}</span>
      </div>
      {expanded && turn.steps.length > 0 && (
        <div className="rl-steps">
          {turn.steps.map((s) => (
            <StepLine
              key={s.id}
              step={s}
              selectedEventId={selectedEventId}
              onSelectEvent={onSelectEvent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function RunList({
  rows,
  selectedEventId,
  playing,
  follow = false,
  selectNonce = 0,
  onSelectEvent,
}: {
  rows: TurnRow[];
  selectedEventId: string | null;
  playing: boolean;
  /** Live view: keep the newest row in view while the user stays at the bottom. */
  follow?: boolean;
  /** Bumped on every pick, so picking the same step again still scrolls to it. */
  selectNonce?: number;
  onSelectEvent: (eventId: string) => void;
}) {
  const LIMIT = 400;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);

  // Auto-expand error/warn turns the first time they appear; a turn the user closed stays closed.
  const autoExpanded = useRef<Set<string>>(new Set());
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const r of rows) {
        if ((r.status === "error" || r.status === "warn") && !autoExpanded.current.has(r.id)) {
          autoExpanded.current.add(r.id);
          next.add(r.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  // Follow the newest row while replaying, or while live as long as the user is at the bottom
  // (scrolling up to read pauses following, like a packet capture).
  const atBottom = useRef(true);
  useEffect(() => {
    const scroller = containerRef.current?.closest(".rl-surface");
    if (!scroller) return;
    const onScroll = () => {
      atBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!(playing || (follow && atBottom.current))) return;
    lastRef.current?.scrollIntoView({ block: "end", behavior: playing ? "smooth" : "auto" });
  }, [rows, playing, follow]);

  // "Show me" / failure navigation: open the message that holds the step, then bring it into view.
  useEffect(() => {
    if (!selectedEventId) return;
    const turn = rows.find((r) => r.steps.some((st) => st.eventIds.includes(selectedEventId)) || r.eventIds.includes(selectedEventId));
    if (!turn) return;
    atBottom.current = false;
    setExpanded((prev) => (prev.has(turn.id) ? prev : new Set(prev).add(turn.id)));
    if (rows.indexOf(turn) < rows.length - LIMIT) setShowAll(true);
    const frame = requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector('[data-selected="1"]');
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
    // Only when a new step is picked; rows change every second while live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId, selectNonce]);

  const { visible, earlierCount } = useMemo(() => {
    if (showAll || rows.length <= LIMIT) {
      return { visible: rows, earlierCount: 0 };
    }
    const selIdx = selectedEventId
      ? rows.findIndex((r) => r.steps.some((st) => st.eventIds.includes(selectedEventId)) || r.eventIds.includes(selectedEventId))
      : -1;
    const from = Math.min(rows.length - LIMIT, selIdx >= 0 ? selIdx : rows.length);
    return {
      visible: rows.slice(Math.max(0, from)),
      earlierCount: Math.max(0, from),
    };
  }, [rows, showAll, selectedEventId]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="rl-root" ref={containerRef}>
      {earlierCount > 0 && (
        <button
          className="rl-earlier"
          onClick={() => setShowAll(true)}
          type="button"
        >
          show {earlierCount} earlier messages
        </button>
      )}
      {visible.map((turn) => (
        <TurnLine
          key={turn.id}
          turn={turn}
          expanded={expanded.has(turn.id)}
          onToggle={() => toggle(turn.id)}
          selectedEventId={selectedEventId}
          onSelectEvent={onSelectEvent}
        />
      ))}
      {playing && (
        <div className="rl-now" ref={lastRef}>
          <span className="rl-now-line" />
        </div>
      )}
    </div>
  );
}
