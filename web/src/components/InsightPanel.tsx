import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchInsight, type InsightReport, type InsightState } from '../api';
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

/** Each open modal's place in the paint order: its layer's z-index, and its order in the page. */
export interface ModalSlot {
  z: number;
  order: number;
}

/**
 * Whether this modal is the one the keyboard belongs to. The highest layer wins, and on an equal
 * z-index the one later in the document paints on top. Without this a stacked dialog would take
 * Escape (and Tab) from the surface drawn over it.
 */
export function isTopmostLayer(mine: ModalSlot, others: readonly ModalSlot[]): boolean {
  return others.every((other) => mine.z > other.z || (mine.z === other.z && mine.order > other.order));
}

/** The panel's own focusables, in the order Tab visits them; hidden ones are filtered by the caller. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A layer's z-index: the largest numeric one on the element or on the boxes it sits in. */
function layerZ(el: Element): number {
  let z = 0;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = Number.parseInt(window.getComputedStyle(node).zIndex, 10);
    if (!Number.isNaN(value)) z = Math.max(z, value);
  }
  return z;
}

/** The dialog that owns the keyboard right now, whichever overlay drew it. */
function owningDialog(): Element | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
  ).filter((el) => el.getClientRects().length > 0);
  if (dialogs.length === 0) return null;
  const slots = dialogs.map((el, order) => ({ el, slot: { z: layerZ(el), order } }));
  let winner = slots[0];
  for (const candidate of slots.slice(1)) {
    if (!isTopmostLayer(winner.slot, [candidate.slot])) winner = candidate;
  }
  return winner.el;
}

/** True while this panel's dialog is the topmost modal, so Escape and Tab are its to handle. */
function ownsKeyboard(panel: HTMLElement | null): boolean {
  const dialog = panel?.closest('[role="dialog"][aria-modal="true"]');
  if (!dialog) return true;
  return owningDialog() === dialog;
}

/**
 * Whether focus may go back to whatever opened the panel. Not when that control has been
 * unmounted (the compact header swaps its buttons), hidden or disabled — `.focus()` on any of
 * those silently does nothing and would leave focus on the page — and not when the reader has
 * already moved focus elsewhere on purpose: restoring then would snatch it back.
 */
export function mayReturnFocus(state: {
  openerConnected: boolean;
  openerVisible: boolean;
  openerDisabled: boolean;
  focusWasInPanel: boolean;
  focusOnPage: boolean;
}): boolean {
  if (!state.openerConnected || !state.openerVisible || state.openerDisabled) return false;
  return state.focusWasInPanel || state.focusOnPage;
}

/**
 * The hint `fetchInsight` attaches when the request itself failed. It resolves rather than
 * rejects, so this — with no report beside it — is the only signal that tells "could not ask"
 * apart from "no report yet".
 */
const FAILED_READ_HINT = 'the viewer did not answer';

/** True when the read failed rather than finding no report. */
export function failedRead(state: InsightState): boolean {
  return !state.available && state.report === null && state.hint === FAILED_READ_HINT;
}

/**
 * What to keep after a read. A failed read keeps the report already on screen: replacing it with
 * "No writeup yet" would be a different claim, and a false one. A read that succeeds replaces it,
 * even when the answer is that the report is gone.
 */
export function keepReportOnFailure(
  previous: InsightReport | null,
  state: InsightState,
): InsightReport | null {
  return failedRead(state) ? previous : state.report;
}

/**
 * Read tokens for the panel. Every open and every Reload takes a new token, and a response is
 * published only while its token is still the newest: a read that lands after the panel closed,
 * or after a newer Reload, belongs to nobody and must not overwrite what is on screen.
 */
export interface ReadGate {
  begin(): number;
  isCurrent(token: number): boolean;
  retire(): void;
}

export function createReadGate(): ReadGate {
  let current = 0;
  return {
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (token: number) => token === current,
    retire: () => {
      current += 1;
    },
  };
}

export function InsightPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [report, setReport] = useState<InsightReport | null>(null);
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const gate = useMemo(createReadGate, []);
  // App hands down a new onClose on every render; a ref keeps the key listener from being torn
  // down and rebuilt while the report is being read (or is still loading).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async () => {
    const token = gate.begin();
    setLoading(true);
    const state = await fetchInsight();
    // A read that a newer visit or Reload has superseded publishes nothing at all: not the
    // report, not the hint, not the loading flag.
    if (!gate.isCurrent(token)) return;
    setFailed(failedRead(state));
    setHint(state.hint);
    setReport((previous) => keepReportOnFailure(previous, state));
    setLoading(false);
  }, [gate]);

  useEffect(() => {
    if (!open) return;
    // Opening starts clean: the previous visit's "Copied" label and failure notice are not news
    // about this one, and the read below will say what is true once it has an answer.
    setCopied(false);
    setFailed(false);
    void load();
    return () => {
      // Closing retires the visit: a response that arrives after this belongs to no panel.
      gate.retire();
    };
  }, [open, load, gate]);

  // The "Copied" label is feedback, not state anyone asked to keep: drop its timer with the panel.
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  // A dialog must own focus from the moment it opens. Close is the predictable landing point;
  // Tab and Shift+Tab wrap inside the panel; Escape closes it only while it is the topmost layer,
  // so a Settings/Help surface drawn above keeps its own Escape (and App's workspace shortcuts,
  // which check defaultPrevented, stay out of it). On the way out focus goes back to the chip or
  // button that opened it, unless that control has been unmounted or focus has moved on.
  useEffect(() => {
    if (!open) return;
    const dialog = panelRef.current;
    const opener = document.activeElement;
    openerRef.current = opener instanceof HTMLElement ? opener : null;
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      // Something closer to the key already acted on it — a control inside the panel, or a menu
      // that called preventDefault. One press must not close two things.
      if (event.defaultPrevented) return;
      if (!ownsKeyboard(dialog)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === dialog || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const back = openerRef.current;
      const active = document.activeElement;
      if (
        back &&
        mayReturnFocus({
          openerConnected: back.isConnected,
          openerVisible: back.getClientRects().length > 0,
          openerDisabled: back.hasAttribute('disabled'),
          focusWasInPanel: !!dialog?.contains(active),
          focusOnPage: !active || active === document.body,
        })
      ) {
        back.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.markdown);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        copiedTimer.current = null;
        setCopied(false);
      }, 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="ai-scrim" role="dialog" aria-modal="true" aria-labelledby="ai-title">
      <div ref={panelRef} tabIndex={-1} className="ai-panel">
        <header className="ai-head">
          <div>
            <h2 id="ai-title" className="ai-title">The writeup</h2>
            <p className="ai-lede">
              Hermes reads this recording — calls, tokens, cache, timings, rate limits, context
              growth — with the model you are already using, and writes what to fix. Metadata only:
              the recorder never stores a prompt, a tool argument or a file&apos;s contents.
            </p>
          </div>
          <button ref={closeRef} type="button" className="ai-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="ai-controls">
          <button type="button" className="ai-run" onClick={() => void load()} disabled={loading}>
            {loading ? 'Reading…' : 'Reload'}
          </button>
        </div>

        {failed && report ? (
          <p className="ai-note" role="status">
            The viewer did not answer, so this is the copy read earlier. Nothing was changed.
          </p>
        ) : null}

        <p className="ai-note">
          Written in Hermes: run <code>/omni insight</code> there (or <code>/omni insight 30</code>{' '}
          for a period), then reload this panel. The viewer holds no key and calls no provider, so
          the model call happens inside Hermes, where your credentials already live.
        </p>

        {!loading && !report ? (
          <p className="ai-idle">
            {failed
              ? 'The writeup could not be read: the viewer did not answer. '
              : `No writeup yet for this recording. ${hint ? `${hint} ` : ''}`}
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
