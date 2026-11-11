import { describe, expect, it } from 'vitest';
import { CancelledError, withRetry } from './retry';

const sleeps: number[] = [];
const fakeSleep = async (ms: number) => {
  sleeps.push(ms);
};

describe('retrying a request before saying it failed', () => {
  it('returns the first success and never waits', async () => {
    sleeps.length = 0;
    const value = await withRetry(async () => 'ok', { sleep: fakeSleep });
    expect(value).toBe('ok');
    expect(sleeps).toEqual([]);
  });

  it('recovers from one dropped request', async () => {
    sleeps.length = 0;
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('boom');
        return 'second';
      },
      { sleep: fakeSleep },
    );
    expect(value).toBe('second');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([400]);
  });

  it('gives up after the last attempt and throws the real error', async () => {
    sleeps.length = 0;
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`fail ${calls}`);
        },
        { attempts: 3, sleep: fakeSleep },
      ),
    ).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([400, 1200]);
  });

  it('stops immediately when the view unmounted', async () => {
    sleeps.length = 0;
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { cancelled: () => true, sleep: fakeSleep },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it('does not retry after the caller cancelled mid-wait', async () => {
    let cancelled = false;
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          cancelled = true;
          throw new Error('boom');
        },
        { cancelled: () => cancelled, sleep: fakeSleep },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toBe(1);
  });
});
