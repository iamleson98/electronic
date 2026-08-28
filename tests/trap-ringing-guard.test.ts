// Trapezoidal ringing guard — physics regression tests.
//
// The trapezoidal companion model has an undamped (−1)^n sampling mode: with
// dt >> tau (or at a source discontinuity) the solved sequence alternates
// around the true solution instead of settling. passive.ts now runs an
// LTspice-style "modified trap" guard: sustained sign alternation of the
// element's current (capacitor) / voltage (inductor) differences trips a
// 2-step backward-Euler fallback that annihilates the mode. These tests pin:
//   - the alternation detector unit behavior,
//   - suppression on RC / RL circuits with dt >> tau,
//   - NO false positives on a genuine LC oscillator (amplitude preserved),
//   - telemetry (__trapRingCount + report.trapRings) wiring,
//   - state-key garbage collection for the new suffixes.

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { runTran } from '../src/lib/circuit/analysis';
import { trapAlternates, TRAP_RING_ALT_THRESHOLD } from '../src/lib/circuit/integration';
import { cleanupComponentState } from '../src/lib/circuit/memory';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

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
function plugins(): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().map((p) => [p.type, p]));
}

interface RunOut {
  trace: number[];       // probe node voltage per step
  ringCount: number;     // __trapRingCount at the end
  full: boolean;         // every step solved
}

/** Run N steps at dt with the given method, probing `probe` (componentId:terminalId). */
function runTrace(
  comps: CircuitComponent[],
  ws: Wire[],
  steps: number,
  dt: number,
  method: 'euler' | 'trap' | 'gear',
  probe: string,
): RunOut {
  const p = plugins();
  let prev: SimContext | undefined;
  const out: number[] = [];
  let ringCount = 0;
  let full = true;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(comps, ws, p, prev as any, dt, { method });
    if (!r) { full = false; break; }
    out.push(r.sim.nodeVoltage[r.nodeMap.terminalNode.get(probe) ?? 0] ?? 0);
    ringCount = (r.sim.state.__global?.__trapRingCount as number | undefined) ?? 0;
    prev = {
      nodeVoltage: r.sim.nodeVoltage,
      branchCurrent: r.sim.branchCurrent,
      time: r.sim.time,
      state: r.sim.state,
    } as any;
  }
  return { trace: out, ringCount, full };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: the alternation detector
// ─────────────────────────────────────────────────────────────────────────────

describe('trapAlternates (unit)', () => {
  it('detects a sustained alternating sequence', () => {
    // 5 + 1·(−1)^n: differences alternate ±2 every step.
    const seq = [4, 6, 4, 6, 4, 6];
    for (let i = 2; i < seq.length; i++) {
      expect(trapAlternates(seq[i], seq[i - 1], seq[i - 2], 1e-12, 1e-3)).toBe(true);
    }
  });

  it('does not fire on a monotonic ramp', () => {
    expect(trapAlternates(3, 2, 1, 1e-12, 1e-3)).toBe(false);
  });

  it('fires at most ONCE for a smooth extremum (sinusoid peak)', () => {
    // Samples of a cosine around its peak, 20 samples/period: only the
    // difference pair straddling the peak alternates sign.
    const w = (2 * Math.PI) / 20;
    const samples = Array.from({ length: 7 }, (_, k) => Math.cos((k - 3) * w));
    let alternations = 0;
    for (let i = 2; i < samples.length; i++) {
      if (trapAlternates(samples[i], samples[i - 1], samples[i - 2], 1e-12, 1e-3)) alternations++;
    }
    expect(alternations).toBeLessThanOrEqual(1);
  });

  it('ignores alternations below the absolute tolerance (noise floor)', () => {
    // Alternating but tiny: |d| = 2e-15 < abstol 1e-12.
    expect(trapAlternates(1 + 1e-15, 1 - 1e-15, 1 + 1e-15, 1e-12, 1e-3)).toBe(false);
  });

  it('ignores alternations below the relative tolerance', () => {
    // |d| = 1e-6 against a 10 A baseline: reltol 1e-3 → floor 10 mA.
    expect(trapAlternates(10.000001, 9.999999, 10.000001, 1e-12, 1e-3)).toBe(false);
  });

  it('threshold: at least 3 consecutive alternations are required to trip', () => {
    expect(TRAP_RING_ALT_THRESHOLD).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capacitor ringing suppression (RC with dt >> tau)
// ─────────────────────────────────────────────────────────────────────────────

describe('trap ringing guard — capacitor (RC, dt >> tau)', () => {
  // R = 1 kΩ, C = 1 nF → τ = 1 µs; dt = 1 ms → a = dt/(2τ) = 500, so the pure
  // trapezoidal eigenvalue is λ = (1−a)/(1+a) ≈ −0.996: the capacitor voltage
  // alternates around 5 V with essentially no decay (|λ|^30 ≈ 0.89 → still
  // ±4.4 V after 30 steps). The guard must suppress it.
  const dt = 1e-3;
  const mkRC = () => [
    comp('dcVoltage', 'V1', { voltage: 5 }),
    comp('resistor', 'R1', { resistance: 1000 }),
    comp('capacitor', 'C1', { capacitance: 1e-9, initialV: 0 }),
    comp('ground', 'GND'),
  ];
  const ws = [
    wire('w1', 'V1', 'p', 'R1', 'a'),
    wire('w2', 'R1', 'b', 'C1', 'a'),
    wire('w3', 'V1', 'n', 'GND', 'g'),
    wire('w4', 'C1', 'b', 'GND', 'g'),
  ];

  it('suppresses the (−1)^n mode: v(C) settles to 5 V within a few steps', () => {
    const { trace, full } = runTrace(mkRC(), ws, 30, dt, 'trap', 'C1:a');
    expect(full).toBe(true);
    expect(trace.length).toBe(30);
    // After the guard trips (≤ ~8 steps) the voltage must sit at 5 V — the
    // unguarded trapezoidal solution still alternates ±4.4 V here.
    for (let i = 8; i < 30; i++) {
      expect(Math.abs(trace[i] - 5)).toBeLessThan(0.01);
    }
  });

  it('records the suppression in __trapRingCount', () => {
    const { ringCount } = runTrace(mkRC(), ws, 30, dt, 'trap', 'C1:a');
    expect(ringCount).toBeGreaterThanOrEqual(1);
  });

  it('euler mode never engages the guard', () => {
    const { ringCount } = runTrace(mkRC(), ws, 30, dt, 'euler', 'C1:a');
    expect(ringCount).toBe(0);
  });

  it('gear mode never engages the guard (BDF-2 is L-stable)', () => {
    const { ringCount, trace } = runTrace(mkRC(), ws, 30, dt, 'gear', 'C1:a');
    expect(ringCount).toBe(0);
    expect(Math.abs(trace[trace.length - 1] - 5)).toBeLessThan(0.01);
  });

  it('fine-timestep trap on the same circuit stays accurate AND guard-free', () => {
    // dt = τ/10: trapezoidal is well-resolved — the guard must not fire and
    // the charge curve must track the closed form.
    const fine = 1e-7;
    const steps = 200;
    const { trace, ringCount, full } = runTrace(mkRC(), ws, steps, fine, 'trap', 'C1:a');
    expect(full).toBe(true);
    expect(ringCount).toBe(0);
    // t = 200 · 1e-7 = 20 µs = 20τ → v = 5(1 − e^−20) ≈ 5 V.
    expect(trace[steps - 1]).toBeCloseTo(5 * (1 - Math.exp(-20)), 3);
    // Mid-curve accuracy: at 10τ (step 100) v = 5(1 − e^−10) = 4.99977 V.
    expect(trace[100]).toBeCloseTo(5 * (1 - Math.exp(-10)), 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inductor ringing suppression (RL with dt >> tau)
// ─────────────────────────────────────────────────────────────────────────────

describe('trap ringing guard — inductor (RL, dt >> tau)', () => {
  // 5 V, R = 1 Ω, L = 1 µH → τ = 1 µs; dt = 1 ms. The inductor current
  // alternates around the 5 A steady state (λ ≈ −0.996) and the inductor
  // VOLTAGE alternates around 0 V. The guard watches that voltage.
  const dt = 1e-3;
  const mkRL = () => [
    comp('dcVoltage', 'V1', { voltage: 5 }),
    comp('resistor', 'R1', { resistance: 1 }),
    comp('inductor', 'L1', { inductance: 1e-6, initialI: 0 }),
    comp('ground', 'GND'),
  ];
  const ws = [
    wire('w1', 'V1', 'p', 'R1', 'a'),
    wire('w2', 'R1', 'b', 'L1', 'a'),
    wire('w3', 'V1', 'n', 'GND', 'g'),
    wire('w4', 'L1', 'b', 'GND', 'g'),
  ];

  it('suppresses the mode: v(L) settles to 0 V and i(L) to 5 A', () => {
    const { trace, full, ringCount } = runTrace(mkRL(), ws, 30, dt, 'trap', 'R1:b');
    expect(full).toBe(true);
    expect(ringCount).toBeGreaterThanOrEqual(1);
    for (let i = 8; i < 30; i++) {
      expect(Math.abs(trace[i])).toBeLessThan(0.01);
    }
    // inductor current: read from the final state (ind_<id> key)
    const p = plugins();
    let prev: any;
    let last: any = null;
    for (let i = 0; i < 30; i++) {
      const r = simulateStep(mkRL(), ws, p, prev, dt, { method: 'trap' });
      last = r;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    const iL = last.sim.state.__global['ind_L1'] as number;
    expect(iL).toBeCloseTo(5, 2);
  });

  it('euler mode never engages the guard', () => {
    const { ringCount } = runTrace(mkRL(), ws, 30, dt, 'euler', 'R1:b');
    expect(ringCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No false positives: a genuine LC oscillator must keep its amplitude
// ─────────────────────────────────────────────────────────────────────────────

describe('trap ringing guard — no false positives on real oscillation', () => {
  it('LC tank at 40 samples/period: amplitude preserved, guard silent', () => {
    const L = 1e-3, C = 1e-6;
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
    const T0 = 1 / f0;
    const comps = [
      comp('inductor', 'L1', { inductance: L }),
      comp('capacitor', 'C1', { capacitance: C, initialV: 5 }),
      comp('resistor', 'Rp', { resistance: 1e6 }), // light bleed only
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'L1', 'a', 'C1', 'a'),
      wire('w2', 'C1', 'b', 'GND', 'g'),
      wire('w3', 'L1', 'b', 'GND', 'g'),
      wire('w4', 'L1', 'a', 'Rp', 'a'),
      wire('w5', 'Rp', 'b', 'GND', 'g'),
    ];
    const dt = T0 / 40;
    const steps = 40 * 20 + 1; // 20 periods
    const { trace, ringCount, full } = runTrace(comps, ws, steps, dt, 'trap', 'C1:a');
    expect(full).toBe(true);
    expect(ringCount).toBe(0);
    const peak = (a: number[]) => Math.max(...a.map(Math.abs));
    // The 1 MΩ bleed costs ~0.1% per period (Q ≈ 3000); after 20 periods the
    // amplitude must still be ≥ 4.5 V (euler would be at 0 V, unguarded trap
    // holds ~5 V, a false-positive guard would have eaten it).
    expect(peak(trace.slice(-40))).toBeGreaterThan(4.5);
    // and the frequency is still exact (zero-crossing spacing = 40 samples).
    const zeros: number[] = [];
    for (let i = 1; i < trace.length; i++) {
      if (trace[i - 1] < 0 && trace[i] >= 0) zeros.push(i);
    }
    expect(zeros.length).toBeGreaterThanOrEqual(19);
    // spacing quantizes to 40±1 samples (a crossing can straddle a sample).
    for (let i = 2; i < zeros.length; i++) {
      expect(zeros[i] - zeros[i - 1]).toBeGreaterThanOrEqual(40);
      expect(zeros[i] - zeros[i - 1]).toBeLessThanOrEqual(41);
    }
  });

  it('a square-wave-driven RC (discontinuities every edge) stays stable under trap', () => {
    // 1 kHz square wave (high 5 V, duty 50%) through R=1k into C=1nF
    // (τ=1µs, dt=10µs — 10 τ per step: every edge is an under-resolved kick,
    // the classic recipe for trapezoidal ringing). The guard trips at the
    // edges; the result must stay bounded, finite, and track the waveform.
    const comps = [
      comp('pulseSource', 'V1', { high: 5, low: 0, frequency: 1000, duty: 50 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-9 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'C1', 'b', 'GND', 'g'),
    ];
    const { trace, full, ringCount } = runTrace(comps, ws, 200, 1e-5, 'trap', 'C1:a');
    expect(full).toBe(true);
    // the guard engaged at the under-resolved edges (t=0.5, 1.0, 1.5 ms…)
    expect(ringCount).toBeGreaterThanOrEqual(2);
    for (const v of trace) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(10); // 0..5 V signal, no ringing blow-up
    }
    // Mid first pulse (t = 300 µs): cap follows the source (dt = 10τ → rail).
    expect(trace[30]).toBeGreaterThan(4.5);
    // Mid first low phase (t = 800 µs): discharged.
    expect(trace[80]).toBeLessThan(0.5);
    // Mid second pulse (t = 1.3 ms): high again — the waveform tracks.
    expect(trace[130]).toBeGreaterThan(4.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry wiring through runTran
// ─────────────────────────────────────────────────────────────────────────────

describe('trap ringing guard — runTran telemetry', () => {
  it('report.trapRings and scalars.trapRings count suppressions (trap only)', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-9, initialV: 0 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'C1', 'b', 'GND', 'g'),
    ];
    const p = plugins();
    const res = runTran(comps, ws, p, {
      type: 'tran', tStop: 20e-3, tStep: 1e-3, probes: ['C1:a'],
    }, { method: 'trap', uic: true });
    expect(res.report.converged).toBe(true);
    expect(res.report.trapRings).toBeGreaterThanOrEqual(1);
    expect(res.scalars.trapRings).toBe(res.report.trapRings);
    // and the last sample sits at the settled value
    const last = res.traces[0].yValues[res.traces[0].yValues.length - 1];
    expect(Math.abs(last - 5)).toBeLessThan(0.01);
  });

  it('euler runs carry no trapRings field', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-9 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'C1', 'b', 'GND', 'g'),
    ];
    const res = runTran(comps, ws, plugins(), {
      type: 'tran', tStop: 5e-3, tStep: 1e-3, probes: ['C1:a'],
    }, { method: 'euler' });
    expect(res.report.trapRings).toBeUndefined();
    expect(res.scalars.trapRings).toBeUndefined();
  });

  it('a well-resolved trap run reports zero rings', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-9 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'C1', 'b', 'GND', 'g'),
    ];
    const res = runTran(comps, ws, plugins(), {
      type: 'tran', tStop: 20e-6, tStep: 1e-7, probes: ['C1:a'],
    }, { method: 'trap' });
    expect(res.report.converged).toBe(true);
    expect(res.report.trapRings).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State-key hygiene for the new guard suffixes
// ─────────────────────────────────────────────────────────────────────────────

describe('trap ringing guard — state keys & GC', () => {
  it('guard suffix keys (_i2/_vp/_vp2/_ring/_used/_alt) are collected with their element', () => {
    // Simulate a ringing capacitor so all guard keys exist, then delete the
    // component: every `cap_C1*` key must be garbage-collected.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-9, initialV: 0 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'C1', 'b', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-3, { method: 'trap' });
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    const g = prev.state.__global;
    for (const suffix of ['', '_i', '_i2', '_used', '_ring', '_alt']) {
      expect(g[`cap_C1${suffix}`]).toBeDefined();
    }
    // delete C1 → all its keys go away
    const remaining = comps.filter((c) => c.id !== 'C1');
    const removed = cleanupComponentState({ state: prev.state }, remaining);
    expect(removed).toBeGreaterThanOrEqual(6);
    for (const suffix of ['', '_i', '_i2', '_used', '_ring', '_alt']) {
      expect(g[`cap_C1${suffix}`]).toBeUndefined();
    }
  });

  it('inductor trap keys (_vp/_vp2) are collected with their element', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1 }),
      comp('inductor', 'L1', { inductance: 1e-6 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'L1', 'a'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'L1', 'b', 'GND', 'g'),
    ];
    const p = plugins();
    let prev: any;
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(comps, ws, p, prev, 1e-3, { method: 'trap' });
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    const g = prev.state.__global;
    expect(g['ind_L1_vp']).toBeDefined();
    expect(g['ind_L1_vp2']).toBeDefined();
    const remaining = comps.filter((c) => c.id !== 'L1');
    cleanupComponentState({ state: prev.state }, remaining);
    expect(g['ind_L1_vp']).toBeUndefined();
    expect(g['ind_L1_vp2']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral Signal Chain example under trap (feedback + guard interplay)
// ─────────────────────────────────────────────────────────────────────────────

describe('trap ringing guard — Behavioral Signal Chain example under trap', () => {
  it('the catalog example simulates correctly with method=trap', async () => {
    const { exampleBehavioral } = await import('../src/lib/circuit/examples');
    const p = plugins();
    let prev: any;
    let sim: any = null;
    for (let i = 0; i < 51; i++) {
      const r = simulateStep(exampleBehavioral.components, exampleBehavioral.wires, p, prev, 1e-4, { method: 'trap' });
      expect(r).not.toBeNull();
      sim = r!.sim;
      prev = { nodeVoltage: sim.nodeVoltage, branchCurrent: sim.branchCurrent, time: sim.time, state: sim.state };
    }
    const nm = buildNodeMap(exampleBehavioral.components, exampleBehavioral.wires, p);
    const inNode = nm.terminalNode.get('vIn:p')!;
    const ampNode = nm.terminalNode.get('r1:a')!;
    const outNode = nm.terminalNode.get('r2:a')!;
    // same pinned values as the euler run (the chain is resistive — the
    // method must not change the answer)
    expect(sim.nodeVoltage[inNode]).toBeCloseTo(1.5, 2);
    expect(sim.nodeVoltage[ampNode]).toBeCloseTo(4.5, 2);
    expect(sim.nodeVoltage[outNode]).toBeCloseTo(4, 2);
  });
});
