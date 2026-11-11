import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tour } from './Tour';

describe('Tour', () => {
  it('renders nothing during SSR', () => {
    const html = renderToStaticMarkup(<Tour />);
    expect(html).toBe('');
  });

  it('renders nothing with forceStart during SSR', () => {
    const html = renderToStaticMarkup(<Tour forceStart={1} />);
    expect(html).toBe('');
  });
});
