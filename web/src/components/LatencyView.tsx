import { useEffect, useState } from 'react';
import { fetchLatency, type LatencyReport, type ModelLatency, type ProviderLatency } from '../api';
import { Tip } from './Tip';

/**
 * How long the models actually take, and what went wrong around them — measured, never probed.
 *
 * Nothing here sends a test request: every figure comes from the `duration_s`, `ttfb_s`,
 * `retry_count` and `llm.error` rows the recorder already wrote. That means the numbers cost
 * nothing, need no network traffic of their own, and describe exactly what this machine
 * experienced — which is the question someone asks when a chat feels slow.
 *
 * Two tables, because two questions:
 *   • per provider — is the account healthy? A rate limit belongs to the account, not to a
 *     model name, and the same model is often served through more than one provider.
 *   • per model — which name is slow? Sorted worst p95 first, so the top row is the suspect.
 */
export function LatencyView() {
  const [report, setReport] = useState<LatencyReport | null>(null);
  const [period, setPeriod] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem('omni.latencyWindow') ?? '0');
    return Number.isFinite(saved) && saved >= 0 ? saved : 0;
  });

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const next = await fetchLatency(period);
      if (!stopped) setReport(next);
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [period]);

  if (report === null) return <p className="lat-empty">Reading recorded call times…</p>;
  const { models, providers } = report;
  if (models.length === 0) {
    return (
      <p className="lat-empty">
        No model calls with a recorded duration yet. The viewer fills this from the recorder's own
        timings, so it needs at least one completed call.
      </p>
    );
  }

  const totalCalls = models.reduce((sum, row) => sum + row.calls, 0);
  const findings = diagnose(models, providers, totalCalls);

  return (
    <div className="lat">
      <p className="lat-lede">
        Measured from <b>{totalCalls.toLocaleString()}</b> recorded calls across{' '}
        <b>{providers.length}</b> provider{providers.length === 1 ? '' : 's'}. No test requests are
        sent; these are the times the calls in this database actually took.
      </p>

      <div className="us-periods lat-periods" role="group" aria-label="Period">
        {PERIODS.map(([seconds, label]) => (
          <button
            key={seconds}
            type="button"
            className={`us-period${period === seconds ? ' is-active' : ''}`}
            aria-pressed={period === seconds}
            onClick={() => {
              setPeriod(seconds);
              window.localStorage.setItem('omni.latencyWindow', String(seconds));
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {findings.length > 0 ? (
        <ul className="lat-findings">
          {findings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <section className="lat-panel">
        <h3 className="lat-h">
          Providers
          <Tip
            text="A rate limit or a queue belongs to the account, not to one model name: the same model is often served through several providers."
            side="top"
          >
            <span className="lat-hint">?</span>
          </Tip>
        </h3>
        <table className="lat-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th className="lat-num">Models</th>
              <th className="lat-num">Calls</th>
              <th className="lat-num">
                <Tip text="The slowest p95 among this provider's models: the tail you actually notice." side="top">
                  <span>Worst p95</span>
                </Tip>
              </th>
              <th className="lat-num">
                <Tip text="Calls the provider refused with 429 (or a rate-limit reason). Each one was retried, so it also inflates every duration in this table." side="top">
                  <span>Rate limited</span>
                </Tip>
              </th>
              <th className="lat-num">
                <Tip text="Requests that needed a retry before they succeeded — usually the visible cost of a rate limit." side="top">
                  <span>Retried</span>
                </Tip>
              </th>
              <th className="lat-num">
                <Tip text="Failed calls: rate limits, timeouts and everything else the provider returned." side="top">
                  <span>Errors</span>
                </Tip>
              </th>
              <th className="lat-num">
                <Tip text="Context drops seen while calls went to this provider: the chat was compacted here." side="top">
                  <span>Compactions</span>
                </Tip>
              </th>
              <th className="lat-num">Last call</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((row) => (
              <tr key={row.provider}>
                <td
                  className="lat-model mono"
                  title={row.worst_model ? `worst model: ${row.worst_model}` : undefined}
                >
                  {row.provider}
                </td>
                <td className="lat-num mono">{row.models}</td>
                <td className="lat-num mono">{row.calls.toLocaleString()}</td>
                <td className="lat-num mono">{secs(row.p95_s)}</td>
                <td className={`lat-num mono${row.rate_limited > 0 ? ' lat-warn' : ''}`}>
                  {row.rate_limited.toLocaleString()}
                </td>
                <td className={`lat-num mono${row.retried > 0 ? ' lat-warn' : ''}`}>
                  {row.retried.toLocaleString()}
                </td>
                <td className={`lat-num mono${row.errors > 0 ? ' lat-bad' : ''}`}>
                  {row.errors.toLocaleString()}
                </td>
                <td className="lat-num mono">{row.compactions.toLocaleString()}</td>
                <td className="lat-num mono lat-when">{ago(row.last_seen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="lat-panel">
        <h3 className="lat-h">
          Models
          <Tip
            text="Sorted worst p95 first: when something feels slow, the top row is the name to suspect."
            side="top"
          >
            <span className="lat-hint">?</span>
          </Tip>
        </h3>
        <table className="lat-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th className="lat-num">Calls</th>
              <th className="lat-num">
                <Tip text="Half of the calls were faster than this." side="top">
                  <span>Median</span>
                </Tip>
              </th>
              <th className="lat-num">
                <Tip text="95% of calls were faster than this: the slow tail you actually notice." side="top">
                  <span>p95</span>
                </Tip>
              </th>
              <th className="lat-num">Slowest</th>
              <th className="lat-num">
                <Tip text="Median time until the first word of the answer arrived. High here with a normal total means the provider queued the request." side="top">
                  <span>First word</span>
                </Tip>
              </th>
              <th className="lat-num">
                <Tip text="Calls that took 30 seconds or more. A handful is normal on a busy provider; a cluster is the thing to look at." side="top">
                  <span>Over 30 s</span>
                </Tip>
              </th>
              <th className="lat-num">
                <Tip text="Refused with 429 or a rate-limit reason." side="top">
                  <span>429</span>
                </Tip>
              </th>
              <th className="lat-num">Retried</th>
              <th className="lat-num">Timeouts</th>
              <th className="lat-num">Other err</th>
              <th className="lat-num">Compact</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => (
              <tr key={`${row.provider}:${row.model}`}>
                <td className="lat-prov mono">{row.provider}</td>
                <td className="lat-model mono" title={row.model}>
                  {row.model}
                </td>
                <td className="lat-num mono">{row.calls.toLocaleString()}</td>
                <td className="lat-num mono">{secs(row.p50_s)}</td>
                <td className="lat-num mono">{secs(row.p95_s)}</td>
                <td className="lat-num mono">{secs(row.max_s)}</td>
                <td className="lat-num mono">{secs(row.ttfb_p50_s, 2)}</td>
                <td className="lat-num mono">{row.over_30s.toLocaleString()}</td>
                <td className={`lat-num mono${row.rate_limited > 0 ? ' lat-warn' : ''}`}>
                  {row.rate_limited.toLocaleString()}
                </td>
                <td className={`lat-num mono${row.retried > 0 ? ' lat-warn' : ''}`}>
                  {row.retried.toLocaleString()}
                </td>
                <td className="lat-num mono">{row.timeouts.toLocaleString()}</td>
                <td className="lat-num mono">{row.other_errors.toLocaleString()}</td>
                <td className="lat-num mono">{row.compactions.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="lat-note">
        A slow tail on one model with a healthy median means the provider is queuing, not that the
        agent did something wrong. Rate limits matter twice: each one is a retry the user waited
        for, and the retry's own duration lands in the same average. If slow calls cluster in one
        chat, the cause is more likely that chat's context size — check the context colour in
        Tokens. A compaction costs one large prompt paid twice, once before the drop and once to
        rebuild, so a chat that compacts often is a chat worth trimming.
      </p>
    </div>
  );
}

/** Lookbacks offered on the page. 0 = everything ever recorded. */
const PERIODS: [number, string][] = [
  [0, 'All'],
  [3_600, 'Last hour'],
  [86_400, 'Last 24 h'],
  [7 * 86_400, 'Last 7 days'],
  [30 * 86_400, 'Last 30 days'],
];

function secs(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}s`;
}

function ago(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return '—';
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Plain-language reading of the tables: what is worth fixing, in the order it hurts. */
export function diagnose(
  models: ModelLatency[],
  providers: ProviderLatency[],
  totalCalls: number,
): string[] {
  const out: string[] = [];
  if (totalCalls === 0) return out;

  const limited = providers
    .filter((row) => row.rate_limited > 0)
    .sort((a, b) => b.rate_limited - a.rate_limited);
  for (const row of limited.slice(0, 2)) {
    const attempts = Math.max(1, row.calls + row.rate_limited);
    const share = Math.round((row.rate_limited / attempts) * 100);
    const shareText = share >= 1 ? ` (about ${share}% of its traffic)` : '';
    out.push(
      `${row.provider} refused ${row.rate_limited.toLocaleString()} call${
        row.rate_limited === 1 ? '' : 's'
      } with a rate limit${shareText} and ${row.retried.toLocaleString()} needed a retry: the account is being throttled, so those waits are the provider's, not the agent's.`,
    );
  }

  const queued = models
    .filter((row) => (row.p95_s ?? 0) >= 10 && row.ttfb_p50_s !== null)
    .sort((a, b) => (b.p95_s ?? 0) - (a.p95_s ?? 0));
  if (queued.length > 0) {
    const worst = queued[0];
    out.push(
      `${worst.model} on ${worst.provider} is the slow tail: ${secs(worst.p95_s)} at p95 with ${secs(
        worst.p50_s,
      )} at the median and ${secs(worst.ttfb_p50_s, 2)} to the first word — that gap is queuing at the provider.`,
    );
  }

  const fails = models
    .filter((row) => row.other_errors + row.timeouts > 0)
    .sort((a, b) => b.other_errors + b.timeouts - (a.other_errors + a.timeouts));
  if (fails.length > 0) {
    const worst = fails[0];
    const count = worst.other_errors + worst.timeouts;
    out.push(
      `${worst.model} also failed ${count.toLocaleString()} time${
        count === 1 ? '' : 's'
      } beyond rate limits (${worst.timeouts} timeout${worst.timeouts === 1 ? '' : 's'}, ${
        worst.other_errors
      } other) — that is a provider or endpoint problem, not a prompt problem.`,
    );
  }

  const compacted = [...models].sort((a, b) => b.compactions - a.compactions)[0];
  if (compacted && compacted.compactions > 0) {
    out.push(
      `Context was compacted ${compacted.compactions.toLocaleString()} time${
        compacted.compactions === 1 ? '' : 's'
      } while ${compacted.model} was in use: every compaction pays for the whole prompt once more before it can shrink, so those chats are the expensive ones.`,
    );
  }

  return out.slice(0, 4);
}
