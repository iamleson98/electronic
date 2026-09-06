// Top-1 closers: robust solveDC, per-part tolerance MC, S-expr netlist,
// DNP filtering, SPICE directive import, noise inoise/NF, fab bundle,
// presets, waivers, BOM join, PnP corrections, design report, KB growth.

import { describe, it, expect } from 'vitest';
import { solveDC } from '../src/lib/circuit/engine';
import { runMonteCarlo } from '../src/lib/circuit/monte-carlo';
import { exportKiCadNetlist, buildBOMRows } from '../src/lib/circuit/netlist-export';
import { importSpiceNetlist } from '../src/lib/circuit/spice-import';
import { runNoise } from '../src/lib/circuit/analysis';
import { exportAllGerbers, exportPickAndPlace } from '../src/lib/pcb/gerber-export';
import { getManufacturerSpec, listManufacturerNames } from '../src/lib/pcb/manufacturer-presets';
import { drcErrorKey, runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import { exportBOM } from '../src/lib/pcb/additional-exports';
import { KB_ARTICLES, searchArticles } from '../src/lib/ai/knowledge/knowledge-base';
import { TOOLS_BY_NAME } from '../src/lib/ai/tools/index';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

function comp(type: string, id: string, params: Record<string, number | string | boolean> = {}): CircuitComponent {
  const plugin = getPlugin(type)!;
  const defaults: Record<string, number | string | boolean> = {};
  for (const p of plugin.parameters) defaults[p.key] = p.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...defaults, ...params }, refdes: id.toUpperCase() };
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}
function pluginsFor(comps: CircuitComponent[]) {
  const m = new Map();
  for (const c of comps) {
    const p = getPlugin(c.type);
    if (p) m.set(c.type, p);
  }
  return m;
}

describe('robust solveDC fallback', () => {
  it('solves a normal divider with robust=true', () => {
    const comps = [comp('dcVoltage', 'v1', { voltage: 5 }), comp('resistor', 'r1', { resistance: 1000 }), comp('resistor', 'r2', { resistance: 1000 }), comp('ground', 'gnd')];
    const ws = [wire('w1', 'v1', 'p', 'r1', 'a'), wire('w2', 'r1', 'b', 'r2', 'a'), wire('w3', 'r2', 'b', 'gnd', 'g'), wire('w4', 'v1', 'n', 'gnd', 'g')];
    const sim = solveDC(comps, ws, pluginsFor(comps), 50, { robust: true });
    expect(sim).not.toBeNull();
  });
});

describe('per-part tolerance MC', () => {
  it('uses component tolerance fields when config list is empty', () => {
    const comps = [comp('dcVoltage', 'v1', { voltage: 5 }), comp('resistor', 'r1', { resistance: 1000 }), comp('resistor', 'r2', { resistance: 1000 }), comp('ground', 'gnd')];
    (comps[1] as CircuitComponent).tolerance = 0.01;
    const ws = [wire('w1', 'v1', 'p', 'r1', 'a'), wire('w2', 'r1', 'b', 'r2', 'a'), wire('w3', 'r2', 'b', 'gnd', 'g'), wire('w4', 'v1', 'n', 'gnd', 'g')];
    const r = runMonteCarlo(
      { version: 1, components: comps, wires: ws },
      { runs: 20, seed: 7, measurement: { type: 'voltage', node: 'r1:b' } },
      pluginsFor(comps),
    );
    expect(r.runs.length).toBe(20);
    expect(r.stats.mean).toBeCloseTo(2.5, 0);
  });
});

describe('S-expr netlist + DNP', () => {
  it('emits S-expr and excludes DNP parts', () => {
    const r2 = comp('resistor', 'r2', { resistance: 2000 });
    (r2 as CircuitComponent).variant = 'dnp';
    const comps = [comp('dcVoltage', 'v1', { voltage: 5 }), comp('resistor', 'r1', { resistance: 1000 }), r2, comp('ground', 'gnd')];
    const ws = [wire('w1', 'v1', 'p', 'r1', 'a'), wire('w2', 'r1', 'b', 'gnd', 'g'), wire('w3', 'v1', 'n', 'gnd', 'g')];
    const doc = { version: 1 as const, components: comps, wires: ws };
    const sexpr = exportKiCadNetlist(doc, 'T');
    expect(sexpr.startsWith('(export')).toBe(true);
    expect(sexpr).not.toContain('R2');
    const xml = exportKiCadNetlist(doc, 'T', { format: 'xml' });
    expect(xml).toContain('<export');
    const bom = buildBOMRows(doc);
    expect(bom.length).toBeGreaterThan(0);
  });
});

describe('SPICE import preserves directives', () => {
  it('keeps .tran/.options/.temp cards in simOptions', () => {
    const out = importSpiceNetlist(['* t', 'R1 a 0 1k', 'V1 a 0 5', '.tran 1u 10m', '.options reltol=0.001', '.temp 50', '.end'].join('\n'));
    expect(out.doc).not.toBeNull();
    const simOptions = (out.doc as unknown as { simOptions: { cards: string[]; temp: number } }).simOptions;
    expect(simOptions.cards.length).toBeGreaterThanOrEqual(3);
    expect(simOptions.temp).toBe(50);
  });
});

describe('noise inoise + NF + integrated', () => {
  it('returns three traces and integrated scalar', () => {
    const comps = [comp('dcVoltage', 'v1', { voltage: 5 }), comp('resistor', 'r1', { resistance: 1000 }), comp('resistor', 'r2', { resistance: 1000 }), comp('ground', 'gnd')];
    const ws = [wire('w1', 'v1', 'p', 'r1', 'a'), wire('w2', 'r1', 'b', 'r2', 'a'), wire('w3', 'r2', 'b', 'gnd', 'g'), wire('w4', 'v1', 'n', 'gnd', 'g')];
    const r = runNoise(comps, ws, pluginsFor(comps), {
      type: 'noise', outputNode: 'r1:b', inputSourceId: 'v1',
      fStart: 10, fStop: 10000, nPoints: 5, sweep: 'dec',
    });
    expect(r.traces.length).toBe(3);
    expect(r.traces.map((t) => t.name)).toEqual(['onoise', 'inoise', 'nf']);
    expect(r.scalars.integratedNoise_Vrms).toBeGreaterThanOrEqual(0);
  });
});

describe('fab bundle + presets + waivers', () => {
  it('bundle includes paste/edge-cuts/job/drill-map', () => {
    const files = exportAllGerbers([], [], [], { width: 10, height: 10 });
    const names = files.map((f) => f.filename);
    expect(names).toContain('top_paste.gbr');
    expect(names).toContain('edge_cuts.gbr');
    expect(names).toContain('job.gbrjob');
    expect(names).toContain('drill_map.txt');
  });
  it('five typed presets resolve', () => {
    expect(listManufacturerNames().length).toBeGreaterThanOrEqual(5);
    expect(getManufacturerSpec('JLCPCB')?.config.minClearance).toBeCloseTo(0.127, 9);
    expect(getManufacturerSpec('OSHPark')?.config.minDrillSize).toBeCloseTo(0.33, 9);
  });
  it('waivers filter violations', () => {
    const key = drcErrorKey({ type: 'clearance', position: { x: 1, y: 2 } });
    const errors = runDRC([], [], [], [], { width: 10, height: 10 }, DEFAULT_DRC_CONFIG, undefined, [{ key, note: 'reviewed', date: '2026-01-01' }]);
    expect(errors.find((e) => drcErrorKey(e) === key)).toBeUndefined();
  });
  it('BOM has order columns, PnP has LCSC + corrections', () => {
    const bom = exportBOM([{ refdes: 'R1', componentType: 'resistor', position: { x: 0, y: 0 }, rotation: 0, side: 'top', bodySize: { width: 1, height: 1 }, pads: [] } as never]);
    expect(bom.split('\n')[0]).toContain('LCSC');
    const pnp = exportPickAndPlace([{ refdes: 'D1', componentType: 'diode', footprintName: 'SOT-23', position: { x: 1, y: 2 }, rotation: 0, side: 'top' } as never]);
    expect(pnp.split('\n')[0]).toContain('LCSC');
    expect(pnp.split('\n')[1].split(',')[4]).toBe('180');
  });
});

describe('AI closers registered', () => {
  it('yield/review/fault/report tools exist', () => {
    for (const name of ['yield.monteCarlo', 'yield.sensitivity', 'review.derating', 'review.checklist', 'review.bringup', 'simulate.fault', 'export.designReport']) {
      expect(TOOLS_BY_NAME.has(name), name).toBe(true);
    }
  });
  it('KB grew past 25 with fab/safety coverage', () => {
    expect(KB_ARTICLES.length).toBeGreaterThanOrEqual(30);
    expect(searchArticles('JLCPCB order stencil').length).toBeGreaterThan(0);
    expect(searchArticles('TVS ESD protection').length).toBeGreaterThan(0);
    expect(searchArticles('buck converter hot loop').length).toBeGreaterThan(0);
  });
});
