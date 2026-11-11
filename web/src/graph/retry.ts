/**
 * Try a request a few times before telling the reader it failed.
 *
 * The Usage page is one slow aggregate (a cold read of the whole recording takes ~3.4 s here, and
 * the viewer restarts under an open tab on every deploy). A single transient failure used to leave
 * a red line and a button, and a request that never settled left "Reading the recording…" on screen
 * for ever — the owner's report was "not populating". Retrying once or twice turns both into a page
 * that arrives on its own.
 *
 * Deliberately dumb: no jitter, no timers hidden inside a component, and the sleep is injectable so
 * a test does not spend seconds waiting.
 */

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Wait before attempt N+1; the last value is reused when attempts run past the list. */
  delaysMs?: number[];
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Checked before every attempt and every wait, so an unmounted view stops retrying. */
  cancelled?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delays = options.delaysMs?.length ? options.delaysMs : [400, 1200];
  const sleep = options.sleep ?? defaultSleep;
  const cancelled = options.cancelled ?? (() => false);

  let lastError: unknown = new Error('no attempt was made');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (cancelled()) throw new CancelledError();
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      if (cancelled()) throw new CancelledError();
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
    }
  }
  throw lastError;
}
