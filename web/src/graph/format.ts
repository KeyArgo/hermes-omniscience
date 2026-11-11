/**
 * Human-friendly formatters. Pure: no hidden clock (pass `now` explicitly).
 *
 * Conventions from the product spec:
 * - durations: "850 ms", "3.2 s", "3 min 16 s" — never bare floats
 * - numbers: thousands separators ("13,916")
 * - timestamps: local time of the viewer
 */

import type { SessionMeta } from '../types';

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'not reported';
  return Math.round(value).toLocaleString('en-US');
}

/** Seconds (possibly fractional) -> "850 ms" / "3.2 s" / "3 min 16 s" / "1 h 04 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'not reported';
  if (Math.round(seconds * 1000) < 1000) {
    return `${Math.round(seconds * 1000)} ms`;
  }
  // 59.96 s would render "60.0 s"; anything that rounds to 60.0 is 1 minute.
  if (Math.round(seconds * 10) < 600) {
    return `${seconds.toFixed(1)} s`;
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    const mm = m > 0 ? ` ${m} min` : '';
    return `${h} h${mm}`;
  }
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

/** Milliseconds -> same style as formatDuration. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'not reported';
  return formatDuration(ms / 1000);
}

/** Big token counts: 13916 -> "13,916". */
export function formatTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'not reported';
  return formatNumber(value);
}

/** "12 min ago" style relative time. `now` in epoch seconds, like `ts`. */
export function relativeTime(ts: number | null | undefined, now: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'unknown';
  // Round to whole seconds first so seconds never spill into 60
  // (Math.round(diff % 60) could yield 60 for a diff like 119.6 s).
  const secs = Math.round(Math.max(0, now - ts));
  if (secs < 60) return 'just now';
  const minutes = Math.floor(secs / 60);
  if (minutes < 60) {
    if (minutes < 5) {
      const rem = secs % 60;
      return rem > 0 ? `${minutes} min ${rem} s ago` : `${minutes} min ago`;
    }
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Epoch seconds -> "2026-11-05 23:41:07" in the viewer's local time. */
export function formatLocalTime(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'not reported';
  const date = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Session start label for the conversation list:
 * "Today 14:02", "Yesterday 09:15", otherwise "Nov 5 14:02".
 */
export function sessionStartLabel(
  ts: number | null | undefined,
  now: number,
): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'not reported';
  if (typeof now !== 'number' || !Number.isFinite(now)) return 'not reported';
  const date = new Date(ts * 1000);
  const nowDate = new Date(now * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameLocalDay(date, nowDate)) return `Today ${time}`;
  const yesterday = new Date(nowDate);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(date, yesterday)) return `Yesterday ${time}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`;
}

/** Session status -> plain words for the conversation list. */
export function sessionOutcome(status: string | null | undefined): string {
  if (typeof status !== 'string' || status.trim() === '') return 'not reported';
  switch (status.toLowerCase()) {
    case 'ok':
    case 'success':
    case 'succeeded':
    case 'completed':
    case 'complete':
      return 'finished OK';
    case 'error':
    case 'failed':
    case 'failure':
      return 'finished with errors';
    case 'running':
    case 'started':
    case 'in_progress':
      return 'still running';
    case 'interrupted':
    case 'blocked':
    case 'cancelled':
    case 'canceled':
    case 'lost':
      return 'stopped early';
    default:
      return 'not reported';
  }
}

/** Shorten a model name for a narrow list row; missing values are explicit. */
export function shortModel(model: string | null | undefined): string {
  if (typeof model !== 'string' || model.trim() === '') return 'not reported';
  const trimmed = model.trim();
  return trimmed.length > 16 ? `${trimmed.slice(0, 14)}…` : trimmed;
}

export type ConnectionState = 'live' | 'recent' | 'recorded' | 'disconnected';

/** An event this fresh means the chat is working right now. */
export const ACTIVE_WINDOW_S = 60;
/** An event this fresh still counts as recent; past it, the chat is quiet. */
export const RECENT_WINDOW_S = 300;

export interface ConnectionInput {
  socketOpen: boolean;
  fetchFailing: boolean;
  lastEventAt: number | null | undefined;
  now: number;
}

/**
 * How alive one chat is, measured only by its own recorded events. Three states, one rule:
 *
 * - event within the last minute  -> 'live'    (working now)
 * - event within the last 5 min   -> 'recent'  (just worked)
 * - otherwise                     -> 'recorded' (quiet)
 * - the viewer cannot be reached  -> 'disconnected'
 *
 * The windows are exported so the badge, the chat rows and the tooltips all quote the same
 * numbers instead of each picking their own idea of "recent".
 */
export function connectionState(input: ConnectionInput): ConnectionState {
  if (input.fetchFailing) return 'disconnected';
  const last = input.lastEventAt;
  if (typeof last !== 'number' || !Number.isFinite(last)) return 'recorded';
  const age = input.now - last;
  if (age <= ACTIVE_WINDOW_S) return 'live';
  if (age <= RECENT_WINDOW_S) return 'recent';
  return 'recorded';
}

export const CONNECTION_TEXT: Record<
  ConnectionState,
  { label: string; tooltip: string }
> = {
  live: {
    label: 'Active now',
    tooltip: 'An event was recorded in the last minute. That is what "active" means here.',
  },
  recent: {
    label: 'Recent activity',
    tooltip: 'The last event was 1–5 minutes ago: it just worked, but is not doing anything this second.',
  },
  recorded: {
    label: 'Quiet',
    tooltip:
      'No event in this chat for over 5 minutes. Other chats may still be recording — this badge only describes the chat you have open.',
  },
  disconnected: {
    label: 'Disconnected',
    tooltip: "Disconnected — can't reach the viewer",
  },
};

/** "12s ago", "4m ago", "2h ago" — the age that backs the badge, in words. */
export function activityAge(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Newest session by last activity, falling back to its first timestamp.
 *
 * Prefers sessions with a known event count > 0 so a stale empty session
 * never hides a full one; without any event counts, keeps the old behaviour.
 */
export function pickNewestSession(sessions: SessionMeta[]): SessionMeta | null {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  let best: SessionMeta | null = null;
  let bestTs = -Infinity;
  let bestHasEvents = false;
  for (const session of sessions) {
    const hasEvents =
      typeof session.events === 'number' && Number.isFinite(session.events) && session.events > 0;
    const candidates = [session.last_ts, session.first_ts];
    let ts: number | null = null;
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        ts = candidate;
        break;
      }
    }
    if (ts === null) continue;
    // A session with events wins over one without, regardless of timestamp.
    if (best !== null && hasEvents === bestHasEvents && ts <= bestTs) continue;
    if (best !== null && !hasEvents && bestHasEvents) continue;
    best = session;
    bestTs = ts;
    bestHasEvents = hasEvents;
  }
  return best ?? sessions[0] ?? null;
}
