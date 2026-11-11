import type { UsageDay, UsageDayModel, UsageModel } from '../types';

/** 1,682,309,441 reads as "1.68B" — a page of totals needs lengths, not digit counts. */
export function compactNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

/** Exact figures belong in tooltips; this is the short form for a chip. */
export function exactNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

/**
 * A price, from a figure someone else measured. Sub-cent amounts keep four places: a real
 * $0.0046 rendered as "$0.00" is the dishonesty this formatting exists to avoid.
 */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `~$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function pct(x: number | null | undefined, places = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(places)}%`;
}

/** Seconds, said the way a person reads a wait. */
export function secs(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Short model name: the vendor prefix tells the reader nothing they need on one row. */
export function shortModel(model: string): string {
  const name = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return name;
}

export const SHADE_STEPS = 4;

/**
 * Which shade a day's tokens deserve. Scaled to the busiest day in view, not to a fixed
 * threshold: two days of history and two years of history must both use the whole scale.
 */
export function shadeFor(tokens: number, max: number): number {
  if (!(tokens > 0) || !(max > 0)) return 0;
  const share = tokens / max;
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}

export interface CalendarCell {
  day: string;
  tokens: number;
  shade: number;
  /** 0 = Sunday … 6 = Saturday, so the grid can start each column on the right row. */
  weekday: number;
}

/**
 * One cell per day between *since* and *now*, including days with no usage — a calendar with
 * holes in it cannot be read as a streak. Accepts the report's own daily rows.
 */
export function calendarCells(
  daily: UsageDay[],
  since: number,
  now: number,
): CalendarCell[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const cells: CalendarCell[] = [];
  // "All" arrives as since = 0, which is 1970: without this floor the calendar builds twenty
  // thousand cells and the page grows to ninety thousand pixels. Start at the first day that
  // actually has a call.
  const firstDay = daily.length ? daily[0].day : null;
  const startMs = since > 0
    ? since * 1000
    : firstDay
      ? new Date(`${firstDay}T00:00:00`).getTime()
      : now * 1000;
  const start = new Date(startMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now * 1000);
  end.setHours(0, 0, 0, 0);
  const max = daily.reduce((m, d) => Math.max(m, d.prompt + d.output), 0);
  // A year and a day is the most a calendar can say; older history is in the tables.
  let guard = 0;
  for (let cursor = new Date(start); cursor <= end && guard < 400; cursor.setDate(cursor.getDate() + 1), guard += 1) {
    const day = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
      cursor.getDate(),
    ).padStart(2, '0')}`;
    const row = byDay.get(day);
    const tokens = row ? row.prompt + row.output : 0;
    cells.push({ day, tokens, shade: shadeFor(tokens, max), weekday: cursor.getDay() });
  }
  return cells;
}

export interface StackRow {
  day: string;
  /** Model name → tokens sent that day, in the order of *keys*. */
  parts: { model: string; tokens: number }[];
  total: number;
}

/**
 * Daily bars split by model. The busiest few models get their own band and everything else
 * is folded into "other": a legend with nine entries is a table, not a chart.
 */
export function stackByModel(
  daily: UsageDay[],
  dailyModels: UsageDayModel[],
  topN = 4,
): { rows: StackRow[]; keys: string[] } {
  const totals = new Map<string, number>();
  for (const row of dailyModels) {
    totals.set(row.model, (totals.get(row.model) ?? 0) + row.prompt + row.output);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const keys = ranked.slice(0, topN);
  const hasOther = ranked.length > keys.length;
  const lookup = new Map<string, Map<string, number>>();
  for (const row of dailyModels) {
    const key = keys.includes(row.model) ? row.model : 'other';
    const perDay = lookup.get(row.day) ?? new Map<string, number>();
    perDay.set(key, (perDay.get(key) ?? 0) + row.prompt + row.output);
    lookup.set(row.day, perDay);
  }
  const rows = daily.map((d) => {
    const perDay = lookup.get(d.day) ?? new Map<string, number>();
    const parts = keys.map((model) => ({ model, tokens: perDay.get(model) ?? 0 }));
    if (hasOther) parts.push({ model: 'other', tokens: perDay.get('other') ?? 0 });
    return { day: d.day, parts, total: parts.reduce((s, p) => s + p.tokens, 0) };
  });
  return { rows, keys: hasOther ? [...keys, 'other'] : keys };
}

/** Share of a row's bar each part gets, as percentages that sum to 100. */
export function partShares(row: StackRow): number[] {
  if (!(row.total > 0)) return row.parts.map(() => 0);
  return row.parts.map((p) => (p.tokens / row.total) * 100);
}

/**
 * What to say about a model's latency: a healthy median with a slow tail means queuing, and
 * one number alone cannot say that.
 */
export function latencySentence(row: UsageModel): string {
  if (row.p50_s === null || row.p95_s === null) return 'no timed calls';
  if (row.p95_s >= row.p50_s * 4 && row.p95_s > 10) return 'slow tail — likely queuing';
  if (row.p95_s > 30) return 'slow throughout';
  return 'steady';
}

/** The three busiest hours, from the report's daily rows is not possible — kept for callers
 * that already have an hourly series; the Usage page asks the chat list instead. */
