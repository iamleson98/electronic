// Falstad-class example library verification.
//
// Every example in examples.ts's categories (the retained classics + the
// examples-complex.ts library) must:
//   1. pass structural checks (unique wire ids, plugins resolve, buildNodeMap
//      yields > 1 node, every wire endpoint resolves to a real node),
//   2. survive a transient run (no singular matrix, all voltages finite),
//   3. pass the physics validator,
// and the 25 complex examples get PER-CIRCUIT BEHAVIORAL assertions:
// oscillation frequencies, amplifier gain/clipping, regulator voltages,
// digital state sequences, truth tables, and CURRENT FLOW (KCL splits,
// wire currents). This is the "run simulation for each example and verify
// it works right, current flow works right" gate.
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap, computeWireCurrents, computeComponentCurrents, solveDC } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { exampleCategories, examples } from '../src/lib/circuit/examples';
import { rawComplexExamples } from '../src/lib/circuit/examples-complex';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import type { CircuitComponent, CircuitDocument, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');
  await import('../src/lib/circuit/components/p1-logic');
});

function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const m = new Map<string, ComponentPlugin>();
  for (const c of components) { const p = getPlugin(c.type); if (p) m.set(c.type, p); }
  return m;
}

function cloneDoc(raw: unknown): CircuitDocument {
  return JSON.parse(JSON.stringify(raw)) as CircuitDocument;
}

interface Hist { nv: Float64Array; bc: Float64Array; time: number; state: Record<string, unknown> }
interface Run {
  hist: Hist[]; failAt: number; nodeMap: ReturnType<typeof buildNodeMap>;
  plugins: Map<string, ComponentPlugin>; components: CircuitComponent[]; wires: Wire[];
}

function runTran(doc: CircuitDocument, steps: number, dt: number, method: 'euler' | 'trap' | 'gear' = 'euler'): Run {
  const plugins = pluginsFor(doc.components);
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
  for (const c of doc.components) if (!c.simState) c.simState = {};
  let prev: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: Record<string, unknown> } | undefined;
  const hist: Hist[] = [];
  let failAt = -1;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, dt, { method });
    if (!r) { failAt = i; break; }
    hist.push({ nv: Float64Array.from(r.sim.nodeVoltage), bc: Float64Array.from(r.sim.branchCurrent), time: r.sim.time, state: r.sim.state });
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return { hist, failAt, nodeMap, plugins, components: doc.components, wires: doc.wires };
}

function V(run: Run, i: number, id: string, t: string): number {
  const n = run.nodeMap.terminalNode.get(`${id}:${t}`);
  return n === undefined ? NaN : run.hist[i].nv[n];
}
function arr(run: Run, id: string, t: string, from = 0): number[] {
  return run.hist.slice(from).map((_, i) => V(run, from + i, id, t));
}
function maxAbs(run: Run, from = 0): number {
  let m = 0;
  for (let i = from; i < run.hist.length; i++) for (const v of run.hist[i].nv) if (Math.abs(v) > m) m = Math.abs(v);
  return m;
}
function finite(run: Run): boolean {
  for (const s of run.hist) for (const v of s.nv) if (!Number.isFinite(v)) return false;
  return true;
}
function freqOf(a: number[], dt: number, minAmp: number): number {
  if (!a || a.length < 10) return 0;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const c = a.map(v => v - mean);
  const amp = Math.max(...c.map(Math.abs));
  if (amp < minAmp) return 0;
  const zc: number[] = [];
  let armed = true;
  for (let i = 1; i < c.length; i++) {
    if (armed && c[i - 1] <= 0 && c[i] > 0) { zc.push(i); armed = false; }
    if (c[i] < -0.25 * amp) armed = true;
  }
  if (zc.length < 3) return 0;
  const p: number[] = [];
  for (let i = 1; i < zc.length; i++) p.push((zc[i] - zc[i - 1]) * dt);
  return 1 / (p.reduce((x, y) => x + y, 0) / p.length);
}

// ═══ Part 1: structural + transient + physics for EVERY category example ═══
describe('every example: structure + transient + physics', () => {
  // Circuits needing longer runs to show activity, by name (everything else
  // gets 60 steps which suffices to catch wiring/singularity issues).
  const slowOnes = new Set(['Arduino Blink', '7-Segment Counter', 'Simple Seconds Counter', 'Arduino Clock (MM:SS)', 'Arduino Clock (HH:MM:SS)', '555 Timer Clock (HH:MM:SS)', 'Digital Clock (HH:MM:SS)']);

  for (const ex of examples) {
    it(`${ex.name}: loads, solves, stays finite, passes physics`, () => {
      // structural
      const wireIds = new Set(ex.doc.wires.map(w => w.id));
      expect(ex.doc.wires.length, 'wire count').toBeGreaterThan(0);
      expect(ex.doc.wires.length).toBe(wireIds.size); // unique ids
      for (const c of ex.doc.components) {
        expect(getPlugin(c.type), `plugin for ${c.type} (${c.id})`).toBeTruthy();
      }
      const plugins = pluginsFor(ex.doc.components);
      const nodeMap = buildNodeMap(ex.doc.components, ex.doc.wires, plugins);
      expect(nodeMap.numNodes, 'more than just ground').toBeGreaterThan(1);
      // every wire endpoint resolves to a real node
      for (const w of ex.doc.wires) {
        const a = nodeMap.terminalNode.get(`${w.from.componentId}:${w.from.terminalId}`);
        const b = nodeMap.terminalNode.get(`${w.to.componentId}:${w.to.terminalId}`);
        expect(a, `wire ${w.id} from-node`).toBeDefined();
        expect(b, `wire ${w.id} to-node`).toBeDefined();
      }
      // has a ground reference (else the solve would be floating)
      const hasGround = [...nodeMap.terminalNode.values()].some(n => n === 0);
      expect(hasGround, 'ground reference').toBe(true);

      // transient
      const steps = slowOnes.has(ex.name) ? 250 : 60;
      const run = runTran(cloneDoc(ex.doc), steps, 1e-4);
      expect(run.failAt, `singular at step ${run.failAt}`).toBeLessThan(0);
      expect(run.hist.length, 'completed steps').toBe(steps);
      expect(finite(run), 'all voltages finite').toBe(true);
      expect(maxAbs(run), 'bounded voltages').toBeLessThan(1e6);

      // physics validator on the final state
      const last = run.hist[run.hist.length - 1];
      const sim = {
        nodeVoltage: last.nv, branchCurrent: last.bc, state: last.state,
        numNodes: run.nodeMap.numNodes, time: last.time, dt: 1e-4,
        method: 'euler' as const, temp: 27, netNames: run.nodeMap.netNames,
      };
      const result = validatePhysics(run.components, run.wires, run.plugins, sim);
      const fatal = result.violations.filter(v => v.severity === 'error');
      expect(fatal, `physics errors: ${fatal.map(v => v.message).join('; ')}`).toHaveLength(0);
    });
  }
});

// ═══ Part 2: behavioral verification of the complex library ═══
describe('complex examples: behavioral verification', () => {

  it('ceAmplifier: DC bias in the active region + amplified output', () => {
    const doc = cloneDoc(rawComplexExamples.ceAmplifier);
    const plugins = pluginsFor(doc.components);
    const dc = solveDC(doc.components, doc.wires, plugins, 60);
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(doc.components, doc.wires, plugins);
    const D = (id: string, t: string) => dc!.nodeVoltage[nm.terminalNode.get(`${id}:${t}`)!];
    expect(Math.abs(D('q1', 'b') - 1.35)).toBeLessThan(0.35);
    expect(D('q1', 'e')).toBeGreaterThan(0.3);
    expect(D('q1', 'c')).toBeGreaterThan(4);
    expect(D('q1', 'c')).toBeLessThan(8);
    const run = runTran(cloneDoc(rawComplexExamples.ceAmplifier), 6000, 2e-5);
    expect(run.failAt).toBeLessThan(0);
    const vOut = arr(run, 'rload', 'a', 3000);
    const swing = Math.max(...vOut) - Math.min(...vOut);
    expect(swing).toBeGreaterThan(0.2);
    expect(maxAbs(run)).toBeLessThan(15);
  });

  it('pushPull: dead-zone clipping at ~2.3V peak, 200Hz', () => {
    const run = runTran(cloneDoc(rawComplexExamples.pushPull), 4000, 2e-5);
    expect(run.failAt).toBeLessThan(0);
    const vl = arr(run, 'rl', 'a', 1000);
    const vpeak = Math.max(...vl.map(Math.abs));
    expect(vpeak).toBeGreaterThan(1.5);
    expect(vpeak).toBeLessThan(3.5);
    expect(Math.abs(freqOf(vl, 2e-5, 0.5) - 200)).toBeLessThan(10);
  });

  it('phaseShiftOscillator: self-starts and sustains', () => {
    const run = runTran(cloneDoc(rawComplexExamples.phaseShiftOscillator), 60000, 5e-5);
    expect(run.failAt).toBeLessThan(0);
    const vc = arr(run, 'q1', 'c', 30000);
    const f = freqOf(vc, 5e-5, 0.05);
    expect(f).toBeGreaterThan(150);
    expect(f).toBeLessThan(900);
    expect(Math.max(...vc) - Math.min(...vc)).toBeGreaterThan(0.5);
  });

  it('currentMirror: mirrors Iref into the load (ammeter branch current)', () => {
    const run = runTran(cloneDoc(rawComplexExamples.currentMirror), 50, 1e-4);
    expect(run.failAt).toBeLessThan(0);
    const last = run.hist.length - 1;
    const vq2c = V(run, last, 'q2', 'c');
    const sim: SimContext = {
      nodeVoltage: run.hist[last].nv, branchCurrent: run.hist[last].bc, state: run.hist[last].state,
      numNodes: run.nodeMap.numNodes, time: 0, dt: 1e-4, method: 'euler', temp: 27, netNames: run.nodeMap.netNames,
    };
    const iMirror = Math.abs(computeComponentCurrents(run.components, run.wires, run.plugins, sim).get('am1') ?? 0);
    const iRef = (9 - 0.7) / 10000;
    expect(Math.abs(iMirror - iRef)).toBeLessThan(0.0002);
    expect(vq2c).toBeGreaterThan(3.5);
    expect(vq2c).toBeLessThan(6.5);
  });

  it('emitterFollower: Vout = Vin − 0.7 at 1kHz', () => {
    const run = runTran(cloneDoc(rawComplexExamples.emitterFollower), 2000, 5e-5);
    expect(run.failAt).toBeLessThan(0);
    const vin = arr(run, 'vin', 'p', 500);
    const vout = arr(run, 'q1', 'e', 500);
    const err = Math.max(...vin.map((v, i) => Math.abs(v - vout[i] - 0.7)));
    expect(err).toBeLessThan(0.05);
    expect(Math.abs(freqOf(vout, 5e-5, 0.5) - 1000)).toBeLessThan(50);
  });

  it('relayFlyback: contact closes on coil current, flyback clamps the switch node', () => {
    const run1 = runTran(cloneDoc(rawComplexExamples.relayFlyback), 600, 1e-4);
    expect(run1.failAt).toBeLessThan(0);
    const lampOn = Math.max(...run1.hist.slice(100).map(h => {
      const a = run1.nodeMap.terminalNode.get('rlamp:a')!;
      const b = run1.nodeMap.terminalNode.get('rlamp:b')!;
      return Math.abs(h.nv[a] - h.nv[b]);
    }));
    expect(lampOn).toBeGreaterThan(6); // ~10V across the lamp resistor when contact closed
    // open the switch → coil de-energizes (current decays through the diode), contact opens
    const comps = run1.components.map(c => ({ ...c, parameters: { ...c.parameters } }));
    comps.find(c => c.id === 'sw1')!.parameters.closed = false;
    const run2 = runTran({ version: 1, components: comps, wires: run1.wires } as CircuitDocument, 1500, 1e-4);
    expect(run2.failAt).toBeLessThan(0);
    const swNode = run2.nodeMap.terminalNode.get('sw1:b')!;
    const vSwAfter = Math.max(...run2.hist.slice(50).map(h => Math.abs(h.nv[swNode])));
    const lampAfter = Math.max(...run2.hist.slice(100).map(h => {
      const a = run2.nodeMap.terminalNode.get('rlamp:a')!;
      const b = run2.nodeMap.terminalNode.get('rlamp:b')!;
      return Math.abs(h.nv[a] - h.nv[b]);
    }));
    expect(vSwAfter).toBeLessThan(2.5); // diode clamp, no kilovolt spike
    expect(lampAfter).toBeLessThan(0.5); // contact open → no lamp current
  });

  it('opampIntegrator: triangle wave from square, 500Hz, slope ≈ 1000V/s', () => {
    const run = runTran(cloneDoc(rawComplexExamples.opampIntegrator), 3000, 2e-5);
    expect(run.failAt).toBeLessThan(0);
    const vout = arr(run, 'u1', 'out', 500);
    expect(Math.abs(freqOf(vout, 2e-5, 0.1) - 500)).toBeLessThan(25);
    const slopes: number[] = [];
    for (let i = 1; i < vout.length; i++) slopes.push(Math.abs(vout[i] - vout[i - 1]) / 2e-5);
    const med = slopes.sort((a, b) => a - b)[Math.floor(slopes.length / 2)];
    expect(med).toBeGreaterThan(300);
    expect(med).toBeLessThan(1600);
    expect(Math.max(...vout.map(Math.abs))).toBeLessThan(3);
  });

  it('triangleGen: ±11.5V square + ±3.7V triangle at ~650Hz', () => {
    const run = runTran(cloneDoc(rawComplexExamples.triangleGen), 30000, 2e-5, 'trap');
    expect(run.failAt).toBeLessThan(0);
    const sq = arr(run, 'u1', 'out', 5000);
    const tri = arr(run, 'u1', 'in-', 5000);
    expect(Math.max(...sq)).toBeGreaterThan(10.5);
    expect(Math.min(...sq)).toBeLessThan(-10.5);
    const f = freqOf(sq, 2e-5, 2);
    expect(f).toBeGreaterThan(500);
    expect(f).toBeLessThan(900);
    const triAmp = Math.max(...tri.map(v => Math.abs(v)));
    expect(triAmp).toBeGreaterThan(2.5);
    expect(triAmp).toBeLessThan(5);
  });

  it('sallenKey: 200Hz passes, 10kHz attenuated (2nd-order rolloff)', () => {
    const run1 = runTran(cloneDoc(rawComplexExamples.sallenKey), 1500, 2e-5);
    expect(run1.failAt).toBeLessThan(0);
    const amp1 = Math.max(...arr(run1, 'u1', 'out', 700).map(Math.abs));
    const doc2 = cloneDoc(rawComplexExamples.sallenKey);
    doc2.components.find(c => c.id === 'vin')!.parameters.frequency = 10000;
    const run2 = runTran(doc2, 3000, 2e-6);
    expect(run2.failAt).toBeLessThan(0);
    const amp2 = Math.max(...arr(run2, 'u1', 'out', 1000).map(Math.abs));
    expect(amp1).toBeGreaterThan(0.85);
    expect(amp2).toBeLessThan(0.15);
  });

  it('schmitt: rail-to-rail square at the input frequency', () => {
    const run = runTran(cloneDoc(rawComplexExamples.schmitt), 4000, 5e-5);
    expect(run.failAt).toBeLessThan(0);
    const vout = arr(run, 'u1', 'out', 500);
    expect(Math.max(...vout)).toBeGreaterThan(10.5);
    expect(Math.min(...vout)).toBeLessThan(-10.5);
    expect(Math.abs(freqOf(vout, 5e-5, 2) - 200)).toBeLessThan(10);
  });

  it('diffAmp: Vout = V2 − V1 exactly (−2V for 1V/3V inputs)', () => {
    const run = runTran(cloneDoc(rawComplexExamples.diffAmp), 30, 1e-4);
    expect(run.failAt).toBeLessThan(0);
    expect(Math.abs(V(run, 29, 'u1', 'out') + 2)).toBeLessThan(0.02);
  });

  it('wienBridge: sine oscillation near 1.6kHz, bounded amplitude', () => {
    const run = runTran(cloneDoc(rawComplexExamples.wienBridge), 50000, 1e-5, 'trap');
    expect(run.failAt).toBeLessThan(0);
    const out = arr(run, 'u1', 'out', 30000);
    const amp = Math.max(...out.map(Math.abs));
    const f = freqOf(out, 1e-5, 0.5);
    expect(amp).toBeGreaterThan(1.5);
    expect(amp).toBeLessThan(9.5);
    expect(f).toBeGreaterThan(1100);
    expect(f).toBeLessThan(2100);
  });

  it('precisionRectifier: Vout = max(Vin, 0) outside the crossing window', () => {
    const run = runTran(cloneDoc(rawComplexExamples.precisionRectifier), 4000, 5e-5);
    expect(run.failAt).toBeLessThan(0);
    const vin = arr(run, 'vin', 'p', 500);
    const vout = arr(run, 'rload', 'a', 500);
    let maxErr = 0;
    for (let i = 0; i < vin.length; i++) {
      if (Math.abs(vin[i]) < 0.3) continue; // one-step crossover glitch window
      const err = Math.abs(vout[i] - Math.max(vin[i], 0));
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr).toBeLessThan(0.05);
    expect(Math.abs(freqOf(vout, 5e-5, 0.5) - 200)).toBeLessThan(15);
  });

  it('monostable555: idle low, fires on trigger, pulse holds (1.1·R·C)', () => {
    const doc = cloneDoc(rawComplexExamples.monostable555);
    const btn = doc.components.find(c => c.id === 'btn1')!;
    const plugins = pluginsFor(doc.components);
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    for (const c of doc.components) if (!c.simState) c.simState = {};
    let prev: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: Record<string, unknown> } | undefined;
    const hist: Float64Array[] = [];
    for (let i = 0; i < 900; i++) {
      btn.parameters.pressed = (i >= 300 && i < 400); // 30ms→40ms
      const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
      if (!r) break;
      hist.push(Float64Array.from(r.sim.nodeVoltage));
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(hist.length).toBe(900);
    const out = hist.map(h => h[nodeMap.terminalNode.get('ic1:out')!] > 4);
    expect(out.slice(0, 290).every(v => !v)).toBe(true); // low before trigger
    expect(out.slice(310, 320).every(Boolean)).toBe(true); // fired
    expect(out.slice(880, 899).every(Boolean)).toBe(true); // 0.52s pulse still high at 90ms
  });

  it('pwm555: oscillates with wiper-controlled duty', () => {
    const run = runTran(cloneDoc(rawComplexExamples.pwm555), 12000, 5e-4);
    expect(run.failAt).toBeLessThan(0);
    const vout = arr(run, 'ic1', 'out', 500);
    const f = freqOf(vout, 5e-4, 2);
    const highTime = vout.filter(v => v > 4).length / vout.length;
    expect(f).toBeGreaterThan(5);
    expect(f).toBeLessThan(30);
    // wiper 25% → charge R = 75k, discharge R = 25k → duty ≈ 75% (complement)
    expect(Math.abs(highTime - 0.75)).toBeLessThan(0.2);
  });

  it('tone555: ~415Hz astable driving the speaker', () => {
    const run = runTran(cloneDoc(rawComplexExamples.tone555), 12000, 5e-5);
    expect(run.failAt).toBeLessThan(0);
    const vout = arr(run, 'ic1', 'out', 500);
    expect(Math.abs(freqOf(vout, 5e-5, 2) - 415)).toBeLessThan(60);
    const vb = arr(run, 'spk1', 'b', 500);
    const iSpkMean = arr(run, 'spk1', 'a', 500).map((v, i) => Math.abs(v - vb[i]) / 8)
      .reduce((a, b) => a + b, 0) / vout.length;
    expect(iSpkMean).toBeGreaterThan(0.005); // speaker actually driven
  });

  it('bridgeSupply: full-wave humps → flat 5.1V regulated rail', () => {
    const run = runTran(cloneDoc(rawComplexExamples.bridgeSupply), 8000, 5e-4);
    expect(run.failAt).toBeLessThan(0);
    const vreg = arr(run, 'dz', 'k', 4000);
    const vbridge = arr(run, 'cs', 'a', 4000);
    const regMean = vreg.reduce((a, b) => a + b, 0) / vreg.length;
    expect(Math.abs(regMean - 5.1)).toBeLessThan(0.5);
    expect(Math.max(...vbridge)).toBeGreaterThan(9);
  });

  it('voltageDoubler: output ≈ 2·Vp − 2·Vf ≈ 10.6V', () => {
    const run = runTran(cloneDoc(rawComplexExamples.voltageDoubler), 10000, 5e-4);
    expect(run.failAt).toBeLessThan(0);
    const vout = arr(run, 'c2', 'a', 5000);
    const vmean = vout.reduce((a, b) => a + b, 0) / vout.length;
    expect(vmean).toBeGreaterThan(9);
    expect(vmean).toBeLessThan(12);
  });

  it('zenerRegulator: 5.1V rail + KCL current split on the wire dots', () => {
    const run = runTran(cloneDoc(rawComplexExamples.zenerRegulator), 300, 1e-5);
    expect(run.failAt).toBeLessThan(0);
    const last = run.hist.length - 1;
    expect(Math.abs(V(run, last, 'dz', 'k') - 5.1)).toBeLessThan(0.6);
    const sim: SimContext = {
      nodeVoltage: run.hist[last].nv, branchCurrent: run.hist[last].bc, state: run.hist[last].state,
      numNodes: run.nodeMap.numNodes, time: 0, dt: 1e-4, method: 'euler', temp: 27, netNames: run.nodeMap.netNames,
    };
    const wc = computeWireCurrents(run.components, run.wires, run.plugins, sim);
    const iZener = Math.abs(wc.get('w4') ?? 0);
    const iLoad = Math.abs(wc.get('w3') ?? 0);
    const iTotal = Math.abs(wc.get('w1') ?? 0);
    expect(Math.abs(iZener - 0.026)).toBeLessThan(0.01); // zener absorbs the surplus
    expect(Math.abs(iLoad - 0.0051)).toBeLessThan(0.002);
    expect(Math.abs(iTotal - (iZener + iLoad))).toBeLessThan(0.0005); // KCL
  });

  it('inductorKickback: current builds, spike is huge but finite', () => {
    const doc = cloneDoc(rawComplexExamples.inductorKickback);
    const plugins = pluginsFor(doc.components);
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    for (const c of doc.components) if (!c.simState) c.simState = {};
    let prev: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: Record<string, unknown> } | undefined;
    const hist: Float64Array[] = [];
    let failAt = -1;
    for (let i = 0; i < 1500; i++) {
      if (i === 700) doc.components[1].parameters.closed = false;
      const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4, { method: 'trap' });
      if (!r) { failAt = i; break; }
      hist.push(Float64Array.from(r.sim.nodeVoltage));
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(failAt).toBeLessThan(0);
    const swNode = nodeMap.terminalNode.get('sw1:b')!;
    expect(hist.slice(0, 700).every(h => Math.abs(h[swNode] - 12) < 0.5)).toBe(true);
    const spike = Math.max(...hist.slice(700).map(h => Math.abs(h[swNode])));
    expect(Number.isFinite(spike)).toBe(true);
    expect(spike).toBeGreaterThan(50); // the physics: a real kick
  });

  it('srLatch: set → hold → reset → hold', () => {
    const doc = cloneDoc(rawComplexExamples.srLatch);
    const plugins = pluginsFor(doc.components);
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    for (const c of doc.components) if (!c.simState) c.simState = {};
    const Q = (i: number) => hist[i][nodeMap.terminalNode.get('g1:y')!];
    let prev: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: Record<string, unknown> } | undefined;
    const hist: Float64Array[] = [];
    for (let i = 0; i < 900; i++) {
      doc.components[3].parameters.pressed = (i >= 100 && i < 200); // SET
      doc.components[4].parameters.pressed = (i >= 400 && i < 500); // RESET
      const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
      if (!r) break;
      hist.push(Float64Array.from(r.sim.nodeVoltage));
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(Q(250)).toBeGreaterThan(3.5); // set
    expect(Q(350)).toBeGreaterThan(3.5); // holds after release
    expect(Q(550)).toBeLessThan(1.5); // reset
    expect(Q(800)).toBeLessThan(1.5); // holds
  });

  it('dffCounter: divide-by-2 per stage (Q1 = Q0/2)', () => {
    const run = runTran(cloneDoc(rawComplexExamples.dffCounter), 9000, 1e-3);
    expect(run.failAt).toBeLessThan(0);
    const q0 = arr(run, 'ff1', 'q');
    const q1 = arr(run, 'ff2', 'q');
    const clk = arr(run, 'clk1', 'p');
    const countTransitions = (a: number[]) => {
      let n = 0;
      for (let i = 500; i < a.length - 1; i++) if ((a[i] < 2.5) !== (a[i + 1] < 2.5)) n++;
      return n;
    };
    const q0T = countTransitions(q0), q1T = countTransitions(q1), clkT = countTransitions(clk);
    expect(clkT).toBeGreaterThanOrEqual(14); // ~8 rising + falling edges in 9s
    expect(q0T).toBeGreaterThanOrEqual(7); // toggles every rising edge
    expect(q1T).toBeGreaterThanOrEqual(3); // half rate
    expect(Math.abs(q0T - 2 * q1T)).toBeLessThanOrEqual(2);
  });

  it('halfAdder: full truth table', () => {
    const doc = cloneDoc(rawComplexExamples.halfAdder);
    const plugins = pluginsFor(doc.components);
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    for (const c of doc.components) if (!c.simState) c.simState = {};
    const btnA = doc.components.find(c => c.id === 'btna')!;
    const btnB = doc.components.find(c => c.id === 'btnb')!;
    const truth: { sum: number; carry: number }[] = [];
    for (const [a, b] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      let prev: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: Record<string, unknown> } | undefined;
      for (let i = 0; i < 60; i++) {
        btnA.parameters.pressed = a;
        btnB.parameters.pressed = b;
        const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
        if (!r) break;
        prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
        if (i === 59) truth.push({
          sum: r.sim.nodeVoltage[nodeMap.terminalNode.get('gx:y')!],
          carry: r.sim.nodeVoltage[nodeMap.terminalNode.get('ga:y')!],
        });
      }
    }
    expect(truth).toHaveLength(4);
    expect(truth[0].sum).toBeLessThan(1); expect(truth[0].carry).toBeLessThan(1); // 0+0 = 00
    expect(truth[1].sum).toBeGreaterThan(4); expect(truth[1].carry).toBeLessThan(1); // 1+0 = 01
    expect(truth[2].sum).toBeGreaterThan(4); expect(truth[2].carry).toBeLessThan(1); // 0+1 = 01
    expect(truth[3].sum).toBeLessThan(1); expect(truth[3].carry).toBeGreaterThan(4); // 1+1 = 10
  });

  it('wheatstone: balanced = 0.000V; 20% leg change = −0.227V', () => {
    const run = runTran(cloneDoc(rawComplexExamples.wheatstone), 3, 1e-4);
    expect(run.failAt).toBeLessThan(0);
    expect(Math.abs(V(run, 2, 'vm', 'p') - V(run, 2, 'vm', 'n'))).toBeLessThan(0.001);
    const doc2 = cloneDoc(rawComplexExamples.wheatstone);
    doc2.components.find(c => c.id === 'r4')!.parameters.resistance = 1200;
    const run2 = runTran(doc2, 3, 1e-4);
    expect(Math.abs((V(run2, 2, 'vm', 'p') - V(run2, 2, 'vm', 'n')) + 0.227)).toBeLessThan(0.005);
  });

  it('r2rDac: exact binary weighting (1011=11/16, 1111=15/16, 0001=1/16 of VCC)', () => {
    const setBits = (doc: CircuitDocument, bits: Record<string, 0 | 1>) => {
      for (const [bit, val] of Object.entries(bits)) {
        doc.components.find(c => c.id === `${bit}h`)!.parameters.closed = val === 1;
        doc.components.find(c => c.id === `${bit}l`)!.parameters.closed = val === 0;
      }
    };
    const doc = cloneDoc(rawComplexExamples.r2rDac);
    setBits(doc, { b3: 1, b2: 0, b1: 1, b0: 1 });
    const run = runTran(doc, 3, 1e-4);
    expect(run.failAt).toBeLessThan(0);
    expect(Math.abs(V(run, 2, 'vm', 'p') - 5 * 11 / 16)).toBeLessThan(0.02);

    const doc2 = cloneDoc(rawComplexExamples.r2rDac);
    setBits(doc2, { b3: 1, b2: 1, b1: 1, b0: 1 });
    const run2 = runTran(doc2, 3, 1e-4);
    expect(Math.abs(V(run2, 2, 'vm', 'p') - 5 * 15 / 16)).toBeLessThan(0.02);

    const doc3 = cloneDoc(rawComplexExamples.r2rDac);
    setBits(doc3, { b3: 0, b2: 0, b1: 0, b0: 1 });
    const run3 = runTran(doc3, 3, 1e-4);
    expect(Math.abs(V(run3, 2, 'vm', 'p') - 5 * 1 / 16)).toBeLessThan(0.02);
  });
});

// ═══ Part 3: the example library organization ═══
describe('example library organization', () => {
  it('is organized into multiple SMALL accordion categories (≤ 6 entries each)', () => {
    expect(exampleCategories.length).toBeGreaterThanOrEqual(8);
    for (const cat of exampleCategories) {
      expect(cat.examples.length, `category "${cat.label}" size`).toBeGreaterThan(0);
      expect(cat.examples.length, `category "${cat.label}" stays small for accordion browsing`).toBeLessThanOrEqual(6);
    }
  });

  it('has unique example names and no simple starter circuits', () => {
    const names = new Set(examples.map(e => e.name));
    expect(names.size).toBe(examples.length);
    // the removed simple starters stay out of the menu
    for (const removed of ['LED + Resistor', 'Voltage Divider', 'Current Source', 'RC Low-pass Filter', 'RL High-pass Filter', 'Diode Rectifier', 'Photoresistor Light Sensor', 'AND Gate', 'Speaker Driver']) {
      expect(names.has(removed), `"${removed}" should not be in the example menu`).toBe(false);
    }
    // and the complex library is fully present
    expect(examples.length).toBeGreaterThanOrEqual(40);
  });

  it('every complex-library entry appears in exactly one category', () => {
    const flat = examples.map(e => e.doc);
    const complexEntries = Object.values(rawComplexExamples) as CircuitDocument[];
    let missing = 0;
    for (const raw of complexEntries) {
      // match by the full component-id sequence (unique per circuit)
      const ids = raw.components.map(c => c.id).join(',');
      const present = flat.some(doc => doc.components.map(c => c.id).join(',') === ids);
      if (!present) missing++;
    }
    expect(missing, 'complex examples missing from the menu').toBe(0);
  });
});
