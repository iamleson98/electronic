// Cross-validation integration tests: the numbers the TEACHING engine
// (circuit.walkthrough) predicts must match what the PHYSICS engine actually
// simulates. This is the grounding guarantee: the AI can never teach a value
// the simulator disagrees with.
//
// 1. LED current: walkthrough's (V−Vf)/R prediction vs solveDC-measured current
// 2. RC step response: τ = RC prediction vs transient V(τ) ≈ 63.2% of final
// 3. 555 astable (external RC): predicted f = 1/(ln2(R1+2R2)C) vs measured
//    output toggle frequency from a real transient run
// 4. Voltage divider: walkthrough Vout vs solveDC node voltage
// 5. Op-amp inverting gain: walkthrough −Rf/Rin vs measured Vout/Vin slope
//    (two DC input levels)

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import {
  simulateStep,
  solveDC,
  buildNodeMap,
  computeComponentCurrents,
  getTerminalsForComponent,
} from '../src/lib/circuit/engine';
import { analyzeCircuitWalkthrough } from '../src/lib/ai/tools/walkthrough-tools';
import type { CircuitComponent, Wire, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(type: string, id: string, pos: [number, number], params?: Record<string, unknown>): CircuitComponent {
  const p = getPlugin(type);
  const defaults: Record<string, unknown> = {};
  if (p) for (const pm of p.parameters) defaults[pm.key] = pm.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}
function plugins(): Map<string, unknown> {
  return new Map(getAllPlugins().map((p) => [p.type, p]));
}
function vOf(comps: CircuitComponent[], ws: Wire[], sim: SimContext, cid: string, tid: string): number {
  const map = buildNodeMap(comps, ws, plugins() as never);
  const c = comps.find((x) => x.id === cid)!;
  const p = getPlugin(c.type)!;
  const terms = getTerminalsForComponent(c, p as never, map);
  return sim.nodeVoltage[terms.find((t) => t.terminalId === tid)?.nodeId ?? 0] ?? 0;
}

/** Time-stepping driver with persistent state (hall-sensors pattern). */
class Driver {
  comps: CircuitComponent[];
  ws: Wire[];
  prev: unknown = undefined;
  sim: SimContext | null = null;

  constructor(comps: CircuitComponent[], ws: Wire[]) {
    this.comps = comps;
    this.ws = ws;
  }

  step(dt = 1e-4): this {
    const r = simulateStep(this.comps, this.ws, plugins() as never, this.prev, dt);
    if (!r) throw new Error('simulateStep failed');
    this.sim = r.sim;
    this.prev = {
      nodeVoltage: r.sim.nodeVoltage,
      branchCurrent: r.sim.branchCurrent,
      time: r.sim.time,
      state: r.sim.state,
    };
    return this;
  }

  settle(n = 2, dt?: number): this {
    for (let i = 0; i < n; i++) this.step(dt);
    return this;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('grounding: walkthrough predictions vs engine physics', () => {
  it('LED current: (V−Vf)/R prediction matches solveDC within 15%', () => {
    const comps = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('resistor', 'R1', [4, 0], { resistance: 330 }),
      comp('led', 'D1', [8, 0], { forwardVoltage: 2 }),
      comp('ground', 'GND', [0, 4], {}),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'D1', 'a'),
      wire('w3', 'D1', 'k', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];

    // What the AI would teach (includes the LED model's internal 220 Ω
    // series resistance — the real current path is R1 + LED seriesR):
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const outBlock = wt.blocks.find((b) => b.kind === 'output')!;
    const ledPart = outBlock.components.find((p) => p.type === 'led')!;
    const predStr = ledPart.analysis!.find((a) => /LED current/i.test(a.label))!.value;
    const predicted = parseFloat(predStr.replace(/[^\d.]/g, ''));
    const predScale = predStr.includes('m') ? 1e-3 : predStr.includes('u') ? 1e-6 : 1;
    const predictedA = predicted * predScale;
    expect(predictedA).toBeCloseTo((5 - 2) / 550, 3); // 5.45 mA with internal Rs

    // What the engine actually does:
    const sim = solveDC(comps, ws, plugins() as never);
    expect(sim).not.toBeNull();
    const currents = computeComponentCurrents(comps, ws, plugins() as never, sim!);
    const actualA = Math.abs(currents.get('D1') ?? 0);
    // LED diode physics has series resistance; 15% tolerance
    expect(Math.abs(actualA - predictedA) / predictedA).toBeLessThan(0.15);
  });

  it('RC step response: V(τ) reaches ~63% of final value', () => {
    const R = 1000, C = 1e-6;
    const tau = R * C; // 1 ms
    const comps = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('resistor', 'R1', [4, 0], { resistance: R }),
      comp('capacitor', 'C1', [8, 0], { capacitance: C }),
      comp('ground', 'GND', [0, 4], {}),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'C1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];

    const dt = tau / 50; // 50 steps per τ
    const d = new Driver(comps, ws);
    // step until sim.time >= τ (drive the step response from 0 V)
    while (d.sim == null || d.sim.time < tau) d.step(dt);
    const vAtTau = vOf(comps, ws, d.sim!, 'C1', 'a');
    const final = 5;
    const pct = (vAtTau / final) * 100;
    // 1 − e^−1 = 63.2%; trapezoidal integration lands close
    expect(pct).toBeGreaterThan(58);
    expect(pct).toBeLessThan(68);
  });

  it('555 astable (external RC): predicted frequency matches measured toggles within 15%', () => {
    const R1 = 10000, R2 = 47000, C = 1e-6;
    const predictedF = 1 / (Math.LN2 * (R1 + 2 * R2) * C); // ≈ 13.87 Hz
    const predictedPeriod = 1 / predictedF;

    const comps = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 9 }),
      // vcc param must match the supply — the 555 derives its 2/3·VCC and
      // 1/3·VCC thresholds from it.
      comp('timer555', 'U1', [8, 0], { vcc: 9 }),
      comp('resistor', 'RA', [0, 2], { resistance: R1 }),
      comp('resistor', 'RB', [0, 3], { resistance: R2 }),
      comp('capacitor', 'CT', [0, 4], { capacitance: C }),
      comp('voltmeter', 'VM', [14, 0]),
      comp('ground', 'GND', [0, 8], {}),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'RA', 'a'),
      wire('w2', 'RA', 'b', 'U1', 'dis'),
      wire('w3', 'U1', 'dis', 'RB', 'a'),
      wire('w4', 'RB', 'b', 'U1', 'thr'),
      wire('w5', 'U1', 'thr', 'CT', 'a'),
      wire('w6', 'CT', 'b', 'GND', 'g'),
      wire('w7', 'U1', 'trig', 'U1', 'thr'),
      wire('w8', 'U1', 'vcc', 'V1', 'p'),
      wire('w9', 'U1', 'rst', 'V1', 'p'),
      wire('w10', 'U1', 'gnd', 'GND', 'g'),
      wire('w11', 'V1', 'n', 'GND', 'g'),
      wire('w12', 'U1', 'out', 'VM', 'p'),
      wire('w13', 'VM', 'n', 'GND', 'g'),
    ];

    // Walkthrough must predict this exact frequency
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const timing = wt.blocks.find((b) => b.kind === 'timing')!;
    const t555 = timing.components.find((p) => p.type === 'timer555')!;
    const fStr = t555.analysis!.find((a) => /frequency/i.test(a.label))!.value;
    const wtF = parseFloat(fStr.replace(/[^\d.]/g, ''));
    const wtScale = fStr.includes('k') ? 1e3 : fStr.includes('m') ? 1e-3 : 1;
    expect(wtF * wtScale).toBeCloseTo(predictedF, 1);

    // Run the real transient and count rising edges on OUT (read via the
    // voltmeter's + terminal, which shares the OUT net)
    const d = new Driver(comps, ws);
    const dt = 1e-4;
    let prevOut = 0;
    const risingEdges: number[] = [];
    const runTime = predictedPeriod * 5; // ~5 cycles
    let guard = 0;
    while ((d.sim?.time ?? 0) < runTime && guard < 2000000) {
      d.step(dt);
      guard++;
      const out = vOf(comps, ws, d.sim!, 'VM', 'p');
      if (out > 4 && prevOut <= 4) risingEdges.push(d.sim.time);
      prevOut = out;
    }
    // Need at least 2 edges to measure a period
    expect(risingEdges.length).toBeGreaterThanOrEqual(2);
    const periods: number[] = [];
    for (let i = 1; i < risingEdges.length; i++) {
      periods.push(risingEdges[i] - risingEdges[i - 1]);
    }
    const avgPeriod = periods.reduce((a, b) => a + b, 0) / periods.length;
    const measuredF = 1 / avgPeriod;
    expect(Math.abs(measuredF - predictedF) / predictedF).toBeLessThan(0.15);
  });

  it('voltage divider: walkthrough Vout matches solveDC within 1%', () => {
    const comps = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 12 }),
      comp('resistor', 'RT', [4, 0], { resistance: 10000 }),
      comp('resistor', 'RB', [8, 0], { resistance: 22000 }),
      comp('ground', 'GND', [0, 4], {}),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'RT', 'a'),
      wire('w2', 'RT', 'b', 'RB', 'a'),
      wire('w3', 'RB', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];

    const expected = 12 * 22000 / 32000; // 8.25 V

    const wt = analyzeCircuitWalkthrough(comps, ws);
    const support = wt.blocks.find((b) => b.kind === 'support')!;
    const divPart = support.components.find((p) => p.role.includes('Voltage divider'))!;
    const vStr = divPart.analysis!.find((a) => /Output voltage/i.test(a.label))!.value;
    expect(parseFloat(vStr)).toBeCloseTo(expected, 2);

    const sim = solveDC(comps, ws, plugins() as never);
    expect(sim).not.toBeNull();
    const mid = vOf(comps, ws, sim!, 'RB', 'a');
    expect(Math.abs(mid - expected) / expected).toBeLessThan(0.01);
  });

  it('op-amp inverting gain: walkthrough −Rf/Rin matches DC transfer slope within 10%', () => {
    const buildWith = (vin: number) => {
      const comps = [
        comp('dcVoltage', 'VIN', [0, 0], { voltage: vin }),
        // Ideal VCCS op-amp — the canonical inverting-amp model (example 6
        // uses the same type). opampRails latches its saturation state at
        // gain 1e5 in a cold-start transient, so it is not used here.
        comp('opamp', 'U1', [8, 0], { gain: 1e5 }),
        comp('resistor', 'RIN', [4, 0], { resistance: 1000 }),
        comp('resistor', 'RF', [4, 3], { resistance: 10000 }),
        comp('voltmeter', 'VM', [14, 0]),
        comp('ground', 'GND', [0, 8], {}),
      ];
      const ws = [
        wire('w1', 'VIN', 'p', 'RIN', 'a'),
        wire('w2', 'VIN', 'n', 'GND', 'g'),
        wire('w3', 'RIN', 'b', 'U1', 'in-'),
        wire('w4', 'U1', 'in-', 'RF', 'a'),
        wire('w5', 'RF', 'b', 'U1', 'out'),
        wire('w6', 'U1', 'in+', 'GND', 'g'),
        wire('w7', 'U1', 'out', 'VM', 'p'),
        wire('w8', 'VM', 'n', 'GND', 'g'),
      ];
      return { comps, ws };
    };

    // The walkthrough's stated gain (from the same topology)
    const { comps, ws } = buildWith(0.1);
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const amp = wt.blocks.find((b) => b.kind === 'amplification')!;
    const oa = amp.components.find((p) => /^opamp/.test(p.type))!;
    const gainStr = oa.analysis!.find((a) => /Voltage gain/i.test(a.label))!.value;
    expect(parseFloat(gainStr.replace('×', ''))).toBeCloseTo(-10, 1);

    // Engine: settle each input level and measure Vout, compute the slope
    const a = buildWith(0.05);
    const dA = new Driver(a.comps, a.ws).settle(400, 1e-4);
    const b = buildWith(0.15);
    const dB = new Driver(b.comps, b.ws).settle(400, 1e-4);
    const outA = vOf(a.comps, a.ws, dA.sim!, 'VM', 'p');
    const outB = vOf(b.comps, b.ws, dB.sim!, 'VM', 'p');
    const slope = (outB - outA) / (0.15 - 0.05);
    expect(slope).toBeLessThan(0); // inverting
    expect(Math.abs(Math.abs(slope) - 10) / 10).toBeLessThan(0.10);
  });
});
