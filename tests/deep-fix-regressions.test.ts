// Regression tests for the deep-research bug-fix pass.
// Each test pins a specific bug that was found and fixed — see git history
// for the full write-ups.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  simulateStep, solveDC, buildNodeMap, computeComponentCurrents,
} from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import { rlCurrentBuildup } from '../src/lib/circuit/transient-methods';
import { runTran, runFour, runAC, runDCSweep } from '../src/lib/circuit/analysis';
import { solveDCWithSourceStepping, solveDCWithPseudoTran, solveDCWithGminStepping } from '../src/lib/circuit/convergence';
import { computeFFT, parseMeasLine, execMeas } from '../src/lib/circuit/measurement';
import { runMonteCarlo } from '../src/lib/circuit/monte-carlo';
import { cleanupComponentState } from '../src/lib/circuit/memory';
import { stampCapacitor, stampInductor } from '../src/lib/circuit/integration-adapter';
import { createMnaSystem, solveMna } from '../src/lib/circuit/solver';

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
function runSim(comps: CircuitComponent[], ws: Wire[], steps = 3, dt = 1e-4) {
  const p = plugins();
  let prev: any;
  let last: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(comps, ws, p, prev, dt);
    if (!r) return null;
    last = r;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// Solver / engine
// ─────────────────────────────────────────────────────────────────────────────

describe('Sparse-path branch currents (asMnaSystem identity fix)', () => {
  it('populates sim.branchCurrent for circuits that take the sparse path', () => {
    // 20 series resistors -> matrix size > 80 -> sparse solver path.
    const comps: CircuitComponent[] = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('ground', 'GND')];
    const ws: Wire[] = [wire('w0', 'V1', 'p', 'R1', 'a'), wire('w1', 'V1', 'n', 'GND', 'g')];
    comps.push(comp('resistor', 'R1', { resistance: 100 }));
    let prevId = 'R1';
    for (let i = 2; i <= 20; i++) {
      const id = `R${i}`;
      comps.push(comp('resistor', id, { resistance: 100 }));
      ws.push(wire(`w${i}`, prevId, 'b', id, 'a'));
      prevId = id;
    }
    ws.push(wire('wlast', prevId, 'b', 'GND', 'g'));
    const r = runSim(comps, ws, 3);
    expect(r).not.toBeNull();
    expect(r!.branchCurrentSize).toBe(1); // was 0 before the fix
    const i = Math.abs(r!.sim.branchCurrent[0]);
    expect(i).toBeCloseTo(5 / 2000, 5); // 2.5 mA
  });
});

describe('RL transient reference (physics law)', () => {
  it('RL current uses tau = L/R (exponent -t*R/L)', () => {
    // At t = tau the current reaches 63.2% of the final value.
    const R = 1000, L = 1, Vs = 10;
    const tau = L / R;
    expect(rlCurrentBuildup(tau, Vs, R, L)).toBeCloseTo((Vs / R) * 0.632, 2);
    // The old (inverted) formula gave ~0.001% at t = tau.
    expect(rlCurrentBuildup(tau, Vs, R, L)).toBeGreaterThan(0.006);
  });
});

describe('Zener current computation', () => {
  it('mirrors the stamp piecewise model (reverse breakdown current ~0 at Vz)', () => {
    // 12V source -> 1k -> zener (Vz=5) -> ground
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 12 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('zener', 'D1', { zenerV: 5, onR: 1, offR: 1e7 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'D1', 'k'), // cathode to the resistor (reverse biased)
      wire('w3', 'D1', 'a', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 5);
    expect(r).not.toBeNull();
    const nm = r!.nodeMap;
    const vk = r!.sim.nodeVoltage[nm.terminalNode.get('D1:k')!];
    expect(vk).toBeCloseTo(5, 1); // regulates at Vz
    const ic = computeComponentCurrents(comps, ws, plugins(), r!.sim);
    const iZ = Math.abs(ic.get('D1') ?? 0);
    expect(iZ).toBeCloseTo((12 - 5) / 1000, 3); // 7 mA through the resistor
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component physics
// ─────────────────────────────────────────────────────────────────────────────

describe('Transformer energy conservation', () => {
  it('primary draws the reflected secondary power (10V, n=0.5, 10 ohm load)', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 10 }),
      comp('transformer', 'T1', { ratio: 0.5, lm: 1 }),
      comp('resistor', 'RL', { resistance: 10 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'T1', 'p1'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'T1', 'p2', 'GND', 'g'),
      wire('w4', 'T1', 's1', 'RL', 'a'),
      wire('w5', 'RL', 'b', 'GND', 'g'),
      wire('w6', 'T1', 's2', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3, 1e-3);
    expect(r).not.toBeNull();
    const nm = r!.nodeMap;
    const vs = r!.sim.nodeVoltage[nm.terminalNode.get('T1:s1')!];
    expect(vs).toBeCloseTo(5, 3); // V2 = n * V1
    const ic = computeComponentCurrents(comps, ws, plugins(), r!.sim);
    const iV1 = Math.abs(ic.get('V1') ?? 0);
    // Primary power (>= load power; the surplus charges the magnetizing L).
    // Before the fix the primary drew only the magnetizing current (~0.01 A)
    // while the load consumed 2.5 W.
    expect(10 * iV1).toBeGreaterThanOrEqual((vs * vs) / 10 - 1e-6);
    expect(iV1).toBeGreaterThan(0.2); // reflected ~0.25 A, not 0.01 A
  });
});

describe('Schmitt trigger gates', () => {
  it('Schmitt NOT inverts its input', () => {
    const comps = [
      comp('dcVoltage', 'VIN', { voltage: 5 }),
      comp('schmitt_not', 'U1', { vcc: 5, vtPos: 2.9, vtNeg: 2.1 }),
      comp('resistor', 'R1', { resistance: 10000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VIN', 'p', 'U1', 'a'),
      wire('w2', 'U1', 'y', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'VIN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3);
    expect(r).not.toBeNull();
    const y = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('U1:y')!];
    expect(y).toBeLessThan(0.5); // input HIGH -> output LOW (was 5 V before)
  });

  it('Schmitt NAND outputs HIGH when an input is LOW', () => {
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 5 }),
      comp('schmitt_nand', 'U1', { vcc: 5, vtPos: 2.9, vtNeg: 2.1 }),
      comp('resistor', 'R1', { resistance: 10000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'U1', 'a', 'GND', 'g'), // A low
      wire('w2', 'U1', 'b', 'GND', 'g'), // B low
      wire('w3', 'VCC', 'p', 'U1', 'vcc'),
      wire('w4', 'U1', 'y', 'R1', 'a'),
      wire('w5', 'R1', 'b', 'GND', 'g'),
      wire('w6', 'VCC', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3);
    expect(r).not.toBeNull();
    const y = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('U1:y')!];
    expect(y).toBeGreaterThan(4.5); // NAND(0,0) = 1 (was stuck at 0 before)
  });
});

describe('Optocoupler phototransistor direction', () => {
  it('does not pull the collector above the supply rail', () => {
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 5 }),
      comp('dcVoltage', 'VIN', { voltage: 5 }),
      comp('resistor', 'RLED', { resistance: 1000 }),
      comp('optocoupler', 'U1', { ledVf: 1.2, ledR: 10, ctr: 0.5, transR: 1e6 }),
      comp('resistor', 'RC', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'RC', 'a'),
      wire('w2', 'RC', 'b', 'U1', 'c'),
      wire('w3', 'U1', 'e', 'GND', 'g'),
      wire('w4', 'VIN', 'p', 'RLED', 'a'),
      wire('w5', 'RLED', 'b', 'U1', 'ledA'),
      wire('w6', 'U1', 'ledK', 'GND', 'g'),
      wire('w7', 'VCC', 'n', 'GND', 'g'),
      wire('w8', 'VIN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 5);
    expect(r).not.toBeNull();
    const c = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('U1:c')!];
    // ~1.9 mA of photocurrent pulls the collector down to ~3.1 V.
    // Before the direction fix the source pushed the collector ABOVE the
    // 5 V rail (a generator, not a transistor).
    expect(c).toBeLessThanOrEqual(5 + 1e-6);
    expect(c).toBeGreaterThan(2);
    expect(c).toBeLessThan(4.5);
  });
});

describe('JFET triode region (Shockley signs)', () => {
  it('N-JFET drain current is positive in the triode region', () => {
    const comps = [
      comp('dcVoltage', 'VDD', { voltage: 5 }),
      comp('resistor', 'RD', { resistance: 100 }),
      comp('jfetN', 'J1', { Vp: -2, Idss: 0.01 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VDD', 'p', 'RD', 'a'),
      wire('w2', 'RD', 'b', 'J1', 'd'),
      wire('w3', 'J1', 's', 'GND', 'g'),
      wire('w4', 'J1', 'g', 'GND', 'g'), // Vgs = 0
      wire('w5', 'VDD', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 8);
    expect(r).not.toBeNull();
    const ic = computeComponentCurrents(comps, ws, plugins(), r!.sim);
    const i = ic.get('J1') ?? 0;
    expect(i).toBeGreaterThan(0); // was negative before the sign fix
  });
});

describe('mosLevel1P magnitude handling', () => {
  it('does not explode to mega-amps after the first timestep', () => {
    const comps = [
      comp('dcVoltage', 'VDD', { voltage: -5 }), // negative rail for PMOS source
      comp('resistor', 'RD', { resistance: 100 }),
      comp('mosLevel1P', 'M1', { Vto: -1, Kp: 0.05 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VDD', 'p', 'M1', 's'),
      wire('w2', 'M1', 'd', 'RD', 'a'),
      wire('w3', 'RD', 'b', 'GND', 'g'),
      wire('w4', 'M1', 'g', 'GND', 'g'), // Vgs = -5 (on)
      wire('w5', 'M1', 'b', 'GND', 'g'),
      wire('w6', 'VDD', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 6);
    expect(r).not.toBeNull();
    for (const v of r!.sim.nodeVoltage) {
      expect(Math.abs(v)).toBeLessThan(1e4); // was ~1e6 A / huge voltages before
      expect(isFinite(v)).toBe(true);
    }
  });
});

describe('Gummel-Poon base companion', () => {
  it('base current offset is not identically zero', () => {
    // Build the BJT stamp by hand and verify the base companion source.
    const sys = createMnaSystem(3, 8);
    sys.nextExtra = 3;
    const terms = [
      { terminalId: 'c', nodeId: 1 },
      { terminalId: 'b', nodeId: 2 },
      { terminalId: 'e', nodeId: 3 },
    ];
    const plugin = getPlugin('bjtGPNpn')!;
    const sim: any = { nodeVoltage: new Float64Array([0, 3, 0.7, 0]), branchCurrent: new Float64Array(8), time: 0, dt: 1e-4, state: { __global: {} } };
    plugin.stamp!({ Is: 1e-15, Bf: 100, Br: 1, Vaf: 100, Var: 50, Ikf: 1 } as any, terms, sys as any, sim);
    // The RHS of the b-e junction must include a nonzero base-current offset
    // (the companion source). Row 1 (node b) with the conductance-only stamp
    // would leave z[1] == 0.
    expect(Math.abs(sys.z[1])).toBeGreaterThan(0);
  });
});

describe('Ammeter branch-current indexing', () => {
  it('reads the correct branch current (5 mA through 1 kOhm)', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('ammeter', 'A1', {}),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'A1', 'p'),
      wire('w2', 'A1', 'n', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3);
    expect(r).not.toBeNull();
    const plugin = getPlugin('ammeter')!;
    const terms = [
      { terminalId: 'p', nodeId: r!.nodeMap.terminalNode.get('A1:p')! },
      { terminalId: 'n', nodeId: r!.nodeMap.terminalNode.get('A1:n')! },
    ];
    const m = plugin.measure!({}, terms, r!.sim, comps[1]);
    const i = parseFloat(m[0].value);
    expect(i).toBeCloseTo(5, 1); // 5 mA — was 0 before the index fix
  });
});

describe('Comparator open-collector output', () => {
  it('pulls the output LOW through ron when V+ < V-', () => {
    const comps = [
      comp('dcVoltage', 'VPULL', { voltage: 5 }),
      comp('dcVoltage', 'VINP', { voltage: 1 }),
      comp('dcVoltage', 'VINN', { voltage: 3 }),
      comp('comparator', 'U1', { vhigh: 5, vlow: 0, ron: 10, roff: 1e7 }),
      comp('resistor', 'RP', { resistance: 10000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VPULL', 'p', 'RP', 'a'),   // pull-up
      wire('w2', 'RP', 'b', 'U1', 'out'),
      wire('w3', 'VINP', 'p', 'U1', 'inp'),
      wire('w4', 'VINN', 'p', 'U1', 'inn'),
      wire('w5', 'VPULL', 'n', 'GND', 'g'),
      wire('w6', 'VINP', 'n', 'GND', 'g'),
      wire('w7', 'VINN', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 4);
    expect(r).not.toBeNull();
    const out = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('U1:out')!];
    // With V+ < V- the transistor is ON: out ~ 5 * ron/(ron+RP) ~ 5 mV.
    // Before the fix the output floated high (roff) and could never pull low.
    expect(out).toBeLessThan(0.05);
  });
});

describe('Flip-flop output drive', () => {
  it('Q drives a 1 kOhm load to full logic level', () => {
    const comps = [
      comp('dcVoltage', 'VD', { voltage: 5 }),
      comp('dcVoltage', 'VCLK', { voltage: 5 }),
      comp('dff', 'U1', {}),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VD', 'p', 'U1', 'd'),
      wire('w2', 'VCLK', 'p', 'U1', 'clk'),
      wire('w3', 'U1', 'q', 'RL', 'a'),
      wire('w4', 'RL', 'b', 'GND', 'g'),
      wire('w5', 'VD', 'n', 'GND', 'g'),
      wire('w6', 'VCLK', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3);
    expect(r).not.toBeNull();
    const q = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('U1:q')!];
    // Before: 1 MOhm Thevenin -> Q collapsed to ~5 mV under a 1 k load.
    expect(q).toBeGreaterThan(4.9);
  });
});

describe('SCR gate referenced to cathode', () => {
  it('fires with an elevated cathode when V(g)-V(k) exceeds the trigger', () => {
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 12 }),
      comp('dcVoltage', 'VK', { voltage: 6 }),   // cathode sits at 6 V
      comp('dcVoltage', 'VG', { voltage: 7 }),   // gate at 7 V -> Vgk = 1 V > 0.7
      comp('resistor', 'RL', { resistance: 100 }),
      comp('scr', 'Q1', { forwardV: 1, gateTriggerV: 0.7, holdingI: 0.001, onR: 1, offR: 1e7 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'RL', 'a'),
      wire('w2', 'RL', 'b', 'Q1', 'a'),
      wire('w3', 'Q1', 'k', 'VK', 'p'),
      wire('w4', 'VG', 'p', 'Q1', 'g'),
      wire('w5', 'VCC', 'n', 'GND', 'g'),
      wire('w6', 'VK', 'n', 'GND', 'g'),
      wire('w7', 'VG', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 4);
    expect(r).not.toBeNull();
    const ic = computeComponentCurrents(comps, ws, plugins(), r!.sim);
    const i = Math.abs(ic.get('Q1') ?? 0);
    // Gate is 7 V vs ground (old check) but Vgk = 1 V (new check fires).
    expect(i).toBeGreaterThan(0.01); // conducting ~ (12-6-1)/101 A
  });
});

describe('74138 decoder outputs', () => {
  it('has all 8 outputs; select=6 lights y6', () => {
    const p = getPlugin('ic74138')!;
    expect(p.terminals.filter(t => t.id.startsWith('y'))).toHaveLength(8);
    const comps = [
      comp('dcVoltage', 'VS0', { voltage: 0 }),
      comp('dcVoltage', 'VS1', { voltage: 5 }),
      comp('dcVoltage', 'VS2', { voltage: 5 }),
      comp('ic74138', 'U1', { vcc: 5, threshold: 2.5 }),
      comp('resistor', 'RL5', { resistance: 10000 }),
      comp('resistor', 'RL6', { resistance: 10000 }),
      comp('resistor', 'RL7', { resistance: 10000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS0', 'p', 'U1', 's0'),
      wire('w2', 'VS1', 'p', 'U1', 's1'),
      wire('w3', 'VS2', 'p', 'U1', 's2'),
      wire('w4', 'U1', 'y5', 'RL5', 'a'),
      wire('w5', 'RL5', 'b', 'GND', 'g'),
      wire('w6', 'U1', 'y6', 'RL6', 'a'),
      wire('w7', 'RL6', 'b', 'GND', 'g'),
      wire('w8', 'U1', 'y7', 'RL7', 'a'),
      wire('w9', 'RL7', 'b', 'GND', 'g'),
      wire('w10', 'VS0', 'n', 'GND', 'g'),
      wire('w11', 'VS1', 'n', 'GND', 'g'),
      wire('w12', 'VS2', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 2);
    expect(r).not.toBeNull();
    const y6 = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('U1:y6')!];
    const y5 = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('U1:y5')!];
    expect(y6).toBeCloseTo(0, 5);  // selected (active low)
    expect(y5).toBeCloseTo(5, 5);  // not selected
  });
});

describe('LM385 reverse-bias regulation', () => {
  it('regulates with cathode above anode (zener orientation)', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('lm385', 'D1', { refV: 1.235, onR: 1, offR: 1e7 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'D1', 'k'), // cathode to the rail (reverse bias)
      wire('w3', 'D1', 'a', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 5);
    expect(r).not.toBeNull();
    const vk = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('D1:k')!];
    expect(vk).toBeCloseTo(1.235, 2); // was ~5 V (never regulated) before
  });
});

describe('Solar cell series resistance', () => {
  it('limits the short-circuit current to ~isc', () => {
    const comps = [
      comp('solarCell', 'SC1', { voc: 0.6, isc: 0.05, seriesR: 0.5, illuminance: 1000 }),
      comp('resistor', 'RL', { resistance: 0.001 }), // ~short circuit
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'SC1', 'p', 'RL', 'a'),
      wire('w2', 'RL', 'b', 'GND', 'g'),
      wire('w3', 'SC1', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3);
    expect(r).not.toBeNull();
    const ic = computeComponentCurrents(comps, ws, plugins(), r!.sim);
    const i = Math.abs(ic.get('RL') ?? 0);
    // Before the fix the ideal source pinned ~0.6 V across the 1 mOhm load
    // -> ~600 A. Now the Thevenin R (= vEff/isc) limits it to ~isc.
    expect(i).toBeLessThan(0.2);
    expect(i).toBeGreaterThan(0.02);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Analysis engine
// ─────────────────────────────────────────────────────────────────────────────

describe('runTran clock reset', () => {
  it('finalTime is ~tStop, not megaseconds', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-6 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'C1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runTran(comps, ws, plugins(), { type: 'tran', tStop: 1e-3, tStep: 1e-4, probes: ['C1:a'] });
    expect(r.scalars.finalTime as number).toBeLessThan(2e-3); // was ~1e6 before
    expect(r.traces[0].yValues.length).toBe(11); // t=0..tStop inclusive
  });
});

describe('runFour FFT bin', () => {
  it('measures the fundamental and harmonics of a clipped sine', () => {
    // 1 kHz sine with 10% 3rd harmonic, 32 points per period, 4 periods.
    const N = 128;
    const dt = 1 / 32000;
    const t = new Float64Array(N);
    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      t[i] = i * dt;
      v[i] = Math.sin(2 * Math.PI * 1000 * t[i]) + 0.1 * Math.sin(2 * Math.PI * 3000 * t[i]);
    }
    const r = runFour({ type: 'four', fundamentalFreq: 1000, nHarmonics: 5, timeValues: t, signalValues: v });
    const trace = r.traces[0];
    expect(trace.yValues[0]).toBeCloseTo(1.0, 1); // fundamental ~ 1 V (was 0 before)
    expect(trace.yValues[2]).toBeCloseTo(0.1, 1); // 3rd harmonic ~ 0.1 V
  });
});

describe('AC analysis treats DC sources as shorts', () => {
  it('biased common-emitter stage has finite, non-degenerate gain', () => {
    // Simple RC-coupled stage with a DC supply that must become an AC ground.
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 12 }),
      comp('dcVoltage', 'VIN', { voltage: 0 }),
      comp('resistor', 'RC', { resistance: 4700 }),
      comp('resistor', 'RB', { resistance: 470000 }),
      comp('capacitor', 'CIN', { capacitance: 1e-6 }),
      comp('capacitor', 'COUT', { capacitance: 1e-6 }),
      comp('npn', 'Q1', { hfe: 100, vbe: 0.7, satV: 0.2 }),
      comp('resistor', 'RL', { resistance: 10000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VCC', 'p', 'RC', 'a'),
      wire('w2', 'RC', 'b', 'Q1', 'c'),
      wire('w3', 'VCC', 'p', 'RB', 'a'),
      wire('w4', 'RB', 'b', 'Q1', 'b'),
      wire('w5', 'VIN', 'p', 'CIN', 'a'),
      wire('w6', 'CIN', 'b', 'Q1', 'b'),
      wire('w7', 'Q1', 'e', 'GND', 'g'),
      wire('w8', 'Q1', 'c', 'COUT', 'a'),
      wire('w9', 'COUT', 'b', 'RL', 'a'),
      wire('w10', 'RL', 'b', 'GND', 'g'),
      wire('w11', 'VCC', 'n', 'GND', 'g'),
      wire('w12', 'VIN', 'n', 'GND', 'g'),
    ];
    const r = runAC(comps, ws, plugins(), {
      type: 'ac', sweep: 'lin', nPoints: 5, fStart: 100, fStop: 10000,
      sourceId: 'VIN', acMag: 1, outputNode: 'RL:a', // complex trace
    } as any);
    // Before the fix the collector rail floated through gmin and the
    // transfer collapsed; any finite, non-NaN response is the fix working.
    const tr = r.traces[0];
    expect(tr.yValues.length).toBe(10); // 5 complex points, interleaved [re, im]
    let anyNonZero = false;
    for (let i = 0; i < tr.yValues.length; i += 2) {
      expect(isFinite(tr.yValues[i])).toBe(true);
      if (Math.abs(tr.yValues[i]) > 1e-9) anyNonZero = true;
    }
    expect(anyNonZero).toBe(true);
  });
});

describe('runDCSweep step guard', () => {
  it('returns an empty (not hanging) result for step = 0', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runDCSweep(comps, ws, plugins(), { type: 'dc', sourceId: 'V1', vStart: 0, vStop: 5, vStep: 0 });
    expect(r.traces[0].xValues.length).toBe(0); // completes instead of hanging
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Convergence aids
// ─────────────────────────────────────────────────────────────────────────────

describe('Source stepping reaches alpha = 1', () => {
  it('returns full-source node voltages on a divider', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 10 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = solveDCWithSourceStepping(comps, ws, plugins());
    // A plain divider solves directly, so source stepping falls through to a
    // full solve; verify the returned voltages are the FULL-source values
    // (the old bug returned 64%-source values when the plain solve failed).
    expect(r.sim).not.toBeNull();
    if (r.sim) {
      const nm = buildNodeMap(comps, ws, plugins());
      const mid = r.sim.nodeVoltage[nm.terminalNode.get('R1:b')!];
      expect(Math.abs(mid - 5)).toBeLessThan(0.5); // 5 V, not 3.2 V
    }
  });
});

describe('Pseudo-transient sizing fix', () => {
  it('converges on a voltage divider (was always singular)', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = solveDCWithPseudoTran(comps, ws, plugins());
    expect(r.sim).not.toBeNull(); // before the fix: always singular -> null
    if (r.sim) {
      const nm = buildNodeMap(comps, ws, plugins());
      const mid = r.sim.nodeVoltage[nm.terminalNode.get('R1:b')!];
      expect(mid).toBeCloseTo(2.5, 2);
    }
  });
});

describe('Gmin stepping (real shunt implementation)', () => {
  it('returns the full-source operating point', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = solveDCWithGminStepping(comps, ws, plugins());
    expect(r.sim).not.toBeNull();
    if (r.sim) {
      const nm = buildNodeMap(comps, ws, plugins());
      const v = r.sim.nodeVoltage[nm.terminalNode.get('R1:a')!];
      expect(v).toBeCloseTo(5, 3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Measurement / MC
// ─────────────────────────────────────────────────────────────────────────────

describe('FFT Hann normalization', () => {
  it('a bin-centered 2 V sine reads ~2 V (not 1 V)', () => {
    const N = 256;
    const xs = new Float64Array(N);
    const ys = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      xs[i] = i * 1e-4;
      ys[i] = 2 * Math.sin(2 * Math.PI * 1000 * xs[i]); // fs=10k, 1 kHz, bin 25.6
    }
    const r = computeFFT({ name: 'x', xValues: xs, yValues: ys });
    let maxVal = 0, maxIdx = 0;
    for (let i = 1; i < r.yValues.length; i++) {
      if (r.yValues[i] > maxVal) { maxVal = r.yValues[i]; maxIdx = i; }
    }
    expect(r.xValues[maxIdx]).toBeCloseTo(1000, -2);
    expect(maxVal).toBeGreaterThan(1.8); // was ~1.0 before (2x low)
    expect(maxVal).toBeLessThan(2.2);
  });
});

describe('.meas SPICE suffix parsing', () => {
  it('parses negative and suffixed FROM/TO values', () => {
    const cmd = parseMeasLine('.meas tran v_avg AVG V(out) FROM=-5ms TO=2.5ms');
    expect(cmd).not.toBeNull();
    expect(cmd!.fromTime).toBeCloseTo(-0.005, 9); // was -5 before
    expect(cmd!.toTime).toBeCloseTo(0.0025, 9);
  });
  it('parses meg/k suffixes', () => {
    const cmd = parseMeasLine('.meas tran t1 WHEN V(out)=1 FROM=1meg TO=2k');
    expect(cmd!.fromTime).toBeCloseTo(1e6, 1);
    expect(cmd!.toTime).toBeCloseTo(2000, 1);
  });
});

describe('.meas DELAY implementation', () => {
  it('returns the TRIG-to-TARG time difference', () => {
    const xs = new Float64Array(1000);
    const ys = new Float64Array(1000);
    for (let i = 0; i < 1000; i++) {
      xs[i] = i * 1e-5;
      ys[i] = xs[i] < 0.005 ? 0 : 5; // step at t=5ms
    }
    const cmd = parseMeasLine('.meas tran t_delay TRIG V(in)=0.5 TARG V(out)=2.5');
    expect(cmd).not.toBeNull();
    const r = execMeas(cmd!, { name: 'in', xValues: xs, yValues: ys });
    expect(r.value).toBeGreaterThan(0); // was always 0 (stub) before
  });
});

describe('Monte Carlo current measurement', () => {
  it('measures a resistor current through computeComponentCurrents', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const mc = runMonteCarlo(
      { version: 1, components: comps, wires: ws } as any,
      { runs: 10, seed: 42, tolerances: [{ componentId: 'R1', param: 'resistance', tolerance: 0.05 }], measurement: { type: 'current', componentId: 'R1' } } as any,
      plugins(),
    );
    expect(mc.runs.length).toBe(10);
    for (const run of mc.runs) {
      expect(isFinite(run.value)).toBe(true);
      expect(Math.abs(run.value)).toBeCloseTo(0.005, 2); // ~5 mA ± 5%
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration adapter + memory cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration adapter physics', () => {
  it('inductor companion source direction matches passive.ts (a->b)', () => {
    // 1 H inductor with iPrev = 1 A between nodes 1 and 2 (node 2 referenced
    // to ground through 1 S). Open-circuited at node 1, the companion forces
    // i = g*(V1-V2) + iPrev = 0 -> V1-V2 = -iPrev/g = -1000 V.
    // The old (b, a) source direction gave +1000 V.
    const sys = createMnaSystem(2, 0);
    sys.stampConductance(2, 0, 1); // ground reference for node 2
    const sim: any = { nodeVoltage: new Float64Array(3), branchCurrent: new Float64Array(4), time: 0, dt: 1e-3, state: { __global: {} } };
    stampInductor(1, 2, 1, 1e-3, sys as any, sim, 'L1', 'euler', 1);
    const x = solveMna(sys);
    expect(x).not.toBeNull();
    expect(x![0] - x![1]).toBeCloseTo(-1000, 0);
  });
});

describe('cleanupComponentState collision safety', () => {
  it('deleting comp_x_5 does not wipe comp_x_51 state', () => {
    const sim = { state: { __global: {
      'cap_comp_lzabc123_5': 1,
      'cap_comp_lzabc123_51': 2, // different component, shared prefix
      'other_comp_lzabc123_5': 3, // arbitrary prefix, deleted component
      'unrelated_key': 4,
      'led_1_2': 5, // node-based key — must stay
    } } };
    const removed = cleanupComponentState(sim, [
      { id: 'comp_lzabc123_51' },
    ]);
    const g = sim.state.__global;
    expect(g['cap_comp_lzabc123_51']).toBe(2);  // survivor's state intact
    expect(g['cap_comp_lzabc123_5']).toBeUndefined();  // deleted
    expect(g['other_comp_lzabc123_5']).toBeUndefined(); // deleted
    expect(g['unrelated_key']).toBe(4);
    expect(g['led_1_2']).toBe(5);
    expect(removed).toBe(2);
  });
});
