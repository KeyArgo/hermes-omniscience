import { describe, expect, it } from 'vitest';
import { HEAT_LEVELS, HEAT_LIMIT, heatLevel, heatRange, heatSentence } from './heat';

describe('heatLevel', () => {
  it('is comfortable with plenty of headroom', () => {
    expect(heatLevel(0)).toBe('green');
    expect(heatLevel(900)).toBe('green');
    expect(heatLevel(HEAT_LIMIT * 0.19)).toBe('green');
  });

  it('steps up through the whole gradient', () => {
    expect(heatLevel(HEAT_LIMIT * 0.2)).toBe('lime');
    expect(heatLevel(HEAT_LIMIT * 0.4)).toBe('yellow');
    expect(heatLevel(HEAT_LIMIT * 0.6)).toBe('orange');
    expect(heatLevel(HEAT_LIMIT * 0.8)).toBe('red');
    expect(heatLevel(HEAT_LIMIT * 0.94)).toBe('blood');
  });

  it('keeps the levels in order with no gaps', () => {
    const froms = HEAT_LEVELS.map((entry) => entry.from);
    expect(froms[0]).toBe(0);
    expect([...froms].sort((a, b) => a - b)).toEqual(froms);
  });

  it('treats missing or nonsense values as comfortable, never as an error', () => {
    expect(heatLevel(null)).toBe('green');
    expect(heatLevel(undefined)).toBe('green');
    expect(heatLevel(Number.NaN)).toBe('green');
    expect(heatLevel(-5)).toBe('green');
  });

  it('scales with the ceiling: the same context is worse on a smaller window', () => {
    const tokens = 200_000;
    expect(heatLevel(tokens, 1_000_000)).toBe('lime');
    expect(heatLevel(tokens, 500_000)).toBe('yellow');
    expect(heatLevel(tokens, 220_000)).toBe('red');
  });
});

describe('heatRange', () => {
  it('describes the band in tokens', () => {
    expect(heatRange('green')).toBe('under 100k');
    expect(heatRange('yellow')).toBe('200k–300k');
    expect(heatRange('blood')).toBe('over 470k');
  });
});

describe('heatSentence', () => {
  it('says the size, the share, and what it means', () => {
    const line = heatSentence(300_000);
    expect(line).toContain('300,000 tokens');
    expect(line).toContain('60%');
    expect(line).toContain('expensive per call');
  });

  it('mentions the peak only when the chat was compacted since', () => {
    expect(heatSentence(50_000, 400_000)).toContain('peaked at 400,000');
    expect(heatSentence(50_000, 50_000)).not.toContain('peaked');
    expect(heatSentence(50_000, null)).not.toContain('peaked');
  });

  it('says how old the figure is when the last call was a while ago', () => {
    const line = heatSentence(512_251, 640_000, undefined, 1_800);
    expect(line).toContain('Context at the last model call');
    expect(line).toContain('30 minutes ago');
    expect(line).toContain('appears with the next call');
    expect(line).toContain('peaked at 640,000');
  });

  it('does not add an age when the call is recent', () => {
    expect(heatSentence(50_000, null, undefined, 60)).not.toContain('minutes ago');
  });

  it('says so when nothing was recorded', () => {
    expect(heatSentence(null)).toBe('No context size recorded for this chat.');
  });
});
