import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fixtureEvents } from '../graph/fixture';
import { EventTimeline, groupAdjacentEvents } from './EventTimeline';

describe('recorded timeline', () => {
  it('labels its limited scope and does not offer nonexistent graph links', () => {
    const html = renderToStaticMarkup(<EventTimeline events={fixtureEvents} nodes={[]} onSelectEvent={() => false} />);
    expect(html).toContain('Recorded timeline');
    expect(html).toContain('recording times');
    expect(html).toContain('disabled');
  });
  it('groups adjacent labels without losing the underlying events', () => {
    const one = { ...fixtureEvents[0], event_id: 'one', kind: 'tool.end', attrs: { tool_name: 'search' } };
    const two = { ...one, event_id: 'two' };
    const three = { ...one, event_id: 'three', attrs: { tool_name: 'read' } };
    expect(groupAdjacentEvents([one, two, three, one])).toEqual([[one, two], [three], [one]]);
  });
  it('shows measured durations and token counts only when recorded', () => {
    const event = { ...fixtureEvents[0], event_id: 'response', kind: 'llm.response', attrs: { duration_s: 4.2, ttfb_s: 0.5, usage: { input_tokens: 125, output_tokens: 20 } } };
    const html = renderToStaticMarkup(<EventTimeline events={[event]} nodes={[]} onSelectEvent={() => false} />);
    expect(html).toContain('4.20s');
    expect(html).toContain('first response 0.50s');
    expect(html).toContain('125 tokens in');
    expect(html).toContain('20 out');
    expect(html).toContain('Model response');
  });
});
