import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TipLayer } from './TipLayer';

describe('TipLayer', () => {
  it('renders nothing initially', () => {
    expect(renderToStaticMarkup(<TipLayer />)).toBe('');
  });

  it('renders nothing with extra selectors', () => {
    expect(renderToStaticMarkup(<TipLayer extra={{ '#save': 'Save' }} />)).toBe('');
  });
});
