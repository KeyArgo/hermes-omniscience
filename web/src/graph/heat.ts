/**
 * How much context a chat is carrying, in one glance.
 *
 * Cost per call is dominated by what the agent re-sends: the whole context goes to the model
 * every time. So the useful question is not "how many tokens has this chat ever used" but "how
 * big is what is being sent right now, and how close is that to the point where it has to be
 * compacted".
 *
 * That makes the scale a *share of a ceiling* rather than a fixed number of tokens: 200k is
 * comfortable on a 1M window and dangerous on a 256k one. The ceiling below is the practical one
 * measured on this machine, kept as a single constant so it can move when the model changes.
 *
 * Nothing here invents money: these are token counts, which is what the recorder stores.
 */

export type ContextHeat = 'green' | 'lime' | 'yellow' | 'orange' | 'red' | 'blood';

/**
 * Where "too much" starts, in prompt tokens.
 *
 * Measured from the recordings here: 6,334 model calls run from a few hundred tokens to 517,312;
 * the 90th percentile is 351,726; and the 14 compactions we have seen fired with the prompt at
 * 290,556 (median), 384,373 (75th percentile) and 466,728 at the top. So the practical wall sits
 * around half a million tokens, and red belongs where compaction actually starts firing.
 *
 * A different model on a different window moves this number, not the shape of the scale.
 */
export const HEAT_LIMIT = 500_000;

/** The look, comfortable through to about to be cut. `from` is a share of HEAT_LIMIT. */
export const HEAT_LEVELS: {
  level: ContextHeat;
  label: string;
  from: number;
  meaning: string;
}[] = [
  { level: 'green', label: 'Comfortable', from: 0, meaning: 'plenty of headroom, cheap to re-send' },
  { level: 'lime', label: 'Fine', from: 0.2, meaning: 'growing, still cheap' },
  { level: 'yellow', label: 'Filling up', from: 0.4, meaning: 'every call is paying for a lot' },
  { level: 'orange', label: 'Heavy', from: 0.6, meaning: 'expensive per call, worth compacting soon' },
  { level: 'red', label: 'Near the limit', from: 0.8, meaning: 'compaction starts firing around here' },
  { level: 'blood', label: 'At the limit', from: 0.94, meaning: 'the context is about to be cut' },
];

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export function heatLevel(
  promptTokens: number | null | undefined,
  limit: number = HEAT_LIMIT,
): ContextHeat {
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens <= 0) {
    return 'green';
  }
  const safeLimit = limit > 0 ? limit : HEAT_LIMIT;
  const share = promptTokens / safeLimit;
  for (let i = HEAT_LEVELS.length - 1; i >= 0; i -= 1) {
    if (share >= HEAT_LEVELS[i].from) return HEAT_LEVELS[i].level;
  }
  return 'green';
}

/** The token range a level covers, in words: "200k–300k". Used by the key. */
export function heatRange(level: ContextHeat, limit: number = HEAT_LIMIT): string {
  const safeLimit = limit > 0 ? limit : HEAT_LIMIT;
  const index = HEAT_LEVELS.findIndex((entry) => entry.level === level);
  if (index < 0) return '';
  const start = HEAT_LEVELS[index].from * safeLimit;
  const next = HEAT_LEVELS[index + 1];
  if (!next) return `over ${short(start)}`;
  if (index === 0) return `under ${short(next.from * safeLimit)}`;
  return `${short(start)}–${short(next.from * safeLimit)}`;
}

/**
 * The same thing as a sentence, for a tooltip.
 *
 * `peak` is optional: when a chat was compacted, the peak is history and the current size is
 * what the next message pays for, so say both and let the reader see the difference.
 */
export function heatSentence(
  promptTokens: number | null | undefined,
  peak?: number | null,
  limit: number = HEAT_LIMIT,
  /** Seconds since the call that produced this figure, when that call is not recent. */
  ageSeconds?: number | null,
): string {
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens <= 0) {
    return 'No context size recorded for this chat.';
  }
  const safeLimit = limit > 0 ? limit : HEAT_LIMIT;
  const level = heatLevel(promptTokens, safeLimit);
  const entry = HEAT_LEVELS.find((candidate) => candidate.level === level);
  const share = Math.round((promptTokens / safeLimit) * 100);
  const stale = typeof ageSeconds === 'number' && Number.isFinite(ageSeconds) && ageSeconds > 300;
  // "now" is a claim about the present. When the newest call is old, it is history instead, and
  // after a compaction the smaller figure only appears with the next model call.
  const headline = stale
    ? `Context at the last model call: ${Math.round(promptTokens).toLocaleString()} tokens — ${share}% of the ${short(safeLimit)} ceiling, ${entry?.meaning ?? ''}.`
    : `Context now ${Math.round(promptTokens).toLocaleString()} tokens — ${share}% of the ${short(safeLimit)} ceiling, ${entry?.meaning ?? ''}.`;
  const parts = [headline];
  if (stale) {
    parts.push(
      `Recorded ${Math.round((ageSeconds as number) / 60)} minutes ago — if you compacted since, ` +
        'the smaller size appears with the next call.',
    );
  }
  if (typeof peak === 'number' && Number.isFinite(peak) && peak > promptTokens * 1.05) {
    parts.push(`It peaked at ${Math.round(peak).toLocaleString()} before the last compaction.`);
  }
  return parts.join(' ');
}
