// Copper pour (ground plane) generation.
// Creates a filled copper area on a layer with clearance around pads and traces.
// Uses a grid-based fill approach — simple but effective for visualization.

import type { Footprint, Trace, Via, Pad, BoardOutline, CopperLayer } from './types';

export interface CopperPour {
  layer: CopperLayer;
  net: string;
  /** grid cells that are filled (x, y in 0.5mm grid) */
  cells: { x: number; y: number }[];
  /** cell size in mm */
  cellSize: number;
  /** thermal relief pads (same-net pads that need spoke connections) */
  thermalPads?: { pos: { x: number; y: number }; spokeWidth: number; padRadius: number; /** cardinal spokes that reach filled copper */ spokes?: number }[];
  /** zone priority — higher wins where pours overlap (default 0) */
  priority?: number;
  /** thermal spoke width in mm (default 0.3) */
  spokeWidth?: number;
  /** clearance to foreign copper in mm (default 0.3) */
  clearance?: number;
  /** remove isolated islands with no same-net connection (default true) */
  removeIslands?: boolean;
  /** inset of the pour from the board outline in mm (default 0.3) */
  edgeClearance?: number;
}

type Pt = { x: number; y: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

function rectRectDist(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}
function pointRectDist(p: Pt, r: Rect): number {
  return Math.hypot(Math.max(0, r.x0 - p.x, p.x - r.x1), Math.max(0, r.y0 - p.y, p.y - r.y1));
}
function segsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
/** exact distance between a segment and an axis-aligned rect (0 if they touch) */
function segRectDist(a: Pt, b: Pt, r: Rect): number {
  const inside = (p: Pt) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  if (inside(a) || inside(b)) return 0;
  const c: Pt[] = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  let best = Math.min(pointRectDist(a, r), pointRectDist(b, r));
  for (let i = 0; i < 4; i++) {
    const e0 = c[i], e1 = c[(i + 1) % 4];
    if (segsIntersect(a, b, e0, e1)) return 0;
    best = Math.min(best, pointToSegDist(e0.x, e0.y, a.x, a.y, b.x, b.y));
  }
  return best;
}

/**
 * Generate a copper pour on a layer for a given net.
 *
 * Raster fill on a `cellSize` grid (0.25 mm). Every cell is tested by its FULL
 * extent (the cell rectangle against the exact obstacle shape), so the real
 * gap between poured copper and any foreign-net copper is >= `clearance`
 * (the old centre-only test left only ~0.05 mm with a 0.3 mm rule). The pour
 * is inset from the board outline by `edgeClearance`. Same-net pads get four
 * cardinal thermal spokes that start inside the pad copper and cross the
 * relief gap into filled cells, so the exported pour overlaps the pad. Fill
 * that is not 4-connected to same-net copper (spokes, same-net traces/vias)
 * is removed as an island.
 *
 * Options: `thermalRelief: false` = direct (solid) connection to same-net pads.
 */
export function generateCopperPour(
  layer: CopperLayer,
  net: string,
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  clearance: number = 0.3,
  options: { thermalRelief?: boolean; priority?: number; spokeWidth?: number; removeIslands?: boolean; edgeClearance?: number; cellSize?: number; keepouts?: { rect: { x: number; y: number; width: number; height: number }; layers: 'all' | string[]; polygon?: { x: number; y: number }[] }[] } = {},
): CopperPour {
  const cellSize = options.cellSize ?? 0.25; // mm per cell
  const edge = options.edgeClearance ?? 0.3;
  const spokeW = options.spokeWidth ?? 0.3;
  const thermalGap = 0.3;
  const thermalRelief = options.thermalRelief ?? true; // default on
  const cols = Math.ceil(board.width / cellSize);
  const rows = Math.ceil(board.height / cellSize);
  const N = cols * rows;
  const idx = (c: number, r: number) => r * cols + c;
  const cellRect = (c: number, r: number): Rect => ({ x0: c * cellSize, y0: r * cellSize, x1: (c + 1) * cellSize, y1: (r + 1) * cellSize });
  const eps = 1e-9;

  const foreign = new Uint8Array(N);   // violates clearance / edge / keepout
  const gap = new Uint8Array(N);       // inside a same-net pad's thermal gap
  const spoke = new Uint8Array(N);     // on a thermal spoke
  const anchor = new Uint8Array(N);    // overlaps same-net copper

  /** visit cells whose rect could be within `reach` of bbox, mark where dist(cellRect) < limit */
  const mark = (arr: Uint8Array, bb: Rect, reach: number, distFn: (r: Rect) => number, limit: number) => {
    const c0 = Math.max(0, Math.floor((bb.x0 - reach) / cellSize));
    const c1 = Math.min(cols - 1, Math.floor((bb.x1 + reach) / cellSize));
    const r0 = Math.max(0, Math.floor((bb.y0 - reach) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((bb.y1 + reach) / cellSize));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (distFn(cellRect(c, r)) < limit - eps) arr[idx(c, r)] = 1;
    }
  };
  const padRect = (pad: Pad): Rect => ({
    x0: pad.position.x - pad.size.width / 2, y0: pad.position.y - pad.size.height / 2,
    x1: pad.position.x + pad.size.width / 2, y1: pad.position.y + pad.size.height / 2,
  });
  /** distance from a cell rect to a pad's copper (circle exact, others by bbox) */
  const padDist = (pad: Pad) => {
    if (pad.shape === 'circle') {
      const rad = Math.max(pad.size.width, pad.size.height) / 2;
      return (r: Rect) => pointRectDist(pad.position, r) - rad;
    }
    const pr = padRect(pad);
    return (r: Rect) => rectRectDist(r, pr);
  };

  // Board edge inset: the cell must lie fully inside the outline minus edge clearance.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cr = cellRect(c, r);
    if (cr.x0 < edge - eps || cr.y0 < edge - eps || cr.x1 > board.width - edge + eps || cr.y1 > board.height - edge + eps) foreign[idx(c, r)] = 1;
  }

  const sameNetPads: Pad[] = [];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      // THT pads have copper on every layer; SMD only on their own side.
      if ((pad.drill ?? 0) <= 0 && pad.layer !== layer) continue;
      const rad = pad.shape === 'circle' ? Math.max(pad.size.width, pad.size.height) / 2 : 0;
      const bb = padRect(pad);
      if (pad.net === net) {
        sameNetPads.push(pad);
        mark(anchor, bb, rad + eps, padDist(pad), 1e-6);
        if (thermalRelief) mark(gap, bb, thermalGap + rad, padDist(pad), thermalGap);
      } else {
        mark(foreign, bb, clearance + rad, padDist(pad), clearance);
      }
    }
  }
  for (const via of vias) {
    const vr = via.diameter / 2;
    const bb = { x0: via.position.x - vr, y0: via.position.y - vr, x1: via.position.x + vr, y1: via.position.y + vr };
    const d = (r: Rect) => pointRectDist(via.position, r) - vr;
    if (via.net === net) mark(anchor, bb, 0, d, 1e-6);
    else mark(foreign, bb, clearance, d, clearance);
  }
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    for (const seg of trace.segments) {
      const bb = { x0: Math.min(seg.start.x, seg.end.x), y0: Math.min(seg.start.y, seg.end.y), x1: Math.max(seg.start.x, seg.end.x), y1: Math.max(seg.start.y, seg.end.y) };
      const d = (r: Rect) => segRectDist(seg.start, seg.end, r) - seg.width / 2;
      if (trace.net === net) mark(anchor, bb, seg.width / 2, d, 1e-6);
      else mark(foreign, bb, clearance + seg.width / 2, d, clearance);
    }
  }

  // Keepouts (rect + polygon) on this layer carve the pour (full cell extent).
  for (const k of options.keepouts ?? []) {
    if (k.layers !== 'all' && !(k.layers as string[]).includes(layer)) continue;
    if (k.polygon && k.polygon.length >= 3) {
      const poly = k.polygon;
      const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
      const bb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const pip = (x: number, y: number) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          if ((poly[i].y > y) !== (poly[j].y > y) && x < ((poly[j].x - poly[i].x) * (y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) inside = !inside;
        }
        return inside;
      };
      mark(foreign, bb, 0, (r) => {
        if (pip((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2) || pip(r.x0, r.y0) || pip(r.x1, r.y0) || pip(r.x0, r.y1) || pip(r.x1, r.y1)) return -1;
        for (let i = 0; i < poly.length; i++) if (segRectDist(poly[i], poly[(i + 1) % poly.length], r) === 0) return -1;
        return 1;
      }, 0);
    } else {
      const kr = { x0: k.rect.x, y0: k.rect.y, x1: k.rect.x + k.rect.width, y1: k.rect.y + k.rect.height };
      mark(foreign, kr, 0, (r) => (rectRectDist(r, kr) === 0 ? -1 : 1), 0);
    }
  }

  // Thermal spokes: 4 cardinal rects starting INSIDE the pad copper and
  // crossing the relief gap (+1 cell), so they touch both pad and pour.
  const spokesPerPad: { dir: number; cells: number[] }[][] = [];
  for (const pad of sameNetPads) {
    const list: { dir: number; cells: number[] }[] = [];
    if (thermalRelief) {
      const hw = pad.size.width / 2, hh = pad.size.height / 2;
      const rad = Math.max(hw, hh);
      const dirs = [{ dx: 1, dy: 0, e: pad.shape === 'circle' ? rad : hw }, { dx: -1, dy: 0, e: pad.shape === 'circle' ? rad : hw },
        { dx: 0, dy: 1, e: pad.shape === 'circle' ? rad : hh }, { dx: 0, dy: -1, e: pad.shape === 'circle' ? rad : hh }];
      dirs.forEach((d, di) => {
        const a = Math.max(0, d.e - 0.1), b = d.e + thermalGap + cellSize;
        const p0 = { x: pad.position.x + d.dx * a, y: pad.position.y + d.dy * a };
        const p1 = { x: pad.position.x + d.dx * b, y: pad.position.y + d.dy * b };
        const sr: Rect = {
          x0: Math.min(p0.x, p1.x) - (d.dy !== 0 ? spokeW / 2 : 0), x1: Math.max(p0.x, p1.x) + (d.dy !== 0 ? spokeW / 2 : 0),
          y0: Math.min(p0.y, p1.y) - (d.dx !== 0 ? spokeW / 2 : 0), y1: Math.max(p0.y, p1.y) + (d.dx !== 0 ? spokeW / 2 : 0),
        };
        const cells: number[] = [];
        const c0 = Math.max(0, Math.floor(sr.x0 / cellSize)), c1 = Math.min(cols - 1, Math.floor(sr.x1 / cellSize));
        const r0 = Math.max(0, Math.floor(sr.y0 / cellSize)), r1 = Math.min(rows - 1, Math.floor(sr.y1 / cellSize));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (rectRectDist(cellRect(c, r), sr) < eps) { cells.push(idx(c, r)); }
        }
        // a spoke is usable only if EVERY cell of it clears foreign copper
        if (cells.length && cells.every((i) => !foreign[i])) {
          for (const i of cells) { spoke[i] = 1; anchor[i] = 1; }
          list.push({ dir: di, cells });
        }
      });
    }
    spokesPerPad.push(list);
  }

  const filled = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!foreign[i] && (!gap[i] || spoke[i])) filled[i] = 1;

  // Island removal: keep only 4-connected fill reachable from cells that
  // actually overlap same-net copper (spokes / direct pad overlap / traces / vias).
  const hasAnchors = sameNetPads.length > 0 || anchor.some((v) => v === 1);
  let kept = filled;
  if (hasAnchors && (options.removeIslands ?? true)) {
    kept = new Uint8Array(N);
    const stack: number[] = [];
    for (let i = 0; i < N; i++) if (filled[i] && anchor[i]) { kept[i] = 1; stack.push(i); }
    while (stack.length) {
      const i = stack.pop()!;
      const c = i % cols, r = (i - c) / cols;
      const nb = [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1];
      for (const n of nb) if (n >= 0 && filled[n] && !kept[n]) { kept[n] = 1; stack.push(n); }
    }
  }

  const cells: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (kept[idx(c, r)]) cells.push({ x: (c + 0.5) * cellSize, y: (r + 0.5) * cellSize });
  }

  const thermalPads: NonNullable<CopperPour['thermalPads']> = [];
  if (thermalRelief) {
    sameNetPads.forEach((pad, i) => {
      thermalPads.push({
        pos: pad.position, spokeWidth: spokeW, padRadius: Math.max(pad.size.width, pad.size.height) / 2,
        spokes: spokesPerPad[i].filter((sp) => sp.cells.every((ci) => kept[ci])).length,
      });
    });
  }

  return {
    layer, net, cells, cellSize, thermalPads,
    priority: options.priority ?? 0,
    spokeWidth: spokeW,
    clearance,
    removeIslands: true,
  };
}

function pointToSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
