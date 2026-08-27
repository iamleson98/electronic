// LAYOUT HELPERS — collision-free component placement for AI-built circuits.
// ─────────────────────────────────────────────────────────────────────────────
// The AI used to hand-pick grid coordinates, which produced overlapping
// components. These helpers give tools (and the one-shot circuit patterns)
// automatic placement: pick a hint location, scan outward in rings until a
// free spot is found, and lay out groups of components in clean rows.
//
// Occupancy model: a component's visual footprint is approximated by a
// ±3-grid-unit box around its position (terminal offsets in this codebase
// span 0–5 units). Conservative and simple — exact glyph bounds are not
// worth the coupling.

import type { ToolContext } from './types';
import type { CircuitComponent } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';

export const GRID_MIN_X = 2;
export const GRID_MAX_X = 38;
export const GRID_MIN_Y = 2;
export const GRID_MAX_Y = 28;

/** Half-extent of the collision box around each placed component. */
const FOOTPRINT = 3;

interface Occupied {
  cells: Set<string>;
}

function buildOccupancy(components: CircuitComponent[], extra: Array<{ x: number; y: number }> = []): Occupied {
  const cells = new Set<string>();
  const mark = (x: number, y: number) => {
    for (let dx = -FOOTPRINT; dx <= FOOTPRINT; dx++) {
      for (let dy = -FOOTPRINT; dy <= FOOTPRINT; dy++) {
        cells.add(`${x + dx},${y + dy}`);
      }
    }
  };
  for (const c of components) mark(Math.round(c.position.x), Math.round(c.position.y));
  for (const p of extra) mark(Math.round(p.x), Math.round(p.y));
  return { cells };
}

function isFree(occ: Occupied, x: number, y: number): boolean {
  if (x < GRID_MIN_X || x > GRID_MAX_X || y < GRID_MIN_Y || y > GRID_MAX_Y) return false;
  // Check the component's own footprint — every cell must be free of OTHERS' boxes
  for (let dx = -FOOTPRINT + 1; dx <= FOOTPRINT - 1; dx++) {
    for (let dy = -FOOTPRINT + 1; dy <= FOOTPRINT - 1; dy++) {
      if (occ.cells.has(`${x + dx},${y + dy}`)) return false;
    }
  }
  return true;
}

/**
 * Find the nearest collision-free grid spot to (hintX, hintY), scanning
 * outward in square rings on a 1-unit stride. Falls back to the hint itself
 * if the entire grid is somehow full.
 */
export function findFreeSpot(ctx: ToolContext, hintX: number, hintY: number): { x: number; y: number } {
  const occ = buildOccupancy(ctx.doc.components);
  const hx = Math.min(GRID_MAX_X, Math.max(GRID_MIN_X, Math.round(hintX)));
  const hy = Math.min(GRID_MAX_Y, Math.max(GRID_MIN_Y, Math.round(hintY)));
  for (let r = 0; r <= 40; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        // Only the ring itself (avoid re-scanning the interior)
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = hx + dx;
        const y = hy + dy;
        if (isFree(occ, x, y)) return { x, y };
      }
    }
  }
  return { x: hx, y: hy };
}

/**
 * Compute the smallest offset needed so that a whole group of relative
 * placements (anchor + relative coords) fits without colliding with
 * existing components or each other's reserved cells.
 */
export function groupPlacementOffset(
  ctx: ToolContext,
  placements: Array<{ x: number; y: number }>,
  anchor: { x: number; y: number },
): { x: number; y: number } {
  if (placements.length === 0) return anchor;
  const occ = buildOccupancy(ctx.doc.components);
  // Try the anchor and its surroundings; find offset where EVERY placement is free
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  const ax = Math.round(anchor.x);
  const ay = Math.round(anchor.y);
  for (let r = 0; r <= 40 && !best; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const ox = ax + dx;
        const oy = ay + dy;
        const fits = placements.every(p => isFree(occ, ox + p.x, oy + p.y));
        if (fits) {
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) { bestDist = dist; best = { x: ox, y: oy }; }
        }
      }
    }
    if (best) break; // nearest ring that fits — good enough
  }
  if (best) return best;
  // Grid is crowded: fall back to the anchor itself. Overlapping a few
  // components is better than the corner-clamp alternative (every component
  // clamped to the same grid corner).
  return { x: ax, y: ay };
}

/**
 * Create a component from a pattern placement with full defaults merged.
 * Returns the created component (already appended to ctx.doc).
 */
export function createComponent(
  ctx: ToolContext,
  type: string,
  x: number,
  y: number,
  params: Record<string, any> = {},
  idHint?: string,
): CircuitComponent {
  const plugin = getPlugin(type);
  if (!plugin) throw new Error(`Unknown component type: ${type}`);
  const defaults: Record<string, any> = {};
  for (const p of plugin.parameters) defaults[p.key] = p.default;
  const id = idHint && !ctx.doc.components.some(c => c.id === idHint)
    ? idHint
    : `${type === 'resistor' ? 'r' : type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const comp: CircuitComponent = {
    id,
    type,
    position: {
      x: Math.min(GRID_MAX_X, Math.max(GRID_MIN_X, Math.round(x))),
      y: Math.min(GRID_MAX_Y, Math.max(GRID_MIN_Y, Math.round(y))),
    },
    rotation: 0,
    parameters: { ...defaults, ...params },
  };
  ctx.doc.components.push(comp);
  return comp;
}

/**
 * Wire two components by id + terminal. Validates that both terminals exist
 * on the component's plugin — a typo'd terminal id silently disconnects the
 * net (the wire endpoint maps to ground) and produces floating-node failures
 * that are very hard to trace, so this throws instead.
 */
export function connect(
  ctx: ToolContext,
  fromComp: CircuitComponent,
  fromTerm: string,
  toComp: CircuitComponent,
  toTerm: string,
): string {
  const fromPlugin = getPlugin(fromComp.type);
  const toPlugin = getPlugin(toComp.type);
  if (fromPlugin && !fromPlugin.terminals.some(t => t.id === fromTerm)) {
    throw new Error(`Terminal "${fromTerm}" does not exist on ${fromComp.type} (${fromComp.id}). Available: ${fromPlugin.terminals.map(t => t.id).join(', ')}`);
  }
  if (toPlugin && !toPlugin.terminals.some(t => t.id === toTerm)) {
    throw new Error(`Terminal "${toTerm}" does not exist on ${toComp.type} (${toComp.id}). Available: ${toPlugin.terminals.map(t => t.id).join(', ')}`);
  }
  const wire = {
    id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    from: { componentId: fromComp.id, terminalId: fromTerm },
    to: { componentId: toComp.id, terminalId: toTerm },
  };
  ctx.doc.wires.push(wire as any);
  return wire.id;
}

/** Check a terminal exists on a component's plugin (defensive for patterns). */
export function terminalExists(comp: CircuitComponent, term: string): boolean {
  const plugin = getPlugin(comp.type);
  return !!plugin?.terminals.some(t => t.id === term);
}
