import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MenuButton, MenuItem, moveFocusIndex } from './MenuButton';

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
