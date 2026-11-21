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
  it('paints no close control of its own: the rail owns the one ×', () => {
    // The panel is only one of three things the rail can show (Inspect, Warnings, Why, and the
    // mini panel). A close button in this head is absent on every other one, and at 701–900 px
    // the rail's collapse chevron is hidden, which left the drawer with no way out. The single
    // close control lives on the rail (`shell/RailClose.tsx`) so it is the same one everywhere.
    const html = renderToStaticMarkup(<Inspector node={node()} />);
    expect(html).not.toContain('Close details');
    expect(html).not.toContain('inspector-close');
  });

  it('still names the step it is showing', () => {
    const html = renderToStaticMarkup(<Inspector node={node()} />);
    expect(html).toContain('inspector');
    expect(html).toContain('gpt-5');
  });
});
