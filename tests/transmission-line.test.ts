// Physics regression tests for the transmission-line rewrite.
//
// transLineLossless now uses the Bergeron / method-of-characteristics model
// (full two-port: reflections, matched terminations, open-end doubling) and
// transLineLossy uses a proper Π-section RLGC ladder with real companion
// models (delay, charge storage, correct DC resistance). These tests pin the
// physics: delay accuracy, reflection coefficients, matched behavior, DC
// resistance, high-segment-count matrix sizing, and per-instance state.

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep } from '../src/lib/circuit/engine';
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

/** Run N steps at dt; return the array of per-step results. */
function runTrace(comps: CircuitComponent[], ws: Wire[], steps: number, dt: number) {
  const p = plugins();
  let prev: any;
  const out: any[] = [];
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(comps, ws, p, prev, dt);
    if (!r) return out;
    out.push(r);
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return out;
}

function nodeV(r: any, nodeMap: any, key: string): number {
  return r.sim.nodeVoltage[nodeMap.terminalNode.get(key)!] ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lossless line — Bergeron model
// ─────────────────────────────────────────────────────────────────────────────

describe('Lossless transmission line (Bergeron)', () => {
  it('matched line: input looks like Z0 before the wave returns, load sees the wave after Td', () => {
    // 5 V source — Rs=50 — [Z0=50, Td] — RL=50. Everything matched: the
    // launched wave is 2.5 V; it arrives at the load at Td and is absorbed.
    const Td = 5e-4;
    const dt = 1e-4; // 5 steps of delay
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'Rs', { resistance: 50 }),
      comp('transLineLossless', 'T1', { Z0: 50, Td }),
      comp('resistor', 'RL', { resistance: 50 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'Rs', 'a'),
      wire('w2', 'Rs', 'b', 'T1', 'a1'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'GND', 'g', 'T1', 'a2'),
      wire('w5', 'T1', 'b1', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'T1', 'b2', 'GND', 'g'),
    ];
    const trace = runTrace(comps, ws, 12, dt);
    expect(trace.length).toBe(12);
    const nm = trace[0].nodeMap;
    const va = (i: number) => nodeV(trace[i], nm, 'T1:a1');
    const vb = (i: number) => nodeV(trace[i], nm, 'T1:b1');
    // Before the wave arrives (t < Td): load voltage 0, input = divider 2.5 V.
    expect(vb(2)).toBeCloseTo(0, 6);
    expect(va(2)).toBeCloseTo(2.5, 2);
    // After arrival (t ≥ Td) the load sees the 2.5 V wave; still no
    // reflection (matched), so both ends settle at 2.5 V.
    expect(vb(7)).toBeCloseTo(2.5, 2);
    expect(vb(11)).toBeCloseTo(2.5, 2);
    expect(va(11)).toBeCloseTo(2.5, 2);
  });

  it('open far end doubles the incident voltage (Γ = +1)', () => {
    // 5 V — Rs=50 — [Z0=50, Td] — open (1 GΩ to ground: the codebase treats
    // unwired terminals as ground, so model the open end explicitly).
    // Launched wave 2.5 V; at the open end the voltage doubles to 5 V at t = Td.
    const Td = 5e-4;
    const dt = 1e-4;
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'Rs', { resistance: 50 }),
      comp('transLineLossless', 'T1', { Z0: 50, Td }),
      comp('resistor', 'Ropen', { resistance: 1e9 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'Rs', 'a'),
      wire('w2', 'Rs', 'b', 'T1', 'a1'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'GND', 'g', 'T1', 'a2'),
      wire('w5', 'T1', 'b1', 'Ropen', 'a'),
      wire('w6', 'Ropen', 'b', 'GND', 'g'),
      wire('w7', 'T1', 'b2', 'GND', 'g'),
    ];
    const trace = runTrace(comps, ws, 12, dt);
    expect(trace.length).toBe(12);
    const nm = trace[0].nodeMap;
    const va = (i: number) => nodeV(trace[i], nm, 'T1:a1');
    const vb = (i: number) => nodeV(trace[i], nm, 'T1:b1');
    // t < Td: b1 still 0.
    expect(vb(2)).toBeCloseTo(0, 6);
    // t just past Td: open-end doubling → 5 V (2 × 2.5 V).
    expect(vb(6)).toBeCloseTo(5, 2);
    // After the reflection returns (t ≥ 2Td) the matched source absorbs it;
    // steady state is the open-circuit value: both ends at 5 V.
    expect(va(11)).toBeCloseTo(5, 2);
    expect(vb(11)).toBeCloseTo(5, 2);
  });

  it('shorted far end reflects inverted (Γ = −1), input stays at launch value', () => {
    // 5 V — Rs=50 — [Z0=50, Td] — short to return. V(b1) must stay ~0 the
    // whole time; the input stays 2.5 V until the −1 reflection returns at
    // 2Td, after which the line input collapses toward 0 (shorted line).
    const Td = 5e-4;
    const dt = 1e-4;
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'Rs', { resistance: 50 }),
      comp('transLineLossless', 'T1', { Z0: 50, Td }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'Rs', 'a'),
      wire('w2', 'Rs', 'b', 'T1', 'a1'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'GND', 'g', 'T1', 'a2'),
      wire('w5', 'T1', 'b1', 'GND', 'g'),
      wire('w6', 'T1', 'b2', 'GND', 'g'),
    ];
    const trace = runTrace(comps, ws, 14, dt);
    expect(trace.length).toBe(14);
    const nm = trace[0].nodeMap;
    const va = (i: number) => nodeV(trace[i], nm, 'T1:a1');
    const vb = (i: number) => nodeV(trace[i], nm, 'T1:b1');
    for (let i = 0; i < 14; i++) expect(vb(i)).toBeCloseTo(0, 6);
    // Before the short's reflection returns: input is the launch value.
    expect(va(7)).toBeCloseTo(2.5, 2);
    // After 2Td the reflected −2.5 V wave reaches the source and the input
    // collapses toward 0 (matched source absorbs it; line looks shorted).
    expect(va(12)).toBeCloseTo(0, 1);
  });

  it('delay is interpolated (Td not a whole number of steps)', () => {
    // Td = 2.5·dt: the wave front should arrive between steps 2 and 3 —
    // interpolation makes the transition partial at the bracketing step
    // rather than jumping a full step early/late.
    const dt = 1e-4;
    const Td = 2.5e-4;
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 4 }),
      comp('resistor', 'Rs', { resistance: 50 }),
      comp('transLineLossless', 'T1', { Z0: 50, Td }),
      comp('resistor', 'RL', { resistance: 50 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'Rs', 'a'),
      wire('w2', 'Rs', 'b', 'T1', 'a1'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'GND', 'g', 'T1', 'a2'),
      wire('w5', 'T1', 'b1', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'T1', 'b2', 'GND', 'g'),
    ];
    const trace = runTrace(comps, ws, 8, dt);
    const nm = trace[0].nodeMap;
    const vb = (i: number) => nodeV(trace[i], nm, 'T1:b1');
    // Step 1 (t=dt): nothing yet. Step 3 (t=3dt > Td): arrived.
    expect(vb(1)).toBeCloseTo(0, 6);
    expect(vb(3)).toBeCloseTo(2, 2); // 4 V × 50/(50+50)
  });

  it('two parallel lines keep independent history (comp-id keyed state)', () => {
    // Two identical lines with different Td: outputs must differ.
    const dt = 1e-4;
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'Rs1', { resistance: 50 }),
      comp('resistor', 'Rs2', { resistance: 50 }),
      comp('transLineLossless', 'T1', { Z0: 50, Td: 2e-4 }),
      comp('transLineLossless', 'T2', { Z0: 50, Td: 8e-4 }),
      comp('resistor', 'RL1', { resistance: 50 }),
      comp('resistor', 'RL2', { resistance: 50 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'Rs1', 'a'),
      wire('w2', 'Rs1', 'b', 'T1', 'a1'),
      wire('w3', 'V1', 'p', 'Rs2', 'a'),
      wire('w4', 'Rs2', 'b', 'T2', 'a1'),
      wire('w5', 'V1', 'n', 'GND', 'g'),
      wire('w6', 'GND', 'g', 'T1', 'a2'),
      wire('w7', 'GND', 'g', 'T2', 'a2'),
      wire('w8', 'T1', 'b1', 'RL1', 'a'),
      wire('w9', 'RL1', 'b', 'GND', 'g'),
      wire('w10', 'T1', 'b2', 'GND', 'g'),
      wire('w11', 'T2', 'b1', 'RL2', 'a'),
      wire('w12', 'RL2', 'b', 'GND', 'g'),
      wire('w13', 'T2', 'b2', 'GND', 'g'),
    ];
    const trace = runTrace(comps, ws, 10, dt);
    expect(trace.length).toBe(10);
    const nm = trace[0].nodeMap;
    const v1 = (i: number) => nodeV(trace[i], nm, 'RL1:a');
    const v2 = (i: number) => nodeV(trace[i], nm, 'RL2:a');
    // t = 5dt: T1 (Td=2dt) has delivered; T2 (Td=8dt) has not.
    expect(v1(5)).toBeCloseTo(2.5, 2);
    expect(v2(5)).toBeCloseTo(0, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lossy line — RLGC Π-section ladder
// ─────────────────────────────────────────────────────────────────────────────

describe('Lossy transmission line (RLGC ladder)', () => {
  it('DC steady state: the line is a pure R·length resistor', () => {
    // R = 10 Ω/m, len = 1 m, load RL = 10 Ω, source 4 V with no series R:
    // steady state → V(b1) = 4 × 10/(10+10) = 2 V. L/C transients decay
    // within a few time constants; run enough steps to settle.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 4 }),
      comp('transLineLossy', 'TL1', {
        RperLen: 10, LperLen: 1e-6, GperLen: 0, CperLen: 1e-9, length: 1, segments: 8,
      }),
      comp('resistor', 'RL', { resistance: 10 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'TL1', 'a1'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'TL1', 'a2'),
      wire('w4', 'TL1', 'b1', 'RL', 'a'),
      wire('w5', 'RL', 'b', 'GND', 'g'),
      wire('w6', 'TL1', 'b2', 'GND', 'g'),
    ];
    // L·C total = 1e-6 H × 1e-9 F spread over segments; with dt=1e-4 the
    // companion settles fast. 200 steps ≫ τ.
    const trace = runTrace(comps, ws, 200, 1e-4);
    expect(trace.length).toBe(200);
    const nm = trace[0].nodeMap;
    const vb = nodeV(trace[199], nm, 'TL1:b1');
    expect(vb).toBeCloseTo(2, 2); // 4 V across 10 Ω + 10 Ω
  });

  it('has real delay: the output lags a fast input edge', () => {
    // Coax-like line: L=250 nH/m, C=100 pF/m → v = 1/√(LC) ≈ 2e8 m/s,
    // Z0 = 50 Ω. len = 20 m → delay ≈ 100 ns. dt = 5 ns (below the 6.25 ns
    // per-segment delay, so backward Euler doesn't smear the front).
    const dt = 5e-9;
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'Rs', { resistance: 5 }),
      comp('transLineLossy', 'TL1', {
        RperLen: 0, LperLen: 250e-9, GperLen: 0, CperLen: 100e-12, length: 20, segments: 16,
      }),
      comp('resistor', 'RL', { resistance: 1e6 }), // ~open
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'Rs', 'a'),
      wire('w2', 'Rs', 'b', 'TL1', 'a1'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'GND', 'g', 'TL1', 'a2'),
      wire('w5', 'TL1', 'b1', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'TL1', 'b2', 'GND', 'g'),
    ];
    // 20 steps = 100 ns = one line delay.
    const trace = runTrace(comps, ws, 30, dt);
    expect(trace.length).toBe(30);
    const nm = trace[0].nodeMap;
    // At t = 20 ns (step 4) the wave has only covered 20% of the line.
    const vbEarly = nodeV(trace[4], nm, 'TL1:b1');
    expect(Math.abs(vbEarly)).toBeLessThan(0.05);
    // By t = 140 ns (step 29) the wave has arrived and doubled at the open
    // end: 2 × 5·50/(5+50) ≈ 9.1 V.
    const vbLate = nodeV(trace[29], nm, 'TL1:b1');
    expect(vbLate).toBeGreaterThan(7);
  });

  it('survives segments=64 (extraVars matrix sizing)', () => {
    // The old code silently overflowed the pre-allocated MNA matrix for
    // N > ~4·components and the solve stalled (null). The engine now sizes
    // the system from plugin.extraVars().
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 3 }),
      comp('transLineLossy', 'TL1', {
        RperLen: 1, LperLen: 1e-7, GperLen: 0, CperLen: 1e-10, length: 1, segments: 64,
      }),
      comp('resistor', 'RL', { resistance: 1 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'TL1', 'a1'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'TL1', 'a2'),
      wire('w4', 'TL1', 'b1', 'RL', 'a'),
      wire('w5', 'RL', 'b', 'GND', 'g'),
      wire('w6', 'TL1', 'b2', 'GND', 'g'),
    ];
    const trace = runTrace(comps, ws, 50, 1e-5);
    expect(trace.length).toBe(50);
    const nm = trace[0].nodeMap;
    const vb = nodeV(trace[49], nm, 'TL1:b1');
    // Divider: 3 V across 1 Ω (line) + 1 Ω (load) → 1.5 V.
    expect(vb).toBeCloseTo(1.5, 2);
  });

  it('two parallel lossy lines keep independent state', () => {
    const mk = (id: string, rPerLen: number) => comp('transLineLossy', id, {
      RperLen: rPerLen, LperLen: 1e-7, GperLen: 0, CperLen: 1e-10, length: 1, segments: 4,
    });
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 6 }),
      mk('TA', 2),
      mk('TB', 10),
      comp('resistor', 'RA', { resistance: 2 }),
      comp('resistor', 'RB', { resistance: 2 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'TA', 'a1'),
      wire('w2', 'V1', 'p', 'TB', 'a1'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'GND', 'g', 'TA', 'a2'),
      wire('w5', 'GND', 'g', 'TB', 'a2'),
      wire('w6', 'TA', 'b1', 'RA', 'a'),
      wire('w7', 'RA', 'b', 'GND', 'g'),
      wire('w8', 'TA', 'b2', 'GND', 'g'),
      wire('w9', 'TB', 'b1', 'RB', 'a'),
      wire('w10', 'RB', 'b', 'GND', 'g'),
      wire('w11', 'TB', 'b2', 'GND', 'g'),
    ];
    const trace = runTrace(comps, ws, 300, 1e-4);
    expect(trace.length).toBe(300);
    const nm = trace[0].nodeMap;
    // TA: 2 Ω line + 2 Ω load → 3 V. TB: 10 Ω line + 2 Ω load → 1 V.
    expect(nodeV(trace[299], nm, 'RA:a')).toBeCloseTo(3, 2);
    expect(nodeV(trace[299], nm, 'RB:a')).toBeCloseTo(1, 2);
  });
});
