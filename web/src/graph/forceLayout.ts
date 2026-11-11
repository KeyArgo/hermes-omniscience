/**
 * A force layout for the link view: the same chat as a floating web of steps, in the shape a
 * note-graph has, instead of the left-to-right timeline.
 *
 * Deterministic on purpose — no Math.random. Two renders of the same chat must produce the same
 * picture, or the reader loses the place they were looking at every time the panel resizes.
 */

export interface ForceNode {
  id: string;
  width: number;
  height: number;
}

export interface ForceEdge {
  source: string;
  target: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface ForceOptions {
  iterations?: number;
  /** How hard links pull compared with repulsion. */
  linkStrength?: number;
  gravity?: number;
}

/** Circle placement on a golden-angle spiral: spread out, and identical every run. */
function seed(nodes: ForceNode[]): Map<string, Point> {
  const out = new Map<string, Point>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((node, index) => {
    const radius = 26 * Math.sqrt(index + 1);
    out.set(node.id, {
      x: Math.cos(index * golden) * radius,
      y: Math.sin(index * golden) * radius,
    });
  });
  return out;
}

export function forceLayout(
  nodes: ForceNode[],
  edges: ForceEdge[],
  options: ForceOptions = {},
): Map<string, Point> {
  const iterations = options.iterations ?? 260;
  const linkStrength = options.linkStrength ?? 0.06;
  const gravity = options.gravity ?? 0.012;

  const points = seed(nodes);
  if (nodes.length < 2) return points;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const centre = { x: 0, y: 0 };

  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    // Repulsion: every pair pushes apart, stronger when they overlap.
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      const pa = points.get(a.id) as Point;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        const pb = points.get(b.id) as Point;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = 0.01 * (i - j);
          dy = 0.01;
          dist = Math.hypot(dx, dy);
        }
        const minDist = (a.width + b.width) / 2 + 24;
        const push = (minDist * minDist) / dist;
        const force = (push * cooling) / dist;
        pa.x += dx * force;
        pa.y += dy * force;
        pb.x -= dx * force;
        pb.y -= dy * force;
      }
    }
    // Links: pull the two ends towards a comfortable distance.
    for (const link of links) {
      const pa = points.get(link.source) as Point;
      const pb = points.get(link.target) as Point;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const pull = (dist - 190) * linkStrength * cooling;
      const ux = (dx / dist) * pull;
      const uy = (dy / dist) * pull;
      pa.x += ux;
      pa.y += uy;
      pb.x -= ux;
      pb.y -= uy;
    }
    // Gravity towards the middle, so nothing drifts away for ever.
    for (const node of nodes) {
      const point = points.get(node.id) as Point;
      point.x -= (point.x - centre.x) * gravity;
      point.y -= (point.y - centre.y) * gravity;
    }
  }

  // Normalise so the caller can fit the result into any pane.
  let minX = Infinity;
  let minY = Infinity;
  for (const point of points.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
  }
  for (const [id, point] of points) {
    points.set(id, { x: point.x - minX + 40, y: point.y - minY + 40 });
  }
  return points;
}
