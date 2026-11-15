import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModeSwitch } from './ModeSwitch';

describe('ModeSwitch', () => {
  it('is a named group of two modes with the current one pressed', () => {
    const html = renderToStaticMarkup(<ModeSwitch mode="hermes" onChange={() => {}} />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Interface mode"');
    expect(html).toContain('>Hermes</button>');
    expect(html).toContain('>Web</button>');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-mode-option="hermes"/);
  });

  it('moves the pressed state with the mode, not by colour alone', () => {
    const web = renderToStaticMarkup(<ModeSwitch mode="web" onChange={() => {}} />);
    expect(web.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(web).toContain('is-active');
    // The visible label of the pressed option is the mode name, so a screenshot and a screen
    // reader agree on which one is current.
    expect(web).toMatch(/mode-option is-active"[^>]*aria-pressed="true"[^>]*>Web</);
  });

  it('explains what each mode is for in its tooltip', () => {
    const html = renderToStaticMarkup(<ModeSwitch mode="web" onChange={() => {}} />);
    expect(html).toContain('Starts Simple');
    expect(html).toContain('full workspace');
  });
});
