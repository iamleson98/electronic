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
