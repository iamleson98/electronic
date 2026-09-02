// Wire 1:1 overlap prevention — the design-time guard requested for the
// "old way" straight-wire routing: wires may CROSS (hop arc) or TOUCH
// (junction), but a new wire must never run exactly ON TOP of an existing
// wire (collinear line-on-line overlap), because that is electrically
// redundant and visually confusing.
//
// All geometry is grid-space and mirrors the renderer's getWirePath exactly:
//   - waypoints (when present) are honored;
//   - aligned endpoints render as a direct line;
//   - everything else is the horizontal-first L-elbow.
//
// Pure module — no React, no store — so the store (commit), the draft
// preview (live feedback) and the tests all share one definition of
// "these two wires overlap 1:1".

import type { CircuitComponent, HierarchicalSheet, Vec2, Wire } from './types';
import { resolveEndpointGridPos } from './endpoint-position';

/** A detected 1:1 overlap between a candidate wire and an existing wire. */
export interface OverlapHit {
  /** The existing wire the candidate would lie on top of. */
  wireId: string;
  /** The overlapping run (grid coordinates). */
  from: Vec2;
  to: Vec2;
  /** Length of the overlapping run in grid units. */
  length: number;
}

const EPS = 1e-6;

/**
 * Grid polyline of a wire — the exact geometry the canvas renders:
 * start → waypoints (if any) → end, with the horizontal-first L-elbow
 * inserted when no waypoints exist and the endpoints are not aligned.
 * Returns null when an endpoint cannot be resolved (deleted component).
 */
export function wireGridPath(
  wire: Pick<Wire, 'from' | 'to' | 'waypoints'>,
  components: CircuitComponent[],
  sheets: HierarchicalSheet[],
): Vec2[] | null {
  const from = resolveEndpointGridPos(wire.from, components, sheets);
  const to = resolveEndpointGridPos(wire.to, components, sheets);
  if (!from || !to) return null;

  const pts: Vec2[] = [from];
  if (wire.waypoints && wire.waypoints.length > 0) {
    for (const wp of wire.waypoints) pts.push({ x: wp.x, y: wp.y });
  } else if (Math.abs(to.x - from.x) > EPS && Math.abs(to.y - from.y) > EPS) {
    // L-elbow, horizontal first — identical to getWirePath's default route.
    pts.push({ x: to.x, y: from.y });
  }
  pts.push(to);
  return dedupePoints(pts);
}

/** Drop consecutive duplicate points (zero-length segments). */
function dedupePoints(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) {
      out.push(p);
    }
  }
  return out;
}

/** An axis-aligned segment: horizontal (fixed y) or vertical (fixed x). */
interface AxisSegment {
  axis: 'h' | 'v';
  /** The constant coordinate: y for horizontal, x for vertical. */
  fixed: number;
  /** The varying interval, normalized (lo < hi). */
  lo: number;
  hi: number;
}

/**
 * Decompose a polyline into axis-aligned segments. Diagonal segments
 * (defensive: committed wires are orthogonal by construction) are split
 * with the same horizontal-first elbow orthogonalizePath uses.
 */
function axisSegments(path: Vec2[]): AxisSegment[] {
  const segs: AxisSegment[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) continue;
    if (Math.abs(dy) < EPS) {
      segs.push({ axis: 'h', fixed: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
    } else if (Math.abs(dx) < EPS) {
      segs.push({ axis: 'v', fixed: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
    } else {
      // Diagonal → horizontal first, then vertical (elbow at (b.x, a.y)).
      segs.push({ axis: 'h', fixed: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      segs.push({ axis: 'v', fixed: b.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
    }
  }
  return segs;
}

/** Default minimum overlap (grid units) that counts as a 1:1 overlap. */
export const MIN_OVERLAP_UNITS = 0.5;

/** Offsets (grid cells) tried for the detour candidates, nearest first. */
const DETOUR_OFFSETS = [2, -2, 4, -4];

/**
 * A wire routing plan: the corner-sparse waypoints the committed wire will
 * store ([] = the renderer's default direct / horizontal-first L route).
 */
export interface WireRoutePlan {
  waypoints: Vec2[];
  /** True when NO straight candidate avoids a 1:1 overlap — the wire will
   *  be rejected (red preview + toast). */
  overlap: boolean;
}

/**
 * Ordered straight-route candidates between two points. Every candidate is
 * orthogonal and corner-sparse (0–3 corners) — never a jigsaw path. The
 * FIRST candidate is always the renderer's default route ([] = direct line
 * or horizontal-first L-elbow), so an unobstructed wire looks exactly like
 * the classic "old way".
 *
 * Exported for example-wires.ts (batch normalization of hand-authored
 * example documents) so interactive commits and example normalization
 * share ONE candidate order.
 */
export function routeCandidates(start: Vec2, end: Vec2): Vec2[][] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const alignedX = Math.abs(dx) < 1e-3; // vertical wire
  const alignedY = Math.abs(dy) < 1e-3; // horizontal wire
  const cands: Vec2[][] = [];

  // 1. The default: direct line when aligned, horizontal-first L otherwise.
  cands.push([]);

  if (!alignedX && !alignedY) {
    // 2. Alternate elbow (vertical-first).
    cands.push([{ x: start.x, y: end.y }]);
    const midX = Math.round((start.x + end.x) / 2);
    const midY = Math.round((start.y + end.y) / 2);
    // 3. Z-route: horizontal runs on the start/end rows, vertical at midX.
    cands.push([{ x: midX, y: start.y }, { x: midX, y: end.y }]);
    // 4. Z-route: vertical runs on the start/end cols, horizontal at midY.
    cands.push([{ x: start.x, y: midY }, { x: end.x, y: midY }]);
  }

  // 5. Detour candidates: run the long leg a few cells off the line so it
  //    clears occupied rows/columns (still straight, still orthogonal).
  for (const off of DETOUR_OFFSETS) {
    if (alignedX) {
      cands.push([{ x: start.x + off, y: start.y }, { x: start.x + off, y: end.y }]);
    } else if (alignedY) {
      cands.push([{ x: start.x, y: start.y + off }, { x: end.x, y: start.y + off }]);
    } else {
      const midX = Math.round((start.x + end.x) / 2);
      const midY = Math.round((start.y + end.y) / 2);
      // Horizontal run at an offset row between the endpoints.
      cands.push([{ x: start.x, y: midY + off }, { x: end.x, y: midY + off }]);
      // Vertical run at an offset column between the endpoints.
      cands.push([{ x: midX + off, y: start.y }, { x: midX + off, y: end.y }]);
    }
  }
  return cands;
}

/**
 * Plan the route a new wire will take between `start` and `end`.
 *
 * With user-placed bends: the user's route is honored exactly (no fallback
 * detours) — an overlapping user route is flagged so the commit rejects it
 * and the preview draws it red; the user can then move a bend.
 *
 * Without user bends: the candidates from routeCandidates() are tried in
 * order and the FIRST one that does not 1:1-overlap any existing wire wins.
 * This keeps wires straight/horizontal like the old way while guaranteeing
 * they never run on top of each other. Only when every straight candidate
 * overlaps does the plan come back `overlap: true` (rejection).
 */
export function planWireRoute(
  start: Vec2,
  end: Vec2,
  wires: Wire[],
  components: CircuitComponent[],
  sheets: HierarchicalSheet[],
  userWaypoints: Vec2[] = [],
): WireRoutePlan {
  // User-routed: honor the bends exactly.
  if (userWaypoints.length > 0) {
    const path = dedupePoints([start, ...userWaypoints, end]);
    const hit = findWireOverlap(path, wires, components, sheets);
    return { waypoints: userWaypoints, overlap: hit != null };
  }

  for (const wps of routeCandidates(start, end)) {
    const path = dedupePoints([start, ...wps, end]);
    if (findWireOverlap(path, wires, components, sheets) == null) {
      return { waypoints: wps, overlap: false };
    }
  }
  // Every straight candidate overlaps — reject (red preview, toast).
  return { waypoints: [], overlap: true };
}

/**
 * Find a 1:1 line-on-line overlap between the candidate polyline and the
 * rendered geometry of the existing wires.
 *
 * Allowed (NOT an overlap):
 *   - perpendicular crossings (different axes);
 *   - endpoint touches — two collinear wires meeting at a single point
 *     (junction) or sharing up to MIN_OVERLAP_UNITS of run.
 *   - parallel runs on different rows/columns.
 *
 * Rejected: a collinear run shared beyond MIN_OVERLAP_UNITS — the new wire
 * would be drawn exactly on top of an existing wire.
 */
export function findWireOverlap(
  candidatePath: Vec2[],
  wires: Wire[],
  components: CircuitComponent[],
  sheets: HierarchicalSheet[],
  opts: { minOverlap?: number } = {},
): OverlapHit | null {
  const minOverlap = opts.minOverlap ?? MIN_OVERLAP_UNITS;
  if (candidatePath.length < 2) return null;
  const candidate = axisSegments(candidatePath);
  if (candidate.length === 0) return null;

  for (const wire of wires) {
    const existingPath = wireGridPath(wire, components, sheets);
    if (!existingPath) continue;
    const existing = axisSegments(existingPath);
    for (const c of candidate) {
      for (const e of existing) {
        if (c.axis !== e.axis) continue;
        if (Math.abs(c.fixed - e.fixed) > 1e-3) continue;
        const lo = Math.max(c.lo, e.lo);
        const hi = Math.min(c.hi, e.hi);
        const length = hi - lo;
        if (length > minOverlap) {
          const from: Vec2 = c.axis === 'h' ? { x: lo, y: c.fixed } : { x: c.fixed, y: lo };
          const to: Vec2 = c.axis === 'h' ? { x: hi, y: c.fixed } : { x: c.fixed, y: hi };
          return { wireId: wire.id, from, to, length };
        }
      }
    }
  }
  return null;
}
