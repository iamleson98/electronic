// Regression tests for the 3D trace geometry builder.
//
// The critical bug: trace segment boxes were rotated with
//   makeRotationY(atan2(dy, dx))
// which mirrors every DIAGONAL segment about the board's X axis, because
// board (x, y) maps to world (x, z=+y) and three's makeRotationY(θ) sends
// local +X → (cos θ, 0, −sin θ). A segment running (0,0)→(10,10) therefore
// rendered its box along (10, 0) — the WRONG diagonal. Axis-aligned segments
// were unaffected (mirroring a horizontal/vertical line is itself), which is
// why it survived a casual glance but produced tangled 45° autorouted wiring.
//
// These tests assert the box's long axis actually lands on the real trace
// endpoints, not their mirrored image.

import { describe, it, expect } from 'vitest';
import { traceGeometries } from '../src/lib/pcb/board-geometry-3d';
import type { Trace, CopperLayer } from '../src/lib/pcb/types';

function mkTrace(start: { x: number; y: number }, end: { x: number; y: number }): Trace {
  return {
    id: 't1',
    net: 'N1',
    layer: 'top' as CopperLayer,
    width: 0.3,
    segments: [{ start: { ...start }, end: { ...end }, width: 0.3 }],
  };
}

/**
 * Extract every vertex of the FIRST returned geometry (the segment box —
 * the cylinder discs come after it). Returns `undefined` when no geometry
 * was produced for the segment.
 */
function boxVertices(trace: Trace): { x: number; y: number; z: number }[] | undefined {
  const geos = traceGeometries(trace, 0);
  const box = geos[0];
  if (!box) return undefined;
  const pos = box.getAttribute('position');
  const pts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) });
  }
  return pts;
}

describe('traceGeometries — diagonal orientation', () => {
  it('a NE diagonal segment (0,0)→(10,10) keeps its box on the real line', () => {
    const pts = boxVertices(mkTrace({ x: 0, y: 0 }, { x: 10, y: 10 }))!;
    expect(pts).toBeDefined();
    // The box's long axis endpoints must land at the TRUE endpoints. Find the
    // vertex with the largest X; its Z must also be large (≈ the "+y" corner
    // of the segment, i.e. z ≈ 10), NOT small (the mirrored (10, 0) corner).
    let maxX = -Infinity;
    let maxXz = 0;
    for (const p of pts) {
      if (p.x > maxX) { maxX = p.x; maxXz = p.z; }
    }
    // width/2 spread means the corner vertex isn't exactly at 10 — but its Z
    // must clearly track the diagonal (≈10), not the mirror (≈0).
    expect(maxXz).toBeGreaterThan(5);
  });

  it('a SE diagonal segment (0,10)→(10,0) keeps its box on the real line', () => {
    const pts = boxVertices(mkTrace({ x: 0, y: 10 }, { x: 10, y: 0 }))!;
    expect(pts).toBeDefined();
    let maxX = -Infinity;
    let maxXz = 0;
    for (const p of pts) {
      if (p.x > maxX) { maxX = p.x; maxXz = p.z; }
    }
    // Mirrors to (10, 10); the true corner is at (10, 0).
    expect(maxXz).toBeLessThan(5);
  });

  it('an axis-aligned horizontal segment is unaffected by the sign fix', () => {
    const pts = boxVertices(mkTrace({ x: 0, y: 5 }, { x: 10, y: 5 }))!;
    expect(pts).toBeDefined();
    const zs = pts.map((p) => p.z);
    // All vertices stay at the segment's board-Y (z=5), modulo width/2 = 0.15.
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    expect(maxZ - minZ).toBeCloseTo(0.3, 2);
    expect((minZ + maxZ) / 2).toBeCloseTo(5, 2);
  });

  it('an axis-aligned vertical segment is unaffected by the sign fix', () => {
    const pts = boxVertices(mkTrace({ x: 5, y: 0 }, { x: 5, y: 10 }))!;
    expect(pts).toBeDefined();
    const xs = pts.map((p) => p.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    expect(maxX - minX).toBeCloseTo(0.3, 2);
    expect((minX + maxX) / 2).toBeCloseTo(5, 2);
  });
});