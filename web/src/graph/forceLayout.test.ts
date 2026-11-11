import { describe, expect, it } from 'vitest';
import { forceLayout } from './forceLayout';

const nodes = Array.from({ length: 12 }, (_, i) => ({
  id: `n${i}`,
  width: 200,
  height: 60,
}));
const edges = nodes.slice(1).map((node, i) => ({ source: `n${i}`, target: node.id }));

describe('forceLayout', () => {
  it('gives the same picture every time', () => {
    const a = forceLayout(nodes, edges);
    const b = forceLayout(nodes, edges);
    for (const node of nodes) {
      expect(a.get(node.id)).toEqual(b.get(node.id));
    }
  });

  it('keeps every box clear of its neighbours', () => {
    const points = forceLayout(nodes, edges);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = points.get(nodes[i].id)!;
        const b = points.get(nodes[j].id)!;
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        // Overlap only counts when both axes are inside the boxes.
        expect(dx > 120 || dy > 40).toBe(true);
      }
    }
  });

  it('starts at a positive offset so a fit can place it anywhere', () => {
    const points = forceLayout(nodes, edges);
    for (const point of points.values()) {
      expect(point.x).toBeGreaterThanOrEqual(39);
      expect(point.y).toBeGreaterThanOrEqual(39);
    }
  });

  it('handles a single node and no edges', () => {
    // Nothing to push against: the seeded position is returned unchanged, and it is not the origin.
    const points = forceLayout([{ id: 'solo', width: 200, height: 60 }], []);
    expect(points.get('solo')).toEqual({ x: 26, y: 0 });
  });
});
