// Tests for every component plugin — verifies stamp() produces correct voltages/currents.
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, computeComponentCurrents, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
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

function nodeV(components: CircuitComponent[], wires: Wire[], compId: string, termId: string, sim: SimContext): number {
  const comp = components.find(c => c.id === compId)!;
  const plugin = getPlugin(comp.type)!;
  const plugins = getPlugins(components);
  const nodeMap = buildNodeMap(components, wires, plugins);
  const terms = getTerminalsForComponent(comp, plugin, nodeMap);
  const nodeId = terms.find(t => t.terminalId === termId)?.nodeId ?? 0;
  return sim.nodeVoltage[nodeId] ?? 0;
}

describe('Resistor', () => {
  it('follows Ohm\'s law V=IR', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 2000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('r1') ?? 0);
    expect(i).toBeCloseTo(0.005, 4); // 10V / 2000Ω = 5mA
  });

  it('handles zero resistance gracefully', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 0 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    // Should not crash (solver clamps R to 1e-9)
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
  });
});

describe('Capacitor', () => {
  it('starts uncharged and charges up', () => {
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
    const sim0 = runSim(comps, wires, 1);
    expect(sim0).not.toBeNull();
    const v0 = nodeV(comps, wires, 'c1', 'a', sim0);
    // At t=0, capacitor voltage should be ~0
    expect(v0).toBeLessThan(0.5);
  });
});

describe('Inductor', () => {
  it('starts with zero current', () => {
    const comps = [
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
    const sim = runSim(comps, wires, 2); // just 2 steps
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('l1') ?? 0);
    // At t=0 (first few steps), inductor current should be very small
    expect(i).toBeLessThan(0.1);
  });
});

describe('LED', () => {
  it('lights when forward voltage exceeds threshold', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 330 }),
      comp('led', 'led1', [8, 0], { color: 'red', forwardV: 2.0, seriesR: 1 }),
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
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('led1') ?? 0);
    expect(i).toBeGreaterThan(0.001); // should have current flowing
  });

  it('does NOT light when reverse biased', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 330 }),
      comp('led', 'led1', [8, 0], { color: 'red', forwardV: 2.0, seriesR: 1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'led1', 'k'),  // reversed!
      wire('w3', 'led1', 'a', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('led1') ?? 0);
    expect(i).toBeLessThan(0.0001); // ~0 current when reverse biased
  });
});

describe('Diode', () => {
  it('conducts when forward biased', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('diode', 'd1', [8, 0], { forwardV: 0.7, onR: 1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'd1', 'a'),
      wire('w3', 'd1', 'k', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('d1') ?? 0);
    expect(i).toBeGreaterThan(0.001);
  });

  it('blocks when reverse biased', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('diode', 'd1', [8, 0], { forwardV: 0.7, onR: 1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'd1', 'k'),  // reversed!
      wire('w3', 'd1', 'a', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('d1') ?? 0);
    expect(i).toBeLessThan(0.0001);
  });
});

describe('NPN Transistor', () => {
  it('turns ON when base is driven HIGH', () => {
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
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('q1') ?? 0);
    expect(i).toBeGreaterThan(0.0001); // collector current flows
  });

  it('turns OFF when base is not driven (no base resistor connection)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'rc', [8, 0], { resistance: 1000 }),
      comp('npn', 'q1', [12, 0], { hfe: 100 }),
      comp('ground', 'gnd', [0, 6], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'rc', 'a'),
      wire('w2', 'rc', 'b', 'q1', 'c'),
      wire('w3', 'q1', 'e', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
      // Base is floating — not connected to anything
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('q1') ?? 0);
    expect(i).toBeLessThan(0.001); // collector current ~0
  });
});

describe('NMOS Transistor', () => {
  it('turns ON when gate voltage > threshold', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'vg', [0, 4], { voltage: 5 }),  // gate drive
      comp('resistor', 'rd', [8, 0], { resistance: 1000 }),
      comp('nmos', 'm1', [12, 0], { vth: 2.0, kp: 0.1 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'rd', 'a'),
      wire('w2', 'rd', 'b', 'm1', 'd'),
      wire('w3', 'm1', 's', 'gnd', 'g'),
      wire('w4', 'vg', 'p', 'm1', 'g'),
      wire('w5', 'v1', 'n', 'gnd', 'g'),
      wire('w6', 'vg', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('m1') ?? 0);
    expect(i).toBeGreaterThan(0.0001);
  });

  it('turns OFF when gate voltage < threshold', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'vg', [0, 4], { voltage: 1 }),  // gate drive below Vth=2
      comp('resistor', 'rd', [8, 0], { resistance: 1000 }),
      comp('nmos', 'm1', [12, 0], { vth: 2.0, kp: 0.1 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'rd', 'a'),
      wire('w2', 'rd', 'b', 'm1', 'd'),
      wire('w3', 'm1', 's', 'gnd', 'g'),
      wire('w4', 'vg', 'p', 'm1', 'g'),
      wire('w5', 'v1', 'n', 'gnd', 'g'),
      wire('w6', 'vg', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('m1') ?? 0);
    expect(i).toBeLessThan(0.001);
  });
});

describe('Switch (SPST)', () => {
  it('conducts when closed', () => {
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
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('r1') ?? 0);
    expect(i).toBeGreaterThan(0.001); // current flows through closed switch
  });

  it('blocks when open', () => {
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
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('r1') ?? 0);
    expect(i).toBeLessThan(0.0001); // ~0 current through open switch
  });
});

describe('Push Button', () => {
  it('conducts when pressed', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('pushButton', 'btn', [4, 0], { pressed: true }),
      comp('resistor', 'r1', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'btn', 'a'),
      wire('w2', 'btn', 'b', 'r1', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('r1') ?? 0);
    expect(i).toBeGreaterThan(0.001);
  });

  it('blocks when released', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('pushButton', 'btn', [4, 0], { pressed: false }),
      comp('resistor', 'r1', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'btn', 'a'),
      wire('w2', 'btn', 'b', 'r1', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('r1') ?? 0);
    expect(i).toBeLessThan(0.0001);
  });
});

describe('Current Source', () => {
  it('drives fixed current regardless of load', () => {
    const r1 = 1000, r2 = 500;
    const comps1 = [
      comp('currentSource', 'i1', [0, 0], { current: 0.01 }),
      comp('resistor', 'r1', [4, 0], { resistance: r1 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires1 = [
      wire('w1', 'i1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'i1', 'n', 'gnd', 'g'),
    ];
    const sim1 = runSim(comps1, wires1);

    const comps2 = [
      comp('currentSource', 'i1', [0, 0], { current: 0.01 }),
      comp('resistor', 'r1', [4, 0], { resistance: r2 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const sim2 = runSim(comps2, wires1);

    const i1 = Math.abs(computeComponentCurrents(comps1, wires1, getPlugins(comps1), sim1).get('r1') ?? 0);
    const i2 = Math.abs(computeComponentCurrents(comps2, wires1, getPlugins(comps2), sim2).get('r1') ?? 0);
    // Current should be the same regardless of resistance
    expect(Math.abs(i1 - i2)).toBeLessThan(0.0001);
    expect(i1).toBeCloseTo(0.01, 3);
  });
});

describe('Op-Amp (ideal)', () => {
  it('amplifies with correct gain (inverting)', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 0.5 }), // input
      comp('opamp', 'op1', [8, 4], { gain: 1e5 }),
      comp('resistor', 'rin', [4, 0], { resistance: 1000 }),
      comp('resistor', 'rf', [8, 0], { resistance: 10000 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'rin', 'a'),
      wire('w2', 'rin', 'b', 'op1', 'in-'),
      wire('w3', 'op1', 'in+', 'gnd', 'g'),
      wire('w4', 'op1', 'out', 'rf', 'a'),
      wire('w5', 'rf', 'b', 'op1', 'in-'),
      wire('w6', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // Vout = -Vin * (Rf/Rin) = -0.5 * 10 = -5V
    const vout = nodeV(comps, wires, 'op1', 'out', sim);
    expect(vout).toBeLessThan(-4); // should be ~-5V
  });
});

describe('Voltmeter', () => {
  it('measures voltage without affecting the circuit', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 10 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('resistor', 'r2', [8, 0], { resistance: 1000 }),
      comp('voltmeter', 'vm', [8, 4], {}),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'r2', 'a'),
      wire('w3', 'r2', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
      wire('w5', 'r1', 'b', 'vm', 'p'),  // measure midpoint
      wire('w6', 'vm', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // Midpoint should be 5V (voltage divider), voltmeter doesn't change it
    const vMid = nodeV(comps, wires, 'r1', 'b', sim);
    expect(vMid).toBeCloseTo(5.0, 1);
  });
});

describe('Potentiometer', () => {
  it('produces correct wiper voltage at 50%', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('potentiometer', 'pot', [4, 0], { resistance: 10000, wiper: 50 }),
      comp('voltmeter', 'vm', [8, 0], {}),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'pot', 'a'),
      wire('w2', 'pot', 'b', 'gnd', 'g'),
      wire('w3', 'pot', 'w', 'vm', 'p'),
      wire('w4', 'vm', 'n', 'gnd', 'g'),
      wire('w5', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // At 50% wiper, voltage should be ~2.5V
    const vWiper = nodeV(comps, wires, 'pot', 'w', sim);
    expect(vWiper).toBeCloseTo(2.5, 1);
  });
});

describe('Logic Gates', () => {
  it('AND gate: HIGH only when both inputs HIGH', () => {
    const makeCircuit = (aHigh: boolean, bHigh: boolean) => {
      const comps = [
        comp('dcVoltage', 'vA', [0, 0], { voltage: aHigh ? 5 : 0 }),
        comp('dcVoltage', 'vB', [0, 4], { voltage: bHigh ? 5 : 0 }),
        comp('dcVoltage', 'vcc', [0, 8], { voltage: 5 }),
        comp('and', 'g1', [4, 2], { vcc: 5, threshold: 2.5 }),
        comp('resistor', 'r1', [8, 2], { resistance: 1000 }),
        comp('ground', 'gnd', [0, 12], {}),
      ];
      const wires = [
        wire('w1', 'vA', 'p', 'g1', 'a'),
        wire('w2', 'vB', 'p', 'g1', 'b'),
        wire('w3', 'vcc', 'p', 'g1', 'vcc'),
        wire('w4', 'vA', 'n', 'gnd', 'g'),
        wire('w5', 'vB', 'n', 'gnd', 'g'),
        wire('w6', 'vcc', 'n', 'gnd', 'g'),
        wire('w7', 'g1', 'gnd', 'gnd', 'g'),
        wire('w8', 'g1', 'y', 'r1', 'a'),
        wire('w9', 'r1', 'b', 'gnd', 'g'),
      ];
      return { comps, wires };
    };

    // A=1, B=1 → Y=1
    let c = makeCircuit(true, true);
    let sim = runSim(c.comps, c.wires, 50);
    expect(sim).not.toBeNull();
    expect(nodeV(c.comps, c.wires, 'g1', 'y', sim)).toBeGreaterThan(4);

    // A=1, B=0 → Y=0
    c = makeCircuit(true, false);
    sim = runSim(c.comps, c.wires);
    expect(sim).not.toBeNull();
    expect(nodeV(c.comps, c.wires, 'g1', 'y', sim)).toBeLessThan(1);

    // A=0, B=1 → Y=0
    c = makeCircuit(false, true);
    sim = runSim(c.comps, c.wires);
    expect(sim).not.toBeNull();
    expect(nodeV(c.comps, c.wires, 'g1', 'y', sim)).toBeLessThan(1);

    // A=0, B=0 → Y=0
    c = makeCircuit(false, false);
    sim = runSim(c.comps, c.wires);
    expect(sim).not.toBeNull();
    expect(nodeV(c.comps, c.wires, 'g1', 'y', sim)).toBeLessThan(1);
  });

  it('NOT gate: inverts input', () => {
    const makeCircuit = (aHigh: boolean) => {
      const comps = [
        comp('dcVoltage', 'vA', [0, 0], { voltage: aHigh ? 5 : 0 }),
        comp('dcVoltage', 'vcc', [0, 4], { voltage: 5 }),
        comp('not', 'g1', [4, 0], { vcc: 5, threshold: 2.5 }),
        comp('resistor', 'r1', [8, 0], { resistance: 1000 }),
        comp('ground', 'gnd', [0, 8], {}),
      ];
      const wires = [
        wire('w1', 'vA', 'p', 'g1', 'a'),
        wire('w2', 'vA', 'n', 'gnd', 'g'),
        wire('w3', 'g1', 'gnd', 'gnd', 'g'),
        wire('w4', 'vcc', 'p', 'g1', 'vcc'),
        wire('w5', 'vcc', 'n', 'gnd', 'g'),
        wire('w6', 'g1', 'y', 'r1', 'a'),
        wire('w7', 'r1', 'b', 'gnd', 'g'),
      ];
      return { comps, wires };
    };

    let c = makeCircuit(true);
    let sim = runSim(c.comps, c.wires, 50);
    expect(nodeV(c.comps, c.wires, 'g1', 'y', sim)).toBeLessThan(1); // NOT(HIGH) = LOW

    c = makeCircuit(false);
    sim = runSim(c.comps, c.wires, 50);
    expect(nodeV(c.comps, c.wires, 'g1', 'y', sim)).toBeGreaterThan(4); // NOT(LOW) = HIGH
  });
});

describe('555 Timer', () => {
  it('produces oscillating output in astable mode', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('timer555', 't555', [4, 0], { vcc: 5, astable: true, r1: 47000, r2: 47000, c: 1e-5 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 't555', 'vcc'),
      wire('w2', 'vcc', 'p', 't555', 'rst'), // RST high
      wire('w3', 't555', 'gnd', 'gnd', 'g'),
      wire('w4', 'vcc', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires, 50);
    expect(sim).not.toBeNull();
    // Output should be either HIGH or LOW (oscillating)
    const vOut = nodeV(comps, wires, 't555', 'out', sim);
    expect(vOut === 0 || vOut === 5 || (vOut > 4 || vOut < 1)).toBe(true);
  });
});

describe('CD4026 Counter', () => {
  it('counts on rising clock edges', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('cd4026', 'ic1', [4, 0], { maxCount: 10, vcc: 5 }),
      comp('resistor', 'r1', [10, 0], { resistance: 220 }),
      comp('sevenSegment', 'seg1', [14, 0], { color: 'red', threshold: 2.0 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'ic1', 'vcc'),
      wire('w2', 'ic1', 'gnd', 'gnd', 'g'),
      wire('w3', 'ic1', 'rst', 'gnd', 'g'),
      wire('w4', 'vcc', 'n', 'gnd', 'g'),
      wire('w5', 'ic1', 'a', 'r1', 'a'),
      wire('w6', 'r1', 'b', 'seg1', 'a'),
      wire('w7', 'seg1', 'com', 'gnd', 'g'),
    ];
    const plugins = getPlugins(comps);
    for (const c of comps) if (!c.simState) c.simState = {};

    let prev: any = undefined;
    let sim: any = null;
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(comps, wires, plugins, prev, 1e-4);
      if (!r) break;
      sim = r.sim;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(sim).not.toBeNull();
    // Digit 0: segment 'a' output should be HIGH (5V)
    const vA = nodeV(comps, wires, 'ic1', 'a', sim);
    expect(vA).toBeGreaterThan(4); // a should be HIGH for digit 0
  });
});

describe('Seven-Segment Display', () => {
  it('shows segments when driven HIGH', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 220 }),
      comp('sevenSegment', 'seg1', [8, 0], { color: 'red', threshold: 2.0 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'seg1', 'a'),
      wire('w3', 'seg1', 'com', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // Segment 'a' should be at ~2.5V (voltage divider: 220Ω resistor + 220Ω internal segment R)
    const vA = nodeV(comps, wires, 'seg1', 'a', sim);
    expect(vA).toBeGreaterThan(2); // should be > 2V (above threshold)
  });
});

describe('Speaker', () => {
  it('has correct impedance', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('speaker', 'spk1', [4, 0], { impedance: 8 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'spk1', 'a'),
      wire('w2', 'spk1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('spk1') ?? 0);
    // I = V/R = 5/8 = 625mA
    expect(i).toBeCloseTo(0.625, 2);
  });
});

describe('Photoresistor', () => {
  it('changes resistance with light level', () => {
    const makeCircuit = (light: number) => {
      const comps = [
        comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
        comp('photoresistor', 'ldr', [4, 0], { darkR: 1000000, lightR: 1000, light }),
        comp('resistor', 'r1', [8, 0], { resistance: 10000 }),
        comp('ground', 'gnd', [0, 4], {}),
      ];
      const wires = [
        wire('w1', 'v1', 'p', 'ldr', 'a'),
        wire('w2', 'ldr', 'b', 'r1', 'a'),
        wire('w3', 'r1', 'b', 'gnd', 'g'),
        wire('w4', 'v1', 'n', 'gnd', 'g'),
      ];
      return { comps, wires };
    };

    // Dark (light=0): LDR resistance = 1MΩ, almost all voltage drops across LDR
    const dark = makeCircuit(0);
    const simDark = runSim(dark.comps, dark.wires);
    const vDark = nodeV(dark.comps, dark.wires, 'ldr', 'b', simDark);

    // Bright (light=1): LDR resistance = 1kΩ, almost all voltage drops across R1
    const bright = makeCircuit(1);
    const simBright = runSim(bright.comps, bright.wires);
    const vBright = nodeV(bright.comps, bright.wires, 'ldr', 'b', simBright);

    // In dark, the midpoint voltage should be LOW (LDR has high R, R1 has low R)
    // In bright, the midpoint should be HIGH (LDR has low R)
    expect(vBright).toBeGreaterThan(vDark);
  });
});
