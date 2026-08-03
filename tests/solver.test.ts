// Unit tests for the MNA solver and engine core.
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, solveDC, computeComponentCurrents, computeWireCurrents, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

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

function getPlugins(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }
  return plugins;
}

function comp(type: string, id: string, pos: [number, number], params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params } };
}

function wire(id: string, fromC: string, fromT: string, toC: string, toT: string): Wire {
  return { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
}

function runDC(components: CircuitComponent[], wires: Wire[], steps = 20) {
  const plugins = getPlugins(components);
  for (const c of components) if (!c.simState) c.simState = {};
  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(components, wires, plugins, prev, 1e-4);
    if (!r) return null;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return sim;
}

describe('MNA Solver — basic DC', () => {
  it('solves a simple voltage divider', () => {
    const components = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runDC(components, wires);
    expect(sim).not.toBeNull();
    // V at midpoint should be 5V (voltage divider)
    const nodeMap = buildNodeMap(components, wires, getPlugins(components));
    const r1b = getTerminals(components, wires, 'r1', 'b', nodeMap);
    expect(sim.nodeVoltage[r1b]).toBeCloseTo(5.0, 1);
  });

  it('solves Ohm\'s law: I = V/R', () => {
    const components = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runDC(components, wires);
    expect(sim).not.toBeNull();
    const plugins = getPlugins(components);
    const compCurrents = computeComponentCurrents(components, wires, plugins, sim);
    const i = Math.abs(compCurrents.get('r1') ?? 0);
    expect(i).toBeCloseTo(0.005, 3); // 5V / 1000Ω = 5mA
  });

  it('handles parallel resistors: R = R1*R2/(R1+R2)', () => {
    const components = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 6 }),
      comp('resistor', 'r1', [4, 0], { resistance: 2000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 3000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w1b', 'v1', 'p', 'r2', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w2b', 'r2', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runDC(components, wires);
    expect(sim).not.toBeNull();
    const plugins = getPlugins(components);
    const compCurrents = computeComponentCurrents(components, wires, plugins, sim);
    // Total current = V / R_eq = 6 / (2000*3000/(2000+3000)) = 6 / 1200 = 5mA
    const i1 = Math.abs(compCurrents.get('r1') ?? 0);
    const i2 = Math.abs(compCurrents.get('r2') ?? 0);
    expect(i1 + i2).toBeCloseTo(0.005, 3);
  });

  it('handles current source', () => {
    const components = [
      comp('currentSource', 'i1', [0, 0], { current: 0.01 }),
      comp('resistor', 'r1', [4, 0], { resistance: 500 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'i1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'i1', 'n', 'gnd', 'g'),
    ];
    const sim = runDC(components, wires);
    expect(sim).not.toBeNull();
    // V = I * R = 0.01 * 500 = 5V (sign depends on current direction)
    const nodeMap = buildNodeMap(components, wires, getPlugins(components));
    const r1a = getTerminals(components, wires, 'r1', 'a', nodeMap);
    expect(Math.abs(sim.nodeVoltage[r1a])).toBeCloseTo(5.0, 1);
  });

  it('enforces KCL: currents sum to zero at a node', () => {
    const components = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 2000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w1b', 'v1', 'p', 'r2', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w2b', 'r2', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runDC(components, wires);
    expect(sim).not.toBeNull();
    const plugins = getPlugins(components);
    const wireCurrents = computeWireCurrents(components, wires, plugins, sim);
    // Current into node from v1 = current out through r1 + r2
    const iR1 = Math.abs(wireCurrents.get('w2') ?? 0);
    const iR2 = Math.abs(wireCurrents.get('w2b') ?? 0);
    const iV1 = Math.abs(wireCurrents.get('w1') ?? 0) + Math.abs(wireCurrents.get('w1b') ?? 0);
    expect(iR1 + iR2).toBeCloseTo(iV1, 4);
  });
});

describe('MNA Solver — edge cases', () => {
  it('handles empty circuit (no components)', () => {
    const sim = runDC([], []);
    // Should not crash, returns some sim (possibly null or minimal)
    // Just verify it doesn't throw
    expect(true).toBe(true);
  });

  it('handles single ground node', () => {
    const components = [comp('ground', 'gnd', [0, 0], {})];
    const sim = runDC(components, []);
    expect(sim).not.toBeNull();
    expect(sim.nodeVoltage[0]).toBe(0); // ground is always 0V
  });

  it('handles floating node (high impedance)', () => {
    const components = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    // r1.b is floating (not connected to ground)
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runDC(components, wires);
    // Should not crash — floating nodes should settle to some value
    expect(sim).not.toBeNull();
  });

  it('handles negative voltage source', () => {
    const components = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: -5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runDC(components, wires);
    expect(sim).not.toBeNull();
    // Current should be negative (reverse direction)
    const plugins = getPlugins(components);
    const compCurrents = computeComponentCurrents(components, wires, plugins, sim);
    const i = compCurrents.get('r1') ?? 0;
    expect(i).toBeLessThan(0); // negative current
  });
});

describe('MNA Solver — transient analysis', () => {
  it('capacitor charges over time', () => {
    const components = [
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
    const plugins = getPlugins(components);
    for (const c of components) if (!c.simState) c.simState = {};

    // Use larger dt for faster convergence (backward Euler is unconditionally stable)
    let prev: any = undefined;
    let sim: any = null;
    for (let i = 0; i < 500; i++) {
      const r = simulateStep(components, wires, plugins, prev, 1e-3); // dt=1ms (RC=1ms, so 1 step ≈ 1 RC)
      if (!r) break;
      sim = r.sim;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(sim).not.toBeNull();
    const nodeMap = buildNodeMap(components, wires, plugins);
    const c1a = getTerminals(components, wires, 'c1', 'a', nodeMap);
    const vCap = sim.nodeVoltage[c1a];
    // After several steps, capacitor should be partially charged
    expect(vCap).toBeGreaterThan(1.0); // at least some charging has occurred
  });

  it('inductor builds up current over time', () => {
    const components = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 100 }),
      comp('inductor', 'l1', [8, 0], { inductance: 1e-3 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'l1', 'a'),
      wire('w3', 'l1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const plugins = getPlugins(components);
    for (const c of components) if (!c.simState) c.simState = {};

    let prev: any = undefined;
    let sim: any = null;
    for (let i = 0; i < 500; i++) {
      const r = simulateStep(components, wires, plugins, prev, 1e-5);
      if (!r) break;
      sim = r.sim;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(sim).not.toBeNull();
    // After long time, inductor acts as short → I = V/R = 5/100 = 50mA
    const compCurrents = computeComponentCurrents(components, wires, plugins, sim);
    const i = Math.abs(compCurrents.get('l1') ?? 0);
    expect(i).toBeGreaterThan(0.04); // > 40mA (approaching 50mA)
  });
});

// Helper: get node ID for a terminal
function getTerminals(components: CircuitComponent[], wires: Wire[], compId: string, termId: string, nodeMap: any): number {
  const comp = components.find(c => c.id === compId)!;
  const plugin = getPlugin(comp.type)!;
  const terms = getTerminalsHelper(comp, plugin, nodeMap);
  return terms.find(t => t.terminalId === termId)?.nodeId ?? 0;
}

import { getTerminalsForComponent } from '../src/lib/circuit/engine';
function getTerminalsHelper(comp: CircuitComponent, plugin: ComponentPlugin, nodeMap: any) {
  return getTerminalsForComponent(comp, plugin, nodeMap);
}
