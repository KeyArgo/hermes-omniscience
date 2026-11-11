import { useEffect, useMemo, useState } from 'react';
import type { OmniEvent, SessionMeta } from '../types';
import { heatLevel } from '../graph/heat';
import { buildContext } from '../graph/context';
import { formatTokens } from '../graph/format';

/**
 * A thin, always-on strip for the chat you have open next to it.
 *
 * It answers one question without leaving the conversation: what is this chat costing, and is the
 * context still climbing? It is deliberately scoped to a single session — the id is passed in and
 * nothing else is read — so a strip in one chat can never report another chat's numbers.
 *
 * Money is an estimate and only appears when you have given it a rate. A price invented here would
 * be a guess wearing a currency symbol; the token figures are recorded facts and always shown.
 */

const RATES_KEY = 'omni.rates';

interface Rates {
  input: number | null;
  output: number | null;
}

function readRates(): Rates {
  try {
    const raw = window.localStorage.getItem(RATES_KEY);
    if (!raw) return { input: null, output: null };
    const parsed = JSON.parse(raw) as { input?: unknown; output?: unknown };
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    return { input: number(parsed.input), output: number(parsed.output) };
  } catch {
    return { input: null, output: null };
  }
}

export function SessionContextStrip({
  session,
  events,
}: {
  session: SessionMeta | null;
  events: OmniEvent[];
}) {
  const [rates, setRates] = useState<Rates>(readRates);
  const [editing, setEditing] = useState(false);

  useEffect(() => setRates(readRates()), [session?.id]);

  const series = useMemo(() => {
    const { calls } = buildContext(events, session?.id ?? null);
    return calls.map((call) => call.prompt).filter((value): value is number => typeof value === 'number');
  }, [events, session?.id]);

  if (!session) return null;

  const contextNow = session.prompt_now && session.prompt_now > 0 ? session.prompt_now : session.prompt_max ?? 0;
  const peak = session.prompt_max ?? contextNow;
  const level = heatLevel(contextNow);
  const cached = session.cached ?? 0;
  const fresh = session.fresh ?? 0;
  const output = session.output ?? 0;

  // The facts a reader checks before anything else. Each is derived from what was recorded; where a
  // number cannot be known it is left out rather than printed as zero.
  const cacheShare = cached + fresh > 0 ? cached / (cached + fresh) : null;
  // 200k is Hermes' compaction point on this box; the percentage is a share of that, and the label
  // says so, because a window size invented here would read as a measurement.
  const WINDOW_TOKENS = 200_000;
  const pressure = contextNow > 0 ? Math.min(1, contextNow / WINDOW_TOKENS) : null;
  const errors = events.reduce((count, event) => (event.status && event.status !== 'ok' && event.status !== 'running' ? count + 1 : count), 0);
  const lastTs = events.reduce((latest, event) => (event.ts && event.ts > latest ? event.ts : latest), 0);
  const ageSeconds = lastTs ? Math.max(0, Date.now() / 1000 - lastTs) : null;

  const cost =
    rates.input !== null || rates.output !== null
      ? ((cached + fresh) / 1_000_000) * (rates.input ?? 0) + (output / 1_000_000) * (rates.output ?? 0)
      : null;

  // Sparkline: the whole chat's context, which is the "gradual increase" part of the question.
  const width = 132;
  const height = 26;
  const max = Math.max(1, ...series);
  const points = series
    .map((value, index) => {
      const x = series.length <= 1 ? width / 2 : (index / (series.length - 1)) * width;
      const y = height - (value / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const saveRates = (input: string, outputValue: string) => {
    const next: Rates = {
      input: input.trim() === '' ? null : Number(input),
      output: outputValue.trim() === '' ? null : Number(outputValue),
    };
    setRates(next);
    try {
      window.localStorage.setItem(RATES_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    setEditing(false);
  };

  return (
    <div className="ctx-strip" title={`${session.label ?? session.id} — only this chat's numbers`}>
      <svg className="ctx-strip-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`Context per model call for ${session.label ?? session.id}: ${series.length} calls, now ${contextNow.toLocaleString()} tokens, peak ${peak.toLocaleString()}`}>
        {series.length > 1 ? (
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.4} className={`spark-heat-${level}`} />
        ) : null}
        <line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} className="ctx-strip-base" />
      </svg>

      <span className="ctx-strip-facts">
        {session.model ? (
          <span className="ctx-strip-model" title="The model this chat is using">
            {String(session.model).split('/').pop()}
          </span>
        ) : null}
        {pressure !== null ? (
          <span
            className={`ctx-strip-press${pressure > 0.85 ? ' is-hot' : pressure > 0.6 ? ' is-warm' : ''}`}
            title={`Context is ${Math.round(pressure * 100)}% of the ${formatTokens(WINDOW_TOKENS)} compaction point`}
          >
            {Math.round(pressure * 100)}% ctx
          </span>
        ) : null}
        {cacheShare !== null ? (
          <span className="ctx-strip-cache" title={`${formatTokens(cached)} of ${formatTokens(cached + fresh)} prompt tokens came from cache`}>
            {Math.round(cacheShare * 100)}% cached
          </span>
        ) : null}
        {errors > 0 ? (
          <span className="ctx-strip-err" title={`${errors} step${errors === 1 ? '' : 's'} reported an error in the loaded window`}>
            {errors} err
          </span>
        ) : null}
        {ageSeconds !== null ? (
          <span className="ctx-strip-dim" title="When the newest recorded step happened">
            {ageSeconds < 60 ? `${Math.round(ageSeconds)}s` : ageSeconds < 3600 ? `${Math.round(ageSeconds / 60)}m` : `${Math.round(ageSeconds / 3600)}h`} ago
          </span>
        ) : null}
        <b className={`ctx-strip-now heat-${level}`}>{formatTokens(contextNow)}</b>
        <span className="ctx-strip-dim">now</span>
        {peak > contextNow * 1.05 ? (
          <span className="ctx-strip-dim">· peak {formatTokens(peak)}</span>
        ) : null}
        <span className="ctx-strip-dim">· {formatTokens(cached + fresh)} in · {formatTokens(output)} out</span>
      </span>

      {editing ? (
        <span className="ctx-strip-rates">
          <label title="Price per million input tokens for this chat's model. Empty means: use the rate recorded with each call.">
            $/M in
            <input
              type="number"
              min="0"
              step="0.01"
              defaultValue={rates.input ?? ''}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const input = (event.currentTarget.parentElement?.querySelectorAll('input')[0]?.value ?? '') as string;
                  const out = (event.currentTarget.parentElement?.querySelectorAll('input')[1]?.value ?? '') as string;
                  saveRates(input, out);
                }
                if (event.key === 'Escape') setEditing(false);
              }}
            />
          </label>
          <label title="Price per million output tokens for this chat's model. Empty means: use the rate recorded with each call.">
            $/M out
            <input
              type="number"
              min="0"
              step="0.01"
              defaultValue={rates.output ?? ''}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const inputs = event.currentTarget.parentElement?.querySelectorAll('input');
                  saveRates(inputs?.[0]?.value ?? '', inputs?.[1]?.value ?? '');
                }
                if (event.key === 'Escape') setEditing(false);
              }}
            />
          </label>
          <button type="button" onClick={() => setEditing(false)}>done</button>
        </span>
      ) : (
        <button
          type="button"
          className="ctx-strip-cost"
          onClick={() => setEditing(true)}
          title={
            cost === null
              ? 'Click to set a price per million tokens; until then only tokens are shown, because an invented rate would be a guess.'
              : `Estimate: ${(cached + fresh).toLocaleString()} input tokens at $${rates.input ?? 0}/M plus ${output.toLocaleString()} output at $${rates.output ?? 0}/M. Cached tokens are counted at the input rate.`
          }
        >
          {cost === null ? '≈ set rates' : `≈ $${cost < 0.01 && cost > 0 ? '<0.01' : cost.toFixed(2)}`}
        </button>
      )}
    </div>
  );
}
