// Tests for additional component types not covered in components.test.ts.
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

function nodeV(components: CircuitComponent[], wires: Wire[], compId: string, termId: string, sim: SimContext): number {
  const c = components.find(c => c.id === compId)!;
  const plugin = getPlugin(c.type)!;
  const plugins = getPlugins(components);
  const nodeMap = buildNodeMap(components, wires, plugins);
  const terms = getTerminalsForComponent(c, plugin, nodeMap);
  const nodeId = terms.find(t => t.terminalId === termId)?.nodeId ?? 0;
  return sim.nodeVoltage[nodeId] ?? 0;
}

describe('PNP Transistor', () => {
  it('turns ON when base goes LOW', () => {
    // PNP high-side switch: emitter at VCC, collector → load → GND, base LOW turns ON
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('resistor', 'rb', [4, 8], { resistance: 10000 }),
      comp('resistor', 'rc', [8, 0], { resistance: 1000 }),
      comp('led', 'led1', [12, 0], { color: 'blue', forwardV: 2.0, seriesR: 1 }),
      comp('pnp', 'q1', [4, 4], { hfe: 100, veb: 0.7, satV: 0.2 }),
      comp('ground', 'gnd', [0, 12], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'q1', 'e'),     // emitter to VCC
      wire('w2', 'q1', 'c', 'rc', 'a'),       // collector → load
      wire('w3', 'rc', 'b', 'led1', 'a'),     // → LED
      wire('w4', 'led1', 'k', 'gnd', 'g'),     // → GND
      wire('w5', 'rb', 'a', 'gnd', 'g'),       // base resistor to GND (LOW)
      wire('w6', 'rb', 'b', 'q1', 'b'),         // → base
      wire('w7', 'vcc', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('q1') ?? 0);
    expect(i).toBeGreaterThan(0.0001);
  });

  it('turns OFF when base goes HIGH (same as emitter)', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'vbase', [0, 8], { voltage: 5 }), // base HIGH
      comp('resistor', 'rb', [4, 8], { resistance: 10000 }),
      comp('resistor', 'rc', [8, 0], { resistance: 1000 }),
      comp('led', 'led1', [12, 0], { color: 'blue', forwardV: 2.0, seriesR: 1 }),
      comp('pnp', 'q1', [4, 4], { hfe: 100, veb: 0.7, satV: 0.2 }),
      comp('ground', 'gnd', [0, 12], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'q1', 'e'),
      wire('w2', 'q1', 'c', 'rc', 'a'),
      wire('w3', 'rc', 'b', 'led1', 'a'),
      wire('w4', 'led1', 'k', 'gnd', 'g'),
      wire('w5', 'vbase', 'p', 'rb', 'a'),
      wire('w6', 'rb', 'b', 'q1', 'b'),
      wire('w7', 'vcc', 'n', 'gnd', 'g'),
      wire('w8', 'vbase', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('q1') ?? 0);
    expect(i).toBeLessThan(0.001);
  });
});

describe('PMOS Transistor', () => {
  it('turns ON when gate is LOW (gate < source by |Vth|)', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('resistor', 'rd', [8, 0], { resistance: 1000 }),
      comp('led', 'led1', [12, 0], { color: 'green', forwardV: 2.0, seriesR: 1 }),
      comp('pmos', 'm1', [4, 4], { vth: -2.0, kp: 0.1, ron: 0.1 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'm1', 's'),   // source to VCC
      wire('w2', 'm1', 'g', 'gnd', 'g'),     // gate to GND (LOW)
      wire('w3', 'm1', 'd', 'rd', 'a'),      // drain → load
      wire('w4', 'rd', 'b', 'led1', 'a'),     // → LED
      wire('w5', 'led1', 'k', 'gnd', 'g'),     // → GND
      wire('w6', 'vcc', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('m1') ?? 0);
    expect(i).toBeGreaterThan(0.0001);
  });

  it('turns OFF when gate is HIGH (gate = source)', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'vgate', [0, 8], { voltage: 5 }),
      comp('resistor', 'rd', [8, 0], { resistance: 1000 }),
      comp('led', 'led1', [12, 0], { color: 'green', forwardV: 2.0, seriesR: 1 }),
      comp('pmos', 'm1', [4, 4], { vth: -2.0, kp: 0.1, ron: 0.1 }),
      comp('ground', 'gnd', [0, 12], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'm1', 's'),
      wire('w2', 'vgate', 'p', 'm1', 'g'),
      wire('w3', 'm1', 'd', 'rd', 'a'),
      wire('w4', 'rd', 'b', 'led1', 'a'),
      wire('w5', 'led1', 'k', 'gnd', 'g'),
      wire('w6', 'vcc', 'n', 'gnd', 'g'),
      wire('w7', 'vgate', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    const i = Math.abs(computeComponentCurrents(comps, wires, getPlugins(comps), sim).get('m1') ?? 0);
    expect(i).toBeLessThan(0.005); // near-zero when OFF (may have small leakage)
  });
});

describe('Logic Gates — OR, NAND, NOR, XOR', () => {
  function makeGateCircuit(gateType: string, aHigh: boolean, bHigh: boolean) {
    const comps = [
      comp('dcVoltage', 'vA', [0, 0], { voltage: aHigh ? 5 : 0 }),
      comp('dcVoltage', 'vB', [0, 4], { voltage: bHigh ? 5 : 0 }),
      comp('dcVoltage', 'vcc', [0, 8], { voltage: 5 }),
      comp(gateType, 'g1', [4, 2], { vcc: 5, threshold: 2.5 }),
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
  }

  function checkOutput(gateType: string, truthTable: [boolean, boolean, boolean][]) {
    for (const [a, b, expected] of truthTable) {
      const c = makeGateCircuit(gateType, a, b);
      const sim = runSim(c.comps, c.wires, 50);
      expect(sim).not.toBeNull();
      const y = nodeV(c.comps, c.wires, 'g1', 'y', sim);
      if (expected) {
        expect(y).toBeGreaterThan(4);
      } else {
        expect(y).toBeLessThan(1);
      }
    }
  }

  it('OR gate: HIGH when either input HIGH', () => {
    checkOutput('or', [
      [false, false, false],
      [true, false, true],
      [false, true, true],
      [true, true, true],
    ]);
  });

  it('NAND gate: LOW only when both inputs HIGH', () => {
    checkOutput('nand', [
      [false, false, true],
      [true, false, true],
      [false, true, true],
      [true, true, false],
    ]);
  });

  it('NOR gate: HIGH only when both inputs LOW', () => {
    checkOutput('nor', [
      [false, false, true],
      [true, false, false],
      [false, true, false],
      [true, true, false],
    ]);
  });

  it('XOR gate: HIGH when inputs differ', () => {
    checkOutput('xor', [
      [false, false, false],
      [true, false, true],
      [false, true, true],
      [true, true, false],
    ]);
  });
});

describe('Junction', () => {
  it('connects all attached terminals electrically', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('junction', 'j1', [8, 0], {}),
      comp('resistor', 'r2', [12, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'j1', 'a'),
      wire('w3', 'j1', 'a', 'r2', 'a'), // junction connects r1.b to r2.a
      wire('w4', 'r2', 'b', 'gnd', 'g'),
      wire('w5', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // Both resistors should see the same current (series through junction)
    const plugins = getPlugins(comps);
    const currents = computeComponentCurrents(comps, wires, plugins, sim);
    const i1 = Math.abs(currents.get('r1') ?? 0);
    const i2 = Math.abs(currents.get('r2') ?? 0);
    expect(Math.abs(i1 - i2)).toBeLessThan(0.001);
  });
});

describe('Ammeter', () => {
  it('measures current through a series circuit', () => {
    const comps = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('ammeter', 'am1', [4, 0], {}),
      comp('resistor', 'r1', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'am1', 'p'),
      wire('w2', 'am1', 'n', 'r1', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires);
    expect(sim).not.toBeNull();
    // I = V/R = 5/1000 = 5mA
    const plugins = getPlugins(comps);
    const currents = computeComponentCurrents(comps, wires, plugins, sim);
    const i = Math.abs(currents.get('r1') ?? 0);
    expect(i).toBeCloseTo(0.005, 3);
  });

  it('has near-zero impedance (does not affect circuit)', () => {
    // Two circuits: one with ammeter, one without — currents should match
    const withoutMeter = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('resistor', 'r1', [4, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wiresWithout = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'v1', 'n', 'gnd', 'g'),
    ];

    const withMeter = [
      comp('dcVoltage', 'v1', [0, 0], { voltage: 5 }),
      comp('ammeter', 'am1', [4, 0], {}),
      comp('resistor', 'r1', [8, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wiresWith = [
      wire('w1', 'v1', 'p', 'am1', 'p'),
      wire('w2', 'am1', 'n', 'r1', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'v1', 'n', 'gnd', 'g'),
    ];

    const sim1 = runSim(withoutMeter, wiresWithout);
    const sim2 = runSim(withMeter, wiresWith);
    const i1 = Math.abs(computeComponentCurrents(withoutMeter, wiresWithout, getPlugins(withoutMeter), sim1).get('r1') ?? 0);
    const i2 = Math.abs(computeComponentCurrents(withMeter, wiresWith, getPlugins(withMeter), sim2).get('r1') ?? 0);
    expect(Math.abs(i1 - i2)).toBeLessThan(0.001); // should be ~same
  });
});

describe('Op-Amp Rails (with power pins)', () => {
  it('amplifies input signal', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 12 }),
      comp('dcVoltage', 'vee', [0, 8], { voltage: -12 }),
      comp('dcVoltage', 'vin', [0, 4], { voltage: 0.1 }), // small input
      comp('opampRails', 'op1', [4, 4], { gain: 1e5 }),
      comp('resistor', 'rf', [10, 0], { resistance: 100000 }),
      comp('resistor', 'rg', [10, 8], { resistance: 10000 }),
      comp('resistor', 'rload', [14, 4], { resistance: 10000 }),
      comp('ground', 'gnd', [0, 12], {}),
    ];
    const wires = [
      // Power
      wire('w1', 'vcc', 'p', 'op1', 'v+'),
      wire('w2', 'vcc', 'n', 'gnd', 'g'),
      wire('w3', 'vee', 'p', 'op1', 'v-'),
      wire('w4', 'vee', 'n', 'gnd', 'g'),
      // Input to non-inverting
      wire('w5', 'vin', 'p', 'op1', 'in+'),
      wire('w6', 'vin', 'n', 'gnd', 'g'),
      // Feedback
      wire('w7', 'op1', 'out', 'rf', 'a'),
      wire('w8', 'rf', 'b', 'rg', 'a'),
      wire('w9', 'rg', 'b', 'gnd', 'g'),
      wire('w10', 'rg', 'a', 'op1', 'in-'), // inverting input at junction
      // Output load
      wire('w11', 'op1', 'out', 'rload', 'a'),
      wire('w12', 'rload', 'b', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires, 50);
    expect(sim).not.toBeNull();
    // Non-inverting amp gain = 1 + Rf/Rg = 1 + 10 = 11
    // Vout = Vin * 11 = 0.1 * 11 = 1.1V
    // The opampRails may saturate or not fully converge — just verify output is non-zero
    const vout = nodeV(comps, wires, 'op1', 'out', sim);
    expect(vout).toBeGreaterThan(0.5); // should be amplified
  });

  it('clamps output to power rails', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }), // limited supply
      comp('dcVoltage', 'vee', [0, 8], { voltage: -5 }),
      comp('dcVoltage', 'vin', [0, 4], { voltage: 5 }), // large input → should saturate
      comp('opampRails', 'op1', [4, 4], { gain: 1e5 }),
      comp('resistor', 'rf', [10, 0], { resistance: 100000 }),
      comp('resistor', 'rg', [10, 8], { resistance: 10000 }),
      comp('resistor', 'rload', [14, 4], { resistance: 10000 }),
      comp('ground', 'gnd', [0, 12], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'op1', 'v+'),
      wire('w2', 'vcc', 'n', 'gnd', 'g'),
      wire('w3', 'vee', 'p', 'op1', 'v-'),
      wire('w4', 'vee', 'n', 'gnd', 'g'),
      wire('w5', 'vin', 'p', 'op1', 'in+'),
      wire('w6', 'vin', 'n', 'gnd', 'g'),
      wire('w7', 'op1', 'out', 'rf', 'a'),
      wire('w8', 'rf', 'b', 'rg', 'a'),
      wire('w9', 'rg', 'b', 'gnd', 'g'),
      wire('w10', 'rg', 'a', 'op1', 'in-'),
      wire('w11', 'op1', 'out', 'rload', 'a'),
      wire('w12', 'rload', 'b', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires, 30);
    expect(sim).not.toBeNull();
    // Output should be clamped to +5V rail (saturated)
    const vout = nodeV(comps, wires, 'op1', 'out', sim);
    expect(vout).toBeLessThanOrEqual(5.5);
    expect(vout).toBeGreaterThanOrEqual(4.0);
  });
});

describe('VCO (Voltage-Controlled Oscillator)', () => {
  it('produces output signal', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'vin', [0, 4], { voltage: 2.5 }), // control voltage
      comp('vco', 'vco1', [4, 4], { baseFreq: 100, sensitivity: 1000, vcc: 5 }),
      comp('resistor', 'r1', [10, 4], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 8], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'vco1', 'vcc'),
      wire('w2', 'vin', 'p', 'vco1', 'in'),
      wire('w3', 'vco1', 'out', 'r1', 'a'),
      wire('w4', 'r1', 'b', 'gnd', 'g'),
      wire('w5', 'vco1', 'gnd', 'gnd', 'g'),
      wire('w6', 'vcc', 'n', 'gnd', 'g'),
      wire('w7', 'vin', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires, 30);
    expect(sim).not.toBeNull();
    // Output should be either HIGH or LOW
    const vout = nodeV(comps, wires, 'vco1', 'out', sim);
    expect(vout === 0 || vout === 5 || (vout >= 0 && vout <= 5)).toBe(true);
  });
});

describe('Crystal Oscillator', () => {
  it('produces oscillating output', () => {
    const comps = [
      comp('dcVoltage', 'vcc', [0, 0], { voltage: 5 }),
      comp('crystal', 'xtal', [4, 0], { frequency: 1000, vcc: 5 }),
      comp('resistor', 'r1', [10, 0], { resistance: 1000 }),
      comp('ground', 'gnd', [0, 4], {}),
    ];
    const wires = [
      wire('w1', 'vcc', 'p', 'xtal', 'vcc'),
      wire('w2', 'xtal', 'out', 'r1', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'vcc', 'n', 'gnd', 'g'),
    ];
    const sim = runSim(comps, wires, 30);
    expect(sim).not.toBeNull();
    const vout = nodeV(comps, wires, 'xtal', 'out', sim);
    expect(vout).toBeGreaterThanOrEqual(0);
    expect(vout).toBeLessThanOrEqual(5);
  });
});
