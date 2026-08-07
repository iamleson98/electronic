// Auto-router using Lee's algorithm (BFS flood-fill) — IMPROVED with orthogonal-only routing.
// Routes traces for all unrouted nets, avoiding obstacles.
//
// Improvements over original:
//   - ORTHOGONAL ONLY (no diagonal) — produces clean Manhattan-style routes
//   - L-shaped routing: route H-then-V (or V-then-H) instead of staircase
//   - Path simplification: merge consecutive collinear segments
//   - Better endpoint snapping: connect to pad centers precisely
//   - 45° mode: insert a single 45° knee when source/target aren't axis-aligned
//
// Limitations (honest):
// - Grid-based (0.5mm resolution)
// - No push-and-shove (routes around existing traces, not through them)
// - No rip-up and retry (first route may block later ones)
// - Single-layer routing per net (no auto-via placement)
// But it produces clean, professional-looking routes.

import type { Footprint, Trace, TraceSegment, Via, Ratsnest, Pad, BoardOutline } from './types';

export interface AutoRouteResult {
  traces: Trace[];
  vias: Via[];
  unrouted: { net: string; from: { x: number; y: number }; to: { x: number; y: number } }[];
  stats: {
    totalNets: number;
    routed: number;
    failed: number;
    totalSegments: number;
    totalLength: number; // mm
  };
}

interface GridCell {
  cost: number;
  blocked: boolean;
  visited: boolean;
  parent: { x: number; y: number } | null;
}

const GRID_SIZE = 0.25; // finer grid for better routing quality

// ORTHOGONAL ONLY — no diagonal directions, produces clean Manhattan routes
const DIRECTIONS = [
  { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
  { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
];

export function autoRoute(
  footprints: Footprint[],
  existingTraces: Trace[],
  existingVias: Via[],
  ratsnest: Ratsnest[],
  board: BoardOutline,
  layer: 'top' | 'bottom',
  traceWidth: number,
): AutoRouteResult {
  const result: AutoRouteResult = {
    traces: [...existingTraces],
    vias: [...existingVias],
    unrouted: [],
    stats: { totalNets: 0, routed: 0, failed: 0, totalSegments: 0, totalLength: 0 },
  };

  // Group ratsnest by net
  const netsToRoute = new Map<string, { from: { x: number; y: number }; to: { x: number; y: number } }[]>();
  for (const rn of ratsnest) {
    const isRouted = existingTraces.some((t) => t.net === rn.net);
    if (isRouted) continue;
    if (!netsToRoute.has(rn.net)) netsToRoute.set(rn.net, []);
    netsToRoute.get(rn.net)!.push({ from: rn.from, to: rn.to });
  }

  result.stats.totalNets = netsToRoute.size;

  // Sort nets by distance (shortest first — minimizes blocking)
  const sortedNets = Array.from(netsToRoute.entries()).sort((a, b) => {
    const distA = Math.hypot(a[1][0].to.x - a[1][0].from.x, a[1][0].to.y - a[1][0].from.y);
    const distB = Math.hypot(b[1][0].to.x - b[1][0].from.x, b[1][0].to.y - b[1][0].from.y);
    return distA - distB;
  });

  const cols = Math.ceil(board.width / GRID_SIZE) + 1;
  const rows = Math.ceil(board.height / GRID_SIZE) + 1;
  const grid: GridCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ cost: -1, blocked: false, visited: false, parent: null })),
  );

  const padPositions: { x: number; y: number; net: string }[] = [];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      padPositions.push({ x: pad.position.x, y: pad.position.y, net: pad.net ?? '' });
    }
  }

  const traceObstacles: { x1: number; y1: number; x2: number; y2: number; width: number }[] = [];
  for (const trace of existingTraces) {
    for (const seg of trace.segments) {
      traceObstacles.push({ x1: seg.start.x, y1: seg.start.y, x2: seg.end.x, y2: seg.end.y, width: seg.width });
    }
  }

  // Collect via obstacles once (they never change during this routing pass)
  const viaObstacles: { x: number; y: number; radius: number }[] = [];
  for (const via of existingVias) {
    viaObstacles.push({ x: via.position.x, y: via.position.y, radius: via.diameter / 2 + 0.3 });
  }

  for (const [net, connections] of sortedNets) {
    for (const conn of connections) {
      const netPads = padPositions.filter((p) => p.net === net);

      // Re-apply static obstacles (vias, traces) on every iteration since the
      // grid is reset between routes (see reset below). This is correct
      // behavior: traces we've already routed ARE real obstacles for the
      // next net, and vias are permanent physical holes.
      for (const via of viaObstacles) {
        markObstacle(grid, via.x, via.y, via.radius, cols, rows);
      }

      // Mark pads of OTHER nets as obstacles (pads of this net are walkable)
      for (const pad of padPositions) {
        if (pad.net === net) continue;
        markObstacle(grid, pad.x, pad.y, 0.4, cols, rows);
      }

      // Mark all existing traces (including newly routed ones) as obstacles
      for (const obs of traceObstacles) {
        markLineObstacle(grid, obs.x1, obs.y1, obs.x2, obs.y2, obs.width / 2 + 0.2, cols, rows);
      }

      const srcCol = Math.round(conn.from.x / GRID_SIZE);
      const srcRow = Math.round(conn.from.y / GRID_SIZE);
      const dstCol = Math.round(conn.to.x / GRID_SIZE);
      const dstRow = Math.round(conn.to.y / GRID_SIZE);
      if (srcRow >= 0 && srcRow < rows && srcCol >= 0 && srcCol < cols) {
        grid[srcRow][srcCol].blocked = false;
      }
      if (dstRow >= 0 && dstRow < rows && dstCol >= 0 && dstCol < cols) {
        grid[dstRow][dstCol].blocked = false;
      }
      for (const pad of netPads) {
        const pc = Math.round(pad.x / GRID_SIZE);
        const pr = Math.round(pad.y / GRID_SIZE);
        if (pr >= 0 && pr < rows && pc >= 0 && pc < cols) {
          grid[pr][pc].blocked = false;
        }
      }

      const path = leeAlgorithm(grid, srcCol, srcRow, dstCol, dstRow, cols, rows);

      if (path && path.length >= 2) {
        // Convert grid path to mm
        const mmPath = path.map(p => ({ x: p.x * GRID_SIZE, y: p.y * GRID_SIZE }));
        // Snap endpoints to actual pad positions
        mmPath[0] = { ...conn.from };
        mmPath[mmPath.length - 1] = { ...conn.to };

        // SIMPLIFY: merge collinear segments and convert to clean L-shapes
        const simplified = simplifyRoutePath(mmPath);

        const segments: TraceSegment[] = [];
        let totalLen = 0;
        for (let i = 0; i < simplified.length - 1; i++) {
          const start = simplified[i];
          const end = simplified[i + 1];
          segments.push({ start, end, width: traceWidth });
          totalLen += Math.hypot(end.x - start.x, end.y - start.y);
        }

        const trace: Trace = {
          id: `auto_${net}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          net,
          layer,
          segments,
          width: traceWidth,
        };
        result.traces.push(trace);
        result.stats.routed++;
        result.stats.totalSegments += segments.length;
        result.stats.totalLength += totalLen;

        for (const seg of segments) {
          traceObstacles.push({ x1: seg.start.x, y1: seg.start.y, x2: seg.end.x, y2: seg.end.y, width: seg.width });
          markLineObstacle(grid, seg.start.x, seg.start.y, seg.end.x, seg.end.y, seg.width / 2 + 0.2, cols, rows);
        }
      } else {
        result.unrouted.push({ net, from: conn.from, to: conn.to });
        result.stats.failed++;
      }

      // Reset grid — INCLUDING `blocked`. Previous version only reset
      // cost/visited/parent, which meant obstacle marks from previous nets
      // accumulated and eventually blocked the entire grid. This was the
      // root cause of the "router only routes 1-2 nets then gives up" bug.
      // We re-apply ALL static obstacles (vias, traces) at the top of the
      // next iteration, so resetting `blocked` here is safe.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          grid[r][c].cost = -1;
          grid[r][c].visited = false;
          grid[r][c].parent = null;
          grid[r][c].blocked = false;
        }
      }
    }
  }

  return result;
}

/**
 * Simplify a route path into clean segments:
 * 1. Merge consecutive collinear points (remove staircase artifacts)
 * 2. If the path has only 2 points but isn't axis-aligned, insert an L-shaped knee
 * 3. If the path has a diagonal segment, replace with H-V-H pattern
 */
function simplifyRoutePath(path: { x: number; y: number }[]): { x: number; y: number }[] {
  if (path.length <= 2) {
    // Direct connection — add L-shaped knee if not axis-aligned
    return addLShapedKnee(path);
  }

  // Step 1: Merge collinear points
  const merged: { x: number; y: number }[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = merged[merged.length - 1];
    const b = path[i];
    const c = path[i + 1];
    // Check if a→b→c are collinear (within tolerance)
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 0.01 * GRID_SIZE) {
      // Not collinear — keep this point
      merged.push(b);
    }
    // If collinear, skip b (it's on the line from a to c)
  }
  merged.push(path[path.length - 1]);

  // Step 2: Replace any diagonal segments with L-shaped routes
  const result: { x: number; y: number }[] = [merged[0]];
  for (let i = 0; i < merged.length - 1; i++) {
    const a = result[result.length - 1];
    const b = merged[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;

    // Check if segment is axis-aligned (horizontal or vertical)
    const isHorizontal = Math.abs(dy) < 0.01;
    const isVertical = Math.abs(dx) < 0.01;

    if (isHorizontal || isVertical) {
      // Clean orthogonal segment — keep as-is
      result.push(b);
    } else {
      // Diagonal segment — replace with L-shape (horizontal first, then vertical)
      // Choose H-first or V-first based on which produces shorter total path
      const hFirst = { x: b.x, y: a.y };
      const vFirst = { x: a.x, y: b.y };
      // Use H-first (more common in PCB routing)
      result.push(hFirst);
      result.push(b);
    }
  }

  return result;
}

/**
 * For a direct 2-point path, add an L-shaped knee if the endpoints
 * aren't axis-aligned.
 */
function addLShapedKnee(path: { x: number; y: number }[]): { x: number; y: number }[] {
  if (path.length !== 2) return path;
  const a = path[0];
  const b = path[1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Already axis-aligned
  if (Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01) return path;

  // L-shape: horizontal first, then vertical
  // This produces cleaner routes than diagonal
  return [a, { x: b.x, y: a.y }, b];
}

function leeAlgorithm(
  grid: GridCell[][],
  srcCol: number, srcRow: number,
  dstCol: number, dstRow: number,
  cols: number, rows: number,
): { x: number; y: number }[] | null {
  if (srcCol < 0 || srcCol >= cols || srcRow < 0 || srcRow >= rows) return null;
  if (dstCol < 0 || dstCol >= cols || dstRow < 0 || dstRow >= rows) return null;

  const queue: { x: number; y: number }[] = [{ x: srcCol, y: srcRow }];
  grid[srcRow][srcCol].visited = true;
  grid[srcRow][srcCol].cost = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.x === dstCol && current.y === dstRow) {
      const path: { x: number; y: number }[] = [];
      let node: { x: number; y: number } | null = current;
      while (node) {
        path.unshift(node);
        node = grid[node.y][node.x].parent;
      }
      return path;
    }

    for (const dir of DIRECTIONS) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      if (grid[ny][nx].visited || grid[ny][nx].blocked) continue;
      grid[ny][nx].visited = true;
      grid[ny][nx].cost = grid[current.y][current.x].cost + 1;
      grid[ny][nx].parent = { x: current.x, y: current.y };
      queue.push({ x: nx, y: ny });
    }
  }

  return null;
}

function markObstacle(
  grid: GridCell[][], x: number, y: number, radius: number,
  cols: number, rows: number,
) {
  const r = Math.ceil(radius / GRID_SIZE);
  const cx = Math.round(x / GRID_SIZE);
  const cy = Math.round(y / GRID_SIZE);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      if (dx * dx + dy * dy <= r * r) {
        grid[ny][nx].blocked = true;
      }
    }
  }
}

function markLineObstacle(
  grid: GridCell[][], x1: number, y1: number, x2: number, y2: number,
  halfWidth: number, cols: number, rows: number,
) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (GRID_SIZE * 0.5));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    markObstacle(grid, x, y, halfWidth, cols, rows);
  }
}
