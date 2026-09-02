// Wire draft preview — the polyline the user sees while drawing a wire.
//
// The old preview was a single straight dashed line from the source pin to
// the raw cursor: it ignored the orthogonal bends, the obstacle-avoiding
// route, and the terminal snap that the COMMITTED wire would actually take.
// Users could not reason about what they were about to create ("I click here
// — what wire do I get?"). This module computes a preview that matches the
// commit path as closely as possible:
//
//   - committed user waypoints are shown as fixed bends;
//   - the final leg follows the same orthogonal elbow the fallback router
//     uses, OR a bounded A* route (same grid + costs as commit) when no
//     user waypoints exist yet;
//   - when the cursor is within snap range of a terminal, the preview ends
//     exactly at that terminal, so "what you see is what you connect".
//
// Pure module (no React/store) + a small memo keyed on the inputs that
// actually change, so the 60fps render loop re-runs A* at most once per
// cursor move.

import type { CircuitComponent, ComponentPlugin, Vec2, Wire } from '@/lib/circuit/types';
import type { HierarchicalSheet } from '@/lib/circuit/types';
import { getAllPlugins } from '@/lib/circuit/registry';
import { resolveEndpointGridPos } from '@/lib/circuit/endpoint-position';
import {
  buildRoutingGridForDocument,
  findRoute,
  PREVIEW_MAX_ITERATIONS,
} from '@/lib/circuit/smart-wire-router';

/** Minimal snap-target shape (subset of TerminalHit). */
export type SnapTarget = { componentId: string; terminalId: string; pos: Vec2 } | null;

export interface WireDraftState {
  from: { componentId: string; terminalId: string };
  cursor: { x: number; y: number };
  /** User-placed bends (grid coordinates), in path order. */
  waypoints: Vec2[];
}

export interface DraftPreviewResult {
  /** Full grid-space polyline, start → waypoints → tentative end. */
  path: Vec2[];
  /** How many leading points (after start) are committed bends. */
  committedWaypoints: number;
  /** Whether the tentative leg came from A* (true) or the elbow fallback. */
  routed: boolean;
}

function pluginsMap(): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().map((p) => [p.type, p]));
}

/** Elbow point matching getWirePath's default L-route (horizontal first). */
function elbow(from: Vec2, to: Vec2): Vec2[] {
  if (Math.abs(to.x - from.x) < 0.01 || Math.abs(to.y - from.y) < 0.01) {
    return [to];
  }
  return [{ x: to.x, y: from.y }, to];
}

// Grid cache: rebuild only when the document (components/wires identity)
// changes — pan/zoom/hover frames reuse it.
let gridCache: {
  components: CircuitComponent[] | null;
  wires: Wire[] | null;
  grid: ReturnType<typeof buildRoutingGridForDocument> | null;
} = { components: null, wires: null, grid: null };

function routingGrid(components: CircuitComponent[], wires: Wire[]) {
  if (gridCache.components !== components || gridCache.wires !== wires) {
    gridCache = { components, wires, grid: buildRoutingGridForDocument(components, wires, pluginsMap()) };
  }
  return gridCache.grid!;
}

// Result memo: skip A* when nothing that affects the route changed.
let resultCache: { key: string; result: DraftPreviewResult | null } = { key: '', result: null };

/**
 * Compute the draft preview path. `snapTarget` (from the canvas hover hit)
 * is the terminal the click would connect to, if any.
 */
export function computeDraftPreview(
  draft: WireDraftState,
  components: CircuitComponent[],
  wires: Wire[],
  sheets: HierarchicalSheet[],
  snapTarget: SnapTarget,
): DraftPreviewResult | null {
  const start = resolveEndpointGridPos(draft.from, components, sheets);
  if (!start) return null;
  const target = snapTarget ? snapTarget.pos : draft.cursor;

  const key = [
    draft.from.componentId, draft.from.terminalId,
    draft.waypoints.length,
    draft.waypoints.length > 0 ? `${draft.waypoints[draft.waypoints.length - 1].x},${draft.waypoints[draft.waypoints.length - 1].y}` : '',
    `${Math.round(target.x)},${Math.round(target.y)}`,
    snapTarget ? snapTarget.componentId : '',
    components.length, wires.length,
  ].join('|');
  if (resultCache.key === key && resultCache.result) return resultCache.result;

  let path: Vec2[];
  let routed = false;

  if (draft.waypoints.length > 0) {
    // Honor the user's committed bends; preview only the final leg.
    const last = draft.waypoints[draft.waypoints.length - 1];
    path = [start, ...draft.waypoints, ...elbow(last, target)];
  } else {
    // No user bends yet: preview the actual A* route (bounded budget) so
    // obstacle detours are visible BEFORE the click commits them. Endpoint
    // freeing is limited to real snap targets (pins) — a raw-cursor target
    // over a component body must not open tunnels in the cached grid.
    let routePath: Vec2[] | null = null;
    try {
      const grid = routingGrid(components, wires);
      const route = findRoute(grid, start, target, {
        maxIterations: PREVIEW_MAX_ITERATIONS,
        freeEndpoints: snapTarget != null,
      });
      if (route.found && route.path.length >= 2) {
        routePath = route.path;
        routed = true;
      }
    } catch {
      routePath = null;
    }
    path = routePath ?? [start, ...elbow(start, target)];
  }

  const result: DraftPreviewResult = {
    path,
    committedWaypoints: draft.waypoints.length,
    routed,
  };
  resultCache = { key, result };
  return result;
}
