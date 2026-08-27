// Tests for the generalized multi-unit IC families: 7402 (quad NOR), 7404
// (hex inverter), following the 7400 quad-NAND sample pattern.

import { describe, it, expect, beforeAll } from 'vitest';
import '../src/lib/circuit/components';
import { getPlugin } from '../src/lib/circuit/registry';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { runFullERC } from '../src/lib/circuit/erc';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

function mkComp(type: string, id: string, params: Record<string, any> = {}, extra: Record<string, any> = {}): CircuitComponent {
  const p = getPlugin(type);
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    rotation: 0,
    parameters: { ...(p?.parameters.reduce((a, q) => ({ ...a, [q.key]: q.default }), {}) || {}), ...params },
    ...extra,
  } as CircuitComponent;
}

function mkWire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

describe('multi-unit 7402 (quad NOR)', () => {
  it('registers all four units with correct terminals and unit metadata', () => {
    for (const unit of ['A', 'B', 'C', 'D']) {
      const p = getPlugin(`7402_${unit}`);
      expect(p, `7402_${unit}`).toBeDefined();
      expect(p!.units).toEqual(['A', 'B', 'C', 'D']);
      expect(p!.terminals.map(t => t.id).sort()).toEqual(['gnd', 'in1', 'in2', 'out', 'vcc'].sort());
      expect(p!.category).toBe('logic');
    }
    // Real 7402 pin numbers on unit A: 1A=2, 1B=3, 1Y=1
    const a = getPlugin('7402_A')!;
    expect(a.terminals.find(t => t.id === 'in1')!.number).toBe('2');
    expect(a.terminals.find(t => t.id === 'in2')!.number).toBe('3');
    expect(a.terminals.find(t => t.id === 'out')!.number).toBe('1');
  });

  it('implements the NOR truth table (DC-verified)', () => {
    const truth: Array<[number, number, number]> = [
      [0, 0, 5], [0, 5, 0], [5, 0, 0], [5, 5, 0],
    ];
    for (const [v1, v2, expected] of truth) {
      const comps: CircuitComponent[] = [];
      const wires: Wire[] = [];
      const gnd = mkComp('ground', 'gnd');
      comps.push(gnd, mkComp('dcVoltage', 'v1', { voltage: v1 }), mkComp('dcVoltage', 'v2', { voltage: v2 }), mkComp('7402_A', 'u1'), mkComp('resistor', 'rprobe', { resistance: 1e6 }));
      wires.push(mkWire('w1', 'v1', 'p', 'u1', 'in1'));
      wires.push(mkWire('w2', 'v2', 'p', 'u1', 'in2'));
      wires.push(mkWire('w3', 'v1', 'n', 'gnd', 'g'));
      wires.push(mkWire('w4', 'v2', 'n', 'gnd', 'g'));
      wires.push(mkWire('w5', 'u1', 'out', 'rprobe', 'a'));
      wires.push(mkWire('w6', 'rprobe', 'b', 'gnd', 'g'));
      const plugins = new Map([['ground', getPlugin('ground')!], ['dcVoltage', getPlugin('dcVoltage')!], ['resistor', getPlugin('resistor')!], ['7402_A', getPlugin('7402_A')!]]);
      const sim = solveDC(comps, wires, plugins as any);
      expect(sim, `NOR(${v1},${v2}) solve`).not.toBeNull();
      const nm = buildNodeMap(comps, wires, plugins as any);
      const outNode = nm.terminalNode.get('u1:out')!;
      expect(sim!.nodeVoltage[outNode]).toBeCloseTo(expected, 6);
    }
  });

  it('two units of the same chip behave independently', () => {
    const comps: CircuitComponent[] = [];
    const wires: Wire[] = [];
    const gnd = mkComp('ground', 'gnd');
    comps.push(gnd,
      mkComp('dcVoltage', 'va', { voltage: 0 }),
      mkComp('dcVoltage', 'vb', { voltage: 5 }),
      mkComp('7402_A', 'uA'),
      mkComp('7402_B', 'uB'));
    comps.push(mkComp('resistor', 'rpA', { resistance: 1e6 }), mkComp('resistor', 'rpB', { resistance: 1e6 }));
    wires.push(
      mkWire('w1', 'va', 'p', 'uA', 'in1'), mkWire('w2', 'va', 'p', 'uA', 'in2'),
      mkWire('w3', 'vb', 'p', 'uB', 'in1'), mkWire('w4', 'va', 'p', 'uB', 'in2'),
      mkWire('w5', 'va', 'n', 'gnd', 'g'), mkWire('w6', 'vb', 'n', 'gnd', 'g'),
      mkWire('w7', 'uA', 'out', 'rpA', 'a'), mkWire('w8', 'rpA', 'b', 'gnd', 'g'),
      mkWire('w9', 'uB', 'out', 'rpB', 'a'), mkWire('w10', 'rpB', 'b', 'gnd', 'g'));
    const plugins = new Map<any, any>([
      ['ground', getPlugin('ground')], ['dcVoltage', getPlugin('dcVoltage')], ['resistor', getPlugin('resistor')],
      ['7402_A', getPlugin('7402_A')], ['7402_B', getPlugin('7402_B')],
    ]);
    const sim = solveDC(comps, wires, plugins as any);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(comps, wires, plugins as any);
    // A: (0,0) → 5V ; B: (5,0) → 0V
    expect(sim!.nodeVoltage[nm.terminalNode.get('uA:out')!]).toBeCloseTo(5, 6);
    expect(sim!.nodeVoltage[nm.terminalNode.get('uB:out')!]).toBeCloseTo(0, 6);
  });
});

describe('multi-unit 7404 (hex inverter)', () => {
  it('registers all six units', () => {
    for (const unit of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const p = getPlugin(`7404_${unit}`);
      expect(p, `7404_${unit}`).toBeDefined();
      expect(p!.units).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      expect(p!.terminals.map(t => t.id).sort()).toEqual(['gnd', 'in1', 'out', 'vcc'].sort());
    }
    // Real pin numbers on unit A: 1A=1, 1Y=2
    const a = getPlugin('7404_A')!;
    expect(a.terminals.find(t => t.id === 'in1')!.number).toBe('1');
    expect(a.terminals.find(t => t.id === 'out')!.number).toBe('2');
  });

  it('implements the NOT truth table (DC-verified)', () => {
    for (const [vin, expected] of [[0, 5], [5, 0]] as Array<[number, number]>) {
      const comps: CircuitComponent[] = [];
      const wires: Wire[] = [];
      const gnd = mkComp('ground', 'gnd');
      comps.push(gnd, mkComp('dcVoltage', 'v1', { voltage: vin }), mkComp('7404_A', 'u1'), mkComp('resistor', 'rprobe', { resistance: 1e6 }));
      wires.push(mkWire('w1', 'v1', 'p', 'u1', 'in1'));
      wires.push(mkWire('w2', 'v1', 'n', 'gnd', 'g'));
      wires.push(mkWire('w3', 'u1', 'out', 'rprobe', 'a'));
      wires.push(mkWire('w4', 'rprobe', 'b', 'gnd', 'g'));
      const plugins = new Map<any, any>([['ground', getPlugin('ground')], ['dcVoltage', getPlugin('dcVoltage')], ['resistor', getPlugin('resistor')], ['7404_A', getPlugin('7404_A')]]);
      const sim = solveDC(comps, wires, plugins as any);
      expect(sim, `NOT(${vin}) solve`).not.toBeNull();
      const nm = buildNodeMap(comps, wires, plugins as any);
      expect(sim!.nodeVoltage[nm.terminalNode.get('u1:out')!]).toBeCloseTo(expected, 6);
    }
  });

  it('unwired outputs do not create singular rows', () => {
    const comps: CircuitComponent[] = [mkComp('ground', 'gnd'), mkComp('7404_A', 'u1')];
    const wires: Wire[] = [];
    const plugins = new Map<any, any>([['ground', getPlugin('ground')], ['7404_A', getPlugin('7404_A')]]);
    const sim = solveDC(comps, wires, plugins as any);
    expect(sim).not.toBeNull(); // solves without the singular-row failure
  });
});

describe('multi-unit ERC integration', () => {
  it('flags a partially-placed 7402 family via refdes/unit grouping', () => {
    const comps: CircuitComponent[] = [
      mkComp('ground', 'gnd'),
      mkComp('7402_A', 'u1', {}, { refdes: 'U1', unit: 1 }),
      // units B, C, D of U1 are missing
    ];
    const wires: Wire[] = [];
    const plugins = new Map<any, any>([['ground', getPlugin('ground')], ['7402_A', getPlugin('7402_A')]]);
    const result = runFullERC(comps, wires);
    const unused = (result.errors as any[]).filter(e => e.type === 'unused_unit');
    expect(unused.length).toBeGreaterThanOrEqual(1);
    expect(unused[0].message).toMatch(/missing units: B, C, D/);
  });

  it('a fully-placed 7404 family produces no unused-unit warning', () => {
    const comps: CircuitComponent[] = [mkComp('ground', 'gnd')];
    const units = ['A', 'B', 'C', 'D', 'E', 'F'];
    units.forEach((u, i) => comps.push(mkComp(`7404_${u}`, `u${u}`, {}, { refdes: 'U2', unit: i + 1 })));
    const plugins = new Map<any, any>([['ground', getPlugin('ground')], ...units.map(u => [`7404_${u}`, getPlugin(`7404_${u}`)])]);
    const result = runFullERC(comps, [] as Wire[]);
    const unused = (result.errors as any[]).filter(e => e.type === 'unused_unit');
    expect(unused).toHaveLength(0);
  });
});
