import type { SessionMeta } from '../types';

/**
 * Collapsible date buckets for the chat rail.
 *
 * The rail is a flat list of every chat this machine has ever recorded, which stops being readable
 * at about a screenful. Grouping answers "when was I working on this?" without hiding anything: the
 * sessions keep their own sort order inside a bucket, and a bucket is a heading you can fold.
 *
 * Buckets are computed from each chat's last recorded activity, in local time — the same clock the
 * row already shows — so "Today" means today where the reader is, not in UTC.
 */
export type GroupMode = 'day' | 'week' | 'month' | 'none';

/** Fresh enough to be "what I am doing right now", which is a different question from "today". */
export const LAST_HOUR_S = 3600;

export const GROUP_MODES: { value: GroupMode; label: string }[] = [
  { value: 'day', label: 'By day' },
  { value: 'week', label: 'By week' },
  { value: 'month', label: 'By month' },
  { value: 'none', label: 'Flat list' },
];

export interface SessionGroup {
  /** Stable id for remembering a folded bucket. */
  key: string;
  label: string;
  sessions: SessionMeta[];
}

const MS_DAY = 86_400_000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday-first week start, matching how the owner reads a week. */
function startOfWeek(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  const weekday = (day.getDay() + 6) % 7; // Monday = 0
  return day.getTime() - weekday * MS_DAY;
}

function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function dayLabel(ms: number, nowMs: number): string {
  if (nowMs - ms <= LAST_HOUR_S * 1000) return 'Last hour';
  const start = startOfDay(ms);
  const today = startOfDay(nowMs);
  const days = Math.round((today - start) / MS_DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = new Date(start);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
  const rest = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return sameYear ? `${weekday} ${rest}` : `${weekday} ${rest} ${date.getFullYear()}`;
}

function weekLabel(ms: number, nowMs: number): string {
  const start = startOfWeek(ms);
  const thisWeek = startOfWeek(nowMs);
  const weeks = Math.round((thisWeek - start) / (7 * MS_DAY));
  if (weeks <= 0) return 'This week';
  if (weeks === 1) return 'Last week';
  const date = new Date(start);
  const rest = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return sameYear ? `Week of ${rest}` : `Week of ${rest} ${date.getFullYear()}`;
}

function monthLabel(ms: number, nowMs: number): string {
  const start = startOfMonth(ms);
  const thisMonth = startOfMonth(nowMs);
  if (start === thisMonth) return 'This month';
  const date = new Date(start);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function bucket(ms: number, mode: GroupMode, nowMs: number): { key: string; label: string } {
  if (mode === 'day') {
    if (nowMs - ms <= LAST_HOUR_S * 1000) {
      // One key for the whole window, so a chat leaving it simply moves down to "Today".
      return { key: 'hour', label: 'Last hour' };
    }
    const start = startOfDay(ms);
    return { key: `d${start}`, label: dayLabel(ms, nowMs) };
  }
  if (mode === 'week') {
    const start = startOfWeek(ms);
    return { key: `w${start}`, label: weekLabel(ms, nowMs) };
  }
  const start = startOfMonth(ms);
  return { key: `m${start}`, label: monthLabel(ms, nowMs) };
}

/**
 * Group in the order sessions already arrive, so a sort by recency, by age or by size still reads
 * top-to-bottom inside each bucket; the buckets themselves appear in order of first appearance.
 */
export function groupSessions(
  sessions: SessionMeta[],
  mode: GroupMode,
  nowSeconds: number,
): SessionGroup[] {
  if (mode === 'none') {
    return sessions.length ? [{ key: 'all', label: '', sessions }] : [];
  }
  const nowMs = nowSeconds * 1000;
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const stamp = session.last_ts ?? session.first_ts;
    if (typeof stamp !== 'number' || !Number.isFinite(stamp)) {
      const undated = groups.get('unknown') ?? { key: 'unknown', label: 'No recorded time', sessions: [] };
      undated.sessions.push(session);
      groups.set('unknown', undated);
      continue;
    }
    const { key, label } = bucket(stamp * 1000, mode, nowMs);
    const group = groups.get(key) ?? { key, label, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()];
}
