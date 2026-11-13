import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WriteupChip } from './App';

/** The visible text of rendered markup, with tags (and their attributes) dropped. */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, '');
}

describe('WriteupChip', () => {
  it('names the panel for what it shows, not for a call the viewer cannot make', () => {
    const markup = renderToStaticMarkup(<WriteupChip onOpen={() => {}} />);
    expect(textOf(markup)).toBe('Writeup');
    expect(markup).not.toContain('Ask a Model');
  });

  it('says where the model call happens', () => {
    const markup = renderToStaticMarkup(<WriteupChip onOpen={() => {}} />);
    expect(markup).toContain('/omni insight');
  });

  it('opens on click', () => {
    let opened = 0;
    const element = WriteupChip({ onOpen: () => (opened += 1) });
    (element.props as { onClick: () => void }).onClick();
    expect(opened).toBe(1);
  });
});
