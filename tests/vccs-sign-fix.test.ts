// Regression tests for the stampVCCS sign-convention fix (2024 deep-audit).
//
// Root cause: stampVCCS in solver.ts / sparse-klu.ts / complex-solver.ts was
// the NEGATION of its documented (and SPICE-standard) semantics — it pushed
// g·(V(c)−V(d)) INTO n1 instead of drawing it out. Every transistor model
// written against the doc (Gummel-Poon BJT, Level-1 MOS, JFET, BSIM3/4,
// vccsUser, AC gm stamps, transmission-line Y12) therefore behaved as a
// negative-gain / energy-generating device. These tests pin the fixed
// behavior with textbook operating points.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  simulateStep, computeComponentCurrents,
} from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import { runAC } from '../src/lib/circuit/analysis';
import { createMnaSystem, solveMna } from '../src/lib/circuit/solver';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(t: string, id: string, p?: any): CircuitComponent {
  const pl = getPlugin(t);
  const d: any = {};
  if (pl) for (const pm of pl.parameters) d[pm.key] = pm.default;
  return { id, type: t, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...p }, simState: {} };
}
function wire(id: string, f: string, ft: string, t: string, tt: string): Wire {
  return { id, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } };
}
function plugins() {
  return new Map(getAllPlugins().map(p => [p.type, p]));
}
function runSim(comps: CircuitComponent[], ws: Wire[], steps = 12, dt = 1e-4) {
  const p = plugins();
  let prev: any;
  let last: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(comps, ws, p, prev, dt);
    if (!r) return null;
    last = r;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return last;
}
function nodeOf(r: any, id: string, term: string): number {
  return r.sim.nodeVoltage[r.nodeMap.terminalNode.get(`${id}:${term}`)!];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The raw MNA stamp: a self-controlled VCCS must behave as a conductance
// ─────────────────────────────────────────────────────────────────────────────

describe('stampVCCS raw-stamp convention', () => {
  it('self-controlled VCCS acts as a positive conductance', () => {
    // 1A injected into node 1; 1Ω to ground; VCCS(1, 0, 1, 0, 0.5) must add
    // 0.5S in parallel → V1 = 1 / 1.5 = 0.6667V. (With the old inverted
    // stamp the effective conductance was −0.5S → V1 = 2V.)
    const sys = createMnaSystem(1, 0);
    sys.stampConductance(1, 0, 1);
    sys.stampVCCS(1, 0, 1, 0, 0.5);
    sys.stampCurrentSource(0, 1, 1);
    const x = solveMna(sys);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(1 / 1.5, 6);
  });

  it('VCCS delivers current from n1 to n2 (SPICE G)', () => {
    // V(1) = 1V via source; VCCS(2, 0, 1, 0, 0.5) draws 0.5A OUT of node 2
    // through the element to ground; node 2 has 1Ω to ground → V2 = −0.5V.
    const sys = createMnaSystem(2, 1);
    sys.stampVoltageSource(1, 0, 1);
    sys.stampConductance(2, 0, 1);
    sys.stampVCCS(2, 0, 1, 0, 0.5);
    const x = solveMna(sys);
    expect(x).not.toBeNull();
    expect(x![1]).toBeCloseTo(-0.5, 6);
  });

  it('VCCS between two live nodes conserves current', () => {
    // VCCS(1, 2, 1, 0, 1): current 1·V1 flows through the element from node1
    // to node2 (enters the element at n1, exits INTO node 2 — SPICE G).
    // Node1 also has 1A injected and 1Ω to ground; node2 has 1Ω to ground.
    // KCL1: 1 (injected) = V1/1 (resistor) + 1·V1 (into element) → V1 = 0.5
    // KCL2: 1·V1 (from element) = V2/1 (resistor)              → V2 = +0.5
    const sys = createMnaSystem(2, 0);
    sys.stampConductance(1, 0, 1);
    sys.stampConductance(2, 0, 1);
    sys.stampVCCS(1, 2, 1, 0, 1);
    sys.stampCurrentSource(0, 1, 1);
    const x = solveMna(sys);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(0.5, 6);
    expect(x![1]).toBeCloseTo(0.5, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. vccsUser (SPICE G element) polarity through the engine
// ─────────────────────────────────────────────────────────────────────────────

describe('vccsUser SPICE G-element polarity', () => {
  it('draws gm·Vin from O+ and injects into O- (V(out) is negative)', () => {
    // Vin = 1V, gm = 0.01 → 10mA flows through the element from O+ to O-.
    // RL = 1k from O+ to ground → V(O+) = −10V (SPICE-correct).
    const comps = [
      comp('dcVoltage', 'VIN', { voltage: 1 }),
      comp('resistor', 'RI', { resistance: 1e6 }),
      comp('vccsUser', 'G1', { gm: 0.01 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VIN', 'p', 'RI', 'a'),
      wire('w2', 'VIN', 'n', 'GND', 'g'),
      wire('w3', 'RI', 'b', 'G1', 'ip'),
      wire('w4', 'G1', 'in', 'GND', 'g'),
      wire('w5', 'G1', 'op', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'G1', 'on', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3);
    expect(r).not.toBeNull();
    const vop = nodeOf(r!, 'G1', 'op');
    expect(vop).toBeCloseTo(-10, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Transistor DC operating points (the models that the inversion broke)
// ─────────────────────────────────────────────────────────────────────────────

describe('Gummel-Poon BJT operating point', () => {
  it('NPN common-emitter: collector sits below the rail (no energy from nothing)', () => {
    // VDD=5, Rc=1k, base driven through 10k from 0.72V.
    // Self-consistent solution: Vbe≈0.686, Ic≈330µA → Vc≈4.67V.
    const comps = [
      comp('dcVoltage', 'VDD', { voltage: 5 }),
      comp('dcVoltage', 'VBB', { voltage: 0.72 }),
      comp('resistor', 'RC', { resistance: 1000 }),
      comp('resistor', 'RB', { resistance: 10000 }),
      comp('bjtGPNpn', 'Q1', { Is: 1e-15, Bf: 100, Vaf: 100 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VDD', 'p', 'RC', 'a'),
      wire('w2', 'RC', 'b', 'Q1', 'c'),
      wire('w3', 'VBB', 'p', 'RB', 'a'),
      wire('w4', 'RB', 'b', 'Q1', 'b'),
      wire('w5', 'Q1', 'e', 'GND', 'g'),
      wire('w6', 'VDD', 'n', 'GND', 'g'),
      wire('w7', 'VBB', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 30);
    expect(r).not.toBeNull();
    const vc = nodeOf(r!, 'Q1', 'c');
    // Before the fix the inverted gm source pumped Vc to ~22–26V (above the
    // 5V rail). Now it must sit at the physical operating point.
    expect(vc).toBeGreaterThan(4.0);
    expect(vc).toBeLessThan(5.0);
    // hfe ≈ 100: Ic = (5−Vc)/1k ≈ 0.33mA; Ib from (0.72−Vbe)/10k ≈ 3.4µA
    const ic = computeComponentCurrents(comps, ws, plugins(), r!.sim).get('Q1') ?? 0;
    expect(ic).toBeGreaterThan(0.0001);
    expect(ic).toBeLessThan(0.001);
  });

  it('PNP high-side switch: collector stays between 0 and the rail', () => {
    // Emitter at +5V, base at 4.28V through 10k (Veb≈0.72 → mirror of the
    // NPN test). Collector through 1k to ground → Ic≈0.33mA → Vc≈0.33V.
    const comps = [
      comp('dcVoltage', 'VDD', { voltage: 5 }),
      comp('dcVoltage', 'VBB', { voltage: 4.28 }),
      comp('resistor', 'RC', { resistance: 1000 }),
      comp('resistor', 'RB', { resistance: 10000 }),
      comp('bjtGPPnp', 'Q1', { Is: 1e-15, Bf: 100, Vaf: 100 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VDD', 'p', 'Q1', 'e'),
      wire('w2', 'Q1', 'c', 'RC', 'a'),
      wire('w3', 'RC', 'b', 'GND', 'g'),
      wire('w4', 'VBB', 'p', 'RB', 'a'),
      wire('w5', 'RB', 'b', 'Q1', 'b'),
      wire('w6', 'VDD', 'n', 'GND', 'g'),
      wire('w7', 'VBB', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 30);
    expect(r).not.toBeNull();
    const vc = nodeOf(r!, 'Q1', 'c');
    // Before the fix: 9.05V (above the rail, a generator). Physical range:
    expect(vc).toBeGreaterThan(-0.05);
    expect(vc).toBeLessThan(1.5);
    const ic = computeComponentCurrents(comps, ws, plugins(), r!.sim).get('Q1') ?? 0;
    expect(ic).toBeGreaterThan(0.00005);
    expect(ic).toBeLessThan(0.002);
  });
});

describe('Level-1 MOSFET operating point', () => {
  it('NMOS common-source: drain at the resistive operating point', () => {
    // VDD=5, Rd=1k, Vg=3, Vto=1, Kp=0.002 → Id=½·0.002·2²=4mA → Vd=1.00V.
    const comps = [
      comp('dcVoltage', 'VDD', { voltage: 5 }),
      comp('dcVoltage', 'VGG', { voltage: 3 }),
      comp('resistor', 'RD', { resistance: 1000 }),
      comp('mosLevel1N', 'M1', { Vto: 1, Kp: 0.002, Lambda: 0, Rd: 0, Rs: 0 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VDD', 'p', 'RD', 'a'),
      wire('w2', 'RD', 'b', 'M1', 'd'),
      wire('w3', 'VGG', 'p', 'M1', 'g'),
      wire('w4', 'M1', 's', 'GND', 'g'),
      wire('w5', 'M1', 'b', 'GND', 'g'),
      wire('w6', 'VDD', 'n', 'GND', 'g'),
      wire('w7', 'VGG', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 20);
    expect(r).not.toBeNull();
    const vd = nodeOf(r!, 'M1', 'd');
    // Before the fix: 23V (above the 5V rail). Physical: 1.00V ± Early/lambda 0.
    expect(vd).toBeGreaterThan(0.6);
    expect(vd).toBeLessThan(1.6);
  });

  it('PMOS high-side switch: drain near ground when fully on', () => {
    // Source at +5V, gate at 0V, Vto=−1, Kp=0.002: |vov|=4 → Id=16mA.
    // Rd=250Ω to ground → Vd = 4.0V.
    const comps = [
      comp('dcVoltage', 'VDD', { voltage: 5 }),
      comp('resistor', 'RD', { resistance: 250 }),
      comp('mosLevel1P', 'M1', { Vto: -1, Kp: 0.002, Lambda: 0, Rd: 0, Rs: 0 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VDD', 'p', 'M1', 's'),
      wire('w2', 'M1', 'd', 'RD', 'a'),
      wire('w3', 'RD', 'b', 'GND', 'g'),
      wire('w4', 'M1', 'g', 'GND', 'g'),
      wire('w5', 'M1', 'b', 'GND', 'g'),
      wire('w6', 'VDD', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 20);
    expect(r).not.toBeNull();
    const vd = nodeOf(r!, 'M1', 'd');
    // Before the fix: −49.7V. Physical: 4V ±0.6.
    expect(vd).toBeGreaterThan(3.2);
    expect(vd).toBeLessThan(4.8);
  });
});

describe('JFET operating point with reverse gate bias', () => {
  it('N-JFET biased at Vgs=−1V: drain sits at the Shockley operating point', () => {
    // Vp=−2, Idss=10mA, Vgs=−1 → vov=0.5 → Id=Idss·0.25=2.5mA (saturation).
    // Rd=1k from 5V → Vd = 2.5V. The old regression test biased at Vgs=0
    // where the (inverted) gm term is identically zero — this test actually
    // exercises the gm stamp.
    const comps = [
      comp('dcVoltage', 'VDD', { voltage: 5 }),
      comp('dcVoltage', 'VGG', { voltage: -1 }),
      comp('resistor', 'RD', { resistance: 1000 }),
      comp('jfetN', 'J1', { Vp: -2, Idss: 0.01 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VDD', 'p', 'RD', 'a'),
      wire('w2', 'RD', 'b', 'J1', 'd'),
      wire('w3', 'VGG', 'p', 'J1', 'g'),
      wire('w4', 'J1', 's', 'GND', 'g'),
      wire('w5', 'VDD', 'n', 'GND', 'g'),
      wire('w6', 'VGG', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 20);
    expect(r).not.toBeNull();
    const vd = nodeOf(r!, 'J1', 'd');
    // Before the fix: ~92V (rail-railing generator). Physical: 2.5V ± 0.5.
    expect(vd).toBeGreaterThan(1.8);
    expect(vd).toBeLessThan(3.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. AC analysis: rπ conductance + gm polarity
// ─────────────────────────────────────────────────────────────────────────────

describe('AC small-signal BJT input impedance (rπ units fix)', () => {
  it('biased CE stage: flat mid-band gain with ≈180° phase (inverting)', () => {
    // Bias the simple npn at Ib ≈ 10µA (Ic ≈ 1mA), then AC-stimulate through
    // the base coupling cap. rπ = β/gm ≈ 100·25.85mV/1mA ≈ 2.59kΩ.
    // Mid-band gain ≈ −gm·Rc = −0.0387·2.2k ≈ −85 → |H| ≈ 85, phase ≈ 180°.
    // The old rπ bug (Ω stamped as S) made the input an effective short:
    // |H| ∝ f with phase +90° and |H(1kHz)| ≈ 0.0026.
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 12 }),
      comp('resistor', 'RC', { resistance: 2200 }),
      comp('resistor', 'RB', { resistance: 1.1e6 }), // ≈10µA base bias from 12V
      comp('capacitor', 'CIN', { capacitance: 10e-6 }),
      comp('dcVoltage', 'VS', { voltage: 0 }), // AC stimulus (0V DC)
      comp('npn', 'Q1', { hfe: 100 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'RC', 'a'),
      wire('w2', 'RC', 'b', 'Q1', 'c'),
      wire('w3', 'VCC', 'p', 'RB', 'a'),
      wire('w4', 'RB', 'b', 'Q1', 'b'),
      wire('w5', 'VS', 'p', 'CIN', 'a'),
      wire('w6', 'CIN', 'b', 'Q1', 'b'),
      wire('w7', 'Q1', 'e', 'GND', 'g'),
      wire('w8', 'VS', 'n', 'GND', 'g'),
      wire('w9', 'VCC', 'n', 'GND', 'g'),
    ];
    const res = runAC(comps, ws, plugins(), {
      type: 'ac', sweep: 'dec', nPoints: 1, fStart: 100, fStop: 10000,
      sourceId: 'VS', acMag: 0.001, outputNode: 'c',
    } as any);
    expect(res.traces.length).toBeGreaterThan(0);
    const t = res.traces[0] as any;
    expect(t.xValues.length).toBe(3); // 100Hz, 1kHz, 10kHz
    const mag = (i: number) => Math.hypot(t.yValues[2 * i], t.yValues[2 * i + 1]);
    // Flat within 2× between 100Hz and 10kHz (CIN 10µF into rπ≈2.6k has
    // fc ≈ 6Hz — well below the band). With the old bug |H| rose ∝ f.
    expect(mag(2) / mag(0)).toBeGreaterThan(0.5);
    expect(mag(2) / mag(0)).toBeLessThan(2.0);
    // Mid-band gain magnitude in a sane band around −gm·Rc ≈ 85
    expect(mag(1) / 0.001).toBeGreaterThan(20);
    expect(mag(1) / 0.001).toBeLessThan(300);
    // Inverting: real part strongly negative, reactive part small
    const re1 = t.yValues[2], im1 = t.yValues[3];
    expect(re1).toBeLessThan(0);
    expect(Math.abs(im1)).toBeLessThan(Math.abs(re1) * 0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Transmission line AC: delay must equal Td, not Z0·Td
// ─────────────────────────────────────────────────────────────────────────────

describe('AC transmission-line delay parameterization', () => {
  it('lossless 50Ω/100ns shorted stub: input impedance follows j·Z0·tan(ω·Td)', () => {
    // Far end shorted (b1/b2 grounded). Zin = j·Z0·tan(ω·Td), Td=100ns,
    // driven through RS=50Ω from a 1V AC source.
    //  • f = 1.25MHz → ω·Td = π/4 → Zin = +j50 → |V(a1)| = 0.707, phase +45°
    //  • f = 2.5MHz  → ω·Td = π/2 → Zin → ∞ (quarter-wave shorted stub is
    //    an open) → |V(a1)| ≈ 1, phase ≈ 0°
    // With the old len=Td bug the delay was Z0·Td = 5µs, giving the OPPOSITE
    // behavior at both frequencies (≈0V at 1.25MHz, ≈0V at 2.5MHz).
    const build = () => ([
      comp('dcVoltage', 'VS', { voltage: 0 }),
      comp('resistor', 'RS', { resistance: 50 }),
      comp('transLineLossless', 'T1', { Z0: 50, Td: 1e-7 }),
      comp('ground', 'GND'),
    ]);
    const ws = [
      wire('w1', 'VS', 'p', 'RS', 'a'),
      wire('w2', 'RS', 'b', 'T1', 'a1'),
      wire('w3', 'T1', 'a2', 'GND', 'g'),
      wire('w4', 'T1', 'b1', 'GND', 'g'), // far end shorted
      wire('w5', 'T1', 'b2', 'GND', 'g'),
      wire('w6', 'VS', 'n', 'GND', 'g'),
    ];
    const runAt = (f: number) => {
      const res = runAC(build(), ws, plugins(), {
        type: 'ac', sweep: 'lin', nPoints: 1, fStart: f, fStop: f,
        sourceId: 'VS', acMag: 1, outputNode: 'a1',
      } as any);
      const t = res.traces[0] as any;
      return { re: t.yValues[0] as number, im: t.yValues[1] as number };
    };
    // 1.25 MHz: |V| ≈ 0.707, phase ≈ +45° (Zin = +j50 against RS=50)
    const v1 = runAt(1.25e6);
    expect(Math.hypot(v1.re, v1.im)).toBeCloseTo(0.707, 2);
    expect(Math.atan2(v1.im, v1.re) * 180 / Math.PI).toBeCloseTo(45, 1);
    // 2.5 MHz: quarter-wave shorted stub → open → |V| ≈ 1, phase ≈ 0°
    const v2 = runAt(2.5e6);
    expect(Math.hypot(v2.re, v2.im)).toBeGreaterThan(0.9);
    expect(Math.abs(Math.atan2(v2.im, v2.re) * 180 / Math.PI)).toBeLessThan(15);
  });
});
