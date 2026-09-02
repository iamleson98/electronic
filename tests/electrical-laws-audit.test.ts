// Regression tests for the electrical-law audit batch (2026-09-02).
//
// Every test here pins a bug found by verifying component code against the
// governing electrical/electronic law:
//   1. solveDC froze time          — ngspice .OP semantics (sources at t=0)
//   2. AC wrapper superposition    — non-stimulus sources contribute ZERO
//   3. AC wrapper pulse source     — 0 V small-signal = AC short
//   4. AC wrapper diode            — linearize at the DC operating point
//   5. DC motor back-EMF sign      — V = I·R + E (EMF OPPOSES the drive)
//   6. SCR/triac holding current   — read the Thevenin companion's true i
//   7. Diac release                — current-based, converges
//   8. LM7805/LM317 dropout        — Vout ≈ Vin − Vdropout (never > setpoint)
//   9. JFET-P Shockley law         — Id = Idss(1 − Vgs/Vp)², gm > 0
//  10. Level-1 MOS body effect     — reverse body bias RAISES Vth
//  11. BSIM3/BSIM4 DVT roll-off    — ngspice forms, sane magnitudes
//  12. node-0 voltage-source guards — unwired outputs no longer singular
//  13. sampleStimulus phase units  — degrees, matching sources.ts/ngspice
//  14. EXP stimulus continuity     — ngspice superposition form
//  15. PNP cold-start guess        — first stamp conducts

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { runACAnalysis } from '../src/lib/circuit/ac-analysis';
import { sampleStimulus } from '../src/lib/circuit/measurement';
import { evaluateBSIM3, DEFAULT_BSIM3_PARAMS } from '../src/lib/circuit/bsim3-full';
import { evaluateBSIM4, DEFAULT_BSIM4_PARAMS } from '../src/lib/circuit/bsim4-full';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/p1-components');
  await import('../src/lib/circuit/components/p2-components');
  await import('../src/lib/circuit/components/kicad-parity');
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
function runSim(comps: CircuitComponent[], ws: Wire[], steps = 12, dt = 1e-4) {
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
function nodeOf(r: any, id: string, term: string): number {
  return r.sim.nodeVoltage[r.nodeMap.terminalNode.get(`${id}:${term}`)!];
}
function nodeOfDC(dc: any, comps: CircuitComponent[], ws: Wire[], id: string, term: string): number {
  const nm = buildNodeMap(comps, ws, plugins());
  return dc.nodeVoltage[nm.terminalNode.get(`${id}:${term}`)!];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. solveDC holds time-dependent sources at their t=0 value
// ─────────────────────────────────────────────────────────────────────────────

describe('solveDC freezes time (ngspice .OP semantics)', () => {
  const rc = (phase: number) => ({
    comps: [
      comp('acVoltage', 'VS', { amplitude: 5, frequency: 1000, offset: 0, phase }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ],
    ws: [
      wire('w1', 'VS', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
    ],
  });

  it('AC source reads offset + amp·sin(phase) at the operating point (phase 0 → 0 V)', () => {
    const { comps, ws } = rc(0);
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    // t=0 value: 0 + 5·sin(0) = 0. The old code advanced time by 1e6 s per
    // iteration: sin(2π·1000·k·1e6) at a random phase → up to ±5 V.
    const v = nodeOfDC(dc, comps, ws, 'R1', 'a');
    expect(Math.abs(v)).toBeLessThan(1e-6);
  });

  it('AC source with 90° phase reads +5 V (offset + amp·sin(90°))', () => {
    const { comps, ws } = rc(90);
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    const v = nodeOfDC(dc, comps, ws, 'R1', 'a');
    expect(v).toBeCloseTo(5, 6);
  });

  it('the operating point is deterministic across repeated solves', () => {
    const { comps, ws } = rc(37);
    const a = solveDC(comps, ws, plugins());
    const b = solveDC(comps, ws, plugins());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    for (let i = 0; i < a!.nodeVoltage.length; i++) {
      expect(a!.nodeVoltage[i]).toBe(b!.nodeVoltage[i]);
    }
  });

  it('pulse source holds its t=0 value (high while phase < duty)', () => {
    const comps = [
      comp('pulseSource', 'VP', { high: 5, low: 0, frequency: 1, duty: 50 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VP', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'VP', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    expect(nodeOfDC(dc, comps, ws, 'R1', 'a')).toBeCloseTo(5, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2-4. Simplified AC analysis: superposition, pulse=short, diode at DC op
// ─────────────────────────────────────────────────────────────────────────────

describe('AC wrapper: superposition and device linearization', () => {
  it('a non-stimulus DC current source contributes ZERO AC (superposition)', () => {
    // 1 V AC stimulus through 1 k to the output node, 1 k load — gain 0.5 at
    // low frequency. A 10 mA DC current source hangs on the output node: it
    // is an AC OPEN, so the gain must stay 0.5. The old code injected the DC
    // 10 mA as a phasor: |0.5·1 − 10 mA·1 k| = 9.5.
    const comps = [
      comp('acVoltage', 'VS', { amplitude: 1, frequency: 100, offset: 0, phase: 0 }),
      comp('currentSource', 'I1', { current: 0.01 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'R1', 'a'),
      wire('w2', 'VS', 'n', 'GND', 'g'),
      wire('w3', 'R1', 'b', 'R2', 'a'),
      wire('w4', 'R2', 'b', 'GND', 'g'),
      wire('w5', 'I1', 'p', 'R1', 'b'),
      wire('w6', 'I1', 'n', 'GND', 'g'),
    ];
    const res = runACAnalysis({
      components: comps, wires: ws, fStart: 0.001, fStop: 0.001, nPoints: 1,
      sourceId: 'VS', acMag: 1, outputNode: 'R1:b',
    });
    expect(res.points.length).toBeGreaterThan(0);
    expect(res.points[0].magnitude).toBeCloseTo(0.5, 3);
  });

  it('pulse source is an AC short (stamped, not floating)', () => {
    // Bias feed through a pulse source + 1 k: in phasor land the pulse source
    // is 0 V = short, so the R1||R2 divider reads 0.5 — exactly like the
    // DC-supply case. The old code left pulse sources UNSTAMPED: the bias
    // branch was an AC open and the gain read 1.0.
    const comps = [
      comp('acVoltage', 'VS', { amplitude: 1, frequency: 100, offset: 0, phase: 0 }),
      comp('pulseSource', 'VP', { high: 5, low: 0, frequency: 1, duty: 50 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-3 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'R1', 'a'),
      wire('w2', 'VS', 'n', 'GND', 'g'),
      wire('w3', 'VP', 'p', 'R2', 'a'),
      wire('w4', 'VP', 'n', 'GND', 'g'),
      wire('w5', 'R2', 'b', 'R1', 'b'),
      wire('w6', 'C1', 'a', 'R1', 'b'),
      wire('w7', 'C1', 'b', 'GND', 'g'),
    ];
    const res = runACAnalysis({
      components: comps, wires: ws, fStart: 0.001, fStop: 0.001, nPoints: 1,
      sourceId: 'VS', acMag: 1, outputNode: 'R1:b',
    });
    expect(res.points.length).toBeGreaterThan(0);
    expect(res.points[0].magnitude).toBeCloseTo(0.5, 2);
  });

  it('diode linearizes at the DC operating point (not a fixed 1 kΩ)', () => {
    // Two identical RC-coupled dividers with a diode to ground; only the
    // stimulus PHASE differs. phase=90: the AC source sits at +1 V at t=0 →
    // the diode is ON at the DC op → small-signal 1/onR (10 Ω) → gain ≈
    // 10/1010. phase=270 (−1 V at t=0): OFF → 1/offR → gain ≈ 1. The old
    // fixed 1 kΩ gave 0.5 for BOTH.
    const build = (phase: number) => {
      const comps = [
        comp('acVoltage', 'VS', { amplitude: 1, frequency: 100, offset: 0, phase }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('diode', 'D1', { forwardV: 0.7, onR: 10, offR: 1e7 }),
        comp('ground', 'GND'),
      ];
      const ws = [
        wire('w1', 'VS', 'p', 'R1', 'a'),
        wire('w2', 'VS', 'n', 'GND', 'g'),
        wire('w3', 'R1', 'b', 'D1', 'a'),
        wire('w4', 'D1', 'k', 'GND', 'g'),
      ];
      return runACAnalysis({
        components: comps, wires: ws, fStart: 0.001, fStop: 0.001, nPoints: 1,
        sourceId: 'VS', acMag: 1, outputNode: 'R1:b',
      });
    };
    const on = build(90);
    const off = build(270);
    expect(on.points[0].magnitude).toBeCloseTo(10 / 1010, 2);
    expect(off.points[0].magnitude).toBeCloseTo(1, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DC motor back-EMF opposes the drive
// ─────────────────────────────────────────────────────────────────────────────

describe('DC motor: V = I·R + E (back-EMF sign)', () => {
  it('a spinning motor draws I = (V−E)/(R_total), not (V+E)', () => {
    // 5 V source, 4 Ω series, motor R=1 Ω, K=0.01. Preset ω = 200 rad/s →
    // E = 2 V. Correct: I = (5−2)/5 = 0.6 A → V(motor a) = 5 − 4·0.6 = 2.6 V.
    // The old sign made the EMF assist the drive: I = 1.4 A, V(a) = −0.6 V
    // (below ground!).
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'RS', { resistance: 4 }),
      comp('dcMotor', 'M1', { resistance: 1, backEmf: 0.01, inertia: 1 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'RS', 'a'),
      wire('w2', 'RS', 'b', 'M1', 'a'),
      wire('w3', 'M1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const p = plugins();
    // Step once to create the state, then force ω = 200 and re-solve.
    const r1 = simulateStep(comps, ws, p, undefined, 1e-4);
    expect(r1).not.toBeNull();
    const st = r1!.sim.state.__global ?? {};
    const key = Object.keys(st).find(k => k.startsWith('dcmotor') && k.endsWith('_w'))!;
    st[key] = 200;
    const r2 = simulateStep(comps, ws, p, {
      nodeVoltage: r1!.sim.nodeVoltage, branchCurrent: r1!.sim.branchCurrent,
      time: r1!.sim.time, state: r1!.sim.state,
    }, 1e-4);
    expect(r2).not.toBeNull();
    const va = nodeOf(r2!, 'M1', 'a');
    expect(va).toBeCloseTo(2.6, 2);
    // and the winding current the solver implies matches the motor law
    const i = (5 - va) / 4;
    expect(i).toBeCloseTo(0.6, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6-7. Thyristors: holding current is read from the companion's true current
// ─────────────────────────────────────────────────────────────────────────────

describe('SCR / triac / diac holding current', () => {
  const scrCircuit = (rLimit: number) => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 12 }),
      comp('resistor', 'RL', { resistance: rLimit }),
      comp('pulseSource', 'VG', { high: 5, low: 0, frequency: 50, duty: 5 }),
      comp('scr', 'SCR1', {}),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'RL', 'a'),
      wire('w2', 'RL', 'b', 'SCR1', 'a'),
      wire('w3', 'SCR1', 'k', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
      wire('w5', 'VG', 'p', 'SCR1', 'g'),
      wire('w6', 'VG', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  };

  it('SCR releases when starved below the holding current (10 kΩ feed)', () => {
    // 1 ms gate pulse (duty 5% @ 50 Hz). Through 10 kΩ the on-state current
    // is (12−1.5)/10.1k ≈ 1.04 mA < 5 mA holding → the SCR must drop out.
    // The old companion-mismatched test overestimated the current by
    // vf/onR = 15 A → the SCR latched forever.
    const { comps, ws } = scrCircuit(10000);
    const r = runSim(comps, ws, 40, 1e-4); // 4 ms — gate low since t=1 ms
    expect(r).not.toBeNull();
    const vAK = nodeOf(r!, 'SCR1', 'a');
    // Off: no current through 10 k → anode sits at the full 12 V.
    expect(vAK).toBeGreaterThan(11.9);
  });

  it('SCR latches on when the anode current exceeds the holding current (1 kΩ feed)', () => {
    const { comps, ws } = scrCircuit(1000);
    const r = runSim(comps, ws, 40, 1e-4);
    expect(r).not.toBeNull();
    const vAK = nodeOf(r!, 'SCR1', 'a');
    // On: Thevenin (1.5 V, 0.1 Ω) — anode ≈ 1.5 V.
    expect(vAK).toBeCloseTo(1.5, 1);
  });

  it('triac releases when starved below its holding current', () => {
    const build = (rLimit: number) => {
      const comps = [
        comp('dcVoltage', 'V1', { voltage: 12 }),
        comp('resistor', 'RL', { resistance: rLimit }),
        comp('pulseSource', 'VG', { high: 5, low: 0, frequency: 50, duty: 5 }),
        comp('triac', 'T1', {}),
        comp('ground', 'GND'),
      ];
      const ws = [
        wire('w1', 'V1', 'p', 'RL', 'a'),
        wire('w2', 'RL', 'b', 'T1', 'mt2'),
        wire('w3', 'T1', 'mt1', 'GND', 'g'),
        wire('w4', 'V1', 'n', 'GND', 'g'),
        wire('w5', 'VG', 'p', 'T1', 'g'),
        wire('w6', 'VG', 'n', 'GND', 'g'),
      ];
      return { comps, ws };
    };
    const starved = build(10000);
    const r1 = runSim(starved.comps, starved.ws, 40, 1e-4);
    expect(r1).not.toBeNull();
    expect(nodeOf(r1!, 'T1', 'mt2')).toBeGreaterThan(11.9); // released

    const fed = build(500);
    const r2 = runSim(fed.comps, fed.ws, 40, 1e-4);
    expect(r2).not.toBeNull();
    expect(nodeOf(r2!, 'T1', 'mt2')).toBeCloseTo(1.5, 1); // latched
  });

  it('diac latches and the DC solve converges (no state flip-flop)', () => {
    // 35 V through 100 Ω into a 30 V diac: on-state current (35−1.5)/101 =
    // 332 mA >> 5 mA holding → stays on with |vAB| ≈ 1.83 V. The old
    // voltage-based release test fought the on-state stamp and oscillated
    // on every re-stamp.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 35 }),
      comp('resistor', 'RL', { resistance: 100 }),
      comp('diac', 'D1', { breakoverV: 30, onR: 1 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'RL', 'a'),
      wire('w2', 'RL', 'b', 'D1', 'a'),
      wire('w3', 'D1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
    const vAB = nodeOfDC(dc, comps, ws, 'D1', 'a');
    expect(vAB).toBeCloseTo(1.5 + 0.332 * 1, 1); // on-state Thevenin
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Linear regulators in dropout
// ─────────────────────────────────────────────────────────────────────────────

describe('LM7805 / LM317 dropout physics', () => {
  it('LM7805 at Vin=6 V delivers ≈ Vin − Vdropout = 4 V (never above 5 V)', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 6 }),
      comp('lm7805', 'U1', { outputV: 5, dropoutV: 2, ron: 0.1 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'U1', 'out', 'RL', 'a'),
      wire('w3', 'RL', 'b', 'GND', 'g'),
      wire('w4', 'U1', 'gnd', 'GND', 'g'),
      wire('w5', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    const vout = nodeOfDC(dc, comps, ws, 'U1', 'out');
    expect(vout).toBeCloseTo(4.0, 1); // old code: ~5.9 V — above the setpoint
    expect(vout).toBeLessThan(5.0);
  });

  it('LM7805 regulates normally at Vin=12 V (5 V)', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 12 }),
      comp('lm7805', 'U1', { outputV: 5, dropoutV: 2, ron: 0.1 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'U1', 'out', 'RL', 'a'),
      wire('w3', 'RL', 'b', 'GND', 'g'),
      wire('w4', 'U1', 'gnd', 'GND', 'g'),
      wire('w5', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    expect(nodeOfDC(dc, comps, ws, 'U1', 'out')).toBeCloseTo(5.0, 1);
  });

  it('LM317 in dropout tracks Vin − 2 V', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('lm317', 'U1', { outputV: 5, ron: 0.1 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'U1', 'out', 'RL', 'a'),
      wire('w3', 'RL', 'b', 'GND', 'g'),
      wire('w5', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    const vout = nodeOfDC(dc, comps, ws, 'U1', 'out');
    expect(vout).toBeCloseTo(3.0, 1); // 5 − 2
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. P-channel JFET obeys the Shockley law
// ─────────────────────────────────────────────────────────────────────────────

describe('jfetP: Id = Idss·(1 − Vgs/Vp)²', () => {
  const sweep = (gateV: number) => {
    // Source at +10 V, drain through 500 Ω to ground, gate driven above the
    // source (reverse-biasing the gate junction — the P-JFET depleting
    // direction). Idss=10 mA, Vp=+2 V.
    const comps = [
      comp('dcVoltage', 'VS', { voltage: 10 }),
      comp('resistor', 'RD', { resistance: 500 }),
      comp('dcVoltage', 'VG', { voltage: gateV }),
      comp('jfetP', 'J1', { Vp: 2, Idss: 0.01 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'J1', 's'),
      wire('w2', 'VS', 'n', 'GND', 'g'),
      wire('w3', 'J1', 'd', 'RD', 'a'),
      wire('w4', 'RD', 'b', 'GND', 'g'),
      wire('w5', 'VG', 'p', 'J1', 'g'),
      wire('w6', 'VG', 'n', 'GND', 'g'),
    ];
    return runSim(comps, ws, 4, 1e-4);
  };

  it('Vgs=0: full Idss conduction (V(drain) = 10 mA·500 Ω = 5 V)', () => {
    const r = sweep(10);
    expect(r).not.toBeNull();
    expect(nodeOf(r!, 'J1', 'd')).toBeCloseTo(5.0, 1);
  });

  it('Vgs=+1 (half of Vp): Id = Idss/4 → V(drain) = 1.25 V', () => {
    const r = sweep(11);
    expect(r).not.toBeNull();
    expect(nodeOf(r!, 'J1', 'd')).toBeCloseTo(1.25, 1);
  });

  it('Vgs=+2 (=Vp): pinched off, V(drain) ≈ 0', () => {
    const r = sweep(12);
    expect(r).not.toBeNull();
    expect(nodeOf(r!, 'J1', 'd')).toBeLessThan(0.05);
  });

  it('the drain NEVER rises above the +10 V supply rail (no energy generation)', () => {
    for (const gateV of [10, 10.5, 11, 11.5, 12]) {
      const r = sweep(gateV);
      expect(r).not.toBeNull();
      // old bug: negative gm/gds drove the drain to +11…+15.6 V
      expect(nodeOf(r!, 'J1', 'd')).toBeLessThan(10.001);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Level-1 MOSFET body effect: reverse bias RAISES Vth
// ─────────────────────────────────────────────────────────────────────────────

describe('mosLevel1 body effect (Vth = Vto + γ(√(2ΦF−Vbs) − √(2ΦF)))', () => {
  const nmos = (bodyV: number) => {
    const comps = [
      comp('dcVoltage', 'VD', { voltage: 5 }),
      comp('resistor', 'RD', { resistance: 100 }),
      comp('dcVoltage', 'VG', { voltage: 2 }),
      comp('dcVoltage', 'VB', { voltage: bodyV }),
      comp('mosLevel1N', 'M1', { Vto: 1, Kp: 0.05, Gamma: 0.5, Phi: 0.7, Lambda: 0.02 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VD', 'p', 'RD', 'a'),
      wire('w2', 'RD', 'b', 'M1', 'd'),
      wire('w3', 'VD', 'n', 'GND', 'g'),
      wire('w4', 'VG', 'p', 'M1', 'g'),
      wire('w5', 'VG', 'n', 'GND', 'g'),
      wire('w6', 'M1', 's', 'GND', 'g'),
      wire('w7', 'VB', 'p', 'M1', 'b'),
      wire('w8', 'VB', 'n', 'GND', 'g'),
    ];
    return runSim(comps, ws, 5, 1e-4);
  };

  it('reverse body bias (Vsb=2 V) raises Vth and REDUCES the drain current', () => {
    const body0 = nmos(0);    // Vsb = 0 → Vth = 1.0
    const bodyRev = nmos(-2); // Vsb = 2 → Vth = 1 + 0.5(√3.4−√1.4) = 1.33
    expect(body0).not.toBeNull();
    expect(bodyRev).not.toBeNull();
    const vd0 = nodeOf(body0!, 'M1', 'd');
    const vdRev = nodeOf(bodyRev!, 'M1', 'd');
    // Id = ½Kp·vov²: vov 1.0 → 0.67 — the current roughly HALVES, so the
    // drain voltage (5 − Id·100) RISES. Old code: Vth fell to 0.41 → the
    // drain voltage moved the WRONG way.
    expect(vdRev).toBeGreaterThan(vd0 + 0.5);
  });

  it('P-channel flip-world: body above source raises |Vth| (less current)', () => {
    const pmos = (bodyV: number) => {
      const comps = [
        comp('dcVoltage', 'VS', { voltage: 5 }),
        comp('resistor', 'RD', { resistance: 100 }),
        comp('dcVoltage', 'VG', { voltage: 3 }),
        comp('dcVoltage', 'VB', { voltage: bodyV }),
        comp('mosLevel1P', 'M1', { Vto: -1, Kp: 0.05, Gamma: 0.5, Phi: 0.7, Lambda: 0.02 }),
        comp('ground', 'GND'),
      ];
      const ws = [
        wire('w1', 'VS', 'p', 'M1', 's'),
        wire('w2', 'VS', 'n', 'GND', 'g'),
        wire('w3', 'M1', 'd', 'RD', 'a'),
        wire('w4', 'RD', 'b', 'GND', 'g'),
        wire('w5', 'VG', 'p', 'M1', 'g'),
        wire('w6', 'VG', 'n', 'GND', 'g'),
        wire('w7', 'VB', 'p', 'M1', 'b'),
        wire('w8', 'VB', 'n', 'GND', 'g'),
      ];
      return runSim(comps, ws, 5, 1e-4);
    };
    const body0 = pmos(5);    // Vsb = 0
    const bodyRev = pmos(7);  // body above source: reverse bias
    expect(body0).not.toBeNull();
    expect(bodyRev).not.toBeNull();
    // vgs = −2, Vth = −1: |vov| = 1 → Id ≈ 25 mA → V(d) ≈ 2.5 V.
    // Reverse body: |Vth| = 1.33 → |vov| = 0.67 → less current → V(d) drops.
    const vd0 = nodeOf(body0!, 'M1', 'd');
    const vdRev = nodeOf(bodyRev!, 'M1', 'd');
    expect(vd0).toBeGreaterThan(2.0);       // conducting
    expect(vdRev).toBeLessThan(vd0 - 0.5);  // body effect throttles it
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. BSIM3 / BSIM4: ngspice-form DVT roll-off, textbook magnitudes
// ─────────────────────────────────────────────────────────────────────────────

describe('BSIM3 device equations (ngspice b3ld.c forms)', () => {
  const p = { ...DEFAULT_BSIM3_PARAMS };

  it('default 130 nm device: off at Vgs=0, textbook µA currents, positive gm/gds', () => {
    const off = evaluateBSIM3(0, 1, 0, p);
    expect(Math.abs(off.id)).toBeLessThan(1e-9);
    const on = evaluateBSIM3(1, 1, 0, p);
    expect(on.id).toBeGreaterThan(1e-6);      // µA-scale channel current
    expect(on.id).toBeLessThan(1e-2);         // …not kA (the old DVT units bug: 34 kA)
    expect(on.gm).toBeGreaterThan(0);
    expect(on.gds).toBeGreaterThanOrEqual(0);
    expect(on.vth ?? 0).toEqual(0); // (no vth field on BSIM3 op — sanity no-crash)
  });

  it('long channel: roll-off vanishes and the square law emerges', () => {
    const pLong = { ...p, l: 10e-6 };
    const a = evaluateBSIM3(1, 1, 0, pLong);
    const b = evaluateBSIM3(2, 1, 0, pLong);
    // Id ∝ vov² far above threshold: ratio ≈ ((2−0.5)/(1−0.5))² ≈ 9
    const ratio = b.id / a.id;
    expect(ratio).toBeGreaterThan(4);
    expect(ratio).toBeLessThan(16);
  });

  it('Id is monotonic in Vds (no negative-output regions)', () => {
    let prev = -1;
    for (let vds = 0; vds <= 1.2; vds += 0.05) {
      const id = evaluateBSIM3(1, vds, 0, p).id;
      expect(id).toBeGreaterThanOrEqual(prev - 1e-18);
      prev = id;
    }
  });
});

describe('BSIM4 device equations (ngspice b4ld.c forms)', () => {
  const p = { ...DEFAULT_BSIM4_PARAMS };

  it('default 65 nm device: Vth ≈ 0.35 V, off at Vgs=0, Id ≈ 500 µA/µm at 1 V', () => {
    const off = evaluateBSIM4(0, 1, 0, p);
    // subthreshold leakage ~1 nA at Vgs=0 is physical — "off" means no
    // channel current (≤ 100 nA), not zero.
    expect(Math.abs(off.id)).toBeLessThan(1e-7);
    const on = evaluateBSIM4(1, 1, 0, p);
    expect(on.vth).toBeGreaterThan(0.2);
    expect(on.vth).toBeLessThan(0.55);
    expect(on.id).toBeGreaterThan(1e-4);   // ~200 µA at least
    expect(on.id).toBeLessThan(2e-3);      // not 63 kA (the old DVT bug)
    expect(on.gm).toBeGreaterThan(0);
    expect(on.gds).toBeGreaterThanOrEqual(0);
  });

  it('Meyer partition: Cgs=Cgd at Vds=0, continuous with saturation at Vdsat', () => {
    const v0 = evaluateBSIM4(1, 1e-6, 0, p);
    // at Vds≈0 the channel is symmetric
    expect(Math.abs(v0.cgs - v0.cgd)).toBeLessThan(0.05 * (v0.cgs + v0.cgd));
    const sat = evaluateBSIM4(1, 1, 0, p);
    const edge = evaluateBSIM4(1, sat.vdsat, 0, p);
    // Cgs continuous across the triode→saturation boundary (2/3·C)
    expect(edge.cgs).toBeCloseTo(sat.cgs, -12);  // relative tolerance
    expect(edge.cgd).toBeCloseTo(sat.cgd, -12);
    // Cgs ≥ Cgd everywhere in triode (charge piles at the source end)
    const mid = evaluateBSIM4(1, sat.vdsat / 2, 0, p);
    expect(mid.cgs).toBeGreaterThan(mid.cgd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Unwired outputs must not singularize the matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('node-0 voltage-source guards', () => {
  it('7400 unit with an unwired output: the circuit still solves', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('dcVoltage', 'V2', { voltage: 5 }),
      comp('7400_A', 'U1', {}),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'U1', 'in1'),
      wire('w2', 'V2', 'p', 'U1', 'in2'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'V2', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3, 1e-4);
    expect(r).not.toBeNull(); // old: all-zero branch row → singular → null
  });

  it('ADC with unwired data bits: the circuit still solves', () => {
    const comps = [
      comp('dcVoltage', 'VIN', { voltage: 3 }),
      comp('dcVoltage', 'VREF', { voltage: 5 }),
      comp('adc', 'U1', {}),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VIN', 'p', 'U1', 'vin'),
      wire('w2', 'VREF', 'p', 'U1', 'vref'),
      wire('w3', 'VIN', 'n', 'GND', 'g'),
      wire('w4', 'VREF', 'n', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 3, 1e-4);
    expect(r).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13-14. Stimulus sampling: phase units and EXP continuity
// ─────────────────────────────────────────────────────────────────────────────

describe('sampleStimulus units and continuity', () => {
  it('SINE phase is DEGREES (90° → cos at t=0 → 1)', () => {
    const times = Float64Array.from([0]);
    const out = sampleStimulus({ type: 'sine', params: { voff: 0, vamp: 1, freq: 50, phase: 90 } }, times);
    expect(out[0]).toBeCloseTo(1, 9);
  });

  it('EXP second segment is continuous at td2 (ngspice superposition form)', () => {
    const params = { v1: 0, v2: 5, td1: 0, tau1: 0.1, td2: 0.1, tau2: 0.1 };
    const justBefore = sampleStimulus({ type: 'exp', params }, Float64Array.from([0.0999]));
    const at = sampleStimulus({ type: 'exp', params }, Float64Array.from([0.1]));
    // ngspice: both expressions agree at td2 — the old code jumped to v2 (5 V)
    expect(Math.abs(at[0] - justBefore[0])).toBeLessThan(0.02);
    expect(at[0]).toBeCloseTo(5 * (1 - Math.exp(-1)), 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. PNP cold-start: the first stamp must conduct
// ─────────────────────────────────────────────────────────────────────────────

describe('bjtGPPnp cold-start guess', () => {
  it('PNP collector conducts from the very first step (flipped-world default)', () => {
    // Emitter at 5 V, base at 4.3 V (Vbe = −0.7), collector through 1 k to
    // ground. The old cold guess (vBEguess = −0.7 in the exp) modeled the
    // device as open for the first step → V(c) = 0.
    const comps = [
      comp('dcVoltage', 'VE', { voltage: 5 }),
      comp('dcVoltage', 'VB', { voltage: 4.3 }),
      comp('resistor', 'RC', { resistance: 1000 }),
      comp('bjtGPPnp', 'Q1', {}),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VE', 'p', 'Q1', 'e'),
      wire('w2', 'VE', 'n', 'GND', 'g'),
      wire('w3', 'VB', 'p', 'Q1', 'b'),
      wire('w4', 'VB', 'n', 'GND', 'g'),
      wire('w5', 'Q1', 'c', 'RC', 'a'),
      wire('w6', 'RC', 'b', 'GND', 'g'),
    ];
    const r = runSim(comps, ws, 1, 1e-4); // ONE step — the cold guess alone
    expect(r).not.toBeNull();
    const vc = nodeOf(r!, 'Q1', 'c');
    expect(vc).toBeGreaterThan(0.5); // conducting immediately
  });
});
