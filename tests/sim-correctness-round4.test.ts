// Simulation correctness — round 4 regressions.
//
// Each block pins a bug found by checking the engine against closed-form
// answers at tight tolerances (the older suites accepted up to 100% error on
// some transients, which is how these survived):
//
//   1. Wire currents violated KCL at junctions (min-of-two-estimates guess).
//   2. Trapezoidal cold start assumed i(0) = 0 → step responses less accurate
//      than backward Euler.
//   3. Cold-start step reported t = 0 while integrating over dt (sources one
//      step behind the reactive state).
//   4. No analysis passed SimOptions.temp to the DC operating point.
//   5. Is(T) used a "doubles every 10 °C" rule → diode Vf ROSE with T.
//   6. Gummel-Poon BJT: no B-C junction (no saturation) + linearized around
//      the previous timestep, so resistive circuits drifted off their DC point.
//   7. Level-1 MOSFET: no reverse mode (Vd = −50 V from a 10 V rail) and the
//      same stale linearization.
//   8. .disto replaced the input's DC bias with a bare sine and shared plugin
//      state across frequencies; it also mutated the caller's component.
//   9. .tran / DC sweep reported convergence over failed solves (DC sweep
//      plotted failures as 0 V).
import { describe, it, expect } from 'vitest';
import { simulateStep, buildNodeMap, solveDC, computeWireCurrents, computeComponentCurrents } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { runAnalysis } from '../src/lib/circuit/analysis';
import { tempScaleIs } from '../src/lib/circuit/sim-options';
import type { CircuitComponent, Wire, SimContext } from '../src/lib/circuit/types';
import '../src/lib/circuit/components';

function comp(type: string, id: string, p: Record<string, unknown> = {}): CircuitComponent {
  const pl = getPlugin(type);
  const d: Record<string, unknown> = {};
  if (pl) for (const pm of pl.parameters) d[pm.key] = pm.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...p } as any, simState: {} };
}
function w(id: string, f: string, ft: string, t: string, tt: string): Wire {
  return { id, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } };
}
const plugins = () => new Map(getAllPlugins().map((p) => [p.type, p]));
const volt = (c: CircuitComponent[], ws: Wire[], sim: SimContext, key: string) =>
  sim.nodeVoltage[buildNodeMap(c, ws, plugins()).terminalNode.get(key)!];

function transient(c: CircuitComponent[], ws: Wire[], dt: number, n: number, key: string, method: 'euler' | 'trap' | 'gear' = 'euler') {
  const p = plugins();
  let prev: any;
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = simulateStep(c, ws, p, prev, dt, { method });
    if (!r) throw new Error(`step ${i} failed`);
    out.push({ t: r.sim.time, v: volt(c, ws, r.sim, key) });
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return out;
}

const rcCharge = () => ({
  c: [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('capacitor', 'C1', { capacitance: 1e-6 }), comp('ground', 'G')],
  ws: [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'C1', 'a'), w('3', 'C1', 'b', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g')],
});
const npnBias = (type: string, rb: number) => ({
  c: [comp('dcVoltage', 'V1', { voltage: 10 }), comp('dcVoltage', 'V2', { voltage: 5 }), comp('resistor', 'RB', { resistance: rb }), comp('resistor', 'RC', { resistance: 1000 }), comp(type, 'Q1'), comp('ground', 'G')],
  ws: [w('1', 'V1', 'p', 'RC', 'a'), w('2', 'RC', 'b', 'Q1', 'c'), w('3', 'V2', 'p', 'RB', 'a'), w('4', 'RB', 'b', 'Q1', 'b'), w('5', 'Q1', 'e', 'G', 'g'), w('6', 'V1', 'n', 'G', 'g'), w('7', 'V2', 'n', 'G', 'g')],
});
const shockley = () => ({
  c: [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('diodeShockley', 'D1'), comp('ground', 'G')],
  ws: [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'D1', 'a'), w('3', 'D1', 'k', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g')],
});

describe('1. wire currents satisfy KCL exactly', () => {
  it('a wire feeding a junction carries the full branch current', () => {
    // V1 → R1 → X; X → R2 (1k) → gnd; X → R3 (4k) → gnd, X joined by a wire chain
    const c = [comp('dcVoltage', 'V1', { voltage: 10 }), comp('resistor', 'R1', { resistance: 1000 }), comp('resistor', 'R2', { resistance: 1000 }), comp('resistor', 'R3', { resistance: 4000 }), comp('ground', 'G')];
    const ws = [w('w1', 'V1', 'p', 'R1', 'a'), w('wx1', 'R1', 'b', 'R2', 'a'), w('wx2', 'R2', 'a', 'R3', 'a'), w('w3', 'R2', 'b', 'G', 'g'), w('w4', 'R3', 'b', 'G', 'g'), w('w5', 'V1', 'n', 'G', 'g')];
    const sim = solveDC(c, ws, plugins())!;
    const i = computeWireCurrents(c, ws, plugins(), sim);
    // I1 = 10/1800 = 5.556 mA splits 4.444 (R2) / 1.111 (R3)
    expect(i.get('wx1')!).toBeCloseTo(10 / 1800, 9); // was 4.444 mA
    expect(i.get('wx2')!).toBeCloseTo(10 / 1800 * 0.2, 9);
    expect(i.get('w3')!).toBeCloseTo(10 / 1800 * 0.8, 9);
  });

  it('KCL holds at every terminal for a saturated BJT (generic device, no per-type case)', () => {
    const { c, ws } = npnBias('bjtGPNpn', 10e3);
    const sim = solveDC(c, ws, plugins())!;
    const i = computeWireCurrents(c, ws, plugins(), sim);
    // emitter wire carries Ic + Ib
    expect(i.get('5')!).toBeCloseTo(i.get('2')! + i.get('4')!, 9);
    expect(i.get('2')!).toBeGreaterThan(9e-3);
  });

  it('generic devices report their solved current (Gummel-Poon collector)', () => {
    const { c, ws } = npnBias('bjtGPNpn', 100e3);
    const sim = solveDC(c, ws, plugins())!;
    const ic = computeComponentCurrents(c, ws, plugins(), sim).get('Q1')!;
    const vc = volt(c, ws, sim, 'Q1:c');
    expect(ic).toBeCloseTo((10 - vc) / 1000, 9);
  });
});

describe('2–3. transient start-up', () => {
  it('trapezoidal RC step response is second-order accurate from the first step', () => {
    const { c, ws } = rcCharge();
    const tr = transient(c, ws, 1e-4, 10, 'C1:a', 'trap'); // τ = 1 ms, dt = τ/10
    const last = tr[9];
    const exact = 5 * (1 - Math.exp(-last.t / 1e-3));
    // was 3.0% (worse than Euler's 2.8%); now limited by the trap LTE
    expect(Math.abs(last.v - exact) / exact).toBeLessThan(5e-4);
  });

  it('trapezoidal keeps an LC tank lossless (no damping from the start-up step)', () => {
    const c = [comp('inductor', 'L1', { inductance: 1e-3 }), comp('capacitor', 'C1', { capacitance: 1e-6, initialV: 1 }), comp('ground', 'G')];
    const ws = [w('1', 'L1', 'a', 'C1', 'a'), w('2', 'L1', 'b', 'G', 'g'), w('3', 'C1', 'b', 'G', 'g')];
    const tr = transient(c, ws, 1e-5, 2000, 'C1:a', 'trap'); // 100 periods
    const peak = Math.max(...tr.slice(-200).map((s) => Math.abs(s.v)));
    expect(peak).toBeGreaterThan(0.995);
    expect(peak).toBeLessThan(1.005);
  });

  it('the first step ends at t = dt, with sources sampled there', () => {
    const { c, ws } = rcCharge();
    const tr = transient(c, ws, 1e-4, 3, 'C1:a');
    expect(tr.map((s) => s.t)).toEqual([1e-4, 2e-4, 3e-4].map((t) => expect.closeTo(t, 15)));
    // backward Euler RC: v1 = 5·(dt/τ)/(1 + dt/τ)
    expect(tr[0].v).toBeCloseTo(5 * 0.1 / 1.1, 9);
  });
});

describe('4–5. temperature', () => {
  it('SPICE Is(T) law: Is grows ~15%/°C for silicon near room temperature', () => {
    const r = tempScaleIs(1e-14, 28, 27) / 1e-14;
    expect(r).toBeGreaterThan(1.12);
    expect(r).toBeLessThan(1.18);
    expect(tempScaleIs(1e-14, 27, 27)).toBeCloseTo(1e-14, 25);
  });

  it('.op honors SimOptions.temp and diode Vf falls ≈ 1.5–2.5 mV/°C', () => {
    const { c, ws } = shockley();
    const vf = (T: number) => runAnalysis(c, ws, plugins(), { type: 'op' }, { temp: T }).scalars['D1:a'];
    const slope = (vf(75) - vf(25)) / 50;
    expect(slope).toBeLessThan(-1.5e-3);
    expect(slope).toBeGreaterThan(-2.5e-3);
  });

  it('a .temp sweep of a transient produces distinct curves', () => {
    const { c, ws } = shockley();
    const r = runAnalysis(c, ws, plugins(), {
      type: 'temp', temperatures: [0, 50],
      inner: { type: 'tran', tStop: 1e-4, tStep: 1e-5, probes: ['D1:a'] },
    });
    const last = r.traces.map((t) => t.yValues[t.yValues.length - 1]);
    expect(last[0] - last[1]).toBeGreaterThan(0.05); // 0 °C sits well above 50 °C
  });

  it('Gummel-Poon Vbe falls with temperature', () => {
    const { c, ws } = npnBias('bjtGPNpn', 100e3);
    const vbe = (T: number) => runAnalysis(c, ws, plugins(), { type: 'op' }, { temp: T }).scalars['Q1:b'];
    expect(vbe(100)).toBeLessThan(vbe(0) - 0.1);
  });
});

describe('6. Gummel-Poon BJT', () => {
  it('a resistive bias network sits on its DC point from the first transient step', () => {
    const { c, ws } = npnBias('bjtGPNpn', 100e3);
    const dc = volt(c, ws, solveDC(c, ws, plugins(), 200)!, 'Q1:c');
    const tr = transient(npnBias('bjtGPNpn', 100e3).c, ws, 1e-6, 5, 'Q1:c');
    for (const s of tr) expect(s.v).toBeCloseTo(dc, 6); // was 5.83 → 5.23, drifting
    // forward-active: Ic ≈ Bf·Ib with Early effect, VC ≈ 5.5 V
    expect(dc).toBeGreaterThan(5.3);
    expect(dc).toBeLessThan(5.8);
  });

  it('saturates instead of pulling the collector below the emitter', () => {
    const { c, ws } = npnBias('bjtGPNpn', 10e3); // wants 43 mA, RC allows ~10 mA
    const vc = volt(c, ws, solveDC(c, ws, plugins())!, 'Q1:c');
    expect(vc).toBeGreaterThan(0.02);
    expect(vc).toBeLessThan(0.3);
  });

  it('PNP mirrors the NPN', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 10 }), comp('dcVoltage', 'V2', { voltage: 5 }), comp('resistor', 'RB', { resistance: 100e3 }), comp('resistor', 'RC', { resistance: 1000 }), comp('bjtGPPnp', 'Q1'), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'Q1', 'e'), w('2', 'Q1', 'c', 'RC', 'a'), w('3', 'RC', 'b', 'G', 'g'), w('4', 'V2', 'p', 'RB', 'b'), w('5', 'RB', 'a', 'Q1', 'b'), w('6', 'V1', 'n', 'G', 'g'), w('7', 'V2', 'n', 'G', 'g')];
    const sim = solveDC(c, ws, plugins())!;
    expect(volt(c, ws, sim, 'Q1:b')).toBeCloseTo(10 - 0.75, 0);
    expect(volt(c, ws, sim, 'Q1:c')).toBeGreaterThan(4.2);
    expect(volt(c, ws, sim, 'Q1:c')).toBeLessThan(4.7);
  });
});

describe('7. Level-1 MOSFET', () => {
  const nmosSwitch = () => ({
    c: [comp('dcVoltage', 'V1', { voltage: 10 }), comp('dcVoltage', 'V2', { voltage: 3 }), comp('resistor', 'RD', { resistance: 1000 }), comp('mosLevel1N', 'M1'), comp('ground', 'G')],
    ws: [w('1', 'V1', 'p', 'RD', 'a'), w('2', 'RD', 'b', 'M1', 'd'), w('3', 'V2', 'p', 'M1', 'g'), w('5', 'M1', 's', 'G', 'g'), w('5b', 'M1', 'b', 'G', 'g'), w('6', 'V1', 'n', 'G', 'g'), w('7', 'V2', 'n', 'G', 'g')],
  });

  it('triode switch pulls the drain near ground (was −50 V)', () => {
    const { c, ws } = nmosSwitch();
    const vd = volt(c, ws, solveDC(c, ws, plugins())!, 'M1:d');
    // triode: Kp·(Vov·Vd − Vd²/2)(1 + λVd) = (10 − Vd)/1k → Vd ≈ 0.101
    const p = c.find((x) => x.id === 'M1')!.parameters as any;
    const id = p.Kp * (2 * vd - vd * vd / 2) * (1 + p.Lambda * vd);
    expect(id).toBeCloseTo((10 - vd) / 1000, 6);
    expect(vd).toBeGreaterThan(0.05);
    expect(vd).toBeLessThan(0.2);
  });

  it('is memoryless in transient: every step equals the DC solution', () => {
    const { c, ws } = nmosSwitch();
    const dc = volt(c, ws, solveDC(c, ws, plugins())!, 'M1:d');
    for (const s of transient(nmosSwitch().c, ws, 1e-6, 4, 'M1:d')) expect(s.v).toBeCloseTo(dc, 6);
  });

  it('conducts in reverse mode (source and drain swap roles)', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('dcVoltage', 'V2', { voltage: 10 }), comp('resistor', 'R', { resistance: 1000 }), comp('mosLevel1N', 'M1', { Gamma: 0 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R', 'a'), w('2', 'R', 'b', 'M1', 's'), w('3', 'M1', 'd', 'G', 'g'), w('3b', 'M1', 'b', 'G', 'g'), w('4', 'V2', 'p', 'M1', 'g'), w('6', 'V1', 'n', 'G', 'g'), w('7', 'V2', 'n', 'G', 'g')];
    const vs = volt(c, ws, solveDC(c, ws, plugins())!, 'M1:s');
    expect(vs).toBeGreaterThan(0);
    expect(vs).toBeLessThan(0.05);
  });

  it('no longer advertises inert W/L parameters', () => {
    const keys = getPlugin('mosLevel1N')!.parameters.map((p) => p.key);
    expect(keys).not.toContain('W');
    expect(keys).not.toContain('L');
  });
});

describe('8. distortion analysis', () => {
  // Base driven directly (RB = 1 Ω) at a 0.65 V DC bias: the 100 mV tone
  // gives Ic ∝ exp(x·sin ωt), x = 0.1 V / Vt, whose harmonics are modified
  // Bessel functions — HD2 = I₂(x)/I₁(x), HD3 = I₃(x)/I₁(x). Only a correctly
  // BIASED transistor produces this; the old code replaced the 0.65 V source
  // with a bare 0.1 V sine (transistor cut off).
  const besselI = (n: number, x: number) => {
    let sum = 0;
    const fact = (k: number) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };
    for (let k = 0; k < 30; k++) sum += (x / 2) ** (2 * k + n) / (fact(k) * fact(k + n));
    return sum;
  };
  const ceAmp = () => {
    const c = [comp('dcVoltage', 'VIN', { voltage: 0.65 }), comp('dcVoltage', 'VCC', { voltage: 10 }), comp('resistor', 'RB', { resistance: 1 }), comp('resistor', 'RC', { resistance: 1000 }), comp('bjtGPNpn', 'Q1', { Vaf: 1e4 }), comp('ground', 'G')];
    const ws = [w('1', 'VIN', 'p', 'RB', 'a'), w('2', 'RB', 'b', 'Q1', 'b'), w('3', 'VCC', 'p', 'RC', 'a'), w('4', 'RC', 'b', 'Q1', 'c'), w('5', 'Q1', 'e', 'G', 'g'), w('6', 'VIN', 'n', 'G', 'g'), w('7', 'VCC', 'n', 'G', 'g')];
    return { c, ws };
  };

  it('keeps the input bias: HD2/HD3 match the exponential (Bessel) law', () => {
    const { c, ws } = ceAmp();
    const before = JSON.stringify(c.find((x) => x.id === 'VIN')!.parameters);
    const r = runAnalysis(c, ws, plugins(), {
      type: 'disto', sweep: 'lin', nPoints: 1, fStart: 1000, fStop: 1000,
      inputSourceId: 'VIN', outputNode: 'Q1:c',
    } as any);
    // the caller's component is never mutated
    expect(JSON.stringify(c.find((x) => x.id === 'VIN')!.parameters)).toBe(before);
    const x = 0.1 / (1.380649e-23 * 300.15 / 1.602176634e-19);
    const hd2 = r.traces.find((t) => /hd2/i.test(t.name))!.yValues[0];
    const hd3 = r.traces.find((t) => /hd3/i.test(t.name))!.yValues[0];
    expect(hd2).toBeCloseTo(besselI(2, x) / besselI(1, x), 1);
    expect(hd3).toBeCloseTo(besselI(3, x) / besselI(1, x), 1);
  });

  it('every frequency starts from the same bias state', () => {
    // a coupling capacitor makes the result depend on starting state: the
    // old code carried the previous frequency's capacitor history forward
    const { c, ws } = ceAmp();
    const cfg = (n: number) => ({
      type: 'disto', sweep: 'lin', nPoints: n, fStart: 1000, fStop: 1000,
      inputSourceId: 'VIN', outputNode: 'Q1:c',
    } as any);
    c.push(comp('capacitor', 'CL', { capacitance: 1e-6 }));
    ws.push(w('8', 'Q1', 'c', 'CL', 'a'), w('9', 'CL', 'b', 'G', 'g'));
    const one = runAnalysis(c, ws, plugins(), cfg(1)).traces.find((t) => /thd/i.test(t.name))!.yValues;
    const three = runAnalysis(c, ws, plugins(), cfg(3)).traces.find((t) => /thd/i.test(t.name))!.yValues;
    for (const v of three) expect(v).toBeCloseTo(one[0], 9);
  });
});

describe('9. honest convergence reports', () => {
  it('DC sweep plots failed points as gaps and reports them', () => {
    // no ground reference at all → every solve fails (was plotted as 0 V
    // with converged: true)
    const c = [comp('dcVoltage', 'V1', { voltage: 1 }), comp('resistor', 'R1')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'V1', 'n')];
    const r = runAnalysis(c, ws, plugins(), { type: 'dc', sourceId: 'V1', vStart: 0, vStop: 1, vStep: 0.5, outputNode: 'R1:a' });
    expect(r.report.converged).toBe(false);
    expect(Array.from(r.traces[0].yValues).every((v) => Number.isNaN(v))).toBe(true);
  });

  it('.tran reports a failed step instead of claiming convergence', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 1 }), comp('resistor', 'R1')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'V1', 'n')];
    const r = runAnalysis(c, ws, plugins(), { type: 'tran', tStop: 1e-3, tStep: 1e-4, probes: ['R1:a'] }, { uic: true });
    expect(r.report.converged).toBe(false);
    expect(r.report.message).toMatch(/failed/);
  });

  it('DC sweep of an acVoltage source sweeps its DC offset', () => {
    const c = [comp('acVoltage', 'V1', { amplitude: 1, offset: 0 }), comp('resistor', 'R1'), comp('resistor', 'R2'), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'R2', 'a'), w('3', 'R2', 'b', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g')];
    const r = runAnalysis(c, ws, plugins(), { type: 'dc', sourceId: 'V1', vStart: 0, vStop: 2, vStep: 1, outputNode: 'R2:a' });
    expect(Array.from(r.traces[0].yValues)).toEqual([0, 0.5, 1].map((v) => expect.closeTo(v, 9)));
  });
});
