import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  InsightPanel,
  createReadGate,
  failedRead,
  isTopmostLayer,
  keepReportOnFailure,
  mayReturnFocus,
} from './InsightPanel';
import type { InsightReport, InsightState } from '../api';

// The viewer's tests run in plain Node (no DOM), so the Tab/Escape mechanics themselves are
// exercised in a real browser (dev/insight-focus.mjs); here we pin the contract they depend on:
// the dialog's labelling and focus targets, which layer owns the keyboard when overlays stack,
// when focus may go back to the opener, and which reads are allowed to publish.

describe('InsightPanel markup', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(<InsightPanel open={false} onClose={() => {}} />);
    expect(html).toBe('');
  });

  it('is a labelled modal dialog with a single readable name', () => {
    const html = renderToStaticMarkup(<InsightPanel open onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="ai-title"');
    expect(html).toContain('id="ai-title"');
    // The name comes from the visible heading, not a second aria-label that could drift from it.
    expect(html).not.toContain('aria-label="The writeup"');
  });

  it('puts Close first in the tab order, so initial focus is the obvious way out', () => {
    const html = renderToStaticMarkup(<InsightPanel open onClose={() => {}} />);
    const close = html.indexOf('ai-close');
    const reload = html.indexOf('ai-run');
    expect(close).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(close);
    const firstButton = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(firstButton).toContain('aria-label="Close"');
  });

  it('keeps a programmatic focus target on the panel for the no-focusables fallback', () => {
    const html = renderToStaticMarkup(<InsightPanel open onClose={() => {}} />);
    expect(html).toMatch(/class="ai-panel"[^>]*tabindex="-1"|tabindex="-1"[^>]*class="ai-panel"/);
  });
});

describe('isTopmostLayer', () => {
  const mine = { z: 90, order: 1 };

  it('owns the keyboard when nothing else is open', () => {
    expect(isTopmostLayer(mine, [])).toBe(true);
  });

  it('yields to a higher layer regardless of document order', () => {
    expect(isTopmostLayer(mine, [{ z: 100, order: 0 }])).toBe(false);
  });

  it('wins over a lower layer even when that one renders later', () => {
    expect(isTopmostLayer(mine, [{ z: 60, order: 9 }])).toBe(true);
  });

  it('wins an equal z-index tie only by rendering later', () => {
    expect(isTopmostLayer(mine, [{ z: 90, order: 0 }])).toBe(true);
    expect(isTopmostLayer(mine, [{ z: 90, order: 2 }])).toBe(false);
  });

  it('requires being above every other layer, not just one of them', () => {
    expect(isTopmostLayer(mine, [{ z: 60, order: 0 }, { z: 90, order: 2 }])).toBe(false);
  });
});

describe('mayReturnFocus', () => {
  const base = {
    openerConnected: true,
    openerVisible: true,
    openerDisabled: false,
    focusWasInPanel: true,
    focusOnPage: false,
  };

  it('returns focus to a live opener when the panel still had it', () => {
    expect(mayReturnFocus(base)).toBe(true);
  });

  it('returns focus when it has already fallen back to the page', () => {
    expect(mayReturnFocus({ ...base, focusWasInPanel: false, focusOnPage: true })).toBe(true);
  });

  it('does not grab focus back once the reader has moved on', () => {
    expect(mayReturnFocus({ ...base, focusWasInPanel: false, focusOnPage: false })).toBe(false);
  });

  it('does not aim at an opener that was unmounted with the compact header', () => {
    expect(mayReturnFocus({ ...base, openerConnected: false })).toBe(false);
  });

  it('does not aim at a disabled opener', () => {
    expect(mayReturnFocus({ ...base, openerDisabled: true })).toBe(false);
  });

  it('does not aim at a hidden opener, where focus() would silently do nothing', () => {
    expect(mayReturnFocus({ ...base, openerVisible: false })).toBe(false);
  });
});

const REPORT: InsightReport = {
  markdown: '# The writeup\n\n- one thing',
  model: 'hermes',
  provider: 'local',
  days: 1,
  took_s: 3.2,
  generated_at: 1_700_000_000,
};

const READ: InsightState = { available: true, report: REPORT, hint: '' };
const NOTHING: InsightState = { available: false, report: null, hint: 'run /omni insight in Hermes' };
const UNREACHABLE: InsightState = { available: false, report: null, hint: 'the viewer did not answer' };

describe('failedRead', () => {
  it('tells a request that failed apart from a recording with no report', () => {
    expect(failedRead(UNREACHABLE)).toBe(true);
    expect(failedRead(NOTHING)).toBe(false);
    expect(failedRead(READ)).toBe(false);
  });
});

describe('keepReportOnFailure', () => {
  it('keeps the report on screen when the reload fails', () => {
    expect(keepReportOnFailure(REPORT, UNREACHABLE)).toBe(REPORT);
  });

  it('does not invent a report when the first read fails', () => {
    expect(keepReportOnFailure(null, UNREACHABLE)).toBeNull();
  });

  it('replaces the report when the viewer answers, including with no report', () => {
    expect(keepReportOnFailure(REPORT, NOTHING)).toBeNull();
    expect(keepReportOnFailure(null, READ)).toBe(REPORT);
  });
});

describe('createReadGate', () => {
  it('lets only the newest read publish', () => {
    const gate = createReadGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('drops a reload that lands after the panel closed and reopened', async () => {
    const gate = createReadGate();
    const published: string[] = [];
    const read = async (token: number, value: string, delay: number) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (gate.isCurrent(token)) published.push(value);
    };

    const oldVisit = read(gate.begin(), 'old', 30); // opened, Reload pressed
    gate.retire(); // panel closed: the old visit owns nothing now
    const newVisit = read(gate.begin(), 'new', 5); // reopened: a fresh read
    await Promise.all([oldVisit, newVisit]);

    expect(published).toEqual(['new']);
  });

  it('drops the slower of two overlapping reloads', async () => {
    const gate = createReadGate();
    const published: string[] = [];
    const read = async (token: number, value: string, delay: number) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (gate.isCurrent(token)) published.push(value);
    };

    const slow = read(gate.begin(), 'slow', 25);
    const fast = read(gate.begin(), 'fast', 5);
    await Promise.all([slow, fast]);

    expect(published).toEqual(['fast']);
  });

  it('publishes a read where nothing newer intervened', async () => {
    const gate = createReadGate();
    const published: string[] = [];
    const token = gate.begin();
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (gate.isCurrent(token)) published.push('only');
    expect(published).toEqual(['only']);
  });
});
