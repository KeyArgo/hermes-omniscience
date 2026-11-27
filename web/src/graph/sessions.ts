import type { SessionMeta } from '../types';

export type SessionSort = 'recent' | 'oldest' | 'busiest';

export const SESSION_SORTS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'busiest', label: 'Most steps' },
];

/** When a chat counts as "being worked on": an event landed this recently. */
export const WORKING_WINDOW_S = 90;

function activityAt(session: SessionMeta): number {
  const last = session.last_ts;
  if (typeof last === 'number' && Number.isFinite(last)) return last;
  const first = session.first_ts;
  if (typeof first === 'number' && Number.isFinite(first)) return first;
  return 0;
}

/**
 * Order the rail. "Most recent" means the chat that last received an event comes first, so a
 * chat the agent is working on right now sits at the top of the list without being pinned.
 * Ties fall back to the chat's start, so the order never flickers between polls.
 */
export function sortSessions(sessions: SessionMeta[], sort: SessionSort): SessionMeta[] {
  const rows = [...sessions];
  rows.sort((a, b) => {
    if (sort === 'busiest') {
      const diff = (b.events ?? 0) - (a.events ?? 0);
      if (diff !== 0) return diff;
      return activityAt(b) - activityAt(a);
    }
    const diff = activityAt(b) - activityAt(a);
    if (diff !== 0) return sort === 'oldest' ? -diff : diff;
    const startDiff = (b.first_ts ?? 0) - (a.first_ts ?? 0);
    return sort === 'oldest' ? -startDiff : startDiff;
  });
  return rows;
}

/**
 * The chat the agent is working on right now: the one whose last recorded event is freshest
 * and inside the working window. Null when everything has been quiet — an indicator that
 * never goes out is decoration, not state.
 */
export function workingSessionId(
  sessions: SessionMeta[],
  nowSeconds: number,
  windowSeconds: number = WORKING_WINDOW_S,
): string | null {
  let best: SessionMeta | null = null;
  for (const session of sessions) {
    const at = activityAt(session);
    if (at <= 0 || at > nowSeconds) continue;
    if (nowSeconds - at >= windowSeconds) continue;
    if (!best || at > activityAt(best)) best = session;
  }
  return best ? best.id : null;
}

export type ChatSortKey = 'context' | 'recent' | 'output' | 'calls';

export const CHAT_SORTS: { value: ChatSortKey; label: string }[] = [
  { value: 'context', label: 'Biggest context now' },
  { value: 'recent', label: 'Most recent' },
  { value: 'output', label: 'Most output' },
  { value: 'calls', label: 'Most calls' },
];

/**
 * Which chat to look at first. "Biggest context" is the one that matters most: that chat pays
 * for its whole context on every call, so it is where compacting or splitting buys the most.
 */
export function sortChats(chats: SessionMeta[], sort: ChatSortKey): SessionMeta[] {
  const rows = [...chats];
  if (sort === 'recent') {
    rows.sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0));
    return rows;
  }
  // Current context, not the historical peak: after a compaction a chat is cheap again and
  // must stop ranking as the most expensive one.
  const key = (c: SessionMeta) =>
    sort === 'context' ? (c.prompt_now && c.prompt_now > 0 ? c.prompt_now : (c.prompt_max ?? 0))
      : sort === 'output' ? (c.output ?? 0)
        : (c.calls ?? 0);
  rows.sort((a, b) => key(b) - key(a) || (b.last_ts ?? 0) - (a.last_ts ?? 0));
  return rows;
}

/** Which chats the Tokens list is willing to show at once. */
export type ChatWindow = 'hour' | 'today' | 'all';

export const CHAT_WINDOWS: { value: ChatWindow; label: string }[] = [
  { value: 'hour', label: 'Last hour' },
  { value: 'today', label: 'Today' },
  { value: 'all', label: 'All chats' },
];

export const CHAT_HOUR_S = 3600;

function startOfLocalDay(nowSeconds: number): number {
  const d = new Date(nowSeconds * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Does this chat belong in the window? The Tokens list defaults to the last hour so it ranks
 * what is being worked on instead of filling with conversations that no longer exist. A chat
 * with no timestamp only belongs in "all".
 */
export function inChatWindow(
  chat: SessionMeta,
  window: ChatWindow,
  nowSeconds: number,
): boolean {
  const at = activityAt(chat);
  if (window === 'all') return true;
  if (at <= 0) return false;
  if (window === 'today') return at >= startOfLocalDay(nowSeconds) && at <= nowSeconds + 60;
  return nowSeconds - at < CHAT_HOUR_S && at <= nowSeconds + 60;
}

/**
 * The chats the list shows. *keepId* is the chat already open: it stays visible even when it
 * is older than the window, so the row you are reading cannot disappear underneath you.
 */
export function withinChatWindow(
  chats: SessionMeta[],
  window: ChatWindow,
  nowSeconds: number,
  keepId: string | null = null,
): SessionMeta[] {
  return chats.filter(
    (chat) => chat.id === keepId || inChatWindow(chat, window, nowSeconds),
  );
}

/**
 * Which rankings the time window applies to.
 *
 * Only "Biggest context now": a chat that went quiet an hour ago still carries a large context,
 * but it is not what needs attention today, so it must not head that list. "Most recent",
 * "Most output" and "Most calls" are questions about history, and an old chat is a legitimate
 * answer to them — so those show everything the recorder has.
 */
export function windowAppliesTo(sort: ChatSortKey): boolean {
  return sort === 'context';
}

/** How many chats each window would show, so an empty hour can offer the next step. */
export function chatWindowCounts(
  chats: SessionMeta[],
  nowSeconds: number,
): Record<ChatWindow, number> {
  const counts: Record<ChatWindow, number> = { hour: 0, today: 0, all: 0 };
  for (const chat of chats) {
    for (const option of CHAT_WINDOWS) {
      if (inChatWindow(chat, option.value, nowSeconds)) counts[option.value] += 1;
    }
  }
  return counts;
}
