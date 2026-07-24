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
}

/**
 * Generate a copper pour on a layer for a given net.
 * Fills the entire board area except around pads/traces on different nets.
 *
 * @param layer Which copper layer to pour on
 * @param net The net name for the pour (e.g. "GND")
 * @param footprints All footprints on the board
 * @param traces All traces on the board
 * @param vias All vias on the board
 * @param board Board dimensions
 * @param clearance Clearance around non-net features in mm
 */
export function generateCopperPour(
  layer: 'top' | 'bottom',
  net: string,
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  clearance: number = 0.3,
): CopperPour {
  const cellSize = 0.5; // mm per cell
  const cols = Math.ceil(board.width / cellSize);
  const rows = Math.ceil(board.height / cellSize);
  const cells: { x: number; y: number }[] = [];

  // Collect features to avoid (different net, same layer)
  interface AvoidFeature {
    pos: { x: number; y: number };
    radius: number;
  }
  const avoidPoints: AvoidFeature[] = [];

  // Pads on different nets
  for (const fp of footprints) {
    if (fp.side !== layer) continue;
    for (const pad of fp.pads) {
      if (pad.net === net) continue; // same net, don't avoid
      const r = Math.max(pad.size.width, pad.size.height) / 2 + clearance;
      avoidPoints.push({ pos: pad.position, radius: r });
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

  // Fill grid cells
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = (col + 0.5) * cellSize;
      const cy = (row + 0.5) * cellSize;

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
      cells.push({ x: cx, y: cy });
    }
  }

  return { layer, net, cells, cellSize };
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
