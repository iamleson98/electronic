// Wiring UX — regression tests.
//
// Covers the behaviors pinned by user feedback:
//   1. Straight wires ("the old way"): no A* detours — a wire without user
//      bends commits with NO waypoints and renders as the direct line /
//      horizontal-first L-elbow. User-placed bends are still honored.
//   2. 1:1 overlap prevention: a new wire may CROSS or TOUCH an existing
//      wire but never run on top of one — rejected at commit, red live
//      preview while drafting.
//   3. Current flow travels ALONG the rendered wire line (computeFlowDotPositions).
//   4. Snapping (nearest-match, zoom-independent radius) + crossing hop arcs
//      + malformed-endpoint robustness.

import { describe, it, expect, beforeAll } from 'vitest';
import { useEditor } from '../src/lib/circuit/store';
import { getPlugin, getAllPlugins, registerPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, ComponentPlugin, Wire, Vec2 } from '../src/lib/circuit/types';
import { findNearestTerminal } from '../src/components/circuit/terminal-snap';
import {
  expandPathToCells,
  buildRoutingGrid,
  buildRoutingGridForDocument,
  documentGridSize,
  findRoute,
  WIRE_CROSS_COST,
  type RoutingGrid,
} from '../src/lib/circuit/smart-wire-router';
import { computeWireCrossingMarks } from '../src/lib/circuit/wire-crossings';
import { computeDraftPreview } from '../src/components/circuit/wire-draft-preview';
import { orthogonalizePath, computeFlowDotPositions } from '../src/lib/circuit/wire-geometry';
import { findWireOverlap, wireGridPath } from '../src/lib/circuit/wire-overlap';
import {
  renderScene,
  createInitialView,
  formatStatusText,
  type RenderScene,
} from '../src/components/circuit/canvas-renderer';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
});

function plugins(): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().map((p) => [p.type, p]));
}

function state() { return useEditor.getState(); }
function reset() { state().clear(); state().reset(); }

/** Helper: all consecutive point pairs share an axis (orthogonal path). */
function assertOrthogonal(path: Vec2[]) {
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const sharesAxis = Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9;
    expect(sharesAxis, `segment ${i} (${a.x},${a.y})→(${b.x},${b.y}) is diagonal`).toBe(true);
  }
}

/** Helper: no three consecutive collinear points (corner-sparse path). */
function assertCornerSparse(path: Vec2[]) {
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1];
    const b = path[i];
    const c = path[i + 1];
    const sameRow = a.y === b.y && b.y === c.y;
    const sameCol = a.x === b.x && b.x === c.x;
    expect(!sameRow && !sameCol, `points ${i - 1}..${i + 1} are collinear (redundant waypoint)`).toBe(true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Terminal snap: nearest-match + zoom-independent screen-space radius
// ─────────────────────────────────────────────────────────────────────────────

describe('terminal snap (findNearestTerminal)', () => {
  const mkResistor = (id: string, x: number, y: number): CircuitComponent =>
    ({ id, type: 'resistor', position: { x, y }, rotation: 0, parameters: { resistance: 1000 } } as unknown as CircuitComponent);

  it('returns the NEAREST terminal, not the first in component order', () => {
    // R1 comes first in the array with a pin 1.0 units away; R2's pin is
    // 0.2 units away. The old first-match code returned R1's pin.
    const comps = [mkResistor('r1', 0, 0), mkResistor('r2', 4, 0)];
    // R1 pins: (0,1),(4,1); R2 pins: (4,1),(8,1).
    // Query (3.85, 1.05): nearest is R1.b/R2.a at (4,1) — distance 0.18.
    const hit = findNearestTerminal(3.85, 1.05, comps, []);
    expect(hit).not.toBeNull();
    expect(hit!.pos.x).toBe(4);
    expect(hit!.pos.y).toBe(1);
  });

  it('snaps at the same SCREEN distance regardless of zoom', () => {
    const comps = [mkResistor('r1', 0, 0)];
    // Pins (0,1) and (4,1). Query (2,1) is 2 grid units from both.
    // Default radius is 27px: at zoom 1 that is 1.5 units (no snap); at zoom
    // 0.25 it is 6 units (snap). A grid-unit radius would behave the
    // opposite way (huge magnet when zoomed in, tiny when zoomed out).
    expect(findNearestTerminal(2, 1, comps, [], { zoom: 1 })).toBeNull();
    expect(findNearestTerminal(2, 1, comps, [], { zoom: 0.25 })).not.toBeNull();
    // Zoomed IN (4×): 27px = 0.375 units — 0.5 units (36px) is out of range
    // (precision targeting), 0.2 units is in range.
    expect(findNearestTerminal(4.5, 1, comps, [], { zoom: 4 })).toBeNull();
    expect(findNearestTerminal(4.2, 1, comps, [], { zoom: 4 })?.pos).toEqual({ x: 4, y: 1 });
  });

  it('honors exclude (the wire draft source pin is not a snap target)', () => {
    const comps = [mkResistor('r1', 0, 0)];
    const hit = findNearestTerminal(0, 1, comps, [], {
      zoom: 1,
      exclude: { componentId: 'r1', terminalId: 'a' },
    });
    // r1.a is at the query point but excluded; r1.b is 4 units away (no snap).
    expect(hit).toBeNull();
  });

  it('returns null when the snap radius is zero (bypassed)', () => {
    const comps = [mkResistor('r1', 0, 0)];
    expect(findNearestTerminal(4, 1, comps, [], { snapRadiusPx: 0 })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Router: rasterized wire cells, clearance, dynamic grid
// ─────────────────────────────────────────────────────────────────────────────

describe('expandPathToCells', () => {
  it('rasterizes every cell along orthogonal segments (not just corners)', () => {
    const cells = expandPathToCells([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }]);
    const keys = new Set(cells.map((c) => `${c.x},${c.y}`));
    expect(keys.has('2,0')).toBe(true);   // mid horizontal run
    expect(keys.has('5,2')).toBe(true);   // mid vertical run
    expect(keys.size).toBe(9);            // 6 horizontal + 3 vertical (corner shared)
  });
});

describe('buildRoutingGrid rasterization + clearance', () => {
  const mkResistor = (id: string, x: number, y: number): CircuitComponent =>
    ({ id, type: 'resistor', position: { x, y }, rotation: 0, parameters: { resistance: 1000 } } as unknown as CircuitComponent);

  it('marks the FULL path cells of a sparse-waypoint wire', () => {
    // Wire from r1.a (0,1) to r2.b (10,1) with a single corner waypoint (5,1)
    // — the rendered wire covers x=0..10 at y=1; all those cells must be
    // 'wire' so future routes treat the run as occupied.
    const comps = [mkResistor('r1', 0, 0), mkResistor('r2', 6, 0)];
    const wire: Wire = {
      id: 'w1',
      from: { componentId: 'r1', terminalId: 'a' },
      to: { componentId: 'r2', terminalId: 'b' },
      waypoints: [{ x: 5, y: 1 }],
    };
    const grid = buildRoutingGrid(comps, [wire], plugins(), { width: 20, height: 10 }, 5);
    expect(grid.cells[1][2]).toBe('wire');
    expect(grid.cells[1][5]).toBe('wire');
    expect(grid.cells[1][8]).toBe('wire');
  });

  it('clearance map costs the halo around wires, not terminals or the wire itself', () => {
    const comps = [mkResistor('r1', 0, 0), mkResistor('r2', 6, 0)];
    const wire: Wire = {
      id: 'w1',
      from: { componentId: 'r1', terminalId: 'a' },
      to: { componentId: 'r2', terminalId: 'b' },
    };
    const grid = buildRoutingGridForDocument(comps, [wire], plugins());
    expect(grid.clearance).toBeDefined();
    // (5,1) is on the wire (no clearance — handled by wireCost); (5,2) is in
    // the halo; (5,5) is far away.
    expect(grid.clearance![1][5] ?? 0).toBe(0);
    expect(grid.clearance![2][5]).toBeGreaterThan(0);
    expect(grid.clearance![5][5] ?? 0).toBe(0);
  });

  it('documentGridSize grows past the old hard-coded 100×60 for far components', () => {
    const comps = [mkResistor('far', 150, 80)];
    const size = documentGridSize(comps, [], plugins());
    expect(size.width).toBeGreaterThanOrEqual(170);
    expect(size.height).toBeGreaterThanOrEqual(100);
    // Small documents keep the old minimum.
    const small = documentGridSize([mkResistor('near', 5, 5)], [], plugins());
    expect(small.width).toBe(100);
    expect(small.height).toBe(60);
  });

  it('A* avoids crossing a short wire wall when overlap is expensive (the old cost-5 router plowed through)', () => {
    // Hand-built grid (same style as the existing integration tests):
    // a 3-cell vertical wire wall at x=5, y=2..4, with the document-grade
    // costs (wireCost 12 + halo). Route (2,3) → (8,3).
    const width = 12, height = 8;
    const cells: RoutingGrid['cells'] = Array.from({ length: height }, () => new Array(width).fill('free' as const));
    const clearance = Array.from({ length: height }, () => new Array(width).fill(0));
    for (const y of [2, 3, 4]) {
      cells[y][5] = 'wire';
      const halo: [number, number][] = [[y, 4], [y, 6], [y - 1, 5], [y + 1, 5]];
      for (const [hy, hx] of halo) {
        if (hy >= 0 && hy < height && cells[hy][hx] === 'free') clearance[hy][hx] = 2.5;
      }
    }
    const grid: RoutingGrid = { width, height, cells, wireCost: WIRE_CROSS_COST, clearance };

    const result = findRoute(grid, { x: 2, y: 3 }, { x: 8, y: 3 });
    expect(result.found).toBe(true);
    const crossesWall = result.path.some((p) => p.x === 5 && p.y >= 2 && p.y <= 4);
    expect(crossesWall, 'route overlaps the existing wire when a free detour exists').toBe(false);

    // With the OLD cost semantics (5, no clearance), the same layout prefers
    // the straight overlap — documenting why the presets changed.
    const oldGrid: RoutingGrid = { width, height, cells: cells.map((r) => [...r]), wireCost: 5 };
    const oldResult = findRoute(oldGrid, { x: 2, y: 3 }, { x: 8, y: 3 });
    const oldCrosses = oldResult.path.some((p) => p.x === 5 && p.y >= 2 && p.y <= 4);
    expect(oldCrosses).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Crossing marks (hop arcs)
// ─────────────────────────────────────────────────────────────────────────────

describe('computeWireCrossingMarks', () => {
  const comps = [
    { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
    { id: 'c2', type: 'resistor', position: { x: 6, y: 0 }, rotation: 0, parameters: {} },
    { id: 'c3', type: 'resistor', position: { x: 2, y: -2 }, rotation: 0, parameters: {} },
    { id: 'c4', type: 'resistor', position: { x: 2, y: 2 }, rotation: 0, parameters: {} },
  ] as unknown as CircuitComponent[];

  // A: horizontal run y=1, x=0..6 (c1.a → c2.a, corner waypoint at (6,1)).
  const wireA: Wire = {
    id: 'wa', from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' },
    waypoints: [{ x: 6, y: 1 }],
  };
  // B: vertical run x=2, y=-1..3 (c3.a (2,-1) → c4.a (2,3)) crossing A at (2,1).
  const wireB: Wire = {
    id: 'wb', from: { componentId: 'c3', terminalId: 'a' }, to: { componentId: 'c4', terminalId: 'a' },
  };

  it('assigns the hop to the LATER wire (the one drawn on top)', () => {
    const marks = computeWireCrossingMarks([wireA, wireB], comps, plugins());
    const bMarks = marks.get('wb') ?? [];
    expect(bMarks.length).toBe(1);
    expect(bMarks[0].x).toBe(2);
    expect(bMarks[0].y).toBe(1);
    expect(marks.get('wa')).toBeUndefined();
    // Reversing the order moves the hop to the other wire.
    const marks2 = computeWireCrossingMarks([wireB, wireA], comps, plugins());
    expect((marks2.get('wa') ?? []).length).toBe(1);
  });

  it('skips cells at wire endpoints (pin dots live there)', () => {
    // A wire ending ON another wire's run: the shared cells at the endpoint
    // must not produce hop marks.
    const wireC: Wire = {
      id: 'wc', from: { componentId: 'c3', terminalId: 'b' }, to: { componentId: 'c1', terminalId: 'b' },
    };
    // c3.b = (6,-1), c1.b = (4,1): elbow route (6,-1)→(6,1)→(4,1)...
    // endpoint (4,1) lies on A's run x=0..6? A's rasterized cells include (4,1),
    // and (4,1) is wireC's endpoint → skipped.
    const marks = computeWireCrossingMarks([wireA, wireC], comps, plugins());
    const cMarks = marks.get('wc') ?? [];
    const atEndpoint = cMarks.some((m) => m.x === 4 && m.y === 1);
    expect(atEndpoint).toBe(false);
  });

  it('collapses a run of overlapping cells into a single hop', () => {
    // Two wires sharing the same terminal pair (full colinear overlap along
    // the x=2 column, y=0..2 between the skipped endpoint cells) — the run
    // must render as ONE hop, not one per cell.
    const wireD: Wire = {
      id: 'wd', from: { componentId: 'c3', terminalId: 'a' }, to: { componentId: 'c4', terminalId: 'a' },
      waypoints: [{ x: 2, y: 1 }],
    };
    const marks = computeWireCrossingMarks([wireA, wireD], comps, plugins());
    const dMarks = marks.get('wd') ?? [];
    expect(dMarks.length).toBe(1);
    expect(dMarks[0].x).toBe(2);
    expect(dMarks[0].y).toBe(1);
  });

  it('ignores wires with malformed endpoints instead of crashing (live bug: scripting-API misuse crashed the RAF loop)', () => {
    const malformed = { id: 'bad', from: 'comp1', to: 'b' } as unknown as Wire;
    expect(() => computeWireCrossingMarks([wireA, malformed], comps, plugins())).not.toThrow();
    const marks = computeWireCrossingMarks([wireA, malformed], comps, plugins());
    expect(marks.get('bad')).toBeUndefined();
    // The valid wire still gets its marks computed.
    const withValid = computeWireCrossingMarks([malformed, wireA, wireB], comps, plugins());
    expect(withValid.get('wb')?.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Draft preview (honest WYSIWYG)
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDraftPreview', () => {
  it('falls back to the orthogonal elbow matching the commit fallback route', () => {
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
    ] as unknown as CircuitComponent[];
    const draft = {
      from: { componentId: 'c1', terminalId: 'a' },  // (0,1)
      cursor: { x: 10, y: 5 },
      waypoints: [],
    };
    const result = computeDraftPreview(draft, comps, [], [], null)!;
    expect(result).not.toBeNull();
    assertOrthogonal(result.path);
    expect(result.path[0]).toEqual({ x: 0, y: 1 });
    expect(result.path[result.path.length - 1]).toEqual({ x: 10, y: 5 });
  });

  it('previews the DIRECT L-route even across a component body (no A* detours)', () => {
    // The A* detours produced jigsaw paths users hated ("wires not straight
    // or horizontal, looks very ugly"). The preview must show exactly the
    // two-segment L-route the commit renders — component bodies on the
    // straight line do NOT reroute it.
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
      { id: 'big', type: 'resistor', position: { x: 2, y: 0 }, rotation: 0, parameters: {} },
    ] as unknown as CircuitComponent[];
    const draft = {
      from: { componentId: 'c1', terminalId: 'a' },
      cursor: { x: 10, y: 1 },
      waypoints: [],
    };
    const result = computeDraftPreview(draft, comps, [], [], null)!;
    // Aligned endpoints → direct horizontal line, no bends at all.
    expect(result.path).toEqual([{ x: 0, y: 1 }, { x: 10, y: 1 }]);
  });

  it('falls back to a straight detour when the direct line would overlap (no stacking)', () => {
    // Existing wire c1.a(0,1)→c2.a(10,1): horizontal run y=1, x 0..10.
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
      { id: 'c2', type: 'resistor', position: { x: 10, y: 0 }, rotation: 0, parameters: {} },
      { id: 'c3', type: 'resistor', position: { x: 0, y: 6 }, rotation: 0, parameters: {} },
    ] as unknown as CircuitComponent[];
    const wires: Wire[] = [{
      id: 'w1', from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' },
    }];
    // Draft from c1.b (4,1) to (8,1): the direct y=1 run lies on w1 —
    // the planner detours 2 rows down instead of stacking wire on wire.
    const detoured = computeDraftPreview(
      { from: { componentId: 'c1', terminalId: 'b' }, cursor: { x: 8, y: 1 }, waypoints: [] },
      comps, wires, [], null,
    )!;
    expect(detoured.overlap).toBe(false);
    expect(detoured.path).toEqual([
      { x: 4, y: 1 },
      { x: 4, y: 3 },
      { x: 8, y: 3 },
      { x: 8, y: 1 },
    ]);

    // Draft from c3.a (0,7) to (10,7): parallel run on a different row — direct.
    const parallel = computeDraftPreview(
      { from: { componentId: 'c3', terminalId: 'a' }, cursor: { x: 10, y: 7 }, waypoints: [] },
      comps, wires, [], null,
    )!;
    expect(parallel.overlap).toBe(false);
    expect(parallel.path).toEqual([{ x: 0, y: 7 }, { x: 10, y: 7 }]);

    // Draft from c3.a (0,7) to (3,1): vertical x=3 CROSSES w1 at (3,1) —
    // crossings are allowed (hop arc), not 1:1 overlaps.
    const crossing = computeDraftPreview(
      { from: { componentId: 'c3', terminalId: 'a' }, cursor: { x: 3, y: 1 }, waypoints: [] },
      comps, wires, [], null,
    )!;
    expect(crossing.overlap).toBe(false);
  });

  it('previews RED when every straight route is blocked (commit will reject)', () => {
    // Five horizontal wires on rows y=1 (direct), y=3/−1 (±2), y=5/−3 (±4)
    // all covering x 0..10 — every candidate for the horizontal draft
    // (4,1)→(8,1) is blocked.
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
      { id: 'c2', type: 'resistor', position: { x: 10, y: 0 }, rotation: 0, parameters: {} },
    ] as unknown as CircuitComponent[];
    const rows = [1, 3, -1, 5, -3];
    const wires: Wire[] = rows.map((y, i) => ({
      id: `b${i}`,
      from: { componentId: 'c1', terminalId: 'a' },
      to: { componentId: 'c2', terminalId: 'a' },
      waypoints: y === 1 ? undefined : [{ x: 0, y }, { x: 10, y }],
    }));
    const result = computeDraftPreview(
      { from: { componentId: 'c1', terminalId: 'b' }, cursor: { x: 8, y: 1 }, waypoints: [] },
      comps, wires, [], null,
    )!;
    expect(result.overlap).toBe(true);
    // The red preview shows the default L-route that fails.
    expect(result.path).toEqual([{ x: 4, y: 1 }, { x: 8, y: 1 }]);
  });

  it('honors user-placed bends and only previews the final leg', () => {
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
    ] as unknown as CircuitComponent[];
    const draft = {
      from: { componentId: 'c1', terminalId: 'a' },  // (0,1)
      cursor: { x: 20, y: 5 },
      waypoints: [{ x: 5, y: 1 }, { x: 5, y: 5 }],
    };
    const result = computeDraftPreview(draft, comps, [], [], null)!;
    expect(result.path.slice(0, 3)).toEqual([{ x: 0, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }]);
    expect(result.committedWaypoints).toBe(2);
    assertOrthogonal(result.path);
  });

  it('ends exactly at the snap target terminal (WYSIWYG connect)', () => {
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
      { id: 'c2', type: 'resistor', position: { x: 10, y: 4 }, rotation: 0, parameters: {} },
    ] as unknown as CircuitComponent[];
    const draft = {
      from: { componentId: 'c1', terminalId: 'a' },
      cursor: { x: 10.4, y: 5.2 },   // near c2.a (10,5) but not exact
      waypoints: [],
    };
    const snap = { componentId: 'c2', terminalId: 'a', pos: { x: 10, y: 5 } };
    const result = computeDraftPreview(draft, comps, [], [], snap)!;
    expect(result.path[result.path.length - 1]).toEqual({ x: 10, y: 5 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Store: click-by-click draft + sparse/committed waypoints
// ─────────────────────────────────────────────────────────────────────────────

describe('store: wire draft click-by-click', () => {
  it('startWire initializes an empty waypoint list; add/pop maintain it', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    expect(state().wireDraft!.waypoints).toEqual([]);
    state().addWireWaypoint({ x: 8.4, y: 9.6 });
    expect(state().wireDraft!.waypoints).toEqual([{ x: 8, y: 10 }]);  // rounded to grid
    state().addWireWaypoint({ x: 8, y: 10 });                          // duplicate ignored
    expect(state().wireDraft!.waypoints.length).toBe(1);
    state().addWireWaypoint({ x: 16, y: 10 });
    state().popWireWaypoint();
    expect(state().wireDraft!.waypoints).toEqual([{ x: 8, y: 10 }]);
    state().cancelWire();
    expect(state().wireDraft).toBeNull();
  });

  it('completeWire honors user-placed bends (their route, corner-sparse)', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r1 = state().addComponent('resistor', { x: 20, y: 10 });     // a=(20,11)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().addWireWaypoint({ x: 12, y: 6 });
    state().addWireWaypoint({ x: 12, y: 12 });
    state().completeWire({ componentId: r1, terminalId: 'a' });

    expect(state().wires.length).toBe(1);
    const wire = state().wires[0];
    expect(wire.waypoints).toBeDefined();
    const fullPath: Vec2[] = [
      { x: 5, y: 6 },
      ...(wire.waypoints ?? []),
      { x: 20, y: 11 },
    ];
    // User bends survive (they are real corners).
    expect(wire.waypoints!.some((w) => w.x === 12 && w.y === 6)).toBe(true);
    expect(wire.waypoints!.some((w) => w.x === 12 && w.y === 12)).toBe(true);
    assertOrthogonal(fullPath);
    assertCornerSparse(fullPath);
  });

  it('completeWire without user bends stores NO waypoints — straight/L route (the old way)', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r1 = state().addComponent('resistor', { x: 30, y: 10 });    // a=(30,11)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r1, terminalId: 'a' });

    const wire = state().wires[0];
    expect(wire).toBeDefined();
    // No A* waypoints: the renderer draws the horizontal-first L-route
    // (5,6)→(30,6)→(30,11) — the classic straight/horizontal look.
    expect(wire.waypoints).toBeUndefined();
  });

  it('wires connect far components exactly (no grid clamping — no router involved)', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 150, y: 80 });   // p=(151,80)
    const r1 = state().addComponent('resistor', { x: 170, y: 90 });   // a=(170,91)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 151, y: 80 });
    state().completeWire({ componentId: r1, terminalId: 'a' });
    const wire = state().wires[0];
    expect(wire).toBeDefined();
    expect(wire.waypoints).toBeUndefined();
    expect(wire.from).toEqual({ componentId: v1, terminalId: 'p' });
    expect(wire.to).toEqual({ componentId: r1, terminalId: 'a' });
  });

  it('undo/redo still bracket wire creation', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });
    const r1 = state().addComponent('resistor', { x: 12, y: 6 });
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r1, terminalId: 'a' });
    expect(state().wires.length).toBe(1);
    state().undo();
    expect(state().wires.length).toBe(0);
    state().redo();
    expect(state().wires.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5b. Store: 1:1 overlap prevention (wires may cross or touch, never stack)
// ─────────────────────────────────────────────────────────────────────────────

describe('store: wire 1:1 overlap prevention', () => {
  it('rejects an exact duplicate wire (same terminal pair) without touching history', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r1 = state().addComponent('resistor', { x: 20, y: 6 });      // a=(20,7)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r1, terminalId: 'a' });
    expect(state().wires.length).toBe(1);
    const pastLen = state().past.length;

    // Same wire again — lies exactly on top of the first.
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r1, terminalId: 'a' });

    expect(state().wires.length).toBe(1);                        // not added
    expect(state().wireDraft).toBeNull();                        // draft closed
    expect(state().announcement).toContain('rejected');           // a11y feedback
    expect(state().past.length).toBe(pastLen);                   // history clean
  });

  it('auto-detours around an overlap: never stacks wire on wire (partial collinear)', () => {
    reset();
    // Wire 1: v1.p (5,6) → r2.b (14,6): horizontal run y=6, x 5..14.
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r2 = state().addComponent('resistor', { x: 10, y: 5 });      // a=(10,6), b=(14,6)
    const r3 = state().addComponent('resistor', { x: 26, y: 5 });      // a=(26,6)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r2, terminalId: 'b' });
    expect(state().wires.length).toBe(1);

    // New wire r2.a (10,6) → r3.a (26,6): the direct y=6 run would overlap
    // wire 1's x 5..14 over 4 units — the planner detours 2 rows down.
    state().startWire({ componentId: r2, terminalId: 'a' }, { x: 10, y: 6 });
    state().completeWire({ componentId: r3, terminalId: 'a' });
    expect(state().wires.length).toBe(2);                        // committed...
    const w2 = state().wires[1];
    expect(w2.waypoints).toEqual([{ x: 10, y: 8 }, { x: 26, y: 8 }]); // ...via the detour
  });

  it('auto-picks the alternate elbow when the default L would overlap (LED-chain case)', () => {
    reset();
    // Feed wire on y=3 between rLeft.b (6,3) and rRight.a (12,3).
    const rLeft = state().addComponent('resistor', { x: 2, y: 2 });    // b=(6,3)
    const rRight = state().addComponent('resistor', { x: 12, y: 2 });   // a=(12,3), b=(16,3)
    state().startWire({ componentId: rLeft, terminalId: 'b' }, { x: 6, y: 3 });
    state().completeWire({ componentId: rRight, terminalId: 'a' });

    // Return wire from rRight.b (16,3) down to ground g (9,12): the default
    // horizontal-first L would run BACK along y=3 (x 9..16) on top of the
    // feed wire's run (x 6..12, 3 units of overlap); the vertical-first L
    // clears it.
    const gnd = state().addComponent('ground', { x: 8, y: 12 });        // g=(9,12)
    state().startWire({ componentId: rRight, terminalId: 'b' }, { x: 16, y: 3 });
    state().completeWire({ componentId: gnd, terminalId: 'g' });
    expect(state().wires.length).toBe(2);
    expect(state().wires[1].waypoints).toEqual([{ x: 16, y: 12 }]);   // vertical-first L
  });

  it('rejects when EVERY straight route overlaps (user must bend manually)', () => {
    reset();
    const r2 = state().addComponent('resistor', { x: 10, y: 5 });      // a=(10,6)
    const r3 = state().addComponent('resistor', { x: 26, y: 5 });      // a=(26,6)
    // Blockers on rows y=6 (direct), 8/4 (±2), 10/2 (±4), each covering
    // x 5..26. Injected directly (no commit path) — geometry fixtures.
    const block = (y: number, i: number): Wire => ({
      id: `blk${i}`,
      from: { componentId: r2, terminalId: 'b' },
      to: { componentId: r3, terminalId: 'b' },
      waypoints: y === 6 ? undefined : [{ x: 5, y }, { x: 26, y }],
    });
    useEditor.setState({
      wires: [block(6, 0), block(8, 1), block(4, 2), block(10, 3), block(2, 4)],
      past: [],
      future: [],
    });
    state().startWire({ componentId: r2, terminalId: 'a' }, { x: 10, y: 6 });
    state().completeWire({ componentId: r3, terminalId: 'a' });
    expect(state().wires.length).toBe(5);                        // nothing added
    expect(state().announcement).toContain('overlap');
    expect(state().past.length).toBe(0);                          // history untouched
  });

  it('ALLOWS endpoint-touching series wires (junction, not overlap)', () => {
    reset();
    // Wire 1: v1.p (5,6) → r2.a (10,6). Wire 2: r2.b (14,6) → r3.a (26,6).
    // Both run on y=6 but share only... nothing — 10..14 has the resistor
    // body between the pins; the runs are disjoint. This is the normal
    // series-chain pattern and must stay legal.
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r2 = state().addComponent('resistor', { x: 10, y: 5 });      // a=(10,6), b=(14,6)
    const r3 = state().addComponent('resistor', { x: 22, y: 5 });      // a=(22,6)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r2, terminalId: 'a' });
    state().startWire({ componentId: r2, terminalId: 'b' }, { x: 14, y: 6 });
    state().completeWire({ componentId: r3, terminalId: 'a' });
    expect(state().wires.length).toBe(2);
  });

  it('ALLOWS perpendicular crossings (hop arc, not 1:1 overlap)', () => {
    reset();
    // Wire 1: horizontal y=6, x 5..14 (v1.p → r2.b).
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r2 = state().addComponent('resistor', { x: 10, y: 5 });      // b=(14,6)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r2, terminalId: 'b' });

    // Wire 2: vertical x=12 y 3..9 (top.b → bot.b) crossing wire 1 at (12,6).
    const top = state().addComponent('resistor', { x: 10, y: 2 });     // b=(14,3)
    const bot = state().addComponent('resistor', { x: 10, y: 8 });     // b=(14,9)
    state().startWire({ componentId: top, terminalId: 'b' }, { x: 14, y: 3 });
    state().addWireWaypoint({ x: 12, y: 3 });
    state().addWireWaypoint({ x: 12, y: 9 });
    state().completeWire({ componentId: bot, terminalId: 'b' });
    expect(state().wires.length).toBe(2);
  });

  it('rejects a user-bent route that runs along an existing wire', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r2 = state().addComponent('resistor', { x: 10, y: 5 });      // b=(14,6)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r2, terminalId: 'b' });

    // Hand-routed wire with REAL corners whose first leg runs along y=6
    // (overlapping wire 1's x 5..14 run). User routes get no fallback
    // detours — the commit rejects so the user can move the bend.
    const far = state().addComponent('resistor', { x: 40, y: 5 });      // a=(40,6)
    state().startWire({ componentId: r2, terminalId: 'a' }, { x: 10, y: 6 });
    state().addWireWaypoint({ x: 16, y: 6 });
    state().addWireWaypoint({ x: 16, y: 9 });
    state().completeWire({ componentId: far, terminalId: 'a' });
    expect(state().wires.length).toBe(1);                        // rejected
    expect(state().announcement).toContain('overlap');
  });

  it('straightenWires collapses stored bends into straight/L routes (undoable)', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r1 = state().addComponent('resistor', { x: 20, y: 10 });     // a=(20,11)
    // A legacy jigsaw wire (waypoints from the old A* router).
    useEditor.setState({
      wires: [{
        id: 'legacy',
        from: { componentId: v1, terminalId: 'p' },
        to: { componentId: r1, terminalId: 'a' },
        waypoints: [{ x: 10, y: 6 }, { x: 10, y: 11 }, { x: 16, y: 11 }],
      }],
      past: [],
      future: [],
    });
    state().straightenWires();
    expect(state().wires[0].waypoints).toBeUndefined();          // now the L-route
    expect(state().past.length).toBe(1);                         // one history entry
    state().undo();
    expect(state().wires[0].waypoints).toHaveLength(3);          // restored
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Renderer: hop arcs + status hint
// ─────────────────────────────────────────────────────────────────────────────

describe('renderer: wiring UX', () => {
  function makeMockCtx() {
    const ops: Array<{ op: string; args: unknown[] }> = [];
    const ctx: Record<string, unknown> = {};
    const methods = [
      'save', 'restore', 'setTransform', 'scale', 'translate', 'rotate',
      'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect', 'fillRect', 'strokeRect',
      'fill', 'stroke', 'clip', 'fillText', 'drawImage', 'setLineDash',
    ];
    for (const m of methods) {
      ctx[m] = (...args: unknown[]) => { ops.push({ op: m, args }); };
    }
    ctx.measureText = (text: string) => ({ width: String(text).length * 6 });
    for (const prop of ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'globalAlpha', 'shadowColor', 'shadowBlur', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin']) {
      let v: unknown = undefined;
      Object.defineProperty(ctx, prop, {
        get: () => v,
        set: (nv: unknown) => { v = nv; },
        configurable: true,
      });
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
  }

  function baseScene(overrides: Partial<RenderScene> = {}): RenderScene {
    return {
      view: createInitialView(),
      dpr: 1,
      components: [],
      wires: [],
      sheets: [],
      selection: { type: null, id: null },
      multiSelection: { components: new Set<string>(), wires: new Set<string>() },
      simContext: null,
      running: false,
      showGrid: false,
      wireDraft: null,
      noConnects: [],
      drawings: [],
      units: 'grid',
      showPinNumbers: false,
      showPinNames: false,
      showPinElecTypes: false,
      netClasses: [],
      showNetColors: false,
      ercErrors: [],
      placementDraft: null,
      theme: 'dark',
      drag: null,
      wireDrag: null,
      rotateDrag: null,
      panDrag: false,
      flowPhase: 0,
      ...overrides,
    };
  }

  it('draws a hop arc (r=4.5) where two wires cross without connecting', () => {
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'c2', type: 'resistor', position: { x: 6, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'c3', type: 'resistor', position: { x: 2, y: -2 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'c4', type: 'resistor', position: { x: 2, y: 2 }, rotation: 0, parameters: { resistance: 1000 } },
    ] as unknown as CircuitComponent[];
    const wireA: Wire = {
      id: 'wa', from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' },
      waypoints: [{ x: 6, y: 1 }],
    };
    const wireB: Wire = {
      id: 'wb', from: { componentId: 'c3', terminalId: 'a' }, to: { componentId: 'c4', terminalId: 'a' },
    };
    const { ctx, ops } = makeMockCtx();
    renderScene(ctx, baseScene({ components: comps, wires: [wireA, wireB] }));
    // Terminal dots use r=3, wire handles r=3, junction dots don't apply here
    // (no ≥3 coincident endpoints) — so arcs with radius 4.5 are hop arcs.
    const hopArcs = ops.filter((o) => o.op === 'arc' && o.args[2] === 4.5);
    expect(hopArcs.length).toBe(1);
  });

  it('hides segment midpoint handles while a wire draft is active', () => {
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'c2', type: 'resistor', position: { x: 10, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
    ] as unknown as CircuitComponent[];
    const wireA: Wire = {
      id: 'wa', from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' },
    };
    const idle = makeMockCtx();
    renderScene(idle.ctx, baseScene({ components: comps, wires: [wireA] }));
    // r=3 arcs: terminals (4) + segment handles — count them for comparison.
    const idleHandleish = idle.ops.filter((o) => o.op === 'arc' && o.args[2] === 3).length;

    const drafting = makeMockCtx();
    renderScene(drafting.ctx, baseScene({
      components: comps, wires: [wireA],
      wireDraft: { from: { componentId: 'c1', terminalId: 'b' }, cursor: { x: 5, y: 8 }, waypoints: [] },
    }));
    const draftHandleish = drafting.ops.filter((o) => o.op === 'arc' && o.args[2] === 3).length;
    // Same 4 terminal dots, but the segment midpoint handle is hidden.
    expect(draftHandleish).toBe(idleHandleish - 1);
  });

  it('draws the tentative draft leg RED when every straight route would overlap', () => {
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'c2', type: 'resistor', position: { x: 10, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
    ] as unknown as CircuitComponent[];
    // Five wires on rows y=1 (direct), y=3/−1 (±2), y=5/−3 (±4), each
    // covering x 0..10 — every horizontal candidate for the draft
    // c1.b (4,1) → (8,1) is blocked → the commit will reject → red leg.
    const blockers: Wire[] = [1, 3, -1, 5, -3].map((y, i) => ({
      id: `b${i}`,
      from: { componentId: 'c1', terminalId: 'a' },
      to: { componentId: 'c2', terminalId: 'a' },
      waypoints: y === 1 ? undefined : [{ x: 0, y }, { x: 10, y }],
    }));

    // Wrap ctx.stroke to record the strokeStyle active at each call.
    function renderWithStrokeSpy(cursor: { x: number; y: number }, wires: Wire[]): string[] {
      const { ctx } = makeMockCtx();
      const origStroke = ctx.stroke.bind(ctx);
      const seen: string[] = [];
      ctx.stroke = () => { seen.push(String(ctx.strokeStyle)); origStroke(); };
      renderScene(ctx, baseScene({
        components: comps, wires,
        wireDraft: { from: { componentId: 'c1', terminalId: 'b' }, cursor, waypoints: [] },
      }));
      return seen;
    }

    // Fully blocked: red leg.
    expect(renderWithStrokeSpy({ x: 8, y: 1 }, blockers)).toContain('#ef4444');
    // Same draft pointed straight down (perpendicular): no red.
    expect(renderWithStrokeSpy({ x: 4, y: 7 }, blockers)).not.toContain('#ef4444');
    // With only one blocking wire the planner detours — no red either.
    expect(renderWithStrokeSpy({ x: 8, y: 1 }, [blockers[0]])).not.toContain('#ef4444');
  });

  it('formatStatusText shows the wiring hint while a draft is active', () => {
    const plain = formatStatusText({ x: 1, y: 2 }, 1, false);
    const drafting = formatStatusText({ x: 1, y: 2 }, 1, false, true);
    expect(plain).not.toContain('wire:');
    expect(drafting).toContain('wire:');
    expect(drafting).toContain('pin = finish');
  });

  it('renderScene tolerates malformed wire endpoints without crashing (live bug)', () => {
    const comps = [
      { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
    ] as unknown as CircuitComponent[];
    const malformed = { id: 'bad', from: 'comp_x', to: 'b' } as unknown as Wire;
    const { ctx } = makeMockCtx();
    expect(() => renderScene(ctx, baseScene({ components: comps, wires: [malformed] }))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. wire-geometry: orthogonalizePath (shared by store + drag)
// ─────────────────────────────────────────────────────────────────────────────

describe('orthogonalizePath', () => {
  it('inserts an elbow for each diagonal segment, keeps endpoints out', () => {
    const result = orthogonalizePath({ x: 0, y: 0 }, { x: 10, y: 4 }, [{ x: 5, y: 2 }]);
    // (0,0)→(5,2) diagonal → elbow; (5,2)→(10,4) diagonal → elbow.
    assertOrthogonal([{ x: 0, y: 0 }, ...result, { x: 10, y: 4 }]);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. wire-overlap pure geometry
// ─────────────────────────────────────────────────────────────────────────────

describe('findWireOverlap (pure geometry)', () => {
  const comps = [
    { id: 'c1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
    { id: 'c2', type: 'resistor', position: { x: 10, y: 0 }, rotation: 0, parameters: {} },
    { id: 'c3', type: 'resistor', position: { x: 0, y: 6 }, rotation: 0, parameters: {} },
    { id: 'c4', type: 'resistor', position: { x: 10, y: 6 }, rotation: 0, parameters: {} },
  ] as unknown as CircuitComponent[];

  it('wireGridPath mirrors getWirePath: direct when aligned, L-elbow otherwise, waypoints honored', () => {
    // Aligned pins c1.a(0,1)→c2.a(10,1): direct 2-point line.
    const aligned = wireGridPath({ from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' } }, comps, []);
    expect(aligned).toEqual([{ x: 0, y: 1 }, { x: 10, y: 1 }]);
    // Diagonal pins c1.a(0,1)→c4.a(10,7): horizontal-first L.
    const elbowPath = wireGridPath({ from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c4', terminalId: 'a' } }, comps, []);
    expect(elbowPath).toEqual([{ x: 0, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 7 }]);
    // Waypoints are honored verbatim.
    const bent = wireGridPath(
      { from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' }, waypoints: [{ x: 4, y: 4 }] },
      comps, [],
    );
    expect(bent).toEqual([{ x: 0, y: 1 }, { x: 4, y: 4 }, { x: 10, y: 1 }]);
  });

  it('detects full, partial and reversed line-on-line overlaps', () => {
    // w1: c1.a(0,1)→c2.a(10,1) horizontal y=1 x 0..10.
    const w1: Wire = { id: 'w1', from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' } };
    // Same run, reversed endpoints.
    const reversed: Wire = { id: 'wr', from: { componentId: 'c2', terminalId: 'a' }, to: { componentId: 'c1', terminalId: 'a' } };
    expect(findWireOverlap([{ x: 0, y: 1 }, { x: 10, y: 1 }], [reversed], comps, [])).not.toBeNull();
    // Partial overlap: candidate x 5..15 on the same row.
    expect(findWireOverlap([{ x: 5, y: 1 }, { x: 15, y: 1 }], [w1], comps, [])).toMatchObject({ wireId: 'w1' });
    // Parallel row (y=7): no overlap.
    expect(findWireOverlap([{ x: 5, y: 7 }, { x: 15, y: 7 }], [w1], comps, [])).toBeNull();
    // Perpendicular crossing: no overlap.
    expect(findWireOverlap([{ x: 5, y: -2 }, { x: 5, y: 5 }], [w1], comps, [])).toBeNull();
    // Endpoint touch only (share x=10 point): no overlap.
    expect(findWireOverlap([{ x: 10, y: 1 }, { x: 20, y: 1 }], [w1], comps, [])).toBeNull();
  });

  it('reports the overlapping run and length', () => {
    const w1: Wire = { id: 'w1', from: { componentId: 'c1', terminalId: 'a' }, to: { componentId: 'c2', terminalId: 'a' } };
    const hit = findWireOverlap([{ x: 4, y: 1 }, { x: 14, y: 1 }], [w1], comps, [])!;
    expect(hit.wireId).toBe('w1');
    expect(hit.from).toEqual({ x: 4, y: 1 });
    expect(hit.to).toEqual({ x: 10, y: 1 });
    expect(hit.length).toBe(6);
  });

  it('tolerates wires with unresolvable endpoints (no crash, no hit)', () => {
    const bad = { id: 'bad', from: 'oops', to: 'b' } as unknown as Wire;
    expect(findWireOverlap([{ x: 0, y: 1 }, { x: 10, y: 1 }], [bad], comps, [])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Current flow MUST travel along the wire line (computeFlowDotPositions)
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFlowDotPositions — current flows along the wire line', () => {
  /** Squared distance from point to polyline. */
  function distToPolyline(p: Vec2, path: Vec2[]): number {
    let best = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
    return best;
  }

  it('every dot lies ON the L-shaped wire polyline, at every animation offset', () => {
    // The classic L-route: horizontal leg then vertical leg.
    const path: Vec2[] = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 120 }];
    for (let off = -400; off <= 400; off += 3.7) {
      for (const d of computeFlowDotPositions(path, off)) {
        expect(distToPolyline(d, path)).toBeLessThan(1e-6);
      }
    }
  });

  it('dots turn the corner — both legs of the L carry dots', () => {
    const path: Vec2[] = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 120 }];
    const dots = computeFlowDotPositions(path, 0);
    const onHorizontal = dots.some((d) => d.y === 0 && d.x > 0 && d.x < 300);
    const onVertical = dots.some((d) => d.x === 300 && d.y > 0 && d.y < 120);
    expect(onHorizontal).toBe(true);
    expect(onVertical).toBe(true);
    // No dot ever takes the diagonal shortcut.
    expect(dots.some((d) => d.x > 0 && d.x < 300 && d.y > 0)).toBe(false);
  });

  it('offset wraps around the total length (animation loops seamlessly)', () => {
    const path: Vec2[] = [{ x: 0, y: 0 }, { x: 240, y: 0 }];
    const total = 240;
    const a = computeFlowDotPositions(path, 0).map((p) => `${p.x},${p.y}`);
    const b = computeFlowDotPositions(path, total).map((p) => `${p.x},${p.y}`);
    const c = computeFlowDotPositions(path, -total).map((p) => `${p.x},${p.y}`);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('negative offsets animate backwards (direction from current sign)', () => {
    const path: Vec2[] = [{ x: 0, y: 0 }, { x: 240, y: 0 }];
    const forward = computeFlowDotPositions(path, 10);
    const backward = computeFlowDotPositions(path, -10);
    // Different positions, same on-line guarantee.
    expect(forward[0].x).not.toBeCloseTo(backward[0].x, 6);
    for (const d of backward) expect(d.y).toBe(0);
  });

  it('degenerate paths produce no dots (no NaN, no crash)', () => {
    expect(computeFlowDotPositions([], 10)).toEqual([]);
    expect(computeFlowDotPositions([{ x: 1, y: 1 }], 10)).toEqual([]);
    expect(computeFlowDotPositions([{ x: 1, y: 1 }, { x: 1, y: 1 }], 10)).toEqual([]);
  });
});
