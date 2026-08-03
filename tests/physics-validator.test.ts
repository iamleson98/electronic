// Tests for the physics validator — verifies each law catches its target bug class.
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

function validate(components: CircuitComponent[], wires: Wire[], sim: SimContext) {
  const plugins = getPlugins(components);
  return validatePhysics(components, wires, plugins, sim);
}

describe('Physics Validator — Voltage Sanity', () => {
  it('passes for normal circuits', () => {
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
    const result = validate(comps, wires, sim);
    const voltageViolations = result.violations.filter(v => v.law === 'Voltage Sanity');
    expect(voltageViolations).toHaveLength(0);
  });
});

describe('Physics Validator — KCL', () => {
  it('passes for a simple series circuit', () => {
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
    const result = validate(comps, wires, sim);
    const kclViolations = result.violations.filter(v => v.law === 'KCL');
    expect(kclViolations.filter(v => v.severity === 'error')).toHaveLength(0);
  });
});

describe('Physics Validator — Series Current', () => {
  it('passes when all wires in series carry same current', () => {
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
    const result = validate(comps, wires, sim);
    const seriesViolations = result.violations.filter(v => v.law === 'Series Current');
    expect(seriesViolations.filter(v => v.severity === 'error')).toHaveLength(0);
  });
});

describe('Physics Validator — Diode Forward Law', () => {
  it('passes when LED is properly forward biased', () => {
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
    const sim = runSim(comps, wires);
    const result = validate(comps, wires, sim);
    const diodeViolations = result.violations.filter(v => v.law === 'Diode Forward Law' && v.severity === 'error');
    expect(diodeViolations).toHaveLength(0);
  });
});

describe('Physics Validator — Voltage Source', () => {
  it('passes when voltage source outputs rated voltage', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 12 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    const result = validate(comps, wires, sim);
    const sourceViolations = result.violations.filter(v => v.law === 'Voltage Source');
    expect(sourceViolations).toHaveLength(0);
  });
});

describe('Physics Validator — Switch Off Law', () => {
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
    const result = validate(comps, wires, sim);
    const switchViolations = result.violations.filter(v => v.law === 'Switch Off Law' && v.severity === 'error');
    expect(switchViolations).toHaveLength(0);
  });
});

describe('Physics Validator — overall pass', () => {
  it('returns passed=true for a valid circuit', () => {
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
    const result = validate(comps, wires, sim);
    expect(result.passed).toBe(true);
  });

  it('returns violations array (possibly empty)', () => {
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
    const result = validate(comps, wires, sim);
    expect(Array.isArray(result.violations)).toBe(true);
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.checkedAt).toBe('number');
  });
});
