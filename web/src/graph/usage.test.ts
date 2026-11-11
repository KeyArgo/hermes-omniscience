import { describe, expect, it } from 'vitest';
import type { UsageDay, UsageDayModel, UsageModel } from '../types';
import {
  calendarCells,
  compactNum,
  exactNum,
  latencySentence,
  partShares,
  pct,
  secs,
  shadeFor,
  shortModel,
  stackByModel,
  usd,
} from './usage';

function day(day: string, prompt: number, output = 1000): UsageDay {
  return {
    day,
    prompt,
    output,
    calls: 1,
    chats: 1,
    fresh: prompt,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    tool_calls: 0,
    errors: 0,
    aux_calls: 0,
    cost: 0,
  };
}

function dm(day: string, model: string, prompt: number): UsageDayModel {
  return { day, model, prompt, output: 0, calls: 1 };
}

function model(patch: Partial<UsageModel>): UsageModel {
  return {
    model: 'm',
    calls: 1,
    prompt: 0,
    fresh: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0,
    errors: 0,
    p50_s: 1,
    p95_s: 1,
    ttfb_median_s: 0.2,
    cost: null,
    rates: null,
    ...patch,
  };
}

describe('numbers', () => {
  it('shortens totals without inventing precision', () => {
    expect(compactNum(1_682_309_441)).toBe('1.68B');
    expect(compactNum(47_688_868)).toBe('47.69M');
    expect(compactNum(12_300)).toBe('12k');
    expect(compactNum(812)).toBe('812');
    expect(compactNum(null)).toBe('—');
  });

  it('keeps the exact figure available', () => {
    expect(exactNum(1_682_309_441)).toBe((1_682_309_441).toLocaleString());
  });

  it('never renders a real sub-cent amount as $0.00', () => {
    expect(usd(0.0046)).toBe('~$0.0046');
    expect(usd(14.1345)).toBe('$14.13');
    expect(usd(0)).toBe('$0.00');
    expect(usd(null)).toBe('—');
  });

  it('says a wait the way a person reads it', () => {
    expect(secs(0.42)).toBe('420 ms');
    expect(secs(3.567)).toBe('3.6 s');
    expect(secs(75)).toBe('1m 15s');
    expect(secs(null)).toBe('—');
  });

  it('percentages round once', () => {
    expect(pct(0.9701)).toBe('97%');
    expect(pct(0.9701, 1)).toBe('97.0%');
    expect(pct(null)).toBe('—');
  });

  it('a vendor prefix is dropped but the model stays identifiable', () => {
    expect(shortModel('deepseek/deepseek-v4.1-flash-1017')).toBe('deepseek-v4.1-flash-1017');
    expect(shortModel('local')).toBe('local');
  });
});

describe('calendar', () => {
  const now = Math.floor(new Date(2026, 10, 9, 18, 0, 0).getTime() / 1000);
  const since = Math.floor(new Date(2026, 10, 6, 9, 0, 0).getTime() / 1000);

  it('one cell per day, including days with no usage', () => {
    const cells = calendarCells([day('2026-11-09', 5000)], since, now);
    expect(cells.map((c) => c.day)).toEqual([
      '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09',
    ]);
  });

  it('scales the shades to the busiest day in view', () => {
    const cells = calendarCells(
      [day('2026-11-08', 1000, 0), day('2026-11-09', 4000, 0)],
      since,
      now,
    );
    const byDay = Object.fromEntries(cells.map((c) => [c.day, c]));
    expect(byDay['2026-11-09'].shade).toBe(4);
    expect(byDay['2026-11-08'].shade).toBe(1);
    expect(byDay['2026-11-07'].shade).toBe(0);
  });

  it('a quiet day is empty, not a lowest shade', () => {
    expect(shadeFor(0, 1000)).toBe(0);
    expect(shadeFor(1, 1000)).toBe(1);
  });

  it('carries the weekday so the grid can align', () => {
    const cells = calendarCells([], since, now);
    expect(cells[0].weekday).toBe(new Date(2026, 10, 6).getDay());
  });
});

describe('daily bars by model', () => {
  const daily = [day('2026-11-08', 3000), day('2026-11-09', 6000)];
  const dailyModels = [
    dm('2026-11-08', 'big', 2000),
    dm('2026-11-08', 'small', 1000),
    dm('2026-11-09', 'big', 5000),
    dm('2026-11-09', 'small', 1000),
  ];

  it('each day carries its models in a stable order', () => {
    const { rows, keys } = stackByModel(daily, dailyModels);
    expect(keys).toEqual(['big', 'small']);
    expect(rows.map((r) => r.day)).toEqual(['2026-11-08', '2026-11-09']);
    expect(rows[0].parts.map((p) => p.tokens)).toEqual([2000, 1000]);
  });

  it('folds the long tail into "other" rather than growing the legend', () => {
    const many = [
      dm('2026-11-09', 'a', 400),
      dm('2026-11-09', 'b', 300),
      dm('2026-11-09', 'c', 200),
      dm('2026-11-09', 'd', 100),
      dm('2026-11-09', 'e', 50),
    ];
    const { rows, keys } = stackByModel([day('2026-11-09', 1050)], many, 3);
    expect(keys).toEqual(['a', 'b', 'c', 'other']);
    expect(rows[0].parts.find((p) => p.model === 'other')?.tokens).toBe(150);
  });

  it('part widths sum to the whole bar', () => {
    const { rows } = stackByModel(daily, dailyModels);
    expect(partShares(rows[0]).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });

  it('an empty day has no width rather than dividing by zero', () => {
    const { rows } = stackByModel([day('2026-11-10', 0)], [], 3);
    expect(partShares(rows[0])).toEqual([]);
  });
});

describe('latency wording', () => {
  it('a healthy median with a slow tail is named as queuing', () => {
    expect(latencySentence(model({ p50_s: 3.5, p95_s: 21 }))).toBe('slow tail — likely queuing');
  });

  it('a fast model is not described as slow', () => {
    expect(latencySentence(model({ p50_s: 2, p95_s: 4 }))).toBe('steady');
  });

  it('no timed calls says so instead of printing nothing', () => {
    expect(latencySentence(model({ p50_s: null, p95_s: null }))).toBe('no timed calls');
  });
});

it('the calendar does not start in 1970 when the period is everything', () => {
  const now = Date.UTC(2026, 10, 9, 12) / 1000;
  const daily = [
    { day: '2026-08-14', calls: 3, prompt: 100, output: 10, cost: 0 } as never,
    { day: '2026-11-09', calls: 5, prompt: 200, output: 20, cost: 0 } as never,
  ];
  const cells = calendarCells(daily, 0, now);
  // 14 Aug to 9 Nov is 88 days; the old behaviour produced 20,000+.
  expect(cells.length).toBe(88);
  expect(cells[0].day).toBe('2026-08-14');
  expect(cells[cells.length - 1].day).toBe('2026-11-09');
});
