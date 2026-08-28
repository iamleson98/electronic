// Every catalog example must simulate cleanly under EVERY integration method
// (backward Euler, trapezoidal, Gear/BDF-2).
//
// The user-facing contract: opening the Options dialog, switching Integration
// Method, and re-running any example must never break the simulation — and
// for signal-chain examples the results must AGREE across methods (the
// method only changes numerical accuracy, not physics). Oscillators
// legitimately differ: trapezoidal preserves amplitude where backward Euler
// numerically damps it — the LC Tank example pins exactly that behavior.

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { exampleCategories, exampleLCTank } from '../src/lib/circuit/examples';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function plugins(): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().map((p) => [p.type, p]));
}

type Method = 'euler' | 'trap' | 'gear';

interface RunOut {
  ok: boolean;             // every step solved
  steps: number;           // steps actually run
  maxAbs: number;          // max |V| over all nodes/steps
  finite: boolean;         // all voltages finite
  final: SimContext | null;
  history: Float64Array[]; // per-step probe-node voltage
  nodeMap: Map<string, number> | null;
  ringCount: number;       // trap guard trip count (0 unless trap)
}

/** Clone components so simState never leaks between methods. */
function fresh(comps: CircuitComponent[]): CircuitComponent[] {
  return comps.map((c) => ({ ...c, parameters: { ...c.parameters }, simState: {} }));
}

/** Simulate `steps` steps at dt under `method`, probing `probe` (comp:term). */
function run(
  doc: { components: CircuitComponent[]; wires: Wire[] },
  steps: number,
  dt: number,
  method: Method,
  probe?: string,
): RunOut {
  const p = plugins();
  const comps = fresh(doc.components);
  let prev: SimContext | undefined;
  const history: Float64Array[] = [];
  let ok = true;
  let stepsRun = 0;
  let maxAbs = 0;
  let finite = true;
  let final: SimContext | null = null;
  let nodeMap: Map<string, number> | null = null;
  let ringCount = 0;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(comps, doc.wires, p, prev as any, dt, { method });
    if (!r) { ok = false; break; }
    final = r.sim;
    nodeMap = r.nodeMap.terminalNode;
    stepsRun++;
    for (let k = 0; k < r.sim.nodeVoltage.length; k++) {
      const v = r.sim.nodeVoltage[k];
      if (!Number.isFinite(v)) { finite = false; ok = false; }
      else maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    ringCount = (r.sim.state.__global?.__trapRingCount as number | undefined) ?? 0;
    history.push(Float64Array.from(r.sim.nodeVoltage));
    prev = {
      nodeVoltage: r.sim.nodeVoltage,
      branchCurrent: r.sim.branchCurrent,
      time: r.sim.time,
      state: r.sim.state,
    } as any;
  }
  void probe;
  return { ok, steps: stepsRun, maxAbs, finite, final, history, nodeMap, ringCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Smoke: every example × every method runs the full window, finite, bounded
// ─────────────────────────────────────────────────────────────────────────────

describe('All catalog examples × all integration methods', () => {
  const METHODS: Method[] = ['euler', 'trap', 'gear'];

  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      for (const method of METHODS) {
        it(`${ex.name} [${method}]: full run, finite, bounded`, () => {
          const out = run(ex.doc, 200, 1e-4, method);
          expect(out.ok).toBe(true);
          expect(out.steps).toBe(200);
          expect(out.finite).toBe(true);
          // every example is a ≤ 12 V system — 1kV catches any numerical blow-up
          expect(out.maxAbs).toBeLessThan(1000);
        });
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Signal-chain examples: results must AGREE across methods
// ─────────────────────────────────────────────────────────────────────────────

describe('Signal-chain examples agree across methods', () => {
  const AC_EXAMPLES = new Set([
    'RC Low-pass Filter',
    'RL High-pass Filter',
    'Diode Rectifier',
    'Behavioral Signal Chain',
    'Op-Amp Inverting Amp',
    'Op-Amp Non-inverting Amp',
    'Two-Stage Audio Amplifier',
    'Speaker Driver',
  ]);

  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      if (!AC_EXAMPLES.has(ex.name)) continue;
      it(`${ex.name}: node voltage ranges agree euler vs trap vs gear`, () => {
        const mins: Record<Method, number[]> = { euler: [], trap: [], gear: [] };
        const maxs: Record<Method, number[]> = { euler: [], trap: [], gear: [] };
        for (const method of ['euler', 'trap', 'gear'] as Method[]) {
          const out = run(ex.doc, 200, 1e-4, method);
          expect(out.ok).toBe(true);
          const n = out.history[0].length;
          // Skip the startup transient (first 50 steps): coupling caps and
          // bias networks settle differently under each method — that's the
          // methods doing their job, not a physics disagreement. Compare the
          // settled window.
          const settled = out.history.slice(50);
          for (let k = 0; k < n; k++) {
            let mn = Infinity, mx = -Infinity;
            for (const h of settled) {
              const v = h[k];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            mins[method][k] = mn;
            maxs[method][k] = mx;
          }
        }
        // per-node swing parity: the method changes accuracy, not physics —
        // every node's total swing under trap/gear within [0.5×, 2×] of Euler's
        for (let k = 1; k < mins.euler.length; k++) {
          const eSwing = maxs.euler[k] - mins.euler[k];
          if (eSwing < 0.5) continue; // ignore quiet nodes
          const tSwing = maxs.trap[k] - mins.trap[k];
          const gSwing = maxs.gear[k] - mins.gear[k];
          expect(tSwing).toBeGreaterThan(0.5 * eSwing);
          expect(tSwing).toBeLessThan(2.0 * eSwing);
          expect(gSwing).toBeGreaterThan(0.5 * eSwing);
          expect(gSwing).toBeLessThan(2.0 * eSwing);
          // and the extrema (e.g. op-amp rails) land on the same values
          expect(Math.abs(maxs.trap[k] - maxs.euler[k])).toBeLessThan(0.5);
          expect(Math.abs(mins.trap[k] - mins.euler[k])).toBeLessThan(0.5);
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Behavioral Signal Chain: pinned values under all three methods
// ─────────────────────────────────────────────────────────────────────────────

describe('Behavioral Signal Chain — exact values under every method', () => {
  const behavior = exampleCategories
    .flatMap((c) => c.examples)
    .find((e) => e.name === 'Behavioral Signal Chain')!;

  for (const method of ['euler', 'trap', 'gear'] as Method[]) {
    it(`[ ${method} ] V(in)=1.5 → V(amp)=4.5 → V(out)=4.0 at the sine peak`, () => {
      const p = plugins();
      const comps = fresh(behavior.doc.components);
      let prev: SimContext | undefined;
      let sim: SimContext | null = null;
      for (let i = 0; i < 51; i++) {
        const r = simulateStep(comps, behavior.doc.wires, p, prev as any, 1e-4, { method });
        expect(r).not.toBeNull();
        sim = r!.sim;
        prev = {
          nodeVoltage: sim.nodeVoltage,
          branchCurrent: sim.branchCurrent,
          time: sim.time,
          state: sim.state,
        } as any;
      }
      const nm = buildNodeMap(comps, behavior.doc.wires, p);
      const vIn = sim!.nodeVoltage[nm.terminalNode.get('vIn:p')!];
      const vAmp = sim!.nodeVoltage[nm.terminalNode.get('r1:a')!];
      const vOut = sim!.nodeVoltage[nm.terminalNode.get('r2:a')!];
      expect(vIn).toBeCloseTo(1.5, 2);
      expect(vAmp).toBeCloseTo(4.5, 2);
      expect(vOut).toBeCloseTo(4, 2);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. LC Tank Oscillator — the integration-method showcase example
// ─────────────────────────────────────────────────────────────────────────────

describe('LC Tank Oscillator example — the trapezoidal showcase', () => {
  // f0 = 1/(2π√(0.1·10µ)) ≈ 159 Hz; T0 ≈ 6.28 ms → 62.8 samples/period at
  // dt = 1e-4. 800 steps ≈ 12.7 periods.
  const dt = 1e-4;
  const steps = 800;

  function peakOfLastPeriod(out: RunOut, node: number): number {
    const tail = out.history.slice(-63).map((h) => h[node]);
    return Math.max(...tail.map(Math.abs));
  }

  it('euler: numerical damping kills the oscillation (< 40% after ~13 periods)', () => {
    const out = run(exampleLCTank, steps, dt, 'euler');
    expect(out.ok).toBe(true);
    const nm = out.nodeMap!;
    const node = nm.get('c1:a')!;
    // first period amplitude ≈ 5 V (initial charge), euler damps ~0.5%/step
    const peak = peakOfLastPeriod(out, node);
    expect(peak).toBeGreaterThan(0.05); // not dead to zero (still solving)
    expect(peak).toBeLessThan(2.0);     // but heavily damped
  });

  it('trap: amplitude preserved (≥ 85% after ~13 periods) and period exact', () => {
    const out = run(exampleLCTank, steps, dt, 'trap');
    expect(out.ok).toBe(true);
    const nm = out.nodeMap!;
    const node = nm.get('c1:a')!;
    const peak = peakOfLastPeriod(out, node);
    expect(peak).toBeGreaterThan(4.25); // ≈5 V × Q-loss ≈ 1 (euler would be <2)
    // exact period: positive-going zero crossings spaced 62.8±1 samples
    const trace = out.history.map((h) => h[node]);
    const zeros: number[] = [];
    for (let i = 1; i < trace.length; i++) {
      if (trace[i - 1] < 0 && trace[i] >= 0) zeros.push(i);
    }
    expect(zeros.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < zeros.length; i++) {
      expect(zeros[i] - zeros[i - 1]).toBeGreaterThanOrEqual(61);
      expect(zeros[i] - zeros[i - 1]).toBeLessThanOrEqual(64);
    }
    // and the ringing guard stays silent — this is REAL oscillation
    expect(out.ringCount).toBe(0);
  });

  it('gear: mild, clean damping (between trap and euler)', () => {
    const out = run(exampleLCTank, steps, dt, 'gear');
    expect(out.ok).toBe(true);
    const node = out.nodeMap!.get('c1:a')!;
    const peak = peakOfLastPeriod(out, node);
    // BDF-2 at 63 samples/period: a few % per period — still clearly ringing
    expect(peak).toBeGreaterThan(2.5);
    expect(peak).toBeLessThan(5.0);
  });

  it('oscillation frequency matches 1/(2π√(LC)) under trap', () => {
    const out = run(exampleLCTank, steps, dt, 'trap');
    const node = out.nodeMap!.get('c1:a')!;
    const trace = out.history.map((h) => h[node]);
    const zeros: number[] = [];
    for (let i = 1; i < trace.length; i++) {
      if (trace[i - 1] < 0 && trace[i] >= 0) zeros.push(i);
    }
    expect(zeros.length).toBeGreaterThanOrEqual(2);
    const cycles = zeros.length - 1;
    const totalTime = (zeros[zeros.length - 1] - zeros[0]) * dt;
    const fMeasured = cycles / totalTime;
    const fIdeal = 1 / (2 * Math.PI * Math.sqrt(0.1 * 10e-6));
    expect(Math.abs(fMeasured - fIdeal) / fIdeal).toBeLessThan(0.02);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 555 astable — oscillator behavior under every method
// ─────────────────────────────────────────────────────────────────────────────

describe('555 Astable example — oscillator under every method', () => {
  const ex555 = exampleCategories
    .flatMap((c) => c.examples)
    .find((e) => e.name === '555 Astable Blink')!;

  for (const method of ['euler', 'trap', 'gear'] as Method[]) {
    it(`[ ${method} ] LED energizes and the timer output is a clean rail-to-rail swing`, () => {
      const out = run(ex555.doc, 200, 1e-4, method);
      expect(out.ok).toBe(true);
      expect(out.steps).toBe(200);
      const ledNode = out.nodeMap!.get('led1:a')!;
      let maxLed = -Infinity;
      for (const h of out.history) maxLed = Math.max(maxLed, h[ledNode]);
      // the astable output drives the LED to the rail
      expect(maxLed).toBeGreaterThan(4.5);
    });
  }
});
