import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextView } from './ContextView';
import type { OmniEvent } from '../types';

function call(prompt: number, index: number): OmniEvent[] {
  return [
    {
      rowid: index * 2 + 1,
      event_id: `turn-${index}`,
      schema: 'omni.v1',
      boot_id: 'b',
      seq: index * 2,
      ts: 1762400000 + index * 60,
      kind: 'turn.start',
      session_id: 'root',
      parent_session_id: null,
      turn_id: `t${index}`,
      api_request_id: null,
      tool_call_id: null,
      subagent_id: null,
      status: null,
      attrs: null,
    },
    {
      rowid: index * 2 + 2,
      event_id: `req-${index}`,
      schema: 'omni.v1',
      boot_id: 'b',
      seq: index * 2 + 1,
      ts: 1762400001 + index * 60,
      kind: 'llm.request',
      session_id: 'root',
      parent_session_id: null,
      turn_id: `t${index}`,
      api_request_id: `r${index}`,
      tool_call_id: null,
      subagent_id: null,
      status: null,
      attrs: {
        model: 'm',
        provider: 'p',
        message_count: 4,
        tool_count: 2,
        approx_input_tokens: prompt,
        usage: { prompt_tokens: prompt, cache_read_tokens: 0, output_tokens: 50 },
      },
    },
  ];
}

const spread = [517000, 512000, 498000, 61000, 64000, 68000, 72000, 76000].flatMap(call);
const steady = [1000, 1100, 1200].flatMap(call);

const render = (events: OmniEvent[], compact = false) =>
  renderToStaticMarkup(
    <ContextView events={events} rootSessionId="root" onSelectEvent={() => {}} compact={compact} />,
  );

describe('ContextView chart sizing', () => {
  it('keeps the standalone compact chart at its inline height', () => {
    const html = render(spread, true);
    expect(html).toContain('height="132"');
    expect(html).toContain('viewBox="0 0 320 132"');
    expect(html).not.toContain('height="220"');
  });

  it('keeps the full account view at its own height', () => {
    const html = render(spread);
    expect(html).toContain('height="220"');
    expect(html).toContain('viewBox="0 0 320 220"');
    expect(html).not.toContain('height="132"');
  });
});

describe('ContextView labels', () => {
  it('keeps both time ticks and every logarithmic value label', () => {
    const html = render(spread, true);
    expect(html).toContain('cx-scale-note');
    expect(html).toContain('logarithmic');
    expect(html).toContain('>1k<');
    expect(html).toContain('>100k<');
    expect(html).toContain('cx-axis-time');
  });

  it('does not show the scale note when the axis is linear', () => {
    const html = render(steady, true);
    expect(html).not.toContain('cx-scale-note');
    expect(html).toContain('>1k<');
  });

  it('keeps the notes above the chart', () => {
    const html = render(steady, true);
    expect(html).toContain('Each model call now re-sends about');
    expect(html.indexOf('cx-notes')).toBeLessThan(html.indexOf('cx-chart'));
  });
});

describe('ContextView interaction markup', () => {
  it('keeps points focusable and clickable in the compact chart', () => {
    const html = render(steady, true);
    expect(html).toContain('class="cx-point"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="img"');
  });

  it('offers the enlarge control only in the compact chart', () => {
    expect(render(steady, true)).toContain('Show this chart larger');
    expect(render(steady)).not.toContain('Show this chart larger');
  });
});
