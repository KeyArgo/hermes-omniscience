import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Inspector } from './Inspector';
import type { GNode } from '../graph/reduce';
import type { OmniEvent } from '../types';

function event(): OmniEvent {
  return {
    rowid: 7,
    event_id: 'evt-7',
    schema: 'omni.v1',
    boot_id: 'boot',
    seq: 7,
    ts: 1762400007,
    kind: 'llm.response',
    session_id: 'root',
    parent_session_id: null,
    turn_id: 'turn-1',
    api_request_id: 'req-7',
    tool_call_id: null,
    subagent_id: null,
    status: 'ok',
    attrs: {},
  };
}

function node(): GNode {
  const recorded = event();
  return {
    id: 'llm:req-7',
    type: 'llm',
    label: 'gpt-5',
    status: 'ok',
    firstRowid: 7,
    eventIds: [recorded.event_id],
    data: {
      status: 'ok',
      label: 'gpt-5',
      events: [recorded],
      model: 'gpt-5',
    },
  };
}

describe('the details panel head', () => {
  it('carries a close control named "Close details"', () => {
    const html = renderToStaticMarkup(<Inspector node={node()} onClose={() => {}} />);
    expect(html).toContain('aria-label="Close details"');
    expect(html).toContain('title="Close details (Esc)"');
  });

  it('is a real button, so it is reachable with Tab and fires on Enter and Space', () => {
    const html = renderToStaticMarkup(<Inspector node={node()} onClose={() => {}} />);
    const button = html.match(/<button[^>]*aria-label="Close details"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain('class="inspector-close"');
    // Not disabled, not hidden: nothing about the control depends on the width it is drawn at.
    expect(button).not.toContain('disabled');
    expect(button).not.toContain('hidden');
  });

  it('offers no close control when the panel owns no close action', () => {
    const html = renderToStaticMarkup(<Inspector node={node()} />);
    expect(html).not.toContain('Close details');
  });
});
