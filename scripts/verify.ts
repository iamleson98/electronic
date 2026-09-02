/**
 * VERIFICATION SUITE (run with: bun scripts/verify.ts)
 *
 * Proves, numerically, for every example:
 *   1. STRICT orthogonality — every wire segment is purely horizontal or
 *      purely vertical ("straight like Ox, OY"), snapped, jog-free.
 *   2. Every flow-edge polyline lies exactly ON its parent wire's path
 *      (i.e., animated current dots ride the real wire geometry).
 *   3. KCL: at every anchor, injections == flow out (residual ~ 0).
 *   4. Solver sanity: known DC solutions (divider 8 V / 4 mA),
 *      R current = V/R, RC step matches analytic, RL ramp matches analytic.
 *   5. All voltages/currents finite over 4000 steps.
 */

import { EXAMPLES, cloneCircuit } from '../src/lib/circuit/examples';
import { isPerfectlyOrtho } from '../src/lib/circuit/normalizer';
import { buildNets } from '../src/lib/circuit/nets';
import { Solver, R_SW_CLOSED, R_LED_ON, type ElemState } from '../src/lib/circuit/solver';
import { solveFlows } from '../src/lib/circuit/flow';
import { CircuitEngine, DT } from '../src/lib/circuit/engine';
import { onSegment, distToPolyline } from '../src/lib/circuit/geometry';
import { terminals, key } from '../src/lib/circuit/types';
import type { Circuit, Elem } from '../src/lib/circuit/types';

let failures = 0;
const fail = (msg: string) => { failures++; console.error(`  ✗ ${msg}`); };
const pass = (msg: string) => console.log(`  ✓ ${msg}`);
const ok = (cond: boolean, msg: string) => (cond ? pass(msg) : fail(msg));

/* ---------------- unit circuits ---------------- */

function mkCircuit(elems: Elem[], wires: [number, number][][]): Circuit {
  let i = 0;
  return {
    name: 'unit',
    elems: elems.map((e) => ({ ...e, id: `u${i++}` })),
    wires: wires.map((pts) => ({ id: `uw${i++}`, pts: pts.map(([x, y]) => ({ x, y })) })),
  };
}

console.log('\n=== 1. ORTHOGONALITY OF EXAMPLES (Ox/OY) ===');
for (const ex of EXAMPLES) {
  const c = cloneCircuit(ex);
  const engine = new CircuitEngine(c);
  const label = engine.circuit.name;
  let bad = 0;
  for (const w of engine.circuit.wires) {
    if (!isPerfectlyOrtho(w.pts)) bad++;
  }
  ok(bad === 0, `${label}: all ${engine.circuit.wires.length} wires strictly orthogonal, snapped, jog-free`);
  for (const w of engine.circuit.wires) {
    for (const p of w.pts) {
      if (p.x % 20 !== 0 || p.y % 20 !== 0) fail(`${label}: point off-grid in ${w.id}`);
    }
  }
}

console.log('\n=== 2. FLOW EDGES LIE EXACTLY ON WIRES ===');
for (const ex of EXAMPLES) {
  const c = cloneCircuit(ex);
  const engine = new CircuitEngine(c);
  const label = engine.circuit.name;
  engine.advance(50);
  let worst = 0;
  for (const e of engine.nets.edges) {
    const wire = engine.circuit.wires.find((w) => w.id === e.wireId)!;
    for (const p of e.poly) {
      worst = Math.max(worst, distToPolyline(p, wire.pts));
      void onSegment;
    }
    // edge polylines must also be strictly orthogonal
    if (!isPerfectlyOrtho(e.poly)) fail(`${label}: edge ${e.id} polyline not orthogonal`);
  }
  ok(worst < 1e-6, `${label}: all ${engine.nets.edges.length} flow segments lie on wire paths (max deviation ${worst.toExponential(1)})`);
}

console.log('\n=== 3. KCL AT ANCHORS (injections vs solved flows) ===');
for (const ex of EXAMPLES) {
  const c = cloneCircuit(ex);
  const engine = new CircuitEngine(c);
  const label = engine.circuit.name;
  engine.advance(200);
  let worst = 0;
  for (const net of engine.nets.nets) {
    // per-anchor: injections - net outflow of edge flows must be ~0
    for (const a of net.anchors) {
      const inj = engineInjections(engine).get(a) ?? 0;
      let out = 0;
      for (const e of net.edges) {
        if (e.u === a) out += e.f;
        if (e.v === a) out -= e.f;
      }
      worst = Math.max(worst, Math.abs(inj - out));
    }
  }
  ok(worst < 1e-7, `${label}: KCL residual over all anchors = ${worst.toExponential(1)} A`);
  ok(engine.lastFlowResidual < 1e-7, `${label}: flow solver root residual = ${engine.lastFlowResidual.toExponential(1)} A`);
}

function engineInjections(engine: CircuitEngine): Map<string, number> {
  const inj = new Map<string, number>();
  for (const el of engine.circuit.elems) {
    const r = engine.readings.get(el.id);
    if (!r) continue;
    for (const t of terminals(el)) {
      const out = t.name === 'p' ? r.i : t.name === 'm' ? r.im : r.i;
      const k = key(t.pt);
      inj.set(k, (inj.get(k) ?? 0) - out);
    }
  }
  return inj;
}

console.log('\n=== 4. SOLVER UNIT TESTS ===');

// 4a. battery + resistor loop: I = V/R
{
  const c = mkCircuit(
    [ { kind: 'battery', x: 0, y: 0, rot: 90, value: 10, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'resistor', x: 120, y: -80, rot: 0, value: 5, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined } ],
    []
  );
  c.wires = [
    { id: 'w1', pts: [{ x: 0, y: -40 }, { x: 0, y: -80 }, { x: 80, y: -80 }] },
    { id: 'w2', pts: [{ x: 160, y: -80 }, { x: 160, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 40 }] },
  ];
  const nets = buildNets(c);
  const solver = new Solver(nets, c.elems);
  const state = new Map<string, ElemState>();
  for (const e of c.elems) state.set(e.id, { vOld: 0, iOld: 0, ledOn: false });
  const res = solver.step(0, DT, state);
  const r = res.readings.get(c.elems[0].id)!;
  ok(Math.abs(r.i + 2) < 1e-6, `battery 10V + R 5Ω -> I = ${(-r.i).toFixed(6)} A (expect 2, flowing out of +; leak ~nA)`);
  const rr = res.readings.get(c.elems[1].id)!;
  ok(Math.abs(rr.v - 10) < 1e-9, `resistor V = ${rr.v.toFixed(6)} V (expect 10)`);
}

// 4b. RC charging vs analytic exponential (backward Euler)
{
  const Rv = 1000, C = 1e-3, V0 = 10; // tau = 1 s
  const c = mkCircuit(
    [ { kind: 'battery', x: 0, y: 0, rot: 90, value: V0, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'resistor', x: 100, y: -80, rot: 0, value: Rv, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'capacitor', x: 200, y: 0, rot: 90, value: C, id: '', freq: undefined, closed: undefined, vInit: 0, iInit: undefined, label: undefined } ],
    []
  );
  c.wires = [
    { id: 'w1', pts: [{ x: 0, y: -40 }, { x: 0, y: -80 }, { x: 60, y: -80 }] },
    { id: 'w2', pts: [{ x: 140, y: -80 }, { x: 200, y: -80 }, { x: 200, y: -40 }] },
    { id: 'w3', pts: [{ x: 200, y: 40 }, { x: 200, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 40 }] },
  ];
  const engine = new CircuitEngine(c);
  const steps = Math.round(0.5 / DT); // 0.5 s = 0.5 tau
  engine.advance(steps);
  const vCap = engine.readings.get(c.elems[2].id)!.v;
  const expect = V0 * (1 - Math.exp(-0.5));
  ok(Math.abs(vCap - expect) < 0.02, `RC @ 0.5τ: vC = ${vCap.toFixed(4)} V (analytic ${expect.toFixed(4)})`);
}

// 4c. RL ramp: i(t) = V/R (1 - e^-tR/L)
{
  const Rv = 10, L = 0.5, V0 = 10; // tau = 0.05 s
  const c = mkCircuit(
    [ { kind: 'battery', x: 0, y: 0, rot: 90, value: V0, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'resistor', x: 100, y: -80, rot: 0, value: Rv, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'inductor', x: 200, y: 0, rot: 90, value: L, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: 0, label: undefined } ],
    []
  );
  c.wires = [
    { id: 'w1', pts: [{ x: 0, y: -40 }, { x: 0, y: -80 }, { x: 60, y: -80 }] },
    { id: 'w2', pts: [{ x: 140, y: -80 }, { x: 200, y: -80 }, { x: 200, y: -40 }] },
    { id: 'w3', pts: [{ x: 200, y: 40 }, { x: 200, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 40 }] },
  ];
  const engine = new CircuitEngine(c);
  engine.advance(Math.round(0.1 / DT)); // 2 tau
  const iL = engine.readings.get(c.elems[2].id)!.i;
  const expect = (V0 / Rv) * (1 - Math.exp(-2));
  ok(Math.abs(iL - expect) < 0.05, `RL @ 2τ: iL = ${iL.toFixed(4)} A (analytic ${expect.toFixed(4)})`);
}

// 4d. LED forward model: 5V, 220Ω, Vf 2 -> I = (5-2)/220
{
  const c = mkCircuit(
    [ { kind: 'battery', x: 0, y: 0, rot: 90, value: 5, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'resistor', x: 100, y: -80, rot: 0, value: 220, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'led', x: 200, y: 0, rot: 90, value: 2.0, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined } ],
    []
  );
  c.wires = [
    { id: 'w1', pts: [{ x: 0, y: -40 }, { x: 0, y: -80 }, { x: 60, y: -80 }] },
    { id: 'w2', pts: [{ x: 140, y: -80 }, { x: 200, y: -80 }, { x: 200, y: -40 }] },
    { id: 'w3', pts: [{ x: 200, y: 40 }, { x: 200, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 40 }] },
  ];
  const engine = new CircuitEngine(c);
  engine.advance(5);
  const iL = Math.abs(engine.readings.get(c.elems[2].id)!.i);
  const expect = (5 - 2) / (220 + R_LED_ON);
  ok(Math.abs(iL - expect) < 1e-6, `LED current = ${iL.toExponential(3)} A (expect ${expect.toExponential(3)})`);
}

// 4e. switch open -> ~zero current
{
  const c = mkCircuit(
    [ { kind: 'battery', x: 0, y: 0, rot: 90, value: 9, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'switch', x: 100, y: -80, rot: 0, value: 0, id: '', freq: undefined, closed: false, vInit: undefined, iInit: undefined, label: undefined },
      { kind: 'resistor', x: 240, y: 0, rot: 90, value: 100, id: '', freq: undefined, closed: undefined, vInit: undefined, iInit: undefined, label: undefined } ],
    []
  );
  c.wires = [
    { id: 'w1', pts: [{ x: 0, y: -40 }, { x: 0, y: -80 }, { x: 60, y: -80 }] },
    { id: 'w2', pts: [{ x: 140, y: -80 }, { x: 240, y: -80 }, { x: 240, y: -40 }] },
    { id: 'w3', pts: [{ x: 240, y: 40 }, { x: 240, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 40 }] },
  ];
  const engine = new CircuitEngine(c);
  engine.advance(3);
  const i = Math.abs(engine.readings.get(c.elems[0].id)!.i);
  ok(i < 1e-6, `open switch blocks: I = ${i.toExponential(2)} A`);
}

console.log('\n=== 5. VOLTAGE DIVIDER KNOWN VALUES ===');
{
  const c = cloneCircuit(EXAMPLES[0]);
  const engine = new CircuitEngine(c);
  engine.advance(10);
  const bat = engine.readings.get(c.elems[0].id)!;
  const r2 = engine.readings.get(c.elems[2].id)!;
  ok(Math.abs(-bat.i - 0.004) < 1e-6, `battery current = ${(-bat.i).toFixed(6)} A (expect 0.004)`);
  ok(Math.abs(r2.v - 8) < 1e-4, `R2 voltage = ${r2.v.toFixed(6)} V (expect 8)`);
  // R1 bottom terminal anchor (120,0) should read 8 V
  ok(Math.abs(engine.netVoltageAt({ x: 120, y: 0 }) - 8) < 1e-3, `junction (120,0) = ${engine.netVoltageAt({ x: 120, y: 0 }).toFixed(3)} V (expect 8)`);
  ok(Math.abs(engine.netVoltageAt({ x: 0, y: 80 }) - 0) < 1e-6, `ground rail = ${engine.netVoltageAt({ x: 0, y: 80 }).toFixed(4)} V (expect 0)`);
}

console.log('\n=== 6. PARALLEL EXAMPLE: CURRENT SPLIT AT TAPS ===');
{
  const c = cloneCircuit(EXAMPLES[3]);
  const engine = new CircuitEngine(c);
  engine.advance(10);
  const bat = engine.readings.get(c.elems[0].id)!;
  ok(Math.abs(-bat.i - 1.2) < 1e-6, `battery current = ${(-bat.i).toFixed(4)} A (expect 1.2)`);
  // top rail: first edge from battery+ (-180,-40) to first tap (-60,-80) carries 1.2 A; then 0.8, then 0.4
  const segs = engine.nets.edges.filter((e) => e.wireId === c.wires[0].id);
  const f1 = segs.find((e) => e.u === '-180,-40' && e.v === '-60,-80');
  const f2 = segs.find((e) => e.u === '-60,-80' && e.v === '40,-80');
  const f3 = segs.find((e) => e.u === '40,-80' && e.v === '140,-80');
  ok(!!f1 && Math.abs(f1.f - 1.2) < 1e-6, `rail seg1 = ${f1 ? f1.f.toFixed(4) : '?'} A (expect +1.2 toward taps)`);
  ok(!!f2 && Math.abs(f2.f - 0.8) < 1e-6, `rail seg2 = ${f2 ? f2.f.toFixed(4) : '?'} A (expect +0.8)`);
  ok(!!f3 && Math.abs(f3.f - 0.4) < 1e-6, `rail seg3 = ${f3 ? f3.f.toFixed(4) : '?'} A (expect +0.4)`);
}

console.log('\n=== 7. LONG RUN STABILITY + JUNCTION COUNTS ===');
for (const ex of EXAMPLES) {
  const c = cloneCircuit(ex);
  const engine = new CircuitEngine(c);
  const label = engine.circuit.name;
  engine.advance(4000);
  let maxV = 0, maxI = 0, bad = false;
  for (const net of engine.nets.nets) maxV = Math.max(maxV, Math.abs(net.v));
  for (const e of engine.nets.edges) maxI = Math.max(maxI, Math.abs(e.f));
  for (const v of [maxV, maxI]) if (!isFinite(v)) bad = true;
  ok(!bad && maxV < 1e4 && maxI < 1e5, `${label}: 4000 steps stable (maxV ${maxV.toFixed(2)} V, maxI ${maxI.toExponential(2)} A)`);
}

console.log('\n=== 8. TAP SPLITTING (T-junctions become separate segments) ===');
{
  const c = cloneCircuit(EXAMPLES[3]);
  const engine = new CircuitEngine(c);
  const topRail = engine.circuit.wires[0];
  const segs = engine.nets.edges.filter((e) => e.wireId === topRail.id);
  ok(segs.length === 3, `top rail split into ${segs.length} segments (expect 3: two taps + endpoints)`);
  const junctions = engine.nets.junctions;
  ok(junctions.length === 4, `${junctions.length} junction dots (expect 4 T-taps)`);
}

/* ---------------- verdict ---------------- */
console.log('\n────────────────────────────────');
if (failures === 0) {
  console.log('ALL CHECKS PASSED ✓');
} else {
  console.log(`${failures} FAILURE(S) ✗`);
  process.exit(1);
}
