// Regression tests for the component-model batch 3 fixes (deep audit):
// - P1 op-amp macromodels (LM358/LM741/TL072) converge in closed loop
// - DC motor electromechanical dynamics (back-EMF, rotor speed, RPM readout)
// - TL431 anode-referenced shunt regulation
// - Transformer magnetizing inductance integrates (no resistive loss)
// - Optocoupler linear CTR transfer + saturation clamp

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

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
// 1. P1 op-amp macromodels
// ─────────────────────────────────────────────────────────────────────────────

describe('P1 op-amp macromodels (LM358/LM741/TL072)', () => {
  const follower = (type: string) => {
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 12 }),
      comp('dcVoltage', 'VEE', { voltage: -12 }),
      comp('dcVoltage', 'VIN', { voltage: 2 }),
      comp(type, 'U1', {}),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'U1', 'vcc'),
      wire('w2', 'VEE', 'p', 'U1', 'vee'),
      wire('w3', 'VIN', 'p', 'U1', 'inp'),
      wire('w4', 'U1', 'out', 'U1', 'inn'), // follower feedback
      wire('w5', 'VCC', 'n', 'GND', 'g'),
      wire('w6', 'VEE', 'n', 'GND', 'g'),
      wire('w7', 'VIN', 'n', 'GND', 'g'),
    ];
    return runSim(comps, ws, 10);
  };
  it('LM358 voltage follower converges to the input', () => {
    const r = follower('lm358');
    expect(r).not.toBeNull();
    expect(nodeOf(r!, 'U1', 'out')).toBeCloseTo(2.0, 2);
  });
  it('LM741 voltage follower converges to the input', () => {
    const r = follower('lm741');
    expect(r).not.toBeNull();
    expect(nodeOf(r!, 'U1', 'out')).toBeCloseTo(2.0, 2);
  });
  it('TL072 voltage follower converges to the input', () => {
    const r = follower('tl072');
    expect(r).not.toBeNull();
    expect(nodeOf(r!, 'U1', 'out')).toBeCloseTo(2.0, 2);
  });
  it('LM358 inverting amp: gain -Rf/Rin exactly', () => {
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 12 }),
      comp('dcVoltage', 'VEE', { voltage: -12 }),
      comp('dcVoltage', 'VIN', { voltage: 0.2 }),
      comp('lm358', 'U1', {}),
      comp('resistor', 'RF', { resistance: 47000 }),
      comp('resistor', 'RIN', { resistance: 4700 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'U1', 'vcc'),
      wire('w2', 'VEE', 'p', 'U1', 'vee'),
      wire('w3', 'VIN', 'p', 'RIN', 'a'),
      wire('w4', 'RIN', 'b', 'U1', 'inn'),
      wire('w5', 'U1', 'inp', 'GND', 'g'),
      wire('w6', 'U1', 'out', 'RF', 'a'),
      wire('w7', 'RF', 'b', 'U1', 'inn'),
      wire('w8', 'VCC', 'n', 'GND', 'g'),
      wire('w9', 'VEE', 'n', 'GND', 'g'),
      wire('w10', 'VIN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 10);
    expect(r).not.toBeNull();
    // gain -10: 0.2V in -> -2.0V out, ±50mV band covering the macromodel's
    // own 2mV input offset amplified by (1+Rf/Rin) = 11 → 22mV
    expect(nodeOf(r!, 'U1', 'out')).toBeCloseTo(-2.0, 1);
  });
  it('LM741 saturates at the rails (with the 741\'s ~1V margin) when open-loop', () => {
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 12 }),
      comp('dcVoltage', 'VEE', { voltage: -12 }),
      comp('dcVoltage', 'VIN', { voltage: 1 }),
      comp('lm741', 'U1', {}),
      comp('resistor', 'RL', { resistance: 1e6 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'U1', 'vcc'),
      wire('w2', 'VEE', 'p', 'U1', 'vee'),
      wire('w3', 'VIN', 'p', 'U1', 'inp'),
      wire('w4', 'U1', 'inn', 'GND', 'g'),
      wire('w5', 'U1', 'out', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'VCC', 'n', 'GND', 'g'),
      wire('w8', 'VEE', 'n', 'GND', 'g'),
      wire('w9', 'VIN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 12);
    expect(r).not.toBeNull();
    const vout = nodeOf(r!, 'U1', 'out');
    // 12V rail minus 1V margin minus the 75Ω/1MΩ droop ≈ 10.99V
    expect(vout).toBeGreaterThan(10.5);
    expect(vout).toBeLessThan(11.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DC motor electromechanics
// ─────────────────────────────────────────────────────────────────────────────

describe('DC motor electromechanical model', () => {
  it('spins up to the no-load speed V/K and the current falls to ~0', () => {
    // 5V, R=5Ω, K=0.01 V·s/rad -> no-load speed 500 rad/s (4775 rpm).
    // Mechanical time constant J·R/K² = 1e-6·5/1e-4 = 50ms -> 0.5s settles.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('dcMotor', 'M1', { resistance: 5, backEmf: 0.01, inertia: 1e-6 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'M1', 'a'),
      wire('w2', 'M1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 5000, 1e-4); // 0.5s
    expect(r).not.toBeNull();
    const st = r!.sim.state.__global ?? {};
    const key = Object.keys(st).find(k => k.startsWith('dcmotor') && k.endsWith('_w'))!;
    const omega = st[key] as number;
    expect(omega).toBeGreaterThan(400);   // near no-load speed
    expect(omega).toBeLessThan(520);
    // near-zero steady-state current (back-EMF starves the winding)
    const v = nodeOf(r!, 'M1', 'a');
    const i = (v - 0.01 * omega) / 5;
    expect(Math.abs(i)).toBeLessThan(0.02);
  });
  it('stalled motor draws the full V/R current', () => {
    // Brake the rotor with huge inertia so it barely moves in 10ms.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('dcMotor', 'M1', { resistance: 5, backEmf: 0.01, inertia: 1 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'M1', 'a'),
      wire('w2', 'M1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 100, 1e-4);
    expect(r).not.toBeNull();
    const v = nodeOf(r!, 'M1', 'a');
    const i = v / 5; // omega ~ 0
    expect(i).toBeCloseTo(1.0, 1); // 5V / 5Ω = 1A stall current
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. TL431 shunt regulator
// ─────────────────────────────────────────────────────────────────────────────

describe('TL431 shunt regulator', () => {
  it('regulates the classic 2.495V shunt reference', () => {
    // 12V through 1k into the TL431 with REF tied to CATHODE (the standard
    // 2.495V reference hookup): the cathode must sit at ~2.495V and the
    // resistor carries the difference.
    const comps = [
      comp('dcVoltage', 'VIN', { voltage: 12 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('tl431', 'U1', { refV: 2.495 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VIN', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'U1', 'c'),
      wire('w3', 'U1', 'c', 'U1', 'ref'), // REF tied to cathode
      wire('w4', 'U1', 'a', 'GND', 'g'),
      wire('w5', 'VIN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 10);
    expect(r).not.toBeNull();
    const vk = nodeOf(r!, 'U1', 'c');
    expect(vk).toBeCloseTo(2.495, 1);
  });
  it('regulates an elevated-anode topology (anode-referenced REF)', () => {
    // Anode lifted to 5V; divider R1=10k (cathode→ref), R2=10k (ref→anode):
    // regulation holds V(ref)−V(anode) = 2.495 → V(c)−V(a) ≈ 2·2.495 = 4.99V
    // → V(c) ≈ 9.99V. The old ground-referenced comparator never fired here.
    const comps = [
      comp('dcVoltage', 'VIN', { voltage: 15 }),
      comp('dcVoltage', 'VAN', { voltage: 5 }),
      comp('resistor', 'RB', { resistance: 1000 }),
      comp('resistor', 'R1', { resistance: 10000 }),
      comp('resistor', 'R2', { resistance: 10000 }),
      comp('tl431', 'U1', { refV: 2.495 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VIN', 'p', 'RB', 'a'),
      wire('w2', 'RB', 'b', 'U1', 'c'),
      wire('w3', 'U1', 'c', 'R1', 'a'),
      wire('w4', 'R1', 'b', 'U1', 'ref'),
      wire('w5', 'U1', 'ref', 'R2', 'a'),
      wire('w6', 'R2', 'b', 'U1', 'a'),
      wire('w7', 'U1', 'a', 'VAN', 'p'),
      wire('w8', 'VIN', 'n', 'GND', 'g'),
      wire('w9', 'VAN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 15);
    expect(r).not.toBeNull();
    const vc = nodeOf(r!, 'U1', 'c');
    const va = nodeOf(r!, 'U1', 'a');
    const vref = nodeOf(r!, 'U1', 'ref');
    // V(ref) − V(anode) regulated at 2.495
    expect(vref - va).toBeCloseTo(2.495, 1);
    // V(cathode) ≈ anode + 2 × 2.495 ≈ 9.99
    expect(vc).toBeGreaterThan(9.3);
    expect(vc).toBeLessThan(10.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Transformer magnetizing inductance
// ─────────────────────────────────────────────────────────────────────────────

describe('Transformer magnetizing branch', () => {
  it('integrates magnetizing current instead of dissipating (DC path)', () => {
    // 5V DC step into the primary; the secondary sees a 10MΩ load (an
    // open for practical purposes — an ideal transformer would reflect a
    // true short if the secondary were left unwired-to-ground). With a
    // proper inductor the magnetizing current RAMPS (i = V·t/L), while the
    // old plain conductance sat at a fixed V·dt/L.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('transformer', 'T1', { ratio: 2, lm: 0.01 }),
      comp('resistor', 'RL', { resistance: 1e7 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'T1', 'p1'),
      wire('w2', 'T1', 'p2', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'T1', 's1', 'RL', 'a'),
      wire('w5', 'RL', 'b', 'GND', 'g'),
      wire('w6', 'T1', 's2', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    const currents: number[] = [];
    for (let i = 0; i < 100; i++) { // 10ms
      const r = simulateStep(comps, ws, p, prev, 1e-4);
      expect(r).not.toBeNull();
      const st = r!.sim.state.__global ?? {};
      const key = Object.keys(st).find(k => k.startsWith('xfmr_lm') && k.endsWith('_i'))!;
      currents.push(st[key] as number);
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    // Current ramps up approximately linearly: i(10ms) ≈ 5V·10ms/10mH = 5A
    // (the ideal-transformer branch carries none of it — the secondary is open)
    const iEarly = currents[9];
    const iLate = currents[99];
    expect(iLate).toBeGreaterThan(3.5);
    // ramp, not a fixed value: iLate ≈ 10× iEarly for a linear ramp
    expect(iLate / Math.max(1e-9, iEarly)).toBeGreaterThan(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Optocoupler transfer curve
// ─────────────────────────────────────────────────────────────────────────────

describe('Optocoupler CTR transfer + saturation', () => {
  it('active region: Vc follows CTR·I_LED linearly', () => {
    // LED: 5V − 1.2V across (1k + ledR 1Ω) ≈ 3.76mA; CTR 0.5 → Ic = 1.88mA;
    // Rc 1k from 5V → Vc = 5 − 1.88 = 3.12V (linear, not saturated).
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 5 }),
      comp('dcVoltage', 'VIN', { voltage: 5 }),
      comp('resistor', 'RLED', { resistance: 1000 }),
      comp('optocoupler', 'U1', { ctr: 0.5, ledVf: 1.2, ledR: 1 }),
      comp('resistor', 'RC', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'RC', 'a'),
      wire('w2', 'RC', 'b', 'U1', 'c'),
      wire('w3', 'U1', 'e', 'GND', 'g'),
      wire('w4', 'VIN', 'p', 'RLED', 'a'),
      wire('w5', 'RLED', 'b', 'U1', 'ledA'),
      wire('w6', 'U1', 'ledK', 'GND', 'g'),
      wire('w7', 'VCC', 'n', 'GND', 'g'),
      wire('w8', 'VIN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 5);
    expect(r).not.toBeNull();
    const vc = nodeOf(r!, 'U1', 'c');
    expect(vc).toBeCloseTo(3.12, 1);
  });
  it('saturates at Vce(sat) when over-driven, and releases when the LED turns off', () => {
    // Same circuit but a weak 100k pull-up: CTR current (1.88mA) far exceeds
    // the 45µA the pull-up can supply -> phototransistor saturates, Vc ≈ 0.2V.
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 5 }),
      comp('dcVoltage', 'VIN', { voltage: 5 }),
      comp('resistor', 'RLED', { resistance: 1000 }),
      comp('optocoupler', 'U1', { ctr: 0.5, ledVf: 1.2, ledR: 1 }),
      comp('resistor', 'RC', { resistance: 100000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'RC', 'a'),
      wire('w2', 'RC', 'b', 'U1', 'c'),
      wire('w3', 'U1', 'e', 'GND', 'g'),
      wire('w4', 'VIN', 'p', 'RLED', 'a'),
      wire('w5', 'RLED', 'b', 'U1', 'ledA'),
      wire('w6', 'U1', 'ledK', 'GND', 'g'),
      wire('w7', 'VCC', 'n', 'GND', 'g'),
      wire('w8', 'VIN', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    let last: any = null;
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-4);
      expect(r).not.toBeNull();
      last = r;
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    expect(nodeOf(last, 'U1', 'c')).toBeLessThan(0.5); // saturated low
    // Now turn the LED off and verify release (LED source to 0V)
    (comps.find(c => c.id === 'VIN')!.parameters as any).voltage = 0;
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-4);
      expect(r).not.toBeNull();
      last = r;
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    // LED dark -> phototransistor off -> pull-up wins: Vc back to ~5V
    expect(nodeOf(last, 'U1', 'c')).toBeGreaterThan(4.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CD4026 first-clock-edge
// ─────────────────────────────────────────────────────────────────────────────

describe('CD4026 first clock edge', () => {
  it('counts the FIRST rising edge of a clock idling low at power-up', () => {
    // 1Hz square (idles low at t=0): segment 'b' is lit for count 1.
    // With the old `initialized` gating the first edge was swallowed and
    // the count stayed 0 until the SECOND edge.
    const comps = [
      comp('pulseSource', 'CLK', { high: 5, low: 0, frequency: 1, duty: 0.5 }),
      comp('dcVoltage', 'VCC', { voltage: 5 }),
      comp('cd4026', 'U1', { vcc: 5, maxCount: 10 }),
      comp('resistor', 'RB', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'CLK', 'p', 'U1', 'clk'),
      wire('w2', 'CLK', 'n', 'GND', 'g'),
      wire('w3', 'VCC', 'p', 'U1', 'vcc'),
      wire('w4', 'U1', 'gnd', 'GND', 'g'),
      wire('w5', 'U1', 'b', 'RB', 'a'),
      wire('w6', 'RB', 'b', 'GND', 'g'),
      wire('w7', 'VCC', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    let last: any = null;
    // 0.75s: the clock rose at t=0.5s (first rising edge) -> count must be 1
    for (let i = 0; i < 7500; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-4);
      expect(r).not.toBeNull();
      last = r;
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    const st = last.sim.state['cd4026_U1'] ?? {};
    expect((st as any).count).toBe(1);
    // segment b high (count 1 pattern: segments b,c lit)
    const vb = nodeOf(last, 'U1', 'b');
    expect(vb).toBeGreaterThan(4.5);
  });
});
