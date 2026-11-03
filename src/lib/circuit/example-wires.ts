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
import { routeCandidates, makeRouteContext, bestReadableRoute } from './wire-overlap';
import { evaluateRoute, updateContextWire } from './schematic-router';
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
export function normalizeExampleWires(input: CircuitDocument): CircuitDocument {
  const doc = separateCoincidentPins(input);
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

  return { ...doc, wires: readabilityPass(newWires, components, sheets) };
}

/**
 * Layout fix-ups for hand-authored example documents: `spread` scales every
 * component position around the origin (parts placed on top of each other
 * get room; the arrangement and the topology are unchanged) and `moves`
 * relocates individual parts. Wires whose endpoints moved lose their
 * hand-drawn bends — normalizeExampleWires routes them fresh.
 */
export function relayoutExample(
  doc: CircuitDocument,
  opts: { spread?: number; moves?: Record<string, Vec2> },
): CircuitDocument {
  const k = opts.spread ?? 1;
  const moved = new Set<string>();
  const components = doc.components.map((c) => {
    let position = k === 1 ? c.position : { x: Math.round(c.position.x * k), y: Math.round(c.position.y * k) };
    if (opts.moves?.[c.id]) position = opts.moves[c.id];
    if (position.x !== c.position.x || position.y !== c.position.y) moved.add(c.id);
    return { ...c, position };
  });
  const wires = doc.wires.map((w) => {
    if (!moved.has(w.from.componentId) && !moved.has(w.to.componentId)) return w;
    const next = { ...w };
    delete next.waypoints;
    return next;
  });
  return { ...doc, components, wires };
}

/**
 * Pins of DIFFERENT nets on the same grid point draw as a connection that
 * does not exist (a source's + pin on a ground pin reads as a short). Move
 * the part with fewer pins to the nearest spot where none of its pins land
 * on another part's pin and its body overlaps no other body; its wires lose
 * their old routes and are re-routed by the normal pipeline.
 */
export function separateCoincidentPins(doc: CircuitDocument): CircuitDocument {
  if (!doc.wires || doc.wires.length === 0) return doc;
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of doc.components) { const p = getPlugin(c.type); if (p) plugins.set(c.type, p); }
  const nm = buildNodeMap(doc.components, doc.wires, plugins);
  const sheets = doc.sheets ?? [];
  let components = doc.components.map((c) => ({ ...c }));
  const pinsOf = (c: CircuitComponent) => (plugins.get(c.type)?.terminals ?? []).map((t) => ({
    key: `${c.id}:${t.id}`,
    p: resolveEndpointGridPos({ componentId: c.id, terminalId: t.id }, components, sheets),
  }));
  const net = (key: string) => nm.terminalNode.get(key);
  const moved = new Set<string>();
  for (let guard = 0; guard < 20; guard++) {
    // first remaining conflict
    const at = new Map<string, { comp: CircuitComponent; key: string }[]>();
    for (const c of components) {
      for (const { key, p } of pinsOf(c)) {
        if (!p) continue;
        const k = `${p.x},${p.y}`;
        const list = at.get(k) ?? [];
        list.push({ comp: c, key });
        at.set(k, list);
      }
    }
    let pair: [CircuitComponent, CircuitComponent] | null = null;
    for (const list of at.values()) {
      for (let i = 0; i < list.length && !pair; i++) {
        for (let j = i + 1; j < list.length && !pair; j++) {
          if (list[i].comp.id !== list[j].comp.id && net(list[i].key) !== net(list[j].key)) pair = [list[i].comp, list[j].comp];
        }
      }
      if (pair) break;
    }
    if (!pair) break;
    const pinCount = (c: CircuitComponent) => plugins.get(c.type)?.terminals.length ?? 0;
    const mover = pinCount(pair[0]) <= pinCount(pair[1]) ? pair[0] : pair[1];
    const others = components.filter((c) => c.id !== mover.id);
    const otherPins = new Set(others.flatMap((c) => pinsOf(c)).filter((x) => x.p).map((x) => `${x.p!.x},${x.p!.y}`));
    const rects = bodyRects(others);
    const pl = plugins.get(mover.type)!;
    const fits = (pos: Vec2) => {
      const trial = { ...mover, position: pos };
      const r = { x0: pos.x, y0: pos.y, x1: pos.x + pl.boundingBox.width, y1: pos.y + pl.boundingBox.height };
      if (rects.some((o) => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0)) return false;
      return pl.terminals.every((t) => {
        const p = resolveEndpointGridPos({ componentId: mover.id, terminalId: t.id }, [...others, trial], sheets);
        return !p || !otherPins.has(`${p.x},${p.y}`);
      });
    };
    let best: Vec2 | null = null;
    for (let d = 1; d <= 6 && !best; d++) {
      for (const [dx, dy] of [[0, d], [0, -d], [d, 0], [-d, 0], [d, d], [-d, d], [d, -d], [-d, -d]]) {
        const pos = { x: mover.position.x + dx, y: mover.position.y + dy };
        if (fits(pos)) { best = pos; break; }
      }
    }
    if (!best) break;
    components = components.map((c) => (c.id === mover.id ? { ...c, position: best! } : c));
    moved.add(mover.id);
  }
  if (moved.size === 0) return doc;
  const wires = doc.wires.map((w) => {
    if (!moved.has(w.from.componentId) && !moved.has(w.to.componentId)) return w;
    const next = { ...w };
    delete next.waypoints;
    return next;
  });
  return { ...doc, components, wires };
}

/**
 * Local ground symbols: every wire that runs from a part's pin to a shared
 * ground symbol is replaced by a ground symbol placed right at that pin —
 * the way real schematics draw ground. One ground symbol per circuit forces
 * a ground bus that crosses half the drawing; local symbols remove those
 * crossings without changing connectivity (all ground symbols are node 0).
 * A pin keeps its bus wire when there is no free spot next to it.
 */
export function localizeGrounds(doc: CircuitDocument): CircuitDocument {
  const byId = new Map(doc.components.map((c) => [c.id, c]));
  const isGround = (id: string) => byId.get(id)?.type === 'ground';
  const gplug = getPlugin('ground');
  if (!gplug) return doc;
  const rects = bodyRects(doc.components.filter((c) => c.type !== 'ground'));
  const pins: Vec2[] = [];
  for (const c of doc.components) {
    if (c.type === 'ground') continue;
    const pl = getPlugin(c.type);
    if (!pl) continue;
    for (const t of pl.terminals) {
      const p = resolveEndpointGridPos({ componentId: c.id, terminalId: t.id }, doc.components, doc.sheets ?? []);
      if (p) pins.push(p);
    }
  }
  const taken: BodyRect[] = [];
  const free = (box: BodyRect, lead: [Vec2, Vec2], pin: Vec2) => {
    const hit = (r: BodyRect) => box.x0 < r.x1 + 1 && box.x1 > r.x0 - 1 && box.y0 < r.y1 + 1 && box.y1 > r.y0 - 1;
    if (rects.some(hit) || taken.some(hit)) return false;
    if (rects.some((r) => segIntersectsRect(lead[0], lead[1], r))) return false;
    // the lead and the symbol must not touch any other pin
    return !pins.some((q) => {
      if (q.x === pin.x && q.y === pin.y) return false;
      const onLead = Math.min(lead[0].x, lead[1].x) <= q.x && q.x <= Math.max(lead[0].x, lead[1].x)
        && Math.min(lead[0].y, lead[1].y) <= q.y && q.y <= Math.max(lead[0].y, lead[1].y);
      const inBox = q.x >= box.x0 - 1 && q.x <= box.x1 + 1 && q.y >= box.y0 - 1 && q.y <= box.y1 + 1;
      return onLead || inBox;
    });
  };
  const added: CircuitComponent[] = [];
  let n = 0;
  const wires = doc.wires.map((w) => {
    const gFrom = isGround(w.from.componentId), gTo = isGround(w.to.componentId);
    if (gFrom === gTo) return w;
    const pinRef = gFrom ? w.to : w.from;
    const owner = byId.get(pinRef.componentId);
    const pl = owner && getPlugin(owner.type);
    const pin = resolveEndpointGridPos(pinRef, doc.components, doc.sheets ?? []);
    if (!owner || !pl || !pin) return w;
    // pins on the TOP edge would need the ground symbol drawn upside down
    if (pin.y <= owner.position.y) return w;
    const side = pin.x <= owner.position.x ? -1 : pin.x >= owner.position.x + pl.boundingBox.width ? 1 : 0;
    const spots: Vec2[] = [];
    for (let d = 1; d <= 3; d++) spots.push({ x: pin.x, y: pin.y + d });
    if (side !== 0) for (let d = 0; d <= 2; d++) spots.push({ x: pin.x + 2 * side, y: pin.y + 1 + d });
    for (const t of spots) {
      const box = { x0: t.x - 1, y0: t.y, x1: t.x + 1, y1: t.y + 2 };
      if (!free(box, [pin, { x: t.x, y: pin.y }], pin) || !free(box, [{ x: t.x, y: pin.y }, t], pin)) continue;
      const id = `gnd_l${++n}`;
      added.push({ id, type: 'ground', position: { x: t.x - 1, y: t.y }, rotation: 0, parameters: {} } as CircuitComponent);
      taken.push(box);
      const gref = { componentId: id, terminalId: 'g' };
      const next: Wire = gFrom ? { ...w, from: gref } : { ...w, to: gref };
      delete next.waypoints;
      return next;
    }
    return w;
  });
  // shared ground symbols nothing connects to any more are dropped
  const before = new Set(doc.wires.flatMap((w) => [w.from.componentId, w.to.componentId]));
  const used = new Set(wires.flatMap((w) => [w.from.componentId, w.to.componentId]));
  const components = [
    ...doc.components.filter((c) => c.type !== 'ground' || used.has(c.id) || !before.has(c.id)),
    ...added,
  ];
  return { ...doc, components, wires };
}

/**
 * Route EVERY wire with the readable router, longest first (later wires
 * join the trunks the long ones lay down). Used by "Tidy wires" and for
 * example layouts whose hand-drawn routes were discarded.
 */
export function routeAllReadable(wires: Wire[], components: CircuitComponent[], sheets: HierarchicalSheet[]): Wire[] {
  const len = (w: Wire) => {
    const a = resolveEndpointGridPos(w.from, components, sheets);
    const b = resolveEndpointGridPos(w.to, components, sheets);
    return a && b ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : 0;
  };
  const order = wires.map((w, i) => ({ i, l: len(w) })).sort((p, q) => q.l - p.l).map((p) => p.i);
  // start from no routes at all: each wire sees only the ones routed before it
  const out: Wire[] = wires.map((w) => { const b = { ...w }; delete b.waypoints; return b; });
  const placed: Wire[] = [];
  for (const i of order) {
    const w = out[i];
    const from = resolveEndpointGridPos(w.from, components, sheets);
    const to = resolveEndpointGridPos(w.to, components, sheets);
    if (from && to) {
      // nets come from the FULL wire list (connectivity), obstacles from the
      // wires already placed
      const ctx = makeRouteContext(components, out, sheets);
      ctx.wires = placed.slice();
      const route = bestReadableRoute(from, to, { from: w.from, to: w.to }, ctx, undefined, true);
      if (route && route.length > 0) out[i] = { ...w, waypoints: route.map((p) => ({ x: p.x, y: p.y })) };
    }
    placed.push(out[i]);
  }
  // anything still misleading (e.g. an early wire crossed by nothing yet
  // but now overlapped) gets the standard fix-up
  return readabilityPass(out, components, sheets);
}

/**
 * Phase E — readability: re-route every wire whose drawing would mislead
 * (passes over another net's pin, runs through a component body, ends on
 * or turns on another net's wire, overlaps another net). Clean wires keep
 * their authored route; offenders get the readable router's route.
 * Two passes: a re-route can free space another offender needs.
 */
export function readabilityPass(
  wires: Wire[], components: CircuitComponent[], sheets: HierarchicalSheet[],
  only?: Set<string>,
): Wire[] {
  // untouched wires keep their object identity (cheap change detection)
  const out = wires.slice();
  // Pass 2 revisits only wires pass 1 could not fix: a re-route treats every
  // other wire as an obstacle, so it never creates a new violation.
  let todo: Set<string> | undefined = only;
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    const unfixed = new Set<string>();
    // one context (and one geometry snapshot) per pass, updated per re-route
    const ctx = makeRouteContext(components, out.slice(), sheets);
    for (let i = 0; i < out.length; i++) {
      const w = out[i];
      if (todo && !todo.has(w.id)) continue;
      const from = resolveEndpointGridPos(w.from, components, sheets);
      const to = resolveEndpointGridPos(w.to, components, sheets);
      if (!from || !to) continue;
      const exclude = new Set([w.id]);
      const own = new Set([ctx.netOf(`${w.from.componentId}:${w.from.terminalId}`), ctx.netOf(`${w.to.componentId}:${w.to.terminalId}`)]);
      const current = w.waypoints && w.waypoints.length > 0
        ? w.waypoints
        : (Math.abs(from.x - to.x) > 1e-3 && Math.abs(from.y - to.y) > 1e-3 ? [{ x: to.x, y: from.y }] : []);
      if (Number.isFinite(evaluateRoute(from, current, to, ctx, { own, exclude }))) continue;
      const route = bestReadableRoute(from, to, { from: w.from, to: w.to }, ctx, exclude);
      if (!route) { unfixed.add(w.id); continue; }
      const next: Wire = { ...w };
      if (route.length > 0) next.waypoints = route.map((p) => ({ x: p.x, y: p.y }));
      else delete next.waypoints;
      out[i] = next;
      updateContextWire(ctx, next);
      changed = true;
    }
    if (!changed || unfixed.size === 0) break;
    todo = unfixed;
  }
  return out;
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
