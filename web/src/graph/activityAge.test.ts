import { describe, expect, it } from 'vitest';
import { activityAge } from './activityAge';

describe('activityAge', () => {
  it('handles absent, invalid and future timestamps', () => {
    expect(activityAge(null, 100)).toBe('Unknown');
    expect(activityAge(NaN, 100)).toBe('Unknown');
    expect(activityAge(100, Infinity)).toBe('Unknown');
    expect(activityAge(101, 100)).toBe('Just now');
  });
  it('formats elapsed time at unit boundaries', () => {
    expect(activityAge(0, 59)).toBe('Just now');
    expect(activityAge(0, 60)).toBe('1 minute ago');
    expect(activityAge(0, 120)).toBe('2 minutes ago');
    expect(activityAge(0, 3600)).toBe('1 hour ago');
    expect(activityAge(0, 7200)).toBe('2 hours ago');
    expect(activityAge(0, 86400)).toBe('1 day ago');
    expect(activityAge(0, 172800)).toBe('2 days ago');
  });
});
