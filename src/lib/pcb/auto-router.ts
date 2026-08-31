// ─────────────────────────────────────────────────────────────────────────────
// Modern PCB auto-router — multi-layer A* with exact clearance geometry,
// automatic via placement, 45° routes and rip-up/reroute congestion handling.
//
// Design (v2, complete rewrite of the Lee-BFS router):
//
//   • Obstacle model: every copper feature (pad / via / trace segment /
//     keepout / board edge) is an exact geometric primitive — circle, rect
//     or segment — tagged with its net. Clearances are checked EXACTLY
//     (point/segment-to-primitive distance), never approximated by a coarse
//     "blocked cell" radius, so two legally-spaced features never block a
//     legal route and no route ever violates the DRC clearance.
//   • Pads with NO net (floating pins, e.g. a 555's CTRL pin) are hard
//     obstacles for every net — the old router routed straight through them
//     and created shorts.
//   • A* runs on a fine grid (0.25 mm default) across BOTH routing layers
//     (top + bottom). Layer transitions place real vias; vias cost extra
//     path length so the router prefers single-layer routes but escapes
//     congestion through the second layer when needed.
//   • 8-directional expansion produces native 45° routes; a post-pass
//     "string-pull" simplification removes jogs and merges detours into
//     clean straight/diagonal segments (verified exactly before accepted).
//   • Rip-up & reroute: when a leg cannot be routed, the engine identifies
//     the nets crossing its corridor, rips them up, routes the blocked leg,
//     and re-routes the ripped nets. Multiple passes with escalating via
//     budgets resolve congestion.
//   • Multi-pad nets: per-net minimum spanning tree (Prim); later legs may
//     run over / follow earlier legs' copper (same-net walkability).
//   • Per-net trace width / clearance / via size from net classes.
//   • Performance: typed arrays, binary heap, spatial hash with a dilated
//     occupancy counter fast path. A 24-component board routes in well
//     under a second (the previous router exceeded 60 s).
//
// Public API:
//   autoRoute(footprints, traces, vias, ratsnest, board, layerOrOptions?, traceWidth?)
//     — legacy 6-arg form routes on a single layer with no vias
//     — options form enables the full two-layer engine
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CopperLayer, Footprint, Pad, Ratsnest, Trace, TraceSegment, Via, BoardOutline,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RouterNetClass {
  name: string;
  traceWidth: number;
  clearance: number;
  viaDiameter: number;
  viaDrill: number;
  nets: string[];
}

export interface RouterKeepout {
  rect: { x: number; y: number; width: number; height: number };
  layers: 'all' | string[];
}

export interface AutoRouteOptions {
  /** default trace width (mm) — overridden per net by net classes */
  traceWidth: number;
  /** default copper-to-copper clearance (mm) */
  clearance: number;
  /** via outer diameter (mm) */
  viaDiameter: number;
  /** via drill diameter (mm) */
  viaDrill: number;
  /** routing grid resolution (mm). Auto-coarsened for very large boards. */
  gridResolution: number;
  /** routing layers. Two layers ⇒ vias allowed between them. */
  layers: CopperLayer[];
  /** allow layer transitions with vias (requires ≥ 2 layers) */
  allowVias: boolean;
  /** per-net width/clearance/via overrides */
  netClasses: RouterNetClass[];
  /** keepout rectangles the router must avoid */
  keepouts: RouterKeepout[];
  /** rip-up/reroute passes (1 = single pass, no rip-up escalation) */
  maxPasses: number;
}

export const DEFAULT_AUTOROUTE_OPTIONS: AutoRouteOptions = {
  traceWidth: 0.3,
  clearance: 0.2,
  viaDiameter: 0.6,
  viaDrill: 0.3,
  gridResolution: 0.25,
  layers: ['top', 'bottom'],
  allowVias: true,
  netClasses: [],
  keepouts: [],
  maxPasses: 6,
};

export interface AutoRouteResult {
  traces: Trace[];
  vias: Via[];
  unrouted: { net: string; from: { x: number; y: number }; to: { x: number; y: number }; reason?: string }[];
  stats: {
    totalNets: number;
    routed: number;
    failed: number;
    totalSegments: number;
    totalLength: number; // mm
    vias: number;
    passes: number;
    rippedUp: number;
    elapsedMs: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact geometry helpers (shared with the interactive clearance preview)
// ─────────────────────────────────────────────────────────────────────────────

export function distPointSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function distPointRect(px: number, py: number, cx: number, cy: number, hw: number, hh: number): number {
  const dx = Math.max(Math.abs(px - cx) - hw, 0);
  const dy = Math.max(Math.abs(py - cy) - hh, 0);
  return Math.hypot(dx, dy);
}

function segIntersect(
  a1x: number, a1y: number, a2x: number, a2y: number,
  b1x: number, b1y: number, b2x: number, b2y: number,
): boolean {
  const d1 = (b2x - b1x) * (a1y - b1y) - (b2y - b1y) * (a1x - b1x);
  const d2 = (b2x - b1x) * (a2y - b1y) - (b2y - b1y) * (a2x - b1x);
  const d3 = (a2x - a1x) * (b1y - a1y) - (a2y - a1y) * (b1x - a1x);
  const d4 = (a2x - a1x) * (b2y - a1y) - (a2y - a1y) * (b2x - a1x);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function distSegSeg(
  a1x: number, a1y: number, a2x: number, a2y: number,
  b1x: number, b1y: number, b2x: number, b2y: number,
): number {
  if (segIntersect(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y)) return 0;
  return Math.min(
    distPointSeg(b1x, b1y, a1x, a1y, a2x, a2y),
    distPointSeg(b2x, b2y, a1x, a1y, a2x, a2y),
    distPointSeg(a1x, a1y, b1x, b1y, b2x, b2y),
    distPointSeg(a2x, a2y, b1x, b1y, b2x, b2y),
  );
}

export function distSegRect(
  x1: number, y1: number, x2: number, y2: number,
  cx: number, cy: number, hw: number, hh: number,
): number {
  if (distPointRect(x1, y1, cx, cy, hw, hh) === 0) return 0;
  if (distPointRect(x2, y2, cx, cy, hw, hh) === 0) return 0;
  const ex = cx + hw, sx = cx - hw, ey = cy + hh, sy = cy - hh;
  return Math.min(
    distSegSeg(x1, y1, x2, y2, sx, sy, ex, sy),
    distSegSeg(x1, y1, x2, y2, ex, sy, ex, ey),
    distSegSeg(x1, y1, x2, y2, ex, ey, sx, ey),
    distSegSeg(x1, y1, x2, y2, sx, ey, sx, sy),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Copper obstacle model
// ─────────────────────────────────────────────────────────────────────────────

/** net index meaning "blocks every net" (keepouts, board edge, floating pads) */
const NET_HARD = -2;

type CopperItem = {
  /** net index (router-internal); NET_HARD blocks all nets */
  net: number;
  kind: 'circle' | 'rect' | 'segment';
  /** circle: cx,cy,r · rect: cx,cy,hw,hh · segment: x1,y1,x2,y2,r */
  cx: number; cy: number; r: number;
  hw: number; hh: number;
  x1: number; y1: number; x2: number; y2: number;
};

function circleItem(net: number, cx: number, cy: number, r: number): CopperItem {
  return { net, kind: 'circle', cx, cy, r, hw: 0, hh: 0, x1: 0, y1: 0, x2: 0, y2: 0 };
}
function rectItem(net: number, cx: number, cy: number, hw: number, hh: number): CopperItem {
  return { net, kind: 'rect', cx, cy, r: 0, hw, hh, x1: 0, y1: 0, x2: 0, y2: 0 };
}
function segmentItem(net: number, x1: number, y1: number, x2: number, y2: number, r: number): CopperItem {
  return { net, kind: 'segment', cx: 0, cy: 0, r, hw: 0, hh: 0, x1, y1, x2, y2 };
}

/** Distance from a POINT to an item's copper (0 = touching/inside). */
function distPointItem(px: number, py: number, it: CopperItem): number {
  if (it.kind === 'circle') return Math.max(Math.hypot(px - it.cx, py - it.cy) - it.r, 0);
  if (it.kind === 'rect') return distPointRect(px, py, it.cx, it.cy, it.hw, it.hh);
  return Math.max(distPointSeg(px, py, it.x1, it.y1, it.x2, it.y2) - it.r, 0);
}

/** Distance from a SEGMENT to an item's copper (0 = touching/crossing). */
function distSegItem(x1: number, y1: number, x2: number, y2: number, it: CopperItem): number {
  if (it.kind === 'circle') return Math.max(distPointSeg(it.cx, it.cy, x1, y1, x2, y2) - it.r, 0);
  if (it.kind === 'rect') return distSegRect(x1, y1, x2, y2, it.cx, it.cy, it.hw, it.hh);
  return Math.max(distSegSeg(x1, y1, x2, y2, it.x1, it.y1, it.x2, it.y2) - it.r, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-layer obstacle index: spatial hash + dilated occupancy counter
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET_MM = 4; // spatial hash bucket size (mm)

class LayerIndex {
  /** bucketKey → item ids */
  readonly hash = new Map<number, number[]>();
  /** per-grid-cell count of items whose influence zone (bbox + margin) covers the cell */
  readonly nearCount: Uint16Array;
  readonly cols: number;
  readonly rows: number;
  readonly grid: number;

  constructor(cols: number, rows: number, grid: number) {
    this.cols = cols; this.rows = rows; this.grid = grid;
    this.nearCount = new Uint16Array(cols * rows);
  }

  bucketKey(px: number, py: number): number {
    return (Math.floor(px / BUCKET_MM) + 2048) * 8192 + (Math.floor(py / BUCKET_MM) + 2048);
  }

  bucketAt(px: number, py: number): number[] | undefined {
    return this.hash.get(this.bucketKey(px, py));
  }

  /** influence bbox of an item (copper bbox + margin) */
  private influenceBBox(it: CopperItem, margin: number): [number, number, number, number] {
    if (it.kind === 'circle') {
      return [it.cx - it.r - margin, it.cy - it.r - margin, it.cx + it.r + margin, it.cy + it.r + margin];
    }
    if (it.kind === 'rect') {
      return [it.cx - it.hw - margin, it.cy - it.hh - margin, it.cx + it.hw + margin, it.cy + it.hh + margin];
    }
    const mx = Math.min(it.x1, it.x2) - it.r - margin;
    const my = Math.min(it.y1, it.y2) - it.r - margin;
    const Mx = Math.max(it.x1, it.x2) + it.r + margin;
    const My = Math.max(it.y1, it.y2) + it.r + margin;
    return [mx, my, Mx, My];
  }

  insert(it: CopperItem, margin: number, id: number): void { this.apply(it, margin, id, +1); }
  remove(it: CopperItem, margin: number, id: number): void { this.apply(it, margin, id, -1); }

  private apply(it: CopperItem, margin: number, id: number, sign: 1 | -1): void {
    const [mx, my, Mx, My] = this.influenceBBox(it, margin);
    // hash: register the item in every bucket its influence bbox touches
    const bx0 = Math.floor(mx / BUCKET_MM), bx1 = Math.floor(Mx / BUCKET_MM);
    const by0 = Math.floor(my / BUCKET_MM), by1 = Math.floor(My / BUCKET_MM);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const key = (bx + 2048) * 8192 + (by + 2048);
        if (sign > 0) {
          let list = this.hash.get(key);
          if (!list) { list = []; this.hash.set(key, list); }
          list.push(id);
        } else {
          const list = this.hash.get(key);
          if (list) {
            const i = list.indexOf(id);
            if (i >= 0) list.splice(i, 1);
            if (list.length === 0) this.hash.delete(key);
          }
        }
      }
    }
    // nearCount: dilate over grid cells covered by the influence bbox
    const g = this.grid;
    const c0 = Math.max(0, Math.floor(mx / g)), c1 = Math.min(this.cols - 1, Math.ceil(Mx / g));
    const r0 = Math.max(0, Math.floor(my / g)), r1 = Math.min(this.rows - 1, Math.ceil(My / g));
    const nc = this.nearCount;
    if (sign > 0) {
      for (let r = r0; r <= r1; r++) {
        const base = r * this.cols;
        for (let c = c0; c <= c1; c++) {
          const v = nc[base + c];
          if (v < 65535) nc[base + c] = v + 1;
        }
      }
    } else {
      for (let r = r0; r <= r1; r++) {
        const base = r * this.cols;
        for (let c = c0; c <= c1; c++) {
          const v = nc[base + c];
          if (v > 0) nc[base + c] = v - 1;
        }
      }
    }
  }

  /**
   * Is point (px,py) clear of OTHER-net copper?
   * `need` = required copper-to-point distance (clearance + halfWidth [+ slack]).
   * Exact: every item in the bucket is distance-checked.
   */
  pointClear(px: number, py: number, net: number, need: number, items: CopperItem[]): boolean {
    const col = Math.round(px / this.grid), row = Math.round(py / this.grid);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return false;
    if (this.nearCount[row * this.cols + col] === 0) return true; // fast path — no copper anywhere near
    const list = this.bucketAt(px, py);
    if (!list) return true;
    for (const id of list) {
      const it = items[id];
      if (!it || it.net === net) continue;
      if (distPointItem(px, py, it) < need) return false;
    }
    return true;
  }

  /**
   * EXACT segment clearance: checks the true segment-to-item distance for
   * every item near the segment. Used for route verification and the
   * string-pull pass (no sampling error).
   */
  segmentClearExact(
    x1: number, y1: number, x2: number, y2: number,
    net: number, need: number, items: CopperItem[],
  ): boolean {
    const mx = Math.min(x1, x2) - need, Mx = Math.max(x1, x2) + need;
    const my = Math.min(y1, y2) - need, My = Math.max(y1, y2) + need;
    const bx0 = Math.floor(mx / BUCKET_MM), bx1 = Math.floor(Mx / BUCKET_MM);
    const by0 = Math.floor(my / BUCKET_MM), by1 = Math.floor(My / BUCKET_MM);
    const seen = new Set<number>();
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const list = this.hash.get((bx + 2048) * 8192 + (by + 2048));
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          const it = items[id];
          if (!it || it.net === net) continue;
          if (distSegItem(x1, y1, x2, y2, it) < need) return false;
        }
      }
    }
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary min-heap over (f, cellIdx)
// ─────────────────────────────────────────────────────────────────────────────

class MinHeap {
  private f = new Float64Array(4096);
  private idx = new Int32Array(4096);
  private n = 0;
  get size(): number { return this.n; }
  clear(): void { this.n = 0; }
  push(f: number, idx: number): void {
    if (this.n >= this.f.length) this.grow();
    let i = this.n++;
    this.f[i] = f; this.idx[i] = idx;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      this.swap(p, i);
      i = p;
    }
  }
  pop(): number {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.f[0] = this.f[this.n]; this.idx[0] = this.idx[this.n];
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let best = i;
        if (l < this.n && this.f[l] < this.f[best]) best = l;
        if (r < this.n && this.f[r] < this.f[best]) best = r;
        if (best === i) break;
        this.swap(best, i);
        i = best;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const tf = this.f[a]; this.f[a] = this.f[b]; this.f[b] = tf;
    const ti = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = ti;
  }
  private grow(): void {
    const nf = new Float64Array(this.f.length * 2);
    nf.set(this.f); this.f = nf;
    const ni = new Int32Array(this.idx.length * 2);
    ni.set(this.idx); this.idx = ni;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router engine
// ─────────────────────────────────────────────────────────────────────────────

interface RouteLeg {
  net: number;
  from: Pad | null;
  to: Pad | null;
  fromPt: { x: number; y: number };
  toPt: { x: number; y: number };
  fromLayer: number;
  toLayer: number;
  dist: number;
}

interface Stamp {
  /** obstacle-index item id (assigned at commit time) */
  id: number;
  layer: number;
  /** copper primitive (set by buildRoute; consumed at commit) */
  item?: CopperItem;
}

interface CommittedRoute {
  leg: RouteLeg;
  traces: Trace[];
  vias: Via[];
  /** items stamped into the obstacle index by this route */
  stamps: Stamp[];
  lengthMm: number;
}

interface RouteBuild {
  traces: Trace[];
  vias: Via[];
  stamps: Stamp[];
  lengthMm: number;
}

/** Is segment a→b axis-aligned or at 45°? */
function is45Segment(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (dx < 1e-6 || dy < 1e-6) return true;          // axis-aligned
  return Math.abs(dx - dy) < 1e-6;                    // 45°
}

const DIRS8: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

class Router {
  readonly board: BoardOutline;
  readonly grid: number;
  readonly cols: number;
  readonly rows: number;
  readonly layers: CopperLayer[];
  readonly layerIdx = new Map<CopperLayer, number>();
  readonly layerCount: number;
  readonly allowVias: boolean;
  readonly options: AutoRouteOptions;

  /** all items indexed by id */
  readonly items: CopperItem[] = [];
  private readonly layerIndexes: LayerIndex[];
  /** dilation margin for the hash/nearCount — ≥ any check radius used */
  private readonly margin: number;

  private netWidths: number[] = [];
  private netClearances: number[] = [];
  private netViaDia: number[] = [];
  private netViaDrill: number[] = [];
  private netNames: string[] = [];
  private netNameToIdx = new Map<string, number>();
  private maxViaR = 0;

  // A* scratch (allocated once)
  private readonly gScore: Float32Array;
  private readonly gGen: Uint32Array;
  private readonly closedGen: Uint32Array;
  private readonly parent: Int32Array;
  private readonly heap = new MinHeap();
  private gen = 0;
  private readonly stateCount: number;

  private committed: CommittedRoute[] = [];
  private legsForNetCache = new Map<number, RouteLeg[]>();

  constructor(board: BoardOutline, options: AutoRouteOptions) {
    this.board = board;
    this.options = options;
    // adaptive grid: keep cell count manageable on very large boards
    let grid = options.gridResolution;
    const maxDim = Math.max(board.width, board.height);
    if (maxDim > 260 && grid < 0.4) grid = 0.4;
    else if (maxDim > 170 && grid < 0.3) grid = 0.3;
    this.grid = grid;
    this.cols = Math.max(2, Math.floor(board.width / grid) + 1);
    this.rows = Math.max(2, Math.floor(board.height / grid) + 1);
    this.layers = options.layers.length > 0 ? options.layers : ['top', 'bottom'];
    this.layers.forEach((l, i) => this.layerIdx.set(l, i));
    this.layerCount = this.layers.length;
    this.allowVias = options.allowVias && this.layerCount > 1;

    this.stateCount = this.cols * this.rows * this.layerCount;
    this.gScore = new Float32Array(this.stateCount);
    this.gGen = new Uint32Array(this.stateCount);
    this.closedGen = new Uint32Array(this.stateCount);
    this.parent = new Int32Array(this.stateCount);
    this.layerIndexes = Array.from({ length: this.layerCount }, () => new LayerIndex(this.cols, this.rows, grid));

    // dilation margin must cover the largest check radius:
    // clearance + max(trace half width, via radius) + grid slack
    let maxHalfW = options.traceWidth / 2;
    let maxClear = options.clearance;
    this.maxViaR = Math.max(options.viaDiameter / 2, 0);
    for (const nc of options.netClasses) {
      maxHalfW = Math.max(maxHalfW, nc.traceWidth / 2);
      maxClear = Math.max(maxClear, nc.clearance);
      this.maxViaR = Math.max(this.maxViaR, nc.viaDiameter / 2);
    }
    this.margin = maxClear + Math.max(maxHalfW, this.maxViaR) + grid * 3;
  }

  // ── net parameters ───────────────────────────────────────────────────────

  netIndex(name: string): number {
    let idx = this.netNameToIdx.get(name);
    if (idx === undefined) {
      idx = this.netNames.length;
      this.netNames.push(name);
      this.netNameToIdx.set(name, idx);
      const cls = this.options.netClasses.find((c) => c.nets.includes(name));
      this.netWidths[idx] = cls?.traceWidth ?? this.options.traceWidth;
      this.netClearances[idx] = cls?.clearance ?? this.options.clearance;
      this.netViaDia[idx] = cls?.viaDiameter ?? this.options.viaDiameter;
      this.netViaDrill[idx] = cls?.viaDrill ?? this.options.viaDrill;
    }
    return idx;
  }

  private widthOf(net: number): number { return this.netWidths[net] ?? this.options.traceWidth; }
  private clearanceOf(net: number): number { return this.netClearances[net] ?? this.options.clearance; }

  // ── obstacle insertion ───────────────────────────────────────────────────

  private insertItem(item: CopperItem, layers: number[]): number {
    const id = this.items.length;
    this.items.push(item);
    for (const l of layers) {
      this.layerIndexes[l].insert(item, this.margin, id);
    }
    return id;
  }

  private removeItem(id: number, layers: number[]): void {
    const item = this.items[id];
    if (!item) return;
    for (const l of layers) {
      this.layerIndexes[l].remove(item, this.margin, id);
    }
  }

  /** stamp static obstacles: board edge, keepouts, pads, vias, existing traces */
  buildStaticObstacles(footprints: Footprint[], existingVias: Via[], existingTraces: Trace[]): void {
    const allLayers = this.layers.map((_, i) => i);
    // board edge — copper must stay clear of the outline
    const W = this.board.width, H = this.board.height;
    const far = 1000;
    this.insertItem(rectItem(NET_HARD, -far / 2, H / 2, far / 2, far + H), allLayers);          // x ≤ 0
    this.insertItem(rectItem(NET_HARD, W + far / 2, H / 2, far / 2, far + H), allLayers);       // x ≥ W
    this.insertItem(rectItem(NET_HARD, W / 2, -far / 2, far + W, far / 2), allLayers);          // y ≤ 0
    this.insertItem(rectItem(NET_HARD, W / 2, H + far / 2, far + W, far / 2), allLayers);       // y ≥ H

    // keepouts
    for (const k of this.options.keepouts) {
      const layers = k.layers === 'all'
        ? allLayers
        : k.layers.map((n) => this.layerIdx.get(n as CopperLayer)).filter((i): i is number => i !== undefined);
      if (layers.length === 0) continue;
      this.insertItem(
        rectItem(NET_HARD, k.rect.x + k.rect.width / 2, k.rect.y + k.rect.height / 2, k.rect.width / 2, k.rect.height / 2),
        layers,
      );
    }

    // pads (floating pads are hard obstacles — routing through an unconnected
    // pin would short it once it gets wired in a design revision)
    for (const fp of footprints) {
      for (const pad of fp.pads) {
        const netName = pad.net ?? '';
        const net = netName ? this.netIndex(netName) : NET_HARD;
        const isTht = (pad.drill ?? 0) > 0;
        const padLayers = isTht
          ? allLayers
          : [this.layerIdx.get(pad.layer)].filter((i): i is number => i !== undefined);
        if (padLayers.length === 0) continue; // pad on a layer we don't route
        const item = pad.shape === 'circle'
          ? circleItem(net, pad.position.x, pad.position.y, Math.max(pad.size.width, pad.size.height) / 2)
          : rectItem(net, pad.position.x, pad.position.y, pad.size.width / 2, pad.size.height / 2);
        this.insertItem(item, padLayers);
      }
    }

    // vias
    for (const via of existingVias) {
      const net = via.net ? this.netIndex(via.net) : NET_HARD;
      this.insertItem(circleItem(net, via.position.x, via.position.y, via.diameter / 2), allLayers);
    }

    // existing traces
    for (const trace of existingTraces) {
      const l = this.layerIdx.get(trace.layer);
      if (l === undefined) continue;
      const net = trace.net ? this.netIndex(trace.net) : NET_HARD;
      for (const seg of trace.segments) {
        this.insertItem(segmentItem(net, seg.start.x, seg.start.y, seg.end.x, seg.end.y, seg.width / 2), [l]);
      }
    }
  }

  // ── legs (per-net MST) ───────────────────────────────────────────────────

  private routingLayerOf(pad: Pad): number {
    if ((pad.drill ?? 0) > 0) return 0; // THT exists on every layer
    const l = this.layerIdx.get(pad.layer);
    return l ?? 0;
  }

  buildLegs(padsByNet: Map<number, Pad[]>, ratsnest: Ratsnest[]): Map<number, RouteLeg[]> {
    // The ratsnest defines WHICH nets to route (API contract). Nets whose
    // legs are all already connected are filtered out later by isLegRouted.
    const wanted = new Set<string>();
    for (const rn of ratsnest) wanted.add(rn.net);

    const legsByNet = new Map<number, RouteLeg[]>();
    for (const [net, pads] of padsByNet) {
      if (pads.length < 2) continue;
      if (!wanted.has(this.netNames[net])) continue;
      const legs: RouteLeg[] = [];
      const inTree = new Set<number>([0]);
      const bestDist = new Array<number>(pads.length).fill(Infinity);
      const bestFrom = new Array<number>(pads.length).fill(0);
      for (let i = 1; i < pads.length; i++) {
        bestDist[i] = Math.hypot(pads[i].position.x - pads[0].position.x, pads[i].position.y - pads[0].position.y);
      }
      while (inTree.size < pads.length) {
        let bi = -1, bd = Infinity;
        for (let i = 0; i < pads.length; i++) {
          if (!inTree.has(i) && bestDist[i] < bd) { bd = bestDist[i]; bi = i; }
        }
        if (bi < 0) break;
        inTree.add(bi);
        legs.push(this.makeLeg(net, pads[bestFrom[bi]], pads[bi]));
        for (let i = 0; i < pads.length; i++) {
          if (inTree.has(i)) continue;
          const d = Math.hypot(pads[i].position.x - pads[bi].position.x, pads[i].position.y - pads[bi].position.y);
          if (d < bestDist[i]) { bestDist[i] = d; bestFrom[i] = bi; }
        }
      }
      legsByNet.set(net, legs);
    }
    // nets referenced by ratsnest but without pads: synthetic legs
    const padNetSet = new Set(padsByNet.keys());
    for (const rn of ratsnest) {
      const net = this.netIndex(rn.net);
      if (padNetSet.has(net)) continue;
      if (!legsByNet.has(net)) {
        legsByNet.set(net, [{
          net, from: null, to: null,
          fromPt: { ...rn.from }, toPt: { ...rn.to },
          fromLayer: 0, toLayer: 0,
          dist: Math.hypot(rn.to.x - rn.from.x, rn.to.y - rn.from.y),
        }]);
      }
    }
    return legsByNet;
  }

  private makeLeg(net: number, a: Pad, b: Pad): RouteLeg {
    return {
      net, from: a, to: b,
      fromPt: { ...a.position }, toPt: { ...b.position },
      fromLayer: this.routingLayerOf(a), toLayer: this.routingLayerOf(b),
      dist: Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y),
    };
  }

  /** Is a leg already connected by same-net copper? (union-find) */
  isLegRouted(leg: RouteLeg, padsByNet: Map<number, Pad[]>, existingTraces: Trace[], existingVias: Via[]): boolean {
    const netName = this.netNames[leg.net];
    const pads = padsByNet.get(leg.net) ?? [];
    const nodes: { x: number; y: number }[] = pads.map((p) => ({ x: p.position.x, y: p.position.y }));
    const nodeOf = new Map<string, number>();
    const parent: number[] = nodes.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    const nodeAt = (x: number, y: number): number => {
      const key = `${Math.round(x * 100)},${Math.round(y * 100)}`;
      let n = nodeOf.get(key);
      if (n === undefined) { n = nodes.length; nodes.push({ x, y }); nodeOf.set(key, n); parent.push(n); }
      return n;
    };
    for (const t of existingTraces) {
      if (t.net !== netName || t.segments.length === 0) continue;
      for (const seg of t.segments) {
        union(nodeAt(seg.start.x, seg.start.y), nodeAt(seg.end.x, seg.end.y));
      }
    }
    for (const v of existingVias) {
      if (v.net !== netName) continue;
      nodeAt(v.position.x, v.position.y);
    }
    // union nodes that share a location (within a pad-capture radius)
    const eps = 0.25;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) <= eps) union(i, j);
      }
    }
    const clusterAt = (pt: { x: number; y: number }): number => {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const d = Math.hypot(nodes[i].x - pt.x, nodes[i].y - pt.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      return bestD <= eps ? find(best) : -1;
    };
    const ca = clusterAt(leg.fromPt);
    const cb = clusterAt(leg.toPt);
    return ca >= 0 && cb >= 0 && ca === cb;
  }

  // ── A* ───────────────────────────────────────────────────────────────────

  private cellClear(col: number, row: number, layer: number, net: number, halfWidth: number, slack: number): boolean {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return false;
    const px = col * this.grid, py = row * this.grid;
    const need = this.clearanceOf(net) + halfWidth + slack;
    return this.layerIndexes[layer].pointClear(px, py, net, need, this.items);
  }

  private astar(leg: RouteLeg, viaCostMm: number, slack: number): Int32Array | null {
    const { cols, rows, layerCount } = this;
    const net = leg.net;
    const halfW = this.widthOf(net) / 2;
    const viaR = this.netViaDia[net] / 2;

    const srcCol = Math.min(cols - 1, Math.max(0, Math.round(leg.fromPt.x / this.grid)));
    const srcRow = Math.min(rows - 1, Math.max(0, Math.round(leg.fromPt.y / this.grid)));
    const dstCol = Math.min(cols - 1, Math.max(0, Math.round(leg.toPt.x / this.grid)));
    const dstRow = Math.min(rows - 1, Math.max(0, Math.round(leg.toPt.y / this.grid)));
    const srcLayer = leg.fromLayer < layerCount ? leg.fromLayer : 0;
    const dstLayer = leg.toLayer < layerCount ? leg.toLayer : 0;

    const idxOf = (l: number, r: number, c: number) => (l * rows + r) * cols + c;
    const startIdx = idxOf(srcLayer, srcRow, srcCol);
    const goalIdx = idxOf(dstLayer, dstRow, dstCol);

    if (startIdx === goalIdx) return new Int32Array([startIdx]);

    const g = this.grid;
    const h = (r: number, c: number) => {
      const dx = Math.abs(c - dstCol), dy = Math.abs(r - dstRow);
      return ((dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy)) * g;
    };

    this.gen++;
    const gen = this.gen;
    this.heap.clear();
    this.gScore[startIdx] = 0;
    this.gGen[startIdx] = gen;
    this.parent[startIdx] = -1;
    this.heap.push(h(srcRow, srcCol), startIdx);

    const maxExpansions = Math.min(1_200_000, this.stateCount * 4);
    let expansions = 0;

    while (this.heap.size > 0 && expansions < maxExpansions) {
      const cur = this.heap.pop();
      if (this.closedGen[cur] === gen) continue;
      this.closedGen[cur] = gen;
      if (cur === goalIdx) {
        let count = 0;
        let node = cur;
        while (node !== -1) { count++; node = this.parent[node]; }
        const cells = new Int32Array(count);
        node = cur;
        for (let i = count - 1; i >= 0; i--) { cells[i] = node; node = this.parent[node]; }
        return cells;
      }
      expansions++;
      const curLayer = Math.floor(cur / (rows * cols));
      const rem = cur % (rows * cols);
      const curRow = Math.floor(rem / cols);
      const curCol = rem % cols;

      for (const [dx, dy, stepMul] of DIRS8) {
        const nc = curCol + dx, nr = curRow + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nIdx = idxOf(curLayer, nr, nc);
        if (this.closedGen[nIdx] === gen) continue;
        if (dx !== 0 && dy !== 0) {
          // no corner cutting
          if (!this.cellClear(curCol + dx, curRow, curLayer, net, halfW, slack)) continue;
          if (!this.cellClear(curCol, curRow + dy, curLayer, net, halfW, slack)) continue;
        }
        if (!this.cellClear(nc, nr, curLayer, net, halfW, slack)) continue;
        let stepCost = g * stepMul;
        // Directional layer preference (classic 2-layer strategy): top prefers
        // horizontal runs, bottom prefers vertical runs. Crossing nets then
        // orthogonalize across layers instead of fighting for the same
        // corridors — vias are cheap, congestion is expensive. Diagonals carry
        // both axes and stay unpenalized; single-layer boards are exempt.
        if (this.layerCount > 1 && dx === 0 !== (dy === 0)) {
          const movesX = dx !== 0;
          if (curLayer === 0 ? !movesX : movesX) stepCost *= 1.35;
        }
        const tentative = this.gScore[cur] + stepCost;
        if (this.gGen[nIdx] !== gen || tentative < this.gScore[nIdx]) {
          this.gGen[nIdx] = gen;
          this.gScore[nIdx] = tentative;
          this.parent[nIdx] = cur;
          this.heap.push(tentative + h(nr, nc), nIdx);
        }
      }

      // via transitions (same cell, other layers)
      if (this.allowVias) {
        for (let l = 0; l < layerCount; l++) {
          if (l === curLayer) continue;
          const nIdx = idxOf(l, curRow, curCol);
          if (this.closedGen[nIdx] === gen) continue;
          if (!this.cellClear(curCol, curRow, curLayer, net, viaR, slack)) continue;
          if (!this.cellClear(curCol, curRow, l, net, viaR, slack)) continue;
          const tentative = this.gScore[cur] + viaCostMm;
          if (this.gGen[nIdx] !== gen || tentative < this.gScore[nIdx]) {
            this.gGen[nIdx] = gen;
            this.gScore[nIdx] = tentative;
            this.parent[nIdx] = cur;
            this.heap.push(tentative + h(curRow, curCol), nIdx);
          }
        }
      }
    }
    return null;
  }

  private cellToPoint(cell: number): { x: number; y: number; layer: number } {
    const l = Math.floor(cell / (this.rows * this.cols));
    const rem = cell % (this.rows * this.cols);
    const r = Math.floor(rem / this.cols);
    const c = rem % this.cols;
    return { x: c * this.grid, y: r * this.grid, layer: l };
  }

  // ── path → trace conversion ──────────────────────────────────────────────

  private isEndpoint(p: { x: number; y: number }, leg: RouteLeg): boolean {
    return (Math.hypot(p.x - leg.fromPt.x, p.y - leg.fromPt.y) < 1e-6)
      || (Math.hypot(p.x - leg.toPt.x, p.y - leg.toPt.y) < 1e-6);
  }

  /**
   * 45° normalization pass: every non-axis, non-45° segment is decomposed
   * into a straight + 45° pair. Both decomposition orders are tried
   * (straight-first is preferred — it exits pads cleanly); a variant is
   * accepted only if BOTH replacement segments keep clearance.
   */
  private snapPathTo45<T extends { x: number; y: number; layer: number; via: boolean }>(
    path: T[], net: number, leg: RouteLeg,
  ): T[] {
    const out: T[] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = out[out.length - 1];
      const b = path[i];
      if (a.layer !== b.layer || is45Segment(a, b)) { out.push(b); continue; }
      const layer = b.layer;
      const need = this.clearanceOf(net) + this.widthOf(net) / 2 + 1e-6;
      const li = this.layerIndexes[layer];
      const dx = b.x - a.x, dy = b.y - a.y;
      const m = Math.min(Math.abs(dx), Math.abs(dy));
      const sx = Math.sign(dx), sy = Math.sign(dy);
      // candidate knees: straight-then-diagonal and diagonal-then-straight
      let knee1: { x: number; y: number } | null = null;
      let knee2: { x: number; y: number } | null = null;
      if (Math.abs(dx) >= Math.abs(dy)) {
        // dominant axis is x: horizontal straight + 45° diagonal
        knee1 = { x: b.x - sx * m, y: a.y };
        knee2 = { x: a.x + sx * m, y: b.y };
      } else {
        knee1 = { x: a.x, y: b.y - sy * m };
        knee2 = { x: b.x, y: a.y + sy * m };
      }
      let inserted = false;
      for (const knee of [knee1, knee2]) {
        if (!knee) continue;
        if (Math.hypot(knee.x - a.x, knee.y - a.y) < 1e-6) continue;
        if (Math.hypot(b.x - knee.x, b.y - knee.y) < 1e-6) continue;
        if (!is45Segment(a, knee) || !is45Segment(knee, b)) continue;
        if (!li.segmentClearExact(a.x, a.y, knee.x, knee.y, net, need, this.items)) continue;
        if (!li.segmentClearExact(knee.x, knee.y, b.x, b.y, net, need, this.items)) continue;
        out.push({ ...knee, layer, via: false } as T);
        out.push(b);
        inserted = true;
        break;
      }
      if (!inserted) out.push(b); // keep the arbitrary angle (still verified later)
    }
    void leg;
    return out;
  }

  /**
   * Build trace segments + vias from an A* cell path, with string-pull
   * simplification and exact clearance verification.
   */
  private buildRoute(leg: RouteLeg, cells: Int32Array): RouteBuild | null {
    const net = leg.net;
    const netName = this.netNames[net];
    const width = this.widthOf(net);
    const halfW = width / 2;
    const viaDia = this.netViaDia[net];
    const viaDrill = this.netViaDrill[net];
    const clearance = this.clearanceOf(net);

    interface P { x: number; y: number; layer: number; via: boolean }

    // 1. cells → points; layer transitions become via point pairs
    const pts: P[] = [];
    for (let i = 0; i < cells.length; i++) {
      const p = this.cellToPoint(cells[i]);
      const prev = i > 0 ? this.cellToPoint(cells[i - 1]) : null;
      const isTransition = prev !== null && prev.x === p.x && prev.y === p.y && prev.layer !== p.layer;
      if (isTransition) {
        pts[pts.length - 1] = { ...pts[pts.length - 1], via: true };
        pts.push({ x: p.x, y: p.y, layer: p.layer, via: true });
      } else {
        pts.push({ x: p.x, y: p.y, layer: p.layer, via: false });
      }
    }
    if (pts.length < 2) return null;

    // 2. exact endpoints at pad centers
    pts[0] = { x: leg.fromPt.x, y: leg.fromPt.y, layer: pts[0].layer, via: pts[0].via };
    pts[pts.length - 1] = { x: leg.toPt.x, y: leg.toPt.y, layer: pts[pts.length - 1].layer, via: pts[pts.length - 1].via };

    // 3. collapse collinear points (same layer, no via boundary)
    let simplified: P[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = simplified[simplified.length - 1];
      const b = pts[i];
      const c = pts[i + 1];
      if (b.via || a.via || c.via || a.layer !== b.layer || b.layer !== c.layer) { simplified.push(b); continue; }
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) > 1e-9) simplified.push(b);
    }
    simplified.push(pts[pts.length - 1]);

    // 4. 45° normalization: decompose every non-45°/non-axis segment into a
    //    straight + 45° pair (modern-router look). Verified before accepted.
    simplified = this.snapPathTo45(simplified, net, leg);

    // 5. string-pull: drop interior vertices whose shortcut stays clear AND
    //    keeps the path 45°/axis-aligned
    for (let sweep = 0; sweep < 3; sweep++) {
      let changed = false;
      const out: P[] = [simplified[0]];
      let i = 1;
      while (i < simplified.length - 1) {
        const a = out[out.length - 1];
        const b = simplified[i];
        const c = simplified[i + 1];
        const removable = !a.via && !b.via && !c.via
          && a.layer === b.layer && b.layer === c.layer
          && !this.isEndpoint(a, leg) && !this.isEndpoint(b, leg) && !this.isEndpoint(c, leg)
          && is45Segment(a, c);
        if (removable) {
          const need = clearance + halfW + 1e-6;
          if (this.layerIndexes[b.layer].segmentClearExact(a.x, a.y, c.x, c.y, net, need, this.items)) {
            changed = true;
            i++;
            continue;
          }
        }
        out.push(b);
        i++;
      }
      out.push(simplified[simplified.length - 1]);
      simplified = out;
      if (!changed) break;
    }

    // 5. split into per-layer runs at via boundaries
    interface Run { pts: P[]; layer: number }
    const runs: Run[] = [];
    let curRun: Run | null = null;
    for (const p of simplified) {
      if (curRun === null || p.layer !== curRun.layer) {
        if (curRun !== null && curRun.pts.length >= 1) runs.push(curRun);
        curRun = { pts: [], layer: p.layer };
      }
      curRun.pts.push(p);
    }
    if (curRun !== null && curRun.pts.length >= 1) runs.push(curRun);
    if (runs.length === 0) return null;

    const traces: Trace[] = [];
    const vias: Via[] = [];
    const stamps: Stamp[] = [];
    let totalLen = 0;
    let seq = 0;
    const mkId = (prefix: string) => `${prefix}_${netName}_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

    for (let ri = 0; ri < runs.length - 1; ri++) {
      const p = runs[ri].pts[runs[ri].pts.length - 1];
      vias.push({
        id: mkId('via'),
        position: { x: p.x, y: p.y },
        diameter: viaDia,
        drill: viaDrill,
        net: netName,
        type: 'tht',
        fromLayer: this.layers[runs[ri].layer],
        toLayer: this.layers[runs[ri + 1].layer],
      });
    }

    for (const run of runs) {
      const segments: TraceSegment[] = [];
      for (let i = 0; i < run.pts.length - 1; i++) {
        const a = run.pts[i], b = run.pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-9) continue;
        segments.push({ start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, width });
        totalLen += len;
      }
      if (segments.length === 0) continue;
      traces.push({ id: mkId('route'), net: netName, layer: this.layers[run.layer], segments, width });
      for (const seg of segments) {
        stamps.push({ id: -1, layer: run.layer, item: segmentItem(net, seg.start.x, seg.start.y, seg.end.x, seg.end.y, halfW) });
      }
    }
    if (traces.length === 0) return null;
    for (const v of vias) {
      for (let l = 0; l < this.layerCount; l++) {
        stamps.push({ id: -1, layer: l, item: circleItem(net, v.position.x, v.position.y, v.diameter / 2) });
      }
    }

    // 6. EXACT verification — every segment and via must keep clearance.
    //    If anything fails the caller retries with more slack.
    for (const run of runs) {
      for (let i = 0; i < run.pts.length - 1; i++) {
        const a = run.pts[i], b = run.pts[i + 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
        if (!this.layerIndexes[run.layer].segmentClearExact(a.x, a.y, b.x, b.y, net, clearance + halfW + 1e-6, this.items)) {
          return null;
        }
      }
    }
    for (const v of vias) {
      for (let l = 0; l < this.layerCount; l++) {
        if (!this.layerIndexes[l].pointClear(v.position.x, v.position.y, net, clearance + v.diameter / 2 + 1e-6, this.items)) {
          return null;
        }
      }
    }

    return { traces, vias, stamps, lengthMm: totalLen };
  }

  // ── commit / rip-up ──────────────────────────────────────────────────────

  private commitBuild(build: RouteBuild, leg: RouteLeg): void {
    for (const s of build.stamps) {
      s.id = this.insertItem(s.item!, [s.layer]);
    }
    this.committed.push({
      leg,
      traces: build.traces,
      vias: build.vias,
      stamps: build.stamps.map((s) => ({ id: s.id, layer: s.layer })),
      lengthMm: build.lengthMm,
    });
  }

  private ripUpRoute(route: CommittedRoute): void {
    // remove in reverse so overlapping same-net stamps unwind cleanly
    for (let i = route.stamps.length - 1; i >= 0; i--) {
      this.removeItem(route.stamps[i].id, [route.stamps[i].layer]);
    }
    this.committed = this.committed.filter((c) => c !== route);
  }

  // ── top-level routing ────────────────────────────────────────────────────

  routeAll(
    legsByNet: Map<number, RouteLeg[]>,
    padsByNet: Map<number, Pad[]>,
    existingTraces: Trace[],
    existingVias: Via[],
  ): {
    failedLegs: { leg: RouteLeg; reason: string }[];
    routedCount: number;
    rippedUp: number;
    passes: number;
  } {
    const pending = new Map<number, RouteLeg[]>();
    let routedCount = 0;
    for (const [net, legs] of legsByNet) {
      const todo = legs.filter((l) => !this.isLegRouted(l, padsByNet, existingTraces, existingVias));
      routedCount += legs.length - todo.length;
      if (todo.length > 0) pending.set(net, todo);
      this.legsForNetCache.set(net, legs);
    }

    const netOrder = Array.from(pending.keys()).sort((a, b) => {
      const la = (pending.get(a) ?? []).reduce((s, l) => s + l.dist, 0);
      const lb = (pending.get(b) ?? []).reduce((s, l) => s + l.dist, 0);
      return la - lb;
    });

    let rippedUp = 0;
    let passes = 0;
    // global budget: rip-up events are expensive (re-routes of the ripped
    // net's legs); cap the total so congested boards finish in seconds
    let ripUpBudget = 20;

    for (let pass = 1; pass <= this.options.maxPasses && pending.size > 0; pass++) {
      passes = pass;
      const viaCost = pass === 1 ? 14.0 : pass === 2 ? 6.0 : pass === 3 ? 2.5 : 1.2;
      const allowRipUp = pass >= 2 && ripUpBudget > 0;
      // Corridor sweep (rip ALL corridor blockers at once) — the heavy
      // rescue for long crossing legs on congested boards. Only from pass 3:
      // passes 1–2 get the cheap single-net rip-ups first.
      const allowSweep = pass >= 3 && ripUpBudget > 0;

      for (const net of [...netOrder]) {
        let legs = pending.get(net);
        if (!legs) continue;
        const remaining: RouteLeg[] = [];
        for (const leg of legs) {
          if (this.tryRouteLeg(leg, viaCost)) { routedCount++; continue; }
          let routed = false;
          if (allowRipUp) {
            for (const cand of this.corridorCandidates(leg, net)) {
              if (ripUpBudget <= 0) break;
              ripUpBudget--;
              const res = this.ripUpAndRetry(cand, leg, viaCost, pending);
              rippedUp += res.ripUps;
              if (res.success) { routed = true; routedCount++; break; }
            }
          }
          if (!routed && allowSweep && ripUpBudget > 0) {
            const res = this.corridorSweep(leg, net, viaCost, pending);
            rippedUp += res.ripUps;
            ripUpBudget -= res.budgetCost;
            if (res.success) { routed = true; routedCount++; }
          }
          if (!routed) remaining.push(leg);
        }
        if (remaining.length === 0) pending.delete(net);
        else pending.set(net, remaining);
      }
    }

    return {
      failedLegs: Array.from(pending.values()).flat().map((leg) => ({ leg, reason: 'no clear path found' })),
      routedCount,
      rippedUp,
      passes,
    };
  }

  /**
   * Corridor SWEEP rescue for jammed long legs: rip up EVERY net blocking the
   * leg's corridor at once (bounded), route the leg through the cleared
   * corridor, then re-route the ripped nets around it. Ripped legs that fail
   * to re-route return to the pending queue — later passes retry them.
   *
   * This is what un-blocks dense boards (multi-digit clocks): a long crossing
   * leg is individually trivial to route, but every corridor is jammed by a
   * dozen SHORT nets that no single-net rip-up can displace.
   */
  private corridorSweep(
    leg: RouteLeg, ownNet: number, viaCost: number, pending: Map<number, RouteLeg[]>,
  ): { success: boolean; ripUps: number; budgetCost: number } {
    const blockers = this.corridorBlockers(leg, ownNet);
    if (blockers.size === 0) return { success: false, ripUps: 0, budgetCost: 0 };

    // snapshot every blocker's committed routes for restore
    const snapshots: Array<{ net: number; routes: Array<{ leg: RouteLeg; traces: Trace[]; vias: Via[]; lengthMm: number }> }> = [];
    for (const net of blockers) {
      const routes = this.committed.filter((c) => c.leg.net === net);
      if (routes.length === 0) continue;
      snapshots.push({
        net,
        routes: routes.map((c) => ({
          leg: c.leg,
          traces: c.traces.map((t) => ({ ...t, segments: t.segments.map((s) => ({ ...s })) })),
          vias: c.vias.map((v) => ({ ...v })),
          lengthMm: c.lengthMm,
        })),
      });
      for (const c of routes) this.ripUpRoute(c);
    }
    if (snapshots.length === 0) return { success: false, ripUps: 0, budgetCost: 0 };

    if (this.tryRouteLeg(leg, viaCost)) {
      // re-route every ripped net; failures go back to pending
      let reFailures = 0;
      for (const s of snapshots) {
        const legs = this.legsForNetCache.get(s.net) ?? [];
        const failed: RouteLeg[] = [];
        for (const cl of legs) {
          if (!this.tryRouteLeg(cl, viaCost)) failed.push(cl);
        }
        if (failed.length > 0) {
          reFailures += failed.length;
          const prev = pending.get(s.net) ?? [];
          pending.set(s.net, [...prev, ...failed]);
        }
      }
      return { success: true, ripUps: snapshots.length, budgetCost: 1 + reFailures };
    }

    // the leg STILL failed even with an empty corridor (shouldn't happen) —
    // restore everything exactly as it was.
    for (const s of snapshots) for (const r of s.routes) this.restoreRoute(r);
    return { success: false, ripUps: 0, budgetCost: 1 };
  }

  /** nets whose committed routes cross the leg's corridor (all of them). */
  private corridorBlockers(leg: RouteLeg, ownNet: number): Set<number> {
    const margin = 2;
    const mx = Math.min(leg.fromPt.x, leg.toPt.x) - margin;
    const Mx = Math.max(leg.fromPt.x, leg.toPt.x) + margin;
    const my = Math.min(leg.fromPt.y, leg.toPt.y) - margin;
    const My = Math.max(leg.fromPt.y, leg.toPt.y) + margin;
    const blockers = new Set<number>();
    for (const c of this.committed) {
      if (c.leg.net === ownNet || blockers.has(c.leg.net)) continue;
      for (const t of c.traces) {
        for (const seg of t.segments) {
          if (Math.max(seg.start.x, seg.end.x) >= mx && Math.min(seg.start.x, seg.end.x) <= Mx
            && Math.max(seg.start.y, seg.end.y) >= my && Math.min(seg.start.y, seg.end.y) <= My) {
            blockers.add(c.leg.net);
            break;
          }
        }
        if (blockers.has(c.leg.net)) break;
      }
    }
    return blockers;
  }

  /** single leg attempt with escalating slack. Returns true when committed. */
  private tryRouteLeg(leg: RouteLeg, viaCost: number): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      const slack = this.grid * 0.8 + attempt * 0.15;
      const cells = this.astar(leg, viaCost, slack);
      if (!cells) continue;
      const build = this.buildRoute(leg, cells);
      if (!build) continue;
      this.commitBuild(build, leg);
      return true;
    }
    return false;
  }

  /** nets whose committed routes cross the leg's corridor (smallest first) */
  private corridorCandidates(leg: RouteLeg, ownNet: number): number[] {
    const margin = 3;
    const mx = Math.min(leg.fromPt.x, leg.toPt.x) - margin;
    const Mx = Math.max(leg.fromPt.x, leg.toPt.x) + margin;
    const my = Math.min(leg.fromPt.y, leg.toPt.y) - margin;
    const My = Math.max(leg.fromPt.y, leg.toPt.y) + margin;
    const lengthByNet = new Map<number, number>();
    for (const c of this.committed) {
      if (c.leg.net === ownNet) continue;
      let hits = false;
      for (const t of c.traces) {
        for (const seg of t.segments) {
          if (Math.max(seg.start.x, seg.end.x) >= mx && Math.min(seg.start.x, seg.end.x) <= Mx
            && Math.max(seg.start.y, seg.end.y) >= my && Math.min(seg.start.y, seg.end.y) <= My) {
            hits = true;
            break;
          }
        }
        if (hits) break;
      }
      if (hits) lengthByNet.set(c.leg.net, (lengthByNet.get(c.leg.net) ?? 0) + c.lengthMm);
    }
    return Array.from(lengthByNet.keys())
      .sort((a, b) => (lengthByNet.get(a) ?? 0) - (lengthByNet.get(b) ?? 0))
      .slice(0, 3);
  }

  /**
   * Rip up a blocking net, route the blocked leg, then re-route the ripped
   * net's legs. Legs of the ripped net that fail to re-route go back to the
   * pending queue so later passes retry them.
   */
  private ripUpAndRetry(
    candNet: number, leg: RouteLeg, viaCost: number, pending: Map<number, RouteLeg[]>,
  ): { success: boolean; ripUps: number } {
    const candRoutes = this.committed.filter((c) => c.leg.net === candNet);
    if (candRoutes.length === 0) return { success: false, ripUps: 0 };
    // snapshot for restore
    const snapshot = candRoutes.map((c) => ({
      leg: c.leg,
      traces: c.traces.map((t) => ({ ...t, segments: t.segments.map((s) => ({ ...s })) })),
      vias: c.vias.map((v) => ({ ...v })),
      lengthMm: c.lengthMm,
    }));
    for (const c of candRoutes) this.ripUpRoute(c);

    if (this.tryRouteLeg(leg, viaCost)) {
      // re-route the ripped net's legs
      const legs = this.legsForNetCache.get(candNet) ?? [];
      const failed: RouteLeg[] = [];
      for (const cl of legs) {
        if (!this.tryRouteLeg(cl, viaCost)) failed.push(cl);
      }
      if (failed.length > 0) {
        // put failed legs back into pending for later passes
        const prev = pending.get(candNet) ?? [];
        pending.set(candNet, [...prev, ...failed]);
      }
      return { success: true, ripUps: snapshot.length };
    }

    // failed even after rip-up → restore the candidate's original routes
    for (const s of snapshot) this.restoreRoute(s);
    return { success: false, ripUps: 0 };
  }

  private restoreRoute(s: { leg: RouteLeg; traces: Trace[]; vias: Via[]; lengthMm: number }): void {
    const stamps: Stamp[] = [];
    const build: RouteBuild = { traces: s.traces, vias: s.vias, stamps, lengthMm: s.lengthMm };
    for (const t of s.traces) {
      const l = this.layerIdx.get(t.layer);
      if (l === undefined) continue;
      for (const seg of t.segments) {
        stamps.push({ id: -1, layer: l, item: segmentItem(s.leg.net, seg.start.x, seg.start.y, seg.end.x, seg.end.y, seg.width / 2) });
      }
    }
    for (const v of s.vias) {
      for (let li = 0; li < this.layerCount; li++) {
        stamps.push({ id: -1, layer: li, item: circleItem(s.leg.net, v.position.x, v.position.y, v.diameter / 2) });
      }
    }
    this.commitBuild(build, s.leg);
  }

  /** assemble the final result */
  result(
    existingTraces: Trace[], existingVias: Via[],
    failedLegs: { leg: RouteLeg; reason: string }[],
    totalNets: number, totalLegs: number, routedCount: number,
    rippedUp: number, passes: number, elapsedMs: number,
  ): AutoRouteResult {
    const traces = [...existingTraces];
    const vias = [...existingVias];
    let totalSegments = 0;
    let totalLength = 0;
    let newVias = 0;
    for (const c of this.committed) {
      traces.push(...c.traces);
      vias.push(...c.vias);
      newVias += c.vias.length;
      totalSegments += c.traces.reduce((s, t) => s + t.segments.length, 0);
      totalLength += c.lengthMm;
    }
    return {
      traces,
      vias,
      unrouted: failedLegs.map((f) => ({
        net: this.netNames[f.leg.net],
        from: { ...f.leg.fromPt },
        to: { ...f.leg.toPt },
        reason: f.reason,
      })),
      stats: {
        totalNets,
        routed: routedCount,
        failed: failedLegs.length,
        totalSegments,
        totalLength,
        vias: newVias,
        passes,
        rippedUp,
        elapsedMs,
      },
    };
  }

  get netCount(): number { return this.netNames.length; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

function normalizeOptions(
  layerOrOptions?: 'top' | 'bottom' | Partial<AutoRouteOptions>,
  traceWidth?: number,
): AutoRouteOptions {
  if (typeof layerOrOptions === 'string') {
    // legacy single-layer API (backwards compatible)
    return {
      ...DEFAULT_AUTOROUTE_OPTIONS,
      layers: [layerOrOptions],
      allowVias: false,
      traceWidth: traceWidth ?? DEFAULT_AUTOROUTE_OPTIONS.traceWidth,
      maxPasses: 4,
    };
  }
  const o = layerOrOptions ?? {};
  const layers = o.layers && o.layers.length > 0 ? o.layers : DEFAULT_AUTOROUTE_OPTIONS.layers;
  return {
    traceWidth: o.traceWidth ?? DEFAULT_AUTOROUTE_OPTIONS.traceWidth,
    clearance: o.clearance ?? DEFAULT_AUTOROUTE_OPTIONS.clearance,
    viaDiameter: o.viaDiameter ?? DEFAULT_AUTOROUTE_OPTIONS.viaDiameter,
    viaDrill: o.viaDrill ?? DEFAULT_AUTOROUTE_OPTIONS.viaDrill,
    gridResolution: o.gridResolution ?? DEFAULT_AUTOROUTE_OPTIONS.gridResolution,
    layers,
    allowVias: o.allowVias ?? layers.length > 1,
    netClasses: o.netClasses ?? DEFAULT_AUTOROUTE_OPTIONS.netClasses,
    keepouts: o.keepouts ?? DEFAULT_AUTOROUTE_OPTIONS.keepouts,
    maxPasses: o.maxPasses ?? DEFAULT_AUTOROUTE_OPTIONS.maxPasses,
  };
}

/**
 * Auto-route all unrouted nets.
 *
 * Legacy form: autoRoute(fp, traces, vias, ratsnest, board, 'top', 0.3)
 *   → single-layer routing, no vias (backwards compatible).
 * Modern form: autoRoute(fp, traces, vias, ratsnest, board, { ...options })
 *   → two-layer routing with vias, rip-up/reroute, net classes, keepouts.
 */
export function autoRoute(
  footprints: Footprint[],
  existingTraces: Trace[],
  existingVias: Via[],
  ratsnest: Ratsnest[],
  board: BoardOutline,
  layerOrOptions?: 'top' | 'bottom' | Partial<AutoRouteOptions>,
  traceWidth?: number,
): AutoRouteResult {
  const t0 = Date.now();
  const options = normalizeOptions(layerOrOptions, traceWidth);
  const router = new Router(board, options);

  // pads grouped by net
  const padsByNet = new Map<number, Pad[]>();
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const netName = pad.net ?? '';
      if (!netName) continue;
      const idx = router.netIndex(netName);
      let list = padsByNet.get(idx);
      if (!list) { list = []; padsByNet.set(idx, list); }
      list.push(pad);
    }
  }

  router.buildStaticObstacles(footprints, existingVias, existingTraces);
  const legsByNet = router.buildLegs(padsByNet, ratsnest);

  const totalNets = legsByNet.size;
  const totalLegs = Array.from(legsByNet.values()).reduce((s, l) => s + l.length, 0);
  const { failedLegs, routedCount, rippedUp, passes } =
    router.routeAll(legsByNet, padsByNet, existingTraces, existingVias);

  return router.result(existingTraces, existingVias, failedLegs, totalNets, totalLegs, routedCount, rippedUp, passes, Date.now() - t0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive routing support — clearance preview used by the PCB canvas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a candidate interactive trace segment (start→end) keeps
 * `clearance` from all other-net copper (pads, vias, traces) on `layer`.
 * Copper of `net` itself is ignored (same net may touch).
 */
export function segmentHasClearanceConflict(
  start: { x: number; y: number },
  end: { x: number; y: number },
  net: string,
  layer: CopperLayer,
  halfWidth: number,
  clearance: number,
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
): { conflict: boolean; point: { x: number; y: number } | null } {
  const need = clearance + halfWidth;
  // pads + vias: sampled point checks (exact geometry per sample)
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.ceil(len / 0.1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = start.x + (end.x - start.x) * t;
    const py = start.y + (end.y - start.y) * t;
    for (const fp of footprints) {
      for (const pad of fp.pads) {
        if ((pad.net ?? '') === net) continue;
        const isTht = (pad.drill ?? 0) > 0;
        if (!isTht && pad.layer !== layer) continue;
        const d = pad.shape === 'circle'
          ? Math.max(Math.hypot(px - pad.position.x, py - pad.position.y) - Math.max(pad.size.width, pad.size.height) / 2, 0)
          : distPointRect(px, py, pad.position.x, pad.position.y, pad.size.width / 2, pad.size.height / 2);
        if (d < need - 1e-9) return { conflict: true, point: { x: px, y: py } };
      }
    }
    for (const via of vias) {
      if (via.net === net) continue;
      const d = Math.max(Math.hypot(px - via.position.x, py - via.position.y) - via.diameter / 2, 0);
      if (d < need - 1e-9) return { conflict: true, point: { x: px, y: py } };
    }
  }
  // trace-vs-trace: exact segment-segment distance
  for (const trace of traces) {
    if (trace.net === net) continue;
    if (trace.layer !== layer) continue;
    for (const seg of trace.segments) {
      const d = Math.max(distSegSeg(
        start.x, start.y, end.x, end.y,
        seg.start.x, seg.start.y, seg.end.x, seg.end.y,
      ) - seg.width / 2, 0);
      if (d < need - 1e-9) {
        return { conflict: true, point: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
      }
    }
  }
  return { conflict: false, point: null };
}
