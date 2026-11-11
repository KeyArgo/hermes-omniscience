import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { shownState, whyKey, WhyAnswer, WhyPanel, type WhyAnswerValue } from './WhyPanel';
import type { Diagnose } from '../api';

const explained: Diagnose = {
  status: 'explained',
  failed_kind: 'tool.end',
  failed_tool: 'Bash',
  error_type: 'PermissionError',
  duration_ms: 91,
  session_id: 's1',
  previous_step: { kind: 'tool.end', tool: 'Read', duration_ms: 42, event_id: 'e2' },
  evidence_event_ids: ['e1', 'e2'],
  sentence: 'The first failure was the Bash tool with a PermissionError error after 91 ms.',
};

function answerHtml(answer: WhyAnswerValue): string {
  const html = renderToStaticMarkup(
    <WhyAnswer answer={answer} stepHidden={false} onSelectEvent={() => true} onStepFound={() => {}} />,
  );
  return html.replaceAll('&#x27;', "'");
}

function buttonsIn(node: ReactNode): ReactElement[] {
  const found: ReactElement[] = [];
  const walk = (candidate: ReactNode) => {
    if (typeof candidate !== 'object' || candidate === null) return;
    if (Array.isArray(candidate)) {
      candidate.forEach(walk);
      return;
    }
    if (!isValidElement(candidate)) return;
    if (candidate.type === 'button') {
      found.push(candidate);
    }
    walk((candidate.props as { children?: ReactNode }).children);
  };
  walk(node);
  return found;
}

function clickLink(element: ReactNode, label: string) {
  const button = buttonsIn(element).find(
    (candidate) => (candidate.props as { children?: unknown }).children === label,
  );
  if (!button) throw new Error(`link not found: ${label}`);
  (button.props as { onClick: () => void }).onClick();
}

describe('WhyPanel', () => {
  it('hides until the graph has errors, then asks the question', () => {
    const hidden = renderToStaticMarkup(
      <WhyPanel root="s1" failedCount={0} onSelectEvent={() => true} />,
    );
    expect(hidden).toBe('');
    const shown = renderToStaticMarkup(
      <WhyPanel root="s1" failedCount={2} onSelectEvent={() => true} />,
    );
    expect(shown).toContain('Why did this run fail?');
  });

  it('explains the failure, the step before and offers both jumps', () => {
    const html = answerHtml(explained);
    expect(html).toContain('The first failure was the Bash tool with a PermissionError error after 91 ms.');
    expect(html).toContain('Step before it: Read (42 ms)');
    expect(html).toContain('Show failing step');
    expect(html).toContain('Show step before');
  });

  it('states the honest short answer for every other status', () => {
    expect(answerHtml({ status: 'no_failure', events: 12 })).toContain('No failure was found in the events reviewed.');
    const missing: Diagnose = { status: 'insufficient', missing: ['previous_step', 'error_type'] };
    expect(answerHtml(missing)).toContain('Not enough recorded data to say why. Missing: previous_step, error_type.');
    expect(answerHtml('error')).toContain("Couldn't reach the viewer.");
  });

  it('links select map nodes through their event ids', () => {
    const clicked: string[] = [];
    const element = WhyAnswer({
      answer: explained,
      stepHidden: false,
      onSelectEvent: (eventId) => {
        clicked.push(eventId);
        return true;
      },
      onStepFound: () => {},
    });
    clickLink(element, 'Show failing step');
    clickLink(element, 'Show step before');
    expect(clicked).toEqual(['e1', 'e2']);
  });

  it('forgets the answer when the session or the failing-step count changes', () => {
    const asked = { key: whyKey('s1', 1), answer: explained, stepHidden: false };
    expect(shownState(asked, whyKey('s1', 1)).answer).toBe(explained);
    expect(shownState(asked, whyKey('s2', 1)).answer).toBeNull();
    expect(shownState(asked, whyKey('s1', 2)).answer).toBeNull();
  });

  it('shows a hint when the clicked step is not on the map', () => {
    const reports: boolean[] = [];
    const element = WhyAnswer({
      answer: explained,
      stepHidden: false,
      onSelectEvent: () => false,
      onStepFound: (found) => reports.push(found),
    });
    clickLink(element, 'Show failing step');
    expect(reports).toEqual([false]);
    const html = renderToStaticMarkup(
      <WhyAnswer answer={explained} stepHidden onSelectEvent={() => true} onStepFound={() => {}} />,
    );
    expect(html.replaceAll('&#x27;', "'")).toContain(
      "That step isn't on the map right now (a filter may hide it).",
    );
  });
});
