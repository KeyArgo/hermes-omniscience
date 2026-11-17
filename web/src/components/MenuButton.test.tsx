import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MenuButton, MenuItem, moveFocusIndex, placeMenu } from './MenuButton';

describe('moveFocusIndex', () => {
  it('wraps down past the end', () => {
    expect(moveFocusIndex(2, 'ArrowDown', 3)).toBe(0);
  });

  it('wraps up past the start', () => {
    expect(moveFocusIndex(0, 'ArrowUp', 3)).toBe(2);
  });

  it('jumps to home and end', () => {
    expect(moveFocusIndex(1, 'Home', 4)).toBe(0);
    expect(moveFocusIndex(1, 'End', 4)).toBe(3);
  });

  it('returns -1 for empty', () => {
    expect(moveFocusIndex(0, 'ArrowDown', 0)).toBe(-1);
  });
});

describe('MenuButton static render', () => {
  it('shows label and collapsed state', () => {
    const html = renderToStaticMarkup(
      <MenuButton label="Options">
        <MenuItem>One</MenuItem>
      </MenuButton>,
    );
    expect(html).toContain('Options');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="true"');
  });

  it('shows badge only when greater than zero', () => {
    const withBadge = renderToStaticMarkup(
      <MenuButton label="Alerts" badge={3}>
        <MenuItem>One</MenuItem>
      </MenuButton>,
    );
    expect(withBadge).toContain('mb-badge');
    expect(withBadge).toContain('3');

    const zero = renderToStaticMarkup(
      <MenuButton label="Alerts" badge={0}>
        <MenuItem>One</MenuItem>
      </MenuButton>,
    );
    expect(zero).not.toContain('mb-badge');
  });
});

describe('placeMenu', () => {
  const viewport = { width: 1366, height: 768 };
  it('opens below the trigger, right-aligned for end menus, at full readable width', () => {
    const p = placeMenu({ top: 150, bottom: 196, left: 1000, right: 1100 }, 320, viewport, 'end');
    expect(p.top).toBe(202);
    expect(p.left + p.width).toBe(1100);
    expect(p.width).toBe(440);
  });
  it('never crosses the left or right window edge', () => {
    const left = placeMenu({ top: 10, bottom: 50, left: 2, right: 60 }, 200, viewport, 'end');
    expect(left.left).toBeGreaterThanOrEqual(8);
    const right = placeMenu({ top: 10, bottom: 50, left: 1340, right: 1360 }, 200, viewport, 'start');
    expect(right.left + right.width).toBeLessThanOrEqual(1366 - 8);
  });
  it('fits a phone width', () => {
    const p = placeMenu({ top: 100, bottom: 140, left: 300, right: 400 }, 300, { width: 320, height: 600 }, 'end');
    expect(p.left).toBe(8);
    expect(p.width).toBe(304);
  });
  it('flips above when there is more room there, and scrolls when neither side fits', () => {
    const up = placeMenu({ top: 600, bottom: 640, left: 10, right: 90 }, 400, viewport, 'start');
    expect(up.top + Math.min(400, up.maxHeight)).toBeLessThanOrEqual(600);
    const tall = placeMenu({ top: 300, bottom: 340, left: 10, right: 90 }, 5000, viewport, 'start');
    expect(tall.maxHeight).toBeLessThan(768);
    expect(tall.top).toBeGreaterThanOrEqual(8);
  });
});
