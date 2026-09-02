// Wire draft preview — the polyline the user sees while drawing a wire.
//
// WYSIWYG contract: the preview is EXACTLY the wire completeWire will
// commit. Wires are straight ("the old way"):
//   - with NO user bends: the direct line (aligned endpoints) or the
//     horizontal-first L-elbow — and when that route would run 1:1 on top
//     of an existing wire, the same alternate-elbow / straight-detour
//     fallback the commit uses;
//   - WITH user bends: the bends are honored and the final leg takes the
//     same horizontal-first elbow the commit's orthogonalizePath produces;
//     no fallback detours (like the commit), so an overlapping user route
//     previews red;
//   - when the cursor is within snap range of a terminal, the preview ends
//     exactly at that terminal, so "what you see is what you connect".
//
// The 1:1 overlap guard runs live: when the tentative wire would overlap
// and no straight route fixes it, the result is flagged so the renderer
// draws it red — the user knows BEFORE the click that it will be rejected.
//
// Pure module (no React/store) + a small memo keyed on the inputs that
// actually change, so the 60fps render loop stays cheap.

import type { CircuitComponent, HierarchicalSheet, Vec2, Wire } from '@/lib/circuit/types';
import { resolveEndpointGridPos } from '@/lib/circuit/endpoint-position';
import { findWireOverlap, planWireRoute } from '@/lib/circuit/wire-overlap';

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
  /** True when the tentative wire would overlap an existing wire 1:1 and
   *  no straight fallback fixes it — completeWire will REJECT it (red). */
  overlap: boolean;
}

/** Elbow point matching getWirePath/orthogonalizePath (horizontal first). */
function elbow(from: Vec2, to: Vec2): Vec2[] {
  if (Math.abs(to.x - from.x) < 0.01 || Math.abs(to.y - from.y) < 0.01) {
    return [to];
  }
  return [{ x: to.x, y: from.y }, to];
}

// Result memo: skip the geometry work when nothing changed.
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
    // Geometry fingerprints: overlap detection depends on WHERE the existing
    // wires run, not just how many there are.
    components.map((c) => `${c.id}@${c.position.x},${c.position.y}`).join(','),
    wires.map((w) => `${w.id}:${(w.waypoints ?? []).map((p) => `${p.x},${p.y}`).join(';')}`).join(','),
  ].join('|');
  if (resultCache.key === key && resultCache.result) return resultCache.result;

  let path: Vec2[];
  let overlap: boolean;

  if (draft.waypoints.length > 0) {
    // User-routed: honor the bends; final leg = the commit's elbow; the
    // whole path is checked with NO fallbacks — exactly like the commit.
    const last = draft.waypoints[draft.waypoints.length - 1];
    path = [start, ...draft.waypoints, ...elbow(last, target)];
    overlap = findWireOverlap(path, wires, components, sheets) != null;
  } else {
    const plan = planWireRoute(start, target, wires, components, sheets, []);
    if (plan.overlap) {
      // Blocked: preview the default L-route in red (the wire that fails).
      path = [start, ...elbow(start, target)];
      overlap = true;
    } else {
      // The default candidate ([] waypoints) is expanded through the SAME
      // horizontal-first elbow getWirePath renders; explicit fallback
      // waypoints are already orthogonal.
      path = plan.waypoints.length > 0
        ? [start, ...plan.waypoints, target]
        : [start, ...elbow(start, target)];
      overlap = false;
    }
  }

  const result: DraftPreviewResult = {
    path,
    committedWaypoints: draft.waypoints.length,
    overlap,
  };
  resultCache = { key, result };
  return result;
}
