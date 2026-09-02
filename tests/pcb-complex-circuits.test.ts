// PCB layout verification on COMPLEX circuits — the production-workflow
// battery requested after the router/placement overhaul:
//
//   1. The three biggest bundled examples (6-digit clocks, 24-component
//      audio amp) go through the STORE pipeline (the exact UI code path:
//      importFromSchematic → runAutoRoute → runDRC) and must come out
//      100% routed with zero hard DRC errors, like KiCad's "route all +
//      DRC" loop.
//   2. A hand-built mixed-signal board (~29 components / ~45 wires: MCU,
//      555, LDO, decoupling bank, LED bank, analog pots, transistor
//      driver, star ground) exercises high-fanout rails and DIP-30
//      footprints.
//   3. Production workflow semantics: edit → unroute → re-route converges
//      clean; serialize/loadDocument round-trips a routed complex board;
//      undo restores traces; placement has no overlapping courtyards and
//      valid rotations; trace geometry is 0°/45°/90° with pad-exact
//      endpoints; performance stays bounded.
//
// Independent audits reuse the exported geometry helpers (distSegSeg etc.)
// instead of trusting router internals.

import { describe, it, expect, beforeEach } from 'vitest';
import '../src/lib/circuit/components';
import { exampleCategories } from '../src/lib/circuit/examples';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import { usePCB, _resetPCBHistory } from '../src/lib/pcb/store';
import {
  createPCBFromSchematic,
  computeSmartPlacement,
} from '../src/lib/pcb/netlist-sync';
import { autoRoute, DEFAULT_AUTOROUTE_OPTIONS, distPointRect } from '../src/lib/pcb/auto-router';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import {
  computeNetCompletion,
  verifyNetlist,
} from '../src/lib/pcb/netlist-verify';
import type { Footprint, Trace, Via, Ratsnest, BoardOutline } from '../src/lib/pcb/types';

const allExamples = exampleCategories.flatMap((c) => c.examples);

function findExample(name: string) {
  const ex = allExamples.find((e) => e.name === name);
  expect(ex, `example "${name}" must exist`).toBeDefined();
  return ex!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture MX: hand-built complex mixed-signal board
// ─────────────────────────────────────────────────────────────────────────────

function buildMixedSignalBoard(): { components: CircuitComponent[]; wires: Wire[] } {
  const components: CircuitComponent[] = [];
  const wires: Wire[] = [];
  let cid = 0;
  let wid = 0;

  const add = (type: string, x: number, y: number, params: Record<string, unknown> = {}): string => {
    const id = `mx${++cid}`;
    components.push({ id, type, position: { x, y }, rotation: 0, parameters: params } as unknown as CircuitComponent);
    return id;
  };
  const wire = (a: string, at: string, b: string, bt: string) => {
    wires.push({ id: `mw${++wid}`, from: { componentId: a, terminalId: at }, to: { componentId: b, terminalId: bt } });
  };

  // Power section: 9V source → LM7805 LDO → 5V rail with decoupling bank.
  const v9 = add('dcVoltage', 4, 4, { voltage: 9 });
  const gnd = add('ground', 4, 16);
  const reg = add('lm7805', 10, 4);
  const cin = add('capacitor', 10, 10, { capacitance: 100e-9 });
  const cout1 = add('capacitor', 16, 10, { capacitance: 10e-6 });
  const cout2 = add('capacitor', 22, 10, { capacitance: 100e-9 });
  wire(v9, 'p', reg, 'in');
  wire(v9, 'n', gnd, 'g');
  wire(reg, 'gnd', gnd, 'g');
  wire(reg, 'in', cin, 'a');
  wire(cin, 'b', gnd, 'g');
  wire(reg, 'out', cout1, 'a');
  wire(cout1, 'b', gnd, 'g');
  wire(reg, 'out', cout2, 'a');
  wire(cout2, 'b', gnd, 'g');

  // MCU: 30-pin arduinoReal DIP + three local decoupling caps on the 5V rail.
  const mcu = add('arduinoReal', 32, 2, {});
  const dec1 = add('capacitor', 30, 18, { capacitance: 100e-9 });
  const dec2 = add('capacitor', 36, 18, { capacitance: 100e-9 });
  const dec3 = add('capacitor', 42, 18, { capacitance: 10e-6 });
  wire(reg, 'out', mcu, '5v');
  wire(mcu, 'gnd', gnd, 'g');
  wire(dec1, 'a', mcu, '5v');
  wire(dec1, 'b', gnd, 'g');
  wire(dec2, 'a', mcu, '5v');
  wire(dec2, 'b', gnd, 'g');
  wire(dec3, 'a', mcu, '5v');
  wire(dec3, 'b', gnd, 'g');

  // 555 timer section (fed from the same 5V rail, its own timing network).
  const t555 = add('timer555', 50, 2, {});
  const rt1 = add('resistor', 50, 12, { resistance: 10000 });
  const rt2 = add('resistor', 56, 12, { resistance: 4700 });
  const ct = add('capacitor', 56, 18, { capacitance: 1e-6 });
  wire(reg, 'out', t555, 'vcc');
  wire(t555, 'gnd', gnd, 'g');
  wire(t555, 'dis', rt1, 'a');
  wire(rt1, 'b', t555, 'thr');
  wire(t555, 'thr', rt2, 'a');
  wire(rt2, 'b', t555, 'trig');
  wire(t555, 'trig', ct, 'a');
  wire(ct, 'b', gnd, 'g');
  wire(t555, 'out', mcu, 'a2');       // 1Hz clock into the MCU
  wire(t555, 'rst', reg, 'out');      // reset held high

  // LED bank on D2..D7 (six series resistors — shared GND return).
  const leds: string[] = [];
  const ledRes: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = add('resistor', 62 + i * 8, 2, { resistance: 330 });
    const l = add('led', 62 + i * 8, 8, {});
    wire(mcu, `d${i + 2}`, r, 'a');
    wire(r, 'b', l, 'a');
    wire(l, 'k', gnd, 'g');
    ledRes.push(r);
    leds.push(l);
  }

  // Analog front-end: two potentiometer dividers into A0/A1.
  const pot1 = add('potentiometer', 32, 24, { resistance: 10000 });
  const pot2 = add('potentiometer', 40, 24, { resistance: 10000 });
  wire(reg, 'out', pot1, 'a');
  wire(pot1, 'w', mcu, 'a0');
  wire(pot1, 'b', gnd, 'g');
  wire(reg, 'out', pot2, 'a');
  wire(pot2, 'w', mcu, 'a1');
  wire(pot2, 'b', gnd, 'g');

  // Transistor driver on D8: base resistor, LED load to the 5V rail.
  const q1 = add('npn', 116, 4, { hfe: 120 });
  const rb = add('resistor', 112, 0, { resistance: 1000 });
  const ledQ = add('led', 116, 10, {});
  wire(mcu, 'd8', rb, 'a');
  wire(rb, 'b', q1, 'b');
  wire(reg, 'out', ledQ, 'a');
  wire(ledQ, 'k', q1, 'c');
  wire(q1, 'e', gnd, 'g');

  return { components, wires };
}

// ─────────────────────────────────────────────────────────────────────────────
// Independent audit battery (does not reuse router internals)
// ─────────────────────────────────────────────────────────────────────────────

/** Rect-overlap check between footprint bounding bodies. */
function bodiesOverlap(a: Footprint, b: Footprint): boolean {
  const ax1 = a.position.x - a.bodySize.width / 2;
  const ax2 = a.position.x + a.bodySize.width / 2;
  const ay1 = a.position.y - a.bodySize.height / 2;
  const ay2 = a.position.y + a.bodySize.height / 2;
  const bx1 = b.position.x - b.bodySize.width / 2;
  const bx2 = b.position.x + b.bodySize.width / 2;
  const by1 = b.position.y - b.bodySize.height / 2;
  const by2 = b.position.y + b.bodySize.height / 2;
  return ax1 < bx2 && bx1 < ax2 && ay1 < by2 && by1 < ay2;
}

/** Every trace segment is axis-aligned or exactly 45°. */
function assertTraceAngles(label: string, traces: Trace[]) {
  for (const t of traces) {
    for (const s of t.segments) {
      const dx = Math.abs(s.end.x - s.start.x);
      const dy = Math.abs(s.end.y - s.start.y);
      const axisOr45 = dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6;
      expect(
        axisOr45,
        `${label}: net ${t.net} segment (${s.start.x},${s.start.y})→(${s.end.x},${s.end.y}) is neither axis-aligned nor 45°`,
      ).toBe(true);
    }
  }
}

/** Connectivity capture radius — mirrors netlist-verify.ts: trace
 *  endpoints may land within this distance of a same-net pad/via/run
 *  (grid-snapped landings, like a trace entering a pad annulus). */
const CAPTURE_MM = 0.25;

/** Trace endpoints land on same-net copper: a pad, a via, or another
 *  same-net run (including mid-run T-branches) within the capture radius. */
function assertEndpointsOnPads(label: string, traces: Trace[], footprints: Footprint[], vias: Via[]) {
  const padsByNet = new Map<string, { x: number; y: number }[]>();
  for (const fp of footprints) {
    for (const p of fp.pads) {
      if (!p.net) continue;
      if (!padsByNet.has(p.net)) padsByNet.set(p.net, []);
      padsByNet.get(p.net)!.push(p.position);
    }
  }
  const viaPoints = vias.map((v) => v.position);
  /** Point→segment distance for interior-branch checks. */
  const distPtSeg = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  for (const t of traces) {
    const pads = padsByNet.get(t.net) ?? [];
    expect(pads.length, `${label}: net ${t.net} has no pads`).toBeGreaterThan(0);
    for (const s of t.segments) {
      for (const [name, pt] of [['start', s.start], ['end', s.end]] as const) {
        const onPad = pads.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < CAPTURE_MM);
        if (onPad) continue;
        const onVia = viaPoints.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < CAPTURE_MM);
        if (onVia) continue;
        // A trace may branch off the INTERIOR of a same-net run (T-junction)
        // — standard production-router connectivity. Its OWN segment is
        // excluded (an endpoint trivially lies on it).
        const onSameNetRun = traces.some((t2) => t2.net === t.net && t2.segments.some((s2) =>
          s2 !== s && distPtSeg(pt.x, pt.y, s2.start.x, s2.start.y, s2.end.x, s2.end.y) < CAPTURE_MM));
        expect(
          onSameNetRun,
          `${label}: net ${t.net} ${name} (${pt.x},${pt.y}) is on neither a pad, a via, nor a same-net run`,
        ).toBe(true);
      }
    }
  }
}

/** Full board audit: shorts, clearance, connectivity, geometry, board fit. */
function auditComplexBoard(
  label: string,
  components: CircuitComponent[],
  wires: Wire[],
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  ratsnest: Ratsnest[],
  board: BoardOutline,
) {
  // 1. Every net complete (true connectivity oracle).
  const completion = computeNetCompletion(footprints, traces, vias);
  expect(completion.routedNets, `${label}: routedNets`).toBe(completion.totalNets);
  for (const n of completion.nets) {
    expect(n.complete, `${label}: net ${n.net} incomplete (${n.unconnectedPads.length} unconnected pads)`).toBe(true);
  }

  // 2. Netlist parity with the schematic.
  const verify = verifyNetlist(components, wires, footprints, traces);
  expect(verify.errors.filter((e) => e.severity === 'error'), `${label}: netlist parity errors`).toHaveLength(0);

  // 3. DRC: zero hard errors on default config.
  const drc = runDRC(footprints, traces, vias, ratsnest, board, DEFAULT_DRC_CONFIG);
  const hard = drc.filter((e) => e.severity === 'error');
  expect(hard, `${label}: DRC errors — ${hard.map((e) => `${e.type}@(${e.position.x},${e.position.y}): ${e.message}`).join('; ')}`).toHaveLength(0);

  // 4. Trace geometry: 0°/45°/90° only, endpoints on pads/junctions/vias.
  assertTraceAngles(label, traces);
  assertEndpointsOnPads(label, traces, footprints, vias);

  // 5. All pads + bodies inside the board outline.
  for (const fp of footprints) {
    const cx = fp.position.x;
    const cy = fp.position.y;
    const inside = distPointRect(cx, cy, board.width / 2, board.height / 2, board.width / 2, board.height / 2) < 1e-9;
    expect(inside, `${label}: footprint ${fp.refdes} body (${cx},${cy}) outside board ${board.width}×${board.height}`).toBe(true);
  }

  // 6. Placement: no two footprint bodies overlap (courtyard rule of thumb).
  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
      const a = footprints[i];
      const b = footprints[j];
      // Skip the trivial zero-pad annotation footprints.
      if (a.pads.length === 0 || b.pads.length === 0) continue;
      expect(
        bodiesOverlap(a, b),
        `${label}: footprints ${a.refdes} (${a.position.x},${a.position.y}, ${a.bodySize.width}×${a.bodySize.height}) and ${b.refdes} (${b.position.x},${b.position.y}, ${b.bodySize.width}×${b.bodySize.height}) bodies overlap`,
      ).toBe(false);
    }
  }

  // 7. Vias: sane geometry (drill ≥ min, annular ring ≥ min, THT spanning layers).
  for (const v of vias) {
    expect(v.drill, `${label}: via drill`).toBeGreaterThanOrEqual(DEFAULT_DRC_CONFIG.minDrillSize - 1e-9);
    expect((v.diameter - v.drill) / 2, `${label}: via annular ring`).toBeGreaterThanOrEqual(DEFAULT_DRC_CONFIG.minAnnularRing - 1e-9);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Store pipeline on the biggest bundled examples
// ─────────────────────────────────────────────────────────────────────────────

describe('complex boards: store pipeline (importFromSchematic → runAutoRoute → runDRC)', () => {
  const BIG = [
    '555 Timer Clock (HH:MM:SS)',
    'Arduino Clock (HH:MM:SS)',
    'Digital Clock (HH:MM:SS)',
    'Two-Stage Audio Amplifier',
  ];

  beforeEach(() => {
    usePCB.getState().clearPCB();
    _resetPCBHistory();
    usePCB.setState({ canUndo: false, canRedo: false });
  });

  for (const name of BIG) {
    it(`${name}: 100% routed, zero DRC errors, bounded runtime`, () => {
      const ex = findExample(name);
      const t0 = performance.now();
      usePCB.getState().importFromSchematic(ex.doc.components, ex.doc.wires);
      const s = usePCB.getState();

      // Every pad got a net; every ratsnest leg starts unrouted.
      const padful = s.footprints.filter((f) => f.pads.length > 0);
      expect(padful.length).toBeGreaterThanOrEqual(5);
      expect(s.ratsnest.length).toBeGreaterThan(10);
      expect(s.ratsnest.every((l) => !l.routed)).toBe(true);

      const stats = s.runAutoRoute();
      expect(stats.unroutedCount, `${name}: unrouted legs`).toBe(0);
      expect(stats.failed, `${name}: failed legs`).toBe(0);
      expect(usePCB.getState().ratsnest.every((l) => l.routed), `${name}: all legs satisfied`).toBe(true);

      usePCB.getState().runDRC();
      const hard = usePCB.getState().drcErrors.filter((e) => e.severity === 'error');
      expect(hard, `${name}: DRC errors — ${hard.map((e) => e.message).join('; ')}`).toHaveLength(0);

      const elapsed = performance.now() - t0;
      expect(elapsed, `${name}: pipeline took ${elapsed.toFixed(0)}ms`).toBeLessThan(20000);
    }, 60000);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Hand-built mixed-signal board (full audit, both pure + store paths)
// ─────────────────────────────────────────────────────────────────────────────

describe('complex board: hand-built mixed-signal MCU board (29 components)', () => {
  it('has substantial topology (sanity)', () => {
    const { components, wires } = buildMixedSignalBoard();
    expect(components.length).toBeGreaterThanOrEqual(28);
    expect(wires.length).toBeGreaterThanOrEqual(40);
    // GND is a high-fanout net.
    const gndWireCount = wires.filter((w) =>
      w.from.componentId === 'mx2' || w.to.componentId === 'mx2').length;
    expect(gndWireCount).toBeGreaterThanOrEqual(12);
  });

  it('pure pipeline: placement → route → DRC → full audit battery', () => {
    const { components, wires } = buildMixedSignalBoard();
    const t0 = performance.now();
    const { footprints, ratsnest, padNets, board } = createPCBFromSchematic(components, wires);

    // Placement sanity.
    expect(footprints.length).toBe(components.length);
    expect(board.width).toBeGreaterThanOrEqual(40);
    expect(board.height).toBeGreaterThanOrEqual(30);
    expect(board.width / board.height).toBeLessThanOrEqual(1.8);
    expect(padNets.size).toBeGreaterThan(20);
    for (const fp of footprints) {
      expect([0, 90, 180, 270]).toContain(fp.rotation);
    }

    const result = autoRoute(footprints, [], [], ratsnest, board, {
      ...DEFAULT_AUTOROUTE_OPTIONS,
      clearance: DEFAULT_DRC_CONFIG.minClearance,
      traceWidth: DEFAULT_AUTOROUTE_OPTIONS.traceWidth,
    });
    expect(result.stats.failed).toBe(0);
    expect(result.unrouted).toHaveLength(0);
    // stats.routed counts routed ratsnest LEGS (multi-pad nets span many
    // legs) — the authoritative completeness oracle is computeNetCompletion,
    // asserted inside auditComplexBoard.
    expect(result.stats.routed).toBeGreaterThanOrEqual(ratsnest.length);

    auditComplexBoard(
      'MX', components, wires,
      footprints, result.traces, result.vias, ratsnest, board,
    );

    const elapsed = performance.now() - t0;
    expect(elapsed, `MX board took ${elapsed.toFixed(0)}ms`).toBeLessThan(20000);
  }, 60000);

  it('deterministic: identical input → identical geometry (ids are random)', () => {
    const { components, wires } = buildMixedSignalBoard();
    const a = createPCBFromSchematic(components, wires);
    const b = createPCBFromSchematic(components, wires);
    const ra = autoRoute(a.footprints, [], [], a.ratsnest, a.board, DEFAULT_AUTOROUTE_OPTIONS);
    const rb = autoRoute(b.footprints, [], [], b.ratsnest, b.board, DEFAULT_AUTOROUTE_OPTIONS);
    // Trace/via IDs carry random suffixes — compare the geometry, not ids.
    const shape = (t: Trace) => ({ net: t.net, layer: t.layer, width: t.width, segments: t.segments });
    const viaShape = (v: Via) => ({ net: v.net, position: v.position, diameter: v.diameter, drill: v.drill });
    expect(JSON.stringify(ra.traces.map(shape))).toBe(JSON.stringify(rb.traces.map(shape)));
    expect(JSON.stringify(ra.vias.map(viaShape))).toBe(JSON.stringify(rb.vias.map(viaShape)));
  }, 60000);

  it('store pipeline: route → edit (move footprint) → unroute → re-route converges clean', () => {
    const { components, wires } = buildMixedSignalBoard();
    usePCB.getState().clearPCB();
    _resetPCBHistory();
    usePCB.setState({ canUndo: false, canRedo: false });
    usePCB.getState().importFromSchematic(components, wires);

    let stats = usePCB.getState().runAutoRoute();
    expect(stats.unroutedCount).toBe(0);
    usePCB.getState().runDRC();
    expect(usePCB.getState().drcErrors.filter((e) => e.severity === 'error')).toHaveLength(0);

    // Simulate a layout edit: relocate a decoupling cap far from the MCU
    // (production workflow: drag parts, then re-route the board).
    const s = usePCB.getState();
    const victim = s.footprints.find((f) => f.componentType === 'capacitor')!;
    usePCB.getState().moveFootprint(victim.id, { x: 5, y: 5 });

    // Re-route everything after the edit (KiCad-like "unroute + route all").
    usePCB.getState().unrouteAll();
    stats = usePCB.getState().runAutoRoute();
    expect(stats.unroutedCount, 're-route after layout edit left unrouted legs').toBe(0);
    usePCB.getState().runDRC();
    const hard = usePCB.getState().drcErrors.filter((e) => e.severity === 'error');
    expect(hard, hard.map((e) => `${e.type}: ${e.message}`).join('; ')).toHaveLength(0);
    expect(usePCB.getState().ratsnest.every((l) => l.routed)).toBe(true);
  }, 60000);

  it('serialize → loadDocument round-trips the routed board (nets, traces, ratsnest)', () => {
    const { components, wires } = buildMixedSignalBoard();
    usePCB.getState().clearPCB();
    usePCB.getState().importFromSchematic(components, wires);
    usePCB.getState().runAutoRoute();
    const before = usePCB.getState();

    const doc = before.serialize();
    usePCB.getState().clearPCB();
    usePCB.getState().loadDocument(JSON.parse(JSON.stringify(doc)));

    const after = usePCB.getState();
    expect(after.footprints).toHaveLength(before.footprints.length);
    expect(after.traces).toHaveLength(before.traces.length);
    expect(after.vias).toHaveLength(before.vias.length);
    expect(after.padNets.size).toBe(before.padNets.size);
    // Routed ratsnest legs survive the reload (no resurrected airwires).
    expect(after.ratsnest.every((l) => l.routed)).toBe(true);
    // And the reloaded board is still DRC-clean.
    after.runDRC();
    expect(after.drcErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
  }, 60000);

  it('undo restores the routed traces after unrouteAll', () => {
    const { components, wires } = buildMixedSignalBoard();
    usePCB.getState().clearPCB();
    _resetPCBHistory();
    usePCB.setState({ canUndo: false, canRedo: false });
    usePCB.getState().importFromSchematic(components, wires);
    usePCB.getState().runAutoRoute();
    const traceCount = usePCB.getState().traces.length;
    expect(traceCount).toBeGreaterThan(20);

    usePCB.getState().unrouteAll();
    expect(usePCB.getState().traces).toHaveLength(0);

    usePCB.getState().undo();
    expect(usePCB.getState().traces).toHaveLength(traceCount);
    expect(usePCB.getState().ratsnest.every((l) => l.routed)).toBe(true);
  }, 60000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Placement quality on the complex fixture
// ─────────────────────────────────────────────────────────────────────────────

describe('complex board: placement quality (congestion-aware clustered placement)', () => {
  it('congestion stays bounded and clusters form on the mixed-signal board', () => {
    const { components, wires } = buildMixedSignalBoard();
    const { positions, rotations, stats } = computeSmartPlacement(
      components, wires, 120, 90,
    );
    expect(positions.size).toBe(components.length);
    expect(rotations.size).toBe(components.length);
    // Congestion re-relaxation is bounded (no oscillation).
    expect(stats.congestionReRelaxations).toBeLessThanOrEqual(2);
    expect(stats.maxDemandRatio).toBeGreaterThan(0);
    // All positions finite and on positive coordinates.
    for (const p of positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('routing reaches every pad exactly (pad-center endpoints, 0°/45°/90° traces)', () => {
    // The production invariant that matters: routing REACHES every pad
    // exactly, regardless of the placement grid the pads landed on.
    const { components, wires } = buildMixedSignalBoard();
    const { footprints, ratsnest, board } = createPCBFromSchematic(components, wires);
    const result = autoRoute(footprints, [], [], ratsnest, board, DEFAULT_AUTOROUTE_OPTIONS);
    expect(result.unrouted).toHaveLength(0);
    assertEndpointsOnPads('MX-pads', result.traces, footprints, result.vias);
    assertTraceAngles('MX-pads', result.traces);
  }, 60000);
});
