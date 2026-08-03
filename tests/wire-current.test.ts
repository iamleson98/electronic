// Tests for wire current computation and node map building.
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, computeComponentCurrents, computeWireCurrents, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
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
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return plugins;
}

function runSim(components: CircuitComponent[], wires: Wire[], steps = 20): SimContext | null {
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

describe('Wire Current — series circuits', () => {
  it('all wires in a series circuit carry the same |current|', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('led', 'led1', [8, 0], { forwardV: 2.0, seriesR: 1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'led1', 'a'),
      wire('w3', 'led1', 'k', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const plugins = getPlugins(comps);
    const wireCurrents = computeWireCurrents(comps, wires, plugins, sim);
    const i1 = Math.abs(wireCurrents.get('w1') ?? 0);
    const i2 = Math.abs(wireCurrents.get('w2') ?? 0);
    const i3 = Math.abs(wireCurrents.get('w3') ?? 0);
    // All should be approximately equal (series circuit)
    expect(Math.abs(i1 - i2) / Math.max(i1, 1e-12)).toBeLessThan(0.05);
    expect(Math.abs(i2 - i3) / Math.max(i2, 1e-12)).toBeLessThan(0.05);
  });

  it('wire current sign indicates direction (from→to = positive)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'), // current flows from v1 to r1 (positive)
      wire('w2', 'r1', 'b', 'gnd', 'g'), // current flows from r1 to gnd (positive)
      wire('w3', 'v1', 'n', 'gnd', 'g'), // current flows from gnd to v1.n (negative or reversed)
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const plugins = getPlugins(comps);
    const wireCurrents = computeWireCurrents(comps, wires, plugins, sim);
    // Current should flow from v1.p through r1 to gnd
    const i1 = wireCurrents.get('w1') ?? 0;
    expect(i1).toBeGreaterThan(0); // from v1 to r1 → positive
  });
});

describe('Wire Current — parallel circuits', () => {
  it('total current splits across parallel branches', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 2000 }),
      comp('resistor', 'r2', [4, 4], { resistance: 2000 }),
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
    const plugins = getPlugins(comps);
    const wireCurrents = computeWireCurrents(comps, wires, plugins, sim);
    // Each branch: I = 10/2000 = 5mA. Total = 10mA
    const i1 = Math.abs(wireCurrents.get('w2') ?? 0);
    const i2 = Math.abs(wireCurrents.get('w2b') ?? 0);
    expect(i1).toBeCloseTo(0.005, 3);
    expect(i2).toBeCloseTo(0.005, 3);
    // Total current through source
    const iTotal = Math.abs(wireCurrents.get('w1') ?? 0) + Math.abs(wireCurrents.get('w1b') ?? 0);
    expect(iTotal).toBeCloseTo(0.01, 3);
  });
});

describe('Node Map — terminal to node assignment', () => {
  it('assigns ground to node 0', () => {
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
    const plugins = getPlugins(comps);
    const nodeMap = buildNodeMap(comps, wires, plugins);
    const gnd = comps.find(c => c.id === 'gnd')!;
    const gndPlugin = plugins.get('ground')!;
    const gndTerms = getTerminalsForComponent(gnd, gndPlugin, nodeMap);
    const gndNode = gndTerms.find(t => t.terminalId === 'g')?.nodeId ?? -1;
    expect(gndNode).toBe(0); // ground is always node 0
  });

  it('assigns the same node to connected terminals', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'), // v1.p and r1.a should be same node
      wire('w2', 'r1', 'b', 'gnd', 'g'), // r1.b and gnd.g should be same node
      wire('w3', 'v1', 'n', 'gnd', 'g'), // v1.n and gnd.g should be same node
    ];
    const plugins = getPlugins(comps);
    const nodeMap = buildNodeMap(comps, wires, plugins);
    const v1Terms = getTerminalsForComponent(comps[0], plugins.get('dcVoltage')!, nodeMap);
    const r1Terms = getTerminalsForComponent(comps[1], plugins.get('resistor')!, nodeMap);
    const gndTerms = getTerminalsForComponent(comps[2], plugins.get('ground')!, nodeMap);

    const v1p = v1Terms.find(t => t.terminalId === 'p')?.nodeId;
    const r1a = r1Terms.find(t => t.terminalId === 'a')?.nodeId;
    expect(v1p).toBe(r1a); // connected terminals share a node

    const v1n = v1Terms.find(t => t.terminalId === 'n')?.nodeId;
    const gndG = gndTerms.find(t => t.terminalId === 'g')?.nodeId;
    expect(v1n).toBe(gndG); // v1.n connected to gnd
    expect(gndG).toBe(0); // ground is node 0
  });

  it('assigns different nodes to unconnected terminals', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'), // r1.b and r2.a are same node
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const plugins = getPlugins(comps);
    const nodeMap = buildNodeMap(comps, wires, plugins);
    const r1Terms = getTerminalsForComponent(comps[1], plugins.get('resistor')!, nodeMap);
    const r2Terms = getTerminalsForComponent(comps[2], plugins.get('resistor')!, nodeMap);
    const r1a = r1Terms.find(t => t.terminalId === 'a')?.nodeId;
    const r1b = r1Terms.find(t => t.terminalId === 'b')?.nodeId;
    const r2a = r2Terms.find(t => t.terminalId === 'a')?.nodeId;
    expect(r1a).not.toBe(r1b); // different nodes (different sides of resistor)
    expect(r1b).toBe(r2a); // connected → same node
  });

  it('handles components with no wires (floating terminals)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'n', 'gnd', 'g'),
    ];
    const plugins = getPlugins(comps);
    const nodeMap = buildNodeMap(comps, wires, plugins);
    // v1.p is floating (no wire) → gets assigned to a node
    // Unconnected terminals default to node 0 (ground) in the node map builder
    const v1Terms = getTerminalsForComponent(comps[0], plugins.get('dcVoltage')!, nodeMap);
    const v1p = v1Terms.find(t => t.terminalId === 'p')?.nodeId;
    expect(v1p).toBeDefined();
    expect(v1p).toBeGreaterThanOrEqual(0); // valid node ID (may be 0 = ground if unconnected)
  });
});

describe('Component Currents — sign conventions', () => {
  it('resistor current flows a→b (positive = forward)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'), // v1.p → r1.a (HIGH side)
      wire('w2', 'r1', 'b', 'gnd', 'g'), // r1.b → gnd (LOW side)
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const plugins = getPlugins(comps);
    const currents = computeComponentCurrents(comps, wires, plugins, sim);
    const i = currents.get('r1') ?? 0;
    // Current flows from a (high) to b (low) → positive
    expect(i).toBeGreaterThan(0);
  });

  it('voltage source current is positive when sourcing (current flows out of +)', () => {
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
    const plugins = getPlugins(comps);
    const currents = computeComponentCurrents(comps, wires, plugins, sim);
    const i = currents.get('v1') ?? 0;
    // Current flows out of + terminal → positive
    expect(i).toBeGreaterThan(0);
  });
});
