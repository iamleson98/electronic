// Scratch verification for diode turn-off + opampRails macromodel fixes.
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, computeComponentCurrents } from '../src/lib/circuit/engine';
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
function nodeOf(r: any, id: string, term: string): number {
  return r.sim.nodeVoltage[r.nodeMap.terminalNode.get(`${id}:${term}`)!];
}

describe('diode rectification', () => {
  it('half-wave rectifier blocks the negative half-cycle', () => {
    // 5V 50Hz sine -> diode -> 1k load. Output must stay >= -0.1V for the
    // whole cycle (before the fix the negative half passed at -5.7V).
    const comps = [
      comp('acVoltage', 'VS', { voltage: 0, amplitude: 5, frequency: 50 }),
      comp('diode', 'D1', { forwardV: 0.7, onR: 1 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'D1', 'a'),
      wire('w2', 'D1', 'k', 'RL', 'a'),
      wire('w3', 'RL', 'b', 'GND', 'g'),
      wire('w4', 'VS', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    let minOut = Infinity, maxOut = -Infinity;
    const dt = 1e-4;
    // two full cycles
    for (let i = 0; i < 400; i++) {
      const r = simulateStep(comps, ws, p, prev, dt);
      expect(r).not.toBeNull();
      const out = nodeOf(r!, 'D1', 'k');
      minOut = Math.min(minOut, out);
      maxOut = Math.max(maxOut, out);
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    // blocks reverse: output never goes meaningfully negative
    expect(minOut).toBeGreaterThan(-0.1);
    // passes forward: output peaks near 5 - 0.7 = 4.3V
    expect(maxOut).toBeGreaterThan(3.8);
    expect(maxOut).toBeLessThan(4.8);
  });

  it('full-cycle check: diode current never reverses', () => {
    const comps = [
      comp('acVoltage', 'VS', { voltage: 0, amplitude: 5, frequency: 50 }),
      comp('diode', 'D1', { forwardV: 0.7, onR: 1 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'D1', 'a'),
      wire('w2', 'D1', 'k', 'RL', 'a'),
      wire('w3', 'RL', 'b', 'GND', 'g'),
      wire('w4', 'VS', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    let minI = Infinity;
    const dt = 1e-4;
    for (let i = 0; i < 400; i++) {
      const r = simulateStep(comps, ws, p, prev, dt);
      const ic = computeComponentCurrents(comps, ws, p, r!.sim);
      minI = Math.min(minI, ic.get('D1') ?? 0);
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    // element current may touch ~0 but never flow backward meaningfully
    expect(minI).toBeGreaterThan(-1e-6);
  });
});

describe('opampRails macromodel', () => {
  it('voltage follower with wired rails tracks the input', () => {
    // ±12V rails, 2V input, follower: Vout ≈ 2.000V (before: rail-slamming)
    const comps = [
      comp('dcVoltage', 'VP', { voltage: 12 }),
      comp('dcVoltage', 'VN', { voltage: -12 }),
      comp('dcVoltage', 'VIN', { voltage: 2 }),
      comp('opampRails', 'U1', { gain: 1e5 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VP', 'p', 'U1', 'v+'),
      wire('w2', 'VN', 'p', 'U1', 'v-'),
      wire('w3', 'VIN', 'p', 'U1', 'in+'),
      wire('w4', 'U1', 'out', 'U1', 'in-'), // follower feedback
      wire('w5', 'VP', 'n', 'GND', 'g'),
      wire('w6', 'VN', 'n', 'GND', 'g'),
      wire('w7', 'VIN', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    let last: any = null;
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-4);
      expect(r).not.toBeNull();
      last = r;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    const vout = nodeOf(last, 'U1', 'out');
    expect(vout).toBeCloseTo(2.0, 2);
  });

  it('non-inverting amplifier gain = 1 + Rf/Rg converges exactly', () => {
    // Gain 11 stage: Rf=10k, Rg=1k, VIN=0.5V → Vout = 5.5V
    const comps = [
      comp('dcVoltage', 'VP', { voltage: 12 }),
      comp('dcVoltage', 'VN', { voltage: -12 }),
      comp('dcVoltage', 'VIN', { voltage: 0.5 }),
      comp('opampRails', 'U1', { gain: 1e5 }),
      comp('resistor', 'RF', { resistance: 10000 }),
      comp('resistor', 'RG', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VP', 'p', 'U1', 'v+'),
      wire('w2', 'VN', 'p', 'U1', 'v-'),
      wire('w3', 'VIN', 'p', 'U1', 'in+'),
      wire('w4', 'U1', 'out', 'RF', 'a'),
      wire('w5', 'RF', 'b', 'U1', 'in-'),
      wire('w6', 'U1', 'in-', 'RG', 'a'),
      wire('w7', 'RG', 'b', 'GND', 'g'),
      wire('w8', 'VP', 'n', 'GND', 'g'),
      wire('w9', 'VN', 'n', 'GND', 'g'),
      wire('w10', 'VIN', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    let last: any = null;
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-4);
      expect(r).not.toBeNull();
      last = r;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    const vout = nodeOf(last, 'U1', 'out');
    expect(vout).toBeCloseTo(5.5, 2);
  });

  it('saturates at the rails when open-loop', () => {
    // No feedback, +1V on in+: open-loop gain slams to the +rail (11.5V)
    const comps = [
      comp('dcVoltage', 'VP', { voltage: 12 }),
      comp('dcVoltage', 'VN', { voltage: -12 }),
      comp('dcVoltage', 'VIN', { voltage: 1 }),
      comp('opampRails', 'U1', { gain: 1e5 }),
      comp('resistor', 'RL', { resistance: 10000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VP', 'p', 'U1', 'v+'),
      wire('w2', 'VN', 'p', 'U1', 'v-'),
      wire('w3', 'VIN', 'p', 'U1', 'in+'),
      wire('w4', 'U1', 'in-', 'GND', 'g'),
      wire('w5', 'U1', 'out', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'VP', 'n', 'GND', 'g'),
      wire('w8', 'VN', 'n', 'GND', 'g'),
      wire('w9', 'VIN', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    let last: any = null;
    for (let i = 0; i < 12; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-4);
      expect(r).not.toBeNull();
      last = r;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    const vout = nodeOf(last, 'U1', 'out');
    // 11.5V Thevenin through rout=100Ω into the 10k load:
    // 11.5 · 10000/10100 = 11.386V (output droop under load is physical)
    expect(vout).toBeCloseTo(11.5 * 10000 / 10100, 1);
  });
});
