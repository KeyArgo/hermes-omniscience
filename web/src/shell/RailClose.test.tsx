import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RailClose } from './RailClose';
import appSource from '../App.tsx?raw';

describe('the rail close control', () => {
  it('is named "Close details" and is a real button at every width', () => {
    const html = renderToStaticMarkup(<RailClose onClose={() => {}} />);
    expect(html).toContain('aria-label="Close details"');
    expect(html).toContain('class="rail-close"');
    expect(html).toContain('type="button"');
    // Nothing about the control depends on the width it is drawn at.
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('hidden');
  });

  it('closes the panel when pressed', () => {
    const onClose = vi.fn();
    const element = RailClose({ onClose });
    expect(element.props.onClick).toBe(onClose);
    element.props.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the rail draws it once, on every tab and mode', () => {
  // The defect this fixes is a control that only exists in one branch of the rail's render tree,
  // so it is pinned at the call site: a DOM mock would happily pass while the button sat inside
  // `railMode === 'details'` / `railTab === 'inspect'`.
  it('renders one RailClose, closing the details panel', () => {
    const uses = appSource.match(/<RailClose\b/g) ?? [];
    expect(uses.length).toBe(1);
    expect(appSource).toContain('onClose={closeDetails}');
  });

  it('renders it inside the rail body, before any tab or mode branch', () => {
    const at = appSource.indexOf('<RailClose');
    expect(at).toBeGreaterThan(-1);
    // Inside the rail body, so it is drawn wherever the rail is drawn.
    expect(appSource.indexOf('className="rail-content"')).toBeLessThan(at);
    // Ahead of the branch that swaps the rail's contents by tab or mode, so none can hide it.
    for (const branch of [
      "{railMode === 'follow' ? (",
      "{railMode === 'details' ? (",
      "{railTab === 'warnings' ? (",
    ]) {
      const branchAt = appSource.indexOf(branch);
      expect(branchAt).toBeGreaterThan(-1);
      expect(at).toBeLessThan(branchAt);
    }
  });

  it('leaves no second close control of the same name behind', () => {
    // One × with one name: the panel head used to paint its own.
    const names = appSource.match(/aria-label="Close details"/g) ?? [];
    expect(names.length).toBe(0);
  });
});
