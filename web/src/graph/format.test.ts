import { describe, expect, it } from 'vitest';
import {
  CONNECTION_TEXT,
  connectionState,
  formatDuration,
  formatDurationMs,
  formatLocalTime,
  formatNumber,
  formatTokens,
  pickNewestSession,
  relativeTime,
  sessionOutcome,
  sessionStartLabel,
  shortModel,
} from './format';

describe('duration formatter', () => {
  it('gives human-readable durations', () => {
    expect(formatDuration(0.85)).toBe('850 ms');
    expect(formatDuration(3.2)).toBe('3.2 s');
    expect(formatDuration(1)).toBe('1.0 s');
    expect(formatDuration(0.9996)).toBe('1.0 s'); // rounds up: never "1000 ms"
    expect(formatDuration(196)).toBe('3 min 16 s');
    expect(formatDuration(60)).toBe('1 min 0 s');
    expect(formatDuration(3720)).toBe('1 h 2 min');
  });

  it('sends values that round to 60.0 s into the minute format', () => {
    expect(formatDuration(59.96)).toBe('1 min 0 s'); // would otherwise read "60.0 s"
    expect(formatDuration(59.94)).toBe('59.9 s'); // rounds to 59.9, stays in seconds
    expect(formatDuration(59.4)).toBe('59.4 s');
    expect(formatDuration(59.5)).toBe('59.5 s'); // displays below 60.0, stays in seconds
    expect(formatDuration(119.96)).toBe('2 min 0 s');
  });

  it('rejects junk as "not reported", never 0', () => {
    expect(formatDuration(NaN)).toBe('not reported');
    expect(formatDuration(-3)).toBe('not reported');
    expect(formatDurationMs(NaN)).toBe('not reported');
  });

  it('handles milliseconds input', () => {
    expect(formatDurationMs(850)).toBe('850 ms');
    expect(formatDurationMs(999)).toBe('999 ms');
    expect(formatDurationMs(1000)).toBe('1.0 s');
    expect(formatDurationMs(3200)).toBe('3.2 s');
    expect(formatDurationMs(42)).toBe('42 ms');
  });
});

describe('number formatter', () => {
  it('adds thousands separators', () => {
    expect(formatNumber(13916)).toBe('13,916');
    expect(formatNumber(151)).toBe('151');
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatTokens(13916)).toBe('13,916');
    expect(formatTokens(undefined)).toBe('not reported');
  });
});

describe('relative time', () => {
  const now = 1762500000;
  it('says "just now" below a minute', () => {
    expect(relativeTime(now - 30, now)).toBe('just now');
  });
  it('says minutes for older events', () => {
    expect(relativeTime(now - 12 * 60, now)).toBe('12 min ago');
  });
  it('keeps seconds in the 0-59 range and minutes correct', () => {
    // 119.6 s previously read "1 min 60 s ago" (rounding overflow)
    expect(relativeTime(now - 119.6, now)).toBe('2 min ago');
    expect(relativeTime(now - 61.5, now)).toBe('1 min 2 s ago');
    expect(relativeTime(now - 64.4, now)).toBe('1 min 4 s ago');
    expect(relativeTime(now - 59.6, now)).toBe('1 min ago');
  });
  it('says hours and days for old sessions', () => {
    expect(relativeTime(now - 3600, now)).toBe('1 h 0 min ago');
    expect(relativeTime(now - 25 * 3600, now)).toBe('1 d ago');
  });
  it('treats missing timestamps as unknown', () => {
    expect(relativeTime(null, now)).toBe('unknown');
  });
});

describe('local time', () => {
  it('renders a local timestamp', () => {
    // 12:00 UTC is the same calendar date in every time zone from UTC-11 to UTC+11
    const ts = Date.UTC(2026, 10, 5, 12, 0, 0) / 1000;
    const text = formatLocalTime(ts);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(text).toContain('2026-11-05');
  });
  it('handles missing values', () => {
    expect(formatLocalTime(null)).toBe('not reported');
  });
});

describe('session start label', () => {
  const now = new Date(2026, 10, 7, 15, 30).getTime() / 1000;
  const local = (day: number, hour: number, minute: number): number =>
    new Date(2026, 10, day, hour, minute).getTime() / 1000;

  it('labels today and yesterday', () => {
    expect(sessionStartLabel(local(7, 14, 2), now)).toBe('Today 14:02');
    expect(sessionStartLabel(local(6, 9, 15), now)).toBe('Yesterday 09:15');
  });

  it('labels older sessions with month, day and time', () => {
    expect(sessionStartLabel(local(5, 14, 2), now)).toBe('Nov 5 14:02');
    expect(sessionStartLabel(local(1, 0, 5), now)).toBe('Nov 1 00:05');
  });

  it('treats yesterday across a month boundary as yesterday', () => {
    const newYear = new Date(2027, 0, 1, 8, 0).getTime() / 1000;
    const lastYear = new Date(2026, 11, 31, 23, 59).getTime() / 1000;
    expect(sessionStartLabel(lastYear, newYear)).toBe('Yesterday 23:59');
  });

  it('shows "not reported" for missing or invalid values', () => {
    expect(sessionStartLabel(null, now)).toBe('not reported');
    expect(sessionStartLabel(undefined, now)).toBe('not reported');
    expect(sessionStartLabel(0, now)).toBe('not reported');
    expect(sessionStartLabel(Number.NaN, now)).toBe('not reported');
  });
});

describe('session outcome', () => {
  it('uses plain words for finished runs', () => {
    expect(sessionOutcome('ok')).toBe('finished OK');
    expect(sessionOutcome('completed')).toBe('finished OK');
    expect(sessionOutcome('error')).toBe('finished with errors');
    expect(sessionOutcome('failed')).toBe('finished with errors');
    expect(sessionOutcome('running')).toBe('still running');
    expect(sessionOutcome('interrupted')).toBe('stopped early');
    expect(sessionOutcome('cancelled')).toBe('stopped early');
  });

  it('shows "not reported" for missing or unknown statuses', () => {
    expect(sessionOutcome(null)).toBe('not reported');
    expect(sessionOutcome(undefined)).toBe('not reported');
    expect(sessionOutcome('')).toBe('not reported');
    expect(sessionOutcome('weird')).toBe('not reported');
  });
});

describe('short model name', () => {
  it('keeps short names and shortens long ones', () => {
    expect(shortModel('gpt-4o')).toBe('gpt-4o');
    expect(shortModel('claude-3-5-sonnet-20241022')).toBe('claude-3-5-son…');
  });

  it('shows "not reported" for missing values', () => {
    expect(shortModel(null)).toBe('not reported');
    expect(shortModel(undefined)).toBe('not reported');
    expect(shortModel('   ')).toBe('not reported');
  });
});

describe('connection state', () => {
  const now = 1762500000;

  it('is disconnected when a fetch failed', () => {
    expect(
      connectionState({ socketOpen: true, fetchFailing: true, lastEventAt: now - 5, now }),
    ).toBe('disconnected');
    expect(
      connectionState({ socketOpen: false, fetchFailing: true, lastEventAt: now - 5, now }),
    ).toBe('disconnected');
  });

  it('is live when an event arrived recently, even with the socket closed', () => {
    expect(
      connectionState({ socketOpen: false, fetchFailing: false, lastEventAt: now - 5, now }),
    ).toBe('live');
  });

  it('is recent between one and five minutes, and quiet after five', () => {
    expect(
      connectionState({ socketOpen: false, fetchFailing: false, lastEventAt: now - 61, now }),
    ).toBe('recent');
    expect(
      connectionState({ socketOpen: false, fetchFailing: false, lastEventAt: now - 300, now }),
    ).toBe('recent');
    expect(
      connectionState({ socketOpen: false, fetchFailing: false, lastEventAt: now - 301, now }),
    ).toBe('recorded');
  });

  it('is live only when an event arrived in the last 60 seconds', () => {
    expect(
      connectionState({ socketOpen: true, fetchFailing: false, lastEventAt: now - 59, now }),
    ).toBe('live');
    expect(
      connectionState({ socketOpen: true, fetchFailing: false, lastEventAt: now - 60, now }),
    ).toBe('live');
  });

  it('is quiet when the socket is open but nothing arrived for over five minutes', () => {
    expect(
      connectionState({ socketOpen: true, fetchFailing: false, lastEventAt: now - 601, now }),
    ).toBe('recorded');
    expect(
      connectionState({ socketOpen: true, fetchFailing: false, lastEventAt: null, now }),
    ).toBe('recorded');
    expect(
      connectionState({
        socketOpen: true,
        fetchFailing: false,
        lastEventAt: Number.NaN,
        now,
      }),
    ).toBe('recorded');
  });

  it('provides the exact one-line labels and tooltips', () => {
    expect(CONNECTION_TEXT.live).toEqual({
      label: 'Active now',
      tooltip: 'An event was recorded in the last minute. That is what "active" means here.',
    });
    expect(CONNECTION_TEXT.recent).toEqual({
      label: 'Recent activity',
      tooltip: 'The last event was 1–5 minutes ago: it just worked, but is not doing anything this second.',
    });
    expect(CONNECTION_TEXT.recorded).toEqual({
      label: 'Quiet',
      tooltip:
        'No event in this chat for over 5 minutes. Other chats may still be recording — this badge only describes the chat you have open.',
    });
    expect(CONNECTION_TEXT.disconnected).toEqual({
      label: 'Disconnected',
      tooltip: "Disconnected — can't reach the viewer",
    });
  });
});

describe('newest session', () => {
  it('picks the session with the latest activity', () => {
    const sessions = [
      { id: 'old', first_ts: 100, last_ts: 200 },
      { id: 'new', first_ts: 300, last_ts: 500 },
      { id: 'middle', first_ts: 400, last_ts: 450 },
    ];
    expect(pickNewestSession(sessions)?.id).toBe('new');
  });

  it('falls back to first_ts when last_ts is missing', () => {
    const sessions = [
      { id: 'a', first_ts: 100, last_ts: null },
      { id: 'b', first_ts: 300, last_ts: undefined },
    ];
    expect(pickNewestSession(sessions)?.id).toBe('b');
  });

  it('falls back to the first session when no timestamps exist', () => {
    const sessions = [{ id: 'a' }, { id: 'b' }];
    expect(pickNewestSession(sessions)?.id).toBe('a');
  });

  it('picks an eventful older session over a newer empty one', () => {
    const sessions = [
      { id: 'a', last_ts: 200, events: 0 },
      { id: 'b', last_ts: 100, events: 114 },
    ];
    expect(pickNewestSession(sessions)?.id).toBe('b');
  });

  it('keeps newest-by-timestamp when no session has events > 0', () => {
    const allEmpty = [
      { id: 'a', last_ts: 200, events: 0 },
      { id: 'b', last_ts: 100, events: 0 },
    ];
    expect(pickNewestSession(allEmpty)?.id).toBe('a');
    const missing = [
      { id: 'a', last_ts: 200 },
      { id: 'b', last_ts: 100 },
    ];
    expect(pickNewestSession(missing)?.id).toBe('a');
  });

  it('returns null for an empty list', () => {
    expect(pickNewestSession([])).toBeNull();
  });
});
