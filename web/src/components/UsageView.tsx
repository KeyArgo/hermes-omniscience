import { useEffect, useMemo, useRef, useState } from 'react';
import type { UsageReport } from '../types';
import { fetchUsage } from '../api';
import { CancelledError, withRetry } from '../graph/retry';
import { Tip } from './Tip';
import { UsageSources } from './UsageSources';
import { PanelFrame } from './PanelFrame';
import {
  calendarCells,
  compactNum,
  exactNum,
  latencySentence,
  partShares,
  pct,
  secs,
  shortModel,
  stackByModel,
  usd,
} from '../graph/usage';
import './UsageView.css';

const PERIOD_KEY = 'omni.usageDays';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A duration a person can read at a glance: seconds under a minute, then minutes, then hours. */
function dur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

const PERIODS: { days: number; label: string; tip: string }[] = [
  { days: 1 / 24, label: '1 hour', tip: 'The last hour, to the minute — what this machine is doing right now.' },
  { days: 1, label: '24 hours', tip: 'The last twenty-four hours, to the minute.' },
  { days: 7, label: '7 days', tip: 'The last seven days, including today.' },
  { days: 30, label: '30 days', tip: 'The last thirty days.' },
  { days: 0, label: 'All', tip: 'Everything the recorder holds — no window.' },
];

function readPeriod(): number {
  try {
    // /omni tokens links straight to a period: ?days=7 is the command's own choice, so it
    // wins over a remembered one.
    const asked = new URLSearchParams(window.location.search).get('days');
    if (asked !== null && PERIODS.some((p) => String(p.days) === asked)) return Number(asked);
  } catch {
    // ignore
  }
  try {
    const raw = window.localStorage.getItem(PERIOD_KEY);
    if (raw !== null && PERIODS.some((p) => String(p.days) === raw)) return Number(raw);
  } catch {
    // ignore
  }
  return 7;
}

function Stat({
  label,
  value,
  exact,
  tip,
}: {
  label: string;
  value: string;
  exact?: string;
  tip: string;
}) {
  return (
    <Tip text={tip} side="bottom">
      <div className="us-stat" tabIndex={0}>
        <span className="us-stat-label">{label}</span>
        <span className="us-stat-value" title={exact}>{value}</span>
      </div>
    </Tip>
  );
}

/**
 * The Usage page: what this machine spent, in detail, on purpose a place you navigate to.
 *
 * Tokens come from the recording, which is the only source with per-call facts. Money comes
 * from Hermes' own estimate and says so; where Hermes has no price, the page shows nothing
 * rather than a guess.
 */
export function UsageView({ onOpenChat }: { onOpenChat: (sessionId: string) => void }) {
  const [days, setDays] = useState<number>(readPeriod);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [waited, setWaited] = useState(0);
  const [tick, setTick] = useState(0);
  const [stamped, setStamped] = useState<number | null>(null);
  const haveReport = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // A silent refresh must not flash the "waiting" state on a page that already has numbers.
    if (!haveReport.current) {
      setLoading(true);
      setWaited(0);
    }
    // A cold read of the whole recording takes seconds, and a viewer restart under an open tab
    // can drop the first request. Retrying twice turns both into "the page arrived" instead of
    // "not populating" — which is how this was reported.
    withRetry(() => fetchUsage(days), {
      attempts: 3,
      delaysMs: [400, 1200],
      cancelled: () => cancelled,
    })
      .then((next) => {
        if (cancelled) return;
        setReport(next);
        setError(null);
        haveReport.current = true;
        setStamped(Date.now());
      })
      .catch((exc: unknown) => {
        if (cancelled || exc instanceof CancelledError) return;
        setError(exc instanceof Error ? exc.message : 'could not read usage');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, reload, tick]);

  // Usage is a live number: a page left open for an hour must not show the hour it opened.
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') bump();
    }, 30000);
    window.addEventListener('focus', bump);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', bump);
    };
  }, []);

  // Waiting with no number is what looks broken: count the seconds out loud while it loads.
  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setWaited((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  function pick(next: number) {
    setDays(next);
    try {
      window.localStorage.setItem(PERIOD_KEY, String(next));
    } catch {
      // ignore
    }
  }

  const totals = report?.totals;
  const cells = useMemo(
    () => (report ? calendarCells(report.daily, report.since, report.generated_at) : []),
    [report],
  );
  // Answer first: one sentence that says what this period was, before any figure is read.
  const barsRef = useRef<HTMLDivElement | null>(null);
  const [barsHeight, setBarsHeight] = useState(180);
  useEffect(() => {
    const node = barsRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setBarsHeight(Math.max(60, Math.round(entry.contentRect.height)));
    });
    observer.observe(node);
    return () => observer.disconnect();
    // Re-run when the report arrives: the chart (and its ref) does not exist on the first render.
  }, [report]);

  const answer = useMemo(() => {
    if (!report || !totals) return '';
    const period =
      days === 0 ? 'since records began' : days === 1 ? 'in the last day' : `in the last ${days} days`;
    const harnesses = report.harnesses.length;
    const agents = harnesses > 1 ? `${harnesses} agents` : harnesses === 1 ? 'one agent' : 'Hermes';
    const money = report.cost_available ? ` — about ${usd(totals.cost)} by Hermes' estimate` : '';
    const cache =
      report.cache.hit_rate === null
        ? ''
        : `, with ${pct(report.cache.hit_rate)} of the context served from cache`;
    return `${compactNum(totals.prompt)} tokens across ${exactNum(totals.calls)} calls from ${agents} ${period}${cache}${money}.`;
  }, [report, totals, days]);

  const bars = useMemo(
    () => (report ? stackByModel(report.daily, report.daily_models) : { rows: [], keys: [] }),
    [report],
  );
  const maxBar = useMemo(
    () => bars.rows.reduce((m, r) => Math.max(m, r.total), 1),
    [bars],
  );
  const maxHistogram = useMemo(
    () => (report?.context.histogram ?? []).reduce((m, h) => Math.max(m, h.calls), 1),
    [report],
  );

  if (error) {
    return (
      <div className="us-root">
        <p className="us-error">
          Usage could not be read: {error}.{' '}
          <button type="button" className="us-retry" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="us-root">
      <header className="us-head">
        <div>
          <h2 className="us-title">Usage</h2>
          <p className="us-answer">{answer}</p>
          <p className="us-lede">
            Measured per call from the recording. Money is Hermes' own estimate, not a bill.
          </p>
        </div>
        <div className="us-controls">
          <div className="us-periods" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <Tip key={p.days} text={p.tip} side="bottom">
                <button
                  type="button"
                  className={`us-period ${days === p.days ? 'is-active' : ''}`}
                  aria-pressed={days === p.days}
                  onClick={() => pick(p.days)}
                >
                  {p.label}
                </button>
              </Tip>
            ))}
          </div>
          <span
            className="us-updated"
            title="Refreshes every 30 seconds while this page is open, and whenever you come back to it"
          >
            {stamped ? `updated ${new Date(stamped).toLocaleTimeString()}` : 'reading…'}
          </span>
          <button
            type="button"
            className="us-retry"
            onClick={() => setReload((n) => n + 1)}
            title="Read the databases again now."
          >
            {loading ? 'reading…' : 'refresh'}
          </button>
        </div>
      </header>

      {!report || !totals ? (
        <p className="us-empty">
          Reading the recording…{waited >= 2 ? ` ${waited}s — a cold read of all history takes a few seconds.` : ''}
        </p>
      ) : (
        <>
          {/* 1 — the headline numbers */}
          <section className="us-stats">
            <Stat
              label="Tokens sent"
              value={compactNum(totals.prompt)}
              exact={exactNum(totals.prompt)}
              tip="Context sent to the model across every call in this period. This is what you paid for repeatedly; the cache share below is how much of it was cheap."
            />
            <Stat
              label={report.cost_available ? "Cost (Hermes' estimate)" : 'Cost'}
              value={report.cost_available ? usd(totals.cost) : 'not available'}
              exact={report.cost_available ? `${totals.cost.toFixed(4)} USD` : undefined}
              tip="Hermes' own estimate from its session store. Omniscience records tokens, never prices, so this figure is quoted from Hermes and labelled as an estimate."
            />
            <Stat
              label="Model calls"
              value={exactNum(totals.calls)}
              tip="Responses received. Auxiliary calls (titles, approvals, compression) are counted separately below."
            />
            <Stat
              label="Chats"
              value={exactNum(totals.chats)}
              tip="Conversations with recorded activity in this period. A helper's spend is rolled into the chat that started it."
            />
            <Stat
              label="Cache hit"
              value={pct(report.cache.hit_rate)}
              tip="Share of the context the provider served from its cache. A high number is good: those tokens are much cheaper, not free."
            />
            <Stat
              label="Saved by cache"
              value={usd(report.cache.saved_usd)}
              exact={
                report.cache.saved_usd === null
                  ? 'no published rate for these models'
                  : `${report.cache.saved_usd.toFixed(4)} USD at list price`
              }
              tip="Cached tokens priced at the input rate instead of the cache rate, using the published list price for each model. Models without a published rate are left out rather than guessed."
            />
            <Stat
              label="Tool calls"
              value={exactNum(totals.tool_calls)}
              tip="Tools executed in this period. A tool call costs nothing by itself; the model turn that follows it pays for the context again."
            />
            <Stat
              label="Output tokens"
              value={compactNum(totals.output)}
              exact={exactNum(totals.output)}
              tip="What the models wrote back, including reasoning tokens the provider reported."
            />
          </section>

          {/* 2 — who spent it: one row per harness, and how much of the period each carried */}
          {report.harnesses.length > 0 ? (
            <section className="us-panel">
              <h3 className="us-h">
                By harness
                <Tip
                  text="Every agent whose history you switched on, plus Hermes itself. Calls are model calls with recorded tokens; the share is of all tokens sent in this period."
                  side="bottom"
                >
                  <span className="us-hint">?</span>
                </Tip>
              </h3>
              <div className="us-table-wrap">
                <table className="us-table">
                  <thead>
                    <tr>
                      <th>Harness</th>
                      <th className="us-num">Calls</th>
                      <th className="us-num">Tokens in</th>
                      <th className="us-num">Cache read</th>
                      <th className="us-num">Out</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.harnesses.map((h) => {
                      const total = report.harnesses.reduce(
                        (sum, row) => sum + row.prompt + row.output,
                        0,
                      );
                      const share = total ? (h.prompt + h.output) / total : 0;
                      return (
                        <tr key={h.source}>
                          <td>
                            {h.source}
                            <span className="us-hint-inline"> {h.models.length} models</span>
                          </td>
                          <td className="us-num">{exactNum(h.calls)}</td>
                          <td className="us-num" title={exactNum(h.prompt)}>
                            {compactNum(h.prompt)}
                          </td>
                          <td className="us-num" title={exactNum(h.cache_read)}>
                            {compactNum(h.cache_read)}
                          </td>
                          <td className="us-num" title={exactNum(h.output)}>
                            {compactNum(h.output)}
                          </td>
                          <td>
                            <span className="us-share">
                              <span className="us-share-fill" style={{ width: `${share * 100}%` }} />
                            </span>
                            <span className="us-num">{pct(share)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {/* 3 — the calendar */}
          <section className="us-panel">
            <h3 className="us-h">
              Daily activity
              <Tip text="One cell per day, darker for more tokens. Days with no activity stay empty so a gap is visible as a gap." side="bottom">
                <span className="us-hint">?</span>
              </Tip>
            </h3>
            <div className="us-weekdays" aria-hidden="true">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
                <span key={`${label}-${index}`}>{label}</span>
              ))}
            </div>
            <div className="us-calendar">
              {cells.map((cell) => (
                <Tip
                  key={cell.day}
                  text={`${cell.day} · ${exactNum(cell.tokens)} tokens`}
                  side="bottom"
                >
                  <span
                    className={`us-cell us-shade-${cell.shade}`}
                    style={{ gridColumn: cell.weekday + 1 }}
                    aria-label={`${cell.day}: ${cell.tokens} tokens`}
                  />
                </Tip>
              ))}
            </div>
            <p className="us-note">
              {cells.length} day{cells.length === 1 ? '' : 's'} in view · busiest{' '}
              {compactNum(cells.reduce((m, c) => Math.max(m, c.tokens), 0))} tokens
            </p>
          </section>

          {/* 4 — when the work happened: weekday by hour */}
          {report.hourly.some((n) => n > 0) ? (
            <PanelFrame
              id="heat"
              title="When the calls happened"
              tip="Model calls per hour, by weekday, in your own timezone. A dark cell is a busy hour; the busiest hour in the period is fully dark."
              hint={
                <>
                  {dur(report.time_metrics.active_s)} active · longest run{' '}
                  {dur(report.time_metrics.longest_s)} · up to {report.time_metrics.peak_concurrent} at once
                </>
              }
              defaultHeight={260}
            >
              <div className="us-heat">
                {report.weekday_hour.map((row, day) => (
                  <div className="us-heat-row" key={DAYS[day]}>
                    <span className="us-heat-day">{DAYS[day]}</span>
                    {row.map((count, hour) => (
                      <Tip
                        key={hour}
                        text={`${DAYS[day]} ${String(hour).padStart(2, '0')}:00 · ${count} call${count === 1 ? '' : 's'}`}
                        side="top"
                      >
                        <span
                          className={`us-heat-cell ${count ? 'is-on' : ''}`}
                          style={{ opacity: 0.07 + 0.93 * (count / Math.max(...report.hourly, 1)) }}
                        />
                      </Tip>
                    ))}
                  </div>
                ))}
              </div>
              <div className="us-heat-axis">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
            </PanelFrame>
          ) : null}

          {/* 5 — daily bars by model */}
          <PanelFrame
            id="daily"
            title="Tokens per day, by model"
            tip="Each bar is a day; the bands are the models that sent the most in this period. The tail is folded into one band so the legend stays readable. Drag the bottom edge for a taller chart, or focus it."
            defaultHeight={300}
          >
            <div className="us-bars" role="img" aria-label="Tokens per day by model" ref={barsRef}>
              {bars.rows.map((row, index) => {
                // With a month of days the date labels would collide; print every few.
                const labelEvery = bars.rows.length > 14 ? Math.ceil(bars.rows.length / 7) : 1;
                const shares = partShares(row);
                return (
                  <Tip key={row.day} text={`${row.day} · ${exactNum(row.total)} tokens`} side="top">
                    <div className="us-bar-col">
                      <div
                        className="us-bar"
                        style={{ height: `${Math.max(2, (row.total / maxBar) * (barsHeight - 22))}px` }}
                      >
                        {row.parts.map((part, i) => (
                          <span
                            key={part.model}
                            className={`us-band us-band-${i % 6}`}
                            style={{ flexGrow: Math.max(part.tokens, shares[i] > 0 ? 0.001 : 0) }}
                          />
                        ))}
                      </div>
                      <span className="us-bar-day">
                        {index % labelEvery === 0 ? row.day.slice(5) : ''}
                      </span>
                    </div>
                  </Tip>
                );
              })}
            </div>
            <ul className="us-legend">
              {bars.keys.map((key, i) => (
                <li key={key}>
                  <span className={`us-swatch us-band-${i % 6}`} />
                  {key === 'other' ? 'other models' : shortModel(key)}
                </li>
              ))}
            </ul>
          </PanelFrame>

          {/* 4 — models */}
          <section className="us-panel">
            <h3 className="us-h">
              Models
              <Tip text="Measured latency comes from the recorded calls themselves: p50 is a typical wait, p95 the slow ones. A healthy median with a slow tail usually means queuing." side="bottom">
                <span className="us-hint">?</span>
              </Tip>
            </h3>
            <div className="us-table-wrap">
              <table className="us-table">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col" className="us-num">Calls</th>
                    <th scope="col" className="us-num">In</th>
                    <th scope="col" className="us-num">Cache read</th>
                    <th scope="col" className="us-num">Out</th>
                    <th scope="col" className="us-num">p50</th>
                    <th scope="col" className="us-num">p95</th>
                    <th scope="col" className="us-num">First word</th>
                    <th scope="col">Shape</th>
                  </tr>
                </thead>
                <tbody>
                  {report.models.map((row) => (
                    <tr key={row.model}>
                      <td title={row.model}>{shortModel(row.model)}</td>
                      <td className="us-num">{exactNum(row.calls)}</td>
                      <td className="us-num" title={exactNum(row.prompt)}>{compactNum(row.prompt)}</td>
                      <td className="us-num" title={exactNum(row.cache_read)}>{compactNum(row.cache_read)}</td>
                      <td className="us-num" title={exactNum(row.output)}>{compactNum(row.output)}</td>
                      <td className="us-num">{secs(row.p50_s)}</td>
                      <td className="us-num">{secs(row.p95_s)}</td>
                      <td className="us-num">{secs(row.ttfb_median_s)}</td>
                      <td className="us-shape">{latencySentence(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="us-note">
              Cost per model is only shown where Hermes priced the chat; tokens are always measured.
            </p>
          </section>

          {/* 5 — the cache */}
          <section className="us-panel">
            <h3 className="us-h">
              Cache
              <Tip text="The provider bills cached input at a fraction of the full rate. A high hit rate means the same context is being re-read cheaply — usually a long conversation, not a wasteful one." side="bottom">
                <span className="us-hint">?</span>
              </Tip>
            </h3>
            <div className="us-cachebar" role="img" aria-label="Cached versus fresh input">
              <span
                className="us-cache-read"
                style={{ width: `${(report.cache.hit_rate ?? 0) * 100}%` }}
              />
            </div>
            <div className="us-cachefacts">
              <span>
                <strong>{compactNum(report.cache.read)}</strong> from cache
              </span>
              <span>
                <strong>{compactNum(report.cache.fresh)}</strong> fresh
              </span>
              <span>
                <strong>{usd(report.cache.saved_usd)}</strong> saved
                {report.cache.priced_share !== null && report.cache.priced_share < 1
                  ? ` · ${pct(report.cache.priced_share)} of calls priced`
                  : ''}
              </span>
            </div>
          </section>

          {/* 6 — context */}
          <section className="us-panel">
            <h3 className="us-h">
              Context economics
              <Tip text="Every call re-sends its conversation. This shows how big that context was on each call, and how often compaction cut it back — the two things that decide what a chat costs." side="bottom">
                <span className="us-hint">?</span>
              </Tip>
            </h3>
            <div className="us-histogram">
              {report.context.histogram.map((band) => (
                <div key={band.band} className="us-hist-row">
                  <span className="us-hist-label">{band.band}</span>
                  <span className="us-hist-track">
                    <span
                      className="us-hist-fill"
                      style={{ width: `${(band.calls / maxHistogram) * 100}%` }}
                    />
                  </span>
                  <span className="us-hist-count">{exactNum(band.calls)}</span>
                </div>
              ))}
            </div>
            <p className="us-note">
              {exactNum(report.context.calls_with_context)} calls carried real context ·{' '}
              {compactNum(report.context.context_tokens)} context tokens sent in total
            </p>
            <h4 className="us-sub">Compactions</h4>
            {report.context.compactions.length === 0 ? (
              <p className="us-note">No compaction recorded in this period.</p>
            ) : (
              <ul className="us-compactions">
                {report.context.compactions.slice(0, 6).map((c) => (
                  <li key={`${c.session}-${c.before}`}>
                    <button type="button" className="us-link" onClick={() => onOpenChat(c.session)}>
                      {c.session.slice(0, 12)}…
                    </button>
                    <span>
                      {compactNum(c.before)} → {compactNum(c.after)} tokens
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 7 — chats */}
          <section className="us-panel">
            <h3 className="us-h">
              Chats
              <Tip text="Ranked by what Hermes says each chat cost, then by the context it is carrying now. Click a row to open that chat in the viewer." side="bottom">
                <span className="us-hint">?</span>
              </Tip>
            </h3>
            <div className="us-table-wrap">
              <table className="us-table">
                <thead>
                  <tr>
                    <th scope="col">Chat</th>
                    <th scope="col" className="us-num">Cost</th>
                    <th scope="col" className="us-num">Calls</th>
                    <th scope="col" className="us-num">Context now</th>
                    <th scope="col" className="us-num">Peak</th>
                    <th scope="col" className="us-num">Tools</th>
                    <th scope="col" className="us-num">p95</th>
                    <th scope="col" className="us-num">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {report.chats.slice(0, 15).map((chat) => (
                    <tr key={chat.id} onClick={() => onOpenChat(chat.id)} className="us-chatrow">
                      <td title={chat.id}>{chat.id.slice(0, 18)}…</td>
                      <td className="us-num">{chat.cost === null ? '—' : usd(chat.cost)}</td>
                      <td className="us-num">{exactNum(chat.calls)}</td>
                      <td className="us-num" title={exactNum(chat.prompt_now)}>
                        {compactNum(chat.prompt_now)}
                      </td>
                      <td className="us-num" title={exactNum(chat.prompt_max)}>
                        {compactNum(chat.prompt_max)}
                      </td>
                      <td className="us-num">{exactNum(chat.tools)}</td>
                      <td className="us-num">{secs(chat.p95_s)}</td>
                      <td className="us-num">
                        {new Date(chat.last_ts * 1000).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <UsageSources
            sources={report.sources}
            onChanged={() => setReload((n) => n + 1)}
          />

          <p className="us-footer">
            Generated {new Date(report.generated_at * 1000).toLocaleString()} ·{' '}
            {report.days === 0 ? 'all recorded history' : `last ${report.days} day${report.days === 1 ? '' : 's'}`}
            {report.cost_available ? '' : ' · cost unavailable: Hermes’ session store was not readable'}
          </p>
        </>
      )}
    </div>
  );
}
