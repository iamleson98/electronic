// Capacitor charge/discharge visualization — physics-accurate current-flow
// direction + plate charge rendering state.
//
// What the user sees while the sim runs (Falstad/EveryCircuit conventions):
//   • CHARGING: current dots flow INTO the positive plate and OUT of the
//     negative plate (never through the dielectric); the plates glow and
//     pulse at a rate ∝ |I|, + marks accumulate on the + plate, − on −.
//   • DISCHARGING: dots reverse (OUT of the + plate, INTO the − plate) and
//     the glow dims as the stored energy drains.
//
// Tests cover:
//   1. capacitorChargeVisuals — the pure (V, I, t) → visual-state mapping
//   2. getFlowPaths — two disjoint sub-paths with a dielectric gap
//   3. Physics: an actual RC charge/discharge transient — the capacitor
//      current sign and wire-current directions match the story above.
import { describe, it, expect } from 'vitest';
import { capacitorChargeVisuals } from '../src/lib/circuit/components/passive';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';
import {
  simulateStep,
  buildNodeMap,
  computeComponentCurrents,
  computeWireCurrents,
} from '../src/lib/circuit/engine';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

// ── 1. capacitorChargeVisuals (pure mapping) ───────────────────────────────

describe('capacitorChargeVisuals', () => {
  it('uncharged + no current → no glow, no marks', () => {
    const cv = capacitorChargeVisuals(0, 0, 0);
    expect(cv.level).toBe(0);
    expect(cv.glow).toBe(0);
    expect(cv.marks).toBe(0);
    expect(cv.charging).toBe(false);
    expect(cv.discharging).toBe(false);
  });

  it('charging at 5 V: plate a is positive, glow is meaningful, charging=true', () => {
    const cv = capacitorChargeVisuals(5, 0.001, 0);
    expect(cv.positivePlate).toBe('a');
    expect(cv.charging).toBe(true);
    expect(cv.discharging).toBe(false);
    expect(cv.level).toBeGreaterThan(0.5);   // 5/(5+3)
    expect(cv.level).toBeLessThan(1);
    expect(cv.marks).toBe(2);                // round(0.625*3)
  });

  it('reversed polarity: negative voltage makes plate b positive', () => {
    const cv = capacitorChargeVisuals(-5, -0.001, 0);
    expect(cv.positivePlate).toBe('b');
    // V·I = (-5)·(-0.001) > 0 → still charging (energy in)
    expect(cv.charging).toBe(true);
  });

  it('discharging (V·I < 0) is detected in both polarities', () => {
    expect(capacitorChargeVisuals(5, -0.001, 0).discharging).toBe(true);
    expect(capacitorChargeVisuals(-5, 0.001, 0).discharging).toBe(true);
    expect(capacitorChargeVisuals(5, -0.001, 0).charging).toBe(false);
  });

  it('glow pulses while current flows, stays steady when current stops', () => {
    // Same charge level, different times → pulse modulates the glow.
    const t1 = capacitorChargeVisuals(5, 0.001, 0).glow;
    const t2 = capacitorChargeVisuals(5, 0.001, 1 / (2 * capacitorChargeVisuals(5, 0.001, 0).pulseHz) * 0.5).glow;
    const t3 = capacitorChargeVisuals(5, 0.001, 1 / capacitorChargeVisuals(5, 0.001, 0).pulseHz).glow;
    expect(t1).not.toBe(t2);
    // After one full pulse period the phase repeats exactly.
    expect(t3).toBeCloseTo(t1, 9);
    // No current → pulse factor is exactly 1 (steady glow = level).
    const steady = capacitorChargeVisuals(5, 0, 0);
    expect(steady.glow).toBeCloseTo(steady.level, 12);
  });

  it('pulse rate grows with current magnitude and saturates', () => {
    const tiny = capacitorChargeVisuals(5, 1e-9, 0).pulseHz;
    const small = capacitorChargeVisuals(5, 1e-6, 0).pulseHz;
    const mid = capacitorChargeVisuals(5, 1e-4, 0).pulseHz;
    const big = capacitorChargeVisuals(5, 1e-3, 0).pulseHz;
    expect(tiny).toBeLessThan(small);
    expect(small).toBeLessThan(mid);
    expect(mid).toBeLessThanOrEqual(big);
    // Saturates at the clamp (1 mA already maxes the log scale).
    expect(big).toBeCloseTo(0.8 + 1.2 * 3, 9);
    expect(capacitorChargeVisuals(5, 100, 0).pulseHz).toBeCloseTo(big, 9);
  });

  it('glow is bounded [0,1] and dims as the cap discharges', () => {
    // A discharging cap: voltage decays 5V → 2V → 0.3V; glow must follow down.
    const g5 = capacitorChargeVisuals(5, -0.001, 0).glow;
    const g2 = capacitorChargeVisuals(2, -0.0005, 0).glow;
    const gLow = capacitorChargeVisuals(0.3, -0.0001, 0).glow;
    expect(g5).toBeLessThanOrEqual(1);
    expect(g5).toBeGreaterThan(g2);
    expect(g2).toBeGreaterThan(gLow);
  });

  it('non-finite inputs degrade gracefully (no NaN glow)', () => {
    const cv = capacitorChargeVisuals(NaN, Infinity, NaN);
    expect(Number.isFinite(cv.glow)).toBe(true);
    expect(cv.glow).toBe(0);
    expect(cv.marks).toBe(0);
  });

  it('sub-µA currents (numerical settling tail) do not pulse or count as charging', () => {
    const cv = capacitorChargeVisuals(5, 1e-8, 0.37);
    // Below the visually-meaningful floor the pulse factor is exactly 1.
    expect(cv.glow).toBeCloseTo(cv.level, 12);
    expect(cv.charging).toBe(false);
    expect(cv.discharging).toBe(false);
  });
});

// ── 2. getFlowPaths — dot geometry with the dielectric gap ─────────────────

describe('capacitor getFlowPaths', () => {
  it('provides TWO disjoint sub-paths (dots never cross the dielectric)', () => {
    const plugin = getPlugin('capacitor')!;
    expect(plugin.getFlowPaths).toBeDefined();
    const paths = plugin.getFlowPaths!({}, undefined, undefined);
    expect(paths).toHaveLength(2);
    const [p1, p2] = paths;
    expect(p1.length).toBeGreaterThanOrEqual(2);
    expect(p2.length).toBeGreaterThanOrEqual(2);
    // Sub-path 1 ends BEFORE the gap; sub-path 2 starts AFTER it.
    const endX = Math.max(...p1.map(p => p.x));
    const startX = Math.min(...p2.map(p => p.x));
    expect(endX).toBeLessThan(startX);
    expect(startX - endX).toBeGreaterThan(0.1); // a visible plate gap
    // Path 1 starts at terminal a, path 2 ends at terminal b.
    expect(Math.min(...p1.map(p => p.x))).toBe(0);
    expect(Math.max(...p2.map(p => p.x))).toBe(4);
    // Both run along the terminal axis.
    for (const p of [...p1, ...p2]) expect(p.y).toBe(1);
  });

  it('old through-the-dielectric getFlowPath is gone', () => {
    const plugin = getPlugin('capacitor')!;
    expect(plugin.getFlowPath).toBeUndefined();
  });
});

// ── 3. Physics: RC charge → discharge transient ────────────────────────────

function rcFixture(): { components: CircuitComponent[]; wires: Wire[] } {
  // V1(+5V) — R1(1k) — C1(1µF) — GND, with a SPDT-style arrangement:
  // simple series loop; charging through R1 from the source.
  const components: CircuitComponent[] = [
    { id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0, parameters: { voltage: 5 } },
    { id: 'r1', type: 'resistor', position: { x: 6, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
    { id: 'c1', type: 'capacitor', position: { x: 12, y: 0 }, rotation: 0, parameters: { capacitance: 1e-6, initialV: 0 } },
    { id: 'g1', type: 'ground', position: { x: 18, y: 0 }, rotation: 0, parameters: {} },
  ];
  const wires: Wire[] = [
    { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
    { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'c1', terminalId: 'a' } },
    { id: 'w3', from: { componentId: 'c1', terminalId: 'b' }, to: { componentId: 'g1', terminalId: 'g' } },
    { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'g1', terminalId: 'g' } },
  ];
  return { components, wires };
}

function pluginsFor(components: CircuitComponent[]) {
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return plugins;
}

describe('RC transient — the current-flow story the dots tell', () => {
  it('charging: capacitor current is positive (a→b), decays as V approaches 5V', () => {
    const { components, wires } = rcFixture();
    const plugins = pluginsFor(components);
    let prev: any = undefined;
    const firstCurrents: number[] = [];
    let firstSim: any = null;
    // dt = 20µs (τ = 1ms) — 10 steps = 0.2τ.
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(components, wires, plugins, prev, 2e-5);
      expect(r).toBeTruthy();
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
      firstSim = r.sim;
    }
    const currents = computeComponentCurrents(components, wires, plugins, firstSim);
    const iCap = currents.get('c1')!;
    expect(iCap).toBeGreaterThan(0);           // INTO terminal a → charging
    expect(iCap).toBeLessThan(5 / 1000 * 0.95); // decayed from the initial 5mA
    // Voltage rising toward 5V but not there yet.
    const st = firstSim.state.__global;
    expect(st['cap_c1']).toBeGreaterThan(0);
    expect(st['cap_c1']).toBeLessThan(4.9);
    // The visual mapping says: charging, plate a positive.
    const cv = capacitorChargeVisuals(st['cap_c1'], iCap, firstSim.time);
    expect(cv.charging).toBe(true);
    expect(cv.positivePlate).toBe('a');
  });

  it('wire currents carry the charge current: INTO the + plate, OUT of the − plate', () => {
    const { components, wires } = rcFixture();
    const plugins = pluginsFor(components);
    let prev: any = undefined;
    let sim: any = null;
    for (let i = 0; i < 5; i++) {
      const r = simulateStep(components, wires, plugins, prev, 2e-5);
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
      sim = r.sim;
    }
    const wireCurrents = computeWireCurrents(components, wires, plugins, sim);
    const nodeMap = buildNodeMap(components, wires, plugins);
    // w2 joins R1.b → C1.a. Current must flow from R1 toward C1 (into + plate)
    // when the wire's `from` is R1.b: positive = from→to.
    const iW2 = wireCurrents.get('w2')!;
    expect(iW2).toBeGreaterThan(0);
    // w3 joins C1.b → GND: current flows OUT of the negative plate toward
    // ground — again from→to positive.
    const iW3 = wireCurrents.get('w3')!;
    expect(iW3).toBeGreaterThan(0);
    // Both magnitudes ≈ the capacitor current.
    const iCap = computeComponentCurrents(components, wires, plugins, sim).get('c1')!;
    expect(Math.abs(iW2 - iCap)).toBeLessThan(iCap * 0.01 + 1e-12);
    expect(Math.abs(iW3 - iCap)).toBeLessThan(iCap * 0.01 + 1e-12);
    // Sanity: C1.a is the positive-plate node.
    expect(nodeMap.terminalNode.get('c1:a')).toBeDefined();
  });

  it('discharging: pre-charged cap sources current OUT of its + plate (negative cap current)', () => {
    const { components, wires } = rcFixture();
    // Replace the source with a wire (short) so the cap discharges through R1.
    const components2 = components.filter(c => c.id !== 'v1');
    const wires2 = wires
      .filter(w => w.from.componentId !== 'v1' && w.to.componentId !== 'v1')
      .concat([{ id: 'w5', from: { componentId: 'r1', terminalId: 'a' }, to: { componentId: 'g1', terminalId: 'g' } } as Wire]);
    const c1 = components2.find(c => c.id === 'c1')!;
    c1.parameters = { capacitance: 1e-6, initialV: 5 };
    const plugins = pluginsFor(components2);
    let prev: any = undefined;
    let sim: any = null;
    for (let i = 0; i < 5; i++) {
      const r = simulateStep(components2, wires2, plugins, prev, 2e-5);
      expect(r).toBeTruthy();
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
      sim = r.sim;
    }
    const iCap = computeComponentCurrents(components2, wires2, plugins, sim).get('c1')!;
    expect(iCap).toBeLessThan(0); // current flows b→a internally = OUT of the + plate
    // Voltage decays from 5V.
    const st = sim.state.__global;
    expect(st['cap_c1']).toBeLessThan(5);
    expect(st['cap_c1']).toBeGreaterThan(0);
    // The visual mapping says: discharging, plate a still positive, glow dims.
    const cv = capacitorChargeVisuals(st['cap_c1'], iCap, sim.time);
    expect(cv.discharging).toBe(true);
    expect(cv.charging).toBe(false);
    expect(cv.positivePlate).toBe('a');
    // Discharge wire current: w2 (R1.b ← C1.a) now flows C1 → R1, i.e. the
    // dot direction flips vs charging (negative from→to).
    const wireCurrents = computeWireCurrents(components2, wires2, plugins, sim);
    expect(wireCurrents.get('w2')!).toBeLessThan(0);
  });

  it('steady state (fully charged): current ≈ 0 → no dots, steady glow', () => {
    const { components, wires } = rcFixture();
    const plugins = pluginsFor(components);
    let prev: any = undefined;
    let sim: any = null;
    // 10 time constants.
    for (let i = 0; i < 600; i++) {
      const r = simulateStep(components, wires, plugins, prev, 2e-5);
      if (!r) break;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
      sim = r.sim;
    }
    const iCap = computeComponentCurrents(components, wires, plugins, sim).get('c1')!;
    expect(Math.abs(iCap)).toBeLessThan(1e-6); // essentially zero
    const st = sim.state.__global;
    expect(st['cap_c1']).toBeGreaterThan(4.9); // fully charged to 5V
    const cv = capacitorChargeVisuals(st['cap_c1'], iCap, sim.time);
    // No current → no charging/discharging pulse; a strong steady glow.
    expect(cv.charging).toBe(false);
    expect(cv.glow).toBeCloseTo(cv.level, 9);
    expect(cv.level).toBeGreaterThan(0.6);
  });
});
