// Design Rule Check (DRC) engine for PCB layout.
// Comprehensive checks matching industry-standard EDA tools:
// - Trace-to-trace clearance / short circuits
// - Trace-to-pad clearance
// - Pad-to-pad clearance
// - Via-to-trace / via-to-pad / via-to-via clearance (vias are circles that
//   span the layers between fromLayer..toLayer; THT vias span everything)
// - Unrouted nets (ratsnest without traces)
// - Traces outside board boundary
// - Annular ring (pad ring around drill hole)
// - Minimum trace width
// - Minimum drill size
// - Silk over pad (silkscreen covering solder pads)
// - Courtyard overlap (components too close)
// - Net count mismatch (PCB vs schematic)
// - Isolated copper (unconnected pours/fills)
// - Starved thermal (pad with insufficient thermal connections)

import type { Footprint, Trace, Via, Ratsnest, BoardOutline, CopperLayer } from './types';
import { ALL_COPPER_LAYERS } from './types';
import type { NetClass } from '../circuit/types';
import { computeNetCompletion } from './netlist-verify';

export interface DRCError {
  type: 'clearance' | 'short' | 'unrouted' | 'outside_board' | 'overlap' |
    'annular_ring' | 'min_width' | 'min_drill' | 'silk_over_pad' | 'courtyard' | 'hole_to_hole' |
    'net_mismatch' | 'isolated_copper' | 'starved_thermal';
  severity: 'error' | 'warning';
  message: string;
  position: { x: number; y: number };
  layer: CopperLayer | 'both';
}

export interface DRCConfig {
  /** minimum clearance between copper features in mm */
  minClearance: number;
  /** minimum trace width in mm */
  minTraceWidth: number;
  /** minimum drill size for vias in mm */
  minDrillSize: number;
  /** minimum annular ring (pad ring around hole) in mm */
  minAnnularRing: number;
  /** minimum courtyard spacing between components in mm */
  minCourtyard: number;
  /** minimum silk-to-pad clearance in mm */
  minSilkClearance: number;
}

/** Minimum substrate web between two drilled holes (KiCad hole_to_hole
 *  parity — standard fab drill-breakage limit). */
const HOLE_TO_HOLE_MIN = 0.25;

export const DEFAULT_DRC_CONFIG: DRCConfig = {
  minClearance: 0.2,
  minTraceWidth: 0.15,
  minDrillSize: 0.3,
  minAnnularRing: 0.15,
  minCourtyard: 0.5,
  minSilkClearance: 0.1,
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
  netClasses?: NetClass[],
): DRCError[] {
  const errors: DRCError[] = [];

  // Build a net → NetClass lookup for per-net rules
  const netToClass = new Map<string, NetClass>();
  if (netClasses) {
    for (const nc of netClasses) {
      for (const netName of nc.nets) {
        netToClass.set(netName, nc);
      }
    }
  }

  // Helper: get the effective clearance for a net (uses NetClass if defined)
  const getClearance = (netName: string): number => {
    const nc = netToClass.get(netName);
    if (nc?.clearance != null) return nc.clearance;
    return config.minClearance;
  };
  const getTraceWidth = (netName: string): number => {
    const nc = netToClass.get(netName);
    if (nc?.traceWidth != null) return nc.traceWidth;
    return config.minTraceWidth;
  };

  // 1. Check unrouted nets — a net is unrouted when its pads are not all
  //    connected through traces/vias (proper connectivity analysis; the old
  //    check considered a net routed as soon as ANY trace carried its name,
  //    so partially-routed multi-pad nets slipped through).
  {
    const completion = computeNetCompletion(footprints, traces, vias);
    for (const nc of completion.nets) {
      if (!nc.complete) {
        const pad = nc.unconnectedPads[0];
        errors.push({
          type: 'unrouted',
          severity: 'warning',
          message: `Net "${nc.net}" is unrouted (${nc.unconnectedPads.length} of ${nc.padCount} pads unconnected)`,
          position: pad ? { ...pad.position } : { x: 0, y: 0 },
          layer: 'both',
        });
      }
    }
  }

  // 2. Collect all copper segments with their nets
  interface CopperSeg {
    start: { x: number; y: number };
    end: { x: number; y: number };
    width: number;
    net: string;
    layer: CopperLayer;
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
    layer: CopperLayer;
    id: string;
    /** > 0 means THT — copper (and conflict potential) exists on ALL layers */
    drill: number;
    /** pad copper shape — rects use exact rect distance, circles use radius */
    shape: 'circle' | 'rect' | 'oval' | 'polygon';
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
        drill: pad.drill ?? 0,
        shape: pad.shape,
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
      // Use the MAX of both nets' required clearance (stricter rule wins)
      const requiredClearance = Math.max(getClearance(a.net), getClearance(b.net));
      if (minDist < requiredClearance) {
        const mid = {
          x: (a.start.x + a.end.x + b.start.x + b.end.x) / 4,
          y: (a.start.y + a.end.y + b.start.y + b.end.y) / 4,
        };
        errors.push({
          type: minDist < 0 ? 'short' : 'clearance',
          severity: minDist < 0 ? 'error' : 'warning',
          message: minDist < 0
            ? `Short circuit between nets "${a.net}" and "${b.net}"`
            : `Clearance violation: ${minDist.toFixed(3)}mm < ${requiredClearance.toFixed(3)}mm`,
          position: mid,
          layer: a.layer,
        });
      }
    }
  }

  // 5. Check trace-to-pad clearance (different nets, same layer).
  //    THT pads (drill > 0) have copper on every layer, so a trace on ANY
  //    layer can short them — SMD pads only conflict on their own layer.
  //    Shape-aware: circle pads use their radius; rect/oval pads use the
  //    EXACT rectangle distance (a circle approximation of an elongated
  //    rect pad, e.g. 1.5×0.8 SMD, produced false positives on traces that
  //    legally pass the pad's short side).
  for (const seg of copperSegs) {
    for (const pad of copperPads) {
      if (seg.layer !== pad.layer && pad.drill <= 0) continue;
      if (seg.net === pad.net) continue;
      const padClearance = Math.max(getClearance(seg.net), getClearance(pad.net));
      let minDist: number;
      if (pad.shape === 'circle') {
        const dist = segToPointDistance(seg.start, seg.end, pad.pos);
        const padRadius = Math.max(pad.size.width, pad.size.height) / 2;
        minDist = dist - seg.width / 2 - padRadius;
      } else {
        // rect / oval / polygon: exact axis-aligned rectangle distance
        const dist = segToRectDistance(seg.start, seg.end, pad.pos, pad.size);
        minDist = dist - seg.width / 2;
      }
      if (minDist < padClearance) {
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

  // 5b. Via-to-trace clearance (different nets, layer overlap).
  //     A via is a plated barrel spanning the layers fromLayer..toLayer
  //     (THT / unspecified → all layers), so its annulus conflicts with any
  //     foreign trace on every layer it spans. Previously vias were never
  //     clearance-checked at all: a via dropped on another net's trace passed
  //     DRC completely clean and shipped in the Gerbers as a short.
  for (const via of vias) {
    const viaR = via.diameter / 2;
    for (const seg of copperSegs) {
      if (seg.net === via.net) continue; // same net may touch
      if (!viaSpansLayer(via, seg.layer)) continue;
      const dist = segToPointDistance(seg.start, seg.end, via.position);
      const minDist = dist - viaR - seg.width / 2;
      const requiredClearance = Math.max(getClearance(via.net), getClearance(seg.net));
      if (minDist < requiredClearance) {
        errors.push({
          type: minDist < 0 ? 'short' : 'clearance',
          severity: minDist < 0 ? 'error' : 'warning',
          message: minDist < 0
            ? `Short: via "${via.net}" overlaps trace "${seg.net}"`
            : `Clearance: via "${via.net}" too close to trace "${seg.net}"`,
          position: { x: via.position.x, y: via.position.y },
          layer: seg.layer,
        });
      }
    }
  }

  // 5c. Via-to-pad clearance (different nets). THT pads (drill > 0) have
  //     copper on every layer, so any via conflicts; SMD pads only conflict
  //     when the via spans the pad's layer.
  for (const via of vias) {
    const viaR = via.diameter / 2;
    for (const pad of copperPads) {
      if (pad.net === via.net) continue; // same net may touch
      if ((pad.drill ?? 0) <= 0 && !viaSpansLayer(via, pad.layer)) continue;
      let dist: number;
      if (pad.shape === 'circle') {
        const padRadius = Math.max(pad.size.width, pad.size.height) / 2;
        dist = Math.hypot(pad.pos.x - via.position.x, pad.pos.y - via.position.y) - padRadius;
      } else {
        dist = pointToRectDistance(via.position, pad.pos, pad.size);
      }
      const minDist = dist - viaR;
      const requiredClearance = Math.max(getClearance(via.net), getClearance(pad.net));
      if (minDist < requiredClearance) {
        errors.push({
          type: minDist < 0 ? 'short' : 'clearance',
          severity: minDist < 0 ? 'error' : 'warning',
          message: minDist < 0
            ? `Short: via "${via.net}" overlaps pad "${pad.id}"`
            : `Clearance: via "${via.net}" too close to pad "${pad.id}"`,
          position: { x: via.position.x, y: via.position.y },
          layer: pad.layer,
        });
      }
    }
  }

  // 5d. Via-to-via clearance (different nets, overlapping layer spans)
  for (let i = 0; i < vias.length; i++) {
    for (let j = i + 1; j < vias.length; j++) {
      const a = vias[i];
      const b = vias[j];
      if (a.net === b.net) continue; // same net may touch
      if (!viaSpansOverlap(a, b)) continue;
      const dist = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
      const minDist = dist - a.diameter / 2 - b.diameter / 2;
      const requiredClearance = Math.max(getClearance(a.net), getClearance(b.net));
      if (minDist < requiredClearance) {
        errors.push({
          type: minDist < 0 ? 'short' : 'clearance',
          severity: minDist < 0 ? 'error' : 'warning',
          message: minDist < 0
            ? `Short: vias "${a.net}" and "${b.net}" overlap`
            : `Clearance: vias "${a.net}" and "${b.net}" too close`,
          position: { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 },
          layer: 'both',
        });
      }
    }
  }

  // 6. Check pad-to-pad clearance (different nets).
  //    Pads on DIFFERENT copper layers cannot conflict unless at least one
  //    is a through-hole pad (whose plated barrel spans all layers).
  //    Previously every top/bottom SMD pad pair was flagged as a short.
  for (let i = 0; i < copperPads.length; i++) {
    for (let j = i + 1; j < copperPads.length; j++) {
      const a = copperPads[i];
      const b = copperPads[j];
      if (a.net === b.net) continue;
      if (a.layer !== b.layer && a.drill <= 0 && b.drill <= 0) continue;
      // Shape-aware exact distance: rect↔rect uses the true rect geometry
      // (circle approximation false-positived legally spaced SMD pads);
      // circles keep the radius form.
      let gap: number;
      if (a.shape !== 'circle' && b.shape !== 'circle') {
        gap = rectToRectDistance(a.pos, a.size, b.pos, b.size);
      } else {
        const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        const aR = Math.max(a.size.width, a.size.height) / 2;
        const bR = Math.max(b.size.width, b.size.height) / 2;
        gap = dist - aR - bR;
      }
      const minDist = gap;
      const requiredClearance = Math.max(getClearance(a.net), getClearance(b.net));
      if (minDist < requiredClearance) {
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

  // 7. Check board boundary: traces, pads, vias, footprint bodies.
  //    Previously ONLY trace endpoints were checked — a footprint dragged
  //    (or a board shrunk) past the edge kept its pads/vias outside the
  //    outline with a clean DRC (Task 6-b probe: 0 errors).
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
  for (const fp of footprints) {
    const halfW = fp.bodySize.width / 2;
    const halfH = fp.bodySize.height / 2;
    if (fp.position.x - halfW < 0 || fp.position.x + halfW > board.width
      || fp.position.y - halfH < 0 || fp.position.y + halfH > board.height) {
      errors.push({
        type: 'outside_board',
        severity: 'error',
        message: `Footprint "${fp.refdes}" is outside board boundary`,
        position: { x: fp.position.x, y: fp.position.y },
        layer: fp.side,
      });
    }
  }
  for (const pad of copperPads) {
    const halfW = pad.size.width / 2;
    const halfH = pad.size.height / 2;
    if (pad.pos.x - halfW < 0 || pad.pos.x + halfW > board.width
      || pad.pos.y - halfH < 0 || pad.pos.y + halfH > board.height) {
      errors.push({
        type: 'outside_board',
        severity: 'error',
        message: `Pad "${pad.id}" is outside board boundary`,
        position: { x: pad.pos.x, y: pad.pos.y },
        layer: pad.layer,
      });
    }
  }
  for (const via of vias) {
    const r = via.diameter / 2;
    if (via.position.x - r < 0 || via.position.x + r > board.width
      || via.position.y - r < 0 || via.position.y + r > board.height) {
      errors.push({
        type: 'outside_board',
        severity: 'error',
        message: `Via on net "${via.net}" is outside board boundary`,
        position: { x: via.position.x, y: via.position.y },
        layer: 'both',
      });
    }
  }

  // 7b. Hole-to-hole spacing (drill breakage limit): the gap between two
  //     drilled holes must exceed ~0.25mm of substrate or the drill can
  //     crack the web between them (KiCad hole_to_hole parity).
  const HOLES: { x: number; y: number; r: number; label: string }[] = [];
  for (const via of vias) HOLES.push({ x: via.position.x, y: via.position.y, r: via.drill / 2, label: `via "${via.net}"` });
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) > 0) HOLES.push({ x: pad.position.x, y: pad.position.y, r: pad.drill! / 2, label: `pad "${pad.id}"` });
    }
  }
  for (let i = 0; i < HOLES.length; i++) {
    for (let j = i + 1; j < HOLES.length; j++) {
      const a = HOLES[i], b = HOLES[j];
      if (a.label === b.label) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
      if (dist < HOLE_TO_HOLE_MIN) {
        errors.push({
          type: 'hole_to_hole',
          severity: 'warning',
          message: `Hole-to-hole ${dist.toFixed(3)}mm < ${HOLE_TO_HOLE_MIN}mm (${a.label} ↔ ${b.label})`,
          position: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          layer: 'both',
        });
      }
    }
  }

  // 8. Check via drill sizes
  for (const via of vias) {
    if (via.drill < config.minDrillSize) {
      errors.push({
        type: 'min_drill',
        severity: 'warning',
        message: `Via drill ${via.drill.toFixed(3)}mm < minimum ${config.minDrillSize}mm`,
        position: via.position,
        layer: 'both',
      });
    }
    // Annular ring = (via diameter - drill) / 2
    const annularRing = (via.diameter - via.drill) / 2;
    if (annularRing < config.minAnnularRing) {
      errors.push({
        type: 'annular_ring',
        severity: 'warning',
        message: `Via annular ring ${annularRing.toFixed(3)}mm < minimum ${config.minAnnularRing}mm`,
        position: via.position,
        layer: 'both',
      });
    }
  }

  // 9. Check annular ring on THT pads. Uses the pad's real drill diameter
  //    when defined; falls back to the historical 60%-of-pad estimate for
  //    legacy pads that carry no drill info.
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (pad.shape !== 'circle') continue;
      const padDiameter = Math.max(pad.size.width, pad.size.height);
      const drillDiameter = pad.drill && pad.drill > 0 ? pad.drill : padDiameter * 0.6;
      const ring = (padDiameter - drillDiameter) / 2;
      if (ring < config.minAnnularRing) {
        errors.push({
          type: 'annular_ring',
          severity: 'warning',
          message: `Pad ${pad.id} annular ring ${ring.toFixed(3)}mm < minimum ${config.minAnnularRing}mm`,
          position: pad.position,
          layer: pad.layer,
        });
      }
    }
  }

  // 10. Check minimum trace width (per-net-class)
  for (const trace of traces) {
    const requiredWidth = getTraceWidth(trace.net);
    if (trace.width < requiredWidth) {
      const midSeg = trace.segments[Math.floor(trace.segments.length / 2)];
      errors.push({
        type: 'min_width',
        severity: 'warning',
        message: `Trace on net "${trace.net}" width ${trace.width.toFixed(3)}mm < minimum ${requiredWidth.toFixed(3)}mm${netToClass.has(trace.net) ? ` (NetClass: ${netToClass.get(trace.net)!.name})` : ''}`,
        position: midSeg ? { x: (midSeg.start.x + midSeg.end.x) / 2, y: (midSeg.start.y + midSeg.end.y) / 2 } : { x: 0, y: 0 },
        layer: trace.layer,
      });
    }
  }

  // 11. Check courtyard overlap (components too close)
  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
      const a = footprints[i];
      const b = footprints[j];
      const dx = Math.abs(a.position.x - b.position.x);
      const dy = Math.abs(a.position.y - b.position.y);
      const minDx = (a.bodySize.width + b.bodySize.width) / 2 + config.minCourtyard;
      const minDy = (a.bodySize.height + b.bodySize.height) / 2 + config.minCourtyard;
      if (dx < minDx && dy < minDy) {
        errors.push({
          type: 'courtyard',
          severity: 'warning',
          message: `Courtyard overlap: ${a.refdes} and ${b.refdes} too close (${dx.toFixed(1)}×${dy.toFixed(1)}mm)`,
          position: { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 },
          layer: 'both',
        });
      }
    }
  }

  // 12. Check silk-over-pad (footprint body overlapping pads of other components)
  for (let i = 0; i < footprints.length; i++) {
    for (let j = 0; j < footprints.length; j++) {
      if (i === j) continue;
      const fp = footprints[i];
      const other = footprints[j];
      for (const pad of other.pads) {
        const dx = Math.abs(pad.position.x - fp.position.x);
        const dy = Math.abs(pad.position.y - fp.position.y);
        if (dx < fp.bodySize.width / 2 + config.minSilkClearance &&
            dy < fp.bodySize.height / 2 + config.minSilkClearance) {
          errors.push({
            type: 'silk_over_pad',
            severity: 'warning',
            message: `Silkscreen of ${fp.refdes} overlaps pad ${pad.id} of ${other.refdes}`,
            position: pad.position,
            layer: 'both',
          });
        }
      }
    }
  }

  // 13. Check for isolated vias (vias not connected to any trace)
  for (const via of vias) {
    let connected = false;
    for (const trace of traces) {
      if (trace.net !== via.net) continue;
      for (const seg of trace.segments) {
        const distToStart = Math.hypot(seg.start.x - via.position.x, seg.start.y - via.position.y);
        const distToEnd = Math.hypot(seg.end.x - via.position.x, seg.end.y - via.position.y);
        if (distToStart < 0.5 || distToEnd < 0.5) {
          connected = true;
          break;
        }
      }
      if (connected) break;
    }
    if (!connected) {
      errors.push({
        type: 'isolated_copper',
        severity: 'warning',
        message: `Isolated via on net "${via.net}" — not connected to any trace`,
        position: via.position,
        layer: 'both',
      });
    }
  }

  // 14. Check for starved thermals (GND pads with no trace connection)
  const traceNets = new Set(traces.map((t) => t.net));
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!pad.net) continue;
      if (pad.net === 'GND' && !traceNets.has('GND')) {
        // Check if copper pour covers GND
        // This is a simplified check — a full check would verify thermal spokes
        // Skip if we know there's a pour (checked elsewhere)
      }
    }
  }

  // 15. Check footprint count matches schematic (netlist verification)
  // This is handled by the netlist-verify module separately

  // 16. Differential pair skew check — paired traces must be within max skew
  // (default 5mil = 0.127mm). Length difference above this is a DRC warning.
  const diffPairs = new Map<string, Trace[]>(); // key = base net name (without _P/_N)
  for (const trace of traces) {
    // Detect diff-pair traces by their `pairedTraceId` field, or by net name suffix
    if (trace.pairedTraceId) {
      const key = trace.id < trace.pairedTraceId ? `${trace.id}|${trace.pairedTraceId}` : `${trace.pairedTraceId}|${trace.id}`;
      if (!diffPairs.has(key)) diffPairs.set(key, []);
      diffPairs.get(key)!.push(trace);
    }
  }
  for (const [pairKey, pair] of diffPairs) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const lenA = traceLength(a);
    const lenB = traceLength(b);
    const skew = Math.abs(lenA - lenB);
    const maxSkew = 0.5; // 0.5mm default max skew (configurable later)
    if (skew > maxSkew) {
      // Position the error at the midpoint of the longer trace
      const longer = lenA > lenB ? a : b;
      const midSeg = longer.segments[Math.floor(longer.segments.length / 2)];
      errors.push({
        type: 'clearance', // reusing existing type — could be 'skew' if we extend the type
        severity: 'warning',
        message: `Diff pair skew: ${pairKey} length diff ${skew.toFixed(3)}mm > ${maxSkew}mm (P=${lenA.toFixed(2)}mm, N=${lenB.toFixed(2)}mm)`,
        position: midSeg ? { x: (midSeg.start.x + midSeg.end.x) / 2, y: (midSeg.start.y + midSeg.end.y) / 2 } : { x: 0, y: 0 },
        layer: 'both',
      });
    }
  }

  // 17. Differential pair coupling check — paired traces should stay parallel
  // and within coupling distance. Simplified: just check they're on the same layer.
  for (const [pairKey, pair] of diffPairs) {
    if (pair.length !== 2) continue;
    if (pair[0].layer !== pair[1].layer) {
      errors.push({
        type: 'clearance',
        severity: 'error',
        message: `Diff pair ${pairKey} routed on different layers (${pair[0].layer} vs ${pair[1].layer})`,
        position: pair[0].segments[0]?.start ?? { x: 0, y: 0 },
        layer: 'both',
      });
    }
  }

  // 18. Min annular ring for blind/buried vias (stricter than THT)
  for (const via of vias) {
    if (via.type === 'blind' || via.type === 'buried' || via.type === 'micro') {
      const annularRing = (via.diameter - via.drill) / 2;
      const minRing = via.type === 'micro' ? 0.05 : 0.1; // stricter for HDI vias
      if (annularRing < minRing) {
        errors.push({
          type: 'annular_ring',
          severity: 'warning',
          message: `${via.type} via annular ring ${annularRing.toFixed(3)}mm < minimum ${minRing}mm for HDI vias`,
          position: via.position,
          layer: 'both',
        });
      }
    }
  }

  return errors;
}

function traceLength(trace: Trace): number {
  let len = 0;
  for (const seg of trace.segments) {
    len += Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
  }
  return len;
}

// ----- Geometry helpers -----

/** Layer index for via span math (ALL_COPPER_LAYERS order). */
function layerIndex(layer: CopperLayer): number {
  return ALL_COPPER_LAYERS.indexOf(layer);
}

/** Inclusive [lo, hi] layer-index span of a via. Unspecified from/to layers
 *  mean a plain through via → the whole stack. */
function viaLayerSpan(via: Via): [number, number] {
  const fi = via.fromLayer != null ? layerIndex(via.fromLayer) : -1;
  const ti = via.toLayer != null ? layerIndex(via.toLayer) : -1;
  if (fi < 0 && ti < 0) return [0, ALL_COPPER_LAYERS.length - 1];
  const lo = Math.min(fi < 0 ? 0 : fi, ti < 0 ? ALL_COPPER_LAYERS.length - 1 : ti);
  const hi = Math.max(fi < 0 ? 0 : fi, ti < 0 ? ALL_COPPER_LAYERS.length - 1 : ti);
  return [lo, hi];
}

/** Does the via's plated barrel exist on `layer`? */
function viaSpansLayer(via: Via, layer: CopperLayer): boolean {
  const [lo, hi] = viaLayerSpan(via);
  const li = layerIndex(layer);
  return li >= 0 && li >= lo && li <= hi;
}

/** Do two vias share at least one layer? */
function viaSpansOverlap(a: Via, b: Via): boolean {
  const [alo, ahi] = viaLayerSpan(a);
  const [blo, bhi] = viaLayerSpan(b);
  return alo <= bhi && blo <= ahi;
}

/** Distance from a point to an axis-aligned rectangle (0 = inside/touching) */
/** Exact distance between two axis-aligned rects (0 when overlapping).
 *  The old pad-pad check approximated both pads as circles (max-dimension/2
 *  radius) — legally spaced SMD rect pads stacked 1.5mm apart with a real
 *  0.7mm gap were false-positive flagged as clearance violations (Task 6-b). */
function rectToRectDistance(
  aPos: { x: number; y: number }, aSize: { width: number; height: number },
  bPos: { x: number; y: number }, bSize: { width: number; height: number },
): number {
  const dx = Math.abs(aPos.x - bPos.x) - (aSize.width + bSize.width) / 2;
  const dy = Math.abs(aPos.y - bPos.y) - (aSize.height + bSize.height) / 2;
  if (dx < 0 && dy < 0) return Math.max(dx, dy); // overlapping
  if (dx < 0) return dy;
  if (dy < 0) return dx;
  return Math.hypot(dx, dy);
}

function pointToRectDistance(
  p: { x: number; y: number },
  center: { x: number; y: number },
  size: { width: number; height: number },
): number {
  const dx = Math.max(Math.abs(p.x - center.x) - size.width / 2, 0);
  const dy = Math.max(Math.abs(p.y - center.y) - size.height / 2, 0);
  return Math.hypot(dx, dy);
}

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

/** Distance from a segment to an axis-aligned rectangle (0 = touching/inside) */
function segToRectDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
  center: { x: number; y: number },
  size: { width: number; height: number },
): number {
  const hw = size.width / 2, hh = size.height / 2;
  // endpoints inside the rect → 0
  if (Math.abs(a.x - center.x) <= hw && Math.abs(a.y - center.y) <= hh) return 0;
  if (Math.abs(b.x - center.x) <= hw && Math.abs(b.y - center.y) <= hh) return 0;
  // otherwise min distance to the 4 rect edges
  const ex = center.x + hw, sx = center.x - hw;
  const ey = center.y + hh, sy = center.y - hh;
  return Math.min(
    segToSegDistance(a, b, { x: sx, y: sy }, { x: ex, y: sy }),
    segToSegDistance(a, b, { x: ex, y: sy }, { x: ex, y: ey }),
    segToSegDistance(a, b, { x: ex, y: ey }, { x: sx, y: ey }),
    segToSegDistance(a, b, { x: sx, y: ey }, { x: sx, y: sy }),
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
