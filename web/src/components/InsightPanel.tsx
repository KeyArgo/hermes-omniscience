import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  askInsight,
  fetchInsightModels,
  type InsightChoice,
  type InsightModels,
  type InsightReport,
} from '../api';
import './InsightPanel.css';

/**
 * "Ask a model" — one of your own models reads this recording and writes it up.
 *
 * The picker is filled from the providers Hermes is already authenticated for, so every name
 * offered is a name that answers. Nothing private goes out: the recorder keeps counts, timings
 * and error reasons, and the digest is built from the same figures the pages show.
 *
 * The report is a diagnosis, not a summary of the interface: what the time and money went on,
 * which provider queued or refused calls, whether context growth is the real problem, and what
 * to change.
 */

const DAY_OPTIONS: [number, string][] = [
  [1 / 24, 'Last hour'],
  [1, 'Last 24 h'],
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [0, 'Everything'],
];

/** The period as a person reads it, for the line above the answer. */
function periodLabel(days: number): string {
  if (days === 0) return 'everything recorded';
  if (days * 24 <= 1.5) return `the last ${Math.max(1, Math.round(days * 24))} hour`;
  if (days < 1.5) return 'the last day';
  return `the last ${days} days`;
}

const PICK_KEY = 'omni.insightModel';
const DAYS_KEY = 'omni.insightDays';

export function InsightPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [choices, setChoices] = useState<InsightModels | null>(null);
  const [pick, setPick] = useState<string>(() => window.localStorage.getItem(PICK_KEY) ?? '');
  const [days, setDays] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem(DAYS_KEY) ?? '7');
    return DAY_OPTIONS.some(([value]) => value === saved) ? saved : 7;
  });
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<InsightReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    void (async () => {
      const loaded = await fetchInsightModels();
      if (stopped) return;
      setChoices(loaded);
      setPick((current) => {
        if (current && loaded.models.some((row) => keyOf(row) === current)) return current;
        const first =
          loaded.models.find((row) => row.recommended) ??
          loaded.models.find((row) => row.default) ??
          loaded.models[0];
        return first ? keyOf(first) : '';
      });
    })();
    return () => {
      stopped = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const choice = useMemo(() => choices?.models.find((row) => keyOf(row) === pick) ?? null, [choices, pick]);
  const grouped = useMemo(() => groupByProvider(choices?.models ?? []), [choices]);

  if (!open) return null;

  const run = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    window.localStorage.setItem(PICK_KEY, pick);
    window.localStorage.setItem(DAYS_KEY, String(days));
    const result = await askInsight(choice, days);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      setReport(null);
      return;
    }
    setReport(result.report);
  };

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="ai-scrim" role="dialog" aria-modal="true" aria-label="Ask a model to read this recording">
      <div className="ai-panel">
        <header className="ai-head">
          <div>
            <h2 className="ai-title">Ask a model</h2>
            <p className="ai-lede">
              One of your own models reads this recording — calls, tokens, cache, timings, rate limits,
              context growth — and writes what to fix. Metadata only: the recorder never stores a
              prompt, a tool argument or a file's contents.
            </p>
          </div>
          <button type="button" className="ai-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="ai-controls">
          <label className="ai-field">
            <span className="ai-label">Model</span>
            <select
              value={pick}
              onChange={(event) => setPick(event.target.value)}
              disabled={busy}
              aria-label="Model"
            >
              {choices === null ? <option value="">Reading the model list…</option> : null}
              {choices !== null && choices.models.length === 0 ? (
                <option value="">No model could be listed</option>
              ) : null}
              {grouped.map(([provider, rows]) => (
                <optgroup key={provider} label={providerLabel(provider)}>
                  {rows.map((row) => (
                    <option key={keyOf(row)} value={keyOf(row)}>
                      {row.model}
                      {row.recommended ? ' — recommended' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="ai-field">
            <span className="ai-label">Period</span>
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              disabled={busy}
              aria-label="Period"
            >
              {DAY_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="ai-run" onClick={() => void run()} disabled={busy || !choice}>
            {busy ? 'Reading…' : report ? 'Ask again' : 'Write the report'}
          </button>
        </div>

        {choices && choices.models.some((row) => row.recommended) ? (
          <p className="ai-note">
            Starts on {choices.models.find((row) => row.recommended)?.model} because{' '}
            {choices.models.find((row) => row.recommended)?.why}. Any model in the list works; pick
            another and it is remembered.
          </p>
        ) : null}

        {choices && choices.models.some((row) => row.provider === 'nous') ? (
          <p className="ai-provenance">
            Models come from your own Hermes accounts; the Nous Research portal is one of them.
            Nothing is sent to a provider you have not already configured.
          </p>
        ) : null}

        {choices && choices.unavailable.length > 0 ? (
          <p className="ai-note">
            Not offered: {choices.unavailable.map((row) => `${row.provider} (${row.reason})`).join('; ')}.
          </p>
        ) : null}

        {error ? (
          <div className="ai-error" role="alert">
            <strong>The model could not answer.</strong> {error}
          </div>
        ) : null}

        {busy ? (
          <p className="ai-waiting">
            Asking {choice?.model ?? 'the model'} to read {periodLabel(days)}.
            A long period takes a few seconds to gather and about ten to answer.
          </p>
        ) : null}

        {report && !busy ? (
          <article className="ai-report">
            <div className="ai-meta">
              {report.model} via {report.provider} · {periodLabel(report.days)} ·
              answered in {report.took_s}s · {new Date(report.generated_at * 1000).toLocaleTimeString()}
              <button type="button" className="ai-copy" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {report.finish_reason === 'length' ? (
              <p className="ai-truncated">
                The model hit its output limit before it finished; ask again or pick a shorter period.
              </p>
            ) : null}
            <Markdown text={report.markdown} />
          </article>
        ) : null}

        {!report && !busy && !error ? (
          <p className="ai-idle">
            Nothing has been sent yet. The report costs one model call — roughly a couple of thousand
            tokens in and about the same out — to the model you pick above.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function keyOf(row: InsightChoice): string {
  return `${row.provider}|${row.model}`;
}

/** Provider names as a person reads them. `nous` is Nous Research's own inference portal, and
 *  saying so is a fact about where the call goes, not advertising. */
export function providerLabel(provider: string): string {
  if (provider === 'nous') return 'nous · Nous Research';
  return provider;
}

function groupByProvider(rows: InsightChoice[]): [string, InsightChoice[]][] {
  const map = new Map<string, InsightChoice[]>();
  for (const row of rows) {
    const list = map.get(row.provider) ?? [];
    list.push(row);
    map.set(row.provider, list);
  }
  // Keep the server's order: the model Hermes itself uses is first in its provider, and a
  // second alphabetical sort here would hide it below `~anthropic/...`.
  return [...map.entries()];
}

/** A deliberately small markdown reader: headings, bullets, numbers, bold and inline code. */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="ai-md">
      {blocks.map((block, index) => {
        if (block.kind === 'h') {
          return block.level <= 2 ? (
            <h3 key={index}>{inline(block.text)}</h3>
          ) : (
            <h4 key={index}>{inline(block.text)}</h4>
          );
        }
        if (block.kind === 'ul') {
          return (
            <ul key={index}>
              {block.items.map((item, i) => (
                <li key={i}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'ol') {
          return (
            <ol key={index}>
              {block.items.map((item, i) => (
                <li key={i}>{inline(item)}</li>
              ))}
            </ol>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list || list.kind !== 'ul') {
        flush();
        list = { kind: 'ul', items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (!list || list.kind !== 'ol') {
        flush();
        list = { kind: 'ol', items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }
    flush();
    const previous = blocks[blocks.length - 1];
    if (previous && previous.kind === 'p') previous.text = `${previous.text} ${line.trim()}`;
    else blocks.push({ kind: 'p', text: line.trim() });
  }
  flush();
  return blocks;
}

/** Bold and inline code only — anything else stays literal, so a model cannot inject markup. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) out.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    else out.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
