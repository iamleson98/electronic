// Terminal snap — pure, zoom-aware, nearest-match pin snapping.
//
// Why this module exists: the previous findTerminalAt returned the FIRST
// terminal inside a fixed 1.5-grid-unit radius (component-array order), so
// with several pins nearby the cursor grabbed whichever component was
// iterated first — a classic "snapping grabs the wrong pin" bug. It also
// scaled the radius with zoom, making the magnet enormous when zoomed in
// (1.5 units × 18px × 4× zoom = 108px!) and tiny when zoomed out.
//
// This module fixes both: nearest-match wins, and the snap radius is a
// fixed SCREEN-space distance (27px at any zoom), matching the convention
// used by professional editors (KiCad, Figma). Pure functions only — no
// React, no store — so it is directly unit-testable.

import { getPlugin } from '@/lib/circuit/registry';
import { rotateTerminal } from '@/lib/circuit/components/draw';
import type { CircuitComponent, TerminalDef, Vec2, HierarchicalSheet } from '@/lib/circuit/types';
import { CELL_SIZE } from './canvas-types';

/** A resolved snap target (component terminal or hierarchical sheet pin). */
export interface TerminalHit {
  componentId: string;
  terminalId: string;
  /** Grid-space position of the terminal. */
  pos: Vec2;
  /** Euclidean distance from the query point to `pos`, in grid units. */
  dist: number;
}

export interface TerminalSnapOptions {
  /** Snap radius in SCREEN pixels (default 27 — the old 1.5-unit default at zoom 1). */
  snapRadiusPx?: number;
  /** Current canvas zoom — converts the screen-space radius to grid units. */
  zoom?: number;
  /** A terminal to ignore (e.g. the wire draft's source pin). */
  exclude?: { componentId: string; terminalId: string } | null;
}

/** Rotation-aware grid position of a component terminal. */
export function terminalGridPosition(comp: CircuitComponent, terminal: TerminalDef): Vec2 {
  const plugin = getPlugin(comp.type);
  if (!plugin) return { x: comp.position.x + terminal.position.x, y: comp.position.y + terminal.position.y };
  const rotated = rotateTerminal(terminal, comp.rotation, plugin.boundingBox);
  return { x: comp.position.x + rotated.position.x, y: comp.position.y + rotated.position.y };
}

/**
 * Find the NEAREST terminal within the snap radius of a grid-space point.
 * Returns null when nothing is in range, or when snap is disabled (radius 0).
 * Distance ties resolve in iteration order (components, then sheet pins).
 */
export function findNearestTerminal(
  gx: number,
  gy: number,
  components: CircuitComponent[],
  sheets: HierarchicalSheet[],
  opts: TerminalSnapOptions = {},
): TerminalHit | null {
  const snapRadiusPx = opts.snapRadiusPx ?? 27;
  const zoom = opts.zoom ?? 1;
  if (snapRadiusPx <= 0 || zoom <= 0) return null;
  // Screen-space radius → grid units, so the magnet feels constant on screen.
  const radiusGrid = snapRadiusPx / (CELL_SIZE * zoom);
  const radiusSq = radiusGrid * radiusGrid;

  let best: TerminalHit | null = null;
  let bestDistSq = radiusSq;

  for (const comp of components) {
    const plugin = getPlugin(comp.type);
    if (!plugin) continue;
    for (const t of plugin.terminals) {
      if (t.hidden) continue;
      if (opts.exclude && comp.id === opts.exclude.componentId && t.id === opts.exclude.terminalId) continue;
      const pos = terminalGridPosition(comp, t);
      const dx = pos.x - gx;
      const dy = pos.y - gy;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestDistSq) {
        bestDistSq = distSq;
        best = { componentId: comp.id, terminalId: t.id, pos, dist: Math.sqrt(distSq) };
      }
    }
  }

  if (!best) {
    // Hierarchical sheet pins snap with the same screen-space radius.
    for (const sheet of sheets) {
      for (const pin of sheet.pins) {
        if (opts.exclude && `__sheet:${sheet.id}` === opts.exclude.componentId && `pin:${pin.id}` === opts.exclude.terminalId) continue;
        const pos = { x: sheet.position.x + pin.position.x, y: sheet.position.y + pin.position.y };
        const dx = pos.x - gx;
        const dy = pos.y - gy;
        const distSq = dx * dx + dy * dy;
        if (distSq <= bestDistSq) {
          bestDistSq = distSq;
          best = { componentId: `__sheet:${sheet.id}`, terminalId: `pin:${pin.id}`, pos, dist: Math.sqrt(distSq) };
        }
      }
    }
  }

  return best;
}
