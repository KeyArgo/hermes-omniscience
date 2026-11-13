import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchInsight, type InsightReport } from '../api';
import './InsightPanel.css';

/**
 * The writeup — what the recording says needs fixing, in a model's words.
 *
 * The model is Hermes' own (`ctx.llm`). The viewer never holds a key and never calls a
 * provider, so this panel reads the report Hermes saved beside the recording; `/omni insight`
 * in Hermes is what writes it. Nothing private is involved either way: the recorder keeps
 * counts, timings and error reasons, and the digest is built from the same figures the pages
 * show.
 *
 * The report is a diagnosis, not a summary of the interface: what the time and money went on,
 * which provider queued or refused calls, whether context growth is the real problem, and what
 * to change.
 */

/** The period as a person reads it, for the line above the answer. */
function periodLabel(days: number): string {
  if (days === 0) return 'everything recorded';
  if (days * 24 <= 1.5) return `the last ${Math.max(1, Math.round(days * 24))} hour`;
  if (days < 1.5) return 'the last day';
  return `the last ${days} days`;
}

export function InsightPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [report, setReport] = useState<InsightReport | null>(null);
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    const state = await fetchInsight();
    setReport(state.report);
    setHint(state.hint);
    setLoading(false);
  };

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    setLoading(true);
    void fetchInsight().then((state) => {
      if (stopped) return;
      setReport(state.report);
      setHint(state.hint);
      setLoading(false);
    });
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

  if (!open) return null;

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
    <div className="ai-scrim" role="dialog" aria-modal="true" aria-label="The writeup">
      <div className="ai-panel">
        <header className="ai-head">
          <div>
            <h2 className="ai-title">The writeup</h2>
            <p className="ai-lede">
              Hermes reads this recording — calls, tokens, cache, timings, rate limits, context
              growth — with the model you are already using, and writes what to fix. Metadata only:
              the recorder never stores a prompt, a tool argument or a file&apos;s contents.
            </p>
          </div>
          <button type="button" className="ai-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="ai-controls">
          <button type="button" className="ai-run" onClick={() => void load()} disabled={loading}>
            {loading ? 'Reading…' : 'Reload'}
          </button>
        </div>

        <p className="ai-note">
          Written in Hermes: run <code>/omni insight</code> there (or <code>/omni insight 30</code>{' '}
          for a period), then reload this panel. The viewer holds no key and calls no provider, so
          the model call happens inside Hermes, where your credentials already live.
        </p>

        {!loading && !report ? (
          <p className="ai-idle">
            No writeup yet for this recording. {hint ? `${hint} ` : ''}
            The report costs one model call on the model Hermes is using — roughly a couple of
            thousand tokens in and about the same out.
          </p>
        ) : null}

        {report ? (
          <article className="ai-report">
            <div className="ai-meta">
              {report.model || 'your active model'}
              {report.provider ? ` via ${report.provider}` : ''} · {periodLabel(report.days)} ·
              answered in {report.took_s}s ·{' '}
              {new Date(report.generated_at * 1000).toLocaleString()}
              <button type="button" className="ai-copy" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <Markdown text={report.markdown} />
          </article>
        ) : null}
      </div>
    </div>
  );
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
