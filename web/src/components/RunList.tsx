import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
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

/** The parts of a keyboard event these rows care about; React's own event fits this shape. */
export type RowKeyEvent = {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  preventDefault: () => void;
};

/**
 * The tape lines are divs styled by class, not real buttons, so they activate themselves:
 * Enter and Space do what a click does, and Space must not scroll the list underneath.
 * A held key and a shortcut combination are not ours — a repeat would flip a turn open and
 * shut again, and Ctrl/Cmd/Alt+Enter belongs to whatever else is listening.
 */
export function onRowKeyDown(e: RowKeyEvent, activate: () => void): void {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Enter") {
    activate();
    return;
  }
  if (e.key !== " ") return;
  e.preventDefault();
  activate();
}

/**
 * The keys that move the focus ring, not the row. Enter and Space belong to the row itself,
 * so they are deliberately absent here.
 */
const ROVING_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * Where the one focusable row goes. No wrapping: this is a log, so ArrowDown on the last row
 * scrolls the page instead of teleporting the reader back to the start, and ArrowUp on the
 * first does the mirror. -1 means there is nothing to focus.
 */
export function moveRowFocus(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : Math.min(count - 1, current + 1);
  if (key === "ArrowUp") return current < 0 ? count - 1 : Math.max(0, current - 1);
  return current;
}

/**
 * One stable key per focusable row: a turn head, or a step inside an open turn. Every part is
 * percent-escaped, so a separator can never appear inside a key and the owner of a step key can be
 * recovered by cutting at the first "/" (see handoffKey).
 */
export const turnRowKey = (turnKey: string) => `t:${encodeURIComponent(turnKey)}`;
export const stepRowKey = (turnKey: string, stepKey: string) =>
  `s:${encodeURIComponent(turnKey)}/${encodeURIComponent(stepKey)}`;

/** rows.ts' fixed id for the steps before the first message. */
const PRE_TURN_ID = "turn:pre";
/** Its key when nothing at all is recorded; reserved, so it cannot collide with an event key. */
const PRE_TURN_KEY = "pre";

/**
 * The event that anchors a turn: its first recorded one. The row before the first message is the
 * exception — it can grow at both ends (a prepend puts older events in front, a live append puts
 * newer ones behind), so it is anchored by its newest event. That anchor is used to follow its
 * events when a prepend hands them to a real message; it is deliberately *not* its key.
 */
function turnAnchor(turn: TurnRow): string | null {
  if (turn.id === PRE_TURN_ID) {
    return turn.eventIds[turn.eventIds.length - 1] ?? null;
  }
  if (turn.eventIds.length > 0) return turn.eventIds[0];
  return turn.steps[0]?.eventIds[0] ?? null;
}

export function turnIdentity(turn: TurnRow): string {
  // The row before the first message is a slot, not an event. Its events can move out of it (a
  // prepend reveals a turn.start) or be added at either end (a live event lands before the first
  // message), so keying it by one of them would rename it — and reopen a warning the reader just
  // closed — on every append. It keeps one key for its whole life; the migration below follows its
  // events with focus and the open state when they leave.
  if (turn.id === PRE_TURN_ID) return PRE_TURN_KEY;
  const anchor = turnAnchor(turn);
  if (anchor) return `e:${anchor}`;
  // Nothing recorded at all: the clock the row started at is the only thing that cannot move.
  return `t:${turn.start}`;
}

/**
 * The event that names a step: its first, which a response or another merged call never displaces.
 */
function stepAnchor(step: StepRow): string | null {
  return step.eventIds[0] ?? null;
}

/** The positional prefix rows.ts puts on every id: `t<turn>:` for steps, `turn:<n>:` for the
 *  rows a filter adds. Two messages never share a prefix inside one turn. */
const POSITIONAL_PREFIX = /^(?:turn:(?:\d+|pre)|t\d+|pre):/;

function stepIdentity(step: StepRow): string {
  const anchor = stepAnchor(step);
  if (anchor) return `e:${anchor}`;
  // No recorded event (a "N tools hidden" row): its own id without the positional prefix. The
  // suffix stays put as the turn moves, and hiding one placeholder never renames another.
  return `i:${step.id.replace(POSITIONAL_PREFIX, "")}`;
}

/**
 * One key per row. A base only one row has stays as it is; a base two rows share (a duplicated
 * recorded id) is qualified by something that does not move with the list — the row's clock — so
 * dropping one duplicate never renames the other onto the dropped row's key. Only rows identical
 * in everything fall back to their order, where they are interchangeable anyway.
 */
function uniqueKeys(bases: readonly string[], stamp: (i: number) => string): string[] {
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  const used = new Map<string, number>();
  return bases.map((base, i) => {
    const key = counts.get(base) === 1 ? base : `${base}#${stamp(i)}`;
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return n === 0 ? key : `${key}~${n}`;
  });
}

/** A turn and its rows, each carrying the key the list keys its state by. */
export type KeyedTurn = {
  turn: TurnRow;
  key: string;
  /** The recorded event that names the turn, when it has one. */
  anchor: string | null;
  /** One key per step, parallel to `turn.steps` and unique inside this turn. */
  stepKeys: string[];
  /** The recorded event that names each step, parallel to `turn.steps`. */
  stepAnchors: (string | null)[];
};

/**
 * Key the whole list at once: duplicate bases are numbered in list order, and a prepend keeps the
 * relative order of the rows that were already there, so those numbers do not move either.
 */
export function keyedTurns(turns: TurnRow[]): KeyedTurn[] {
  const turnKeys = uniqueKeys(
    turns.map(turnIdentity),
    (i) => String(turns[i].start),
  );
  return turns.map((turn, i) => ({
    turn,
    key: turnKeys[i],
    anchor: turnAnchor(turn),
    stepKeys: uniqueKeys(
      turn.steps.map(stepIdentity),
      (s) => String(turn.steps[s].start),
    ),
    stepAnchors: turn.steps.map(stepAnchor),
  }));
}

/**
 * The keys of the whole list, plus what each row is made of. `anchorOf` and the two owner maps are
 * what let state follow the recorded events when a row is re-identified: a prefixed "t:" or "s:"
 * key names a rendered row; an owner map goes from one recorded event to the row that holds it now.
 */
export type RowLedger = {
  keyed: KeyedTurn[];
  /** Every turn identity currently on screen. */
  turnKeys: Set<string>;
  /** Rendered row key -> the recorded event that names it (null when nothing is recorded). */
  anchorOf: Map<string, string | null>;
  /** Turn identity -> the recorded event that names it. */
  turnAnchorOf: Map<string, string | null>;
  /** Recorded event -> the turn row that holds it. */
  turnOwnerRow: Map<string, string>;
  /** Recorded event -> the step row that holds it. */
  stepOwnerRow: Map<string, string>;
  /** Recorded ids more than one turn row claims: they name no row in particular. */
  turnAmbiguous: Set<string>;
  /** Recorded ids more than one step row claims. */
  stepAmbiguous: Set<string>;
};

export function rowLedger(turns: TurnRow[]): RowLedger {
  const keyed = keyedTurns(turns);
  const turnKeys = new Set<string>();
  const anchorOf = new Map<string, string | null>();
  const turnAnchorOf = new Map<string, string | null>();
  const turnOwnerRow = new Map<string, string>();
  const stepOwnerRow = new Map<string, string>();
  const turnAmbiguous = new Set<string>();
  const stepAmbiguous = new Set<string>();
  /**
   * Record an event's owner. A recorded id that two rows claim says nothing about where content
   * went — a duplicated event must not send focus to the other row that has it — so the id is
   * marked ambiguous and `movedRow` answers "unknown" for it.
   */
  const claim = (map: Map<string, string>, ambiguous: Set<string>, id: string, key: string) => {
    const owner = map.get(id);
    if (owner === undefined) map.set(id, key);
    else if (owner !== key) {
      map.set(id, AMBIGUOUS_OWNER);
      ambiguous.add(id);
    }
  };
  for (const k of keyed) {
    const head = turnRowKey(k.key);
    turnKeys.add(k.key);
    anchorOf.set(head, k.anchor);
    turnAnchorOf.set(k.key, k.anchor);
    for (const id of k.turn.eventIds) claim(turnOwnerRow, turnAmbiguous, id, head);
    k.turn.steps.forEach((step, i) => {
      const key = stepRowKey(k.key, k.stepKeys[i]);
      anchorOf.set(key, k.stepAnchors[i]);
      for (const id of step.eventIds) claim(stepOwnerRow, stepAmbiguous, id, key);
    });
  }
  return {
    keyed,
    turnKeys,
    anchorOf,
    turnAnchorOf,
    turnOwnerRow,
    stepOwnerRow,
    turnAmbiguous,
    stepAmbiguous,
  };
}

/** Marks an event id that more than one row claims; it can never identify where content went. */
const AMBIGUOUS_OWNER = "";

/**
 * The row that now holds the event that named a row that has gone. This is how state follows its
 * content when a row is re-identified: a merged group that absorbed an older call, or the row
 * before the first message when a prepend reveals a turn.start and its newest events become a
 * real message. The owner map is chosen by the kind of row that went, so an event shared by a
 * turn and its own step cannot send focus to the wrong one, and a shared recorded id answers
 * "unknown" rather than guessing.
 */
export function movedRow(
  lostKey: string,
  anchor: string | null | undefined,
  ledger: Pick<RowLedger, "turnOwnerRow" | "stepOwnerRow">,
): string | null {
  if (!anchor) return null;
  const owner = lostKey.startsWith("s:") ? ledger.stepOwnerRow : ledger.turnOwnerRow;
  const moved = owner.get(anchor) ?? null;
  return moved && moved !== lostKey ? moved : null;
}

/** The turn identity a rendered row key belongs to, decoded. */
export function turnOfRowKey(rowKey: string): string | null {
  if (rowKey.startsWith("t:")) return decodeURIComponent(rowKey.slice(2));
  if (rowKey.startsWith("s:")) {
    const slash = rowKey.indexOf("/");
    return slash > 2 ? decodeURIComponent(rowKey.slice(2, slash)) : null;
  }
  return null;
}

/**
 * The rows that take part in the roving tabindex, in focus order: a turn that has steps, followed
 * by those steps while it is open. A turn with nothing to reveal is not a control and is skipped,
 * exactly as it was when it carried no tab stop at all.
 */
export function rovingKeys(turns: KeyedTurn[], expanded: ReadonlySet<string>): string[] {
  const keys: string[] = [];
  for (const { turn, key, stepKeys } of turns) {
    if (turn.steps.length === 0) continue;
    keys.push(turnRowKey(key));
    if (!expanded.has(key)) continue;
    turn.steps.forEach((_, i) => keys.push(stepRowKey(key, stepKeys[i])));
  }
  return keys;
}

/**
 * The error/warn turns that should open themselves now: each one once per identity, and never a
 * key the list has already opened automatically. A row that merely grows at either end keeps its
 * key, so it is not treated as a new turn — that is what keeps a warning the reader closed closed.
 */
export function autoExpandKeys(
  turns: TurnRow[],
  keyOf: ReadonlyMap<TurnRow, string>,
  seen: ReadonlySet<string>,
): string[] {
  const fresh: string[] = [];
  for (const turn of turns) {
    if (turn.status !== "error" && turn.status !== "warn") continue;
    const key = keyOf.get(turn) ?? turn.id;
    if (seen.has(key) || fresh.includes(key)) continue;
    fresh.push(key);
  }
  return fresh;
}

/**
 * The single row that holds tabIndex 0. The last row the reader used keeps the tab stop while it
 * is still on screen; when it is gone (its turn collapsed, or the earlier window moved on) the
 * first row takes over so Tab always finds the list again.
 */
export function resolveRovingKey(keys: string[], wanted: string | null): string | null {
  if (wanted !== null && keys.includes(wanted)) return wanted;
  return keys[0] ?? null;
}

/**
 * Where focus should go when the row it was on disappears. A step whose turn is still there (the
 * turn was collapsed) goes to that turn's head, so the reader keeps their place. Anything else
 * goes to the nearest surviving row after it, or before it when it was last — not to the top of
 * the list, which in a long run would throw the reader hundreds of rows away from where they were.
 */
export function handoffKey(
  lost: string,
  before: readonly string[],
  after: readonly string[],
): string | null {
  const surviving = new Set(after);
  const slash = lost.indexOf("/");
  if (lost.startsWith("s:") && slash > 2) {
    const owner = `t:${lost.slice(2, slash)}`;
    if (surviving.has(owner)) return owner;
  }
  const at = before.indexOf(lost);
  if (at >= 0) {
    for (let i = at + 1; i < before.length; i += 1) if (surviving.has(before[i])) return before[i];
    for (let i = at - 1; i >= 0; i -= 1) if (surviving.has(before[i])) return before[i];
  }
  return after[0] ?? null;
}

/** The mounted row for a key. Scanned by value so an id with awkward characters needs no escape. */
function rowElement(root: HTMLElement, key: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>("[data-rl-key]")) {
    if (el.dataset.rlKey === key) return el;
  }
  return null;
}

/** The roving row a DOM node sits in, if any. */
function rowKeyOf(node: EventTarget | null): string | null {
  if (!(node instanceof HTMLElement)) return null;
  return node.closest<HTMLElement>("[data-rl-key]")?.dataset.rlKey ?? null;
}

export function StepLine({
  step,
  selectedEventId,
  onSelectEvent,
  rowKey,
  activeKey,
}: {
  step: StepRow;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
  rowKey: string;
  activeKey: string | null;
}) {
  const lastId = step.eventIds[step.eventIds.length - 1];
  const selected = selectedEventId != null && step.eventIds.includes(selectedEventId);
  const pick = () => {
    if (lastId) onSelectEvent(lastId);
  };
  return (
    <div
      data-rl-key={rowKey}
      data-selected={selected ? "1" : undefined}
      className={`rl-step ${STATUS_CLASS[step.status]}${selected ? " rl-selected" : ""}`}
      role="button"
      // Roving tabindex: only the row the reader is on is a Tab stop, so a long run is one stop,
      // not one per step. The rest stay reachable with ArrowUp / ArrowDown.
      tabIndex={activeKey === rowKey ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      onClick={pick}
      onKeyDown={(e) => onRowKeyDown(e, pick)}
    >
      <span className="rl-step-icon" aria-hidden="true">{KIND_ICON[step.kind]}</span>
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

export function TurnLine({
  turn,
  rowKey,
  stepKeys,
  expanded,
  onToggle,
  selectedEventId,
  onSelectEvent,
  activeKey,
}: {
  turn: TurnRow;
  /** Stable identity of this turn; state and React keys use it, not the positional turn id. */
  rowKey: string;
  /** Stable identity of each step, parallel to turn.steps. */
  stepKeys: string[];
  expanded: boolean;
  onToggle: () => void;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
  activeKey: string | null;
}) {
  const dimmed = turn.summary === "no problems";
  const hasSteps = turn.steps.length > 0;
  const headKey = turnRowKey(rowKey);
  // A stable target for aria-controls; turn ids look like "turn:3".
  const stepsId = `rl-steps-${turn.id.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
  const head = (
    <>
      <span className={`rl-caret${expanded ? " rl-caret-open" : ""}`} aria-hidden="true">
        ▸
      </span>
      <span className={`rl-dot rl-dot-${turn.status}`} />
      <span className="rl-turn-label">{turn.label}</span>
      <span className="rl-turn-spacer" />
      {turn.badges.map((b, i) => (
        <span key={i} className="rl-pill">
          {b}
        </span>
      ))}
      <span className="rl-turn-summary">{turn.summary}</span>
    </>
  );
  return (
    <div className={`rl-turn${dimmed ? " rl-dim" : ""}`}>
      {hasSteps ? (
        <div
          className="rl-turn-head"
          data-rl-key={headKey}
          role="button"
          tabIndex={activeKey === headKey ? 0 : -1}
          aria-expanded={expanded}
          aria-controls={expanded ? stepsId : undefined}
          onClick={onToggle}
          onKeyDown={(e) => onRowKeyDown(e, onToggle)}
        >
          {head}
        </div>
      ) : (
        // Nothing to reveal: a plain row, not a control that would focus and do nothing.
        <div className="rl-turn-head">{head}</div>
      )}
      {hasSteps && expanded && (
        <div className="rl-steps" id={stepsId}>
          {turn.steps.map((s, i) => (
            <StepLine
              key={stepKeys[i]}
              step={s}
              selectedEventId={selectedEventId}
              onSelectEvent={onSelectEvent}
              rowKey={stepRowKey(rowKey, stepKeys[i])}
              activeKey={activeKey}
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

  // The row the reader is on, and whether focus is inside the list at all. Together they decide
  // which row holds tabIndex 0 and whether a vanished row should hand focus to its neighbour.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const hadFocus = useRef(false);

  // Keys come from the recorded events, not from each row's position in the loaded window, so an
  // open turn and the focused row stay with the same message when earlier events are prepended
  // (graph/rows.ts numbers turns "turn:0", "turn:1"… by position, and a prepend renumbers them).
  const ledger = useMemo(() => rowLedger(rows), [rows]);
  const keyed = ledger.keyed;
  const keyOf = useMemo(() => new Map(keyed.map((k) => [k.turn, k.key])), [keyed]);

  // Auto-expand error/warn turns the first time they appear; a turn the user closed stays closed.
  const autoExpanded = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = autoExpandKeys(rows, keyOf, autoExpanded.current);
    if (fresh.length === 0) return;
    for (const key of fresh) autoExpanded.current.add(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const key of fresh) next.add(key);
      return next;
    });
  }, [rows, keyOf]);

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
    const key = keyOf.get(turn) ?? turn.id;
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    if (rows.indexOf(turn) < rows.length - LIMIT) setShowAll(true);
    const frame = requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector('[data-selected="1"]');
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
    // Only when a new step is picked; rows change every second while live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId, selectNonce]);

  // Which slice of the list is mounted. The keys are cut from the same offset, so moving the
  // window never renumbers a row.
  const { from, earlierCount } = useMemo(() => {
    if (showAll || rows.length <= LIMIT) {
      return { from: 0, earlierCount: 0 };
    }
    const selIdx = selectedEventId
      ? rows.findIndex((r) => r.steps.some((st) => st.eventIds.includes(selectedEventId)) || r.eventIds.includes(selectedEventId))
      : -1;
    const start = Math.max(0, Math.min(rows.length - LIMIT, selIdx >= 0 ? selIdx : rows.length));
    return { from: start, earlierCount: start };
  }, [rows, showAll, selectedEventId]);
  const keyedVisible = useMemo(() => keyed.slice(from), [keyed, from]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const keys = useMemo(() => rovingKeys(keyedVisible, expanded), [keyedVisible, expanded]);
  const activeKey = resolveRovingKey(keys, focusKey);

  // What the rows were made of on the last commit, and the last ordered rows focus was on. A row
  // can be re-keyed or vanish before we ever see it in its final position, and these say what it
  // held and which way to look for the row that has its content now.
  const lastLedger = useRef<
    Pick<RowLedger, "anchorOf" | "turnAnchorOf" | "turnAmbiguous" | "stepAmbiguous">
  >({
    anchorOf: new Map(),
    turnAnchorOf: new Map(),
    turnAmbiguous: new Set(),
    stepAmbiguous: new Set(),
  });
  const lastKeys = useRef<string[]>([]);

  /**
   * A focus move that has to wait for a commit: the row it names does not exist yet because its
   * turn has to open first (a step that moved into a message the prepend revealed).
   */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    if (pendingFocus === null) return;
    setPendingFocus(null);
    const root = containerRef.current;
    if (!root) return;
    rowElement(root, pendingFocus)?.focus();
  }, [pendingFocus, keys]);

  /**
   * State follows the recorded events when a row is re-identified. A row that is on screen can be
   * re-keyed while its events stay put (a merged group absorbs an older call; a prepend reveals a
   * turn.start and the row before the first message becomes a real message), or it can go. In the
   * first case focus and the open state move to the row that now holds those events — never to
   * whatever row happens to take the old position. In the second, focus goes to the nearest
   * surviving row so the reader is not thrown to the top of the list.
   */
  useEffect(() => {
    const before = lastLedger.current;
    lastLedger.current = {
      anchorOf: ledger.anchorOf,
      turnAnchorOf: ledger.turnAnchorOf,
      turnAmbiguous: ledger.turnAmbiguous,
      stepAmbiguous: ledger.stepAmbiguous,
    };
    const focusedTurn = focusKey === null ? null : turnOfRowKey(focusKey);

    // An open turn whose recorded events now sit under another key takes its open state along.
    // This covers a row that is gone as well as the row before the first message, which keeps its
    // own key but can hand its newest events to a real message when a prepend reveals a turn.start.
    // A step the reader is on is never closed under them: the row it sits in keeps the events that
    // stayed. (A focused turn head can move with the content, since the head itself remains.)
    setExpanded((prev) => {
      if (prev.size === 0) return prev;
      let next: Set<string> | null = null;
      for (const key of prev) {
        if (focusKey !== null && focusKey.startsWith("s:") && key === focusedTurn) continue;
        const anchor = before.turnAnchorOf.get(key);
        if (anchor && before.turnAmbiguous.has(anchor)) continue;
        const moved = movedRow(turnRowKey(key), anchor, ledger);
        // Only a row that is new since the last commit can have taken the content: a row that was
        // already there was already showing its own events.
        if (!moved || before.anchorOf.has(moved)) continue;
        const identity = decodeURIComponent(moved.slice(2));
        if (identity === key || prev.has(identity)) continue;
        next ??= new Set(prev);
        next.delete(key);
        next.add(identity);
      }
      return next ?? prev;
    });

    if (focusKey === null || !hadFocus.current) return;
    // The row that now holds the event that named the focused row, if that event has moved on.
    // An id two rows claimed says nothing about where the content went, so it is not followed.
    const anchor = before.anchorOf.get(focusKey) ?? null;
    const ambiguous = focusKey.startsWith("s:") ? before.stepAmbiguous : before.turnAmbiguous;
    const raw =
      anchor && !ambiguous.has(anchor) ? movedRow(focusKey, anchor, ledger) : null;
    const moved = raw && !before.anchorOf.has(raw) ? raw : null;
    const follow = moved && keys.includes(moved) ? moved : null;
    const on = document.activeElement;
    const onRow = on instanceof HTMLElement && on.dataset.rlKey === focusKey;
    if (keys.includes(focusKey)) {
      lastKeys.current = keys;
      // Still its own row and still the event that named it: nothing to follow, leave focus be.
      if (!follow || !onRow) return;
    } else if (
      on instanceof HTMLElement &&
      on !== document.body &&
      containerRef.current?.contains(on)
    ) {
      return;
    }
    if (!follow && moved && moved.startsWith("s:")) {
      // The content moved into a step of a turn that is closed. Open that turn, then move focus
      // on the commit that mounts the step — otherwise the row does not exist to be focused.
      const owner = turnOfRowKey(moved);
      if (owner !== null && ledger.turnKeys.has(owner)) {
        setExpanded((prev) => (prev.has(owner) ? prev : new Set(prev).add(owner)));
        setPendingFocus(moved);
        return;
      }
    }
    const root = containerRef.current;
    if (!root) return;
    const target = follow ?? handoffKey(focusKey, lastKeys.current, keys);
    if (target) rowElement(root, target)?.focus();
  }, [focusKey, keys, ledger]);

  /**
   * "show N earlier messages" reveals rows above the list and unmounts itself, which would drop
   * focus on <body>. Focus the row that was first in view instead: it sits where the button was,
   * so the reveal neither loses focus nor moves the reader off what they were reading. A run that
   * has no focusable row at all (every message kept nothing) falls back to the list itself.
   */
  const [revealFocus, setRevealFocus] = useState<string | null>(null);
  useEffect(() => {
    if (revealFocus === null) return;
    setRevealFocus(null);
    const root = containerRef.current;
    if (!root) return;
    const el =
      rowElement(root, revealFocus) ?? rowElement(root, resolveRovingKey(keys, null) ?? "");
    if (el) el.focus();
    else root.focus();
  }, [revealFocus, keys]);

  const showEarlier = () => {
    const next = keys[0] ?? null;
    setShowAll(true);
    setRevealFocus(next);
  };

  /** Focus enters the list: remember which row, so the tab stop follows the reader. */
  const handleFocus = (e: FocusEvent<HTMLDivElement>) => {
    const key = rowKeyOf(e.target);
    if (!key) return;
    hadFocus.current = true;
    setFocusKey((prev) => (prev === key ? prev : key));
  };

  /** Focus leaves the list: stop owning the tab stop, so a stray row cannot pull it back. */
  const handleBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    hadFocus.current = false;
  };

  /**
   * One keydown listener for the whole list, rather than one per row: hundreds of rows would
   * otherwise each carry a handler. Arrow keys move the focus ring between mounted rows; Tab is
   * untouched, so the list is a single stop and Tab leaves it in either direction.
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ROVING_KEYS.includes(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const root = containerRef.current;
    if (!root) return;
    const currentKey = rowKeyOf(e.target);
    // Focus is on something else inside the panel (the "earlier messages" button): arrows keep
    // their usual meaning there instead of jumping into the tape.
    if (!currentKey) return;
    const rowsInView = Array.from(root.querySelectorAll<HTMLElement>("[data-rl-key]"));
    const at = rowsInView.findIndex((el) => el.dataset.rlKey === currentKey);
    if (at < 0) return;
    const next = moveRowFocus(at, e.key, rowsInView.length);
    if (next < 0 || next === at) return;
    e.preventDefault();
    const target = rowsInView[next];
    const key = target.dataset.rlKey ?? null;
    if (key && key !== focusKey) setFocusKey(key);
    target.focus();
  };

  return (
    <div
      className="rl-root"
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {earlierCount > 0 && (
        <button className="rl-earlier" onClick={showEarlier} type="button">
          show {earlierCount} earlier messages
        </button>
      )}
      {keyedVisible.map(({ turn, key, stepKeys }) => (
        <TurnLine
          key={key}
          turn={turn}
          rowKey={key}
          stepKeys={stepKeys}
          expanded={expanded.has(key)}
          onToggle={() => toggle(key)}
          selectedEventId={selectedEventId}
          onSelectEvent={onSelectEvent}
          activeKey={activeKey}
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
