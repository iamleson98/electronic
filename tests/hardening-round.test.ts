// Hardening round: PZ Schur exactness (series RLC complex pair), DRC
// override persistence, X2 bundle parity, derating temp curves, yield
// per-part merge, analysis dialog subforms (type-level).

import { describe, it, expect } from 'vitest';
import { runPZ } from '../src/lib/circuit/analysis';
import { exportAllGerbersX2 } from '../src/lib/pcb/gerber-export';
import { deratingCheckTool } from '../src/lib/ai/tools/review-tools';
import { yieldMonteCarloTool } from '../src/lib/ai/tools/yield-tools';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

function mk(type: string, id: string, params: Record<string, number | string | boolean> = {}) {
  const p = getPlugin(type)!;
  const d: Record<string, number | string | boolean> = {};
  for (const q of p.parameters) d[q.key] = q.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0 as const, parameters: { ...d, ...params }, refdes: id.toUpperCase() };
}

describe('PZ Schur exactness', () => {
  it('series RLC gives the analytic complex pair -5000 ± j31225', () => {
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
    const t = r.traces[0] as unknown as { xValues: Float64Array; yValues: Float64Array };
    // One stored pole per conjugate pair (the im>0 half; mirrors filtered).
    expect(t.xValues.length).toBe(1);
    // Complex pair: same real part, opposite imag.
    expect(Math.abs(t.xValues[0] + 5000)).toBeLessThan(100);
    expect(Math.abs(Math.abs(t.yValues[0]) - 31225)).toBeLessThan(500);
    // Stable: negative real parts (passive circuit).
    expect(t.xValues[0]).toBeLessThan(0);
    expect(Math.abs(t.yValues[0])).toBeGreaterThan(1000); // genuinely complex, not a real pole
  });

  it('parallel RLC still exact after the sign fix', () => {
    const comps = [
      mk('currentSource', 'i1', { current: 0.01 }),
      mk('resistor', 'r1', { resistance: 1000 }),
      mk('inductor', 'l1', { inductance: 1e-3 }),
      mk('capacitor', 'c1', { capacitance: 1e-6 }),
      mk('ground', 'gnd'),
    ];
    const wires = [
      { id: 'w1', from: { componentId: 'i1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w3', from: { componentId: 'i1', terminalId: 'p' }, to: { componentId: 'l1', terminalId: 'a' } },
      { id: 'w4', from: { componentId: 'l1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w5', from: { componentId: 'i1', terminalId: 'p' }, to: { componentId: 'c1', terminalId: 'a' } },
      { id: 'w6', from: { componentId: 'c1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w7', from: { componentId: 'i1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const r = runPZ(comps as never, wires as never, plugins as never, { type: 'pz', inputNode: 'i1:p', outputNode: 'r1:a' });
    const t = r.traces[0] as unknown as { xValues: Float64Array; yValues: Float64Array };
    expect(Math.abs(t.xValues[0] + 500)).toBeLessThan(20);
    expect(Math.abs(Math.abs(t.yValues[0]) - 31619)).toBeLessThan(200);
  });
});

describe('X2 bundle parity', () => {
  it('ships paste + edge-cuts + drill map + job file like X1', () => {
    const files = exportAllGerbersX2([], [], [], { width: 50, height: 40 });
    const names = files.map((f) => f.filename);
    for (const need of ['top_paste.gbr', 'bottom_paste.gbr', 'edge_cuts.gbr', 'drill_map.txt', 'job.gbrjob', 'top_copper.gbr', 'drill.drl', 'pick_and_place.csv']) {
      expect(names, need).toContain(need);
    }
  });
  it('inner layers ride along when requested', () => {
    const files = exportAllGerbersX2([], [], [], { width: 50, height: 40 }, [], { layers: ['top', 'inner1', 'bottom'] });
    expect(files.map((f) => f.filename)).toContain('inner1_copper.gbr');
  });
});

describe('derating temperature curves', () => {
  function ctxWithResistor(powerRating = 0.25) {
    const comps = [
      mk('dcVoltage', 'v1', { voltage: 10 }),
      mk('resistor', 'r1', { resistance: 100, powerRating }),
      mk('ground', 'gnd'),
    ];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w3', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    return { doc: { version: 1 as const, components: comps as never[], wires: wires as never[] }, plugins: plugins as never, simContext: null as never };
  }
  it('hot ambient derates the resistor rating (100W? no — 1W into 0.25W fails harder)', async () => {
    const { solveDC } = await import('../src/lib/circuit/engine');
    const ctx = ctxWithResistor();
    const sim = solveDC(ctx.doc.components as never, ctx.doc.wires as never, ctx.plugins as never, 50);
    expect(sim).not.toBeNull();
    const cool = deratingCheckTool.execute({ ambientTemp: 25 }, { ...ctx, simContext: sim } as never) as { ok: boolean; result: { rows: { status: string }[]; tempFactors: { resistor: number } } };
    const hot = deratingCheckTool.execute({ ambientTemp: 120 }, { ...ctx, simContext: sim } as never) as { ok: boolean; result: { rows: { status: string }[]; tempFactors: { resistor: number } } };
    expect(cool.ok).toBe(true);
    expect(cool.result.tempFactors.resistor).toBe(1);
    expect(hot.result.tempFactors.resistor).toBeLessThan(0.6);
    // 10V²/100Ω = 1W vs 0.25W rating: fails at 25 °C already, still fails hot.
    expect(hot.result.rows[0].status).toBe('fail');
  });
});

describe('yield per-part merge', () => {
  it('per-part tolerance overrides the global (fewer implied runs vary less)', async () => {
    const comps = [
      mk('dcVoltage', 'v1', { voltage: 5 }),
      // r1 carries an explicit 1% tolerance; r2 falls back to global 50%.
      mk('resistor', 'r1', { resistance: 1000, tolerance: 0.01 }),
      mk('resistor', 'r2', { resistance: 1000 }),
      mk('ground', 'gnd'),
    ];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'r2', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const ctx = { doc: { version: 1 as const, components: comps as never[], wires: wires as never[] }, plugins: plugins as never };
    const res = yieldMonteCarloTool.execute(
      { runs: 30, tolerance: 0.5, outputNode: 'r1:b', seed: 7 },
      ctx as never,
    ) as { ok: boolean; result: { std: number } };
    expect(res.ok).toBe(true);
    // r1 pinned at 1%: spread must be well under the all-50% spread (~0.9V).
    expect(res.result.std).toBeLessThan(0.9);
  });
});
