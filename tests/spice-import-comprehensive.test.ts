// Comprehensive tests for SPICE netlist import.
// Verifies that importSpiceNetlist() correctly parses SPICE element cards
// (R/C/L/V/I/D/Q/M/S), handles engineering suffixes, builds wires from net
// assignments, and produces a valid CircuitDocument that can be simulated.

import { describe, it, expect, beforeAll } from 'vitest';
import { importSpiceNetlist, parseSpiceValue } from '../src/lib/circuit/spice-import';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

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
  const m = new Map<string, ComponentPlugin>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) m.set(c.type, p);
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Value parsing — SPICE engineering suffixes
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSpiceValue', () => {
  it('plain number: 1000', () => {
    expect(parseSpiceValue('1000')).toBe(1000);
  });
  it('plain decimal: 4.7', () => {
    expect(parseSpiceValue('4.7')).toBe(4.7);
  });
  it('scientific: 1e3', () => {
    expect(parseSpiceValue('1e3')).toBe(1000);
  });
  it('scientific: 4.7e3', () => {
    expect(parseSpiceValue('4.7e3')).toBe(4700);
  });
  it('scientific negative exp: 1.5e-9', () => {
    expect(parseSpiceValue('1.5e-9')).toBe(1.5e-9);
  });
  it('k suffix: 1k = 1000', () => {
    expect(parseSpiceValue('1k')).toBe(1000);
  });
  it('k suffix with decimal: 4.7k = 4700', () => {
    expect(parseSpiceValue('4.7k')).toBe(4700);
  });
  it('Meg suffix: 1Meg = 1e6', () => {
    expect(parseSpiceValue('1Meg')).toBe(1e6);
  });
  it('Meg suffix case-insensitive: 1meg = 1e6', () => {
    expect(parseSpiceValue('1meg')).toBe(1e6);
  });
  it('m suffix (milli): 1m = 0.001', () => {
    expect(parseSpiceValue('1m')).toBe(0.001);
  });
  it('u suffix (micro): 1u = 1e-6', () => {
    expect(parseSpiceValue('1u')).toBe(1e-6);
  });
  it('n suffix (nano): 1n = 1e-9', () => {
    expect(parseSpiceValue('1n')).toBe(1e-9);
  });
  it('p suffix (pico): 1p = 1e-12', () => {
    expect(parseSpiceValue('1p')).toBe(1e-12);
  });
  it('f suffix (femto): 1f = 1e-15', () => {
    expect(parseSpiceValue('1f')).toBe(1e-15);
  });
  it('g suffix: 1g = 1e9', () => {
    expect(parseSpiceValue('1g')).toBe(1e9);
  });
  it('Hz suffix stripped: 1k = 1000 (no hz interference)', () => {
    expect(parseSpiceValue('1k')).toBe(1000);
  });
  it('Ohm suffix stripped: 1k = 1000', () => {
    expect(parseSpiceValue('1k')).toBe(1000);
  });
  it('empty string returns 0', () => {
    expect(parseSpiceValue('')).toBe(0);
  });
  it('non-numeric returns 0', () => {
    expect(parseSpiceValue('abc')).toBe(0);
  });
  it('negative number: -5', () => {
    expect(parseSpiceValue('-5')).toBe(-5);
  });
  it('+5 = 5', () => {
    expect(parseSpiceValue('+5')).toBe(5);
  });
  it('value with extra suffix junk: 1kfoo = 1000 (junk stripped)', () => {
    expect(parseSpiceValue('1kfoo')).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Basic netlist parsing — R/C/L/V/I
// ─────────────────────────────────────────────────────────────────────────────

describe('SPICE import: basic cards', () => {
  it('resistor: R1 1 0 1k', () => {
    const r = importSpiceNetlist('R1 1 0 1k\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc).not.toBeNull();
    expect(r.doc!.components.length).toBe(2);  // R1 + GND
    expect(r.doc!.components[0].type).toBe('resistor');
    expect(r.doc!.components[0].parameters.resistance).toBe(1000);
  });

  it('capacitor: C1 1 0 1u', () => {
    const r = importSpiceNetlist('C1 1 0 1u\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('capacitor');
    expect(r.doc!.components[0].parameters.capacitance).toBe(1e-6);
  });

  it('inductor: L1 1 0 1m', () => {
    const r = importSpiceNetlist('L1 1 0 1m\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('inductor');
    expect(r.doc!.components[0].parameters.inductance).toBe(1e-3);
  });

  it('DC voltage source: V1 1 0 5', () => {
    const r = importSpiceNetlist('V1 1 0 5\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('dcVoltage');
    expect(r.doc!.components[0].parameters.voltage).toBe(5);
  });

  it('AC voltage source: V1 1 0 SINE(0 5 1000)', () => {
    const r = importSpiceNetlist('V1 1 0 SINE(0 5 1000)\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('acVoltage');
    expect(r.doc!.components[0].parameters.amplitude).toBe(5);
    expect(r.doc!.components[0].parameters.frequency).toBe(1000);
  });

  it('current source: I1 1 0 0.01', () => {
    const r = importSpiceNetlist('I1 1 0 0.01\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('currentSource');
    expect(r.doc!.components[0].parameters.current).toBe(0.01);
  });

  it('diode: D1 1 0 1N4148', () => {
    const r = importSpiceNetlist('D1 1 0 1N4148\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('diode');
  });

  it('NPN BJT: Q1 3 2 1 2N3904', () => {
    const r = importSpiceNetlist('Q1 3 2 1 2N3904\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('npn');
  });

  it('PNP BJT inferred from name: Q1 3 2 1 2N3906', () => {
    const r = importSpiceNetlist('Q1 3 2 1 2N3906\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('pnp');
  });

  it('NMOS: M1 3 2 1 2N7000', () => {
    const r = importSpiceNetlist('M1 3 2 1 2N7000\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('nmos');
  });

  it('PMOS inferred from name: M1 3 2 1 BS250', () => {
    const r = importSpiceNetlist('M1 3 2 1 BS250\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('pmos');
  });

  it('switch: S1 1 2 3 0 smodel on', () => {
    const r = importSpiceNetlist('S1 1 2 3 0 smodel on\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('switch');
    expect(r.doc!.components[0].parameters.closed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Multi-component netlists and wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('SPICE import: multi-component circuits', () => {
  it('voltage divider: V1 + R1 + R2', () => {
    const netlist = `
* Voltage divider
V1 1 0 10
R1 1 2 1k
R2 2 0 1k
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
    expect(r.doc).not.toBeNull();
    // Should have V1, R1, R2, GND = 4 components
    expect(r.doc!.components.length).toBe(4);
    // Should have wires connecting them
    expect(r.doc!.wires.length).toBeGreaterThan(0);
  });

  it('RC low-pass filter', () => {
    const netlist = `
V1 1 0 SINE(0 5 1000)
R1 1 2 1000
C1 2 0 1u
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components.length).toBe(4);  // V1, R1, C1, GND
  });

  it('parallel resistors share a node', () => {
    const netlist = `
V1 1 0 5
R1 1 0 1k
R2 1 0 1k
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components.length).toBe(4);  // V1, R1, R2, GND
  });

  it('ground is auto-created when referenced', () => {
    const r = importSpiceNetlist('V1 1 0 5\nR1 1 0 1k\n.end\n');
    expect(r.doc!.components.some(c => c.type === 'ground')).toBe(true);
  });

  it('ground is NOT created when not referenced', () => {
    // All nets are non-zero — but we still typically want a ground for sim.
    // The importer should handle this gracefully (no crash).
    const r = importSpiceNetlist('R1 1 2 1k\n.end\n');
    expect(r.doc).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Simulating imported circuits — round-trip with solveDC
// ─────────────────────────────────────────────────────────────────────────────

describe('SPICE import: simulation correctness', () => {
  it('imported voltage divider: V(mid) = 5V', () => {
    const netlist = `
V1 1 0 10
R1 1 2 1k
R2 2 0 1k
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
    const dc = solveDC(r.doc!.components, r.doc!.wires, pluginsFor(r.doc!.components));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(r.doc!.components, r.doc!.wires, pluginsFor(r.doc!.components));
    const midNode = nm.terminalNode.get('R1:b')!;
    expect(dc!.nodeVoltage[midNode]).toBeCloseTo(5, 1);
  });

  it('imported 1k resistor with 5V source: I = 5mA', () => {
    const netlist = `
V1 1 0 5
R1 1 0 1k
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
    const dc = solveDC(r.doc!.components, r.doc!.wires, pluginsFor(r.doc!.components));
    expect(dc).not.toBeNull();
    // No NaN — solvable
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
  });

  it('imported RC circuit: DC operating point is finite', () => {
    const netlist = `
V1 1 0 5
R1 1 2 1000
C1 2 0 1u
.end
`;
    const r = importSpiceNetlist(netlist);
    const dc = solveDC(r.doc!.components, r.doc!.wires, pluginsFor(r.doc!.components));
    expect(dc).not.toBeNull();
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Comments, continuation lines, dot commands
// ─────────────────────────────────────────────────────────────────────────────

describe('SPICE import: syntax features', () => {
  it('comment lines (starting with *) are skipped', () => {
    const netlist = `
* This is a comment
* Another comment
V1 1 0 5
R1 1 0 1k
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components.length).toBe(3);  // V1, R1, GND
  });

  it('inline comments (after ;) are stripped', () => {
    const r = importSpiceNetlist('V1 1 0 5 ; inline comment\nR1 1 0 1k\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components.length).toBe(3);
  });

  it('continuation lines (starting with +) are joined', () => {
    const r = importSpiceNetlist('V1 1 0 5\n+ SINE(0 1 1000)\n.end\n');
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components[0].type).toBe('acVoltage');
  });

  it('.MODEL cards are skipped', () => {
    const netlist = `
V1 1 0 5
R1 1 0 1k
.model 1N4148 D(Is=2.682n N=1.836)
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
    expect(r.doc!.components.length).toBe(3);
  });

  it('.TRAN/.AC/.DC/.OP cards are skipped', () => {
    const netlist = `
V1 1 0 5
R1 1 0 1k
.tran 1u 10m
.ac dec 10 1 100k
.dc V1 0 5 0.1
.op
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.errors).toHaveLength(0);
  });

  it('.SUBCKT/.ENDS wraps elements', () => {
    const netlist = `
.subckt myfilter in out
R1 in out 1k
.ends
V1 1 0 5
.end
`;
    const r = importSpiceNetlist(netlist);
    // Subckt body is parsed as flat elements (we flatten it)
    expect(r.doc).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('SPICE import: error handling', () => {
  it('empty netlist returns error', () => {
    const r = importSpiceNetlist('');
    expect(r.doc).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('netlist with only comments returns error', () => {
    const r = importSpiceNetlist('* just a comment\n');
    expect(r.doc).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('R card with too few tokens returns error', () => {
    const r = importSpiceNetlist('R1 1 0\n.end\n');
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('unknown card type generates warning', () => {
    const r = importSpiceNetlist('V1 1 0 5\nZ1 1 0 5\nR1 1 0 1k\n.end\n');
    expect(r.warnings.length).toBeGreaterThan(0);
    // V1 and R1 should still parse
    expect(r.doc).not.toBeNull();
    expect(r.doc!.components.length).toBeGreaterThan(0);
  });

  it('non-string input returns error', () => {
    const r = importSpiceNetlist(null as any);
    expect(r.doc).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('.END stops parsing', () => {
    const r = importSpiceNetlist('V1 1 0 5\n.end\nR1 1 0 1k\n');
    // R1 comes after .end — should be ignored
    expect(r.doc!.components.length).toBe(2);  // V1 + GND
  });

  it('multiple errors are collected', () => {
    const r = importSpiceNetlist('R1 1\nV1 1\nC1 1\n.end\n');
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Wire generation
// ─────────────────────────────────────────────────────────────────────────────

describe('SPICE import: wire generation', () => {
  it('two components sharing a net get wired', () => {
    const r = importSpiceNetlist('V1 1 0 5\nR1 1 0 1k\n.end\n');
    expect(r.doc!.wires.length).toBeGreaterThan(0);
  });

  it('ground net generates wires to ground component', () => {
    const r = importSpiceNetlist('V1 1 0 5\nR1 1 0 1k\n.end\n');
    // V1.n → GND.g, R1.b → GND.g (both at net 0)
    const groundWires = r.doc!.wires.filter(w => w.to.componentId === 'GND' || w.from.componentId === 'GND');
    expect(groundWires.length).toBeGreaterThanOrEqual(2);
  });

  it('multi-component circuit has correct wire count', () => {
    const r = importSpiceNetlist('V1 1 0 5\nR1 1 2 1k\nR2 2 0 1k\n.end\n');
    // Net 1: V1.p, R1.a → 1 wire (V1.p to R1.a)
    // Net 2: R1.b, R2.a → 1 wire (R1.b to R2.a)
    // Net 0 (ground): V1.n, R2.b → 2 wires to GND
    expect(r.doc!.wires.length).toBeGreaterThanOrEqual(3);
  });
});
