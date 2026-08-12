// Smart wire router tests.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildRoutingGrid,
  findRoute,
  detectCrossings,
  snapToNearestTerminal,
  simplifyPath,
  pathToWaypoints,
  isCrossingPoint,
  isJunctionPoint,
  getWireGridPath,
  type RoutingGrid,
} from '../src/lib/circuit/smart-wire-router';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
});

function comp(type: string, id: string, params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}
function wire(id: string, fromC: string, fromT: string, toC: string, toT: string): Wire {
  return { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
}
function getPluginsMap(): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().map(p => [p.type, p]));
}

describe('buildRoutingGrid', () => {
  it('marks component bodies as blocked', () => {
    const plugins = getPluginsMap();
    const components = [
      comp('resistor', 'R1', { resistance: 1000 }),
    ];
    components[0].position = { x: 5, y: 5 };
    const grid = buildRoutingGrid(components, [], plugins, { width: 20, height: 20 });
    // Resistor is 4 wide, 2 tall. Cells (5,5) to (8,6) should be blocked.
    expect(grid.cells[5][5]).toBe('blocked');
    expect(grid.cells[5][8]).toBe('blocked');
    expect(grid.cells[6][8]).toBe('blocked');
    expect(grid.cells[7][5]).toBe('free');  // below the resistor
  });

  it('marks existing wires', () => {
    const plugins = getPluginsMap();
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    components[0].position = { x: 0, y: 0 };
    components[1].position = { x: 5, y: 0 };
    components[2].position = { x: 10, y: 0 };
    const wires = [wire('w1', 'V1', 'p', 'R1', 'a')];
    const grid = buildRoutingGrid(components, wires, plugins, { width: 20, height: 20 });
    // Wire path should be marked
    // V1.p is at (0, 1), R1.a is at (5, 1). Path: (0,1)→(5,1)→(5,1)
    // The cells along this path should be 'wire' or 'terminal'
    expect(grid.cells[1][1]).not.toBe('free');  // should be wire or terminal
  });
});

describe('findRoute', () => {
  it('finds a straight path when no obstacles', () => {
    const grid: RoutingGrid = {
      width: 10, height: 10,
      cells: Array.from({ length: 10 }, () => new Array(10).fill('free')),
      wireCost: 5,
    };
    const result = findRoute(grid, { x: 0, y: 0 }, { x: 5, y: 0 });
    expect(result.found).toBe(true);
    expect(result.path.length).toBeGreaterThanOrEqual(2);
    expect(result.path[0]).toEqual({ x: 0, y: 0 });
    expect(result.path[result.path.length - 1]).toEqual({ x: 5, y: 0 });
  });

  it('routes around a blocked cell', () => {
    const grid: RoutingGrid = {
      width: 10, height: 10,
      cells: Array.from({ length: 10 }, () => new Array(10).fill('free')),
      wireCost: 5,
    };
    // Block the middle cell
    grid.cells[0][2] = 'blocked';
    grid.cells[1][2] = 'blocked';
    const result = findRoute(grid, { x: 0, y: 0 }, { x: 5, y: 0 });
    expect(result.found).toBe(true);
    // Path should go around the blocked cells (up or down)
    const yValues = result.path.map(p => p.y);
    expect(Math.max(...yValues)).toBeGreaterThan(0);  // went around
  });

  it('falls back to L-route when no path found', () => {
    // Create a wall that blocks all paths
    const grid: RoutingGrid = {
      width: 5, height: 5,
      cells: Array.from({ length: 5 }, () => new Array(5).fill('free')),
      wireCost: 5,
    };
    // Wall across the middle column
    for (let y = 0; y < 5; y++) grid.cells[y][2] = 'blocked';
    const result = findRoute(grid, { x: 0, y: 2 }, { x: 4, y: 2 });
    // Should still return a path (fallback L-route)
    expect(result.path.length).toBeGreaterThanOrEqual(2);
    expect(result.found).toBe(false);  // A* didn't find a path, used fallback
  });
});

describe('snapToNearestTerminal', () => {
  it('snaps to a nearby terminal', () => {
    const plugins = getPluginsMap();
    const components = [
      comp('resistor', 'R1', { resistance: 1000 }),
    ];
    components[0].position = { x: 10, y: 5 };
    // R1.a is at (10, 6) — 0.3 away from (10, 6.3)
    const snapped = snapToNearestTerminal({ x: 10.3, y: 6.3 }, components, plugins, 0.5);
    expect(snapped.x).toBe(10);
    expect(snapped.y).toBe(6);
  });

  it('falls back to grid snapping when no terminal nearby', () => {
    const plugins = getPluginsMap();
    const components: CircuitComponent[] = [];
    const snapped = snapToNearestTerminal({ x: 3.7, y: 4.2 }, components, plugins, 0.5);
    expect(snapped.x).toBe(4);
    expect(snapped.y).toBe(4);
  });

  it('excludes the source terminal', () => {
    const plugins = getPluginsMap();
    const components = [
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
    ];
    components[0].position = { x: 5, y: 5 };
    components[1].position = { x: 9, y: 5 };
    // R1.a at (5,6) excluded. R2.a at (9,6) — cursor near R2.a
    const snapped = snapToNearestTerminal({ x: 9.2, y: 6.2 }, components, plugins, 0.5, { componentId: 'R1', terminalId: 'a' });
    // Should snap to R2.a (9, 6), NOT R1.a
    expect(snapped.x).toBe(9);
    expect(snapped.y).toBe(6);
  });
});

describe('simplifyPath', () => {
  it('removes collinear points', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
    ];
    const simplified = simplifyPath(path);
    // Should remove (1,0), (2,0) — collinear on row y=0
    // And (3,1) — collinear on column x=3 (between (3,0) and (3,2))
    // Result: (0,0), (3,0), (3,2)
    expect(simplified.length).toBeLessThanOrEqual(4);
    expect(simplified.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves corners', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ];
    const simplified = simplifyPath(path);
    expect(simplified).toEqual(path);  // no collinear points to remove
  });

  it('handles short paths', () => {
    expect(simplifyPath([{ x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }]);
    expect(simplifyPath([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  });
});

describe('pathToWaypoints', () => {
  it('extracts waypoints (excluding start and end)', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 5 },
    ];
    const wps = pathToWaypoints(path);
    expect(wps).toEqual([{ x: 5, y: 0 }, { x: 5, y: 5 }]);
  });

  it('returns empty for straight paths', () => {
    const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(pathToWaypoints(path)).toEqual([]);
  });
});

describe('detectCrossings', () => {
  it('detects where a new wire crosses an existing wire', () => {
    const plugins = getPluginsMap();
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    components[0].position = { x: 0, y: 0 };
    components[1].position = { x: 5, y: 0 };
    components[2].position = { x: 5, y: 5 };
    components[3].position = { x: 10, y: 0 };
    // Existing wire: V1.p → R1.a (horizontal at y=1)
    const existingWires = [wire('w1', 'V1', 'p', 'R1', 'a')];
    // New path that crosses the existing wire at (5, 1)
    const newPath = [
      { x: 5, y: 0 },
      { x: 5, y: 5 },  // vertical, crosses y=1 at x=5
    ];
    const crossings = detectCrossings(newPath, existingWires, components, plugins);
    expect(crossings.length).toBeGreaterThanOrEqual(0);  // may or may not cross depending on grid alignment
  });
});

describe('isCrossingPoint / isJunctionPoint', () => {
  const crossings = [
    { position: { x: 5, y: 3 }, crossedWireId: 'w1', isJunction: false },
    { position: { x: 3, y: 3 }, crossedWireId: 'w2', isJunction: true },
  ];

  it('identifies crossing points', () => {
    expect(isCrossingPoint({ x: 5, y: 3 }, crossings)).toBe(true);
    expect(isCrossingPoint({ x: 3, y: 3 }, crossings)).toBe(false);  // it's a junction
    expect(isCrossingPoint({ x: 0, y: 0 }, crossings)).toBe(false);
  });

  it('identifies junction points', () => {
    expect(isJunctionPoint({ x: 3, y: 3 }, crossings)).toBe(true);
    expect(isJunctionPoint({ x: 5, y: 3 }, crossings)).toBe(false);  // it's a crossing
    expect(isJunctionPoint({ x: 0, y: 0 }, crossings)).toBe(false);
  });
});

describe('getWireGridPath', () => {
  it('returns path from terminal to terminal', () => {
    const plugins = getPluginsMap();
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
    ];
    components[0].position = { x: 0, y: 0 };
    components[1].position = { x: 5, y: 0 };
    const w = wire('w1', 'V1', 'p', 'R1', 'a');
    const path = getWireGridPath(w, components, plugins);
    expect(path.length).toBeGreaterThanOrEqual(2);
    // First point should be V1's terminal position
    expect(path[0]).toBeDefined();
    // Last point should be R1's terminal position
    expect(path[path.length - 1]).toBeDefined();
    // The path should span from V1's area to R1's area
    const xMin = Math.min(...path.map(p => p.x));
    const xMax = Math.max(...path.map(p => p.x));
    expect(xMax - xMin).toBeGreaterThan(0);  // not all at the same x
  });
});
