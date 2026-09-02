// Example-circuit wire normalization — brings hand-authored example documents
// up to the SAME orthogonal wire style the interactive editor enforces since
// the "straight wires" overhaul (see wire-overlap.ts):
//
//   1. ORTHOGONAL — every rendered segment is horizontal or vertical. Any
//      stored diagonal segment is split with the horizontal-first elbow
//      (identical to getWirePath / orthogonalizePath semantics).
//   2. CORNER-SPARSE — no duplicate or collinear interior waypoints; wires
//      store only real corners. Sparsification runs to a fixpoint because a
//      single pass can leave earlier points collinear after later removals.
//   3. NO DIFFERENT-NET 1:1 OVERLAPS — no wire runs line-on-line on top of a
//      DIFFERENT net's wire beyond MIN_OVERLAP_UNITS. Same-net runs are LEGAL
//      (that is what a ground/VCC bus rail IS — several wires converging on
//      one drawn line; the engine's netlist is endpoint-based, so geometry
//      never affects connectivity). Violating wires are re-routed through
//      the SAME ordered straight candidates the editor uses (L → alternate
//      elbow → Z → detours), extended with wider detours for dense
//      documents; stubborn cases trigger a bounded rip-up-and-retry (move a
//      blocking wire first, then retry). When nothing works the
//      orthogonalized author route is kept (still orthogonal).
//
// Endpoints (from/to terminal refs) are NEVER touched — connectivity and the
// simulation netlist are bit-identical before/after (see buildNodeMap: nets
// derive from terminal pairs + power/net labels, not from wire geometry).
//
// Pure module: no React, no store. Runs once per document at module load
// (examples.ts); deterministic and re-runnable.

import type { CircuitDocument, CircuitComponent, HierarchicalSheet, Vec2, Wire } from './types';
import { resolveEndpointGridPos } from './endpoint-position';
import { routeCandidates } from './wire-overlap';
import { buildNodeMap } from './engine';
import { getPlugin } from './registry';
import type { ComponentPlugin } from './types';

const EPS = 1e-6;

/** Max refinement passes (each retries only still-overlapping wires). */
const MAX_PASSES = 8;

/** Extended detour offsets for dense example documents (grid cells). */
const EXTENDED_OFFSETS = [3, -3, 6, -6, 8, -8, 10, -10, 12, -12];

/** Same threshold the editor's overlap guard uses (grid units). */
const MIN_OVERLAP_UNITS = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers (grid space)
// ─────────────────────────────────────────────────────────────────────────────

function isDiagonal(a: Vec2, b: Vec2): boolean {
  return Math.abs(b.x - a.x) > EPS && Math.abs(b.y - a.y) > EPS;
}

/** Orthogonalize a polyline: diagonal segments become horizontal-first then
 *  vertical (elbow at (b.x, a.y)) — the renderer's default L semantics. */
function orthogonalizePath(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    if (isDiagonal(a, b)) out.push({ x: b.x, y: a.y });
    out.push(b);
  }
  return out;
}

/** Drop consecutive duplicate points. */
function dedupePath(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) out.push(p);
  }
  return out;
}

/** Remove interior points collinear with their neighbors (single pass). */
function sparseOnce(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0 || i === pts.length - 1) { out.push(p); continue; }
    const a = out[out.length - 1];
    const b = pts[i + 1];
    const collinear =
      (Math.abs(a.x - p.x) < EPS && Math.abs(p.x - b.x) < EPS) ||
      (Math.abs(a.y - p.y) < EPS && Math.abs(p.y - b.y) < EPS);
    if (!collinear) out.push(p);
  }
  return out;
}

/** Sparsify to a fixpoint (a removal can leave earlier points collinear). */
function sparsePath(pts: Vec2[]): Vec2[] {
  let cur = dedupePath(pts);
  for (let i = 0; i < pts.length + 2; i++) {
    const next = sparseOnce(cur);
    if (next.length === cur.length) return next;
    cur = next;
  }
  return cur;
}

/** The default (waypoint-less) rendered route: direct line when aligned,
 *  horizontal-first L otherwise. */
function defaultPath(from: Vec2, to: Vec2): Vec2[] {
  if (Math.abs(to.x - from.x) <= EPS || Math.abs(to.y - from.y) <= EPS) return [from, to];
  return [from, { x: to.x, y: from.y }, to];
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlap math — EXACT parity with wire-overlap.ts findWireOverlap semantics,
// but on precomputed segment lists (cached) so batch normalization stays fast.
// ─────────────────────────────────────────────────────────────────────────────

interface AxisSeg { axis: 'h' | 'v'; fixed: number; lo: number; hi: number; }

function axisSegments(path: Vec2[]): AxisSeg[] {
  const segs: AxisSeg[] = [];
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
      // Defensive: diagonal → horizontal-first elbow (same as wire-overlap).
      segs.push({ axis: 'h', fixed: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      segs.push({ axis: 'v', fixed: b.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
    }
  }
  return segs;
}

/** Longest 1:1 collinear run shared by two segment lists (0 = none). */
function sharedRun(a: AxisSeg[], b: AxisSeg[]): number {
  let best = 0;
  for (const c of a) {
    for (const e of b) {
      if (c.axis !== e.axis) continue;
      if (Math.abs(c.fixed - e.fixed) > 1e-3) continue;
      const lo = Math.max(c.lo, e.lo);
      const hi = Math.min(c.hi, e.hi);
      const len = hi - lo;
      if (len > best) best = len;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Net computation — the engine's own buildNodeMap, so same-net detection is
// EXACTLY the netlist's notion of a net (terminal pairs + power/net labels).
// ─────────────────────────────────────────────────────────────────────────────

function computeWireNets(components: CircuitComponent[], wires: Wire[]): number[] {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of components) {
    if (!plugins.has(c.type)) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
  }
  try {
    const map = buildNodeMap(components, wires, plugins);
    const tn = (map as { terminalNode: Map<string, number> }).terminalNode;
    return wires.map((w) => {
      const n = tn.get(`${w.from.componentId}:${w.from.terminalId}`);
      return n === undefined ? -1 : n;
    });
  } catch {
    // Netlist unavailable (unknown component types, etc.) — treat every wire
    // as its own net: overlap avoidance stays maximally strict.
    return wires.map((_, i) => -1 - i);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate routes — the editor's ordered set first (parity), then extended
// detours for dense documents. Every candidate is orthogonal + corner-sparse.
// ─────────────────────────────────────────────────────────────────────────────

function richCandidates(start: Vec2, end: Vec2): Vec2[][] {
  const cands: Vec2[][] = [...routeCandidates(start, end)];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const alignedX = Math.abs(dx) < 1e-3;
  const alignedY = Math.abs(dy) < 1e-3;

  for (const off of EXTENDED_OFFSETS) {
    if (alignedX) {
      cands.push([{ x: start.x + off, y: start.y }, { x: start.x + off, y: end.y }]);
    } else if (alignedY) {
      cands.push([{ x: start.x, y: start.y + off }, { x: end.x, y: start.y + off }]);
    } else {
      const midX = Math.round((start.x + end.x) / 2);
      const midY = Math.round((start.y + end.y) / 2);
      cands.push([{ x: start.x, y: midY + off }, { x: end.x, y: midY + off }]);
      cands.push([{ x: midX + off, y: start.y }, { x: midX + off, y: end.y }]);
    }
  }
  return cands;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component body avoidance (preference, not a hard rule — parity with the
// interactive editor, which also allows body crossings when unavoidable)
// ─────────────────────────────────────────────────────────────────────────────

interface BodyRect { x0: number; y0: number; x1: number; y1: number; }

function bodyRects(components: CircuitComponent[]): BodyRect[] {
  const rects: BodyRect[] = [];
  for (const c of components) {
    const plugin = getPlugin(c.type);
    if (!plugin) continue;
    // The bounding box footprint is rotation-invariant: rotateTerminal maps
    // terminals within the SAME [0..width]×[0..height] frame around its center.
    rects.push({
      x0: c.position.x,
      y0: c.position.y,
      x1: c.position.x + plugin.boundingBox.width,
      y1: c.position.y + plugin.boundingBox.height,
    });
  }
  return rects;
}

function segIntersectsRect(a: Vec2, b: Vec2, r: BodyRect): boolean {
  // Both segment and rect are axis-aligned, so per-axis bounding overlap is
  // an exact intersection test (edge-touching counts as outside).
  if (Math.max(a.x, b.x) <= r.x0 || Math.min(a.x, b.x) >= r.x1) return false;
  if (Math.max(a.y, b.y) <= r.y0 || Math.min(a.y, b.y) >= r.y1) return false;
  return true;
}

function pathCrossesBody(path: Vec2[], rects: BodyRect[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    for (const r of rects) {
      if (segIntersectsRect(path[i], path[i + 1], r)) return true;
    }
  }
  return false;
}

/** Document bounding box (components + margin) — detours stay near the circuit. */
function docBounds(components: CircuitComponent[]): BodyRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of components) {
    const plugin = getPlugin(c.type);
    const w = plugin?.boundingBox.width ?? 2;
    const h = plugin?.boundingBox.height ?? 2;
    x0 = Math.min(x0, c.position.x);
    y0 = Math.min(y0, c.position.y);
    x1 = Math.max(x1, c.position.x + w);
    y1 = Math.max(y1, c.position.y + h);
  }
  const M = 6;
  return { x0: x0 - M, y0: y0 - M, x1: x1 + M, y1: y1 + M };
}

function withinBounds(path: Vec2[], b: BodyRect): boolean {
  return path.every((p) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize every wire in an example document to the editor's orthogonal,
 * corner-sparse, different-net-overlap-free straight-wire style. Returns a
 * NEW document (input untouched); wire endpoints are preserved verbatim.
 */
export function normalizeExampleWires(doc: CircuitDocument): CircuitDocument {
  const components = doc.components ?? [];
  const sheets: HierarchicalSheet[] = doc.sheets ?? [];
  if (!doc.wires || doc.wires.length === 0) return doc;

  const rects = bodyRects(components);
  const bounds = docBounds(components);
  const nets = computeWireNets(components, doc.wires);
  const newWires: Wire[] = doc.wires.map((w) => ({ ...w }));

  // Phase A — orthogonalize + sparsify every wire's authored route.
  // (null = unresolvable endpoint → wire is left completely untouched.)
  const paths: Array<Vec2[] | null> = newWires.map((w) => {
    const from = resolveEndpointGridPos(w.from, components, sheets);
    const to = resolveEndpointGridPos(w.to, components, sheets);
    if (!from || !to) return null;
    if (w.waypoints && w.waypoints.length > 0) {
      return sparsePath(orthogonalizePath([from, ...w.waypoints, to]));
    }
    return defaultPath(from, to);
  });

  /** Cached segment lists for the CURRENT paths (invalidated on change). */
  const segCache: Array<AxisSeg[] | null> = new Array(newWires.length).fill(null);
  const segsOf = (i: number): AxisSeg[] | null => {
    if (segCache[i] === null) {
      const p = paths[i];
      segCache[i] = p ? axisSegments(p) : null;
    }
    return segCache[i];
  };
  const setPath = (i: number, p: Vec2[]): void => {
    paths[i] = p;
    segCache[i] = null;
  };

  /** Longest different-net 1:1 overlap of wire i's CURRENT path (0 = clean). */
  const overlapOf = (i: number): number => {
    const own = segsOf(i);
    if (!own) return 0;
    let worst = 0;
    for (let j = 0; j < newWires.length; j++) {
      if (j === i) continue;
      if (nets[j] === nets[i]) continue; // same net: bus-rail stacking is legal
      const other = segsOf(j);
      if (!other) continue;
      worst = Math.max(worst, sharedRun(own, other));
    }
    return worst;
  };

  /** Does `cand` stack on any DIFFERENT-net wire (beyond MIN_OVERLAP_UNITS)? */
  const candOverlaps = (cand: Vec2[], i: number): boolean => {
    const own = axisSegments(cand);
    for (let j = 0; j < newWires.length; j++) {
      if (j === i) continue;
      if (nets[j] === nets[i]) continue;
      const other = segsOf(j);
      if (!other) continue;
      if (sharedRun(own, other) > MIN_OVERLAP_UNITS) return true;
    }
    return false;
  };

  /** Best non-overlapping candidate route for wire i (body-clean preferred). */
  const reroute = (i: number): Vec2[] | null => {
    const from = resolveEndpointGridPos(newWires[i].from, components, sheets);
    const to = resolveEndpointGridPos(newWires[i].to, components, sheets);
    if (!from || !to) return null;

    let best: Vec2[] | null = null;
    for (const wps of richCandidates(from, to)) {
      const cand = sparsePath(orthogonalizePath([from, ...wps, to]));
      if (!withinBounds(cand, bounds)) continue;
      if (candOverlaps(cand, i)) continue;
      if (!pathCrossesBody(cand, rects)) return cand;
      if (best === null) best = cand;
    }
    return best;
  };

  // Phase B — document order: re-route wires whose authored route stacks on a
  // different net.
  for (let i = 0; i < newWires.length; i++) {
    if (!paths[i] || overlapOf(i) <= MIN_OVERLAP_UNITS) continue;
    const next = reroute(i);
    if (next) setPath(i, next);
  }

  // Phase C — refinement with bounded rip-up-and-retry:
  //   * retry every still-overlapping wire;
  //   * when a wire has no clean route, try moving ONE of its different-net
  //     blockers first (longest shared run first), then retry the wire.
  // Every accepted move has zero different-net overlaps, so the total
  // overlap count decreases monotonically → converges.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (let i = 0; i < newWires.length; i++) {
      if (!paths[i] || overlapOf(i) <= MIN_OVERLAP_UNITS) continue;

      let next = reroute(i);
      if (!next) {
        // Rip-up: blockers of wire i, longest shared run first.
        const own = segsOf(i);
        if (own) {
          const blockers: Array<{ j: number; run: number }> = [];
          for (let j = 0; j < newWires.length; j++) {
            if (j === i || nets[j] === nets[i]) continue;
            const other = segsOf(j);
            if (!other) continue;
            const run = sharedRun(own, other);
            if (run > MIN_OVERLAP_UNITS) blockers.push({ j, run });
          }
          blockers.sort((a, b) => b.run - a.run);
          for (const b of blockers) {
            const blockerNext = reroute(b.j);
            if (blockerNext && blockerNext !== paths[b.j]) {
              setPath(b.j, blockerNext);
              changed = true;
              next = reroute(i);
              if (next) break;
            }
          }
        }
      }
      if (next && next !== paths[i]) {
        setPath(i, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Phase D — materialize: interior corners become the wire's waypoints
  // ([] → no waypoints → renderer's default direct / horizontal-first L,
  // which renders identically to an explicit L).
  for (let i = 0; i < newWires.length; i++) {
    const p = paths[i];
    if (!p) continue;
    const interior = p.slice(1, -1);
    const next: Wire = { ...newWires[i] };
    if (interior.length > 0) {
      next.waypoints = interior.map((pt) => ({ x: pt.x, y: pt.y }));
    } else {
      delete next.waypoints;
    }
    newWires[i] = next;
  }

  return { ...doc, wires: newWires };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit helper — shared by tests and the standalone audit script. Counts
// DIFFERENT-net 1:1 overlap pairs (same-net runs are legal bus stacking).
// ─────────────────────────────────────────────────────────────────────────────

export interface OverlapPair {
  wireA: string;
  wireB: string;
  length: number;
}

/** Different-net 1:1 overlap pairs in a document (empty = clean). */
export function differentNetOverlaps(doc: CircuitDocument): OverlapPair[] {
  const components = doc.components ?? [];
  const sheets: HierarchicalSheet[] = doc.sheets ?? [];
  const wires = doc.wires ?? [];
  if (wires.length === 0) return [];
  const nets = computeWireNets(components, wires);
  const segs = wires.map((w) => {
    const from = resolveEndpointGridPos(w.from, components, sheets);
    const to = resolveEndpointGridPos(w.to, components, sheets);
    if (!from || !to) return null;
    const p =
      w.waypoints && w.waypoints.length > 0
        ? [from, ...w.waypoints, to]
        : defaultPath(from, to);
    return axisSegments(dedupePath(p));
  });
  const out: OverlapPair[] = [];
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      if (nets[i] === nets[j]) continue;
      const a = segs[i];
      const b = segs[j];
      if (!a || !b) continue;
      const run = sharedRun(a, b);
      if (run > MIN_OVERLAP_UNITS) out.push({ wireA: wires[i].id, wireB: wires[j].id, length: run });
    }
  }
  return out;
}
