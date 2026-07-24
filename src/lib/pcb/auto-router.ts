// Auto-router using Lee's algorithm (BFS flood-fill).
// Routes traces for all unrouted nets, avoiding obstacles.
//
// Lee's algorithm:
// 1. Start from source pad, flood-fill the grid in all directions
// 2. When the target pad is reached, backtrack to find the shortest path
// 3. Mark the path as an obstacle for subsequent routes
//
// Limitations (honest):
// - Grid-based (0.5mm resolution), not arbitrary-angle
// - No push-and-shove (routes around existing traces)
// - No rip-up and retry (first route may block later ones)
// - Single-layer routing per net (no auto-via placement)
// - No differential pair awareness
// But it's fast and handles simple boards well.

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
  cost: number;       // distance from source (Lee's algorithm)
  blocked: boolean;   // obstacle (pad on different net, existing trace)
  visited: boolean;
  parent: { x: number; y: number } | null;
}

const GRID_SIZE = 0.5; // mm per grid cell
const DIRECTIONS = [
  { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
  { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
  // Diagonal (optional, gives more natural routing)
  { dx: 1, dy: 1 }, { dx: -1, dy: -1 },
  { dx: 1, dy: -1 }, { dx: -1, dy: 1 },
];

/**
 * Auto-route all unrouted nets using Lee's algorithm.
 *
 * @param footprints All footprints on the board
 * @param existingTraces Already-routed traces (will be avoided)
 * @param existingVias Already-placed vias (will be avoided)
 * @param ratsnest Unrouted connections to route
 * @param board Board dimensions
 * @param layer Which layer to route on
 * @param traceWidth Default trace width in mm
 */
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
    // Skip if already routed
    const isRouted = existingTraces.some((t) => t.net === rn.net);
    if (isRouted) continue;
    if (!netsToRoute.has(rn.net)) netsToRoute.set(rn.net, []);
    netsToRoute.get(rn.net)!.push({ from: rn.from, to: rn.to });
  }

  result.stats.totalNets = netsToRoute.size;

  // Build obstacle grid
  const cols = Math.ceil(board.width / GRID_SIZE) + 1;
  const rows = Math.ceil(board.height / GRID_SIZE) + 1;
  const grid: GridCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({
      cost: -1, blocked: false, visited: false, parent: null,
    })),
  );

  // Mark pads as obstacles (unless they're on the same net we're routing)
  const padPositions: { x: number; y: number; net: string }[] = [];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      padPositions.push({ x: pad.position.x, y: pad.position.y, net: pad.net ?? '' });
    }
  }

  // Mark existing traces as obstacles
  const traceObstacles: { x1: number; y1: number; x2: number; y2: number; width: number }[] = [];
  for (const trace of existingTraces) {
    for (const seg of trace.segments) {
      traceObstacles.push({
        x1: seg.start.x, y1: seg.start.y,
        x2: seg.end.x, y2: seg.end.y,
        width: seg.width,
      });
    }
  }

  // Mark vias as obstacles
  for (const via of existingVias) {
    markObstacle(grid, via.position.x, via.position.y, via.diameter / 2 + 0.3, cols, rows);
  }

  // Route each net
  for (const [net, connections] of netsToRoute) {
    for (const conn of connections) {
      // Clear pads of this net from obstacle grid (allow routing to them)
      const netPads = padPositions.filter((p) => p.net === net);

      // Mark non-net pads as obstacles
      for (const pad of padPositions) {
        if (pad.net === net) continue;
        markObstacle(grid, pad.x, pad.y, 0.5, cols, rows);
      }

      // Mark existing traces as obstacles
      for (const obs of traceObstacles) {
        markLineObstacle(grid, obs.x1, obs.y1, obs.x2, obs.y2, obs.width / 2 + 0.2, cols, rows);
      }

      // Clear source and target cells
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
      // Clear net pads
      for (const pad of netPads) {
        const pc = Math.round(pad.x / GRID_SIZE);
        const pr = Math.round(pad.y / GRID_SIZE);
        if (pr >= 0 && pr < rows && pc >= 0 && pc < cols) {
          grid[pr][pc].blocked = false;
        }
      }

      // Run Lee's algorithm
      const path = leeAlgorithm(grid, srcCol, srcRow, dstCol, dstRow, cols, rows);

      if (path && path.length >= 2) {
        // Convert grid path to mm segments
        const segments: TraceSegment[] = [];
        let totalLen = 0;
        for (let i = 0; i < path.length - 1; i++) {
          const start = { x: path[i].x * GRID_SIZE, y: path[i].y * GRID_SIZE };
          const end = { x: path[i + 1].x * GRID_SIZE, y: path[i + 1].y * GRID_SIZE };
          segments.push({ start, end, width: traceWidth });
          totalLen += Math.hypot(end.x - start.x, end.y - start.y);
        }

        // Snap endpoints to actual pad positions
        if (segments.length > 0) {
          segments[0].start = { ...conn.from };
          segments[segments.length - 1].end = { ...conn.to };
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

        // Add this trace as an obstacle for future routes
        for (const seg of segments) {
          traceObstacles.push({
            x1: seg.start.x, y1: seg.start.y,
            x2: seg.end.x, y2: seg.end.y,
            width: seg.width,
          });
          markLineObstacle(grid, seg.start.x, seg.start.y, seg.end.x, seg.end.y, seg.width / 2 + 0.2, cols, rows);
        }
      } else {
        result.unrouted.push({ net, from: conn.from, to: conn.to });
        result.stats.failed++;
      }

      // Reset grid for next route
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          grid[r][c].cost = -1;
          grid[r][c].visited = false;
          grid[r][c].parent = null;
        }
      }
    }
  }

  return result;
}

/**
 * Lee's algorithm (BFS flood-fill) to find shortest path on grid.
 */
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
      // Backtrack to find path
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

  return null; // no path found
}

/** Mark a circular area as obstacle on the grid */
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

/** Mark a line as obstacle on the grid */
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
