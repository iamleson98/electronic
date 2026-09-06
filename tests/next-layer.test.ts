// Next-layer hardening: unified SPICE suffixes, temp threading, per-part
// MC distribution, robust inline fallbacks, LC PZ pair, skill prompt.

import { describe, it, expect } from 'vitest';
import { parseSpiceValue as parseA } from '../src/lib/circuit/spice';
import { parseSpiceValue as parseB } from '../src/lib/circuit/spice-import';
import { runPZ } from '../src/lib/circuit/analysis';
import { buildSystemPrompt } from '../src/lib/ai/system-prompt';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

describe('unified SPICE suffixes', () => {
  it('both parsers agree on compounds', () => {
    for (const s of ['1k', '4.7k', '10u', '1uF', '100n', '2.2mH', '1Meg', '10mil', '2.5kHz', '100ohm']) {
      expect(parseB(s), s).toBeCloseTo(parseA(s), 9);
    }
    expect(parseA('1uF')).toBeCloseTo(1e-6, 12);
    expect(parseA('2.2mH')).toBeCloseTo(2.2e-3, 12);
  });
});

describe('LC tank PZ complex pair', () => {
  it('finds resonance near 1/sqrt(LC)', () => {
    const mk = (type: string, id: string, params: Record<string, number> = {}) => {
      const p = getPlugin(type)!;
      const d: Record<string, number | string | boolean> = {};
      for (const q of p.parameters) d[q.key] = q.default;
      return { id, type, position: { x: 0, y: 0 }, rotation: 0 as const, parameters: { ...d, ...params }, refdes: id.toUpperCase() };
    };
    // Series RLC driven by V source: resonance visible in the descriptor.
    const comps = [
      mk('dcVoltage', 'v1', { voltage: 5 }),
      mk('resistor', 'r1', { resistance: 10 }),
      mk('inductor', 'l1', { inductance: 1e-3 }),
      mk('capacitor', 'c1', { capacitance: 1e-6 }),
      mk('ground', 'gnd'),
    ];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'l1', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'l1', terminalId: 'b' }, to: { componentId: 'c1', terminalId: 'a' } },
      { id: 'w4', from: { componentId: 'c1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w5', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const r = runPZ(comps as never, wires as never, plugins as never, { type: 'pz', inputNode: 'v1:p', outputNode: 'r1:b' });
    expect(r.report.attempts[0]).toBe('QZ-lite (G+sC)');
    // f0 = 1/(2π√(LC)) ≈ 5033 Hz for 1mH/1µF
    const nearRes = (r.traces[0] as unknown as { xValues: Float64Array; yValues: Float64Array });
    let best = Infinity;
    for (let i = 0; i < nearRes.xValues.length; i++) {
      const f = Math.hypot(nearRes.xValues[i], nearRes.yValues[i]) / (2 * Math.PI);
      if (f > 1000 && f < 20000) best = Math.min(best, Math.abs(f - 5033));
    }
    expect(best).toBeLessThan(2500);
  });
});

describe('skill prompt injection', () => {
  it('mentions skill level blocks', () => {
    expect(buildSystemPrompt('beginner')).toContain('BEGINNER');
    expect(buildSystemPrompt('engineer')).toContain('ENGINEER');
    expect(buildSystemPrompt()).toContain('PRACTITIONER');
  });
});
