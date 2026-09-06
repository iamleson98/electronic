// Copper pour (ground plane) generation.
// Creates a filled copper area on a layer with clearance around pads and traces.
// Uses a grid-based fill approach — simple but effective for visualization.

import type { Footprint, Trace, Via, Pad, BoardOutline } from './types';

export interface CopperPour {
  layer: 'top' | 'bottom';
  net: string;
  /** grid cells that are filled (x, y in 0.5mm grid) */
  cells: { x: number; y: number }[];
  /** cell size in mm */
  cellSize: number;
  /** thermal relief pads (same-net pads that need spoke connections) */
  thermalPads?: { pos: { x: number; y: number }; spokeWidth: number; padRadius: number }[];
  /** zone priority — higher wins where pours overlap (default 0) */
  priority?: number;
  /** thermal spoke width in mm (default 0.3) */
  spokeWidth?: number;
  /** clearance to foreign copper in mm (default 0.3) */
  clearance?: number;
  /** remove isolated islands with no same-net connection (default true) */
  removeIslands?: boolean;
}

/**
 * Generate a copper pour on a layer for a given net.
 * Fills the entire board area except around pads/traces on different nets.
 * Same-net pads get a thermal relief pattern (4 spokes) instead of being
 * fully covered, so they can be soldered without thermal mass issues.
 *
 * @param layer Which copper layer to pour on
 * @param net The net name for the pour (e.g. "GND")
 * @param footprints All footprints on the board
 * @param traces All traces on the board
 * @param vias All vias on the board
 * @param board Board dimensions
 * @param clearance Clearance around non-net features in mm
 * @param options.thermalRelief When true, same-net pads get a 4-spoke thermal relief pattern
 */
export function generateCopperPour(
  layer: 'top' | 'bottom',
  net: string,
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  clearance: number = 0.3,
  options: { thermalRelief?: boolean; priority?: number; spokeWidth?: number; removeIslands?: boolean } = {},
): CopperPour {
  const cellSize = 0.5; // mm per cell
  const cols = Math.ceil(board.width / cellSize);
  const rows = Math.ceil(board.height / cellSize);
  const thermalPads: { pos: { x: number; y: number }; spokeWidth: number; padRadius: number }[] = [];
  const thermalRelief = options.thermalRelief ?? true; // default on

  // Collect features to avoid (different net, same layer)
  interface AvoidFeature {
    pos: { x: number; y: number };
    radius: number;
  }
  const avoidPoints: AvoidFeature[] = [];

  // Same-net pads (need thermal relief: keep a small gap around the pad,
  // then add 4 spokes connecting the pad to the pour)
  const sameNetPads: { pos: { x: number; y: number }; radius: number }[] = [];

  // Pads — same net get thermal relief, different net get clearance.
  // THT pads (drill > 0) have copper on BOTH layers and must be avoided on
  // both; SMD pads only on their own side.
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) <= 0 && pad.layer !== layer && fp.side !== layer) continue;
      const padR = Math.max(pad.size.width, pad.size.height) / 2;
      if (pad.net === net) {
        // Same net — thermal relief: avoid pad + small gap, but add spokes
        const gapR = padR + 0.3; // 0.3mm gap, then spokes
        avoidPoints.push({ pos: pad.position, radius: gapR });
        if (thermalRelief) {
          sameNetPads.push({ pos: pad.position, radius: padR });
          thermalPads.push({
            pos: pad.position,
            spokeWidth: 0.3, // 0.3mm wide spokes
            padRadius: padR,
          });
        }
      } else {
        // Different net — clearance
        avoidPoints.push({ pos: pad.position, radius: padR + clearance });
      }
    }
  }

  // Vias on different nets
  for (const via of vias) {
    if (via.net === net) continue;
    avoidPoints.push({ pos: via.position, radius: via.diameter / 2 + clearance });
  }

  // Trace segments on different nets
  interface AvoidSeg {
    start: { x: number; y: number };
    end: { x: number; y: number };
    width: number;
  }
  const avoidSegs: AvoidSeg[] = [];
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    if (trace.net === net) continue;
    for (const seg of trace.segments) {
      avoidSegs.push({
        start: seg.start,
        end: seg.end,
        width: seg.width / 2 + clearance,
      });
    }
  }

  // Build a set of "spoke cells" — cells that should be filled even though
  // they're inside the thermal relief gap (because they're on a spoke).
  // Spokes are 4 line segments from the pad center outward in cardinal directions,
  // each 0.3mm wide, length = gap distance (0.3mm here).
  const spokeCells = new Set<string>();
  for (const sp of sameNetPads) {
    const gap = 0.3;
    const spokeLen = gap + 0.2; // slight overlap with pour
    // 4 cardinal spokes (N, S, E, W)
    const spokes = [
      { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
      { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
    ];
    for (const s of spokes) {
      // Walk along the spoke from padRadius to padRadius + spokeLen
      const steps = Math.ceil(spokeLen / (cellSize * 0.25));
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * spokeLen + sp.radius;
        const px = sp.pos.x + s.dx * t;
        const py = sp.pos.y + s.dy * t;
        // Mark cells within spokeWidth of (px, py)
        const r = 0.15; // half of spokeWidth
        const minCol = Math.floor((px - r) / cellSize);
        const maxCol = Math.ceil((px + r) / cellSize);
        const minRow = Math.floor((py - r) / cellSize);
        const maxRow = Math.ceil((py + r) / cellSize);
        for (let row = minRow; row <= maxRow; row++) {
          for (let col = minCol; col <= maxCol; col++) {
            const cx = (col + 0.5) * cellSize;
            const cy = (row + 0.5) * cellSize;
            if (Math.hypot(cx - px, cy - py) < r) {
              spokeCells.add(`${col},${row}`);
            }
          }
        }
      }
    }
  }

  // Fill grid cells
  const filledCells: { col: number; row: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = (col + 0.5) * cellSize;
      const cy = (row + 0.5) * cellSize;

      // If this is a spoke cell, fill it (thermal relief connection)
      if (spokeCells.has(`${col},${row}`)) {
        filledCells.push({ col, row });
        continue;
      }

      // Check if too close to any avoid point
      let avoid = false;
      for (const ap of avoidPoints) {
        const dx = cx - ap.pos.x;
        const dy = cy - ap.pos.y;
        if (dx * dx + dy * dy < ap.radius * ap.radius) {
          avoid = true;
          break;
        }
      }
      if (avoid) continue;

      // Check if too close to any avoid segment
      for (const seg of avoidSegs) {
        const dist = pointToSegDist(cx, cy, seg.start.x, seg.start.y, seg.end.x, seg.end.y);
        if (dist < seg.width) {
          avoid = true;
          break;
        }
      }
      if (avoid) continue;

      // Cell is clear — fill it
      filledCells.push({ col, row });
    }
  }

  // ── Island removal ──────────────────────────────────────────────────────
  // Keep only the copper that is actually connected to the pour net (via
  // same-net pads or their thermal spokes). Isolated islands of fill are a
  // manufacturing/reliability hazard and every real EDA tool removes them.
  // If there are no same-net anchors on this layer there is nothing to
  // measure connectivity against — keep the fill as before.
  let keptCells = filledCells;
  if (sameNetPads.length > 0) {
    const filled = new Set<string>();
    for (const c of filledCells) filled.add(`${c.col},${c.row}`);

    // Seeds: spoke cells + every filled cell touching a same-net pad's
    // thermal-relief neighbourhood (padRadius + spoke + one cell).
    const seeds: string[] = [];
    for (const key of spokeCells) {
      if (filled.has(key)) seeds.push(key);
    }
    for (const sp of sameNetPads) {
      const anchorR = sp.radius + 0.5 + cellSize; // gap + spoke + 1 cell
      const c0 = Math.floor((sp.pos.x - anchorR) / cellSize);
      const c1 = Math.ceil((sp.pos.x + anchorR) / cellSize);
      const r0 = Math.floor((sp.pos.y - anchorR) / cellSize);
      const r1 = Math.ceil((sp.pos.y + anchorR) / cellSize);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = `${c},${r}`;
          if (!filled.has(key)) continue;
          const cx = (c + 0.5) * cellSize;
          const cy = (r + 0.5) * cellSize;
          if (Math.hypot(cx - sp.pos.x, cy - sp.pos.y) <= anchorR) seeds.push(key);
        }
      }
    }

    // Flood fill (8-connected) from the seeds
    const connected = new Set<string>();
    const stack = [...seeds];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (connected.has(key)) continue;
      connected.add(key);
      const [c, r] = key.split(',').map(Number);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nk = `${c + dc},${r + dr}`;
          if (filled.has(nk) && !connected.has(nk)) stack.push(nk);
        }
      }
    }

    keptCells = filledCells.filter((c) => connected.has(`${c.col},${c.row}`));
  }

  const cells = keptCells.map((c) => ({ x: (c.col + 0.5) * cellSize, y: (c.row + 0.5) * cellSize }));

  return {
    layer, net, cells, cellSize, thermalPads,
    priority: options.priority ?? 0,
    spokeWidth: 0.3,
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
