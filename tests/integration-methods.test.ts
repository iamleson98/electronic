// Integration methods — trapezoidal / Gear (BDF-2) wiring tests.
//
// Verifies that SimOptions.method ('euler' | 'trap' | 'gear') actually reaches
// the capacitor/inductor companion models in passive.ts, and that each method
// produces its characteristic numerical behavior:
//
//   - Backward Euler: 1st order, heavy artificial damping (kills LC oscillators)
//   - Trapezoidal:    2nd order, EXACTLY conserves LC tank energy (Crank-Nicolson
//                     maps the oscillator poles onto the unit circle)
//   - Gear/BDF-2:     2nd order, stable with mild damping; first step falls
//                     back to Euler (standard SPICE order-ramp startup)
//
// All expected values are hand-derived from the companion-model recurrences
// (see src/lib/circuit/integration.ts for the derivations).

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap, solveDC } from '../src/lib/circuit/engine';
import { runTran } from '../src/lib/circuit/analysis';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
});

function comp(type: string, id: string, params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return {
    id, type,
    position: { x: 0, y: 0 },
    rotation: 0,
    parameters: { ...defaults, ...params },
  };
}

function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}

function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().filter(p => components.some(c => c.type === p.type)).map(p => [p.type, p]));
}

/** RC discharge: R=1k from node1 to gnd, C=1µF from node1 to gnd, initialV=5. τ=1ms. */
function rcDischarge(): { components: CircuitComponent[]; wires: Wire[]; plugins: Map<string, ComponentPlugin> } {
  const components = [
    comp('ground', 'gnd'),
    comp('resistor', 'r1', { resistance: 1000 }),
    comp('capacitor', 'c1', { capacitance: 1e-6, initialV: 5 }),
  ];
  const wires = [
    wire('w1', 'r1', 'a', 'c1', 'a'),
    wire('w2', 'r1', 'b', 'gnd', 'g'),
    wire('w3', 'c1', 'b', 'gnd', 'g'),
  ];
  return { components, wires, plugins: pluginsFor(components) };
}

/** Run N steps from cold start, returning the cap node voltage after each step. */
function runSteps(
  circ: { components: CircuitComponent[]; wires: Wire[]; plugins: Map<string, ComponentPlugin> },
  dt: number,
  n: number,
  method?: 'euler' | 'trap' | 'gear',
  nodeId: number = 1,
): { volts: number[]; sim: SimContext | null } {
  const volts: number[] = [];
  let prev: any;
  let sim: SimContext | null = null;
  for (let i = 0; i < n; i++) {
    const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, dt, method ? { method } : undefined);
    if (!r) break;
    sim = r.sim;
    volts.push(sim.nodeVoltage[nodeId] ?? 0);
    prev = {
      nodeVoltage: sim.nodeVoltage,
      branchCurrent: sim.branchCurrent,
      time: sim.time,
      state: sim.state,
    };
  }
  return { volts, sim };
}

// ─────────────────────────────────────────────────────────────────────────────
// Method plumbing
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration method plumbing', () => {
  it('defaults to backward Euler when no method is passed', () => {
    const circ = rcDischarge();
    const { sim } = runSteps(circ, 1e-3, 1);
    expect(sim).not.toBeNull();
    expect(sim!.method).toBe('euler');
  });

  it('sim.method reflects the requested method', () => {
    for (const method of ['trap', 'gear'] as const) {
      const circ = rcDischarge();
      const { sim } = runSteps(circ, 1e-3, 1, method);
      expect(sim).not.toBeNull();
      expect(sim!.method).toBe(method);
    }
  });

  it('sim.netNames is populated with ground aliases', () => {
    const circ = rcDischarge();
    const r = simulateStep(circ.components, circ.wires, circ.plugins, undefined, 1e-3);
    expect(r).not.toBeNull();
    expect(r!.sim.netNames).toBeDefined();
    expect(r!.sim.netNames!.get('0')).toBe(0);
    expect(r!.sim.netNames!.get('gnd')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RC discharge — hand-derived sequences (τ = 1ms = dt)
// ─────────────────────────────────────────────────────────────────────────────

describe('RC discharge with trapezoidal (τ = dt)', () => {
  // Companion recurrences, cold start (v0 = 5V, i0 = 0 — ngspice-UIC semantics):
  //   Euler: v_n = v_{n−1}/2                     → 2.5, 1.25, …
  //   Trap:  v_n = 3.3333·(1/3)^{n−1}            → 3.3333, 1.1111, …
  //   True:  v_n = 5·e^{−n}                      → 1.8395, 0.6767, …
  const euler = [2.5, 1.25, 0.625, 0.3125, 0.15625];
  const trap = [3.333333333, 1.111111111, 0.370370370, 0.123456790, 0.041152263];

  it('trap matches the hand-derived companion sequence', () => {
    const circ = rcDischarge();
    const { volts } = runSteps(circ, 1e-3, 5, 'trap');
    expect(volts.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(volts[i]).toBeCloseTo(trap[i], 6);
    }
  });

  it('euler still matches its historical sequence (no regression)', () => {
    const circ = rcDischarge();
    const { volts } = runSteps(circ, 1e-3, 5);
    for (let i = 0; i < 5; i++) {
      expect(volts[i]).toBeCloseTo(euler[i], 6);
    }
  });

  it('trap error at t=5τ is >3x smaller than euler error', () => {
    const analytic = 5 * Math.exp(-5); // 0.0336897
    const eulerErr = Math.abs(euler[4] - analytic);
    const trapErr = Math.abs(trap[4] - analytic);
    expect(trapErr).toBeLessThan(eulerErr / 3);
  });

  it('trap capacitor current readout is method-consistent', () => {
    const circ = rcDischarge();
    const { sim } = runSteps(circ, 1e-3, 1, 'trap');
    const st = sim!.state.__global ?? {};
    // i_1 = (2C/dt)(v_1 − v_0) − i_0 = 2e-3·(3.3333−5) − 0 = −3.3333 mA
    expect(st['cap_c1_i']).toBeCloseTo(-3.333333333e-3, 6);
  });
});

describe('RC discharge with Gear/BDF-2 (τ = dt)', () => {
  // BDF-2 recurrence (after the Euler seed): v_n = (4v_{n−1} − v_{n−2})/5.
  // With dt = τ the roots are complex (0.4 ± 0.2j) — visible ringing, |z| = 0.447.
  const gear = [2.5, 1.0, 0.3, 0.04, -0.028];

  it('first step falls back to Euler (order-ramp startup)', () => {
    const circ = rcDischarge();
    const { volts } = runSteps(circ, 1e-3, 1, 'gear');
    expect(volts[0]).toBeCloseTo(2.5, 6);
  });

  it('matches the BDF-2 recurrence (including its characteristic ringing at dt=τ)', () => {
    const circ = rcDischarge();
    const { volts } = runSteps(circ, 1e-3, 5, 'gear');
    for (let i = 0; i < 5; i++) {
      expect(volts[i]).toBeCloseTo(gear[i], 6);
    }
  });

  it('gear keeps voltage-history state (v2 key)', () => {
    const circ = rcDischarge();
    const { sim } = runSteps(circ, 1e-3, 2, 'gear');
    const st = sim!.state.__global ?? {};
    expect(st['cap_c1_v2']).toBeDefined();
    // after step 2: v1 = 2.5 was the old vPrev
    expect(st['cap_c1_v2']).toBeCloseTo(2.5, 6);
  });
});

describe('Gear accuracy at dt = τ/4', () => {
  // Recurrence: v_n = (8v_{n−1} − 2v_{n−2})/7, Euler seed v_1 = 4.0.
  const gear = [4.0, 3.142857143, 2.448979592, 1.900874636, 1.472719700];
  const euler = [4.0, 3.2, 2.56, 2.048, 1.6384];

  it('matches the BDF-2 recurrence at quarter-tau steps', () => {
    const circ = rcDischarge();
    const { volts } = runSteps(circ, 2.5e-4, 5, 'gear');
    for (let i = 0; i < 5; i++) {
      expect(volts[i]).toBeCloseTo(gear[i], 5);
    }
  });

  it('gear error at t=1.25τ is >4x smaller than euler error', () => {
    const analytic = 5 * Math.exp(-1.25); // 1.4331450
    const eulerErr = Math.abs(euler[4] - analytic);
    const gearErr = Math.abs(gear[4] - analytic);
    expect(gearErr).toBeLessThan(eulerErr / 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LC tank — the energy-conservation showcase
// ─────────────────────────────────────────────────────────────────────────────

describe('LC tank energy conservation', () => {
  // L = 1mH, C = 1µF → f0 ≈ 5033 Hz, T ≈ 198.69µs. dt = T/20.
  // Backward Euler damps the oscillation to nothing within ~10 periods
  // (artificial damping |1/(1+jωdt)| per step); trapezoidal is Crank-Nicolson —
  // the poles land exactly on the unit circle, so amplitude is preserved forever.
  const dt = (2 * Math.PI * Math.sqrt(1e-3 * 1e-6)) / 20;

  function lcTank() {
    const components = [
      comp('ground', 'gnd'),
      comp('inductor', 'l1', { inductance: 1e-3, initialI: 0 }),
      comp('capacitor', 'c1', { capacitance: 1e-6, initialV: 5 }),
    ];
    const wires = [
      wire('w1', 'l1', 'a', 'c1', 'a'),
      wire('w2', 'l1', 'b', 'gnd', 'g'),
      wire('w3', 'c1', 'b', 'gnd', 'g'),
    ];
    return { components, wires, plugins: pluginsFor(components) };
  }

  it('trapezoidal preserves the tank amplitude over 20 periods (energy-conserving)', () => {
    const circ = lcTank();
    const { sim } = runSteps(circ, dt, 400, 'trap'); // 20 periods
    expect(sim).not.toBeNull();
    // max |v| over the last 100 steps must still be ~5V
    let peak = 0;
    // re-run tracking all values
    let prev: any;
    const volts: number[] = [];
    for (let i = 0; i < 400; i++) {
      const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, dt, { method: 'trap' });
      expect(r).not.toBeNull();
      prev = {
        nodeVoltage: r!.sim.nodeVoltage,
        branchCurrent: r!.sim.branchCurrent,
        time: r!.sim.time,
        state: r!.sim.state,
      };
      volts.push(r!.sim.nodeVoltage[1] ?? 0);
    }
    for (let i = 300; i < 400; i++) peak = Math.max(peak, Math.abs(volts[i]));
    expect(peak).toBeGreaterThan(4.9);
    expect(peak).toBeLessThan(5.1);
  });

  it('backward Euler kills the oscillation within 20 periods (artificial damping)', () => {
    const circ = lcTank();
    let prev: any;
    const volts: number[] = [];
    for (let i = 0; i < 400; i++) {
      const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, dt);
      expect(r).not.toBeNull();
      prev = {
        nodeVoltage: r!.sim.nodeVoltage,
        branchCurrent: r!.sim.branchCurrent,
        time: r!.sim.time,
        state: r!.sim.state,
      };
      volts.push(r!.sim.nodeVoltage[1] ?? 0);
    }
    let peak = 0;
    for (let i = 300; i < 400; i++) peak = Math.max(peak, Math.abs(volts[i]));
    expect(peak).toBeLessThan(1e-3);
  });

  it('Gear stays bounded and stable on the tank (A-stable, mild damping)', () => {
    const circ = lcTank();
    let prev: any;
    const volts: number[] = [];
    for (let i = 0; i < 400; i++) {
      const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, dt, { method: 'gear' });
      expect(r).not.toBeNull();
      prev = {
        nodeVoltage: r!.sim.nodeVoltage,
        branchCurrent: r!.sim.branchCurrent,
        time: r!.sim.time,
        state: r!.sim.state,
      };
      volts.push(r!.sim.nodeVoltage[1] ?? 0);
    }
    let peak = 0;
    for (const v of volts) {
      peak = Math.max(peak, Math.abs(v));
      expect(Number.isFinite(v)).toBe(true);
    }
    // BDF-2: physical root close to unit circle — amplitude within 40%
    expect(peak).toBeGreaterThan(3.0);
    expect(peak).toBeLessThan(5.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RL circuit — inductor trapezoidal companion
// ─────────────────────────────────────────────────────────────────────────────

describe('RL step response with trapezoidal', () => {
  // V = 10V → L = 1H → R = 1k → gnd. τ = 1ms, dt = 1ms.
  // Cold start (i_0 = 0, v_L(0−) = 0):
  //   Euler: i_n = (i_{n−1} + 10mA)/2            → 5, 7.5, 8.75, 9.375, 9.6875 mA
  //   Trap:  i_1 = 3.3333 mA, then i_n = i_{n−1}/3 + 6.6667 mA
  //                                            → 3.3333, 7.7778, 9.2593, 9.7531, 9.9177 mA
  //   True:  i(t) = 10mA(1 − e^{−t/τ})           → 6.3212, 8.6466, 9.5021, 9.8168, 9.9326 mA

  function rlCircuit() {
    const components = [
      comp('ground', 'gnd'),
      comp('dcVoltage', 'v1', { voltage: 10 }),
      comp('inductor', 'l1', { inductance: 1, initialI: 0 }),
      comp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'l1', 'a'),
      wire('w2', 'v1', 'n', 'gnd', 'g'),
      wire('w3', 'l1', 'b', 'r1', 'a'),
      wire('w4', 'r1', 'b', 'gnd', 'g'),
    ];
    return { components, wires, plugins: pluginsFor(components) };
  }

  function inductorCurrents(method?: 'euler' | 'trap' | 'gear'): number[] {
    const circ = rlCircuit();
    let prev: any;
    const currents: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, 1e-3, method ? { method } : undefined);
      expect(r).not.toBeNull();
      prev = {
        nodeVoltage: r!.sim.nodeVoltage,
        branchCurrent: r!.sim.branchCurrent,
        time: r!.sim.time,
        state: r!.sim.state,
      };
      const st = r!.sim.state.__global ?? {};
      currents.push(st['ind_l1'] as number);
    }
    return currents;
  }

  it('trap inductor matches the hand-derived sequence', () => {
    const i = inductorCurrents('trap').map(x => x * 1000); // mA
    expect(i[0]).toBeCloseTo(3.3333333, 6);
    expect(i[1]).toBeCloseTo(7.7777778, 6);
    expect(i[2]).toBeCloseTo(9.2592593, 6);
    expect(i[3]).toBeCloseTo(9.7530864, 6);
    expect(i[4]).toBeCloseTo(9.9176955, 6);
  });

  it('euler inductor keeps its historical sequence (no regression)', () => {
    const i = inductorCurrents().map(x => x * 1000);
    expect(i[0]).toBeCloseTo(5, 6);
    expect(i[1]).toBeCloseTo(7.5, 6);
    expect(i[4]).toBeCloseTo(9.6875, 6);
  });

  it('trap current error at t=5τ is >10x smaller than euler error', () => {
    const analytic = 0.01 * (1 - Math.exp(-5)); // 9.93262 mA
    const eulerErr = Math.abs(inductorCurrents()[4] - analytic);
    const trapErr = Math.abs(inductorCurrents('trap')[4] - analytic);
    expect(trapErr).toBeLessThan(eulerErr / 10);
  });

  it('trap inductor keeps voltage-history state (_vp key)', () => {
    const circ = rlCircuit();
    let prev: any;
    const r1 = simulateStep(circ.components, circ.wires, circ.plugins, prev, 1e-3, { method: 'trap' });
    prev = {
      nodeVoltage: r1!.sim.nodeVoltage,
      branchCurrent: r1!.sim.branchCurrent,
      time: r1!.sim.time,
      state: r1!.sim.state,
    };
    const r2 = simulateStep(circ.components, circ.wires, circ.plugins, prev, 1e-3, { method: 'trap' });
    const st = r2!.sim.state.__global ?? {};
    expect(st['ind_l1_vp']).toBeDefined();
    // v_L at end of step 2 = 10 − 1000·i_2 = 10 − 7.7778 = 2.2222 V
    expect(st['ind_l1_vp']).toBeCloseTo(2.2222222, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parallel capacitors — independent trap state per component
// ─────────────────────────────────────────────────────────────────────────────

describe('Parallel capacitors keep independent trap state', () => {
  // Two 1µF caps in parallel (C_tot = 2µF), both initialV = 5, R = 1k → τ_eff = 2ms.
  // dt = 1ms: trap v_1 = 4.0, v_2 = 2.4. If the two caps shared a state key the
  // companion currents would double-count and the node voltage would differ.
  function parallelCaps() {
    const components = [
      comp('ground', 'gnd'),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('capacitor', 'c1', { capacitance: 1e-6, initialV: 5 }),
      comp('capacitor', 'c2', { capacitance: 1e-6, initialV: 5 }),
    ];
    const wires = [
      wire('w1', 'r1', 'a', 'c1', 'a'),
      wire('w2', 'c1', 'a', 'c2', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'c1', 'b', 'gnd', 'g'),
      wire('w5', 'c2', 'b', 'gnd', 'g'),
    ];
    return { components, wires, plugins: pluginsFor(components) };
  }

  it('trap produces the correct combined-companion voltages', () => {
    const circ = parallelCaps();
    const { volts } = runSteps(circ, 1e-3, 2, 'trap');
    expect(volts[0]).toBeCloseTo(4.0, 6);
    expect(volts[1]).toBeCloseTo(2.4, 6);
  });

  it('each cap tracks its own current', () => {
    const circ = parallelCaps();
    const { sim } = runSteps(circ, 1e-3, 1, 'trap');
    const st = sim!.state.__global ?? {};
    // i per cap = (2C/dt)(v_1 − v_0) − 0 = 2e-3·(4−5) = −2 mA each
    expect(st['cap_c1_i']).toBeCloseTo(-2e-3, 6);
    expect(st['cap_c2_i']).toBeCloseTo(-2e-3, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Method switching mid-run + DC operating point safety
// ─────────────────────────────────────────────────────────────────────────────

describe('Method switching and DC safety', () => {
  it('switching euler → trap mid-run stays finite and monotone', () => {
    const circ = rcDischarge();
    let prev: any;
    const volts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, 1e-3);
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
      volts.push(r!.sim.nodeVoltage[1]);
    }
    for (let i = 0; i < 3; i++) {
      const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, 1e-3, { method: 'trap' });
      expect(r).not.toBeNull();
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
      volts.push(r!.sim.nodeVoltage[1]);
    }
    for (const v of volts) expect(Number.isFinite(v)).toBe(true);
    for (let i = 1; i < volts.length; i++) {
      expect(volts[i]).toBeLessThan(volts[i - 1] + 1e-12); // discharging, never rises
    }
  });

  it('solveDC always runs Euler regardless of what a transient would use', () => {
    // solveDC passes no simOptions → method defaults to 'euler' → the DC
    // operating point sees the classic cap-open/ind-short companions. A trap
    // DC solve would remember −vPrev across the (huge) DC step and oscillate.
    const components = [
      comp('ground', 'gnd'),
      comp('dcVoltage', 'v1', { voltage: 5 }),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('capacitor', 'c1', { capacitance: 1e-6 }),
      comp('inductor', 'l1', { inductance: 1e-3 }),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'v1', 'n', 'gnd', 'g'),
      wire('w3', 'r1', 'b', 'c1', 'a'),
      wire('w4', 'r1', 'b', 'l1', 'a'),
      wire('w5', 'c1', 'b', 'gnd', 'g'),
      wire('w6', 'l1', 'b', 'gnd', 'g'),
    ];
    const plugins = pluginsFor(components);
    const sim = solveDC(components, wires, plugins);
    expect(sim).not.toBeNull();
    // At DC the inductor is a short → node after R is pulled to ground (0V),
    // the full 5V drops across R1, and 5mA flows. A trap DC companion would
    // instead remember −vPrev across the huge DC step and ring.
    const nm = buildNodeMap(components, wires, plugins);
    const nodeOfR1b = nm.terminalNode.get('r1:b') ?? 0;
    expect(sim!.nodeVoltage[nodeOfR1b]).toBeCloseTo(0, 3);
    expect(sim!.method ?? 'euler').toBe('euler');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runTran end-to-end — method flows through the analysis layer
// ─────────────────────────────────────────────────────────────────────────────

describe('runTran integration-method plumbing', () => {
  // Pulse source: 5V high, 0V low, 100Hz, 50% duty → drops at t = 5ms.
  // RC: τ = 1ms, tStep = 1ms. After the DC op (pulse @ t=0 = 5V → cap at 5V),
  // five high steps hold 5V, then five low steps discharge the cap:
  //   euler: 5·(1/2)^k → final 0.15625 V
  //   trap:  3.3333·(1/3)^k → final 0.041152 V
  function pulseRC() {
    const components = [
      comp('ground', 'gnd'),
      comp('pulseSource', 'v1', { high: 5, low: 0, frequency: 100, duty: 50 }),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('capacitor', 'c1', { capacitance: 1e-6 }),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'v1', 'n', 'gnd', 'g'),
      wire('w3', 'r1', 'b', 'c1', 'a'),
      wire('w4', 'c1', 'b', 'gnd', 'g'),
    ];
    return { components, wires, plugins: pluginsFor(components) };
  }

  it('method=trap produces the trap discharge tail through the full analysis stack', () => {
    const circ = pulseRC();
    const result = runTran(circ.components, circ.wires, circ.plugins, {
      type: 'tran', tStop: 10e-3, tStep: 1e-3, probes: ['c1:a'],
    }, { method: 'trap' });
    expect(result.traces.length).toBe(1);
    const y = result.traces[0].yValues;
    // The engine advances time BEFORE stamping (step k runs at t=(k+1)·dt),
    // so the pulse (100Hz, 50% duty) is low for steps 4..8 and high again at
    // t=10ms — the 11th sample recharges. The discharge tail lives in y[5..9].
    expect(y[9]).toBeCloseTo(0.041152263, 4);
  });

  it('default (no method) keeps the Euler discharge tail', () => {
    const circ = pulseRC();
    const result = runTran(circ.components, circ.wires, circ.plugins, {
      type: 'tran', tStop: 10e-3, tStep: 1e-3, probes: ['c1:a'],
    });
    const y = result.traces[0].yValues;
    expect(y[9]).toBeCloseTo(0.15625, 4);
  });
});
