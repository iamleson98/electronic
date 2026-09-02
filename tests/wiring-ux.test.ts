// Wiring UX overhaul — regression tests.
//
// Covers the two user complaints this changeset fixes:
//   1. "Wires easily overlap and are hard to see and reason about"
//      → router clearance costs, corner-sparse waypoints, crossing hop
//        arcs (wire-crossings), honest draft preview.
//   2. "The snapping feature is hard to work with"
//      → nearest-match terminal snap, zoom-independent screen-space snap
//        radius, snap exclusion/bypass, click-by-click bend placement.

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
import { orthogonalizePath } from '../src/lib/circuit/wire-geometry';
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

  it('routes the preview AROUND a blocking component (detours visible before commit)', () => {
    // c1 pin at (0,1); big component body covering x=2..8, y=0..2 → the
    // straight y=1 row is blocked.
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
    expect(result.routed).toBe(true);
    // No path cell may sit inside the body region (x=2..6, y=0..2).
    const inBody = result.path.some((p) => p.x >= 2 && p.x <= 6 && p.y >= 0 && p.y <= 2);
    expect(inBody).toBe(false);
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

  it('completeWire auto-route stores corner-sparse waypoints (no handle every cell)', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 4, y: 6 });      // p=(5,6)
    const r1 = state().addComponent('resistor', { x: 30, y: 10 });    // a=(30,11)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 6 });
    state().completeWire({ componentId: r1, terminalId: 'a' });

    const wire = state().wires[0];
    expect(wire).toBeDefined();
    const fullPath: Vec2[] = [
      { x: 5, y: 6 },
      ...(wire.waypoints ?? []),
      { x: 30, y: 11 },
    ];
    // The old implementation stored EVERY A* cell (~25 waypoints here);
    // sparse storage means ≤ 3 corners for an L-ish route.
    expect((wire.waypoints ?? []).length).toBeLessThanOrEqual(4);
    assertOrthogonal(fullPath);
    assertCornerSparse(fullPath);
  });

  it('routes correctly to components placed beyond the old 100×60 grid', () => {
    reset();
    const v1 = state().addComponent('dcVoltage', { x: 150, y: 80 });   // p=(151,80)
    const r1 = state().addComponent('resistor', { x: 170, y: 90 });   // a=(170,91)
    state().startWire({ componentId: v1, terminalId: 'p' }, { x: 151, y: 80 });
    state().completeWire({ componentId: r1, terminalId: 'a' });
    const wire = state().wires[0];
    expect(wire).toBeDefined();
    // Route must reach the pin area, not be clamped at the old x=100 bound.
    const fullPath: Vec2[] = [{ x: 151, y: 80 }, ...(wire.waypoints ?? []), { x: 170, y: 91 }];
    const maxX = Math.max(...fullPath.map((p) => p.x));
    expect(maxX).toBeGreaterThanOrEqual(169);
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
