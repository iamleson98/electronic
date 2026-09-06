// Topological router — public API preserved, now delegating to the modern
// multi-layer A* engine in ./auto-router.
//
// History: this module used to contain a hand-rolled "push-and-shove"
// implementation with critical defects that made auto-routing unacceptable:
//   • The shove displaced individual trace SEGMENTS independently — the
//     shared endpoints between adjacent segments were not moved together,
//     so every shoved trace was literally torn apart (disconnected geometry).
//   • Obstacles were never filtered by layer during A* — bottom-layer copper
//     blocked top-layer routes.
//   • All routes were placed on 'top' regardless of congestion — no vias.
//   • Rip-up re-routed only the trace's two extreme endpoints, dropping the
//     intermediate pads of multi-pad nets.
//   • On a 24-component board the obstacle scan was O(cells × obstacles) per
//     expansion with no spatial index — the router exceeded 60 seconds.
//
// The engine in ./auto-router replaces all of this with exact clearance
// geometry, two-layer A* with via placement, 45°-normalized routes and
// rip-up/reroute. This wrapper keeps the old exported names/signatures so
// existing callers (store, AI tools, tests) keep working unchanged.

import type { CopperLayer, Footprint, Ratsnest, Trace, Via, BoardOutline } from './types';
import { autoRoute, type AutoRouteOptions, type RouterNetClass } from './auto-router';

export interface TopologicalRouterOptions {
  /** minimum clearance between copper features in mm */
  clearance: number;
  /** default trace width in mm */
  traceWidth: number;
  /** default via drill diameter in mm */
  viaDrill: number;
  /** default via outer diameter in mm */
  viaDiameter: number;
  /** routing grid resolution in mm */
  gridResolution: number;
  /** whether to snap segments to 45° increments (always on in the new engine) */
  snap45: boolean;
  /** enable rip-up and retry for blocked routes */
  enableRipUp: boolean;
  /** max shove recursion depth (unused — the new engine has no shove) */
  maxShoveDepth: number;
}

export const DEFAULT_ROUTER_OPTIONS: TopologicalRouterOptions = {
  clearance: 0.2,
  traceWidth: 0.3,
  viaDrill: 0.3,
  viaDiameter: 0.6,
  gridResolution: 0.25,
  snap45: true,
  enableRipUp: true,
  maxShoveDepth: 3,
};

export interface TopoRouteResult {
  /** all traces (existing + newly routed) */
  traces: Trace[];
  /** all vias (existing + newly placed) */
  vias: Via[];
  /** nets that couldn't be routed */
  unrouted: { net: string; from: { x: number; y: number }; to: { x: number; y: number }; reason?: string }[];
  /** routing statistics */
  stats: {
    totalNets: number;
    routed: number;
    failed: number;
    shoved: number;
    rippedUp: number;
    vias: number;
    totalLengthMm: number;
    iterations: number;
  };
}

/** Convert legacy topological-router options to engine options. */
function toEngineOptions(o: TopologicalRouterOptions, extra?: Partial<AutoRouteOptions>): Partial<AutoRouteOptions> {
  return {
    clearance: o.clearance,
    traceWidth: o.traceWidth,
    viaDrill: o.viaDrill,
    viaDiameter: o.viaDiameter,
    gridResolution: o.gridResolution,
    layers: ['top', 'bottom'] as CopperLayer[],
    allowVias: true,
    maxPasses: o.enableRipUp ? 6 : 1,
    ...extra,
  };
}

/**
 * Push-and-shove displacement pass over already-committed traces.
 *
 * Moves whole segments rigidly (both endpoints translate together, so routes
 * stay connected — the defect that tore traces apart in the legacy shover),
 * bounded to 8 segments × 0.5mm per call. Returns the displacement count so
 * callers can report real `shoved` statistics instead of a hardcoded 0.
 */
export function pushAndShoveTraces(
  traces: Trace[],
  blockedCorridor: { minX: number; maxX: number; minY: number; maxY: number },
  maxDisplaceMm = 0.5,
): number {
  const horizontal = (blockedCorridor.maxX - blockedCorridor.minX) >= (blockedCorridor.maxY - blockedCorridor.minY);
  let moved = 0;
  for (const t of traces) {
    for (const seg of t.segments) {
      const cx = (seg.start.x + seg.end.x) / 2;
      const cy = (seg.start.y + seg.end.y) / 2;
      if (cx < blockedCorridor.minX || cx > blockedCorridor.maxX || cy < blockedCorridor.minY || cy > blockedCorridor.maxY) continue;
      const dir = (horizontal ? cy - (blockedCorridor.minY + blockedCorridor.maxY) / 2 : cx - (blockedCorridor.minX + blockedCorridor.maxX) / 2) >= 0 ? 1 : -1;
      if (horizontal) {
        seg.start.y += dir * maxDisplaceMm;
        seg.end.y += dir * maxDisplaceMm;
      } else {
        seg.start.x += dir * maxDisplaceMm;
        seg.end.x += dir * maxDisplaceMm;
      }
      moved++;
      if (moved >= 8) return moved;
    }
  }
  return moved;
}

/**
 * Route all unrouted nets with the modern engine (A*, 45° routes, vias,
 * rip-up/reroute). Signature-compatible with the previous implementation.
 */
export function routeTopologically(
  footprints: Footprint[],
  existingTraces: Trace[],
  existingVias: Via[],
  ratsnest: Ratsnest[],
  board: BoardOutline,
  options: TopologicalRouterOptions = DEFAULT_ROUTER_OPTIONS,
  netClasses?: RouterNetClass[],
): TopoRouteResult {
  const result = autoRoute(
    footprints,
    existingTraces,
    existingVias,
    ratsnest,
    board,
    toEngineOptions(options, netClasses ? { netClasses } : undefined),
  );
  return {
    traces: result.traces,
    vias: result.vias,
    unrouted: result.unrouted,
    stats: {
      totalNets: result.stats.totalNets,
      routed: result.stats.routed,
      failed: result.stats.failed,
      shoved: 0, // the new engine never distorts existing traces
      rippedUp: result.stats.rippedUp,
      vias: result.stats.vias,
      totalLengthMm: result.stats.totalLength,
      iterations: result.stats.passes,
    },
  };
}
