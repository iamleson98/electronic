// Smart wire router — obstacle-aware, non-overlapping, with crossing indicators.
//
// This module replaces the current simple L-shaped wire routing with:
//   1. A* pathfinding on a grid that avoids component bodies and existing wires.
//   2. Orthogonal routing (90° corners only) with optional 45° mode.
//   3. Crossing detection: when two wires cross without connecting, a "hop"
//      indicator (small arc) is drawn. When they DO connect, a junction dot
//      is drawn.
//   4. Terminal snapping: when drawing a wire, the cursor snaps to nearby
//      terminals (not just grid points).
//   5. Wire midpoint dragging with collision avoidance.
//
// The A* algorithm operates on a coarse grid (1 cell = 1 grid unit) where
// each cell is marked as:
//   - FREE: can route through
//   - BLOCKED: component body (cannot route through)
//   - WIRE: existing wire (can route through but costs more to discourage overlap)
//   - TERMINAL: component terminal (routing endpoint, always accessible)

import type { Vec2, Wire, CircuitComponent, ComponentPlugin } from './types';
import { terminalPos } from './endpoint-position';

/** Absolute grid position of a terminal, honoring the component's quarter-turn
 *  rotation — the same transform the canvas renderer uses. The router used to
 *  ignore rotation, so wires on rotated components were routed/marked at the
 *  unrotated pin positions. */
function terminalGridPos(
  comp: CircuitComponent,
  term: { id: string; position: Vec2 },
  plugin: ComponentPlugin,
): Vec2 {
  return terminalPos(comp, term, plugin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing presets (single source of truth for editor-grade routing)
// ─────────────────────────────────────────────────────────────────────────────

/** Cost of routing THROUGH a cell occupied by an existing wire. High enough
 *  that a detour of up to ~11 cells is still cheaper than a single overlap —
 *  overlap only happens when it is genuinely forced. (The old value of 5 let
 *  A* plow straight through wire runs, producing the "wires pile on top of
 *  each other" complaint.) */
export const WIRE_CROSS_COST = 12;
/** Extra cost for cells orthogonally ADJACENT to an existing wire — keeps a
 *  one-cell visual gap between parallel runs whenever a free path exists. */
export const WIRE_CLEARANCE_COST = 2.5;
/** Extra cost for free cells hugging a component body — nudges routes away
 *  from symbols so pins stay visible under wires. */
export const BODY_CLEARANCE_COST = 1.5;
/** Preview routes get a small iteration budget so a pathological cursor move
 *  can never stall the render loop; the commit path uses the full budget. */
export const PREVIEW_MAX_ITERATIONS = 4000;

/** Default document routing-grid size (grid units). */
const MIN_GRID = { width: 100, height: 60 };
const MAX_GRID = { width: 320, height: 220 };
const GRID_MARGIN = 20;

/**
 * Compute a routing grid that actually covers the document: component
 * bounding boxes, wire endpoints and waypoints, plus a margin. The old
 * hard-coded 100×60 grid silently clamped routes for anything placed past
 * x=100 or y=60 (mis-routed wires to far-away components).
 */
export function documentGridSize(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
): { width: number; height: number } {
  let maxX = MIN_GRID.width - GRID_MARGIN;
  let maxY = MIN_GRID.height - GRID_MARGIN;
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const bb = plugin.boundingBox;
    const bw = comp.rotation % 2 === 1 ? bb.height : bb.width;
    const bh = comp.rotation % 2 === 1 ? bb.width : bb.height;
    maxX = Math.max(maxX, comp.position.x + bw);
    maxY = Math.max(maxY, comp.position.y + bh);
  }
  for (const wire of wires) {
    const path = getWireGridPath(wire, components, plugins);
    for (const pt of path) {
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }
  return {
    width: Math.max(MIN_GRID.width, Math.min(MAX_GRID.width, Math.ceil(maxX + GRID_MARGIN))),
    height: Math.max(MIN_GRID.height, Math.min(MAX_GRID.height, Math.ceil(maxY + GRID_MARGIN))),
  };
}

/**
 * Build the editor routing grid for a whole document: dynamic size (covers
 * all content), editor-grade costs (WIRE_CROSS_COST + clearance map).
 */
export function buildRoutingGridForDocument(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
): RoutingGrid {
  const size = documentGridSize(components, wires, plugins);
  return buildRoutingGrid(components, wires, plugins, size, WIRE_CROSS_COST, {
    wireClearanceCost: WIRE_CLEARANCE_COST,
    bodyClearanceCost: BODY_CLEARANCE_COST,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CellType = 'free' | 'blocked' | 'wire' | 'terminal';

export interface RoutingGrid {
  width: number;
  height: number;
  cells: CellType[][];  // [y][x]
  /** Cost multiplier for routing through wire cells (higher = more avoidance). */
  wireCost: number;
  /** Optional extra-cost map [y][x] (clearance around wires/bodies).
   *  Optional so hand-built grids (tests, callers) keep working. */
  clearance?: number[][];
}

export interface RoutingGridOptions {
  /** Extra cost for cells orthogonally adjacent to existing wires (0 = off). */
  wireClearanceCost?: number;
  /** Extra cost for free cells orthogonally adjacent to component bodies (0 = off). */
  bodyClearanceCost?: number;
}

/**
 * Rasterize a polyline path to EVERY grid cell it passes through (including
 * cells between corner waypoints). Orthogonal segments walk axis-by-axis;
 * diagonal segments sample along the dominant axis. Required so that
 * sparse (corner-only) wire waypoints still block/risk the same cells the
 * rendered wire actually occupies.
 */
export function expandPathToCells(path: Vec2[]): Vec2[] {
  const cells: Vec2[] = [];
  if (path.length === 0) return cells;
  cells.push({ x: Math.round(path[0].x), y: Math.round(path[0].y) });
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const steps = Math.max(Math.abs(Math.round(b.x) - Math.round(a.x)), Math.abs(Math.round(b.y) - Math.round(a.y)));
    if (steps === 0) continue;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      cells.push({ x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) });
    }
  }
  return cells;
}

export interface RouteResult {
  /** Grid points the wire passes through (including start and end). */
  path: Vec2[];
  /** Whether the route was found (false = no path, use fallback). */
  found: boolean;
  /** List of crossing points where this wire crosses existing wires. */
  crossings: CrossingPoint[];
}

export interface CrossingPoint {
  position: Vec2;
  /** The ID of the wire being crossed. */
  crossedWireId: string;
  /** Whether this is a connection (junction) or just a crossing (hop). */
  isJunction: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a routing grid from the circuit.
 * @param components All components on the canvas.
 * @param wires All existing wires.
 * @param plugins Plugin map.
 * @param gridSize Width/height of the routing grid (in grid units).
 * @param wireCost Cost multiplier for routing through wire cells.
 */
export function buildRoutingGrid(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  gridSize: { width: number; height: number },
  wireCost: number = 5,
  options: RoutingGridOptions = {},
): RoutingGrid {
  const { width, height } = gridSize;
  const cells: CellType[][] = Array.from({ length: height }, () =>
    new Array(width).fill('free' as CellType),
  );
  const bodyMask: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));
  const wireMask: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));

  // Mark component bodies as blocked. Terminal cells that fall INSIDE the
  // body region stay blocked too — findRoute() force-frees the route's own
  // start/end cells, and the integration tests encode this behavior. (The
  // old "clear terminals" loop here was dead code that marked nothing.)
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const bb = plugin.boundingBox;
    // A 90°/270°-rotated component occupies width↔height swapped extents.
    const bw = comp.rotation % 2 === 1 ? bb.height : bb.width;
    const bh = comp.rotation % 2 === 1 ? bb.width : bb.height;
    const x0 = Math.max(0, Math.floor(comp.position.x));
    const y0 = Math.max(0, Math.floor(comp.position.y));
    const x1 = Math.min(width - 1, Math.ceil(comp.position.x + bw) - 1);
    const y1 = Math.min(height - 1, Math.ceil(comp.position.y + bh) - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        cells[y][x] = 'blocked';
        bodyMask[y][x] = true;
      }
    }
  }

  // Mark existing wires: rasterize the FULL path (every cell between
  // waypoints), not just the corner points — sparse waypoint lists must
  // block the same cells the rendered wire occupies.
  for (const wire of wires) {
    const path = getWireGridPath(wire, components, plugins);
    for (const pt of expandPathToCells(path)) {
      if (pt.x >= 0 && pt.x < width && pt.y >= 0 && pt.y < height) {
        if (cells[pt.y][pt.x] !== 'terminal') {
          cells[pt.y][pt.x] = 'wire';
          wireMask[pt.y][pt.x] = true;
        }
      }
    }
  }

  const grid: RoutingGrid = { width, height, cells, wireCost };

  // Clearance map: extra cost in the 1-cell halo around wires and bodies so
  // parallel runs keep a visible gap and routes don't hug symbol bodies.
  // Terminals stay free (pins must remain cheap to reach).
  const wireClear = options.wireClearanceCost ?? 0;
  const bodyClear = options.bodyClearanceCost ?? 0;
  if (wireClear > 0 || bodyClear > 0) {
    const clearance: number[][] = Array.from({ length: height }, () => new Array(width).fill(0));
    const mark = (x: number, y: number, cost: number) => {
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      if (cells[y][x] === 'blocked' || cells[y][x] === 'wire') return;
      clearance[y][x] = Math.max(clearance[y][x], cost);
    };
    if (wireClear > 0) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!wireMask[y][x]) continue;
          mark(x, y - 1, wireClear); mark(x, y + 1, wireClear);
          mark(x - 1, y, wireClear); mark(x + 1, y, wireClear);
        }
      }
    }
    if (bodyClear > 0) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!bodyMask[y][x]) continue;
          mark(x, y - 1, bodyClear); mark(x, y + 1, bodyClear);
          mark(x - 1, y, bodyClear); mark(x + 1, y, bodyClear);
        }
      }
    }
    grid.clearance = clearance;
  }

  return grid;
}

/**
 * Get the grid-space path of a wire (from terminal to terminal).
 */
export function getWireGridPath(
  wire: Wire,
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
): Vec2[] {
  const fromComp = components.find(c => c.id === wire.from.componentId);
  const toComp = components.find(c => c.id === wire.to.componentId);
  if (!fromComp || !toComp) return [];

  const fromPlugin = plugins.get(fromComp.type);
  const toPlugin = plugins.get(toComp.type);
  if (!fromPlugin || !toPlugin) return [];

  const fromTerm = fromPlugin.terminals.find(t => t.id === wire.from.terminalId);
  const toTerm = toPlugin.terminals.find(t => t.id === wire.to.terminalId);
  if (!fromTerm || !toTerm) return [];

  // Calculate terminal positions in grid coordinates (rotation-aware)
  const fromPos = {
    x: Math.round(terminalGridPos(fromComp, fromTerm, fromPlugin).x),
    y: Math.round(terminalGridPos(fromComp, fromTerm, fromPlugin).y),
  };
  const toPos = {
    x: Math.round(terminalGridPos(toComp, toTerm, toPlugin).x),
    y: Math.round(terminalGridPos(toComp, toTerm, toPlugin).y),
  };

  const path: Vec2[] = [fromPos];
  if (wire.waypoints && wire.waypoints.length > 0) {
    path.push(...wire.waypoints.map(w => ({ x: Math.round(w.x), y: Math.round(w.y) })));
  } else {
    // Simple L-route
    path.push({ x: toPos.x, y: fromPos.y });
  }
  path.push(toPos);
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// A* Pathfinding
// ─────────────────────────────────────────────────────────────────────────────

interface AStarNode {
  x: number;
  y: number;
  g: number;  // cost from start
  h: number;  // heuristic (Manhattan distance to goal)
  f: number;  // g + h
  parent: AStarNode | null;
}

/**
 * Find the optimal orthogonal route from start to end on the routing grid.
 * Uses A* with Manhattan distance heuristic.
 *
 * @param grid The routing grid.
 * @param start Start point (grid coordinates).
 * @param end End point (grid coordinates).
 * @returns The route result with path and crossings.
 */
export function findRoute(
  grid: RoutingGrid,
  start: Vec2,
  end: Vec2,
  opts?: { maxIterations?: number; freeEndpoints?: boolean },
): RouteResult {
  const { width, height, cells, wireCost, clearance } = grid;

  // Clamp start and end to grid bounds
  const sx = Math.max(0, Math.min(width - 1, Math.round(start.x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(start.y)));
  const ex = Math.max(0, Math.min(width - 1, Math.round(end.x)));
  const ey = Math.max(0, Math.min(height - 1, Math.round(end.y)));

  // If start or end is blocked, force it to be accessible
  // (terminals are always routable even if inside a component body).
  // freeEndpoints=false (live preview with a raw-cursor target) skips the
  // mutation so a cursor hovering over a body doesn't permanently open a
  // one-cell tunnel in a CACHED grid — the preview then falls back to the
  // elbow route, which is the honest answer for an unreachable target.
  if (opts?.freeEndpoints !== false) {
    if (cells[sy]?.[sx] === 'blocked') cells[sy][sx] = 'terminal';
    if (cells[ey]?.[ex] === 'blocked') cells[ey][ex] = 'terminal';
  }

  // A* open list (simple priority queue using array)
  const open: AStarNode[] = [];
  const closed = new Set<string>();
  const openMap = new Map<string, AStarNode>();

  const startNode: AStarNode = {
    x: sx, y: sy, g: 0,
    h: Math.abs(sx - ex) + Math.abs(sy - ey),
    f: 0, parent: null,
  };
  startNode.f = startNode.g + startNode.h;
  open.push(startNode);
  openMap.set(`${sx},${sy}`, startNode);

  const directions = [
    { dx: 0, dy: -1 },  // up
    { dx: 0, dy: 1 },   // down
    { dx: -1, dy: 0 },  // left
    { dx: 1, dy: 0 },   // right
  ];

  let iterations = 0;
  const maxIterations = opts?.maxIterations ?? width * height * 2;  // safety limit

  while (open.length > 0 && iterations < maxIterations) {
    iterations++;

    // Find node with lowest f (simple linear scan — fine for small grids)
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0]!;
    openMap.delete(`${current.x},${current.y}`);
    closed.add(`${current.x},${current.y}`);

    // Goal reached
    if (current.x === ex && current.y === ey) {
      const path: Vec2[] = [];
      let node: AStarNode | null = current;
      while (node) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return { path, found: true, crossings: [] };
    }

    // Expand neighbors
    for (const dir of directions) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;

      // Bounds check
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

      const key = `${nx},${ny}`;
      if (closed.has(key)) continue;

      const cell = cells[ny][nx];
      if (cell === 'blocked') continue;

      // Cost: base 1 for free cells, wireCost for wire cells, plus the
      // optional clearance halo (keeps distance from wires/bodies).
      let stepCost = 1;
      if (cell === 'wire') stepCost = wireCost;
      // Terminals are free
      if (cell === 'terminal') stepCost = 1;
      if (clearance && stepCost === 1 && cell !== 'terminal') {
        stepCost += clearance[ny][nx] ?? 0;
      }

      // Penalize direction changes (prefer straight lines)
      let turnPenalty = 0;
      if (current.parent) {
        const prevDx = current.x - current.parent.x;
        const prevDy = current.y - current.parent.y;
        if (prevDx !== dir.dx || prevDy !== dir.dy) {
          turnPenalty = 0.5;  // small penalty for turning
        }
      }

      const g = current.g + stepCost + turnPenalty;
      const h = Math.abs(nx - ex) + Math.abs(ny - ey);
      const f = g + h;

      const existing = openMap.get(key);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = f;
          existing.parent = current;
        }
      } else {
        const node: AStarNode = { x: nx, y: ny, g, h, f, parent: current };
        open.push(node);
        openMap.set(key, node);
      }
    }
  }

  // No path found — fall back to simple L-route
  return {
    path: [start, { x: end.x, y: start.y }, end],
    found: false,
    crossings: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Crossing detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect where a new wire path crosses existing wires.
 * Two wires "cross" when they share a grid cell but are NOT at a terminal.
 *
 * @param newPath The new wire's grid path.
 * @param existingWires All existing wires.
 * @param components All components.
 * @param plugins Plugin map.
 * @returns List of crossing points.
 */
export function detectCrossings(
  newPath: Vec2[],
  existingWires: Wire[],
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
): CrossingPoint[] {
  const crossings: CrossingPoint[] = [];
  // Rasterize the new path so a mid-segment crossing (not at a corner)
  // is detected too — the corner-only path missed those.
  const newCells = new Set(expandPathToCells(newPath).map(p => `${p.x},${p.y}`));

  for (const wire of existingWires) {
    const wirePath = getWireGridPath(wire, components, plugins);
    for (const pt of expandPathToCells(wirePath)) {
      const key = `${pt.x},${pt.y}`;
      if (newCells.has(key)) {
        // Check if this is at a terminal (junction) or just a crossing (hop)
        const isJunction = isAtTerminal(pt, components, plugins);
        crossings.push({
          position: pt,
          crossedWireId: wire.id,
          isJunction,
        });
      }
    }
  }

  // Collapse runs of consecutive shared cells (parallel overlap) to a
  // single crossing at the middle of the run.
  return collapseConsecutive(newPath, crossings);
}

function isAtTerminal(
  pos: Vec2,
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
): boolean {
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const term of plugin.terminals) {
      const tp = terminalGridPos(comp, term, plugin);
      const tx = Math.round(tp.x);
      const ty = Math.round(tp.y);
      if (tx === pos.x && ty === pos.y) return true;
    }
  }
  return false;
}

/**
 * Collapse crossings that occupy consecutive cells along the new path into a
 * single mark at the middle of the run (two wires overlapping along a stretch
 * should render ONE hop, not one per cell).
 */
function collapseConsecutive(newPath: Vec2[], crossings: CrossingPoint[]): CrossingPoint[] {
  if (crossings.length <= 1) return crossings;
  const order = new Map<string, number>();
  expandPathToCells(newPath).forEach((c, i) => order.set(`${c.x},${c.y}`, i));
  const sorted = [...crossings].sort((a, b) =>
    (order.get(`${a.position.x},${a.position.y}`) ?? 0) -
    (order.get(`${b.position.x},${b.position.y}`) ?? 0));
  const result: CrossingPoint[] = [];
  let run: CrossingPoint[] = [];
  const flush = () => {
    if (run.length === 0) return;
    result.push(run[Math.floor(run.length / 2)]);
    run = [];
  };
  let prevIdx = -2;
  let prevWire = '';
  for (const c of sorted) {
    const idx = order.get(`${c.position.x},${c.position.y}`) ?? -1;
    const isConsecutive = idx === prevIdx + 1 && c.crossedWireId === prevWire;
    if (!isConsecutive) flush();
    run.push(c);
    prevIdx = idx;
    prevWire = c.crossedWireId;
  }
  flush();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal snapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the nearest terminal to a cursor position.
 * If a terminal is within snapRadius, return its grid position.
 * Otherwise, return the snapped grid position.
 *
 * @param cursor Cursor position (grid coordinates).
 * @param components All components.
 * @param plugins Plugin map.
 * @param snapRadius Maximum distance to snap (in grid units).
 * @param excludeTerminal Terminal to exclude (the wire's source).
 * @returns Snapped position.
 */
export function snapToNearestTerminal(
  cursor: Vec2,
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
  snapRadius: number = 0.5,
  excludeTerminal?: { componentId: string; terminalId: string },
): Vec2 {
  let nearest: Vec2 | null = null;
  let nearestDist = snapRadius;

  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const term of plugin.terminals) {
      // Skip the source terminal
      if (excludeTerminal && comp.id === excludeTerminal.componentId && term.id === excludeTerminal.terminalId) {
        continue;
      }
      const tp = terminalGridPos(comp, term, plugin);
      const dist = Math.hypot(cursor.x - tp.x, cursor.y - tp.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = { x: tp.x, y: tp.y };
      }
    }
  }

  if (nearest) return nearest;
  // Fall back to grid snapping (round to nearest integer)
  return { x: Math.round(cursor.x), y: Math.round(cursor.y) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire simplification (remove redundant waypoints)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simplify a wire path by removing collinear points.
 * If three consecutive points are in a straight line, the middle one is redundant.
 */
export function simplifyPath(path: Vec2[]): Vec2[] {
  if (path.length < 3) return path;
  const result: Vec2[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1];
    const b = path[i];
    const c = path[i + 1];
    // Check if a, b, c are collinear (same row or same column)
    const sameRow = a.y === b.y && b.y === c.y;
    const sameCol = a.x === b.x && b.x === c.x;
    if (!sameRow && !sameCol) {
      result.push(b);
    }
  }
  result.push(path[path.length - 1]);
  return result;
}

/**
 * Convert a grid path to waypoints (excluding start and end).
 */
export function pathToWaypoints(path: Vec2[]): Vec2[] {
  if (path.length < 3) return [];
  return path.slice(1, -1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire hop rendering (for crossings without junctions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a point on a wire is a crossing (hop) point.
 * Used by the renderer to draw a small arc instead of a straight line.
 */
export function isCrossingPoint(
  pos: Vec2,
  crossings: CrossingPoint[],
): boolean {
  return crossings.some(c => !c.isJunction && c.position.x === pos.x && c.position.y === pos.y);
}

/**
 * Check if a point on a wire is a junction point (connected).
 * Used by the renderer to draw a junction dot.
 */
export function isJunctionPoint(
  pos: Vec2,
  crossings: CrossingPoint[],
): boolean {
  return crossings.some(c => c.isJunction && c.position.x === pos.x && c.position.y === pos.y);
}
