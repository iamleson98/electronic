// Regression tests for the engine-gmin retry and simplified-AC source
// stamping fixes (deep-audit batch 4).

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, solveDC } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { runACAnalysis } from '../src/lib/circuit/ac-analysis';
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. gmin retry: capacitive-only DC paths must solve
// ─────────────────────────────────────────────────────────────────────────────

describe('gmin retry for capacitive DC paths', () => {
  it('source → 1nF → 1nF → gnd solves (was: singular, null)', () => {
    // The DC companion of a 1nF cap at dt=1e6 is 1e-15 S — below the solver's
    // pivot floor, which made the WHOLE simulation return null before the
    // gmin retry existed. With gmin the divider solves: the mid node's DC
    // value is leakage-dominated (gmin ≫ cap companion), so it sits near 0 —
    // physically what an leakage-defined floating node does — and the
    // important part is the circuit SIMULATES instead of erroring out.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('capacitor', 'C1', { capacitance: 1e-9 }),
      comp('capacitor', 'C2', { capacitance: 1e-9 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'C1', 'a'),
      wire('w2', 'C1', 'b', 'C2', 'a'),
      wire('w3', 'C2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
    const r = simulateStep(comps, ws, plugins(), dc ? {
      nodeVoltage: dc.nodeVoltage, branchCurrent: dc.branchCurrent, time: 0, state: dc.state,
    } : undefined, 1e-4);
    expect(r).not.toBeNull();
    const mid = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('C1:b')!];
    expect(mid).toBeGreaterThan(-0.1);
    expect(mid).toBeLessThan(0.6);
  });

  it('truly ground-less circuits still fail (floating = error, like SPICE)', () => {
    // Battery + resistor loop with NO ground component: must stay an error —
    // the gmin retry is deliberately skipped so the auto-verifier can flag it.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'V1', 'n'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).toBeNull();
  });

  it('precision is untouched: 1 TΩ divider still reads exactly 2.5V', () => {
    // The gmin (1e-12 S = 1 TΩ) must NOT leak into solvable circuits — the
    // first solve succeeds, so no gmin is ever stamped.
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1e12 }),
      comp('resistor', 'R2', { resistance: 1e12 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = simulateStep(comps, ws, plugins(), undefined, 1e-4);
    expect(r).not.toBeNull();
    const mid = r!.sim.nodeVoltage[r!.nodeMap.terminalNode.get('R1:b')!];
    expect(mid).toBeCloseTo(2.5, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Simplified AC analysis (Bode viewer path) source stamping
// ─────────────────────────────────────────────────────────────────────────────

describe('simplified AC analysis source stamping', () => {
  it('biased RC low-pass: DC supply is an AC short, gain reads 0.5 (was 3.0)', () => {
    // 1V AC stimulus through 1k into the output node; a 5V DC bias feed
    // through the SAME 1k sets the DC operating point. At low frequency the
    // capacitive divider is 0.5. The old code pinned the 5V DC source to its
    // DC VALUE in the phasor solve — a spurious second stimulus that pushed
    // the gain to 3.0.
    const comps = [
      comp('acVoltage', 'VS', { amplitude: 1, frequency: 100, offset: 0, phase: 0 }),
      comp('dcVoltage', 'VB', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-3 }), // 1mF: fc = 1/(2π·1k·1m) = 0.16 Hz
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'R1', 'a'),
      wire('w2', 'VS', 'n', 'GND', 'g'),
      wire('w3', 'VB', 'p', 'R2', 'a'),
      wire('w4', 'R2', 'b', 'R1', 'b'), // bias joins the signal node
      wire('w5', 'C1', 'a', 'R1', 'b'),
      wire('w6', 'C1', 'b', 'GND', 'g'),
      wire('w7', 'VB', 'n', 'GND', 'g'),
    ];
    const res = runACAnalysis({
      components: comps, wires: ws, fStart: 0.001, fStop: 0.001, nPoints: 1,
      sourceId: 'VS', acMag: 1, outputNode: 'R1:b',
    });
    expect(res.points.length).toBeGreaterThan(0);
    const lowFreq = res.points[0]; // 1 mHz: far below fc = 0.16 Hz
    // |V(node)| ≈ 0.5 — the R1||R2 divider; the 5V bias contributes NOTHING
    // in phasor land (measured 0.49999)
    expect(lowFreq.magnitude).toBeCloseTo(0.5, 2);
  });

  it('current-source stimulus: SPICE sign convention (drawn from +, injected into −)', () => {
    // 1mA stimulus from node A to ground through its + terminal, 1k load:
    // the engine's convention draws current OUT of + → V(A) = −1V.
    // The old simplified stamp injected INTO + → +1V (180° phase error).
    const comps = [
      comp('currentSource', 'I1', { current: 0.001 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'I1', 'p', 'RL', 'a'),
      wire('w2', 'RL', 'b', 'GND', 'g'),
      wire('w3', 'I1', 'n', 'GND', 'g'),
    ];
    const res = runACAnalysis({
      components: comps, wires: ws, fStart: 100, fStop: 100, nPoints: 1,
      sourceId: 'I1', acMag: 0.001, outputNode: 'RL:a',
    });
    expect(res.points.length).toBeGreaterThan(0);
    const pt = res.points[0];
    // matches the engine's DC solve sign: V(a) = −1V
    expect(pt.real).toBeCloseTo(-1, 3);
    expect(Math.abs(pt.imag)).toBeLessThan(1e-9);
  });

  it('stimulus phase is honored (90° source reads as +j)', () => {
    const comps = [
      comp('acVoltage', 'VS', { amplitude: 1, frequency: 100, offset: 0, phase: 90 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'RL', 'a'),
      wire('w2', 'RL', 'b', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
    ];
    const res = runACAnalysis({
      components: comps, wires: ws, fStart: 100, fStop: 100, nPoints: 1,
      sourceId: 'VS', acMag: 1, outputNode: 'RL:a',
    });
    expect(res.points.length).toBeGreaterThan(0);
    const pt = res.points[0];
    expect(pt.real).toBeCloseTo(0, 6);
    expect(pt.imag).toBeCloseTo(1, 6);
  });
});
