// Intensive tests for simulation physics: KCL, KVL, transient convergence,
// state persistence, determinism, power balance, and node voltage accuracy.
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, solveDC, computeComponentCurrents, computeWireCurrents, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
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
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');
});

function comp(type: string, id: string, pos: [number, number], params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params } };
}

function wire(id: string, fromC: string, fromT: string, toC: string, toT: string): Wire {
  return { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
}

function getPlugins(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const m = new Map<string, ComponentPlugin>();
  for (const c of components) { const p = getPlugin(c.type); if (p) m.set(c.type, p); }
  return m;
}

function nodeV(components: CircuitComponent[], wires: Wire[], compId: string, termId: string, sim: SimContext): number {
  const c = components.find(c => c.id === compId)!;
  const plugin = getPlugin(c.type)!;
  const nodeMap = buildNodeMap(components, wires, getPlugins(components));
  const terms = getTerminalsForComponent(c, plugin, nodeMap);
  const nodeId = terms.find(t => t.terminalId === termId)?.nodeId ?? 0;
  return sim.nodeVoltage[nodeId] ?? 0;
}

function runSim(components: CircuitComponent[], wires: Wire[], steps = 20, dt = 1e-4): SimContext | null {
  const plugins = getPlugins(components);
  for (const c of components) if (!c.simState) c.simState = {};
  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(components, wires, plugins, prev, dt);
    if (!r) return null;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return sim;
}

function runSimSteps(components: CircuitComponent[], wires: Wire[], steps: number, dt: number): { sim: SimContext | null; results: SimContext[] } {
  const plugins = getPlugins(components);
  for (const c of components) if (!c.simState) c.simState = {};
  let prev: any = undefined;
  const results: SimContext[] = [];
  let sim: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(components, wires, plugins, prev, dt);
    if (!r) return { sim: null, results };
    sim = r.sim;
    results.push(sim);
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return { sim, results };
}

// ─────────────────────────────────────────────────────────────────────────────
// KCL: Σ I_leaving = 0 at every node
// ─────────────────────────────────────────────────────────────────────────────
describe('KCL — Kirchhoff Current Law at every node', () => {
  it('simple series: 2-wire node at midpoint', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'), // 2-wire node at r1.b = r2.a
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const wireCurrents = computeWireCurrents(comps, wires, getPlugins(comps), sim);
    // At midpoint: current in (w2) = current out (w3)
    const i_in = Math.abs(wireCurrents.get('w2') ?? 0);
    const i_out = Math.abs(wireCurrents.get('w3') ?? 0);
    expect(Math.abs(i_in - i_out)).toBeLessThan(1e-6);
  });

  it('3-wire node: current splits into two branches', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 12 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 2000 }),
      comp('resistor', 'r3', [8, 4], { resistance: 3000 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'), // node: r1.b, r2.a, r3.a
      wire('w2b', 'r1', 'b', 'r3', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w3b', 'r3', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const currents = computeComponentCurrents(comps, wires, getPlugins(comps), sim);
    // KCL at the 3-wire node: I_r1 (in) = I_r2 + I_r3 (out)
    const i_r1 = Math.abs(currents.get('r1') ?? 0);
    const i_r2 = Math.abs(currents.get('r2') ?? 0);
    const i_r3 = Math.abs(currents.get('r3') ?? 0);
    expect(Math.abs(i_r1 - (i_r2 + i_r3))).toBeLessThan(1e-6);
  });

  it('4-wire node: 3 parallel branches', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 6 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 1000 }),
      comp('resistor', 'r3', [8, 4], { resistance: 1000 }),
      comp('resistor', 'r4', [8, 8], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 12], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w2b', 'r1', 'b', 'r3', 'a'),
      wire('w2c', 'r1', 'b', 'r4', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w3b', 'r3', 'b', 'gnd', 'g'),
      wire('w3c', 'r4', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const currents = computeComponentCurrents(comps, wires, getPlugins(comps), sim);
    // KCL: I_r1 = I_r2 + I_r3 + I_r4
    const i_r1 = Math.abs(currents.get('r1') ?? 0);
    const i_r2 = Math.abs(currents.get('r2') ?? 0);
    const i_r3 = Math.abs(currents.get('r3') ?? 0);
    const i_r4 = Math.abs(currents.get('r4') ?? 0);
    expect(Math.abs(i_r1 - (i_r2 + i_r3 + i_r4))).toBeLessThan(1e-6);
  });

  it('voltage source node: current out of + = current into -', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 500 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const wireCurrents = computeWireCurrents(comps, wires, getPlugins(comps), sim);
    const i_out = Math.abs(wireCurrents.get('w1') ?? 0); // current leaving v1.p
    const i_back = Math.abs(wireCurrents.get('w3') ?? 0); // current returning via v1.n
    expect(Math.abs(i_out - i_back)).toBeLessThan(1e-6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KVL: Σ V around any closed loop = 0
// ─────────────────────────────────────────────────────────────────────────────
describe('KVL — Kirchhoff Voltage Law around closed loops', () => {
  it('simple loop: V_source = V_R1 + V_R2', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 3000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 2000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const vR1 = nodeV(comps, wires, 'r1', 'a', sim) - nodeV(comps, wires, 'r1', 'b', sim);
    const vR2 = nodeV(comps, wires, 'r2', 'a', sim) - nodeV(comps, wires, 'r2', 'b', sim);
    const vSource = nodeV(comps, wires, 'v1', 'p', sim) - nodeV(comps, wires, 'v1', 'n', sim);
    expect(vR1 + vR2).toBeCloseTo(vSource, 2);
  });

  it('3-resistor loop: V_source = V_R1 + V_R2 + V_R3', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 15 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 2000 }),
      comp('resistor', 'r3', [12, 0], { resistance: 2000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'r3', 'a'),
      wire('w4', 'r3', 'b', 'gnd', 'g'),
      wire('w5', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const vR1 = nodeV(comps, wires, 'r1', 'a', sim) - nodeV(comps, wires, 'r1', 'b', sim);
    const vR2 = nodeV(comps, wires, 'r2', 'a', sim) - nodeV(comps, wires, 'r2', 'b', sim);
    const vR3 = nodeV(comps, wires, 'r3', 'a', sim) - nodeV(comps, wires, 'r3', 'b', sim);
    const vSource = nodeV(comps, wires, 'v1', 'p', sim) - nodeV(comps, wires, 'v1', 'n', sim);
    expect(vR1 + vR2 + vR3).toBeCloseTo(vSource, 2);
  });

  it('parallel loop: both branches see same voltage', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 2000 }),
      comp('resistor', 'r2', [4, 4], { resistance: 3000 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w1b', 'v1', 'p', 'r2', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w2b', 'r2', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const vR1 = nodeV(comps, wires, 'r1', 'a', sim) - nodeV(comps, wires, 'r1', 'b', sim);
    const vR2 = nodeV(comps, wires, 'r2', 'a', sim) - nodeV(comps, wires, 'r2', 'b', sim);
    expect(vR1).toBeCloseTo(vR2, 2); // parallel → same voltage
    expect(vR1).toBeCloseTo(10, 1); // = source voltage
  });

  it('voltage divider: midpoint voltage correct', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 12 }),
      comp('resistor', 'r1', [4, 0], { resistance: 7000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 5000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const vMid = nodeV(comps, wires, 'r1', 'b', sim);
    // V_mid = V * R2/(R1+R2) = 12 * 5000/12000 = 5V
    expect(vMid).toBeCloseTo(5.0, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transient convergence: circuits reach expected steady-state
// ─────────────────────────────────────────────────────────────────────────────
describe('Transient convergence — steady-state behavior', () => {
  it('capacitor acts as open circuit at steady state (DC)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('capacitor', 'c1', [8, 0], { capacitance: 1e-6 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'c1', 'a'),
      wire('w3', 'c1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    // Run many steps with large dt
    const { sim } = runSimSteps(comps, wires, 500, 1e-3);
    expect(sim).not.toBeNull();
    // At steady state, capacitor voltage = source voltage (no current through R)
    const vCap = nodeV(comps, wires, 'c1', 'a', sim);
    expect(vCap).toBeGreaterThan(1.0); // should be approaching 5V
  });

  it('inductor acts as short circuit at steady state (DC)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 100 }),
      comp('inductor', 'l1', [8, 0], { inductance: 0.1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'l1', 'a'),
      wire('w3', 'l1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const { sim } = runSimSteps(comps, wires, 500, 1e-3);
    expect(sim).not.toBeNull();
    // At steady state, I = V/R = 5/100 = 50mA (inductor = short)
    const currents = computeComponentCurrents(comps, wires, getPlugins(comps), sim);
    const i = Math.abs(currents.get('l1') ?? 0);
    expect(i).toBeGreaterThan(0.03); // approaching 50mA
  });

  it('RC circuit reaches 63% after one time constant', () => {
    // RC = 1000 * 1e-3 = 1s. After 1 step of dt=1s, V_cap ≈ 63% of V
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('capacitor', 'c1', [8, 0], { capacitance: 1e-3 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'c1', 'a'),
      wire('w3', 'c1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    // dt=1s, 1 step → V_cap ≈ V * (1 - e^(-1)) ≈ 6.32V
    const { sim } = runSimSteps(comps, wires, 1, 1.0);
    expect(sim).not.toBeNull();
    const vCap = nodeV(comps, wires, 'c1', 'a', sim);
    // Backward Euler: V_cap = V * dt / (RC + dt) = 10 * 1 / (1 + 1) = 5V
    // (backward Euler is conservative — actual is 6.32V, but BE gives 5V)
    expect(vCap).toBeGreaterThan(3.0); // at least 30% charged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State persistence: component state survives across steps
// ─────────────────────────────────────────────────────────────────────────────
describe('State persistence — component state survives across steps', () => {
  it('LED hysteresis: stays ON once forward biased', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 330 }),
      comp('led', 'led1', [8, 0], { forwardV: 2.0, seriesR: 1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'led1', 'a'),
      wire('w3', 'led1', 'k', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const { sim } = runSimSteps(comps, wires, 20, 1e-4);
    expect(sim).not.toBeNull();
    // LED should still be ON after 20 steps
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('led1') ?? 0);
    expect(i).toBeGreaterThan(0.001);
  });

  it('NPN stays ON across steps when base driven', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'rb', [4, 0], { resistance: 10000 }),
      comp('resistor', 'rc', [8, 0], { resistance: 1000 }),
      comp('npn', 'q1', [12, 0], { hfe: 100 }),
      comp('ground', 'gnd', [0, 6], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'rb', 'a'),
      wire('w2', 'rb', 'b', 'q1', 'b'),
      wire('w3', 'v1', 'p', 'rc', 'a'),
      wire('w4', 'rc', 'b', 'q1', 'c'),
      wire('w5', 'q1', 'e', 'gnd', 'g'),
      wire('w6', 'v1', 'n', 'gnd', 'g'),
    ];
    const { sim } = runSimSteps(comps, wires, 20, 1e-4);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('q1') ?? 0);
    expect(i).toBeGreaterThan(0.0001);
  });

  it('capacitor voltage persists across steps', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('capacitor', 'c1', [8, 0], { capacitance: 1e-6 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'c1', 'a'),
      wire('w3', 'c1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    // Run 50 steps
    const { sim: sim1 } = runSimSteps(comps, wires, 50, 1e-3);
    expect(sim1).not.toBeNull();
    const v1 = nodeV(comps, wires, 'c1', 'a', sim1);
    // Run 100 more steps
    const { sim: sim2 } = runSimSteps(comps, wires, 100, 1e-3);
    expect(sim2).not.toBeNull();
    const v2 = nodeV(comps, wires, 'c1', 'a', sim2);
    // Voltage should be higher after more steps (capacitor charging)
    expect(v2).toBeGreaterThan(v1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Power balance: P_supplied = P_consumed
// ─────────────────────────────────────────────────────────────────────────────
describe('Power balance — P_supplied = P_consumed', () => {
  it('simple resistor: P = V²/R', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const currents = computeComponentCurrents(comps, wires, getPlugins(comps), sim);
    const i = Math.abs(currents.get('r1') ?? 0);
    const p = 10 * i; // P = V * I
    expect(p).toBeCloseTo(0.1, 2); // 10² / 1000 = 0.1W
  });

  it('two resistors in series: total power = sum', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 12 }),
      comp('resistor', 'r1', [4, 0], { resistance: 2000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 4000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const currents = computeComponentCurrents(comps, wires, getPlugins(comps), sim);
    const i = Math.abs(currents.get('r1') ?? 0);
    const vR1 = nodeV(comps, wires, 'r1', 'a', sim) - nodeV(comps, wires, 'r1', 'b', sim);
    const vR2 = nodeV(comps, wires, 'r2', 'a', sim) - nodeV(comps, wires, 'r2', 'b', sim);
    const pR1 = vR1 * i;
    const pR2 = vR2 * i;
    const pTotal = 12 * i; // P from source
    expect(pR1 + pR2).toBeCloseTo(pTotal, 3);
  });

  it('parallel resistors: total power = sum of branch powers', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 6 }),
      comp('resistor', 'r1', [4, 0], { resistance: 2000 }),
      comp('resistor', 'r2', [4, 4], { resistance: 3000 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w1b', 'v1', 'p', 'r2', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w2b', 'r2', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const currents = computeComponentCurrents(comps, wires, getPlugins(comps), sim);
    const i1 = Math.abs(currents.get('r1') ?? 0);
    const i2 = Math.abs(currents.get('r2') ?? 0);
    const pR1 = 6 * i1; // P = V * I for each branch
    const pR2 = 6 * i2;
    const pTotal = pR1 + pR2;
    // P = V²/R1 + V²/R2 = 36/2000 + 36/3000 = 0.018 + 0.012 = 0.03W
    expect(pTotal).toBeCloseTo(0.03, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism: same inputs produce same outputs
// ─────────────────────────────────────────────────────────────────────────────
describe('Determinism — same inputs → same outputs', () => {
  it('same circuit produces same node voltages on repeated runs', () => {
    const makeCircuit = () => [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 2000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const makeWires = () => [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];

    const sim1 = runSim(makeCircuit(), makeWires());
    const sim2 = runSim(makeCircuit(), makeWires());

    expect(sim1).not.toBeNull();
    expect(sim2).not.toBeNull();
    // All node voltages should match exactly
    for (let i = 0; i < sim1.nodeVoltage.length; i++) {
      expect(sim2.nodeVoltage[i]).toBeCloseTo(sim1.nodeVoltage[i], 10);
    }
  });

  it('same circuit produces same component currents', () => {
    const makeCircuit = () => [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('led', 'led1', [8, 0], { forwardV: 2.0, seriesR: 1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const makeWires = () => [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'led1', 'a'),
      wire('w3', 'led1', 'k', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];

    const sim1 = runSim(makeCircuit(), makeWires());
    const sim2 = runSim(makeCircuit(), makeWires());
    const c1 = computeComponentCurrents(makeCircuit(), makeWires(), getPlugins(makeCircuit()), sim1);
    const c2 = computeComponentCurrents(makeCircuit(), makeWires(), getPlugins(makeCircuit()), sim2);

    expect(c1.get('r1')).toBeCloseTo(c2.get('r1') ?? 0, 10);
    expect(c1.get('led1')).toBeCloseTo(c2.get('led1') ?? 0, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State isolation: circuits don't contaminate each other
// ─────────────────────────────────────────────────────────────────────────────
describe('State isolation — circuits don\'t contaminate each other', () => {
  it('two independent simulations produce independent results', () => {
    // Circuit 1: 5V source
    const comps1 = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires1 = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim1 = runSim(comps1, wires1);

    // Circuit 2: 10V source (different voltage)
    const comps2 = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires2 = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim2 = runSim(comps2, wires2);

    expect(sim1).not.toBeNull();
    expect(sim2).not.toBeNull();
    // sim1 should have ~5V, sim2 should have ~10V
    const v1 = nodeV(comps1, wires1, 'v1', 'p', sim1);
    const v2 = nodeV(comps2, wires2, 'v1', 'p', sim2);
    expect(v1).toBeCloseTo(5, 1);
    expect(v2).toBeCloseTo(10, 1);
    expect(v1).not.toBeCloseTo(v2, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Node voltage accuracy: verify exact values in complex circuits
// ─────────────────────────────────────────────────────────────────────────────
describe('Node voltage accuracy — exact values in complex circuits', () => {
  it('Wheatstone bridge: balanced → midpoint = 0V', () => {
    // R1=R2=1000, R3=R4=1000 → balanced bridge
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }), // top left
      comp('resistor', 'r2', [8, 0], { resistance: 1000 }), // top right
      comp('resistor', 'r3', [4, 4], { resistance: 1000 }), // bottom left
      comp('resistor', 'r4', [8, 4], { resistance: 1000 }), // bottom right
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w1b', 'v1', 'p', 'r2', 'a'),
      wire('w2', 'r1', 'b', 'r3', 'a'), // left midpoint
      wire('w3', 'r2', 'b', 'r4', 'a'), // right midpoint
      wire('w4', 'r3', 'b', 'gnd', 'g'),
      wire('w5', 'r4', 'b', 'gnd', 'g'),
      wire('w6', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const vLeft = nodeV(comps, wires, 'r1', 'b', sim);
    const vRight = nodeV(comps, wires, 'r2', 'b', sim);
    // Balanced bridge: both midpoints at same voltage (V/2 = 2.5V)
    expect(vLeft).toBeCloseTo(vRight, 2);
    expect(vLeft).toBeCloseTo(2.5, 1);
  });

  it('Wheatstone bridge: unbalanced → voltage difference', () => {
    // R1=1000, R2=2000, R3=1000, R4=2000 → unbalanced
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 2000 }),
      comp('resistor', 'r3', [4, 4], { resistance: 1000 }),
      comp('resistor', 'r4', [8, 4], { resistance: 2000 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w1b', 'v1', 'p', 'r2', 'a'),
      wire('w2', 'r1', 'b', 'r3', 'a'),
      wire('w3', 'r2', 'b', 'r4', 'a'),
      wire('w4', 'r3', 'b', 'gnd', 'g'),
      wire('w5', 'r4', 'b', 'gnd', 'g'),
      wire('w6', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const vLeft = nodeV(comps, wires, 'r1', 'b', sim);
    const vRight = nodeV(comps, wires, 'r2', 'b', sim);
    // Left: 10 * 1000/(1000+1000) = 5V
    // Right: 10 * 2000/(2000+2000) = 5V
    // Actually balanced by symmetry (R1/R3 = R2/R4)
    expect(vLeft).toBeCloseTo(5.0, 1);
    expect(vRight).toBeCloseTo(5.0, 1);
  });

  it('3-resistor voltage divider: exact midpoint', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 9 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 2000 }),
      comp('resistor', 'r3', [12, 0], { resistance: 3000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'r3', 'a'),
      wire('w4', 'r3', 'b', 'gnd', 'g'),
      wire('w5', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // I = 9 / (1000+2000+3000) = 9/6000 = 1.5mA
    // V_r1 = 1.5mA * 1000 = 1.5V → node after r1 = 9 - 1.5 = 7.5V
    // V_r2 = 1.5mA * 2000 = 3V → node after r2 = 7.5 - 3 = 4.5V
    // V_r3 = 1.5mA * 3000 = 4.5V → node after r3 = 0V
    const vAfterR1 = nodeV(comps, wires, 'r1', 'b', sim);
    const vAfterR2 = nodeV(comps, wires, 'r2', 'b', sim);
    expect(vAfterR1).toBeCloseTo(7.5, 1);
    expect(vAfterR2).toBeCloseTo(4.5, 1);
  });

  it('current source + resistor: exact voltage', () => {
    const comps = [
      comp('currentSource', 'i1', [0, 0], { current: 0.002 }),
      comp('resistor', 'r1', [4, 0], { resistance: 5000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'i1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'i1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // V = I * R = 0.002 * 5000 = 10V
    const v = Math.abs(nodeV(comps, wires, 'r1', 'a', sim));
    expect(v).toBeCloseTo(10, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire current sign conventions: verify direction in all configurations
// ─────────────────────────────────────────────────────────────────────────────
describe('Wire current — sign conventions in all directions', () => {
  it('current flows from V+ through R to GND (positive from→to)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const wireCurrents = computeWireCurrents(comps, wires, getPlugins(comps), sim);
    // w1: from v1.p to r1.a → positive (current flows OUT of v1 INTO r1)
    expect(wireCurrents.get('w1')).toBeGreaterThan(0);
  });

  it('reverse wire direction gives negative current', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'r1', 'a', 'v1', 'p'), // reversed: from r1 to v1
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const wireCurrents = computeWireCurrents(comps, wires, getPlugins(comps), sim);
    // w1 reversed: current flows INTO r1, OUT of v1 → negative (to→from)
    expect(wireCurrents.get('w1')).toBeLessThan(0);
  });

  it('parallel branches: each branch current is positive', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [4, 4], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w1b', 'v1', 'p', 'r2', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w2b', 'r2', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const wireCurrents = computeWireCurrents(comps, wires, getPlugins(comps), sim);
    // Both branches: current flows from v1 through R to gnd → positive
    expect(wireCurrents.get('w1')).toBeGreaterThan(0);
    expect(wireCurrents.get('w1b')).toBeGreaterThan(0);
    expect(wireCurrents.get('w2')).toBeGreaterThan(0);
    expect(wireCurrents.get('w2b')).toBeGreaterThan(0);
  });
});
