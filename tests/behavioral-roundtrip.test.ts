// Behavioral-source SPICE round-trip tests (batch 8).
//
// bvSource/biSource export as ngspice B-elements (B1 n+ n- V=expr / I=expr)
// and the importer parses them back, auto-attaching netLabels for every
// V(netname) reference so the expression actually resolves in our engine.

import { describe, it, expect, beforeAll } from 'vitest';
import { exportSPICENetlist } from '../src/lib/circuit/netlist-export';
import { importSpiceNetlist } from '../src/lib/circuit/spice-import';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, CircuitDocument, Wire, ComponentPlugin } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(type: string, id: string, params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return {
    id, type,
    position: { x: 0, y: 0 },
    rotation: 0,
    parameters: { ...defaults, ...params },
  };
}

function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}

function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().filter(p => components.some(c => c.type === p.type)).map(p => [p.type, p]));
}

describe('behavioral source SPICE export', () => {
  it('exports bvSource as a B-element with V= expression', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [
        comp('ground', 'gnd'),
        comp('dcVoltage', 'v1', { voltage: 3 }),
        comp('netLabel', 'lIn', { net: 'in' }),
        comp('bvSource', 'b1', { expr: '2*V(in)' }),
        comp('resistor', 'r1', { resistance: 1000 }),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'lIn', 'p'),
        wire('w2', 'v1', 'n', 'gnd', 'g'),
        wire('w3', 'b1', 'p', 'r1', 'a'),
        wire('w4', 'r1', 'b', 'gnd', 'g'),
        wire('w5', 'b1', 'n', 'gnd', 'g'),
      ],
    };
    const netlist = exportSPICENetlist(doc, 'Behavioral');
    const bLine = netlist.split('\n').find(l => /^B/.test(l));
    expect(bLine).toBeDefined();
    expect(bLine!).toMatch(/^Bb1\s+\S+\s+\S+\s+V='2\*V\(in\)'/);
  });

  it('exports biSource as a B-element with I= expression', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [
        comp('ground', 'gnd'),
        comp('biSource', 'b1', { expr: '0.01*sin(2*pi*50*time)' }),
        comp('resistor', 'r1', { resistance: 100 }),
      ],
      wires: [
        wire('w1', 'b1', 'p', 'r1', 'a'),
        wire('w2', 'r1', 'b', 'gnd', 'g'),
        wire('w3', 'b1', 'n', 'gnd', 'g'),
      ],
    };
    const netlist = exportSPICENetlist(doc, 'Behavioral');
    const bLine = netlist.split('\n').find(l => /^B/.test(l));
    expect(bLine).toBeDefined();
    expect(bLine!).toContain("I='0.01*sin(2*pi*50*time)'");
  });
});

describe('behavioral source SPICE import', () => {
  it('parses a BV B-element and auto-attaches a netLabel for V(in)', () => {
    const netlist = [
      '* behavioral amp',
      'V1 in 0 3',
      'B1 out 0 V=2*V(in)',
      'R1 out 0 1k',
      '.end',
    ].join('\n');
    const res = importSpiceNetlist(netlist);
    expect(res.errors).toEqual([]);
    expect(res.doc).not.toBeNull();
    const bv = res.doc!.components.find(c => c.type === 'bvSource');
    expect(bv).toBeDefined();
    expect(bv!.parameters.expr).toBe('2*V(in)');
    // A netLabel named 'in' was auto-created so the expression resolves
    const label = res.doc!.components.find(c => c.type === 'netLabel');
    expect(label).toBeDefined();
    expect(label!.parameters.net).toBe('in');
  });

  it('the imported behavioral circuit SIMULATES: V(out) = 2·V(in) = 6V', () => {
    const netlist = [
      'V1 in 0 3',
      'B1 out 0 V=2*V(in)',
      'R1 out 0 1k',
      '.end',
    ].join('\n');
    const res = importSpiceNetlist(netlist);
    expect(res.doc).not.toBeNull();
    const plugins = pluginsFor(res.doc!.components);
    const r = simulateStep(res.doc!.components, res.doc!.wires, plugins);
    expect(r).not.toBeNull();
    const nm = buildNodeMap(res.doc!.components, res.doc!.wires, plugins);
    const outNode = nm.terminalNode.get('R1:a') ?? nm.netNames.get('OUT') ?? 1;
    // NOTE: net names from SPICE are case-preserved; find via the resistor
    const r1 = res.doc!.components.find(c => c.type === 'resistor')!;
    const outN = nm.terminalNode.get(`${r1.id}:a`) ?? outNode;
    expect(r!.sim.nodeVoltage[outN]).toBeCloseTo(6, 4);
  });

  it('parses a BI B-element with I= expression', () => {
    const netlist = [
      'V1 in 0 5',
      'R1 in 0 1k',
      'B1 out 0 I=2*I(V1)',
      'R2 out 0 1k',
      '.end',
    ].join('\n');
    const res = importSpiceNetlist(netlist);
    expect(res.errors).toEqual([]);
    const bi = res.doc!.components.find(c => c.type === 'biSource');
    expect(bi).toBeDefined();
    expect(bi!.parameters.expr).toBe('2*I(V1)');
    const plugins = pluginsFor(res.doc!.components);
    const r = simulateStep(res.doc!.components, res.doc!.wires, plugins);
    expect(r).not.toBeNull();
    const nm = buildNodeMap(res.doc!.components, res.doc!.wires, plugins);
    const r2 = res.doc!.components.filter(c => c.type === 'resistor')[1]!;
    const outNode = nm.terminalNode.get(`${r2.id}:a`)!;
    // I(V1) = −5mA (delivering) → B1 stamps −10mA → injects 10mA into out → 10V
    expect(r!.sim.nodeVoltage[outNode]).toBeCloseTo(10, 3);
  });

  it('warns when an expression references an unknown net', () => {
    const netlist = [
      'V1 in 0 3',
      'B1 out 0 V=2*V(nosuchnet)',
      'R1 out 0 1k',
      '.end',
    ].join('\n');
    const res = importSpiceNetlist(netlist);
    expect(res.warnings.some(w => w.includes('nosuchnet'))).toBe(true);
  });

  it('round-trips export → import preserving the expression', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [
        comp('ground', 'gnd'),
        comp('dcVoltage', 'v1', { voltage: 3 }),
        comp('netLabel', 'lIn', { net: 'in' }),
        comp('bvSource', 'b1', { expr: 'if(V(in) > 2, 5, 0)' }),
        comp('resistor', 'r1', { resistance: 1000 }),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'lIn', 'p'),
        wire('w2', 'v1', 'n', 'gnd', 'g'),
        wire('w3', 'b1', 'p', 'r1', 'a'),
        wire('w4', 'r1', 'b', 'gnd', 'g'),
        wire('w5', 'b1', 'n', 'gnd', 'g'),
      ],
    };
    const netlist = exportSPICENetlist(doc, 'RoundTrip');
    const res = importSpiceNetlist(netlist);
    expect(res.doc).not.toBeNull();
    const bv = res.doc!.components.find(c => c.type === 'bvSource');
    expect(bv).toBeDefined();
    expect(bv!.parameters.expr).toBe('if(V(in) > 2, 5, 0)');
    // and it still works: V(in) = 3 > 2 → out = 5V
    const plugins = pluginsFor(res.doc!.components);
    const r = simulateStep(res.doc!.components, res.doc!.wires, plugins);
    expect(r).not.toBeNull();
    const nm = buildNodeMap(res.doc!.components, res.doc!.wires, plugins);
    const r1 = res.doc!.components.find(c => c.type === 'resistor')!;
    const outNode = nm.terminalNode.get(`${r1.id}:a`)!;
    expect(r!.sim.nodeVoltage[outNode]).toBeCloseTo(5, 4);
  });
});
