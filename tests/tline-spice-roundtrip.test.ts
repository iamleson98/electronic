// Transmission-line SPICE round-trip tests (T / O cards, LTRA models).
//
// exportSPICENetlist emits:
//   - lossless lines as `T<name> a1 a2 b1 b2 Z0=<z> TD=<t>`
//   - lossy lines as `O<name> a1 a2 b1 b2 <model>` + `.model <model> LTRA(...)`
// importSpiceNetlist parses both back (incl. forward-referenced .model cards,
// the ZO= spelling variant, and the F= normalized-frequency form warning).
// The round-tripped circuits must simulate with the SAME physics as the
// originals: delay, reflection coefficients, and DC resistance.

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { exportSPICENetlist } from '../src/lib/circuit/netlist-export';
import { importSpiceNetlist } from '../src/lib/circuit/spice-import';
import type { CircuitComponent, Wire, CircuitDocument, ComponentPlugin } from '../src/lib/circuit/types';

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

/** Run N steps at dt; return per-step node voltages for `probe` (comp:term). */
function runTrace(doc: { components: CircuitComponent[]; wires: Wire[] }, steps: number, dt: number, probe: string): number[] {
  const p = plugins();
  let prev: any;
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, p, prev, dt);
    if (!r) break;
    out.push(r.sim.nodeVoltage[r.nodeMap.terminalNode.get(probe) ?? 0] ?? 0);
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return out;
}

// A matched 5 V / Rs=50 / Z0=50 / Td line / RL=50 circuit — the canonical
// pulse-delay testbench. Td = 500 µs, dt = 100 µs (5 steps of delay).
function losslessDoc(): CircuitDocument {
  const comps = [
    comp('dcVoltage', 'V1', { voltage: 5 }),
    comp('resistor', 'Rs', { resistance: 50 }),
    comp('transLineLossless', 'T1', { Z0: 50, Td: 5e-4 }),
    comp('resistor', 'RL', { resistance: 50 }),
    comp('ground', 'GND'),
  ];
  const wires = [
    wire('w1', 'V1', 'p', 'Rs', 'a'),
    wire('w2', 'Rs', 'b', 'T1', 'a1'),
    wire('w3', 'V1', 'n', 'GND', 'g'),
    wire('w4', 'GND', 'g', 'T1', 'a2'),
    wire('w5', 'T1', 'b1', 'RL', 'a'),
    wire('w6', 'RL', 'b', 'GND', 'g'),
    wire('w7', 'T1', 'b2', 'GND', 'g'),
  ];
  return { version: 1, components: comps, wires };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

describe('T-line SPICE export', () => {
  it('lossless line exports as a T card with Z0=/TD= and the 4 port nodes', () => {
    const net = exportSPICENetlist(losslessDoc());
    const tline = net.split('\n').find((l) => /^TT1\s/.test(l));
    expect(tline).toBeDefined();
    // node order: a1 a2 b1 b2, then params
    expect(tline!).toMatch(/^TT1\s+\S+\s+\S+\s+\S+\s+\S+\s+Z0=/);
    expect(tline!).toContain('Z0=');
    expect(tline!).toContain('TD=');
    // must not fall back to the generic X subckt call
    expect(net.split('\n').some((l) => /^X/.test(l) && !l.startsWith('XGND'))).toBe(false);
  });

  it('lossy line exports as an O card + .model LTRA with all 5 RLGC params', () => {
    const doc = losslessDoc();
    doc.components[2] = comp('transLineLossy', 'TL1', {
      RperLen: 0.2, LperLen: 250e-9, GperLen: 1e-9, CperLen: 100e-12, length: 2, segments: 8,
    });
    doc.wires.forEach((w) => {
      if (w.from.componentId === 'T1') w.from.componentId = 'TL1';
      if (w.to.componentId === 'T1') w.to.componentId = 'TL1';
    });
    const net = exportSPICENetlist(doc);
    const ocard = net.split('\n').find((l) => /^OTL1\s/.test(l));
    expect(ocard).toBeDefined();
    expect(ocard!.split(/\s+/).length).toBe(6); // OTL1 + 4 nodes + model name
    const model = net.split('\n').find((l) => l.startsWith('.model LTRA_TL1'));
    expect(model).toBeDefined();
    expect(model!).toContain('LTRA(');
    expect(model!).toContain('R=');
    expect(model!).toContain('L=');
    expect(model!).toContain('G=');
    expect(model!).toContain('C=');
    expect(model!).toContain('LEN=');
  });

  it('two lossy lines with distinct params get distinct LTRA models', () => {
    const doc = losslessDoc();
    doc.components.push(comp('transLineLossy', 'TL2', { RperLen: 5, LperLen: 1e-6, GperLen: 0, CperLen: 1e-10, length: 1 }));
    doc.wires.push(
      wire('w8', 'TL2', 'a1', 'Rs', 'b'),
      wire('w9', 'TL2', 'a2', 'GND', 'g'),
      wire('w10', 'TL2', 'b1', 'RL', 'a'),
      wire('w11', 'TL2', 'b2', 'GND', 'g'),
    );
    doc.components[2] = comp('transLineLossy', 'TL1', { RperLen: 0.2, LperLen: 250e-9, length: 2 });
    doc.wires.forEach((w) => {
      if (w.from.componentId === 'T1') w.from.componentId = 'TL1';
      if (w.to.componentId === 'T1') w.to.componentId = 'TL1';
    });
    const net = exportSPICENetlist(doc);
    const models = net.split('\n').filter((l) => l.startsWith('.model LTRA_'));
    expect(models.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────────────────────

describe('T-line SPICE import', () => {
  it('parses a T card (Z0=/TD=) into transLineLossless with correct params', () => {
    const res = importSpiceNetlist([
      'T-line delay test',
      'V1 in 0 5',
      'Rs in a 50',
      'T1 a 0 b 0 Z0=75 TD=2u',
      'RL b 0 75',
      '.tran 1u 20u',
      '.end',
    ].join('\n'));
    expect(res.errors).toEqual([]);
    expect(res.doc).not.toBeNull();
    const t = res.doc!.components.find((c) => c.type === 'transLineLossless');
    expect(t).toBeDefined();
    expect(t!.parameters.Z0).toBeCloseTo(75, 6);
    expect(t!.parameters.Td).toBeCloseTo(2e-6, 12);
  });

  it('accepts the ZO= spelling variant (LTspice style)', () => {
    const res = importSpiceNetlist([
      'T-line',
      'T1 a 0 b 0 ZO=50 TD=1n',
      '.end',
    ].join('\n'));
    expect(res.errors).toEqual([]);
    const t = res.doc!.components.find((c) => c.type === 'transLineLossless');
    expect(t).toBeDefined();
    expect(t!.parameters.Z0).toBeCloseTo(50, 6);
  });

  it('warns (not errors) when TD= is missing or the F= form is used', () => {
    const res = importSpiceNetlist([
      'T-line',
      'T1 a 0 b 0 Z0=50',
      'T2 c 0 d 0 Z0=50 F=100MEG NL=0.5',
      '.end',
    ].join('\n'));
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.includes('TD'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('F=/NL='))).toBe(true);
    const lines = res.doc!.components.filter((c) => c.type === 'transLineLossless');
    expect(lines.length).toBe(2);
  });

  it('parses an O card referencing a FORWARD-declared LTRA .model', () => {
    // .model appears AFTER the O card — SPICE allows forward refs.
    const res = importSpiceNetlist([
      'Lossy line',
      'V1 in 0 5',
      'Rs in a 1',
      'O1 a 0 b 0 LOSSY1',
      'RL b 0 10',
      '.model LOSSY1 LTRA(R=2 L=1u G=0 C=100p LEN=1)',
      '.end',
    ].join('\n'));
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    const tl = res.doc!.components.find((c) => c.type === 'transLineLossy');
    expect(tl).toBeDefined();
    expect(tl!.parameters.RperLen).toBeCloseTo(2, 9);
    expect(tl!.parameters.LperLen).toBeCloseTo(1e-6, 15);
    expect(tl!.parameters.GperLen).toBeCloseTo(0, 15);
    expect(tl!.parameters.CperLen).toBeCloseTo(100e-12, 21);
    expect(tl!.parameters.length).toBeCloseTo(1, 9);
  });

  it('warns when the O card model is not a defined LTRA model', () => {
    const res = importSpiceNetlist([
      'Lossy line',
      'O1 a 0 b 0 NOSUCHMODEL',
      '.end',
    ].join('\n'));
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.includes('NOSUCHMODEL'))).toBe(true);
    // component still imported with defaults
    expect(res.doc!.components.some((c) => c.type === 'transLineLossy')).toBe(true);
  });

  it('lowercases net names consistently between cards (b 0 vs B 0)', () => {
    const res = importSpiceNetlist([
      'T-line',
      'V1 in 0 5',
      'T1 in 0 B 0 Z0=50 TD=1n',
      'RL b 0 50',
      '.end',
    ].join('\n'));
    expect(res.errors).toEqual([]);
    // 'B' and 'b' must map to the SAME net so the load actually terminates the line
    const nm = simulateStep(res.doc!.components, res.doc!.wires, plugins(), undefined, 1e-9);
    expect(nm).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip: export → import → simulate must match the original physics
// ─────────────────────────────────────────────────────────────────────────────

describe('T-line SPICE round-trip physics', () => {
  it('lossless: round-trip preserves delay + matched termination behavior', () => {
    const original = losslessDoc();
    const net = exportSPICENetlist(original);
    const res = importSpiceNetlist(net);
    expect(res.errors).toEqual([]);

    const dt = 1e-4;
    const steps = 12;
    const a = runTrace(original, steps, dt, 'T1:b1');
    // export prepends the SPICE letter to the refdes: T1 -> TT1
    const b = runTrace(res.doc!, steps, dt, 'TT1:b1');
    expect(b.length).toBe(steps);
    // every step matches the original simulation closely (same engine, same
    // params — the only difference is node numbering)
    for (let i = 0; i < steps; i++) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
    }
    // and the physics is the matched-line delay: 0 before Td, 2.5 V after
    expect(b[2]).toBeCloseTo(0, 6);
    expect(b[7]).toBeCloseTo(2.5, 2);
    expect(b[11]).toBeCloseTo(2.5, 2);
  });

  it('lossless: round-trip preserves open-end doubling (Γ = +1)', () => {
    const doc = losslessDoc();
    // open the far end: 1 GΩ load instead of matched 50 Ω
    doc.components[3] = comp('resistor', 'RL', { resistance: 1e9 });
    const net = exportSPICENetlist(doc);
    const res = importSpiceNetlist(net);
    expect(res.errors).toEqual([]);
    const b = runTrace(res.doc!, 12, 1e-4, 'TT1:b1');
    // before Td: 0; just past Td the open end doubles the 2.5 V wave → 5 V
    expect(b[2]).toBeCloseTo(0, 6);
    expect(b[6]).toBeCloseTo(5, 2);
    expect(b[11]).toBeCloseTo(5, 2);
  });

  it('lossy: round-trip preserves the DC series resistance', () => {
    // 4 V source DIRECTLY on the line (no Rs): R = 10 Ω/m × 1 m line in
    // series with a 10 Ω load → steady state V(RL) = 4 × 10/(10+10) = 2 V.
    const doc: CircuitDocument = {
      version: 1,
      components: [
        comp('dcVoltage', 'V1', { voltage: 4 }),
        comp('transLineLossy', 'TL1', {
          RperLen: 10, LperLen: 1e-6, GperLen: 0, CperLen: 1e-9, length: 1, segments: 8,
        }),
        comp('resistor', 'RL', { resistance: 10 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'TL1', 'a1'),
        wire('w2', 'V1', 'n', 'GND', 'g'),
        wire('w3', 'GND', 'g', 'TL1', 'a2'),
        wire('w4', 'TL1', 'b1', 'RL', 'a'),
        wire('w5', 'RL', 'b', 'GND', 'g'),
        wire('w6', 'TL1', 'b2', 'GND', 'g'),
      ],
    };
    // direct: 4 V across 10 Ω (line) + 10 Ω (load) → 2 V
    const direct = runTrace(doc, 200, 1e-4, 'RL:a');
    expect(direct[199]).toBeCloseTo(2, 2);
    // round-trip: same answer (export emits OTL1 + .model LTRA_TL1)
    const net = exportSPICENetlist(doc);
    const res = importSpiceNetlist(net);
    expect(res.errors).toEqual([]);
    const tl = res.doc!.components.find((c) => c.type === 'transLineLossy');
    expect(tl).toBeDefined();
    expect(tl!.parameters.RperLen).toBeCloseTo(10, 6);
    expect(tl!.parameters.length).toBeCloseTo(1, 6);
    const rt = runTrace(res.doc!, 200, 1e-4, 'RRL:a');
    expect(rt.length).toBe(200);
    expect(rt[199]).toBeCloseTo(2, 2);
  });

  it('a mixed netlist (R + T + B) round-trips with all elements intact', () => {
    const doc = losslessDoc();
    doc.components.push(comp('bvSource', 'B1', { expr: '2*V(a)' }));
    doc.wires.push(
      wire('w8', 'B1', 'p', 'T1', 'a1'),
      wire('w9', 'B1', 'n', 'GND', 'g'),
    );
    const net = exportSPICENetlist(doc);
    const res = importSpiceNetlist(net);
    expect(res.errors).toEqual([]);
    expect(res.doc!.components.some((c) => c.type === 'transLineLossless')).toBe(true);
    expect(res.doc!.components.some((c) => c.type === 'resistor')).toBe(true);
    expect(res.doc!.components.some((c) => c.type === 'bvSource')).toBe(true);
    // and the imported circuit still simulates
    const r = simulateStep(res.doc!.components, res.doc!.wires, plugins(), undefined, 1e-4);
    expect(r).not.toBeNull();
  });

  it('a bare title line (no * prefix) is skipped per SPICE convention', () => {
    // Real SPICE netlists start with a title. One that begins with a T (like
    // "T-line delay test") must not be misparsed as a T element card.
    const res = importSpiceNetlist([
      'T-line delay test',
      'V1 in 0 5',
      'Rs in a 50',
      'T1 a 0 b 0 Z0=50 TD=1n',
      'RL b 0 50',
      '.end',
    ].join('\n'));
    expect(res.errors).toEqual([]);
    const lines = res.doc!.components.filter((c) => c.type === 'transLineLossless');
    expect(lines.length).toBe(1); // only T1, not the title
    expect(lines[0].id).toBe('T1');
  });
});
