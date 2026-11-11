import { describe, expect, it } from 'vitest';
import { nextIndex, placeCard, shouldOfferTour } from './tour';

describe('shouldOfferTour', () => {
  it('starts when ?tour=1 is present', () => {
    expect(shouldOfferTour('1', '?tour=1')).toBe('start');
    expect(shouldOfferTour(null, '?foo=2&tour=1')).toBe('start');
  });

  it('offers when never seen', () => {
    expect(shouldOfferTour(null, '')).toBe('offer');
  });

  it('does nothing when already seen', () => {
    expect(shouldOfferTour('1', '')).toBe('none');
    expect(shouldOfferTour('0', '?other=1')).toBe('none');
  });
});

describe('nextIndex', () => {
  it('steps forward and back', () => {
    expect(nextIndex(0, 1, 5)).toBe(1);
    expect(nextIndex(2, -1, 5)).toBe(1);
  });

  it('clamps at 0 going back', () => {
    expect(nextIndex(0, -1, 5)).toBe(0);
  });

  it('returns null past the end', () => {
    expect(nextIndex(4, 1, 5)).toBe(null);
  });
});

describe('placeCard', () => {
  const card = { width: 300, height: 120 };
  const viewport = { width: 1000, height: 800 };

  it('prefers below the target', () => {
    const target = { top: 100, left: 200, width: 120, height: 40 };
    expect(placeCard(target, card, viewport)).toEqual({
      top: 152,
      left: 200,
      placement: 'below',
    });
  });

  it('falls back to above when below does not fit', () => {
    const target = { top: 700, left: 200, width: 120, height: 60 };
    expect(placeCard(target, card, viewport).placement).toBe('above');
  });

  it('centers when target is null', () => {
    expect(placeCard(null, card, viewport)).toEqual({
      top: 340,
      left: 350,
      placement: 'center',
    });
  });

  it('centers when neither side fits', () => {
    const target = { top: 100, left: 200, width: 120, height: 600 };
    expect(placeCard(target, card, viewport).placement).toBe('center');
  });

  it('clamps inside the viewport', () => {
    const target = { top: 0, left: 900, width: 200, height: 40 };
    const placed = placeCard(target, card, { width: 500, height: 400 });
    expect(placed.left).toBe(188);
    expect(placed.top).toBeGreaterThanOrEqual(12);
  });
});
