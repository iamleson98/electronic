// Regression tests for the AI-layer audit fixes (batch 6).
//
// Covers: whatIf suffix parsing, sweep tool probe semantics + alignment,
// diagnostic checks (shorted sources, cathode-side LED resistors, AGND
// grounding), reannotate refdes semantics, describe ground detection,
// batch-runner trace alignment, provider token clamping, KB search safety,
// strict SPICE number parsing, and the power-supply pattern's RMS/peak fix.

import { describe, it, expect, beforeAll } from 'vitest';
import { parseStrictSpiceNumber } from '../src/lib/circuit/measurement';
import { clampAnthropicMaxTokens, AVAILABLE_MODELS } from '../src/lib/ai/provider';
import { searchArticles } from '../src/lib/ai/knowledge/knowledge-base';
import { runBatch } from '../src/lib/circuit/batch-runner';
import { simulateWhatIfTool } from '../src/lib/ai/tools/whatif-tools';
import { simulateSweepTool } from '../src/lib/ai/tools/sweep-tools';
import { reannotateTool } from '../src/lib/ai/tools/erc-annotation-tools';
import { describeCircuitTool } from '../src/lib/ai/tools/schematic-inspection-tools';
import { diagnoseCircuit } from '../src/lib/ai/tools/diagnostic-tools';
import { TOOLS, getTool } from '../src/lib/ai/tools/index';
import { buildSystemPrompt } from '../src/lib/ai/system-prompt';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, CircuitDocument } from '../src/lib/circuit/types';
import type { ToolContext } from '../src/lib/ai/tools/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function mkComp(type: string, id: string, params: Record<string, any> = {}, pos: [number, number] = [0, 0]): CircuitComponent {
  const p = getPlugin(type);
  return {
    id,
    type,
    position: { x: pos[0], y: pos[1] },
    rotation: 0,
    parameters: { ...(p?.parameters.reduce((a, q) => ({ ...a, [q.key]: q.default }), {}) || {}), ...params },
  };
}

function mkWire(id: string, fromC: string, fromT: string, toC: string, toT: string): Wire {
  return { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
}

function mkCtx(components: CircuitComponent[], wires: Wire[]): ToolContext {
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return {
    doc: { version: 1, components, wires } as CircuitDocument,
    plugins,
    simContext: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strict SPICE number parsing (whatIf value corruption fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseStrictSpiceNumber', () => {
  it('parses engineering suffixes', () => {
    expect(parseStrictSpiceNumber('10k')).toBe(10000);
    expect(parseStrictSpiceNumber('4.7u')).toBeCloseTo(4.7e-6, 12);
    expect(parseStrictSpiceNumber('2.2meg')).toBeCloseTo(2.2e6, 6);
    expect(parseStrictSpiceNumber('100n')).toBeCloseTo(1e-7, 12);
    expect(parseStrictSpiceNumber('47p')).toBeCloseTo(47e-12, 15);
    expect(parseStrictSpiceNumber('10mil')).toBeCloseTo(25.4e-6 * 10, 15);
  });

  it('parses plain numbers and signs', () => {
    expect(parseStrictSpiceNumber('330')).toBe(330);
    expect(parseStrictSpiceNumber('-3.3')).toBe(-3.3);
    expect(parseStrictSpiceNumber('1e3')).toBe(1000);
    expect(parseStrictSpiceNumber('+2.5')).toBe(2.5);
  });

  it('rejects expressions and junk (returns null — never a truncated number)', () => {
    expect(parseStrictSpiceNumber('2*V(in)')).toBeNull();
    expect(parseStrictSpiceNumber('10kΩ')).toBeNull();
    expect(parseStrictSpiceNumber('abc')).toBeNull();
    expect(parseStrictSpiceNumber('')).toBeNull();
    expect(parseStrictSpiceNumber('10 20')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// whatIf tool — suffix + expression safety
// ─────────────────────────────────────────────────────────────────────────────

describe('simulate.whatIf value parsing', () => {
  function ledCircuit() {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
      mkComp('led', 'led1', {}),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'led1', 'a'),
      mkWire('w3', 'led1', 'k', 'gnd', 'g'),
      mkWire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    return { components, wires };
  }

  it('treats "10k" as 10 kΩ, not 10 Ω (1000× corruption fix)', async () => {
    // Resistive divider (r1 top, r2 bottom): with r1 = 10k the probe node sits
    // at 5·(1/11) ≈ 0.45V; the old bug ("10k" → 10Ω) gave ≈ 4.95V.
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
      mkComp('resistor', 'r2', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'r2', 'a'),
      mkWire('w3', 'r2', 'b', 'gnd', 'g'),
      mkWire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const res = await simulateWhatIfTool.execute(
      { modifications: [{ componentId: 'r1', key: 'resistance', value: '10k' }], steps: 5, probes: ['r1:b'] },
      ctx,
    ) as any;
    expect(res.ok).toBe(true);
    expect(res.result.probes['r1:b'].dcVoltage).toBeCloseTo(5 * (1000 / 11000), 3);
    // And the original circuit is untouched.
    expect(components.find(c => c.id === 'r1')!.parameters.resistance).toBe(1000);
  });

  it('preserves expression string parameters for behavioral sources', async () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 3 }),
      mkComp('netLabel', 'lin', { net: 'in' }),
      mkComp('bvSource', 'b1', { expr: '2*V(in)' }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'lin', 'p'),
      mkWire('w2', 'v1', 'n', 'gnd', 'g'),
      mkWire('w3', 'b1', 'p', 'r1', 'a'),
      mkWire('w4', 'r1', 'b', 'gnd', 'g'),
      mkWire('w5', 'b1', 'n', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const res = await simulateWhatIfTool.execute(
      { modifications: [{ componentId: 'r1', key: 'resistance', value: '2.2k' }] },
      ctx,
    ) as any;
    expect(res.ok).toBe(true);
    // The BV expression survived as a string (old parseFloat → "2*V(in)" became 2)
    expect(components.find(c => c.id === 'b1')!.parameters.expr).toBe('2*V(in)');
  });

  it('clamps steps and never reports ±Infinity probe stats', async () => {
    const { components, wires } = ledCircuit();
    const ctx = mkCtx(components, wires);
    const res = await simulateWhatIfTool.execute(
      { modifications: [{ componentId: 'r1', key: 'resistance', value: '1k' }], steps: 0, probes: ['led1:a'] },
      ctx,
    ) as any;
    expect(res.ok).toBe(true);
    expect(Number.isFinite(res.result.probes['led1:a'].minVoltage)).toBe(true);
    expect(Number.isFinite(res.result.probes['led1:a'].maxVoltage)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sweep tool — current measurement + terminal detection
// ─────────────────────────────────────────────────────────────────────────────

describe('simulate.sweep probe semantics', () => {
  function ledSweepCircuit() {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 330 }),
      mkComp('led', 'led1', { forwardV: 2, seriesR: 220 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'led1', 'a'),
      mkWire('w3', 'led1', 'k', 'gnd', 'g'),
      mkWire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    return { components, wires };
  }

  it('returns the LED CURRENT (amps), labeled as such', async () => {
    const { components, wires } = ledSweepCircuit();
    const ctx = mkCtx(components, wires);
    const res = await simulateSweepTool.execute(
      { componentId: 'r1', param: 'resistance', start: 220, stop: 1000, step: 195, probeComponentId: 'led1' },
      ctx,
    ) as any;
    expect(res.ok).toBe(true);
    expect(res.result.points.length).toBeGreaterThanOrEqual(4);
    for (const p of res.result.points) {
      expect(p.converged).toBe(true);
      // LED current in a 5V/2V/220-1kΩ circuit: between ~2.7mA and ~13mA.
      // The old bug returned the LED's ~2V anode VOLTAGE labeled as output.
      expect(Math.abs(p.current)).toBeGreaterThan(0.002);
      expect(Math.abs(p.current)).toBeLessThan(0.02);
    }
    // Monotonic: more resistance → less current
    const currents = res.result.points.map((p: any) => Math.abs(p.current));
    for (let i = 1; i < currents.length; i++) {
      expect(currents[i]).toBeLessThan(currents[i - 1]);
    }
  });

  it('finds the R that hits a 10mA target', async () => {
    const { components, wires } = ledSweepCircuit();
    // Give the LED a 1Ω internal series resistance so the textbook math
    // (R = (Vs − Vf)/I = 300Ω) is exact against the plugin model.
    components.find(c => c.id === 'led1')!.parameters.seriesR = 1;
    const ctx = mkCtx(components, wires);
    const res = await simulateSweepTool.execute(
      { componentId: 'r1', param: 'resistance', start: 100, stop: 500, step: 50, probeComponentId: 'led1' },
      ctx,
    ) as any;
    expect(res.ok).toBe(true);
    // The classic "find R for I_LED = 10mA": (5-2)/0.01 = 300Ω
    const best = res.result.points.reduce((a: any, b: any) =>
      Math.abs(Math.abs(b.current) - 0.01) < Math.abs(Math.abs(a.current) - 0.01) ? b : a);
    expect(Math.abs(Math.abs(best.current) - 0.01)).toBeLessThan(0.002);
    expect(best.value).toBeCloseTo(300, 6);
  });

  it('probing a source (p/n terminals) resolves a real terminal, not :a → ground', async () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'gnd', 'g'),
      mkWire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const res = await simulateSweepTool.execute(
      { componentId: 'r1', param: 'resistance', start: 500, stop: 1500, step: 500, probeComponentId: 'v1' },
      ctx,
    ) as any;
    expect(res.ok).toBe(true);
    expect(res.result.probeTerminal).toBe('p'); // dcVoltage's first terminal
    for (const p of res.result.points) {
      // v1.p is held at 5V by the source regardless of R (old bug: 0V — ground)
      expect(p.voltage).toBeCloseTo(5, 3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic checks
// ─────────────────────────────────────────────────────────────────────────────

describe('diagnostic-tools audit fixes', () => {
  it('detects a source with BOTH terminals on ground (dead short)', () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'gnd', 'g'),
      mkWire('w2', 'v1', 'n', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const short = result.issues.find(i => i.category === 'short-circuit');
    // The old check could never fire (the ground symbol itself counted as a load).
    expect(short).toBeDefined();
    expect(short!.severity).toBe('critical');
  });

  it('detects a source with + wired directly to −', () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'v1', 'n'), // direct short across the source
      mkWire('w2', 'r1', 'a', 'v1', 'p'),
      mkWire('w3', 'r1', 'b', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    expect(result.issues.find(i => i.category === 'short-circuit')).toBeDefined();
  });

  it('does NOT flag the legitimate negative-rail topology (p→gnd, n→load)', () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'gnd', 'g'), // + tied to ground...
      mkWire('w2', 'v1', 'n', 'r1', 'a'),  // ...− drives the load → −5V rail
      mkWire('w3', 'r1', 'b', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    expect(result.issues.find(i => i.category === 'short-circuit')).toBeUndefined();
  });

  it('accepts an LED with the series resistor on the CATHODE side', () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 330 }),
      mkComp('led', 'led1', {}),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'led1', 'a'), // LED anode straight to V+...
      mkWire('w2', 'led1', 'k', 'r1', 'a'), // ...resistor on the cathode side
      mkWire('w3', 'r1', 'b', 'gnd', 'g'),
      mkWire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    // The old check only inspected the anode and produced a 0.95-confidence
    // false "no current-limiting resistor" error.
    expect(result.issues.find(i => i.category === 'over-current')).toBeUndefined();
  });

  it('powerAGND alone is NOT a valid ground (matches the engine)', () => {
    const components = [
      mkComp('powerAGND', 'agnd1', { net: 'AGND' }),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'agnd1', 'p'),
      mkWire('w3', 'v1', 'n', 'agnd1', 'p'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const missing = result.issues.find(i => i.category === 'missing-ground');
    expect(missing).toBeDefined();
  });

  it('a GND-named net label IS a valid ground', () => {
    const components = [
      mkComp('netLabel', 'lbl', { net: 'GND' }),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'lbl', 'p'),
      mkWire('w3', 'v1', 'n', 'lbl', 'p'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    expect(result.issues.find(i => i.category === 'missing-ground')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reannotate — refdes semantics, wiring preserved
// ─────────────────────────────────────────────────────────────────────────────

describe('schematic.reannotate', () => {
  it('renumbers refdes fields and leaves ids + wiring intact', async () => {
    // Out-of-order ids that previously triggered the rename-collision hijack:
    // R2 comes first in the array, R1 second.
    const components = [
      mkComp('resistor', 'R2', { resistance: 1000 }),
      mkComp('resistor', 'R1', { resistance: 470 }),
    ];
    const wires = [
      mkWire('w1', 'R2', 'a', 'R1', 'a'),
    ];
    const ctx = mkCtx(components, wires);
    const res = await reannotateTool.execute({}, ctx) as any;
    expect(res.ok).toBe(true);
    expect(res.result.renamed).toBe(2);
    // refdes renumbered by insertion order
    expect(components[0].refdes).toBe('R1');
    expect(components[1].refdes).toBe('R2');
    // ids unchanged → the wire still references the SAME components as before
    expect(components[0].id).toBe('R2');
    expect(components[1].id).toBe('R1');
    expect(wires[0].from.componentId).toBe('R2');
    expect(wires[0].to.componentId).toBe('R1');
    // and the physical mapping is untouched: w1 still joins the 1kΩ and the 470Ω
    const oneK = components.find(c => c.parameters.resistance === 1000)!;
    const four70 = components.find(c => c.parameters.resistance === 470)!;
    expect([wires[0].from.componentId, wires[0].to.componentId].sort()).toEqual([oneK.id, four70.id].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe — ground detection parity with the engine
// ─────────────────────────────────────────────────────────────────────────────

describe('schematic.describe ground detection', () => {
  it('powerGND-grounded circuits (KiCad imports) are NOT reported as groundless', async () => {
    const components = [
      mkComp('powerGND', 'gnd1', { net: 'GND' }),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'gnd1', 'p'),
      mkWire('w3', 'v1', 'n', 'gnd1', 'p'),
    ];
    const ctx = mkCtx(components, wires);
    const res = await describeCircuitTool.execute({}, ctx) as any;
    expect(res.ok).toBe(true);
    expect(res.result.groundNets).toBeGreaterThanOrEqual(1);
    expect(res.result.hints.some((h: string) => h.includes('No ground'))).toBe(false);
  });

  it('genuinely groundless circuits still warn', async () => {
    const components = [
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
    ];
    const ctx = mkCtx(components, wires);
    const res = await describeCircuitTool.execute({}, ctx) as any;
    expect(res.result.hints.some((h: string) => h.includes('No ground'))).toBe(true);
  });

  it('survives stale wire endpoints (deleted component references)', async () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'ghost', 'a'), // references a deleted component
      mkWire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const res = await describeCircuitTool.execute({}, ctx) as any;
    expect(res.ok).toBe(true); // used to throw TypeError in the union-find
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// batch-runner — trace/sweep alignment
// ─────────────────────────────────────────────────────────────────────────────

describe('batch-runner trace alignment', () => {
  it('tracedSweepValues is index-aligned with traces even when points are skipped', async () => {
    // Two parallel dcVoltage sources with different voltages NEVER converge →
    // every sweep point is skipped. runBatch must report zero traces (the old
    // code returned ok:true with an empty array that tools read as success).
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('dcVoltage', 'v2', { voltage: 3 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'v2', 'p'),
      mkWire('w2', 'v1', 'n', 'v2', 'n'),
      mkWire('w3', 'v1', 'n', 'gnd', 'g'),
      mkWire('w4', 'r1', 'a', 'v1', 'p'),
      mkWire('w5', 'r1', 'b', 'gnd', 'g'),
    ];
    const plugins = new Map<string, any>();
    for (const c of components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    const result = runBatch(components, wires, plugins, {
      type: 'step',
      componentId: 'r1',
      param: 'resistance',
      start: 100,
      stop: 500,
      step: 200,
      inner: { type: 'tran', tStop: 1e-3, tStep: 1e-4, probes: ['r1:a'] } as any,
    });
    expect(result.traces.length).toBe(result.tracedSweepValues.length);
    expect(result.traces.length).toBe(0); // all points fail: conflicting sources
  });

  it('healthy sweep keeps traces and tracedSweepValues the same length', async () => {
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'gnd', 'g'),
      mkWire('w3', 'v1', 'n', 'gnd', 'g'),
    ];
    const plugins = new Map<string, any>();
    for (const c of components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    const result = runBatch(components, wires, plugins, {
      type: 'step',
      componentId: 'r1',
      param: 'resistance',
      start: 500,
      stop: 1500,
      step: 500,
      inner: { type: 'tran', tStop: 1e-3, tStep: 5e-4, probes: ['r1:a'] } as any,
    });
    expect(result.traces.length).toBe(3);
    expect(result.tracedSweepValues.length).toBe(3);
    expect(result.tracedSweepValues.map(s => s.value)).toEqual([500, 1000, 1500]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider + KB hardening
// ─────────────────────────────────────────────────────────────────────────────

describe('provider + knowledge-base hardening', () => {
  it('clamps Anthropic max_tokens to the model family limit', () => {
    // 16384 used to be sent unclamped → 400 on every claude-3-* request.
    expect(clampAnthropicMaxTokens('claude-3-5-sonnet-20241022', 16384)).toBe(8192);
    expect(clampAnthropicMaxTokens('claude-3-5-haiku-20241022', 16384)).toBe(8192);
    expect(clampAnthropicMaxTokens('claude-3-5-sonnet-20241022', 4096)).toBe(4096);
    expect(clampAnthropicMaxTokens('claude-3-5-sonnet-20241022', 100)).toBe(100);
  });

  it('retired Claude 3 Opus is no longer offered', () => {
    expect(AVAILABLE_MODELS.anthropic.some((m: any) => m.id.includes('opus'))).toBe(false);
    // every offered Claude model must fit within the 3.5 token cap
    for (const m of AVAILABLE_MODELS.anthropic) {
      expect(clampAnthropicMaxTokens(m.id, 16384)).toBeLessThanOrEqual(8192);
    }
  });

  it('kb.search does not crash on regex metacharacters', () => {
    // The old code built new RegExp(word) from the raw query.
    expect(() => searchArticles('why ( does this work')).not.toThrow();
    expect(() => searchArticles('[led] flicker?')).not.toThrow();
    expect(() => searchArticles('a*b+c')).not.toThrow();
    const results = searchArticles('(led)');
    expect(Array.isArray(results)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry + system prompt consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('tool registry consistency', () => {
  it('verify.autoCheck is a registered tool (system prompt injects calls to it)', () => {
    expect(getTool('verify.autoCheck')).toBeDefined();
    expect(TOOLS.some(t => t.name === 'verify.autoCheck')).toBe(true);
  });

  it('system prompt uses fully-qualified tool names', () => {
    const prompt = buildSystemPrompt();
    // The old prompt mentioned bare addComponent/addWire which don't exist.
    expect(prompt).not.toMatch(/[^.]addComponent\b/); // no bare addComponent
    expect(prompt).toContain('schematic.addComponent');
    expect(prompt).toContain('schematic.addWire');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Power-supply pattern — RMS/peak consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('design.buildPattern power-supply RMS fix', () => {
  it('builds the AC source with peak amplitude = RMS·√2', async () => {
    const { designBuildPatternTool } = await import('../src/lib/ai/tools/design-patterns');
    const ctx = mkCtx([], []);
    const res = await designBuildPatternTool.execute(
      { pattern: 'power-supply', args: { vacRms: 8, outputV: 5, iLoad: 0.1 }, x: 2, y: 2 },
      ctx,
    ) as any;
    expect(res.ok).toBe(true);
    const acSource = (ctx.doc as any).components.find((c: any) => c.type === 'acVoltage');
    expect(acSource).toBeDefined();
    // 8V RMS → 11.31V peak amplitude (old bug: amplitude was 8 → every
    // reported peak/headroom number was ~41% above the simulated circuit)
    expect(acSource.parameters.amplitude).toBeCloseTo(8 * Math.SQRT2, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// simulate.run: integration-method support + trapezoidal ringing telemetry
// ─────────────────────────────────────────────────────────────────────────────

describe('simulate.run integration method + ringing telemetry', () => {
  it('trap on a dt >> tau RC reports trapRingsSuppressed > 0 and settles correctly', async () => {
    const { runSimulationTool } = await import('../src/lib/ai/tools/simulation-tools');
    // R=1k, C=1nF (tau=1µs) with dt=1ms → classic trapezoidal ringing case.
    const comps = [
      mkComp('dcVoltage', 'V1', { voltage: 5 }),
      mkComp('resistor', 'R1', { resistance: 1000 }),
      mkComp('capacitor', 'C1', { capacitance: 1e-9, initialV: 0 }),
      mkComp('ground', 'GND'),
    ];
    const wires = [
      mkWire('w1', 'V1', 'p', 'R1', 'a'),
      mkWire('w2', 'R1', 'b', 'C1', 'a'),
      mkWire('w3', 'V1', 'n', 'GND', 'g'),
      mkWire('w4', 'C1', 'b', 'GND', 'g'),
    ];
    const res = await runSimulationTool.execute({ steps: 20, dt: 1e-3, method: 'trap' }, mkCtx(comps, wires)) as any;
    expect(res.ok).toBe(true);
    expect(res.result.stepsCompleted).toBe(20);
    expect(res.result.trapRingsSuppressed).toBeGreaterThanOrEqual(1);
    // guard suppressed the (−1)^n mode → cap sits at 5 V
    expect(res.result.nodeVoltages['C1:a']).toBeCloseTo(5, 2);
  });

  it('euler runs carry no trapRingsSuppressed field', async () => {
    const { runSimulationTool } = await import('../src/lib/ai/tools/simulation-tools');
    const comps = [
      mkComp('dcVoltage', 'V1', { voltage: 5 }),
      mkComp('resistor', 'R1', { resistance: 1000 }),
      mkComp('capacitor', 'C1', { capacitance: 1e-9 }),
      mkComp('ground', 'GND'),
    ];
    const wires = [
      mkWire('w1', 'V1', 'p', 'R1', 'a'),
      mkWire('w2', 'R1', 'b', 'C1', 'a'),
      mkWire('w3', 'V1', 'n', 'GND', 'g'),
      mkWire('w4', 'C1', 'b', 'GND', 'g'),
    ];
    const res = await runSimulationTool.execute({ steps: 20, dt: 1e-3, method: 'euler' }, mkCtx(comps, wires)) as any;
    expect(res.ok).toBe(true);
    expect(res.result.trapRingsSuppressed).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2-c audit regressions: stale-simContext invalidation, loadDocument
// validation, client-executed PCB tools.
// ─────────────────────────────────────────────────────────────────────────────

describe('AI audit: simContext invalidation on whole-doc mutations', () => {
  it('examples.load drops the cached simContext (node ids belonged to the old circuit)', async () => {
    const { loadExampleTool } = await import('../src/lib/ai/tools/examples-tools');
    const ctx = mkCtx(
      [mkComp('dcVoltage', 'V1', { voltage: 5 }), mkComp('resistor', 'R1', { resistance: 100 }), mkComp('ground', 'GND')],
      [mkWire('w1', 'V1', 'p', 'R1', 'a'), mkWire('w2', 'R1', 'b', 'GND', 'g'), mkWire('w3', 'V1', 'n', 'GND', 'g')],
    );
    (ctx as any).simContext = { nodeVoltage: [0, 5, 2.5], branchCurrent: [0.05], state: {}, time: 0, dt: 1e-4 };
    const res = await loadExampleTool.execute({ name: 'LED + Resistor' }, ctx) as any;
    expect(res.ok).toBe(true);
    expect(ctx.simContext).toBeNull();
  });

  it('schematic.loadDocument drops the cached simContext', async () => {
    const { loadDocumentTool } = await import('../src/lib/ai/tools/document-tools');
    const ctx = mkCtx([], []);
    (ctx as any).simContext = { nodeVoltage: [0, 5], branchCurrent: [], state: {}, time: 0, dt: 1e-4 };
    const res = await loadDocumentTool.execute({
      components: [mkComp('resistor', 'r1', { resistance: 330 })],
      wires: [],
    }, ctx) as any;
    expect(res.ok).toBe(true);
    expect(ctx.simContext).toBeNull();
  });

  it('design.buildPattern drops the cached simContext (it changes topology)', async () => {
    const { designBuildPatternTool } = await import('../src/lib/ai/tools/design-patterns');
    const ctx = mkCtx([], []);
    (ctx as any).simContext = { nodeVoltage: [0, 5], branchCurrent: [], state: {}, time: 0, dt: 1e-4 };
    const res = await designBuildPatternTool.execute({ pattern: 'led-driver', args: { supplyV: 5 } }, ctx) as any;
    expect(res.ok).toBe(true);
    expect(ctx.simContext).toBeNull();
  });
});

describe('AI audit: schematic.loadDocument argument validation', () => {
  it('rejects non-array components without corrupting the document', async () => {
    const { loadDocumentTool } = await import('../src/lib/ai/tools/document-tools');
    const ctx = mkCtx([mkComp('ground', 'GND')], []);
    const res = await loadDocumentTool.execute({ components: 'r1,r2', wires: [] }, ctx) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/arrays/);
    // the doc must be untouched — later tools and auto-verify rely on it
    expect(ctx.doc.components).toHaveLength(1);
    expect(ctx.doc.components[0].type).toBe('ground');
  });

  it('rejects a components array containing non-components', async () => {
    const { loadDocumentTool } = await import('../src/lib/ai/tools/document-tools');
    const ctx = mkCtx([], []);
    const res = await loadDocumentTool.execute({ components: [42], wires: [] }, ctx) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Invalid component entry/);
    expect(ctx.doc.components).toHaveLength(0);
  });

  it('fills plugin parameter defaults + rotation for hand-written components', async () => {
    const { loadDocumentTool } = await import('../src/lib/ai/tools/document-tools');
    const ctx = mkCtx([], []);
    const res = await loadDocumentTool.execute({
      components: [{ id: 'rX', type: 'resistor', position: { x: 5, y: 5 } }],
      wires: [],
    }, ctx) as any;
    expect(res.ok).toBe(true);
    const comp = ctx.doc.components[0] as any;
    expect(comp.rotation).toBe(0);
    expect(comp.parameters.resistance).toBeDefined(); // plugin default merged
  });

  it('rejects components with malformed position', async () => {
    const { loadDocumentTool } = await import('../src/lib/ai/tools/document-tools');
    const ctx = mkCtx([], []);
    const res = await loadDocumentTool.execute({
      components: [{ id: 'rX', type: 'resistor', position: 'left' }],
      wires: [],
    }, ctx) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Invalid component entry/);
  });

  it('rejects wires without from/to endpoints', async () => {
    const { loadDocumentTool } = await import('../src/lib/ai/tools/document-tools');
    const ctx = mkCtx([], []);
    const res = await loadDocumentTool.execute({
      components: [mkComp('ground', 'GND')],
      wires: [{ id: 'w1' }],
    }, ctx) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Invalid wire entry/);
  });
});

describe('AI audit: server-executed PCB tools run the real pipeline', () => {
  it('rejects import from an EMPTY schematic with a clear error (not ok:true)', async () => {
    const { TOOLS_BY_NAME } = await import('../src/lib/ai/tools');
    const res = await TOOLS_BY_NAME.get('pcb.importFromSchematic')!.execute({}, mkCtx([], [])) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/schematic is empty/i);
  });

  it('requires a PCB before routing/DRC/verify (clear error, no crash)', async () => {
    const { TOOLS_BY_NAME } = await import('../src/lib/ai/tools');
    const ctx = mkCtx([], []);
    for (const name of ['pcb.autoRoute', 'pcb.topoRoute', 'pcb.runDRC', 'pcb.verifyNetlist']) {
      const res = await TOOLS_BY_NAME.get(name)!.execute({}, ctx) as any;
      expect(res.ok, name).toBe(false);
      expect(res.error, name).toMatch(/No PCB loaded/i);
    }
  });

  it('imports a real circuit, routes it, and returns actual statistics + DRC', async () => {
    const { TOOLS_BY_NAME } = await import('../src/lib/ai/tools');
    const components = [
      mkComp('ground', 'gnd'),
      mkComp('dcVoltage', 'v1', { voltage: 5 }),
      mkComp('resistor', 'r1', { resistance: 1000 }),
      mkComp('led', 'led1', {}),
    ];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'led1', 'a'),
      mkWire('w3', 'led1', 'k', 'gnd', 'g'),
      mkWire('w4', 'v1', 'n', 'gnd', 'g'),
    ];
    const ctx = mkCtx(components, wires);

    const imp = await TOOLS_BY_NAME.get('pcb.importFromSchematic')!.execute({}, ctx) as any;
    expect(imp.ok).toBe(true);
    expect(ctx.pcb).toBeDefined();
    expect(ctx.pcb!.footprints.length).toBe(4); // ground has no footprint... footprints = non-annotation comps? At least the 3 real ones.
    expect(imp.result.footprints).toBeGreaterThanOrEqual(3);
    expect(imp.result.board.width).toBeGreaterThan(0);

    const route = await TOOLS_BY_NAME.get('pcb.autoRoute')!.execute({}, ctx) as any;
    expect(route.result).toBeDefined();
    expect(route.result.totalConnections).toBeGreaterThan(0);
    expect(route.result.drc).toBeDefined();

    const drc = await TOOLS_BY_NAME.get('pcb.runDRC')!.execute({}, ctx) as any;
    expect(drc.result.errorCount).toBeDefined();

    const verify = await TOOLS_BY_NAME.get('pcb.verifyNetlist')!.execute({}, ctx) as any;
    expect(verify.result.matchedNets).toBeGreaterThan(0);
  });

  it('records missing component types for the user-facing card', async () => {
    const { TOOLS_BY_NAME } = await import('../src/lib/ai/tools');
    const ctx = mkCtx([], []);
    const res = await TOOLS_BY_NAME.get('schematic.addComponent')!.execute(
      { type: 'fluxCapacitor42', x: 1, y: 1 }, ctx,
    ) as any;
    expect(res.ok).toBe(false);
    expect(ctx.missingComponents).toBeDefined();
    expect(ctx.missingComponents!.has('fluxCapacitor42')).toBe(true);
  });
});
