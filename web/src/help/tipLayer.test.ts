import { describe, expect, it } from 'vitest';
import { placeTip, tipTextFor } from './tipLayer';

type FakeEl = {
  attrs: Record<string, string>;
  parent: FakeEl | null;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  closest(selector: string): FakeEl | null;
  parentElement: FakeEl | null;
};

function makeEl(attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl {
  const el: FakeEl = {
    attrs,
    parent,
    getAttribute(name: string) {
      return name in el.attrs ? el.attrs[name] : null;
    },
    matches(selector: string) {
      if (selector === '.tl-bubble') return el.attrs.class === 'tl-bubble';
      if (selector === '.tour-card') return el.attrs.class === 'tour-card';
      if (selector === '.tour-offer') return el.attrs.class === 'tour-offer';
      if (selector === '#save') return el.attrs.id === 'save';
      return false;
    },
    closest(selector: string) {
      let node: FakeEl | null = el;
      while (node) {
        if (node.matches(selector)) return node;
        node = node.parent;
      }
      return null;
    },
    parentElement: parent,
  };
  return el;
}

describe('tipTextFor', () => {
  it('prefers data-tip over title', () => {
    const el = makeEl({ 'data-tip': 'Data tip', title: 'Title tip' });
    const res = tipTextFor(el as unknown as Element, {});
    expect(res?.text).toBe('Data tip');
  });

  it('prefers a fresh title over one moved earlier (React may re-set it)', () => {
    const el = makeEl({ 'data-tl-title': 'Moved', title: 'Title tip' });
    const res = tipTextFor(el as unknown as Element, {});
    expect(res?.text).toBe('Title tip');
  });

  it('walks up to an ancestor with a tip', () => {
    const parent = makeEl({ title: 'Parent tip' });
    const child = makeEl({}, parent);
    const res = tipTextFor(child as unknown as Element, {});
    expect(res?.text).toBe('Parent tip');
    expect(res?.target).toBe(parent as unknown as HTMLElement);
  });

  it('matches an extra selector', () => {
    const el = makeEl({ id: 'save' });
    const res = tipTextFor(el as unknown as Element, { '#save': 'Save it' });
    expect(res?.text).toBe('Save it');
  });

  it('skips elements inside .tl-bubble', () => {
    const bubble = makeEl({ class: 'tl-bubble' });
    const child = makeEl({ title: 'Inside' }, bubble);
    expect(tipTextFor(child as unknown as Element, {})).toBeNull();
  });

  it('returns null for empty text', () => {
    const el = makeEl({ title: '   ' });
    expect(tipTextFor(el as unknown as Element, {})).toBeNull();
  });

  it('returns null for null input', () => {
    expect(tipTextFor(null, {})).toBeNull();
  });
});

describe('placeTip', () => {
  const viewport = { width: 1000, height: 800 };
  const bubble = { width: 200, height: 60 };

  it('places below for targets in the top 40%', () => {
    const res = placeTip({ top: 100, left: 400, width: 100, height: 30 }, bubble, viewport);
    expect(res.side).toBe('bottom');
    expect(res.top).toBe(138);
  });

  it('places above for targets lower down', () => {
    const res = placeTip({ top: 600, left: 400, width: 100, height: 30 }, bubble, viewport);
    expect(res.side).toBe('top');
    expect(res.top).toBe(532);
  });

  it('flips when below does not fit', () => {
    const res = placeTip({ top: 100, left: 400, width: 100, height: 260 }, bubble, { width: 1000, height: 400 });
    expect(res.side).toBe('top');
  });

  it('clamps inside the viewport', () => {
    const res = placeTip({ top: 600, left: 0, width: 20, height: 20 }, bubble, viewport);
    expect(res.left).toBe(8);
    const res2 = placeTip({ top: 600, left: 980, width: 20, height: 20 }, bubble, viewport);
    expect(res2.left).toBe(792);
  });
});
