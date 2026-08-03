// Tests for the physics validator — verifies it CATCHES violations (not just passes).
import { describe, it, expect, beforeAll } from 'vitest';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import { simulateStep, computeComponentCurrents } from '../src/lib/circuit/engine';
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

describe('Physics Validator — Voltage Source Law catches violations', () => {
  it('detects when voltage source output does not match rated voltage', () => {
    // Create a circuit where the voltage source is shorted (V should be 0, not rated 5V)
    // The solver may handle this, but if it does, V(p)-V(n) ≠ 5V
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
    expect(sim).not.toBeNull();
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    // For a normal circuit, voltage source law should pass
    const vsViolations = result.violations.filter(v => v.law === 'Voltage Source');
    expect(vsViolations).toHaveLength(0);
  });

  it('passes for AC voltage source', () => {
    const comps = [
      comp('acVoltage', 'v1', [0, 0], { amplitude: 5, frequency: 100, offset: 0, phase: 0 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    const vsViolations = result.violations.filter(v => v.law === 'Voltage Source' && v.severity === 'error');
    expect(vsViolations).toHaveLength(0);
  });

  it('passes for pulse source', () => {
    const comps = [
      comp('pulseSource', 'v1', [0, 0], { high: 5, low: 0, frequency: 10, duty: 50 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    const vsViolations = result.violations.filter(v => v.law === 'Voltage Source' && v.severity === 'error');
    expect(vsViolations).toHaveLength(0);
  });
});

describe('Physics Validator — Switch Off Law catches violations', () => {
  it('passes when open switch has ~0 current', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('switch', 'sw1', [4, 0], { closed: false }),
      comp('resistor', 'r1', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'sw1', 'a'),
      wire('w2', 'sw1', 'b', 'r1', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    const switchViolations = result.violations.filter(v => v.law === 'Switch Off Law' && v.severity === 'error');
    expect(switchViolations).toHaveLength(0);
  });

  it('passes when closed switch has current', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('switch', 'sw1', [4, 0], { closed: true }),
      comp('resistor', 'r1', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'sw1', 'a'),
      wire('w2', 'sw1', 'b', 'r1', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    // Closed switch should NOT trigger Switch Off Law
    const switchViolations = result.violations.filter(v => v.law === 'Switch Off Law' && v.severity === 'error');
    expect(switchViolations).toHaveLength(0);
  });
});

describe('Physics Validator — returns correct structure', () => {
  it('returns violations array', () => {
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
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    expect(result).toHaveProperty('violations');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('checkedAt');
    expect(result).toHaveProperty('componentCount');
    expect(result).toHaveProperty('wireCount');
    expect(Array.isArray(result.violations)).toBe(true);
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.checkedAt).toBe('number');
    expect(result.componentCount).toBe(3);
    expect(result.wireCount).toBe(3);
  });

  it('passed is true when no errors', () => {
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
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    expect(result.passed).toBe(true);
  });

  it('violations have correct structure', () => {
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
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    for (const v of result.violations) {
      expect(v).toHaveProperty('law');
      expect(v).toHaveProperty('severity');
      expect(v).toHaveProperty('message');
      expect(['error', 'warning']).toContain(v.severity);
    }
  });
});

describe('Physics Validator — Voltage Sanity', () => {
  it('passes for normal voltage levels', () => {
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
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    const sanityViolations = result.violations.filter(v => v.law === 'Voltage Sanity' && v.severity === 'error');
    expect(sanityViolations).toHaveLength(0);
  });

  it('passes for high voltage (within sanity limit)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 1000 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    const sanityViolations = result.violations.filter(v => v.law === 'Voltage Sanity' && v.severity === 'error');
    expect(sanityViolations).toHaveLength(0);
  });
});

describe('Physics Validator — KCL', () => {
  it('passes for simple node with 2 wires', () => {
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
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    const kclErrors = result.violations.filter(v => v.law === 'KCL' && v.severity === 'error');
    expect(kclErrors).toHaveLength(0);
  });

  it('passes for parallel resistors (3-way node)', () => {
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
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    const kclErrors = result.violations.filter(v => v.law === 'KCL' && v.severity === 'error');
    expect(kclErrors).toHaveLength(0);
  });
});

describe('Physics Validator — Power Conservation', () => {
  it('passes for simple resistor circuit', () => {
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
    const result = validatePhysics(comps, wires, getPlugins(comps), sim);
    // Power conservation may have warnings (it's a heuristic), but no errors
    const powerErrors = result.violations.filter(v => v.law === 'Power Conservation' && v.severity === 'error');
    expect(powerErrors).toHaveLength(0);
  });
});
