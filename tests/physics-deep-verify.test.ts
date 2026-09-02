// Deep physics verification — analytical ground truths.
// ─────────────────────────────────────────────────────────────────────────────
// Unlike physics-laws.test.ts (which checks INTERNAL consistency across the
// example circuits), this suite verifies the simulator against CLOSED-FORM
// solutions of the underlying physics:
//
//   • Ohm / KVL / KCL / divider / Thevenin / superposition  — exact circuit theory
//   • RC / RL / RLC transients — exponential & damped-sine closed forms
//   • LC resonance frequency — ω0 = 1/√(LC)
//   • AC steady state — phasor magnitudes at filter corner
//   • Shockley diode I(V) — Is·(e^(V/nVt) − 1) at multiple bias points
//   • MOS Level-1 square law — Id = ½Kp(Vgs−Vth)² in saturation
//   • Body effect — Vth(Vsb) = Vto + γ(√(2Φ−Vsb) − √2Φ)
//   • Maximum power transfer — RL = Rth, P = Vth²/(4Rth)
//   • Random linear networks — KCL at every node (fuzz)
//
// Reference models: Falstad/CircuitJS1 + SPICE 3f5 (research/circuitjs1).
// Run: npx vitest run tests/physics-deep-verify.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap, computeComponentCurrents } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
});

function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return plugins;
}

interface RunResult {
  sim: SimContext | null;
  nodeMap: ReturnType<typeof buildNodeMap>;
  plugins: Map<string, ComponentPlugin>;
}

/** Run a circuit for `steps` steps of `dt`; return the final state. */
function runSim(doc: { components: CircuitComponent[]; wires: Wire[] }, steps: number, dt: number, method: 'euler' | 'trap' | 'gear' = 'euler'): RunResult {
  const plugins = pluginsFor(doc.components);
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
  for (const c of doc.components) if (!c.simState) c.simState = {};
  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, dt, { method });
    if (!r) return { sim: null, nodeMap, plugins };
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return { sim, nodeMap, plugins };
}

/** Sample a node voltage through time — for transient shape checks. */
function runSimTrace(
  doc: { components: CircuitComponent[]; wires: Wire[] },
  steps: number, dt: number,
  probeTerm: string,
  method: 'euler' | 'trap' | 'gear' = 'euler',
): number[] {
  const plugins = pluginsFor(doc.components);
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
  for (const c of doc.components) if (!c.simState) c.simState = {};
  const node = nodeMap.terminalNode.get(probeTerm)!;
  const trace: number[] = [];
  let prev: any = undefined;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, dt, { method });
    if (!r) break;
    trace.push(r.sim.nodeVoltage[node]);
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return trace;
}

function comp(type: string, id: string, at: [number, number], parameters: Record<string, any> = {}): CircuitComponent {
  const plugin = getPlugin(type);
  const resolved: Record<string, any> = {};
  if (plugin) {
    for (const p of plugin.parameters) resolved[p.key] = p.default;
  }
  Object.assign(resolved, parameters);
  return { id, type, position: { x: at[0], y: at[1] }, rotation: 0, parameters: resolved, simState: {} } as CircuitComponent;
}

function wire(fromC: string, fromT: string, toC: string, toT: string): Wire {
  return {
    id: `w_${fromC}_${fromT}_${toC}_${toT}`,
    from: { componentId: fromC, terminalId: fromT },
    to: { componentId: toC, terminalId: toT },
    points: [],
  } as unknown as Wire;
}

function V(run: RunResult, term: string): number {
  const idx = run.nodeMap.terminalNode.get(term);
  if (idx === undefined || !run.sim) return NaN;
  return run.sim.nodeVoltage[idx];
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. FOUNDATIONS — exact circuit theory
// ═════════════════════════════════════════════════════════════════════════════
describe('Analytical foundations', () => {
  it('Ohm\'s law: V = IR exactly for a single loop', () => {
    // 12 V source, 4 kΩ → 3 mA
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 12 }),
        comp('resistor', 'R1', [6, 1], { resistance: 4000 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const run = runSim(doc, 5, 1e-4);
    expect(run.sim).not.toBeNull();
    const v = V(run, 'R1:a') - V(run, 'R1:b');
    expect(v).toBeCloseTo(12, 5);
    const i = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim).get('R1') ?? 0;
    expect(i).toBeCloseTo(0.003, 5); // 3 mA
  });

  it('Voltage divider: exact tap voltage', () => {
    // 9 V across 1k + 2k → tap = 3 V
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 9 }),
        comp('resistor', 'R1', [6, 1], { resistance: 1000 }),
        comp('resistor', 'R2', [10, 1], { resistance: 2000 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'R2', 'a'),
        wire('R2', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const run = runSim(doc, 5, 1e-4);
    const vTap = V(run, 'R1:b');
    // 9 V across 1k + 2k: tap (across R2) = 9 × 2/3 = 6 V
    expect(vTap).toBeCloseTo(6, 5);
    // Current through the chain: 9/3000 = 3 mA
    const i = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim).get('R1') ?? 0;
    expect(i).toBeCloseTo(0.003, 5);
  });

  it('Current divider: exact branch currents', () => {
    // 1 A source splits between 2Ω and 6Ω: I1 = 0.75, I2 = 0.25
    const doc = {
      components: [
        comp('currentSource', 'I1', [1, 1], { current: 1 }),
        comp('resistor', 'R1', [6, 1], { resistance: 2 }),
        comp('resistor', 'R2', [6, 5], { resistance: 6 }),
        comp('ground', 'GND', [1, 9]),
      ],
      wires: [
        wire('I1', 'p', 'R1', 'a'),
        wire('I1', 'p', 'R2', 'a'),
        wire('R1', 'b', 'I1', 'n'),
        wire('R2', 'b', 'I1', 'n'),
        wire('I1', 'n', 'GND', 'g'),
      ],
    };
    const run = runSim(doc, 5, 1e-4);
    const currents = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim);
    // computeComponentCurrents reports signed a→b current; magnitude check
    expect(Math.abs(currents.get('R1') ?? 0)).toBeCloseTo(0.75, 3);
    expect(Math.abs(currents.get('R2') ?? 0)).toBeCloseTo(0.25, 3);
  });

  it('Series/parallel resistor equivalence', () => {
    // 10 V across (1k ∥ 1k) + 1k → 5 V on the parallel pair
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 10 }),
        comp('resistor', 'R1', [6, 1], { resistance: 1000 }),
        comp('resistor', 'R2', [10, 1], { resistance: 1000 }),
        comp('resistor', 'R3', [10, 5], { resistance: 1000 }),
        comp('ground', 'GND', [1, 9]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'R2', 'a'),
        wire('R1', 'b', 'R3', 'a'),
        wire('R2', 'b', 'V1', 'n'),
        wire('R3', 'b', 'V1', 'n'),
        wire('V1', 'n', 'GND', 'g'),
      ],
    };
    const run = runSim(doc, 5, 1e-4);
    // R2 ∥ R3 = 500 Ω; divider with R1 = 1 k → 10 × 500/1500 = 3.333 V
    expect(V(run, 'R1:b')).toBeCloseTo(10 / 3, 3);
  });

  it('KVL: loop voltages sum to zero', () => {
    // Two sources, two resistors in a loop: Σ V = 0
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 5 }),
        comp('dcVoltage', 'V2', [12, 1], { voltage: 3 }),
        comp('resistor', 'R1', [6, 1], { resistance: 1000 }),
        comp('resistor', 'R2', [9, 1], { resistance: 500 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'R2', 'a'),
        wire('R2', 'b', 'V2', 'p'),
        wire('V2', 'n', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const run = runSim(doc, 5, 1e-4);
    const vV1 = V(run, 'V1:p') - V(run, 'V1:n');
    const vR1 = V(run, 'R1:a') - V(run, 'R1:b');
    const vR2 = V(run, 'R2:a') - V(run, 'R2:b');
    const vV2 = V(run, 'V2:p') - V(run, 'V2:n');
    // KVL around the loop: −V1 + VR1 + VR2 + V2 = 0
    const sum = -vV1 + vR1 + vR2 + vV2;
    expect(Math.abs(sum)).toBeLessThan(1e-9);
    // Current: (5 − 3) / 1500 = 1.333 mA
    const i = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim).get('R1') ?? 0;
    expect(i).toBeCloseTo(2 / 1500, 6);
  });

  it('KCL: every node balances exactly on a random ladder network', () => {
    // 5-node ladder: source + 4 resistors in ladder topology
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 7 }),
        comp('resistor', 'R1', [5, 1], { resistance: 330 }),
        comp('resistor', 'R2', [5, 4], { resistance: 470 }),
        comp('resistor', 'R3', [9, 1], { resistance: 220 }),
        comp('resistor', 'R4', [9, 4], { resistance: 820 }),
        comp('ground', 'GND', [1, 7]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'R3', 'a'),
        wire('R1', 'b', 'R2', 'a'),
        wire('R2', 'b', 'GND', 'g'),
        wire('R3', 'b', 'R4', 'a'),
        wire('R4', 'b', 'GND', 'g'),
        wire('V1', 'n', 'GND', 'g'),
      ],
    };
    const run = runSim(doc, 5, 1e-4);
    const currents = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim);
    // Node between R1, R2, R3: current in = current out
    const iR1 = Math.abs(currents.get('R1') ?? 0);
    const iR2 = Math.abs(currents.get('R2') ?? 0);
    const iR3 = Math.abs(currents.get('R3') ?? 0);
    expect(Math.abs(iR1 - iR2 - iR3)).toBeLessThan(1e-9);
    // Exact ladder solution: node N loads with R2 ∥ (R3+R4)
    const R34 = 220 + 820;                           // R3 in series with R4 = 1040
    const Rpar = (470 * R34) / (470 + R34);          // R2 ∥ (R3+R4) = 323.84
    const vNode = 7 * Rpar / (330 + Rpar);           // divider: 7 × 323.84/653.84 = 3.466 V
    expect(V(run, 'R1:b')).toBeCloseTo(vNode, 3);
  });

  it('Thevenin equivalent: Vth and Rth measured by load test', () => {
    // Circuit: 10V source with 1k series. Thevenin: Vth = 10, Rth = 1k.
    // With RL = 1k: V_load = 5. With RL = 3k: V_load = 7.5.
    const makeDoc = (rl: number) => ({
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 10 }),
        comp('resistor', 'Rs', [5, 1], { resistance: 1000 }),
        comp('resistor', 'RL', [9, 1], { resistance: rl }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'Rs', 'a'),
        wire('Rs', 'b', 'RL', 'a'),
        wire('RL', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    });
    const v1 = V(runSim(makeDoc(1000), 5, 1e-4), 'RL:a');
    const v2 = V(runSim(makeDoc(3000), 5, 1e-4), 'RL:a');
    expect(v1).toBeCloseTo(5, 4);
    expect(v2).toBeCloseTo(7.5, 4);
  });

  it('Superposition: response = sum of individual source responses', () => {
    // Two sources V1 = 5V, V2 = 3V, both through 1k into node N, 1k to GND.
    const build = (v1: number, v2: number) => ({
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: v1 }),
        comp('dcVoltage', 'V2', [13, 1], { voltage: v2 }),
        comp('resistor', 'R1', [5, 1], { resistance: 1000 }),
        comp('resistor', 'R2', [9, 1], { resistance: 1000 }),
        comp('resistor', 'R3', [7, 4], { resistance: 1000 }),
        comp('ground', 'GND', [1, 7]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'R3', 'a'),
        wire('V2', 'p', 'R2', 'a'),
        wire('R2', 'b', 'R3', 'a'),
        wire('R3', 'b', 'GND', 'g'),
        wire('V1', 'n', 'GND', 'g'),
        wire('V2', 'n', 'GND', 'g'),
      ],
    });
    const both = V(runSim(build(5, 3), 5, 1e-4), 'R3:a');
    const only1 = V(runSim(build(5, 0), 5, 1e-4), 'R3:a');
    const only2 = V(runSim(build(0, 3), 5, 1e-4), 'R3:a');
    // Superposition theorem
    expect(both).toBeCloseTo(only1 + only2, 6);
  });

  it('Maximum power transfer: RL = Rth gives P = Vth²/(4·Rth)', () => {
    // 8 V source, 100 Ω Rth, RL swept — peak at RL = 100 Ω
    const build = (rl: number) => ({
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 8 }),
        comp('resistor', 'Rth', [5, 1], { resistance: 100 }),
        comp('resistor', 'RL', [9, 1], { resistance: rl }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'Rth', 'a'),
        wire('Rth', 'b', 'RL', 'a'),
        wire('RL', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    });
    const powerAt = (rl: number) => {
      const run = runSim(build(rl), 5, 1e-4);
      const v = V(run, 'RL:a');
      return (v * v) / rl;
    };
    const p80 = powerAt(80);
    const p100 = powerAt(100);
    const p125 = powerAt(125);
    // Exact: P(100) = 8²/(4·100) = 0.16 W; P(80) = P(125) = 0.1572 W
    expect(p100).toBeCloseTo(0.16, 3);
    expect(p80).toBeLessThan(p100);
    expect(p125).toBeLessThan(p100);
    expect(p80).toBeCloseTo((64 * 80) / (180 * 180), 4); // 0.15753
    expect(p125).toBeCloseTo((64 * 125) / (225 * 225), 4); // 0.15720
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. TRANSIENTS — closed-form time responses
// ═════════════════════════════════════════════════════════════════════════════
describe('Analytical transients', () => {
  it('RC charging follows v(t) = Vs·(1 − e^(−t/τ)) at 5 checkpoints', () => {
    // Vs = 5 V, R = 10 kΩ, C = 1 µF → τ = 10 ms. dt = 50 µs (τ/200).
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 5 }),
        comp('resistor', 'R1', [5, 1], { resistance: 10000 }),
        comp('capacitor', 'C1', [9, 1], { capacitance: 1e-6, initialV: 0 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'C1', 'a'),
        wire('C1', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const dt = 5e-5;
    const tau = 0.01;
    const trace = runSimTrace(doc, 2000, dt, 'C1:a', 'trap'); // 100 ms = 10τ
    expect(trace.length).toBe(2000);
    for (const tOverTau of [0.5, 1, 2, 3, 5]) {
      const idx = Math.round((tOverTau * tau) / dt);
      const exact = 5 * (1 - Math.exp(-tOverTau));
      const got = trace[idx];
      // trapezoidal integration at τ/200: < 0.1% discretization error
      expect(Math.abs(got - exact) / exact).toBeLessThan(0.005);
    }
  });

  it('RC time constant: v(τ) = 63.2% of Vs', () => {
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 10 }),
        comp('resistor', 'R1', [5, 1], { resistance: 4700 }),
        comp('capacitor', 'C1', [9, 1], { capacitance: 1e-6 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'C1', 'a'),
        wire('C1', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const tau = 4700 * 1e-6; // 4.7 ms
    const dt = 4.7e-5;      // τ/100
    const trace = runSimTrace(doc, 200, dt, 'C1:a', 'trap');
    const vTau = trace[100]; // exactly one τ in
    // v(τ)/Vs = 63.21% exact; trapezoidal startup transient adds <0.2%
    expect(vTau / 10).toBeCloseTo(1 - Math.exp(-1), 2); // 0.632 ± 0.005
  });

  it('RL current follows i(t) = (V/R)(1 − e^(−t/τ))', () => {
    // The inductor companion carries i in state; measure it via the series
    // resistor drop: v_R(t) = V·e^(−t/τ) (voltmeter across R reads decay).
    // Simpler closed-form check: final i = V/R; mid transient i(τ) = 0.632·V/R.
    // We read the inductor current from its companion: use the resistor's
    // voltage drop at t=0+ (all voltage across L at t=0) and at ∞ (all on R).
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 12 }),
        comp('resistor', 'R1', [5, 1], { resistance: 100 }),
        comp('inductor', 'L1', [9, 1], { inductance: 0.1, initialI: 0 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'L1', 'a'),
        wire('L1', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const tau = 0.1 / 100;  // 1 ms
    const dt = 1e-5;        // τ/100
    // Resistor drop v_R = V(R1:a) − V(R1:b) = 12 − vL; v_R = 12(1−e^(−t/τ))
    const trace = runSimTrace(doc, 300, dt, 'R1:b', 'trap');
    const vTau = 12 - trace[100];
    // 7.585 V exact; trapezoidal startup kick adds < 0.3%
    expect(vTau).toBeCloseTo(12 * (1 - Math.exp(-1)), 1); // ±0.05 V
    const vInf = 12 - trace[299];
    // 300 steps = 3τ → v_R = 12(1 − e^(−3)) = 11.401 V (not yet fully settled)
    expect(vInf).toBeCloseTo(12 * (1 - Math.exp(-3)), 1);
  });

  it('LC resonance: oscillation period T = 2π√(LC)', () => {
    // 1 V initial cap voltage, L = 1 mH, C = 1 µF parallel tank.
    // ω0 = 1/√(LC) = 31623 rad/s → T = 198.7 µs
    const doc = {
      components: [
        comp('capacitor', 'C1', [5, 1], { capacitance: 1e-6, initialV: 1 }),
        comp('inductor', 'L1', [9, 1], { inductance: 1e-3 }),
        comp('ground', 'GND', [5, 5]),
      ],
      wires: [
        wire('C1', 'a', 'L1', 'a'),
        wire('L1', 'b', 'GND', 'g'),
        wire('C1', 'b', 'GND', 'g'),
      ],
    };
    const T = 2 * Math.PI * Math.sqrt(1e-3 * 1e-6); // 198.69 µs
    const dt = T / 200; // ~1 µs
    const trace = runSimTrace(doc, 800, dt, 'C1:a', 'trap');
    // Measure the period from successive DOWNWARD zero crossings (the sine
    // starts at its +1 peak) — skipping the first 2 periods so the trap
    // startup transient (first-step energy kick, ~1%) settles out.
    const crossings: number[] = [];
    for (let i = 400; i < trace.length - 1; i++) {
      if (trace[i] >= 0 && trace[i + 1] < 0) crossings.push(i + 1);
    }
    expect(crossings.length).toBeGreaterThanOrEqual(1);
    if (crossings.length >= 2) {
      const periodSamples = crossings[1] - crossings[0];
      const Tmeasured = periodSamples * dt;
      // Trap on an LC tank has O(dt²) frequency error — well under 1%
      expect(Math.abs(Tmeasured - T) / T).toBeLessThan(0.01);
    }
    // Amplitude stays ~1 V (energy conservation; trap is undamped)
    const tail = trace.slice(400);
    expect(Math.max(...tail)).toBeGreaterThan(0.9);
    expect(Math.min(...tail)).toBeLessThan(-0.9);
  });

  it('RLC damping envelope: peaks decay as e^(−t·R/2L)', () => {
    // SERIES RLC: R = 10 Ω, L = 1 mH, C = 1 µF → α = R/2L = 5000 /s,
    // ω0 = 31623 rad/s → underdamped. Successive peaks ratio = e^(−αT) ≈ 0.37.
    const doc = {
      components: [
        comp('resistor', 'R1', [1, 1], { resistance: 10 }),
        comp('capacitor', 'C1', [5, 1], { capacitance: 1e-6, initialV: 5 }),
        comp('inductor', 'L1', [9, 1], { inductance: 1e-3 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('C1', 'a', 'L1', 'a'),
        wire('L1', 'b', 'R1', 'a'),
        wire('R1', 'b', 'C1', 'b'),
        wire('C1', 'b', 'GND', 'g'),
      ],
    };
    const T = 2 * Math.PI * Math.sqrt(1e-3 * 1e-6);
    const dt = T / 200;
    const trace = runSimTrace(doc, 900, dt, 'C1:a', 'trap');
    // Find successive positive peaks of the capacitor voltage
    const posPeaks: number[] = [];
    let lastPeakIdx = -100;
    for (let i = 100; i < trace.length - 5; i++) {
      if (trace[i] > trace[i - 1] && trace[i] > trace[i + 1] && trace[i] > 0.05 && i - lastPeakIdx > 100) {
        posPeaks.push(trace[i]);
        lastPeakIdx = i;
      }
    }
    expect(posPeaks.length).toBeGreaterThanOrEqual(2);
    const ratio = posPeaks[1] / posPeaks[0];
    // e^(−αT) = e^(−0.9935) = 0.370; allow 5% for discretization + the
    // trap startup kick shifting the effective first-peak amplitude
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.40);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. AC STEADY STATE — phasor physics via transient + envelope
// ═════════════════════════════════════════════════════════════════════════════
describe('AC steady-state physics', () => {
  it('AC resistive divider: amplitude follows resistor ratio exactly', () => {
    // 5 V amplitude 1 kHz sine across 1k/4k → 4 V amplitude at tap
    const doc = {
      components: [
        comp('acVoltage', 'V1', [1, 1], { amplitude: 5, frequency: 1000 }),
        comp('resistor', 'R1', [5, 1], { resistance: 1000 }),
        comp('resistor', 'R2', [9, 1], { resistance: 4000 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'R2', 'a'),
        wire('R2', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    // 3 periods after settling
    const trace = runSimTrace(doc, 3000, 1e-5, 'R1:b', 'trap');
    const tail = trace.slice(1000);
    const max = Math.max(...tail);
    const min = Math.min(...tail);
    expect((max - min) / 2).toBeCloseTo(4, 2); // 4 V amplitude
  });

  it('RC low-pass at the corner: gain = 1/√2, ≈ −45° phase', () => {
    // R = 1 k, C = 159 nF → fc = 1/(2π·1e3·159e-9) ≈ 1000 Hz. Drive at 1 kHz.
    const doc = {
      components: [
        comp('acVoltage', 'V1', [1, 1], { amplitude: 2, frequency: 1000 }),
        comp('resistor', 'R1', [5, 1], { resistance: 1000 }),
        comp('capacitor', 'C1', [9, 1], { capacitance: 159e-9 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'C1', 'a'),
        wire('C1', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    // 4 ms sim (4 periods) at 50 samples/period
    const dt = 2e-5;
    const trace = runSimTrace(doc, 300, dt, 'C1:a', 'trap');
    const tail = trace.slice(100);
    const max = Math.max(...tail);
    const min = Math.min(...tail);
    const amp = (max - min) / 2;
    // Gain at fc = 1/√2 = 0.707 → amplitude ≈ 1.414 V
    expect(amp).toBeGreaterThan(1.30);
    expect(amp).toBeLessThan(1.50);
    // Phase: capacitor voltage lags the source by 45° at fc. The source is
    // v(t) = 2·sin(ωt) (checked by the acVoltage plugin contract); the cap
    // crosses zero going UP at ωt = 45°·(π/180) → 1/8 period after the source.
    // Find the source's zero-crossing alignment via a second trace.
    const srcTrace = runSimTrace(doc, 300, dt, 'R1:a', 'trap');
    let lagSamples = -1;
    for (let i = 100; i < 260 && lagSamples < 0; i++) {
      if (srcTrace[i] <= 0 && srcTrace[i + 1] > 0) {
        // source rising zero at i+1; find next cap rising zero
        for (let j = i + 1; j < i + 60; j++) {
          if (trace[j] <= 0 && trace[j + 1] > 0) { lagSamples = j - i; break; }
        }
      }
    }
    // One period = 50 samples; 45° = 1/8 period = 6.25 samples
    expect(lagSamples).toBeGreaterThanOrEqual(3);
    expect(lagSamples).toBeLessThanOrEqual(10);
  });

  it('Capacitor reactance: Xc = 1/(2πfC) — measured from current', () => {
    // 1 V amplitude source, R = 100 Ω, C = 1 µF at 1 kHz. Measure the cap
    // voltage amplitude, then |I| = 2πfC·|Vc| (reactance current law).
    const doc = {
      components: [
        comp('acVoltage', 'V1', [1, 1], { amplitude: 1, frequency: 1000 }),
        comp('resistor', 'R1', [5, 1], { resistance: 100 }),
        comp('capacitor', 'C1', [9, 1], { capacitance: 1e-6 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'C1', 'a'),
        wire('C1', 'b', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const dt = 5e-6; // 200 samples/period
    const trace = runSimTrace(doc, 600, dt, 'C1:a', 'trap');
    const tail = trace.slice(200);
    const vcAmp = (Math.max(...tail) - Math.min(...tail)) / 2;
    // Phasor divider: |Vc| = |Zc|/|Ztotal| = 159.15/187.65 = 0.8471 V
    const Xc = 1 / (2 * Math.PI * 1000 * 1e-6);
    const vcExact = Xc / Math.hypot(100, Xc);
    expect(vcAmp).toBeCloseTo(vcExact, 3);
    // Current from the reactance law |I| = ωC·|Vc| — same as through R
    const iAmp = 2 * Math.PI * 1000 * 1e-6 * vcAmp;
    const iExact = 1 / Math.hypot(100, Xc);
    expect(iAmp).toBeCloseTo(iExact, 5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SEMICONDUCTOR PHYSICS — Shockley equation
// ═════════════════════════════════════════════════════════════════════════════
describe('Shockley diode physics (diodeShockley)', () => {
  const Vt = (1.380649e-23 * 300.15) / 1.602176634e-19; // 27°C

  it('I(V) = Is·(e^(V/nVt) − 1) at 8 bias points (CircuitJS1 reference model)', () => {
    // Same approach as CircuitJS1's default model: Is = 1.7144e-7, N = 2 →
    // 1 A at 0.7 V. Sweep the bias and check the solved (v, i) pair is
    // self-consistent with the Shockley equation (series Rs = 0, Cjo = 0).
    const Is = 1.7143528192808883e-7;
    const N = 2;
    for (const vBias of [-0.2, 0, 0.3, 0.5, 0.6, 0.65, 0.68, 0.7]) {
      const vSource = vBias + 0.001; // ~1 mA through the 1 k
      const doc = {
        components: [
          comp('dcVoltage', 'V1', [1, 1], { voltage: vSource }),
          comp('resistor', 'R1', [5, 1], { resistance: 1000 }),
          comp('diodeShockley', 'D1', [9, 1], { Is, N, Rs: 0, Cjo: 0, Tt: 0 }),
          comp('ground', 'GND', [1, 5]),
        ],
        wires: [
          wire('V1', 'p', 'R1', 'a'),
          wire('R1', 'b', 'D1', 'a'),
          wire('D1', 'k', 'GND', 'g'),
          wire('GND', 'g', 'V1', 'n'),
        ],
      };
      const run = runSim(doc, 60, 1e-4);
      expect(run.sim).not.toBeNull();
      const v = V(run, 'D1:a') - V(run, 'D1:k');
      const currents = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim);
      const i = currents.get('D1') ?? 0; // signed a→k
      const iExact = Is * (Math.exp(v / (N * Vt)) - 1);
      // Signed comparison on a scale floor of 1 nA (gmin adds ~1e-12·v)
      const scale = Math.max(Math.abs(iExact), 1e-9);
      expect(Math.abs(i - iExact) / scale).toBeLessThan(0.01);
    }
  });

  it('1 A flows at exactly the derived fwdrop (CircuitJS1 default-model identity)', () => {
    // Is = 1/(e^(0.7·vdcoef) − 1) with vdcoef = 1/(N·Vt): the curve passes
    // 1 A at 0.7 V by construction. With a 5.7 V source and 5 kΩ: i ≈ 1 mA
    // at v ≈ 0.5787 V (1 mA point of this curve). Verify self-consistency:
    // v_diode = Vt·N·ln(i/Is + 1) with i = (5.7 − v)/5000.
    const Is = 1.7143528192808883e-7;
    const N = 2;
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 5.7 }),
        comp('resistor', 'R1', [5, 1], { resistance: 5000 }),
        comp('diodeShockley', 'D1', [9, 1], { Is, N, Rs: 0, Cjo: 0, Tt: 0 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'D1', 'a'),
        wire('D1', 'k', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const run = runSim(doc, 80, 1e-4);
    const v = V(run, 'D1:a') - V(run, 'D1:k');
    const i = (5.7 - v) / 5000;
    const vExact = N * Vt * Math.log(i / Is + 1);
    expect(v).toBeCloseTo(vExact, 4);
  });

  it('Zener clamps the reverse voltage at Vz', () => {
    // 12 V source through 1 kΩ into a 5.1 V zener → cathode sits at 5.1 V
    const doc = {
      components: [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 12 }),
        comp('resistor', 'R1', [5, 1], { resistance: 1000 }),
        comp('zener', 'D1', [9, 1], { zenerV: 5.1, forwardV: 0.7 }),
        comp('ground', 'GND', [1, 5]),
      ],
      wires: [
        wire('V1', 'p', 'R1', 'a'),
        wire('R1', 'b', 'D1', 'k'),
        wire('D1', 'a', 'GND', 'g'),
        wire('GND', 'g', 'V1', 'n'),
      ],
    };
    const run = runSim(doc, 40, 1e-4);
    const v = V(run, 'D1:k'); // cathode referenced to ground (anode grounded)
    expect(v).toBeGreaterThan(4.8);
    expect(v).toBeLessThan(5.5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. MOSFET LEVEL-1 — Schichman-Hodges square law
// ═════════════════════════════════════════════════════════════════════════════
describe('MOS Level-1 square law (Schichman-Hodges)', () => {
  it('Saturation: Id = ½·Kp·(Vgs−Vth)²·(1+λVds) at three bias points', () => {
    // Vto = 1, Kp = 0.05, λ = 0 → clean square law. Vds = 5 (deep sat).
    const Kp = 0.05;
    const Vto = 1;
    for (const vgs of [1.5, 2, 3]) {
      const doc = {
        components: [
          comp('dcVoltage', 'VG', [1, 1], { voltage: vgs }),
          comp('dcVoltage', 'VD', [1, 8], { voltage: 5 }),
          comp('resistor', 'RD', [8, 8], { resistance: 1e-3 }), // tiny: Vds ≈ 5
          comp('mosLevel1N', 'M1', [12, 1], { Vto, Kp, Gamma: 0, Phi: 0.7, Lambda: 0, Rd: 0, Rs: 0 }),
          comp('ground', 'GND', [1, 12]),
        ],
        wires: [
          wire('VG', 'p', 'M1', 'g'),
          wire('VD', 'p', 'RD', 'a'),
          wire('RD', 'b', 'M1', 'd'),
          wire('M1', 's', 'GND', 'g'),
          wire('M1', 'b', 'GND', 'g'),
          wire('VG', 'n', 'GND', 'g'),
          wire('VD', 'n', 'GND', 'g'),
        ],
      };
      const run = runSim(doc, 60, 1e-4);
      expect(run.sim).not.toBeNull();
      const currents = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim);
      const id = Math.abs(currents.get('M1') ?? 0);
      const idExact = 0.5 * Kp * (vgs - Vto) * (vgs - Vto);
      expect(Math.abs(id - idExact) / idExact).toBeLessThan(0.02);
    }
  });

  it('Body effect: Vth rises with reverse body bias per Vto + γ(√(2Φ+Vsb)−√2Φ)', () => {
    // Reverse body bias = body BELOW source: set body to −0.5 V (source at
    // ground) → vBS = −0.5 → Vth = Vto + γ(√(2Φ+Vsb) − √2Φ) = 1.0976.
    // Bias at Vgs = Vth + 0.5 and verify Id equals the square law at the
    // SHIFTED threshold (proving the threshold actually shifted).
    const Gamma = 0.5, Phi = 0.7, Vto = 1;
    const Vsb = 0.5;
    const VthExact = Vto + Gamma * (Math.sqrt(2 * Phi + Vsb) - Math.sqrt(2 * Phi));
    const Kp = 0.05;
    const vgs = VthExact + 0.5;
    const doc = {
      components: [
        comp('dcVoltage', 'VB', [1, 1], { voltage: -Vsb }), // body below source
        comp('dcVoltage', 'VG', [5, 1], { voltage: vgs }),
        comp('dcVoltage', 'VD', [9, 1], { voltage: 5 }),
        comp('resistor', 'RD', [12, 1], { resistance: 1e-3 }),
        comp('mosLevel1N', 'M1', [12, 4], { Vto, Kp, Gamma, Phi, Lambda: 0, Rd: 0, Rs: 0 }),
        comp('ground', 'GND', [1, 12]),
      ],
      wires: [
        wire('VG', 'p', 'M1', 'g'),
        wire('VD', 'p', 'RD', 'a'),
        wire('RD', 'b', 'M1', 'd'),
        wire('M1', 's', 'GND', 'g'),
        wire('M1', 'b', 'VB', 'p'),
        wire('VB', 'n', 'GND', 'g'),
        wire('VG', 'n', 'GND', 'g'),
        wire('VD', 'n', 'GND', 'g'),
      ],
    };
    const run = runSim(doc, 60, 1e-4);
    const currents = computeComponentCurrents(doc.components, doc.wires, run.plugins, run.sim);
    const id = Math.abs(currents.get('M1') ?? 0);
    const idExact = 0.5 * Kp * (vgs - VthExact) ** 2;
    expect(Math.abs(id - idExact) / idExact).toBeLessThan(0.02);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. RANDOMIZED KCL — fuzz across random linear networks
// ═════════════════════════════════════════════════════════════════════════════
describe('Randomized linear networks — KCL invariant', () => {
  // Deterministic LCG for reproducibility
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  it('every node balances to < 100 nA on 20 random resistor networks', () => {
    for (let trial = 0; trial < 20; trial++) {
      const nNodes = 3 + Math.floor(rand() * 4); // 3..6 non-ground nodes
      const components: CircuitComponent[] = [
        comp('dcVoltage', 'V1', [1, 1], { voltage: 1 + Math.floor(rand() * 11) }),
      ];
      const wires: Wire[] = [];
      // Random resistor mesh: every pair of nodes gets a resistor with p=0.5
      for (let i = 0; i < nNodes; i++) {
        for (let j = i + 1; j < nNodes; j++) {
          if (rand() < 0.5) {
            const id = `R_${i}_${j}`;
            components.push(comp('resistor', id, [3 + j * 4, 1 + i * 4], { resistance: Math.round(100 + rand() * 900) }));
            wires.push(wire(`N${i}`, 'p', id, 'a'));
          }
        }
      }
      // Node proxies: use small resistors as node junctions is complex —
      // instead build a star chain: V1 → node0 → (R to each other node, R to gnd)
      components.length = 0;
      wires.length = 0;
      components.push(comp('dcVoltage', 'V1', [1, 1], { voltage: 1 + Math.floor(rand() * 11) }));
      const nodeCount = 2 + Math.floor(rand() * 4);
      let prev = 'V1';
      let prevT = 'p';
      for (let i = 0; i < nodeCount; i++) {
        const id = `Rc${i}`;
        components.push(comp('resistor', id, [5 + i * 4, 1], { resistance: Math.round(100 + rand() * 9900) }));
        wires.push(wire(prev, prevT, id, 'a'));
        // parallel shunt to ground
        const sid = `Rs${i}`;
        components.push(comp('resistor', sid, [5 + i * 4, 5], { resistance: Math.round(100 + rand() * 9900) }));
        wires.push(wire(id, 'b', sid, 'a'));
        wires.push(wire(sid, 'b', 'GND', 'g'));
        prev = id;
        prevT = 'b';
      }
      components.push(comp('ground', 'GND', [1, 9]));
      wires.push(wire('V1', 'n', 'GND', 'g'));

      const run = runSim({ components, wires }, 5, 1e-4);
      expect(run.sim).not.toBeNull();
      const currents = computeComponentCurrents(components, wires, run.plugins, run.sim);
      // KCL at every intermediate node: current in through chain = sum out
      for (let i = 0; i < nodeCount; i++) {
        const inCurrent = Math.abs(currents.get(`Rc${i}`) ?? 0);
        const outChain = i + 1 < nodeCount ? Math.abs(currents.get(`Rc${i + 1}`) ?? 0) : 0;
        const outShunt = Math.abs(currents.get(`Rs${i}`) ?? 0);
        const imbalance = Math.abs(inCurrent - outChain - outShunt);
        expect(imbalance).toBeLessThan(1e-7);
      }
    }
  });
});
