import { expect, test } from 'vitest';
import { shouldLogScale } from './scale';

test('one giant call among small ones goes log', () => {
  expect(shouldLogScale(499_000, 4_000, 6_000)).toBe(true);
});

test('a chat that ended big still goes log when the median is small', () => {
  expect(shouldLogScale(500_000, 5_000, 400_000)).toBe(true);
});

test('an even chat stays linear', () => {
  expect(shouldLogScale(120_000, 100_000, 110_000)).toBe(false);
});

test('nothing recorded is linear, not broken', () => {
  expect(shouldLogScale(0, 0, null)).toBe(false);
});
