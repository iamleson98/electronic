// Design Rule Check (DRC) engine for PCB layout.
// Checks for common PCB manufacturing issues:
// - Trace-to-trace clearance violations (shorts)
// - Trace-to-pad clearance violations
// - Pad-to-pad clearance violations
// - Unrouted nets (pads connected by ratsnest but no trace)
// - Traces outside board boundary

import type { Footprint, Trace, Via, Ratsnest, Pad, BoardOutline } from './types';

export interface DRCError {
  type: 'clearance' | 'short' | 'unrouted' | 'outside_board' | 'overlap';
  severity: 'error' | 'warning';
  message: string;
  position: { x: number; y: number };
  layer: 'top' | 'bottom' | 'both';
}

export interface DRCConfig {
  /** minimum clearance between copper features in mm */
  minClearance: number;
  /** minimum trace width in mm */
  minTraceWidth: number;
  /** minimum drill size for vias in mm */
  minDrillSize: number;
}

export const DEFAULT_DRC_CONFIG: DRCConfig = {
  minClearance: 0.2,
  minTraceWidth: 0.15,
  minDrillSize: 0.3,
};

/**
 * Run a full DRC check on the PCB layout.
 */
export function runDRC(
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  ratsnest: Ratsnest[],
  board: BoardOutline,
  config: DRCConfig = DEFAULT_DRC_CONFIG,
): DRCError[] {
  const errors: DRCError[] = [];

  // 1. Check unrouted nets
  const routedNets = new Set<string>();
  for (const trace of traces) {
    routedNets.add(trace.net);
  }
  for (const rn of ratsnest) {
    if (!routedNets.has(rn.net)) {
      errors.push({
        type: 'unrouted',
        severity: 'warning',
        message: `Net "${rn.net}" is unrouted`,
        position: { x: (rn.from.x + rn.to.x) / 2, y: (rn.from.y + rn.to.y) / 2 },
        layer: 'both',
      });
    }
  }

  // 2. Collect all copper segments with their nets
  interface CopperSeg {
    start: { x: number; y: number };
    end: { x: number; y: number };
    width: number;
    net: string;
    layer: 'top' | 'bottom';
    source: string; // trace id
  }
  const copperSegs: CopperSeg[] = [];
  for (const trace of traces) {
    for (const seg of trace.segments) {
      copperSegs.push({
        start: seg.start,
        end: seg.end,
        width: seg.width,
        net: trace.net,
        layer: trace.layer,
        source: trace.id,
      });
    }
  }

  // 3. Collect all pads with their nets
  interface CopperPad {
    pos: { x: number; y: number };
    size: { width: number; height: number };
    net: string;
    layer: 'top' | 'bottom';
    id: string;
  }
  const copperPads: CopperPad[] = [];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      copperPads.push({
        pos: pad.position,
        size: pad.size,
        net: pad.net ?? '',
        layer: pad.layer,
        id: pad.id,
      });
    }
  }

  // 4. Check trace-to-trace clearance (different nets, same layer)
  for (let i = 0; i < copperSegs.length; i++) {
    for (let j = i + 1; j < copperSegs.length; j++) {
      const a = copperSegs[i];
      const b = copperSegs[j];
      if (a.layer !== b.layer) continue; // different layers, no conflict
      if (a.net === b.net) continue; // same net, OK
      const dist = segToSegDistance(a.start, a.end, b.start, b.end);
      const minDist = dist - (a.width + b.width) / 2;
      if (minDist < config.minClearance) {
        const mid = {
          x: (a.start.x + a.end.x + b.start.x + b.end.x) / 4,
          y: (a.start.y + a.end.y + b.start.y + b.end.y) / 4,
        };
        errors.push({
          type: minDist < 0 ? 'short' : 'clearance',
          severity: minDist < 0 ? 'error' : 'warning',
          message: minDist < 0
            ? `Short circuit between nets "${a.net}" and "${b.net}"`
            : `Clearance violation: ${minDist.toFixed(3)}mm < ${config.minClearance}mm`,
          position: mid,
          layer: a.layer,
        });
      }
    }
  }

  // 5. Check trace-to-pad clearance (different nets, same layer)
  for (const seg of copperSegs) {
    for (const pad of copperPads) {
      if (seg.layer !== pad.layer) continue;
      if (seg.net === pad.net) continue;
      const dist = segToPointDistance(seg.start, seg.end, pad.pos);
      const padRadius = Math.max(pad.size.width, pad.size.height) / 2;
      const minDist = dist - seg.width / 2 - padRadius;
      if (minDist < config.minClearance) {
        errors.push({
          type: minDist < 0 ? 'short' : 'clearance',
          severity: minDist < 0 ? 'error' : 'warning',
          message: minDist < 0
            ? `Short: trace "${seg.net}" overlaps pad "${pad.id}"`
            : `Clearance: trace "${seg.net}" too close to pad "${pad.id}"`,
          position: pad.pos,
          layer: seg.layer,
        });
      }
    }
  }

  // 6. Check pad-to-pad clearance (different nets)
  for (let i = 0; i < copperPads.length; i++) {
    for (let j = i + 1; j < copperPads.length; j++) {
      const a = copperPads[i];
      const b = copperPads[j];
      if (a.net === b.net) continue;
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const dist = Math.hypot(dx, dy);
      const aR = Math.max(a.size.width, a.size.height) / 2;
      const bR = Math.max(b.size.width, b.size.height) / 2;
      const minDist = dist - aR - bR;
      if (minDist < config.minClearance) {
        errors.push({
          type: minDist < 0 ? 'short' : 'clearance',
          severity: minDist < 0 ? 'error' : 'warning',
          message: minDist < 0
            ? `Short: pads "${a.id}" and "${b.id}" overlap`
            : `Clearance: pads "${a.id}" and "${b.id}" too close`,
          position: { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 },
          layer: a.layer,
        });
      }
    }
  }

  // 7. Check traces outside board boundary
  for (const seg of copperSegs) {
    const points = [seg.start, seg.end];
    for (const p of points) {
      if (p.x < 0 || p.x > board.width || p.y < 0 || p.y > board.height) {
        errors.push({
          type: 'outside_board',
          severity: 'error',
          message: `Trace on net "${seg.net}" is outside board boundary`,
          position: p,
          layer: seg.layer,
        });
      }
    }
  }

  // 8. Check via drill sizes
  for (const via of vias) {
    if (via.drill < config.minDrillSize) {
      errors.push({
        type: 'clearance',
        severity: 'warning',
        message: `Via drill ${via.drill}mm < minimum ${config.minDrillSize}mm`,
        position: via.position,
        layer: 'both',
      });
    }
  }

  return errors;
}

// ----- Geometry helpers -----

/** Distance from point to line segment */
function segToPointDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Minimum distance between two line segments */
function segToSegDistance(
  a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number },
): number {
  // Check if segments intersect
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  // Otherwise, minimum of point-to-segment distances
  return Math.min(
    segToPointDistance(b1, b2, a1),
    segToPointDistance(b1, b2, a2),
    segToPointDistance(a1, a2, b1),
    segToPointDistance(a1, a2, b2),
  );
}

/** Check if two line segments intersect */
function segmentsIntersect(
  a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number },
): boolean {
  const d1 = cross(b2.x - b1.x, b2.y - b1.y, a1.x - b1.x, a1.y - b1.y);
  const d2 = cross(b2.x - b1.x, b2.y - b1.y, a2.x - b1.x, a2.y - b1.y);
  const d3 = cross(a2.x - a1.x, a2.y - a1.y, b1.x - a1.x, b1.y - a1.y);
  const d4 = cross(a2.x - a1.x, a2.y - a1.y, b2.x - a1.x, b2.y - a1.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ux: number, uy: number, vx: number, vy: number): number {
  return ux * vy - uy * vx;
}
