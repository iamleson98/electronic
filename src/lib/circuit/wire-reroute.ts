// Wire re-routing after component mutations + document-load normalization.
//
// WHY THIS MODULE EXISTS
// ───────────────────────
// moveComponent / rotateComponent / mirrorComponent / align / distribute /
// paste all mutate component geometry WITHOUT touching wire waypoints. A
// wire whose endpoints moved but whose waypoints are stale renders DIAGONAL
// segments (the renderer draws waypoints verbatim — see getWirePath), and
// the current-flow dots then ride those diagonals. Users rearranging an
// example circuit saw exactly that: "wires are not orthogonal, current does
// not flow along the wires".
//
// THE INVARIANT THIS MODULE RESTORES
// ───────────────────────────────────
// After ANY component mutation, every wire attached to a mutated component
// is re-orthogonalized: diagonal legs are split with a horizontal-first
// elbow (identical to the renderer's default L semantics), duplicate and
// collinear interior points are removed. Wire ENDPOINTS (terminal refs) are
// never touched, so the netlist is bit-identical before/after — connectivity
// comes from terminal pairs, not geometry (see buildNodeMap).
//
// Also here: orthogonalizeDocumentWires — the load-time normalizer for
// documents that did NOT pass through examples.ts (share URLs, autosave /
// crash recovery, saved Library rows, imports, AI partial applies). Those
// sources can carry legacy diagonal waypoints; this brings them up to the
// editor's orthogonal style without re-routing (endpoint/netlist preserving,
// geometry-only).
//
// Pure module: no React, no store. Fast enough for per-mousemove use during
// drags (only wires attached to the mutated ids are touched; untouched wires
// keep their object identity so render memoization stays effective).

import type { CircuitDocument, CircuitComponent, HierarchicalSheet, Vec2, Wire } from './types';
import { resolveEndpointGridPos } from './endpoint-position';
import { orthogonalizePath } from './wire-geometry';
import { simplifyPath, pathToWaypoints } from './smart-wire-router';

const EPS = 1e-6;

/** Dedupe consecutive near-identical points (simplifyPath needs exact collinearity). */
function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) out.push(p);
  }
  return out;
}

/** Does the rendered polyline contain any diagonal segment? (waypoints verbatim + default L) */
export function hasDiagonalSegment(
  from: Vec2,
  to: Vec2,
  waypoints: Vec2[] | undefined,
): boolean {
  const pts: Vec2[] = [from];
  if (waypoints && waypoints.length > 0) {
    pts.push(...waypoints);
  } else if (Math.abs(to.x - from.x) > EPS && Math.abs(to.y - from.y) > EPS) {
    pts.push({ x: to.x, y: from.y }); // default horizontal-first elbow
  }
  pts.push(to);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (Math.abs(b.x - a.x) > EPS && Math.abs(b.y - a.y) > EPS) return true;
  }
  return false;
}

/**
 * Re-orthogonalize every wire attached to a mutated component.
 *
 * @param components the POST-mutation component list (terminal positions resolved against it)
 * @param wires the current wires
 * @param sheets hierarchical sheets (endpoint resolution)
 * @param mutatedIds ids of components whose geometry just changed
 * @returns a new wires array — untouched wires keep identity, changed wires are new objects
 */
export function rerouteAttachedWires(
  components: CircuitComponent[],
  wires: Wire[],
  sheets: HierarchicalSheet[],
  mutatedIds: Set<string>,
): Wire[] {
  if (mutatedIds.size === 0) return wires;
  let changed = false;
  const next = wires.map((wire) => {
    const attached =
      mutatedIds.has(wire.from.componentId) || mutatedIds.has(wire.to.componentId);
    if (!attached) return wire;
    if (!wire.waypoints || wire.waypoints.length === 0) {
      // No stored waypoints → the renderer's default route (direct line when
      // aligned, horizontal-first L otherwise) is orthogonal by construction.
      return wire;
    }
    const from = resolveEndpointGridPos(wire.from, components, sheets);
    const to = resolveEndpointGridPos(wire.to, components, sheets);
    if (!from || !to) return wire; // unresolvable endpoint — leave verbatim
    const full = simplifyPath(dedupe([from, ...orthogonalizePath(from, to, wire.waypoints), to]));
    const wps = pathToWaypoints(full);
    if (wps.length === 0) {
      const bare = { ...wire };
      delete bare.waypoints;
      return bare;
    }
    // Identity check: nothing actually moved on the wire — keep the old object.
    const same =
      wire.waypoints.length === wps.length &&
      wire.waypoints.every((w, i) => Math.abs(w.x - wps[i].x) < EPS && Math.abs(w.y - wps[i].y) < EPS);
    if (same) return wire;
    return { ...wire, waypoints: wps.map((p) => ({ x: p.x, y: p.y })) };
  });
  for (let i = 0; i < wires.length; i++) {
    if (next[i] !== wires[i]) { changed = true; break; }
  }
  return changed ? next : wires;
}

/**
 * Load-time orthogonalization for arbitrary documents (share URL, autosave,
 * saved Library rows, imports, AI partial applies): every wire's stored route
 * is made orthogonal + corner-sparse. Geometry-only — endpoints, and
 * therefore the netlist, are untouched. No overlap re-routing (examples keep
 * their richer module-load normalizeExampleWires; user docs must never have
 * their authored corridors silently re-planned).
 */
export function orthogonalizeDocumentWires(doc: CircuitDocument): CircuitDocument {
  const components = doc.components ?? [];
  const sheets = doc.sheets ?? [];
  const wires = doc.wires ?? [];
  if (wires.length === 0) return doc;

  const dirty: boolean[] = wires.map((w) => !!(w.waypoints && w.waypoints.length > 0));
  if (!dirty.some(Boolean)) return doc;

  const newWires: Wire[] = wires.map((wire, i) => {
    if (!dirty[i]) return wire;
    const from = resolveEndpointGridPos(wire.from, components, sheets);
    const to = resolveEndpointGridPos(wire.to, components, sheets);
    if (!from || !to) return wire;
    if (!hasDiagonalSegment(from, to, wire.waypoints)) {
      // Already orthogonal — but sparsify redundant collinear waypoints so
      // stale same-position duplicates don't linger (e.g. legacy documents
      // with duplicate waypoints).
      const full = simplifyPath(dedupe([from, ...wire.waypoints!, to]));
      const wps = pathToWaypoints(full);
      if (wps.length === wire.waypoints!.length) return wire;
      if (wps.length === 0) {
        const bare = { ...wire };
        delete bare.waypoints;
        return bare;
      }
      return { ...wire, waypoints: wps.map((p) => ({ x: p.x, y: p.y })) };
    }
    const full = simplifyPath(dedupe([from, ...orthogonalizePath(from, to, wire.waypoints!), to]));
    const wps = pathToWaypoints(full);
    if (wps.length === 0) {
      const bare = { ...wire };
      delete bare.waypoints;
      return bare;
    }
    return { ...wire, waypoints: wps.map((p) => ({ x: p.x, y: p.y })) };
  });
  const anyChanged = newWires.some((w, i) => w !== wires[i]);
  return anyChanged ? { ...doc, wires: newWires } : doc;
}
