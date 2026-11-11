import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PanelFrame, clampHeight, heightForKey } from './PanelFrame';

describe('heightForKey', () => {
  it('steps by 16 for plain arrows', () => {
    expect(heightForKey(200, 'ArrowDown', false, 120)).toBe(216);
    expect(heightForKey(200, 'ArrowUp', false, 120)).toBe(184);
  });

  it('steps by 64 with shift', () => {
    expect(heightForKey(200, 'ArrowDown', true, 120)).toBe(264);
    expect(heightForKey(200, 'ArrowUp', true, 120)).toBe(136);
  });

  it('clamps arrows to min and max', () => {
    expect(heightForKey(120, 'ArrowUp', false, 120)).toBe(120);
    expect(heightForKey(1190, 'ArrowDown', false, 120)).toBe(1200);
  });

  it('home goes to min, end to max', () => {
    expect(heightForKey(300, 'Home', false, 120)).toBe(120);
    expect(heightForKey(300, 'End', false, 120)).toBe(1200);
  });

  it('returns null for unhandled keys', () => {
    expect(heightForKey(300, 'a', false, 120)).toBeNull();
    expect(heightForKey(300, 'Enter', true, 120)).toBeNull();
  });
});

describe('clampHeight', () => {
  it('clamps into range', () => {
    expect(clampHeight(50, 120)).toBe(120);
    expect(clampHeight(5000, 120)).toBe(1200);
    expect(clampHeight(300, 120)).toBe(300);
  });

  it('honours a custom max', () => {
    expect(clampHeight(5000, 120, 600)).toBe(600);
  });
});

describe('PanelFrame markup', () => {
  it('renders a fold button by default', () => {
    const html = renderToStaticMarkup(
      <PanelFrame id="t1" title="Test">
        <p>body</p>
      </PanelFrame>,
    );
    expect(html).toContain('Fold panel');
    expect(html).toContain('data-panel="t1"');
  });

  it('renders a hide button when onHide is given', () => {
    const html = renderToStaticMarkup(
      <PanelFrame id="t2" title="Test" onHide={() => {}}>
        <p>body</p>
      </PanelFrame>,
    );
    expect(html).toContain('Hide panel');
  });

  it('shows the summary text', () => {
    const html = renderToStaticMarkup(
      <PanelFrame id="t3" title="Test" summary="42 days, 3 gaps">
        <p>body</p>
      </PanelFrame>,
    );
    expect(html).toContain('pf-summary');
    expect(html).toContain('42 days, 3 gaps');
  });

  it('exposes data-panel and data-tour', () => {
    const html = renderToStaticMarkup(
      <PanelFrame id="t4" title="Test" tourId="tour-a">
        <p>body</p>
      </PanelFrame>,
    );
    expect(html).toContain('data-panel="t4"');
    expect(html).toContain('data-tour="tour-a"');
  });
});
