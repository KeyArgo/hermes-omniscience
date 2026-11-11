import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PanelsSheet } from './PanelsSheet';
import { PANELS, type Overrides, type Preset } from '../shell/layoutPrefs';

function makePrefs(preset: Preset) {
  const overrides: Overrides = { hidden: [], shown: [] };
  return {
    visible: (id: string) => {
      const panel = PANELS.find((p) => p.id === id);
      return panel ? panel.defaultVisible[preset] : false;
    },
    toggle: () => {},
    reset: () => {},
    overrides,
  };
}

describe('PanelsSheet', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <PanelsSheet
        open={false}
        onClose={() => {}}
        preset="standard"
        onPreset={() => {}}
        prefs={makePrefs('standard')}
      />,
    );
    expect(html).toBe('');
  });

  it('renders all panels, reset button and preset options when open', () => {
    const html = renderToStaticMarkup(
      <PanelsSheet
        open
        onClose={() => {}}
        preset="standard"
        onPreset={() => {}}
        prefs={makePrefs('standard')}
      />,
    );
    for (const panel of PANELS) {
      expect(html).toContain(panel.title.replace(/&/g, '&amp;'));
    }
    expect(html).toContain('Reset This Layout');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('Simple');
    expect(html).toContain('Standard');
    expect(html).toContain('Everything');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });
});
