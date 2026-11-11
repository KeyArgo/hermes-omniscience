import { describe, expect, it } from 'vitest';
import { diagnose } from './LatencyView';
import type { ModelLatency, ProviderLatency } from '../api';

function model(over: Partial<ModelLatency>): ModelLatency {
  return {
    provider: 'nous',
    model: 'm',
    calls: 10,
    p50_s: 2,
    p95_s: 4,
    max_s: 5,
    ttfb_p50_s: 1,
    over_30s: 0,
    errors: 0,
    rate_limited: 0,
    timeouts: 0,
    other_errors: 0,
    retried: 0,
    compactions: 0,
    last_seen: 1_800_000_000,
    ...over,
  };
}

function provider(over: Partial<ProviderLatency>): ProviderLatency {
  return {
    provider: 'nous',
    models: 1,
    calls: 10,
    errors: 0,
    rate_limited: 0,
    timeouts: 0,
    retried: 0,
    compactions: 0,
    p95_s: 4,
    worst_model: 'm',
    last_seen: 1_800_000_000,
    ...over,
  };
}

describe('the delays page diagnosis', () => {
  it('leads with the provider that was throttled, and says it is the account', () => {
    const out = diagnose([model({})], [provider({ rate_limited: 12, retried: 9 })], 10);
    expect(out[0]).toContain('nous');
    expect(out[0]).toContain('12');
    expect(out[0]).toContain('account');
  });

  it('names the slow tail with its p95 and its first-word time', () => {
    const out = diagnose(
      [model({ model: 'slow-one', p95_s: 22, p50_s: 3, ttfb_p50_s: 0.4 })],
      [provider({ p95_s: 22 })],
      10,
    );
    expect(out.join(' ')).toContain('slow-one');
    expect(out.join(' ')).toContain('22.0s');
  });

  it('does not call a healthy model queuing', () => {
    const out = diagnose([model({ p95_s: 3 })], [provider({ p95_s: 3 })], 10);
    expect(out.join(' ').toLowerCase()).not.toContain('queuing');
  });

  it('counts timeouts apart from rate limits', () => {
    const out = diagnose(
      [model({ model: 'flaky', timeouts: 3, other_errors: 1 })],
      [provider({ errors: 4, timeouts: 3 })],
      10,
    );
    const line = out.find((row) => row.includes('flaky'));
    expect(line).toContain('3 timeouts');
  });

  it('says compaction is real when a model saw context drop', () => {
    const out = diagnose([model({ compactions: 7 })], [provider({ compactions: 7 })], 10);
    expect(out.join(' ')).toContain('compacted 7 times');
  });

  it('never invents money', () => {
    const out = diagnose([model({})], [provider({})], 10);
    expect(out.join(' ')).not.toContain('$');
  });
});
