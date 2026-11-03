// Readability-aware schematic wire router.
//
// A wire drawing must never lie about connectivity. The straight-candidate
// planner only checked wire-on-wire overlap, so on the example library a
// wire passed over another net's pin 419 times, ended on the middle of a
// different-net wire (a fake T-junction) 373 times and ran through
// component bodies for 739 grid units.
//
// This router treats the misleading cases as HARD constraints and the merely
// untidy ones as costs:
//   forbidden  – running on a different-net wire (1:1 overlap)
//              – passing over a pin of another net
//              – touching a different-net wire anywhere but a clean
//                perpendicular crossing (no shared corners / fake T's)
//   costed     – bends (high: corner-sparse routes, never "jigsaw" paths)
//              – perpendicular crossings of other nets (drawn with a hop)
//              – running beside another net in the adjacent track
//              – hugging a body outline
//   preferred  – running along a same-net wire (shared trunk + dots)
//              – crossing a component body (steep: only to escape a pin
//                that is itself trapped inside an overlapping part)
//              – leaving the main grid for half-grid tracks
// The classic straight / L routes win whenever they are clean (see
// planWireRoute); this search only decides when they are not.
//
// Coordinates: a half-grid lattice (step 0.5) so pins at x.5 are reachable.

import type { CircuitComponent, HierarchicalSheet, Vec2, Wire } from './types';
import { getPlugin } from './registry';
import { terminalPos, transformBodyPoint } from './endpoint-position';

export interface RouteContext {
  components: CircuitComponent[];
  wires: Wire[];
  sheets: HierarchicalSheet[];
  /** Net key of a terminal (`componentId:terminalId`), or undefined. */
  netOf: (terminalKey: string) => string | number | undefined;
  /** Rendered grid path of an existing wire (start → corners → end). */
  pathOf: (wire: Wire) => Vec2[] | null;
  /** Precomputed geometry (see routeGeometry); derived on demand when absent. */
  geometry?: RouteGeometry;
}

/** Document geometry the router reads: bodies, pins and wire paths. */
export interface RouteGeometry {
  bodies: { x0: number; y0: number; x1: number; y1: number }[];
  pins: { p: Vec2; net: string | number | undefined }[];
  wires: Map<string, { path: Vec2[]; net: string | number | undefined }>;
}

/** Compute a context's geometry once (callers reuse it across many routes). */
export function routeGeometry(ctx: RouteContext): RouteGeometry {
  const bodies: RouteGeometry['bodies'] = [];
  const pins: RouteGeometry['pins'] = [];
  for (const c of ctx.components) {
    const pl = getPlugin(c.type);
    if (!pl) continue;
    const bb = pl.boundingBox;
    const a = transformBodyPoint(c, { x: 0, y: 0 }, bb);
    const b = transformBodyPoint(c, { x: bb.width, y: bb.height }, bb);
    bodies.push({
      x0: c.position.x + Math.min(a.x, b.x), y0: c.position.y + Math.min(a.y, b.y),
      x1: c.position.x + Math.max(a.x, b.x), y1: c.position.y + Math.max(a.y, b.y),
    });
    for (const t of pl.terminals) pins.push({ p: terminalPos(c, t, pl), net: ctx.netOf(`${c.id}:${t.id}`) });
  }
  const wires: RouteGeometry['wires'] = new Map();
  for (const w of ctx.wires) setGeometryWire(ctx, wires, w);
  return { bodies, pins, wires };
}

function setGeometryWire(ctx: RouteContext, map: RouteGeometry['wires'], w: Wire) {
  const p = ctx.pathOf(w);
  if (p && p.length >= 2) map.set(w.id, { path: p, net: ctx.netOf(`${w.from.componentId}:${w.from.terminalId}`) });
  else map.delete(w.id);
}

/** Replace one wire in a context (and its cached geometry) after a re-route. */
export function updateContextWire(ctx: RouteContext, wire: Wire): void {
  ctx.wires = ctx.wires.map((w) => (w.id === wire.id ? wire : w));
  if (ctx.geometry) setGeometryWire(ctx, ctx.geometry.wires, wire);
}

export interface RouteNets {
  /** Net keys the new wire belongs to (both endpoint nets — they merge). */
  own: Set<string | number | undefined>;
  /** Wire ids to ignore as obstacles (the wire being re-routed). */
  exclude?: Set<string>;
}

const STEP = 1;           // per half-grid step
const BEND = 5;           // per corner (= 2.5 grid units of length)
const CROSS = 6;          // perpendicular crossing of another net
const NEAR = 0.6;         // per step beside another net (adjacent track)
// Joining a same-net run is CHEAPER than fresh track: same-net wires then
// share one trunk that branches with junction dots (the readable
// convention) instead of a ladder of parallel lines to one symbol.
const SHARE = 0.7;        // per step along a same-net wire (replaces STEP)
const H_WEIGHT = SHARE;   // admissible heuristic weight (cheapest step)
const HUG = 1.5;          // per step along a body outline
const HALF = 0.4;         // per step on a half-grid track
const BODY = 12;          // per step through a component body
const MAX_EXPANSIONS = 250_000;

type Key = number;

interface Field {
  x0: number; y0: number; w: number; h: number;
  blocked: Uint8Array;            // foreign pin
  body: Uint8Array;               // component body interior
  hug: Uint8Array;                // body outline
  near: Float32Array;             // adjacency cost
  /** point → other-net wire presence: 1 = interior of a straight run, 2 = corner/end */
  foreignPt: Uint8Array;
  /** point → same-net wire presence */
  ownPt: Uint8Array;
  /** lattice edges carrying other-net wires: h = (X,Y)→(X+1,Y), v = (X,Y)→(X,Y+1) */
  foreignH: Uint8Array; foreignV: Uint8Array;
  ownH: Uint8Array; ownV: Uint8Array;
}

const L = (v: number) => Math.round(v * 2);

/**
 * Obstacle field over a window: the bounding box of `focus` plus a margin
 * (a route between two pins only needs their neighbourhood), or — with
 * `full` — the whole document.
 */
function buildField(ctx: RouteContext, nets: RouteNets, focus: Vec2[], full = false): Field {
  const pts: Vec2[] = [...focus];
  const geo = ctx.geometry ?? (ctx.geometry = routeGeometry(ctx));
  const { bodies, pins } = geo;
  if (full) for (const r of bodies) pts.push({ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y1 });
  const paths: { path: Vec2[]; own: boolean }[] = [];
  for (const [id, { path, net }] of geo.wires) {
    if (nets.exclude?.has(id)) continue;
    paths.push({ path, own: nets.own.has(net) });
    if (full) pts.push(...path);
  }
  const M = full ? 8 : 10; // grid units of free margin
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const x0 = L(minX - M), y0 = L(minY - M);
  const w = L(maxX + M) - x0 + 1, h = L(maxY + M) - y0 + 1;
  const n = w * h;
  const f: Field = {
    x0, y0, w, h,
    blocked: new Uint8Array(n), body: new Uint8Array(n), hug: new Uint8Array(n), near: new Float32Array(n),
    foreignPt: new Uint8Array(n), ownPt: new Uint8Array(n),
    foreignH: new Uint8Array(n), foreignV: new Uint8Array(n), ownH: new Uint8Array(n), ownV: new Uint8Array(n),
  };
  const idx = (X: number, Y: number) => (Y - y0) * w + (X - x0);
  const inside = (X: number, Y: number) => X >= x0 && Y >= y0 && X < x0 + w && Y < y0 + h;

  for (const b of bodies) {
    const X0 = L(b.x0), X1 = L(b.x1), Y0 = L(b.y0), Y1 = L(b.y1);
    for (let Y = Y0; Y <= Y1; Y++) for (let X = X0; X <= X1; X++) {
      if (!inside(X, Y)) continue;
      if (X > X0 && X < X1 && Y > Y0 && Y < Y1) f.body[idx(X, Y)] = 1;
      else f.hug[idx(X, Y)] = 1;
    }
  }
  for (const pin of pins) {
    const X = L(pin.p.x), Y = L(pin.p.y);
    if (!inside(X, Y)) continue;
    if (!nets.own.has(pin.net)) f.blocked[idx(X, Y)] = 1;
    else f.hug[idx(X, Y)] = 0; // own pins are always approachable
  }
  for (const { path, own } of paths) {
    for (let k = 1; k < path.length; k++) {
      const A = { X: L(path[k - 1].x), Y: L(path[k - 1].y) };
      const B = { X: L(path[k].x), Y: L(path[k].y) };
      if (A.X !== B.X && A.Y !== B.Y) continue; // non-orthogonal leg: ignore
      const horiz = A.Y === B.Y;
      // skip runs entirely outside the window (±2 for the adjacency halo)
      if (horiz ? (A.Y < y0 - 2 || A.Y >= y0 + h + 2 || Math.max(A.X, B.X) < x0 || Math.min(A.X, B.X) >= x0 + w)
                : (A.X < x0 - 2 || A.X >= x0 + w + 2 || Math.max(A.Y, B.Y) < y0 || Math.min(A.Y, B.Y) >= y0 + h)) continue;
      const lo = horiz ? Math.max(Math.min(A.X, B.X), x0 - 1) : Math.max(Math.min(A.Y, B.Y), y0 - 1);
      const hi = horiz ? Math.min(Math.max(A.X, B.X), x0 + w) : Math.min(Math.max(A.Y, B.Y), y0 + h);
      const loTrue = horiz ? Math.min(A.X, B.X) : Math.min(A.Y, B.Y);
      const hiTrue = horiz ? Math.max(A.X, B.X) : Math.max(A.Y, B.Y);
      for (let t = lo; t <= hi; t++) {
        const X = horiz ? t : A.X, Y = horiz ? A.Y : t;
        if (!inside(X, Y)) continue;
        const i = idx(X, Y);
        const endPt = t === loTrue || t === hiTrue;
        if (own) f.ownPt[i] = 1;
        else f.foreignPt[i] = Math.max(f.foreignPt[i], endPt ? 2 : 1);
        if (t < hiTrue) {
          if (horiz) (own ? f.ownH : f.foreignH)[i] = 1;
          else (own ? f.ownV : f.foreignV)[i] = 1;
        }
        if (!own) {
          // adjacent tracks (±0.5 and ±1 grid) beside this run
          for (const d of [-2, -1, 1, 2]) {
            const NX = horiz ? X : X + d, NY = horiz ? Y + d : Y;
            if (inside(NX, NY)) f.near[idx(NX, NY)] += NEAR * (Math.abs(d) === 1 ? 1 : 0.6);
          }
        }
      }
    }
  }
  return f;
}

// direction: 0 = +x, 1 = −x, 2 = +y, 3 = −y, 4 = none (start)
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = k[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length > 0) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Cost of moving from lattice point (X,Y) (arrived in `dirIn`) one step in
 * `d`, or Infinity when the move is forbidden. Shared by the search and by
 * evaluatePath so candidates and A* results are scored identically.
 */
function stepCost(f: Field, X: number, Y: number, dirIn: number, d: number, endX: number, endY: number, startX: number, startY: number): number {
  const NX = X + DX[d], NY = Y + DY[d];
  if (NX < f.x0 || NY < f.y0 || NX >= f.x0 + f.w || NY >= f.y0 + f.h) return Infinity;
  const i = (Y - f.y0) * f.w + (X - f.x0);
  const ni = (NY - f.y0) * f.w + (NX - f.x0);
  const isEnd = NX === endX && NY === endY;
  const atStart = X === startX && Y === startY;
  // the edge itself
  const horiz = d < 2;
  const ei = horiz ? (d === 0 ? i : ni) : (d === 2 ? i : ni);
  if ((horiz ? f.foreignH : f.foreignV)[ei]) return Infinity;
  // turning on a point that carries another net's wire = a fake junction
  const turning = dirIn !== 4 && dirIn !== d;
  if (turning && f.foreignPt[i] && !atStart) return Infinity;
  // arriving on a foreign corner / end point (not a clean crossing)
  if (!isEnd && f.foreignPt[ni] === 2) return Infinity;
  if (!isEnd && f.blocked[ni]) return Infinity;
  const sharing = (horiz ? f.ownH : f.ownV)[ei] === 1;
  let c = sharing ? SHARE : STEP;
  if (turning) c += BEND;
  if (!isEnd && f.foreignPt[ni] === 1) {
    // must be a perpendicular crossing: the foreign run is on the other axis
    const fi = horiz ? f.foreignV : f.foreignH;
    const crossing = fi[ni] || fi[horiz ? ni - f.w : ni - 1];
    if (!crossing) return Infinity;
    c += CROSS;
  }
  if (f.hug[ni] && !isEnd) c += HUG;
  if (f.body[ni] && !isEnd) c += BODY;
  c += f.near[ni];
  if (horiz ? (NY & 1) : (NX & 1)) c += HALF;
  return c;
}

/**
 * Best route from `start` to `end` under the readability model, as corner
 * waypoints (endpoints excluded), or null when no legal route exists.
 */
export function routeSchematicWire(start: Vec2, end: Vec2, ctx: RouteContext, nets: RouteNets, field?: RouteField): Vec2[] | null {
  // the neighbourhood first; the whole sheet only when that has no route
  return searchRoute(start, end, (field as Field | undefined) ?? buildField(ctx, nets, [start, end]))
    ?? searchRoute(start, end, buildField(ctx, nets, [start, end], true));
}

/** Opaque obstacle field, reusable for several evaluations of one wire. */
export type RouteField = unknown;

/** Build one field covering every point in `focus` (candidate routes). */
export function createRouteField(ctx: RouteContext, nets: RouteNets, focus: Vec2[]): RouteField {
  return buildField(ctx, nets, focus);
}

function searchRoute(start: Vec2, end: Vec2, f: Field): Vec2[] | null {
  const sX = L(start.x), sY = L(start.y), eX = L(end.x), eY = L(end.y);
  if (sX === eX && sY === eY) return [];
  const W = f.w, H = f.h;
  const state = (X: number, Y: number, d: number): Key => (((Y - f.y0) * W + (X - f.x0)) * 5 + d);
  const g = new Float64Array(W * H * 5).fill(Infinity);
  const parent = new Int32Array(W * H * 5).fill(-1);
  const heap = new Heap();
  const s0 = state(sX, sY, 4);
  g[s0] = 0;
  heap.push(s0, H_WEIGHT * (Math.abs(sX - eX) + Math.abs(sY - eY)));
  let expansions = 0;
  let goal = -1;
  while (heap.size > 0 && expansions++ < MAX_EXPANSIONS) {
    const s = heap.pop();
    const d0 = s % 5;
    const cell = (s - d0) / 5;
    const X = (cell % W) + f.x0, Y = Math.floor(cell / W) + f.y0;
    if (X === eX && Y === eY) { goal = s; break; }
    const gs = g[s];
    for (let d = 0; d < 4; d++) {
      if (d0 !== 4 && ((d0 ^ 1) === d)) continue; // no U-turns
      const c = stepCost(f, X, Y, d0, d, eX, eY, sX, sY);
      if (!Number.isFinite(c)) continue;
      const NX = X + DX[d], NY = Y + DY[d];
      const ns = state(NX, NY, d);
      const ng = gs + c;
      if (ng < g[ns]) {
        g[ns] = ng;
        parent[ns] = s;
        heap.push(ns, ng + H_WEIGHT * (Math.abs(NX - eX) + Math.abs(NY - eY)));
      }
    }
  }
  if (goal < 0) return null;
  const lattice: Vec2[] = [];
  for (let s = goal; s >= 0; s = parent[s]) {
    const cell = (s - (s % 5)) / 5;
    lattice.push({ x: ((cell % W) + f.x0) / 2, y: (Math.floor(cell / W) + f.y0) / 2 });
  }
  lattice.reverse();
  return corners(lattice);
}

/** Interior corner points of an orthogonal polyline. */
function corners(path: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    const colinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    if (!colinear) out.push(b);
  }
  return out;
}

/**
 * Score an explicit route (start → waypoints → end) under the same model:
 * Infinity when it breaks a hard rule (misleading drawing). With `strict`
 * (default) crossing a component body is also a hard failure — the search
 * only pays the steep body cost to free a pin trapped inside another part.
 */
export function evaluateRoute(start: Vec2, waypoints: Vec2[], end: Vec2, ctx: RouteContext, nets: RouteNets, strict = true, field?: RouteField): number {
  const f = (field as Field | undefined) ?? buildField(ctx, nets, [start, ...waypoints, end]);
  // a route leaving the shared field's window is scored on its own field
  for (const p of waypoints) {
    if (L(p.x) < f.x0 || L(p.y) < f.y0 || L(p.x) >= f.x0 + f.w || L(p.y) >= f.y0 + f.h) {
      return evaluateRoute(start, waypoints, end, ctx, nets, strict);
    }
  }
  const pts = [start, ...waypoints, end].map((p) => ({ X: L(p.x), Y: L(p.y) }));
  const sX = pts[0].X, sY = pts[0].Y, eX = pts[pts.length - 1].X, eY = pts[pts.length - 1].Y;
  let X = sX, Y = sY, dir = 4, cost = 0;
  for (let k = 1; k < pts.length; k++) {
    const T = pts[k];
    if (T.X !== X && T.Y !== Y) return Infinity; // diagonal leg
    while (X !== T.X || Y !== T.Y) {
      const d = T.X > X ? 0 : T.X < X ? 1 : T.Y > Y ? 2 : 3;
      if (dir !== 4 && (dir ^ 1) === d) return Infinity;
      const c = stepCost(f, X, Y, dir, d, eX, eY, sX, sY);
      if (!Number.isFinite(c)) return Infinity;
      const NX = X + DX[d], NY = Y + DY[d];
      if (strict && f.body[(NY - f.y0) * f.w + (NX - f.x0)] && !(NX === eX && NY === eY)) return Infinity;
      cost += c;
      X = NX; Y = NY; dir = d;
    }
  }
  return cost;
}
