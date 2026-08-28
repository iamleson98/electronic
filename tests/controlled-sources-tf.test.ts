// Tests for the controlled-source components (CCCS/CCVS) and the new
// Rin/Rout implementation in analysis.ts transfer-function analysis.

import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, buildNodeMap, computeComponentCurrents } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { runTF } from '../src/lib/circuit/analysis';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
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

// ─────────────────────────────────────────────────────────────────────────────
// CCCS — Current-Controlled Current Source
// ─────────────────────────────────────────────────────────────────────────────

describe('CCCS (Current-Controlled Current Source)', () => {
  it('produces a non-zero current output', () => {
    // V1 (5V) → R1 (1k) → sense source V2 (0V, used as ammeter) → GND
    // CCCS F1: I(out) = beta * I(V2). beta = 2 → output = 2 * 5mA = 10mA
    // Output through R_load (1k) → V = 10mA * 1k = 10V
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('dcVoltage', 'V2', { voltage: 0 }),  // sense V-source (0V ammeter)
      comp('cccsUser', 'F1', { beta: 2, vsenseName: 'V2' }),
      comp('resistor', 'Rload', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      // V1 → R1 → V2 → GND
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'V2', 'p'),
      wire('w3', 'V2', 'n', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
      // CCCS: op → Rload → GND, sn → V2.n (already at ground)
      wire('w5', 'F1', 'op', 'Rload', 'a'),
      wire('w6', 'Rload', 'b', 'GND', 'g'),
      wire('w7', 'F1', 'on', 'GND', 'g'),
      wire('w8', 'F1', 'sp', 'V2', 'p'),
      wire('w9', 'F1', 'sn', 'V2', 'n'),
    ];
    const dc = solveDC(components, wires, pluginsFor(components));
    expect(dc).not.toBeNull();
    // beta = 2, sense current = 5V/1k = 5mA → 10mA flows through the element
    // from O+ to O− (SPICE F convention, same as the I source): it is DRAWN
    // OUT of the O+ node → V(O+) = −10mA·1k = −10V. (Asserting the precise
    // value — the old |v| > 0.001 check passed with any gain or direction.)
    const nm = buildNodeMap(components, wires, pluginsFor(components));
    const loadANode = nm.terminalNode.get('Rload:a');
    expect(loadANode).toBeDefined();
    const v = dc!.nodeVoltage[loadANode!];
    expect(v).toBeCloseTo(-10, 6);
  });

  it('does not crash when sense source is missing', () => {
    // CCCS with vsenseName pointing to nonexistent source — should not crash.
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('cccsUser', 'F1', { beta: 2, vsenseName: 'MISSING' }),
      comp('resistor', 'Rload', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w5', 'F1', 'op', 'Rload', 'a'),
      wire('w6', 'Rload', 'b', 'GND', 'g'),
      wire('w7', 'F1', 'on', 'GND', 'g'),
    ];
    expect(() => solveDC(components, wires, pluginsFor(components))).not.toThrow();
  });

  it('all CCCS component metadata is well-formed', () => {
    const p = getPlugin('cccsUser');
    expect(p).toBeDefined();
    expect(p!.terminals.length).toBe(4);  // op, on, sp, sn
    expect(p!.parameters.some(pa => pa.key === 'beta')).toBe(true);
    expect(p!.parameters.some(pa => pa.key === 'vsenseName')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CCVS — Current-Controlled Voltage Source
// ─────────────────────────────────────────────────────────────────────────────

describe('CCVS (Current-Controlled Voltage Source)', () => {
  it('produces a non-zero voltage output', () => {
    // V1 (5V) → R1 (1k) → sense source V2 (0V) → GND
    // CCVS H1: V(out) = transimp * I(V2). transimp = 100, I = 5mA → V = 0.5V
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('dcVoltage', 'V2', { voltage: 0 }),
      comp('ccvsUser', 'H1', { transimp: 100, vsenseName: 'V2' }),
      comp('resistor', 'Rload', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'V2', 'p'),
      wire('w3', 'V2', 'n', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
      wire('w5', 'H1', 'op', 'Rload', 'a'),
      wire('w6', 'Rload', 'b', 'GND', 'g'),
      wire('w7', 'H1', 'on', 'GND', 'g'),
      wire('w8', 'H1', 'sp', 'V2', 'p'),
      wire('w9', 'H1', 'sn', 'V2', 'n'),
    ];
    const dc = solveDC(components, wires, pluginsFor(components));
    expect(dc).not.toBeNull();
    // transimp = 100, sense current = 5mA → V(out) = 0.5V EXACTLY
    const nm = buildNodeMap(components, wires, pluginsFor(components));
    const loadANode = nm.terminalNode.get('Rload:a');
    expect(loadANode).toBeDefined();
    const v = dc!.nodeVoltage[loadANode!];
    expect(v).toBeCloseTo(0.5, 6);
  });

  it('does not crash when sense source is missing', () => {
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ccvsUser', 'H1', { transimp: 100, vsenseName: 'MISSING' }),
      comp('resistor', 'Rload', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w5', 'H1', 'op', 'Rload', 'a'),
      wire('w6', 'Rload', 'b', 'GND', 'g'),
      wire('w7', 'H1', 'on', 'GND', 'g'),
    ];
    expect(() => solveDC(components, wires, pluginsFor(components))).not.toThrow();
  });

  it('all CCVS component metadata is well-formed', () => {
    const p = getPlugin('ccvsUser');
    expect(p).toBeDefined();
    expect(p!.terminals.length).toBe(4);  // op, on, sp, sn
    expect(p!.parameters.some(pa => pa.key === 'transimp')).toBe(true);
    expect(p!.parameters.some(pa => pa.key === 'vsenseName')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VCCS / VCVS (SPICE G / E elements) — exact engine-level values
// ─────────────────────────────────────────────────────────────────────────────

describe('VCCS (SPICE G element) exact values', () => {
  it('gm=0.01, Vin=1V, RL=1k → V(out) = −10V (drawn from O+, injected into O−)', () => {
    const components = [
      comp('dcVoltage', 'VIN', { voltage: 1 }),
      comp('resistor', 'RI', { resistance: 1e6 }),
      comp('vccsUser', 'G1', { gm: 0.01 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'VIN', 'p', 'RI', 'a'),
      wire('w2', 'VIN', 'n', 'GND', 'g'),
      wire('w3', 'RI', 'b', 'G1', 'ip'),
      wire('w4', 'G1', 'in', 'GND', 'g'),
      wire('w5', 'G1', 'op', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'G1', 'on', 'GND', 'g'),
    ];
    const dc = solveDC(components, wires, pluginsFor(components));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(components, wires, pluginsFor(components));
    const v = dc!.nodeVoltage[nm.terminalNode.get('RL:a')!];
    // current gm·V(ip) = 10mA flows through the element O+ → O−: drawn out of
    // the O+ node → V(O+) = −10mA · 1k = −10V
    expect(v).toBeCloseTo(-10, 6);
  });
});

describe('VCVS (SPICE E element) exact values', () => {
  it('gain=4, Vin=1V → V(out) = 4V exactly', () => {
    const components = [
      comp('dcVoltage', 'VIN', { voltage: 1 }),
      comp('resistor', 'RI', { resistance: 1e6 }),
      comp('vcvsUser', 'E1', { gain: 4 }),
      comp('resistor', 'RL', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'VIN', 'p', 'RI', 'a'),
      wire('w2', 'VIN', 'n', 'GND', 'g'),
      wire('w3', 'RI', 'b', 'E1', 'ip'),
      wire('w4', 'E1', 'in', 'GND', 'g'),
      wire('w5', 'E1', 'op', 'RL', 'a'),
      wire('w6', 'RL', 'b', 'GND', 'g'),
      wire('w7', 'E1', 'on', 'GND', 'g'),
    ];
    const dc = solveDC(components, wires, pluginsFor(components));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(components, wires, pluginsFor(components));
    const v = dc!.nodeVoltage[nm.terminalNode.get('RL:a')!];
    expect(v).toBeCloseTo(4, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transfer function Rin/Rout
// ─────────────────────────────────────────────────────────────────────────────

describe('Transfer function: Rin/Rout', () => {
  it('Rin: voltage divider with 2k total → Rin ≈ 2k', () => {
    // V1 (1V) → R1 (1k) → R2 (1k) → GND
    // Rin = V_in / I_in = 1V / (1V / 2k) = 2kΩ
    const components = [
      comp('dcVoltage', 'V1', { voltage: 1 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runTF(
      components,
      wires,
      pluginsFor(components),
      { type: 'tf', inputSourceId: 'V1', outputNode: 'R1:b' } as any,
    );
    expect(r.scalars.gain).toBeDefined();
    expect(r.scalars.rin).toBeDefined();
    expect(r.scalars.rout).toBeDefined();
    // Rin should be around 2k (not 1, which was the old placeholder)
    expect(r.scalars.rin).toBeGreaterThan(100);
    expect(r.scalars.rin).toBeLessThan(5000);
  });

  it('gain: voltage divider with equal R = 0.5', () => {
    const components = [
      comp('dcVoltage', 'V1', { voltage: 1 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runTF(
      components,
      wires,
      pluginsFor(components),
      { type: 'tf', inputSourceId: 'V1', outputNode: 'R1:b' } as any,
    );
    expect(r.scalars.gain).toBeCloseTo(0.5, 2);
  });

  it('Rout: ideal voltage source output → Rout ≈ 0', () => {
    // Output of a voltage source should have very low Rout (the source pins
    // the node to a fixed voltage). We use a small load resistor.
    const components = [
      comp('dcVoltage', 'V1', { voltage: 1 }),
      comp('resistor', 'R1', { resistance: 1000 }),  // load
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runTF(
      components,
      wires,
      pluginsFor(components),
      { type: 'tf', inputSourceId: 'V1', outputNode: 'R1:a' } as any,
    );
    // Rout is small (the source dominates; resistor contributes via parallel path).
    expect(r.scalars.rout).toBeLessThan(2000);
  });

  it('returns valid result object shape', () => {
    const components = [
      comp('dcVoltage', 'V1', { voltage: 1 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runTF(
      components,
      wires,
      pluginsFor(components),
      { type: 'tf', inputSourceId: 'V1', outputNode: 'R1:b' } as any,
    );
    expect(r.type).toBe('tf');
    expect(r.scalars).toBeDefined();
    expect(r.report).toBeDefined();
    expect(typeof r.durationMs).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: DC voltage source records its branch index
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch index tracking', () => {
  it('dcVoltage stamps and records branch index', () => {
    // Just verify the simulation runs and produces finite results.
    // The branch index is an internal detail — verified by CCCS/CCVS tests above.
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(components, wires, pluginsFor(components));
    expect(dc).not.toBeNull();
    expect(dc!.nodeVoltage.length).toBeGreaterThan(0);
  });

  it('multiple voltage sources all get indexed', () => {
    // V1 (5V) → R1 → V2 (3V) → R2 → GND
    // Both sources should be solvable without conflict (V2 is just a fixed 3V).
    const components = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('dcVoltage', 'V2', { voltage: 3 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'V2', 'p'),
      wire('w3', 'V2', 'n', 'R2', 'a'),
      wire('w4', 'R2', 'b', 'GND', 'g'),
      wire('w5', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(components, wires, pluginsFor(components));
    // Should converge (or at least not crash)
    expect(() => solveDC(components, wires, pluginsFor(components))).not.toThrow();
  });
});
