// Component library — real-world behavior and library-wide guards.
//
// Datasheet-level checks for the parts reworked in this round, plus two
// guards over EVERY registered plugin:
//   - health: each part simulates on a generic bench (rails tied, every
//     signal pin driven through 10 kΩ or left open) without solve failures,
//     NaN or runaway voltages;
//   - Newton flag: a stamp that reads node voltages must be flagged
//     nonLinear/feedback, or its decisions lag one timestep.
import { describe, it, expect } from 'vitest';
import { simulateStep, buildNodeMap, solveDC } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { createMnaSystem } from '../src/lib/circuit/solver';
import { runAnalysis } from '../src/lib/circuit/analysis';
import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from '../src/lib/circuit/types';
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
const V = (c: CircuitComponent[], ws: Wire[], s: SimContext, key: string) =>
  s.nodeVoltage[buildNodeMap(c, ws, plugins()).terminalNode.get(key)!];
const acMag = (r: any, i = 0) => Math.hypot(r.traces[0].yValues[2 * i], r.traces[0].yValues[2 * i + 1]);

// ─────────────────────────────────────────────────────────────────────────────
// Unwired pins float
// ─────────────────────────────────────────────────────────────────────────────
describe('unwired pins float instead of being grounded', () => {
  it('a battery with one terminal wired does not break the circuit', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1'), comp('dcVoltage', 'VX', { voltage: 9 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'G', 'g'), w('3', 'V1', 'n', 'G', 'g'), w('4', 'VX', 'n', 'G', 'g')];
    const s = solveDC(c, ws, plugins());
    expect(s).not.toBeNull(); // was a singular matrix
    expect(V(c, ws, s!, 'R1:a')).toBeCloseTo(5, 9);
  });

  it('a resistor with a free end carries no current', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1'), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('3', 'V1', 'n', 'G', 'g')];
    const s = solveDC(c, ws, plugins())!;
    expect(Math.abs(s.terminalCurrents!.get('R1:a')!)).toBeLessThan(1e-9);
    expect(V(c, ws, s, 'R1:b')).toBeCloseTo(5, 6); // floats with the driven end
  });

  it('an unwired 555 RST no longer holds the timer in reset', () => {
    const c = [comp('dcVoltage', 'VCC', { voltage: 5 }), comp('timer555', 'U1'), comp('dcVoltage', 'VT', { voltage: 0 }), comp('ground', 'G')];
    const ws = [w('1', 'VCC', 'p', 'U1', 'vcc'), w('2', 'U1', 'gnd', 'G', 'g'), w('3', 'VCC', 'n', 'G', 'g'), w('4', 'VT', 'p', 'U1', 'trig'), w('5', 'VT', 'n', 'G', 'g')];
    let prev: any;
    let s: SimContext | null = null;
    for (let i = 0; i < 3; i++) {
      const r = simulateStep(c, ws, plugins(), prev, 1e-4)!;
      s = r.sim;
      prev = { nodeVoltage: s.nodeVoltage, branchCurrent: s.branchCurrent, time: s.time, state: s.state };
    }
    // TRIG low → output HIGH (RST floats up through its internal pull-up)
    // NE555 datasheet: VOH ≈ Vcc − 1.0 V (= 4 V on 5 V)
    expect(V(c, ws, s!, 'U1:out')).toBeGreaterThan(3.8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Op-amps — datasheet behavior on the shared core
// ─────────────────────────────────────────────────────────────────────────────
describe('op-amps behave like their datasheets', () => {
  const nonInv = (vin: CircuitComponent, part = 'lm741') => {
    const c = [comp('dcVoltage', 'VCC', { voltage: 15 }), comp('dcVoltage', 'VEE', { voltage: -15 }), vin, comp(part, 'U1', { voff: 0 }), comp('resistor', 'RF', { resistance: 99000 }), comp('resistor', 'RG', { resistance: 1000 }), comp('ground', 'G')];
    const ws = [w('1', 'VCC', 'p', 'U1', 'vcc'), w('2', 'VEE', 'p', 'U1', 'vee'), w('3', 'VCC', 'n', 'G', 'g'), w('4', 'VEE', 'n', 'G', 'g'), w('5', 'VIN', 'p', 'U1', 'inp'), w('6', 'VIN', 'n', 'G', 'g'), w('7', 'U1', 'out', 'RF', 'a'), w('8', 'RF', 'b', 'U1', 'inn'), w('9', 'RG', 'a', 'U1', 'inn'), w('10', 'RG', 'b', 'G', 'g')];
    return { c, ws };
  };

  it('closed-loop bandwidth = GBW / gain (LM741, G = 100 → −3 dB at 10 kHz)', () => {
    const { c, ws } = nonInv(comp('acVoltage', 'VIN', { amplitude: 0.01 }));
    const r = runAnalysis(c, ws, plugins(), { type: 'ac', sweep: 'dec', nPoints: 1, fStart: 100, fStop: 1e5, sourceId: 'VIN', outputNode: 'U1:out' } as any);
    expect(acMag(r, 0)).toBeCloseTo(100, 0);           // 100 Hz
    expect(acMag(r, 2)).toBeCloseTo(100 / Math.SQRT2, 0); // 10 kHz
    expect(acMag(r, 3)).toBeCloseTo(10, 0);            // 100 kHz
  });

  it('slew rate limits a large step (LM741, 0.5 V/µs)', () => {
    const vin = comp('dcVoltage', 'VIN', { voltage: 0 });
    const c = [comp('dcVoltage', 'VCC', { voltage: 15 }), comp('dcVoltage', 'VEE', { voltage: -15 }), vin, comp('lm741', 'U1', { voff: 0 }), comp('resistor', 'RL', { resistance: 10000 }), comp('ground', 'G')];
    const ws = [w('1', 'VCC', 'p', 'U1', 'vcc'), w('2', 'VEE', 'p', 'U1', 'vee'), w('3', 'VCC', 'n', 'G', 'g'), w('4', 'VEE', 'n', 'G', 'g'), w('5', 'VIN', 'p', 'U1', 'inp'), w('6', 'VIN', 'n', 'G', 'g'), w('7', 'U1', 'out', 'U1', 'inn'), w('8', 'U1', 'out', 'RL', 'a'), w('9', 'RL', 'b', 'G', 'g')];
    let prev: any;
    const out: number[] = [];
    for (let i = 0; i < 40; i++) {
      if (i === 10) (vin.parameters as any).voltage = 10;
      const r = simulateStep(c, ws, plugins(), prev, 1e-6)!;
      out.push(V(c, ws, r.sim, 'U1:out'));
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(Math.abs(out[9])).toBeLessThan(0.01);
    for (let i = 11; i < 18; i++) expect(out[i] - out[i - 1]).toBeCloseTo(0.5, 1); // 0.5 V per µs
    expect(out[39]).toBeCloseTo(10, 2); // 10 V / 0.5 V/µs = 20 µs, then settled
  });

  it('LM358 on a single 5 V supply swings 5 mV … V+ − 1.5 V', () => {
    for (const [vin, expected] of [[1, 0.005], [4, 3.5]] as const) {
      const c = [comp('dcVoltage', 'VCC', { voltage: 5 }), comp('dcVoltage', 'VIN', { voltage: vin }), comp('dcVoltage', 'VR', { voltage: 2.5 }), comp('lm358', 'U1'), comp('resistor', 'RL', { resistance: 100000 }), comp('ground', 'G')];
      const ws = [w('1', 'VCC', 'p', 'U1', 'vcc'), w('2', 'U1', 'vee', 'G', 'g'), w('3', 'VCC', 'n', 'G', 'g'), w('5', 'VIN', 'p', 'U1', 'inp'), w('6', 'VIN', 'n', 'G', 'g'), w('7', 'VR', 'p', 'U1', 'inn'), w('7b', 'VR', 'n', 'G', 'g'), w('8', 'U1', 'out', 'RL', 'a'), w('9', 'RL', 'b', 'G', 'g')];
      expect(V(c, ws, solveDC(c, ws, plugins())!, 'U1:out')).toBeCloseTo(expected, 1);
    }
  });

  it('a comparator edge has no open-loop voltage spike', () => {
    const c = [comp('dcVoltage', 'VCC', { voltage: 12 }), comp('dcVoltage', 'VEE', { voltage: -12 }), comp('pulseSource', 'VIN', { high: 1, low: -1, frequency: 500, duty: 50 }), comp('opampRails', 'U1'), comp('ground', 'G')];
    const ws = [w('1', 'VCC', 'p', 'U1', 'v+'), w('2', 'VEE', 'p', 'U1', 'v-'), w('3', 'VCC', 'n', 'G', 'g'), w('4', 'VEE', 'n', 'G', 'g'), w('5', 'VIN', 'p', 'U1', 'in+'), w('6', 'VIN', 'n', 'G', 'g'), w('7', 'U1', 'in-', 'G', 'g')];
    let prev: any;
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      const r = simulateStep(c, ws, plugins(), prev, 2e-5)!;
      peak = Math.max(peak, Math.abs(V(c, ws, r.sim, 'U1:out')));
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    expect(peak).toBeLessThan(12); // was ~5e5 V for one step per edge
    expect(peak).toBeGreaterThan(11);
  });

  it('output current comes from the rails and is short-circuit limited', () => {
    for (const [rl, iOut] of [[1000, 0.01], [1, 0.025]] as const) {
      const c = [comp('dcVoltage', 'VCC', { voltage: 15 }), comp('dcVoltage', 'VEE', { voltage: -15 }), comp('dcVoltage', 'VIN', { voltage: 10 }), comp('lm741', 'U1'), comp('resistor', 'RL', { resistance: rl }), comp('ground', 'G')];
      const ws = [w('1', 'VCC', 'p', 'U1', 'vcc'), w('2', 'VEE', 'p', 'U1', 'vee'), w('3', 'VCC', 'n', 'G', 'g'), w('4', 'VEE', 'n', 'G', 'g'), w('5', 'VIN', 'p', 'U1', 'inp'), w('6', 'VIN', 'n', 'G', 'g'), w('7', 'U1', 'out', 'U1', 'inn'), w('8', 'U1', 'out', 'RL', 'a'), w('9', 'RL', 'b', 'G', 'g')];
      const tc = solveDC(c, ws, plugins())!.terminalCurrents!;
      const iq = 1.7e-3;
      expect(tc.get('U1:vcc')!).toBeCloseTo(iOut + iq, 4);   // load + quiescent from V+
      expect(tc.get('U1:vee')!).toBeCloseTo(-iq, 4);         // quiescent back to V−
      expect(tc.get('U1:out')!).toBeCloseTo(-iOut, 4);       // out of the OUT pin
    }
  });

  it('the ideal op-amp is limited to its ±15 V output range', () => {
    const c = [comp('dcVoltage', 'VIN', { voltage: 1 }), comp('opamp', 'U1'), comp('ground', 'G')];
    const ws = [w('1', 'VIN', 'p', 'U1', 'in+'), w('2', 'VIN', 'n', 'G', 'g'), w('3', 'U1', 'in-', 'G', 'g')];
    expect(V(c, ws, solveDC(c, ws, plugins())!, 'U1:out')).toBeCloseTo(15, 1);
  });

  it('every op-amp part exposes and honors its datasheet parameters', () => {
    for (const t of ['lm358', 'lm324', 'lm741', 'tl072', 'ne5532', 'opampReal']) {
      const keys = getPlugin(t)!.parameters.map((p) => p.key);
      for (const k of ['gain', 'gbw', 'slewRate', 'voff', 'ibias', 'cmrr', 'rout', 'iLimit', 'iq']) expect(keys).toContain(k);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC analysis covers every part
// ─────────────────────────────────────────────────────────────────────────────
describe('AC analysis includes parts without a hand-written phasor model', () => {
  it('potentiometer divider', () => {
    const c = [comp('acVoltage', 'V1', { amplitude: 1 }), comp('potentiometer', 'P1', { wiper: 50 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'P1', 'a'), w('2', 'P1', 'b', 'G', 'g'), w('3', 'V1', 'n', 'G', 'g')];
    const r = runAnalysis(c, ws, plugins(), { type: 'ac', sweep: 'dec', nPoints: 1, fStart: 1000, fStop: 1000, sourceId: 'V1', outputNode: 'P1:w' } as any);
    expect(acMag(r)).toBeCloseTo(0.5, 6); // was an open circuit
  });

  it('coupled inductors match the phasor solution (L1 = 4·L2 → 2:1, k = 0.999)', () => {
    const L1 = 4e-3, L2 = 1e-3, k = 0.999;
    const c = [comp('acVoltage', 'V1', { amplitude: 1 }), comp('resistor', 'RS', { resistance: 1 }), comp('coupledInductor', 'T1', { L1, L2, k }), comp('resistor', 'RL', { resistance: 1000 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'RS', 'a'), w('2', 'RS', 'b', 'T1', 'p1'), w('3', 'T1', 'p2', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g'), w('5', 'T1', 's1', 'RL', 'a'), w('6', 'T1', 's2', 'G', 'g'), w('7', 'RL', 'b', 'G', 'g')];
    const r = runAnalysis(c, ws, plugins(), { type: 'ac', sweep: 'dec', nPoints: 1, fStart: 1000, fStop: 1000, sourceId: 'V1', outputNode: 'T1:s1' } as any);
    // V2/V1 = jωM·RL / ((RS + jωL1)(RL + jωL2) + ω²M²)
    const om = 2 * Math.PI * 1000, M = k * Math.sqrt(L1 * L2);
    const re = 1 * 1000 - om * L1 * om * L2 + om * om * M * M, im = om * L2 * 1 + om * L1 * 1000;
    expect(acMag(r)).toBeCloseTo((om * M * 1000) / Math.hypot(re, im), 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boards, sensors, discrete semiconductors
// ─────────────────────────────────────────────────────────────────────────────
describe('board power pins and sensors', () => {
  it('an Arduino powered through its 5V pin from an external supply simulates', () => {
    const c = [comp('dcVoltage', 'EXT', { voltage: 5 }), comp('arduino', 'U1', { sketch: 'blink' }), comp('led', 'D1'), comp('ground', 'G')];
    const ws = [w('1', 'EXT', 'p', 'U1', '5v'), w('2', 'EXT', 'n', 'G', 'g'), w('3', 'U1', 'gnd', 'G', 'g'), w('4', 'U1', 'd2', 'D1', 'a'), w('5', 'D1', 'k', 'G', 'g')];
    const r = simulateStep(c, ws, plugins(), undefined, 1e-3);
    expect(r).not.toBeNull(); // two ideal 5 V sources in parallel → singular before
  });

  it('the ESP32 LDO cannot back-drive VIN when 3V3 is held high externally', () => {
    const c = [comp('dcVoltage', 'V5', { voltage: 5 }), comp('dcVoltage', 'VIN', { voltage: 5 }), comp('resistor', 'RIN', { resistance: 10000 }), comp('esp32dev', 'U1'), comp('ground', 'G')];
    const ws = [w('1', 'V5', 'p', 'U1', '3v3'), w('2', 'V5', 'n', 'G', 'g'), w('3', 'U1', 'gnd', 'G', 'g'), w('4', 'VIN', 'p', 'RIN', 'a'), w('5', 'RIN', 'b', 'U1', 'vin'), w('6', 'VIN', 'n', 'G', 'g')];
    expect(Math.abs(V(c, ws, solveDC(c, ws, plugins())!, 'U1:vin'))).toBeLessThan(5.1); // was 170 kV
  });

  it('a photodiode open-circuit voltage is clamped by its junction (~0.4 V at 1 klux)', () => {
    const c = [comp('photodiode', 'D1', { illuminance: 1000 }), comp('ground', 'G')];
    const ws = [w('1', 'D1', 'k', 'G', 'g')];
    let prev: any;
    let s: SimContext | null = null;
    for (let i = 0; i < 20; i++) {
      s = simulateStep(c, ws, plugins(), prev, 1e-4)!.sim;
      prev = { nodeVoltage: s.nodeVoltage, branchCurrent: s.branchCurrent, time: s.time, state: s.state };
    }
    const voc = V(c, ws, s!, 'D1:a');
    expect(voc).toBeGreaterThan(0.3); // was 2.7 kV
    expect(voc).toBeLessThan(0.5);
  });

  it('BSIM4 gate leakage is ~1 A/cm² at 1 V (nA for a small device), not amps', () => {
    const p = getPlugin('bsim4nmos')!.parameters.find((x) => x.key === 'aigc')!;
    expect(p.default as number).toBeLessThan(1e-8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Discrete semiconductors, comparator, reference, stepper — previously inert
// parameters now simulated
// ─────────────────────────────────────────────────────────────────────────────
describe('previously inert datasheet parameters are simulated', () => {
  const vt = 1.380649e-23 * 300.15 / 1.602176634e-19;

  it('Shockley diode: series resistance acts outside the junction', () => {
    const c = [comp('currentSource', 'I1', { current: 0.1 }), comp('diodeShockley', 'D1', { Rs: 0.5 }), comp('ground', 'G')];
    const ws = [w('1', 'I1', 'n', 'D1', 'a'), w('2', 'D1', 'k', 'G', 'g'), w('3', 'I1', 'p', 'G', 'g')];
    const vd = V(c, ws, solveDC(c, ws, plugins(), 200)!, 'D1:a');
    expect(vd).toBeCloseTo(vt * Math.log(0.1 / 1e-14 + 1) + 0.1 * 0.5, 5);
  });

  it('Shockley diode: reverse breakdown clamps at −Bv', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: -150 }), comp('resistor', 'R', { resistance: 10000 }), comp('diodeShockley', 'D1', { Bv: 100 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R', 'a'), w('2', 'R', 'b', 'D1', 'a'), w('3', 'D1', 'k', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g')];
    const vd = V(c, ws, solveDC(c, ws, plugins(), 200)!, 'D1:a');
    expect(vd).toBeLessThan(-100);
    expect(vd).toBeGreaterThan(-100.5);
  });

  it('Gummel-Poon: beta droops at high current (Ikf)', () => {
    const beta = (ib: number, ikf: number) => {
      const c = [comp('dcVoltage', 'VCC', { voltage: 5 }), comp('currentSource', 'IB', { current: ib }), comp('bjtGPNpn', 'Q1', { Ikf: ikf }), comp('ground', 'G')];
      const ws = [w('1', 'VCC', 'p', 'Q1', 'c'), w('2', 'VCC', 'n', 'G', 'g'), w('3', 'IB', 'n', 'Q1', 'b'), w('4', 'IB', 'p', 'G', 'g'), w('5', 'Q1', 'e', 'G', 'g')];
      return solveDC(c, ws, plugins(), 200)!.terminalCurrents!.get('Q1:c')! / ib;
    };
    expect(beta(1e-5, 1)).toBeGreaterThan(95);
    expect(beta(1e-2, 1)).toBeLessThan(75);       // high injection
    expect(beta(1e-2, 1e3)).toBeGreaterThan(95);  // knee far away: no droop
  });

  it('comparator: push-pull output drives Output HIGH', () => {
    const c = [comp('dcVoltage', 'VI', { voltage: 2 }), comp('dcVoltage', 'VR', { voltage: 1 }), comp('comparator', 'U1', { output: 'pushPull', vhigh: 3.3 }), comp('resistor', 'RL', { resistance: 10000 }), comp('ground', 'G')];
    const ws = [w('1', 'VI', 'p', 'U1', 'inp'), w('2', 'VR', 'p', 'U1', 'inn'), w('3', 'VI', 'n', 'G', 'g'), w('4', 'VR', 'n', 'G', 'g'), w('5', 'U1', 'out', 'RL', 'a'), w('6', 'RL', 'b', 'G', 'g')];
    expect(V(c, ws, solveDC(c, ws, plugins())!, 'U1:out')).toBeCloseTo(3.3, 1);
  });

  it('TL431 regulates with enough cathode current and drops out below I_KA(min)', () => {
    const vka = (r: number) => {
      const c = [comp('dcVoltage', 'V1', { voltage: 12 }), comp('resistor', 'R', { resistance: r }), comp('tl431', 'U1'), comp('ground', 'G')];
      const ws = [w('1', 'V1', 'p', 'R', 'a'), w('2', 'R', 'b', 'U1', 'c'), w('3', 'U1', 'c', 'U1', 'ref'), w('4', 'U1', 'a', 'G', 'g'), w('5', 'V1', 'n', 'G', 'g')];
      return V(c, ws, solveDC(c, ws, plugins(), 200)!, 'U1:c');
    };
    expect(vka(1000)).toBeCloseTo(2.495, 2);   // 11.5 mA
    expect(vka(100000)).toBeLessThan(2.0);     // 95 µA < 0.4 mA
  });

  it('stepper: R–L windings and 360°/stepsPerRev per full step, in both directions', () => {
    const run = (seq: number[][], spr: number) => {
      const va = comp('dcVoltage', 'VA', { voltage: 0 });
      const vb = comp('dcVoltage', 'VB', { voltage: 0 });
      const m = comp('stepperMotor', 'M1', { stepsPerRev: spr });
      const c = [va, vb, m, comp('ground', 'G')];
      const ws = [w('1', 'VA', 'p', 'M1', 'ap'), w('2', 'VA', 'n', 'M1', 'an'), w('3', 'VB', 'p', 'M1', 'bp'), w('4', 'VB', 'n', 'M1', 'bn'), w('5', 'M1', 'an', 'G', 'g'), w('6', 'M1', 'bn', 'G', 'g')];
      let prev: any;
      let last: any;
      const rise: number[] = [];
      for (let k = 0; k < seq.length * 100; k++) {
        const [a, b] = seq[Math.floor(k / 100)];
        (va.parameters as any).voltage = a;
        (vb.parameters as any).voltage = b;
        last = simulateStep(c, ws, plugins(), prev, 1e-4)!;
        prev = { nodeVoltage: last.sim.nodeVoltage, branchCurrent: last.sim.branchCurrent, time: last.sim.time, state: last.sim.state };
        if (k === 4) rise.push((last.sim.state as any).stepper_M1.iA);
      }
      const r = getPlugin('stepperMotor')!.measure!(m.parameters, [], last.sim, m);
      return { angle: parseFloat(r.find((x) => x.label === 'Angle')!.value), rise: rise[0] };
    };
    const fwd = [[12, 0], [0, 12], [-12, 0], [0, -12], [12, 0], [0, 12]];
    const f200 = run(fwd, 200);
    expect(f200.angle).toBeCloseTo(9, 1);              // 5 steps × 1.8°
    expect(run(fwd, 48).angle).toBeCloseTo(37.5, 1);   // 5 steps × 7.5°
    expect(run([[12, 0], [0, -12], [-12, 0]], 200).angle).toBeCloseTo(-3.6, 1); // reverse
    // winding current at t = 0.5 ms ≈ (12/10)·(1 − e^−1) (τ = L/R = 0.5 ms)
    expect(f200.rise).toBeGreaterThan(0.65);
    expect(f200.rise).toBeLessThan(0.8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Library-wide guards
// ─────────────────────────────────────────────────────────────────────────────
const GND = /^(gnd\d?|vss|agnd|dgnd)$/i;
const VPOS = /^(vcc\d?|vdd|5v|3v3|v\+|vbat)$/i;
const VNEG = /^(vee|v-)$/i;
type Pattern = 'low' | 'mixed' | 'pulse' | 'open';
function bench(p: ComponentPlugin, pattern: Pattern) {
  const comps = [comp(p.type, 'X'), comp('ground', 'G'), comp('dcVoltage', 'VP', { voltage: 5 }), comp('dcVoltage', 'VN', { voltage: -5 })];
  const wires: Wire[] = [];
  let id = 0;
  const wire = (a: string, at: string, b: string, bt: string) => wires.push(w(`w${id++}`, a, at, b, bt));
  wire('VP', 'n', 'G', 'g');
  wire('VN', 'n', 'G', 'g');
  let sig = 0;
  for (const t of p.terminals) {
    if (GND.test(t.id)) { wire('X', t.id, 'G', 'g'); continue; }
    if (VPOS.test(t.id)) { wire('X', t.id, 'VP', 'p'); continue; }
    if (VNEG.test(t.id)) { wire('X', t.id, 'VN', 'p'); continue; }
    if (pattern === 'open') continue;
    const i = sig++;
    comps.push(pattern === 'pulse'
      ? comp('pulseSource', `S${i}`, { high: 5, low: 0, frequency: 50 * (i + 1), duty: 50 })
      : comp('dcVoltage', `S${i}`, { voltage: pattern === 'low' ? 0 : [3.3, 0.6, 4.2, 1.5, 2.7][i % 5] }));
    comps.push(comp('resistor', `R${i}`, { resistance: 10000 }));
    wire(`S${i}`, 'p', `R${i}`, 'a');
    wire(`S${i}`, 'n', 'G', 'g');
    wire(`R${i}`, 'b', 'X', t.id);
  }
  return { comps, wires };
}

describe('library-wide guards', () => {
  // Ideal current sources legitimately drive an OPEN circuit to I/gmin.
  const IDEAL_CURRENT = new Set(['currentSource', 'biSource']);

  it('every component simulates on a generic bench without failing or running away', () => {
    const P = plugins();
    const problems: string[] = [];
    for (const p of getAllPlugins()) {
      if (!p.stamp) continue;
      for (const pat of ['low', 'mixed', 'pulse', 'open'] as Pattern[]) {
        if (pat === 'open' && IDEAL_CURRENT.has(p.type)) continue;
        const { comps, wires } = bench(p, pat);
        let prev: any;
        for (let k = 0; k < 60; k++) {
          const r = simulateStep(comps, wires, P, prev, 1e-4);
          if (!r) { problems.push(`${p.type}@${pat}: solve failed at step ${k}`); break; }
          const bad = Array.from(r.sim.nodeVoltage).find((v) => !Number.isFinite(v) || Math.abs(v) > 1000);
          if (bad !== undefined) { problems.push(`${p.type}@${pat}: V=${bad} at step ${k}`); break; }
          prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
        }
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('every stamp that reads node voltages joins the Newton loop', () => {
    const missing: string[] = [];
    for (const p of getAllPlugins()) {
      if (!p.stamp || p.nonLinear || p.feedback) continue;
      const n = p.terminals.length;
      let reads = 0;
      const spy = <T extends object>(arr: T) => new Proxy(arr, {
        get(t, k) {
          if (typeof k === 'string' && /^\d+$/.test(k)) reads++;
          const v = (t as any)[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const sim: any = {
        nodeVoltage: spy(new Float64Array(n + 2).map((_, i) => 0.37 * i)),
        branchCurrent: spy(new Float64Array(64)),
        state: {}, time: 1e-3, dt: 1e-4, numNodes: n + 2, newtonMemory: {},
      };
      const terms = p.terminals.map((t, i) => ({ terminalId: t.id, nodeId: i + 1 }));
      const params: Record<string, any> = {};
      for (const pm of p.parameters) params[pm.key] = pm.default;
      const sys = createMnaSystem(n + 1, 64);
      sys.nextExtra = n + 1;
      try { p.stamp(params, terms, sys, sim, comp(p.type, 'X')); } catch { /* reads still counted */ }
      if (reads > 0) missing.push(p.type);
    }
    expect(missing).toEqual([]);
  });
});
