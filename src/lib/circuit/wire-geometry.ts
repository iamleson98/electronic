// Wire path geometry — pure polyline helpers shared by the store, the smart
// router, the wire-drag handler and the renderer.
//
// orthogonalizePath used to live only in canvas-wire-utils (component layer);
// the store needs it too (to clean up user-drawn wire paths at commit time),
// so the canonical implementation moved here to keep lib → component imports
// one-directional. canvas-wire-utils re-exports it for compatibility.

import type { Vec2 } from './types';

/**
 * Insert an elbow point for every diagonal segment so the path becomes fully
 * orthogonal (90° corners only). Returns ONLY the intermediate points
 * (start and end are excluded), i.e. the same shape as `Wire.waypoints`.
 */
export function orthogonalizePath(fromPos: Vec2, toPos: Vec2, wps: Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  const full: Vec2[] = [fromPos, ...wps, toPos];
  for (let i = 0; i < full.length - 1; i++) {
    const a = full[i];
    const b = full[i + 1];
    result.push({ ...a });
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) {
      // Elbow matching the default L-route orientation (horizontal first).
      result.push({ x: b.x, y: a.y });
    }
  }
  result.push({ ...toPos });
  return result.slice(1, -1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Current-flow dots — the animation MUST travel along the rendered wire line.
// Extracted from the canvas renderer so the invariant "every dot lies on the
// wire polyline, around corners as well as straight runs" is testable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evenly spaced positions along a polyline for the animated current-flow
 * dots. `dotOffset` is the current travel offset (pixels along the path,
 * already including speed/direction); dots wrap around the total length.
 *
 * The dots walk the polyline SEGMENT BY SEGMENT — an L-shaped wire's dots
 * turn the corner; they never cut the diagonal.
 */
export function computeFlowDotPositions(
  path: Vec2[],
  dotOffset: number,
  dotSpacing = 24,
): Vec2[] {
  if (path.length < 2) return [];

  const segLens: number[] = [];
  let totalLen = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segLens.push(len);
    totalLen += len;
  }
  if (totalLen <= 0) return [];

  const numDots = Math.max(2, Math.floor(totalLen / dotSpacing));
  const evenSpacing = totalLen / numDots;
  const offset = ((dotOffset % totalLen) + totalLen) % totalLen;

  const dots: Vec2[] = [];
  for (let n = 0; n < numDots; n++) {
    let distAlong = (n * evenSpacing + offset);
    distAlong = ((distAlong % totalLen) + totalLen) % totalLen;
    let acc = 0;
    for (let i = 0; i < segLens.length; i++) {
      if (acc + segLens[i] >= distAlong) {
        const t = segLens[i] > 0 ? (distAlong - acc) / segLens[i] : 0;
        const a = path[i];
        const b = path[i + 1];
        dots.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
        });
        break;
      }
      acc += segLens[i];
    }
  }
  return dots;
}
