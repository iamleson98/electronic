// Regression tests for the PCB stack HIGH bug fixes (Task 7-b):
//
//   Bug 1 — DRC never checked via clearance (via-on-foreign-trace/pad and
//           via-on-via passed DRC clean); interactive finishRouting had no
//           clearance gate → shorts reached the Gerbers with a "DRC clean"
//           badge.
//   Bug 2 — Ratsnest airwires never disappeared after routing (store never
//           pruned/flagged satisfied legs; canvas rendered every leg).
//   Bug 3 — Copper pours neither exported to Gerbers nor serialized
//           (exportAllGerbers/X2 took no pours; serialize() omitted
//           copperPours AND layerStack; loadDocument reset both).
//   Bug 4 — moveFootprint left attached trace endpoints dangling at the OLD
//           pad positions.
//
// All tests use the REAL engines: runDRC, the real zustand usePCB store
// (importFromSchematic → runAutoRoute), finishRouting, generateCopperPour,
// exportAllGerbers — nothing mocked.

import { describe, it, expect, beforeEach } from 'vitest';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import { usePCB } from '../src/lib/pcb/store';
import { generateCopperPour } from '../src/lib/pcb/copper-pour';
import { exportAllGerbers, exportAllGerbersX2 } from '../src/lib/pcb/gerber-export';
import { flagSatisfiedRatsnestLegs } from '../src/lib/pcb/netlist-verify';
import { FOUR_LAYER_STACK, DEFAULT_LAYER_STACK } from '../src/lib/pcb/types';
import type { Footprint, Pad, Trace, Via, CopperLayer } from '../src/lib/pcb/types';
import { exampleCategories, exampleLed } from '../src/lib/circuit/examples';
import '../src/lib/circuit/components';

// ── fixtures ────────────────────────────────────────────────────────────────

function mkPad(
  id: string, x: number, y: number, net: string,
  opts: { layer?: 'top' | 'bottom'; drill?: number; size?: number; componentId?: string; terminalId?: string } = {},
): Pad {
  return {
    id,
    componentId: opts.componentId ?? id,
    terminalId: opts.terminalId ?? 'a',
    position: { x, y },
    shape: (opts.drill ?? 0) > 0 ? 'circle' : 'rect',
    size: { width: opts.size ?? 1.0, height: opts.size ?? 1.0 },
    layer: opts.layer ?? 'top',
    net,
    ...(opts.drill ? { drill: opts.drill } : {}),
  };
}

function mkFootprint(id: string, x: number, y: number, pads: Pad[], type = 'resistor'): Footprint {
  return {
    id,
    componentId: id,
    componentType: type,
    refdes: id.toUpperCase(),
    position: { x, y },
    rotation: 0,
    bodySize: { width: 4, height: 4 },
    pads,
    side: 'top',
  };
}

function mkVia(id: string, x: number, y: number, net: string, opts: Partial<Via> = {}): Via {
  return {
    id,
    position: { x, y },
    diameter: 0.6,
    drill: 0.3,
    net,
    type: 'tht',
    fromLayer: 'top',
    toLayer: 'bottom',
    ...opts,
  };
}

function mkTrace(id: string, net: string, layer: CopperLayer, start: { x: number; y: number }, end: { x: number; y: number }): Trace {
  return { id, net, layer, width: 0.3, segments: [{ start: { ...start }, end: { ...end }, width: 0.3 }] };
}

const BOARD = { width: 40, height: 40 };

// ── Bug 1: via clearance in DRC ─────────────────────────────────────────────

describe('Bug 1 — DRC via clearance checks', () => {
  it('a via dropped exactly on another net\'s trace is a SHORT (was: 0 errors)', () => {
    const trace = mkTrace('t1', 'N1', 'top', { x: 5, y: 10 }, { x: 15, y: 10 });
    const via = mkVia('v1', 10, 10, 'N2');
    const errors = runDRC([], [trace], [via], [], BOARD, DEFAULT_DRC_CONFIG);
    const shorts = errors.filter((e) => e.type === 'short');
    expect(shorts.length).toBeGreaterThanOrEqual(1);
    expect(shorts.some((e) => e.severity === 'error' && e.message.includes('via') && e.message.includes('"N2"'))).toBe(true);
  });

  it('a via too close to (not touching) a foreign trace is a clearance warning', () => {
    const trace = mkTrace('t1', 'N1', 'top', { x: 5, y: 10 }, { x: 15, y: 10 });
    // via center 0.6mm above the trace → copper gap = 0.6 - 0.3 - 0.15 = 0.15
    // < 0.2 required → warning (not a short: gap > 0)
    const via = mkVia('v1', 10, 10.6, 'N2');
    const errors = runDRC([], [trace], [via], [], BOARD, DEFAULT_DRC_CONFIG);
    const clearance = errors.filter((e) => e.type === 'clearance' && e.message.includes('via'));
    expect(clearance.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.type === 'short')).toBe(false);
  });

  it('a via overlapping a foreign SMD rect pad is a SHORT (was: 0 errors)', () => {
    const fp = mkFootprint('r1', 10, 10, [mkPad('p1', 10, 10, 'N1')]);
    const via = mkVia('v1', 10, 10, 'N2');
    const errors = runDRC([fp], [], [via], [], BOARD, DEFAULT_DRC_CONFIG);
    const shorts = errors.filter((e) => e.type === 'short' && e.message.includes('pad'));
    expect(shorts.length).toBeGreaterThanOrEqual(1);
  });

  it('a via overlapping a foreign THT pad on ANY layer is a SHORT', () => {
    // via on the bottom layer, THT pad on top — the plated barrel spans layers
    const fp = mkFootprint('r1', 10, 10, [mkPad('p1', 10, 10, 'N1', { drill: 0.6 })]);
    const via = mkVia('v1', 10, 10, 'N2');
    const errors = runDRC([fp], [], [via], [], BOARD, DEFAULT_DRC_CONFIG);
    expect(errors.some((e) => e.type === 'short' && e.message.includes('pad'))).toBe(true);
  });

  it('two overlapping vias of different nets are a SHORT (was: 0 errors)', () => {
    const a = mkVia('v1', 10, 10, 'N1');
    const b = mkVia('v2', 10.4, 10, 'N2'); // center dist 0.4 < 0.3+0.3 → overlap
    const errors = runDRC([], [], [a, b], [], BOARD, DEFAULT_DRC_CONFIG);
    const shorts = errors.filter((e) => e.type === 'short' && e.message.includes('vias'));
    expect(shorts.length).toBeGreaterThanOrEqual(1);
  });

  it('a via touching SAME-net trace and pad is CLEAN (same-net exemption honored)', () => {
    const trace = mkTrace('t1', 'N1', 'top', { x: 5, y: 10 }, { x: 15, y: 10 });
    const fp = mkFootprint('r1', 10, 20, [mkPad('p1', 10, 20, 'N1')]);
    const viaOnTrace = mkVia('v1', 10, 10, 'N1');
    const viaOnPad = mkVia('v2', 10, 20, 'N1');
    const errors = runDRC([fp], [trace], [viaOnTrace, viaOnPad], [], BOARD, DEFAULT_DRC_CONFIG);
    expect(errors.filter((e) => e.type === 'short' || e.type === 'clearance')).toHaveLength(0);
  });

  it('a blind via (top→inner1) does not conflict with a foreign trace on the BOTTOM layer', () => {
    const blind = (x: number, y: number) => mkVia('v1', x, y, 'N2', { type: 'blind', fromLayer: 'top', toLayer: 'inner1' });
    const traceTop = mkTrace('tt', 'N1', 'top', { x: 5, y: 10 }, { x: 15, y: 10 });
    const traceBottom = mkTrace('tb', 'N1', 'bottom', { x: 5, y: 30 }, { x: 15, y: 30 });
    // over the TOP trace → conflict (top is inside the blind via's span)
    const overTop = runDRC([], [traceTop, traceBottom], [blind(10, 10)], [], BOARD, DEFAULT_DRC_CONFIG);
    expect(overTop.some((e) => (e.type === 'clearance' || e.type === 'short') && /via/i.test(e.message))).toBe(true);
    // over the BOTTOM trace → the blind via has no copper on bottom → no via error
    const overBottom = runDRC([], [traceTop, traceBottom], [blind(10, 30)], [], BOARD, DEFAULT_DRC_CONFIG);
    expect(overBottom.some((e) => (e.type === 'clearance' || e.type === 'short') && /via/i.test(e.message))).toBe(false);
  });

  it('store.runDRC surfaces the via short (DRC badge no longer lies)', () => {
    usePCB.setState({
      footprints: [],
      traces: [mkTrace('t1', 'N1', 'top', { x: 5, y: 10 }, { x: 15, y: 10 })],
      vias: [mkVia('v1', 10, 10, 'N2')],
      ratsnest: [],
      board: BOARD,
      netClasses: [],
      drcErrors: [],
    });
    usePCB.getState().runDRC();
    expect(usePCB.getState().drcErrors.some((e) => e.type === 'short')).toBe(true);
  });
});

// ── Bug 1: interactive finishRouting clearance gate ─────────────────────────

describe('Bug 1 — finishRouting clearance gate', () => {
  beforeEach(() => {
    usePCB.getState().clearPCB();
  });

  it('finishing a route that runs over another net\'s pad is REJECTED', () => {
    usePCB.setState({
      board: BOARD,
      // N1 source pad (5,10) and N1 target pad (25,10); an N2 pad sits right
      // between them — a straight route shorted straight through it.
      footprints: [
        mkFootprint('r1', 5, 10, [mkPad('p1', 5, 10, 'N1', { componentId: 'r1' })]),
        mkFootprint('r2', 25, 10, [mkPad('p2', 25, 10, 'N1', { componentId: 'r2' })]),
        mkFootprint('r3', 15, 10, [mkPad('p3', 15, 10, 'N2', { componentId: 'r3' })]),
      ],
      padNets: new Map([['r1:a', 'N1'], ['r2:a', 'N1'], ['r3:a', 'N2']]),
      ratsnest: [{ fromPadId: 'p1', toPadId: 'p2', net: 'N1', from: { x: 5, y: 10 }, to: { x: 25, y: 10 } }],
      traces: [],
      vias: [],
      tool: 'route',
      activeLayer: 'top',
      defaultTraceWidth: 0.3,
    });
    usePCB.getState().startRouting({ x: 5, y: 10, net: 'N1' });
    usePCB.getState().addRoutingPoint({ x: 25, y: 10 });
    const committed = usePCB.getState().finishRouting({ x: 25, y: 10, net: 'N1' });
    expect(committed).toBe(false);
    // no copper committed, routing state kept so the user can fix it
    expect(usePCB.getState().traces).toHaveLength(0);
    expect(usePCB.getState().routingFrom).not.toBeNull();
  });

  it('a legal route commits and satisfies its ratsnest leg (also Bug 2)', () => {
    usePCB.setState({
      board: BOARD,
      footprints: [
        mkFootprint('r1', 5, 10, [mkPad('p1', 5, 10, 'N1', { componentId: 'r1' })]),
        mkFootprint('r2', 25, 10, [mkPad('p2', 25, 10, 'N1', { componentId: 'r2' })]),
        mkFootprint('r3', 15, 30, [mkPad('p3', 15, 30, 'N2', { componentId: 'r3' })]),
      ],
      padNets: new Map([['r1:a', 'N1'], ['r2:a', 'N1'], ['r3:a', 'N2']]),
      ratsnest: [{ fromPadId: 'p1', toPadId: 'p2', net: 'N1', from: { x: 5, y: 10 }, to: { x: 25, y: 10 } }],
      traces: [],
      vias: [],
      tool: 'route',
      activeLayer: 'top',
      defaultTraceWidth: 0.3,
    });
    usePCB.getState().startRouting({ x: 5, y: 10, net: 'N1' });
    usePCB.getState().addRoutingPoint({ x: 25, y: 10 });
    const committed = usePCB.getState().finishRouting({ x: 25, y: 10, net: 'N1' });
    expect(committed).toBe(true);
    expect(usePCB.getState().traces).toHaveLength(1);
    // Bug 2: the leg is satisfied WITHOUT auto-route (manual copper counts)
    const rn = usePCB.getState().ratsnest;
    expect(rn).toHaveLength(1);
    expect(rn[0].routed).toBe(true);
    // ... and it disappears from the unsatisfied set used by the canvas
    expect(flagSatisfiedRatsnestLegs(rn, usePCB.getState().footprints, usePCB.getState().traces, []).filter((l) => !l.routed)).toHaveLength(0);
  });
});

// ── Bug 2: ratsnest pruning after routing ───────────────────────────────────

describe('Bug 2 — ratsnest airwires disappear after routing', () => {
  beforeEach(() => {
    usePCB.getState().clearPCB();
  });

  it('importFromSchematic → runAutoRoute → EVERY leg satisfied; unrouteAll → legs return', () => {
    // 'LED + Resistor' left the example menu (kept as a test fixture export)
    const ex = { name: 'LED + Resistor', doc: exampleLed };
    usePCB.getState().importFromSchematic(ex.doc.components, ex.doc.wires);
    const before = usePCB.getState().ratsnest;
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(before.every((l) => !l.routed)).toBe(true); // nothing routed yet

    const stats = usePCB.getState().runAutoRoute();
    expect(stats.unroutedCount).toBe(0);
    const after = usePCB.getState().ratsnest;
    // a fully-routed board must not keep showing airwires
    expect(after.every((l) => l.routed)).toBe(true);
    expect(flagSatisfiedRatsnestLegs(after, usePCB.getState().footprints, usePCB.getState().traces, usePCB.getState().vias).filter((l) => !l.routed)).toHaveLength(0);

    // unroute → airwires return
    usePCB.getState().unrouteAll();
    const restored = usePCB.getState().ratsnest;
    expect(restored).toHaveLength(after.length);
    expect(restored.every((l) => !l.routed)).toBe(true);
  });

  it('loadDocument of a routed board does NOT resurrect airwires', () => {
    // 'LED + Resistor' left the example menu (kept as a test fixture export)
    const ex = { name: 'LED + Resistor', doc: exampleLed };
    usePCB.getState().importFromSchematic(ex.doc.components, ex.doc.wires);
    usePCB.getState().runAutoRoute();
    const doc = JSON.parse(JSON.stringify(usePCB.getState().serialize()));

    // load the serialized routed board — the ratsnest must come back SATISFIED
    usePCB.getState().loadDocument(doc as any);
    const rn = usePCB.getState().ratsnest;
    expect(rn.length).toBeGreaterThanOrEqual(2);
    expect(rn.every((l) => l.routed)).toBe(true);
  });

  it('deleteTrace un-satisfies the leg again (airwire returns)', () => {
    usePCB.setState({
      board: BOARD,
      footprints: [
        mkFootprint('r1', 5, 10, [mkPad('p1', 5, 10, 'N1', { componentId: 'r1' })]),
        mkFootprint('r2', 25, 10, [mkPad('p2', 25, 10, 'N1', { componentId: 'r2' })]),
      ],
      padNets: new Map([['r1:a', 'N1'], ['r2:a', 'N1']]),
      ratsnest: [{ fromPadId: 'p1', toPadId: 'p2', net: 'N1', from: { x: 5, y: 10 }, to: { x: 25, y: 10 } }],
      tool: 'route',
      activeLayer: 'top',
      defaultTraceWidth: 0.3,
    });
    usePCB.getState().startRouting({ x: 5, y: 10, net: 'N1' });
    usePCB.getState().addRoutingPoint({ x: 25, y: 10 });
    expect(usePCB.getState().finishRouting({ x: 25, y: 10, net: 'N1' })).toBe(true);
    expect(usePCB.getState().ratsnest[0].routed).toBe(true);

    usePCB.getState().deleteTrace(usePCB.getState().traces[0].id);
    expect(usePCB.getState().ratsnest[0].routed).toBeFalsy();
  });
});

// ── Bug 3: copper pour + layer stack serialization & Gerber export ──────────

describe('Bug 3 — copper pours and layer stack survive serialization', () => {
  beforeEach(() => {
    usePCB.getState().clearPCB();
  });

  it('serialize/loadDocument round-trip preserves copperPours AND layerStack exactly', () => {
    usePCB.setState({
      board: { width: 30, height: 20 },
      footprints: [mkFootprint('r1', 15, 10, [mkPad('p1', 15, 10, 'GND')])],
      traces: [],
      vias: [],
      padNets: new Map([['r1:a', 'GND']]),
    });
    usePCB.getState().setLayerStack(FOUR_LAYER_STACK);
    usePCB.getState().addCopperPour('top', 'GND');
    const pour = usePCB.getState().copperPours[0];
    expect(pour).toBeDefined();
    expect(pour.cells.length).toBeGreaterThan(10);

    const doc = JSON.parse(JSON.stringify(usePCB.getState().serialize()));
    expect(doc.layerStack).toEqual(FOUR_LAYER_STACK);
    expect(doc.copperPours).toHaveLength(1);

    usePCB.getState().loadDocument(doc as any);
    // both restored exactly (deep-equal through the JSON round-trip)
    expect(usePCB.getState().layerStack).toEqual(JSON.parse(JSON.stringify(FOUR_LAYER_STACK)));
    expect(usePCB.getState().copperPours).toEqual([JSON.parse(JSON.stringify(pour))]);
  });

  it('old documents without layerStack/copperPours load without crashing (defaults applied)', () => {
    usePCB.getState().setLayerStack(FOUR_LAYER_STACK);
    usePCB.setState({ copperPours: [generateCopperPour('top', 'GND', [], [], [], { width: 20, height: 20 })] });
    // legacy doc shape: no layerStack / copperPours / padNets fields at all
    usePCB.getState().loadDocument({
      version: 1,
      board: { width: 40, height: 30 },
      footprints: [
        mkFootprint('r1', 20, 15, [mkPad('p1', 20, 15, 'N1', { componentId: 'r1' })]),
        mkFootprint('r2', 30, 15, [mkPad('p2', 30, 15, 'N1', { componentId: 'r2' })]),
      ],
      traces: [],
      vias: [],
      activeLayer: 'top',
      defaultTraceWidth: 0.3,
    } as any);
    expect(usePCB.getState().layerStack).toEqual(DEFAULT_LAYER_STACK);
    expect(usePCB.getState().copperPours).toEqual([]);
    // the ratsnest is rebuilt from the (pad-net-less) footprints — no crash,
    // and pads without padNets entries simply produce no legs
    expect(Array.isArray(usePCB.getState().ratsnest)).toBe(true);
    expect(usePCB.getState().ratsnest).toEqual([]);
  });
});

describe('Bug 3 — copper pours are exported to the Gerbers', () => {
  const tinyBoard = { width: 4, height: 2 };

  it('X1: pour geometry lands on its copper layer as exact rect-run flashes', () => {
    // 4×2mm board, no obstacles → full fill: 8 cols × 4 rows of 0.5mm cells
    const pour = generateCopperPour('top', 'GND', [], [], [], tinyBoard, 0.3);
    expect(pour.cells.length).toBe(32);

    const files = exportAllGerbers([], [], [], tinyBoard, [pour]);
    const top = files.find((f) => f.filename === 'top_copper.gbr')!.content;
    const bottom = files.find((f) => f.filename === 'bottom_copper.gbr')!.content;

    // exact-size rect aperture for the merged 4.0×0.5mm row runs
    expect(top).toMatch(/%ADD\d+R,4\.0000X0\.5000\*%/);
    // a flash at the center of the first row run (x=2.0mm, y=0.25mm in X26Y26)
    expect(top).toContain('X02000000Y00250000D03*');
    // 4 rows → 4 pour flashes (no pads/vias/traces on this board)
    expect(top.match(/D03\*/g)?.length).toBe(4);
    // top-only pour → the bottom layer must NOT carry it
    expect(bottom).not.toContain('X02000000Y00250000D03*');
    expect(bottom).not.toMatch(/%ADD\d+R,4\.0000X0\.5000\*%/);
  });

  it('X1 pours export as plain copper (no net attributes — noted design decision)', () => {
    const pour = generateCopperPour('top', 'GND', [], [], [], tinyBoard, 0.3);
    const files = exportAllGerbers([], [], [], tinyBoard, [pour]);
    const top = files.find((f) => f.filename === 'top_copper.gbr')!.content;
    expect(top).toContain('D03*');
    expect(top).not.toContain('GND'); // RS-274X has no net attributes
  });

  it('X2: pour exports WITH its net attribute on the correct layer', () => {
    const pour = generateCopperPour('top', 'GND', [], [], [], tinyBoard, 0.3);
    const files = exportAllGerbersX2([], [], [], tinyBoard, [pour]);
    const top = files.find((f) => f.filename === 'top_copper.gbr')!.content;
    const bottom = files.find((f) => f.filename === 'bottom_copper.gbr')!.content;
    expect(top).toContain('%TO.N,GND*%');
    expect(top).toMatch(/%ADD\d+R,4\.0000X0\.5000\*%/);
    expect(top).toContain('X02000000Y00250000D03*');
    expect(bottom).not.toContain('%TO.N,GND*%');
    expect(bottom).not.toContain('X02000000Y00250000D03*');
  });

  it('omitting the pours argument keeps the legacy export identical (backward compatible)', () => {
    const top = exportAllGerbers([], [], [], tinyBoard)[0].content;
    expect(top).not.toContain('D03*'); // no pads/vias/traces/pours → no flashes
  });
});

// ── Bug 4: moveFootprint drags attached trace endpoints ─────────────────────

describe('Bug 4 — moveFootprint drags attached trace endpoints', () => {
  beforeEach(() => {
    usePCB.getState().clearPCB();
  });

  it('a trace endpoint exactly on a pad moves by (dx, dy) with the footprint', () => {
    usePCB.setState({
      board: { width: 60, height: 60 },
      footprints: [mkFootprint('r1', 10, 10, [mkPad('p1', 12, 10, 'N1', { componentId: 'r1' })])],
      traces: [mkTrace('t1', 'N1', 'top', { x: 12, y: 10 }, { x: 30, y: 10 })],
      padNets: new Map([['r1:a', 'N1']]),
    });
    // move by (+3, +5) — the pad lands at (15, 15)
    usePCB.getState().moveFootprint('r1', { x: 13, y: 15 });
    const fp = usePCB.getState().footprints[0];
    expect(fp.pads[0].position).toEqual({ x: 15, y: 15 });
    const trace = usePCB.getState().traces[0];
    // the attached endpoint followed the pad (was: stuck at the OLD pad position)
    expect(trace.segments[0].start).toEqual({ x: 15, y: 15 });
    // the free endpoint stayed put
    expect(trace.segments[0].end).toEqual({ x: 30, y: 10 });
  });

  it('a trace endpoint NOT on the footprint\'s pads stays put', () => {
    usePCB.setState({
      board: { width: 60, height: 60 },
      footprints: [mkFootprint('r1', 10, 10, [mkPad('p1', 12, 10, 'N1', { componentId: 'r1' })])],
      // 30,10 is far from the pad (radius 0.5) — must NOT be dragged
      traces: [mkTrace('t1', 'N2', 'top', { x: 30, y: 10 }, { x: 40, y: 10 })],
      padNets: new Map([['r1:a', 'N1']]),
    });
    usePCB.getState().moveFootprint('r1', { x: 20, y: 20 });
    const trace = usePCB.getState().traces[0];
    expect(trace.segments[0].start).toEqual({ x: 30, y: 10 });
    expect(trace.segments[0].end).toEqual({ x: 40, y: 10 });
  });

  it('two footprints connected by one trace: moving one drags ONLY its side', () => {
    usePCB.setState({
      board: { width: 60, height: 60 },
      footprints: [
        mkFootprint('r1', 10, 10, [mkPad('p1', 12, 10, 'N1', { componentId: 'r1' })]),
        mkFootprint('r2', 30, 10, [mkPad('p2', 28, 10, 'N1', { componentId: 'r2' })]),
      ],
      traces: [mkTrace('t1', 'N1', 'top', { x: 12, y: 10 }, { x: 28, y: 10 })],
      padNets: new Map([['r1:a', 'N1'], ['r2:a', 'N1']]),
    });
    usePCB.getState().moveFootprint('r1', { x: 13, y: 15 }); // +3, +5
    let trace = usePCB.getState().traces[0];
    expect(trace.segments[0].start).toEqual({ x: 15, y: 15 }); // r1 side followed
    expect(trace.segments[0].end).toEqual({ x: 28, y: 10 });   // r2 side untouched

    usePCB.getState().moveFootprint('r2', { x: 32, y: 10 }); // +2, 0
    trace = usePCB.getState().traces[0];
    expect(trace.segments[0].start).toEqual({ x: 15, y: 15 }); // now r1 side untouched
    expect(trace.segments[0].end).toEqual({ x: 30, y: 10 });   // r2 side followed
  });

  it('rotateFootprint drags attached trace endpoints to the rotated pad positions', () => {
    usePCB.setState({
      board: { width: 60, height: 60 },
      footprints: [mkFootprint('r1', 20, 20, [
        mkPad('p1', 22, 20, 'N1', { componentId: 'r1', terminalId: 'a' }),
        mkPad('p2', 18, 20, 'N2', { componentId: 'r1', terminalId: 'b' }),
      ])],
      // both trace ends sit exactly on the pads
      traces: [mkTrace('t1', 'N1', 'top', { x: 22, y: 20 }, { x: 18, y: 20 })],
      padNets: new Map([['r1:a', 'N1'], ['r1:b', 'N2']]),
    });
    usePCB.getState().rotateFootprint('r1');
    const fp = usePCB.getState().footprints[0];
    expect(fp.rotation).toBe(90);
    const p1 = fp.pads.find((p) => p.id === 'p1')!;
    const p2 = fp.pads.find((p) => p.id === 'p2')!;
    // the pads actually moved (resistor def pads rotate ±2.1mm around center)
    expect(p1.position).not.toEqual({ x: 22, y: 20 });
    expect(p2.position).not.toEqual({ x: 18, y: 20 });
    const trace = usePCB.getState().traces[0];
    // the trace ends stay glued to their pads (not dangling at the old spots)
    expect(trace.segments[0].start).toEqual(p1.position);
    expect(trace.segments[0].end).toEqual(p2.position);
  });
});
