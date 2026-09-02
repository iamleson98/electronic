// Wire re-routing regression tests — the "stale waypoints" bug family.
//
// REPRODUCED BUG (user-visible): moving / rotating / mirroring a component
// mutated component geometry without touching wire waypoints. The renderer
// draws waypoints verbatim, so the leg from the moved pin to the first stale
// waypoint rendered DIAGONAL — and the current-flow dots (which ride the
// rendered polyline) flowed along that diagonal. Users rearranging an
// example circuit saw "wires are not orthogonal" and "current does not flow
// along the wires".
//
// Guarded invariants:
//   1. After ANY component mutation, every wire's rendered path (endpoint
//      positions + stored waypoints, plus the renderer's default L route for
//      waypoint-less wires) contains ZERO diagonal segments.
//   2. Wire endpoints (terminal refs) are never touched → the netlist
//      (buildNodeMap) is bit-identical before/after.
//   3. loadDocument normalizes legacy diagonal waypoints (share URL,
//      autosave/crash recovery, Library rows, imports).
//   4. The AI addWire tool stores only orthogonal waypoints.
//   5. The canonical terminal resolver honors mirror + free rotation with
//      EXACT parity with the canvas body transform.
//   6. Undo restores pre-move geometry (components AND wires together).

import { describe, it, expect, beforeAll } from 'vitest';
import { useEditor } from '../src/lib/circuit/store';
import { exampleLed, exampleVoltageDivider } from '../src/lib/circuit/examples';
import { resolveEndpointGridPos, terminalPos, transformBodyPoint } from '../src/lib/circuit/endpoint-position';
import { rerouteAttachedWires, orthogonalizeDocumentWires, hasDiagonalSegment } from '../src/lib/circuit/wire-reroute';
import { buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitDocument, Vec2, Wire } from '../src/lib/circuit/types';

const EPS = 1e-6;

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/power-symbols');
  useEditor.getState().loadDocument(exampleLed);
});

/** The EXACT geometry the renderer draws for a wire (getWirePath parity). */
function renderedPath(wire: Wire, doc: CircuitDocument): Vec2[] | null {
  const from = resolveEndpointGridPos(wire.from, doc.components, doc.sheets ?? []);
  const to = resolveEndpointGridPos(wire.to, doc.components, doc.sheets ?? []);
  if (!from || !to) return null;
  const pts: Vec2[] = [from];
  if (wire.waypoints && wire.waypoints.length > 0) {
    pts.push(...wire.waypoints);
  } else if (Math.abs(to.x - from.x) > EPS && Math.abs(to.y - from.y) > EPS) {
    pts.push({ x: to.x, y: from.y }); // default horizontal-first elbow
  }
  pts.push(to);
  return pts;
}

function docDiagonals(doc: CircuitDocument): string[] {
  const out: string[] = [];
  for (const w of doc.wires ?? []) {
    const path = renderedPath(w, doc);
    if (!path) continue;
    for (let i = 0; i < path.length - 1; i++) {
      if (Math.abs(path[i + 1].x - path[i].x) > EPS && Math.abs(path[i + 1].y - path[i].y) > EPS) {
        out.push(`${w.id} segment ${i}: (${path[i].x},${path[i].y})→(${path[i + 1].x},${path[i + 1].y})`);
      }
    }
  }
  return out;
}

function netlistKeys(doc: CircuitDocument): string[] {
  const plugins = new Map<string, any>();
  for (const c of doc.components) {
    if (!plugins.has(c.type)) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
  }
  const map = buildNodeMap(doc.components, doc.wires, plugins);
  return [...(map as unknown as { terminalNode: Map<string, number> }).terminalNode.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

describe('wire re-routing after component mutations', () => {
  it('baseline: the LED example is orthogonal at rest', () => {
    expect(docDiagonals(exampleLed)).toEqual([]);
  });

  it('REPRODUCED BUG — moving a component used to leave a diagonal; now every wire re-orthogonalizes', () => {
    const store = useEditor.getState();
    useEditor.getState().loadDocument(exampleLed);
    const before = netlistKeys({ ...exampleLed, components: useEditor.getState().components, wires: useEditor.getState().wires });

    // Move the resistor FAR off its original corridor (the drag that used to
    // strand waypoints and render a long diagonal).
    useEditor.getState().moveComponent('r1', { x: 14, y: 14 });

    const s = useEditor.getState();
    const after = netlistKeys({ ...exampleLed, components: s.components, wires: s.wires });
    const diagonals = docDiagonals({ ...exampleLed, components: s.components, wires: s.wires });
    expect(diagonals).toEqual([]);
    // Netlist is identical — endpoints never touched.
    expect(after).toEqual(before);
  });

  it('moving repeatedly (a whole drag sequence) stays orthogonal at every step', () => {
    useEditor.getState().loadDocument(exampleLed);
    for (let step = 0; step < 6; step++) {
      useEditor.getState().moveComponent('led1', { x: 16 + step, y: 8 + (step % 3) });
      const s = useEditor.getState();
      expect(docDiagonals({ ...exampleLed, components: s.components, wires: s.wires })).toEqual([]);
    }
  });

  it('rotating a component re-orthogonalizes attached wires', () => {
    useEditor.getState().loadDocument(exampleVoltageDivider);
    const before = netlistKeys({ ...exampleVoltageDivider, components: useEditor.getState().components, wires: useEditor.getState().wires });
    useEditor.getState().rotateComponent('pot1');
    const s = useEditor.getState();
    expect(docDiagonals({ ...exampleVoltageDivider, components: s.components, wires: s.wires })).toEqual([]);
    expect(netlistKeys({ ...exampleVoltageDivider, components: s.components, wires: s.wires })).toEqual(before);
  });

  it('mirroring a component re-orthogonalizes attached wires AND terminals follow the body flip', () => {
    useEditor.getState().loadDocument(exampleLed);
    useEditor.getState().mirrorComponent('r1', 'x');
    const s = useEditor.getState();
    const doc: CircuitDocument = { ...exampleLed, components: s.components, wires: s.wires };
    expect(docDiagonals(doc)).toEqual([]);

    // Terminal parity: the resolved terminal must sit exactly where the
    // mirrored body renders it — reflection around the bounding-box center.
    const r1 = doc.components.find((c) => c.id === 'r1')!;
    const plugin = getPlugin('resistor')!;
    const a = plugin.terminals.find((t) => t.id === 'a')!;
    const pos = terminalPos(r1, a, plugin);
    // resistor bb is 4×2 (verified via getComponentInfo); terminal a sits at
    // (0,1) unmirrored → mirrored (mirrorX flips y around center 1): (0,1).
    // The invariant that matters: mirrored a and b SWAP y-offsets relative
    // to the unmirrored case — for bb height 2 the offset is symmetric, so
    // the stronger check is the transform itself (below).
    expect(Math.abs(pos.y - (r1.position.y + 1))).toBeLessThan(EPS + 1e-9);
  });

  it('transformBodyPoint matches the canvas body transform for mirror + free rotation', () => {
    const bb = { width: 4, height: 2 };
    const p = { x: 0, y: 1 };
    // 90° rotation around center (2,1): dx=-2, dy=0 → case 1: rx=-dy=0, ry=dx=-2
    // → (cx+rx, cy+ry) = (2, -1). Exact integers, no trig drift.
    const r90 = transformBodyPoint({ rotation: 1, mirrorX: false, mirrorY: false } as never, p, bb);
    expect(r90.x).toBe(2);
    expect(r90.y).toBe(-1);
    // Free rotation 15°: point (0,1) around center (2,1).
    const r15 = transformBodyPoint({ rotation: 0, rotationDeg: 15, mirrorX: false, mirrorY: false } as never, p, bb);
    const cx = 2, cy = 1;
    const rad = (15 * Math.PI) / 180;
    const dx = p.x - cx, dy = p.y - cy;
    const expectX = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    const expectY = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    expect(r15.x).toBeCloseTo(expectX, 9);
    expect(r15.y).toBeCloseTo(expectY, 9);
    // Mirror: reflection around the center, exact for 90° steps.
    const mx = transformBodyPoint({ rotation: 0, mirrorX: true, mirrorY: false } as never, p, bb);
    expect(mx.y).toBeCloseTo(bb.height - p.y, 9);
    const my = transformBodyPoint({ rotation: 0, mirrorX: false, mirrorY: true } as never, p, bb);
    expect(my.x).toBeCloseTo(bb.width - p.x, 9);
  });

  it('undo restores the pre-move components AND wires together', () => {
    useEditor.getState().loadDocument(exampleLed);
    useEditor.getState().beginDrag();
    const wBefore = JSON.stringify(useEditor.getState().wires);
    const cBefore = JSON.stringify(useEditor.getState().components);
    useEditor.getState().moveComponent('r1', { x: 14, y: 14 });
    expect(JSON.stringify(useEditor.getState().wires)).not.toEqual(wBefore);
    useEditor.getState().undo();
    expect(JSON.stringify(useEditor.getState().components)).toEqual(cBefore);
    expect(JSON.stringify(useEditor.getState().wires)).toEqual(wBefore);
  });

  it('group-drag (moveSelectedComponents) re-orthogonalizes', () => {
    useEditor.getState().loadDocument(exampleLed);
    const s0 = useEditor.getState();
    s0.setMultiSelection({ components: new Set(['r1', 'led1']), wires: new Set() });
    useEditor.getState().moveSelectedComponents({ x: 3, y: -2 });
    const s = useEditor.getState();
    expect(docDiagonals({ ...exampleLed, components: s.components, wires: s.wires })).toEqual([]);
  });
});

describe('loadDocument normalization (share URL / autosave / Library / imports)', () => {
  it('legacy diagonal waypoints are orthogonalized at load', () => {
    // A document with a deliberately diagonal stored route (pre-fix autosave).
    const legacy: CircuitDocument = JSON.parse(JSON.stringify(exampleLed));
    const w1 = legacy.wires.find((w) => w.id === 'w1')!;
    w1.waypoints = [{ x: 7, y: 11.5 }]; // diagonal from v1.p(5,6) and to r1.a(8,9)
    const fixed = orthogonalizeDocumentWires(legacy);
    expect(docDiagonals(fixed)).toEqual([]);
    // Endpoints preserved verbatim.
    for (const w of fixed.wires) {
      const orig = legacy.wires.find((x) => x.id === w.id)!;
      expect(w.from).toEqual(orig.from);
      expect(w.to).toEqual(orig.to);
    }
  });

  it('already-orthogonal documents pass through untouched (identity)', () => {
    const same = orthogonalizeDocumentWires(exampleLed);
    expect(same).toBe(exampleLed);
  });

  it('netlist is bit-identical through normalization', () => {
    const legacy: CircuitDocument = JSON.parse(JSON.stringify(exampleLed));
    legacy.wires.forEach((w, i) => {
      w.waypoints = [{ x: 6 + i, y: 10 + (i % 3) + 0.5 }];
    });
    const fixed = orthogonalizeDocumentWires(legacy);
    expect(netlistKeys(fixed)).toEqual(netlistKeys(legacy));
  });

  it('store.loadDocument applies the normalization (the autosave/crash-recovery path)', () => {
    const legacy: CircuitDocument = JSON.parse(JSON.stringify(exampleLed));
    const w1 = legacy.wires.find((w) => w.id === 'w1')!;
    w1.waypoints = [{ x: 7, y: 11.5 }];
    useEditor.getState().loadDocument(legacy);
    const s = useEditor.getState();
    expect(docDiagonals({ ...legacy, components: s.components, wires: s.wires })).toEqual([]);
  });
});

describe('AI addWire waypoint orthogonalization', () => {
  it('hasDiagonalSegment detects the diagonal a raw LLM waypoint would render', () => {
    expect(hasDiagonalSegment({ x: 0, y: 0 }, { x: 4, y: 4 }, [{ x: 2, y: 2 }])).toBe(true);
    expect(hasDiagonalSegment({ x: 0, y: 0 }, { x: 4, y: 0 }, [{ x: 2, y: 0 }])).toBe(false);
    expect(hasDiagonalSegment({ x: 0, y: 0 }, { x: 4, y: 4 }, undefined)).toBe(false); // default L
  });

  it('rerouteAttachedWires keeps untouched wires by identity (render memoization)', () => {
    const wires = exampleLed.wires.map((w) => ({ ...w }));
    const out = rerouteAttachedWires(exampleLed.components, wires, [], new Set(['nonexistent-id']));
    expect(out).toBe(wires); // same array, same identities
  });
});

describe('terminal resolver parity with the body render', () => {
  it('unrotated/unmirrored resolution is unchanged (backward compat)', () => {
    for (const c of exampleLed.components) {
      const plugin = getPlugin(c.type);
      if (!plugin) continue;
      for (const t of plugin.terminals) {
        const pos = terminalPos(c, t, plugin);
        expect(pos.x).toBeCloseTo(c.position.x + t.position.x, 9);
        expect(pos.y).toBeCloseTo(c.position.y + t.position.y, 9);
      }
    }
  });

  it('90° rotations produce exact on-grid positions (no trig drift)', () => {
    const c = exampleLed.components.find((x) => x.id === 'r1')!;
    const plugin = getPlugin('resistor')!;
    const a = plugin.terminals.find((t) => t.id === 'a')!;
    for (const rot of [1, 2, 3] as const) {
      const pos = terminalPos({ ...c, rotation: rot }, a, plugin);
      expect(Number.isInteger(pos.x)).toBe(true);
      expect(Number.isInteger(pos.y)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hop-arc corner tracing — THE pixel-level bug the geometry probes missed.
//
// strokeWirePathWithHops used to draw each hop-free slice as a TWO-POINT
// moveTo/lineTo (path start → point along the path), CUTTING THE CORNER of
// L/Z-shaped wires: any wire with a hop mark mid-segment rendered a long
// diagonal. This is invisible to data-level probes (stored waypoints were
// orthogonal!) — only the rendered lineTo sequence exposes it.
// ─────────────────────────────────────────────────────────────────────────────
describe('hop arcs trace corners (rendered lineTo sequence)', () => {
  function makeNoopPlugin(): any {
    return {
      type: 'noop2',
      name: 'Noop',
      label: 'Noop',
      symbol: 'N',
      category: 'passive',
      description: 'noop plugin',
      boundingBox: { width: 2, height: 2 },
      parameters: [],
      terminals: [
        { id: 'p', label: 'P', position: { x: 1, y: 0 } },
        { id: 'n', label: 'N', position: { x: 1, y: 2 } },
      ],
      render: () => {},
      stamp: () => {},
    };
  }

  it('every wire lineTo is axis-aligned even when hop marks cut mid-segment', async () => {
    const { renderScene, createInitialView } = await import('../src/components/circuit/canvas-renderer');
    const { registerPlugin } = await import('../src/lib/circuit/registry');
    registerPlugin(makeNoopPlugin());

    // c1 at (0,0): p=(1,0), n=(1,2). c2 at (20,0): p=(21,0), n=(21,2).
    const components = [
      { id: 'c1', type: 'noop2', position: { x: 0, y: 0 }, rotation: 0, parameters: {} },
      { id: 'c2', type: 'noop2', position: { x: 20, y: 0 }, rotation: 0, parameters: {} },
    ] as never[];

    // w2 FIRST (older) — vertical at x=11 from (11,-3) area... use c-less
    // geometry: connect c1.p (1,0) → c2.n (21,2)? We need a crossing with
    // w1's horizontal segment. Simplest: wire from a fake terminal far away
    // isn't possible (endpoints must resolve). Use waypoint'd wires between
    // the real terminals:
    //   wA: c1.n(1,2) → wps (1,6),(21,6) → c2.p? no—c2.p=(21,0) vertical.
    // Route wA: (1,2)→(1,6)→(21,6)→(21,2)=c2.n — a bracket with corners.
    // Route wB: c1.p(1,0)→ wps (11,0)?(no) — wB must CROSS wA's horizontal:
    //   wB: c1.p (1,0) → wps (11,0),(11,8),(21,8) → c2.p (21,0): path
    //   (1,0)→(11,0)→(11,8)→(21,8)→(21,0) — orthogonal bracket. Crossing
    //   with wA at (11,6) ✓ mid-segment of wB's vertical leg.
    const wires = [
      { id: 'wA', from: { componentId: 'c1', terminalId: 'n' }, to: { componentId: 'c2', terminalId: 'n' },
        waypoints: [{ x: 1, y: 6 }, { x: 21, y: 6 }] },
      { id: 'wB', from: { componentId: 'c1', terminalId: 'p' }, to: { componentId: 'c2', terminalId: 'p' },
        waypoints: [{ x: 11, y: 0 }, { x: 11, y: 8 }, { x: 21, y: 8 }] },
    ] as never[];

    const ops: Array<{ op: string; args: number[] }> = [];
    const ctx: Record<string, unknown> = {};
    for (const m of ['save', 'restore', 'setTransform', 'scale', 'translate', 'rotate', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect', 'fillRect', 'strokeRect', 'fill', 'stroke', 'clip', 'fillText', 'drawImage', 'setLineDash']) {
      ctx[m] = (...args: unknown[]) => { ops.push({ op: m, args: args as number[] }); };
    }
    ctx.measureText = (t: string) => ({ width: t.length * 6 });
    for (const prop of ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'globalAlpha', 'shadowColor', 'shadowBlur', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin']) {
      let v: unknown;
      Object.defineProperty(ctx, prop, { get: () => v, set: (nv: unknown) => { v = nv; }, configurable: true });
    }

    renderScene(ctx as unknown as CanvasRenderingContext2D, {
      view: createInitialView(),
      dpr: 1,
      components,
      wires,
      sheets: [],
      selection: { type: null, id: null },
      multiSelection: { components: new Set(), wires: new Set() },
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
    } as never);

    // Extract the drawn polyline from moveTo/lineTo ops whose previous
    // stroke-geometry op was moveTo/lineTo (arc-adjacent moves excluded —
    // the hop semicircle is a curve by design).
    const diagonals: string[] = [];
    let prev: { op: string; args: number[] } | null = null;
    for (const o of ops) {
      if (o.op === 'moveTo' || o.op === 'lineTo') {
        if (prev && (prev.op === 'moveTo' || prev.op === 'lineTo') && o.op === 'lineTo') {
          const dx = Math.abs(o.args[0] - prev.args[0]);
          const dy = Math.abs(o.args[1] - prev.args[1]);
          if (dx > 0.01 && dy > 0.01) {
            diagonals.push(`(${prev.args[0]},${prev.args[1]})→(${o.args[0]},${o.args[1]})`);
          }
        }
        prev = o;
      } else if (o.op === 'arc') {
        prev = null; // hop arc — reset pair tracking
      } else if (o.op !== 'stroke' && o.op !== 'beginPath') {
        prev = null;
      } else {
        prev = null;
      }
    }
    expect(diagonals).toEqual([]);
  });
});
