import type { OmniEvent } from '../types';
import { eventKindLabel } from './eventKindLabel';
import { attrsOf, formatClockTime } from './reduce';

/**
 * Run Lens: a bounded, deterministic reading of the recorded stream.
 *
 * Every value here comes from the recording itself — kind, status, tool name, order and time.
 * Nothing is inferred: a step with no status says "status not recorded" rather than borrowing a
 * neighbour's outcome, and no model, token count, confidence or tool output is ever invented.
 * Free text the recorder wrote (status words, tool names) is shown but bounded, so one long or
 * control-character-filled value cannot break the layout.
 *
 * Order is the recorder's order (rowid ascending, as the viewer keeps `events`). Timestamps are
 * deliberately not used for ordering: they can be missing, zero or duplicated, and sorting by
 * them would silently reshuffle or drop recorded steps. Timestamps only label a moment.
 */

/** The most markers the orbit and its linear list ever draw at once. */
export const LENS_MAX_GROUPS = 16;

/** Longest recorded word the lens paints for a status or a tool name before eliding. */
export const LENS_MAX_TEXT_CHARS = 60;

export type LensCategory =
  | 'model'
  | 'tool'
  | 'session'
  | 'turn'
  | 'helper'
  | 'background'
  | 'lost'
  | 'other';

/**
 * A visual tone. `unknown` is not a failure: it means the record did not say, or said a word the
 * lens does not recognise. Both draw the dashed shape and both are labelled as such.
 */
export type LensTone = 'ok' | 'error' | 'running' | 'stopped' | 'unknown';

/** How much of a group the replay prefix (`events.slice(0, replayCount)`) includes. */
export type LensReplayState = 'all' | 'partial' | 'none';

export interface LensGroup {
  /** Stable id: the recorded kind plus the index of the group's first event. */
  key: string;
  category: LensCategory;
  categoryLabel: string;
  /** The recorded event kind, never a synthesised step type. */
  kind: string;
  /** A recorded tool name, or null. Distinct tool names are never merged. */
  toolName: string | null;
  /** The recorded status value as written and trimmed, or null when none was recorded. */
  status: string | null;
  /** Display form of `status`, bounded and stripped of control characters. */
  statusLabel: string;
  tone: LensTone;
  /** True only for an explicitly recorded error/failed status. */
  failure: boolean;
  count: number;
  /** Events in this group with no usable timestamp (missing, zero or not a number). */
  missingTimeCount: number;
  /** Zero-based indices into the source array; `lastIndex + 1` is the replay prefix length. */
  firstIndex: number;
  lastIndex: number;
  firstRowid: number;
  lastRowid: number;
  /**
   * Earliest and latest usable recorded time in the group, even if some steps had no time.
   * Recorded order is not timestamp order, so these are the span's endpoints: a group whose
   * second step carries an earlier clock than its first still gets `firstTs <= lastTs`.
   */
  firstTs: number | null;
  lastTs: number | null;
  /** "14:05" (the earliest recorded time in the group) or "time not recorded". */
  timeLabel: string;
  /**
   * "14:05" or "14:05–14:09", or "time not recorded". A group that crosses local midnight (or a
   * new year) carries the date on both ends, so "23:58–00:03" can never be misread. A span whose
   * two ends fall in the same displayed minute reads as that one time, never "14:05–14:05".
   */
  timeRangeLabel: string;
  /** Event ids in recorded order; the last one is the group's representative selection. */
  eventIds: string[];
  replayState: LensReplayState;
}

export interface LensView {
  totalEvents: number;
  totalGroups: number;
  /** The bounded, ascending-by-recorded-order set. Never one element per event. */
  groups: LensGroup[];
  sampled: boolean;
  omittedGroups: number;
  /** Recorded steps whose groups are outside the sampled set. */
  omittedEvents: number;
  /**
   * Moment groups with an explicit failure that are outside the sampled set, and so are not
   * marked here. This counts groups, not failing steps: one group may hold many failed steps.
   */
  omittedFailures: number;
  replayIndex: number | null;
  /** The prefix length the replay actually shows. */
  replayCount: number;
  selectedGroupIndex: number;
  cursorGroupIndex: number;
  limit: number;
}

export interface LensOptions {
  maxGroups?: number;
  replayIndex?: number | null;
  selectedEventId?: string | null;
  /** Fixed offset for pure tests; defaults to the device's offset like the rest of the viewer. */
  timezoneOffsetMinutes?: number;
}

const OK_STATUSES = new Set(['ok', 'success', 'succeeded', 'completed', 'complete']);
const ERROR_STATUSES = new Set(['error', 'failed', 'failure']);
const RUNNING_STATUSES = new Set(['running', 'started', 'in_progress']);
const STOPPED_STATUSES = new Set(['cancelled', 'canceled', 'interrupted', 'blocked', 'aborted']);

const CATEGORY_LABELS: Record<LensCategory, string> = {
  model: 'model',
  tool: 'tool',
  session: 'session',
  turn: 'turn',
  helper: 'helper',
  background: 'background',
  lost: 'lost records',
  other: 'other',
};

function validTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Display text for a value the recorder wrote. Control and bidi-override characters become spaces,
 * runs of whitespace collapse, and long words are elided, so a recording can never stretch the
 * layout or reorder what is around it. The undecorated recorded value is kept elsewhere.
 */
export function lensSafeText(value: string, maxChars: number = LENS_MAX_TEXT_CHARS): string {
  const collapsed = value.replace(CONTROL_OR_BIDI, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function numericRowid(event: OmniEvent, index: number): number {
  return typeof event.rowid === 'number' && Number.isFinite(event.rowid) ? event.rowid : index;
}

/** A category is a coarse marker. The exact recorded kind and tool name stay visible. */
export function lensCategoryOf(kind: string): LensCategory {
  if (kind.startsWith('llm.')) return 'model';
  if (kind.startsWith('tool.')) return 'tool';
  if (kind.startsWith('subagent.')) return 'helper';
  if (kind.startsWith('aux.') || kind === 'skill.event') return 'background';
  if (kind === 'omni.dropped') return 'lost';
  if (kind === 'session.start' || kind === 'session.end') return 'session';
  if (kind === 'turn.start' || kind === 'turn.end') return 'turn';
  return 'other';
}

export interface LensStatus {
  status: string | null;
  statusLabel: string;
  tone: LensTone;
  failure: boolean;
}

/**
 * Normalise only what the record says. Unknown words are kept and shown, with an `unknown` tone,
 * so a missing or unfamiliar status can never be rendered as an error. The status value is trimmed
 * and the display label is bounded; grouping compares case-insensitively, so steps whose statuses
 * differ only by case or surrounding whitespace share a group and it shows the first spelling met.
 */
export function lensStatusOf(raw: unknown): LensStatus {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { status: null, statusLabel: 'status not recorded', tone: 'unknown', failure: false };
  }
  const status = raw.trim();
  const statusLabel = lensSafeText(status);
  const lower = status.toLowerCase();
  if (OK_STATUSES.has(lower)) return { status, statusLabel, tone: 'ok', failure: false };
  if (ERROR_STATUSES.has(lower)) return { status, statusLabel, tone: 'error', failure: true };
  if (RUNNING_STATUSES.has(lower)) return { status, statusLabel, tone: 'running', failure: false };
  if (STOPPED_STATUSES.has(lower)) return { status, statusLabel, tone: 'stopped', failure: false };
  return { status, statusLabel, tone: 'unknown', failure: false };
}

/** A recorded tool name, or null. `tool_name` wins unless it is empty, as in the Python labels. */
function recordedToolName(event: OmniEvent): string | null {
  const attrs = attrsOf(event);
  for (const candidate of [attrs.tool_name, attrs.tool]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

interface EventMeta {
  category: LensCategory;
  categoryLabel: string;
  kind: string;
  toolName: string | null;
  status: LensStatus;
  groupKey: string;
}

function describe(event: OmniEvent): EventMeta {
  const kind = typeof event.kind === 'string' ? event.kind : '';
  const category = lensCategoryOf(kind);
  const toolName = recordedToolName(event);
  const status = lensStatusOf(event.status);
  // Adjacent grouping is deliberately narrow: same recorded kind, category, tool name and status.
  // Two different tools are never folded together, and neither are a request and a response.
  const groupKey = JSON.stringify([kind, category, toolName, status.status?.toLowerCase() ?? '']);
  return { category, categoryLabel: CATEGORY_LABELS[category], kind, toolName, status, groupKey };
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

interface LocalDate {
  year: number;
  month: string;
  day: number;
}

/** The wall-clock date of a timestamp in the lens's fixed offset, without the host locale. */
function localDateOf(ts: number, offsetMinutes: number): LocalDate {
  const safeOffset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  const date = new Date((ts + safeOffset * 60) * 1000);
  return {
    year: date.getUTCFullYear(),
    month: MONTH_LABELS[date.getUTCMonth()],
    day: date.getUTCDate(),
  };
}

function dateLabel(parts: LocalDate, withYear: boolean): string {
  return `${parts.month} ${parts.day}${withYear ? ` ${parts.year}` : ''}`;
}

/**
 * "14:05–14:09" inside one local day, with the date on both ends when the group crosses midnight
 * (or a new year), so a range can never be read as going backwards. `first` and `last` are the
 * earliest and latest recorded times in the group, not the first and last steps, so recorded
 * order cannot turn the range around. When both ends display as the same clock time there is no
 * range to show: the single time is the whole span at minute precision.
 */
function timeRangeOf(first: number, last: number, offsetMinutes: number): string {
  const start = formatClockTime(first, offsetMinutes);
  const end = formatClockTime(last, offsetMinutes);
  const startDate = localDateOf(first, offsetMinutes);
  const endDate = localDateOf(last, offsetMinutes);
  const sameDate =
    startDate.year === endDate.year &&
    startDate.month === endDate.month &&
    startDate.day === endDate.day;
  if (sameDate) return start === end ? start : `${start}–${end}`;
  const withYear = startDate.year !== endDate.year;
  return `${dateLabel(startDate, withYear)} ${start}–${dateLabel(endDate, withYear)} ${end}`;
}

function buildAllGroups(events: OmniEvent[], offsetMinutes: number): LensGroup[] {
  const groups: LensGroup[] = [];
  let current: LensGroup | null = null;
  let currentKey = '';

  events.forEach((event, index) => {
    const meta = describe(event);
    const ts = validTimestamp(event.ts);
    if (current && currentKey === meta.groupKey) {
      current.count += 1;
      current.lastIndex = index;
      current.lastRowid = numericRowid(event, index);
      current.eventIds.push(event.event_id);
      if (ts === null) current.missingTimeCount += 1;
      else {
        // Span endpoints, not first/last recorded: a recorder can write a later step with an
        // earlier clock, and a range must not read backwards because of it.
        current.firstTs = current.firstTs === null ? ts : Math.min(current.firstTs, ts);
        current.lastTs = current.lastTs === null ? ts : Math.max(current.lastTs, ts);
      }
      return;
    }

    current = {
      key: `${meta.kind || 'event'}:${index}`,
      category: meta.category,
      categoryLabel: meta.categoryLabel,
      kind: meta.kind,
      toolName: meta.toolName,
      status: meta.status.status,
      statusLabel: meta.status.statusLabel,
      tone: meta.status.tone,
      failure: meta.status.failure,
      count: 1,
      missingTimeCount: ts === null ? 1 : 0,
      firstIndex: index,
      lastIndex: index,
      firstRowid: numericRowid(event, index),
      lastRowid: numericRowid(event, index),
      firstTs: ts,
      lastTs: ts,
      timeLabel: 'time not recorded',
      timeRangeLabel: 'time not recorded',
      eventIds: [event.event_id],
      replayState: 'all',
    };
    currentKey = meta.groupKey;
    groups.push(current);
  });

  for (const group of groups) {
    if (group.firstTs === null) {
      group.timeLabel = 'time not recorded';
      group.timeRangeLabel = 'time not recorded';
      continue;
    }
    group.timeLabel = formatClockTime(group.firstTs, offsetMinutes);
    group.timeRangeLabel =
      group.lastTs !== null && group.lastTs !== group.firstTs
        ? timeRangeOf(group.firstTs, group.lastTs, offsetMinutes)
        : group.timeLabel;
  }
  return groups;
}

/**
 * Prefix length the replay shows, clamped to the loaded events.
 *
 * This is a clamp, not `Array.prototype.slice`: a negative index means "nothing replayed yet"
 * (0), a non-finite one means live (all loaded events), and a fraction is truncated. The viewer
 * uses this same function for its `visibleEvents`, so the ring and the replay cannot disagree.
 */
export function replayPrefixCount(replayIndex: number | null, totalEvents: number): number {
  if (replayIndex === null || !Number.isFinite(replayIndex)) return totalEvents;
  return Math.max(0, Math.min(totalEvents, Math.trunc(replayIndex)));
}

/** Whether a group's events are inside the replay prefix. Prefix slicing: indices 0..count-1. */
export function lensReplayState(
  group: Pick<LensGroup, 'firstIndex' | 'lastIndex'>,
  replayIndex: number | null,
  totalEvents: number,
): LensReplayState {
  if (replayIndex === null) return 'all';
  const count = replayPrefixCount(replayIndex, totalEvents);
  if (group.lastIndex < count) return 'all';
  if (group.firstIndex < count) return 'partial';
  return 'none';
}

/**
 * The replay index that makes this whole group visible. `null` is live (the whole recording),
 * matching ReplayBar: an index equal to the total means live, not "replay at the end".
 */
export function seekIndexForGroup(
  group: Pick<LensGroup, 'lastIndex'>,
  totalEvents: number,
): number | null {
  if (!Number.isFinite(totalEvents) || totalEvents <= 0) return null;
  const next = group.lastIndex + 1;
  if (!Number.isFinite(next) || next >= totalEvents) return null;
  return Math.max(1, next);
}

/** The group at the replay position: the last group whose first event is inside the prefix. */
export function lensCursorIndex(
  groups: Pick<LensGroup, 'firstIndex'>[],
  replayIndex: number | null,
  totalEvents: number,
): number {
  if (groups.length === 0) return -1;
  if (replayIndex === null) return groups.length - 1;
  const count = replayPrefixCount(replayIndex, totalEvents);
  let cursor = -1;
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index].firstIndex < count) cursor = index;
    else break;
  }
  return cursor;
}

/** Index of the group holding an event id, or -1. */
export function groupIndexForEvent(
  groups: Pick<LensGroup, 'eventIds'>[],
  eventId: string | null | undefined,
): number {
  if (!eventId) return -1;
  return groups.findIndex((group) => group.eventIds.includes(eventId));
}

function clampLimit(value: number | undefined): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : LENS_MAX_GROUPS;
  return Math.max(1, Math.min(64, numeric));
}

/**
 * Pick at most `limit` groups, in recorded order.
 *
 * Priority is deterministic: first, last, the selected group, the group at the replay cursor,
 * then groups with an explicit failure spread evenly across those groups, then an even fill across
 * the positions nothing has claimed yet. The fill is spread over the whole recording, so the
 * sample always reaches both ends instead of running out of slots halfway. The fill is skipped when
 * failures already fill the cap, so a failure-heavy sample can cluster around its failures rather
 * than being evenly spread. The result is always sorted by recorded position, so drawing it cannot
 * imply a different order.
 */
export function chooseGroupIndices(
  groups: Pick<LensGroup, 'failure'>[],
  limit: number,
  selectedIndex: number,
  cursorIndex: number,
): number[] {
  const total = groups.length;
  const numeric = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : LENS_MAX_GROUPS;
  const cap = Math.max(1, Math.min(64, numeric));
  if (total <= cap) return groups.map((_, index) => index);

  const chosen = new Set<number>();
  const add = (index: number) => {
    if (index >= 0 && index < total && chosen.size < cap) chosen.add(index);
  };

  add(0);
  add(total - 1);
  add(selectedIndex);
  add(cursorIndex);

  const failures: number[] = [];
  groups.forEach((group, index) => {
    if (group.failure) failures.push(index);
  });
  if (failures.length > 0 && chosen.size < cap) {
    const capacity = cap - chosen.size;
    const take = Math.min(capacity, failures.length);
    for (let step = 0; step < take; step += 1) {
      const at =
        take === 1
          ? Math.floor((failures.length - 1) / 2)
          : Math.round((step * (failures.length - 1)) / (take - 1));
      add(failures[at]);
    }
  }

  // An even fill across the positions nothing has claimed yet. Bins are centred, so the fill does
  // not pile up next to the already-claimed first and last groups, and every bin lies inside the
  // recording: a tiny cap lands near the middle instead of bunching at the start.
  if (chosen.size < cap) {
    const slots = cap - chosen.size;
    for (let step = 0; step < slots; step += 1) {
      const at = Math.floor(((step + 0.5) * total) / slots);
      add(Math.min(total - 1, Math.max(0, at)));
    }
  }
  // Collisions with the priority picks (or a bin landing on the same index) leave slots open:
  // fill them evenly across whatever is still unmarked, never past the end of the recording.
  if (chosen.size < cap) {
    const remaining: number[] = [];
    for (let index = 0; index < total; index += 1) {
      if (!chosen.has(index)) remaining.push(index);
    }
    const slots = cap - chosen.size;
    if (remaining.length <= slots) {
      for (const index of remaining) add(index);
    } else {
      for (let step = 0; step < slots; step += 1) {
        const at =
          slots === 1
            ? Math.floor((remaining.length - 1) / 2)
            : Math.round((step * (remaining.length - 1)) / (slots - 1));
        add(remaining[at]);
      }
    }
  }
  for (let index = 0; index < total && chosen.size < cap; index += 1) add(index);

  return [...chosen].sort((a, b) => a - b);
}

/**
 * Group the recorded stream once. This is the O(events) half of the lens: it is deliberately
 * separate from replay/sampling so dragging the replay slider does not regroup a large stream.
 */
export function buildLensGroups(events: OmniEvent[], timezoneOffsetMinutes?: number): LensGroup[] {
  const offset =
    typeof timezoneOffsetMinutes === 'number' && Number.isFinite(timezoneOffsetMinutes)
      ? timezoneOffsetMinutes
      : -new Date().getTimezoneOffset();
  return buildAllGroups(events, offset);
}

/**
 * Select, sample and replay-mark a pre-built set of groups. Pure and bounded: it never regroups the
 * events, but it is not free. One call walks every built group for the cursor, and when an event is
 * selected it scans every group's event ids (once across all groups to find the selection, once
 * across the sample to mark it). That cost is linear in the loaded steps, not a rebuild, so a
 * replay tick does not redo the grouping.
 */
export function selectLensView(
  allGroups: LensGroup[],
  totalEvents: number,
  options: LensOptions = {},
): LensView {
  const requestedReplay = options.replayIndex ?? null;
  // ReplayBar treats an index at or past the total as live; normalise it here too so the lens
  // never claims "replay at 6 of 6" while drawing every recorded step.
  const replayIndex =
    requestedReplay === null ||
    !Number.isFinite(requestedReplay) ||
    requestedReplay >= totalEvents
      ? null
      : Math.max(0, Math.trunc(requestedReplay));
  const replayCount = replayPrefixCount(replayIndex, totalEvents);
  const limit = clampLimit(options.maxGroups);

  const selectedAll = groupIndexForEvent(allGroups, options.selectedEventId);
  const cursorAll = lensCursorIndex(allGroups, replayIndex, totalEvents);
  const chosen = chooseGroupIndices(allGroups, limit, selectedAll, cursorAll);

  const groups = chosen.map((index) => {
    const group = allGroups[index];
    return { ...group, replayState: lensReplayState(group, replayIndex, totalEvents) };
  });

  const shownEvents = groups.reduce((total, group) => total + group.count, 0);
  // These count moment groups, not failing steps: a group can hold many failed steps and still be
  // one marked failure.
  const shownFailureGroups = groups.reduce((total, group) => total + (group.failure ? 1 : 0), 0);
  const allFailureGroups = allGroups.reduce((total, group) => total + (group.failure ? 1 : 0), 0);

  return {
    totalEvents,
    totalGroups: allGroups.length,
    groups,
    sampled: groups.length < allGroups.length,
    omittedGroups: allGroups.length - groups.length,
    omittedEvents: Math.max(0, totalEvents - shownEvents),
    omittedFailures: Math.max(0, allFailureGroups - shownFailureGroups),
    replayIndex,
    replayCount,
    selectedGroupIndex: groupIndexForEvent(groups, options.selectedEventId),
    cursorGroupIndex: lensCursorIndex(groups, replayIndex, totalEvents),
    limit,
  };
}

/**
 * Build the bounded lens view in one call. Pure: same events/options always produce the same
 * result. Components that re-render on replay should cache `buildLensGroups` and call
 * `selectLensView` instead.
 */
export function buildLensView(events: OmniEvent[], options: LensOptions = {}): LensView {
  const allGroups = buildLensGroups(events, options.timezoneOffsetMinutes);
  return selectLensView(allGroups, events.length, options);
}

/** "Model request" / "Tool call ended · terminal" — the recorded kind, plus a recorded tool name. */
export function lensTypeText(group: Pick<LensGroup, 'kind' | 'toolName'>): string {
  const base = lensSafeText(eventKindLabel(group.kind) || 'Recorded step');
  return group.toolName ? `${base} · ${lensSafeText(group.toolName)}` : base;
}
