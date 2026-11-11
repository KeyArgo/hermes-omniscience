import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { groupWarnings, WarningsPanel } from './WarningsPanel';
import type { Warning } from '../types';

const warning: Warning = {
  title: 'Lost events',
  what_happened: '42 events were skipped.',
  what_it_means: 'The recorder fell behind.',
  severity: 'warn',
  event_ids: ['e1'],
  session_id: null,
};

describe('WarningsPanel', () => {
  it('renders nothing for an empty list', () => {
    const html = renderToStaticMarkup(
      <WarningsPanel warnings={[]} nodes={[]} onSelectNode={() => {}} />,
    );
    expect(html).toBe('');
  });

  it('renders title, what happened and meaning for each warning', () => {
    const html = renderToStaticMarkup(
      <WarningsPanel warnings={[warning]} nodes={[]} onSelectNode={() => {}} />,
    );
    expect(html).toContain('Things worth a look');
    expect(html).toContain('Lost events');
    expect(html).toContain('42 events were skipped.');
    expect(html).toContain('The recorder fell behind.');
  });

  it('escapes text instead of rendering it as HTML', () => {
    const html = renderToStaticMarkup(
      <WarningsPanel
        warnings={[{ ...warning, title: '<img src=x onerror=alert(1)>' }]}
        nodes={[]}
        onSelectNode={() => {}}
      />,
    );
    expect(html).not.toContain('<img');
  });

  it('groups exact matches without losing individual event links', () => {
    const second = { ...warning, event_ids: ['e2'] };
    const different = { ...warning, what_happened: 'A different amount was skipped.', event_ids: ['e3'] };
    expect(groupWarnings([warning, second, different])).toEqual([[warning, second], [different]]);
    const html = renderToStaticMarkup(<WarningsPanel warnings={[warning, second]} nodes={[]} onSelectNode={() => {}} />);
    expect(html).toContain('2 matching warnings');
    expect(html).toContain('Show each occurrence');
    expect(html).toContain('Occurrence 2');
  });
});
