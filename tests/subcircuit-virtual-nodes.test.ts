// Regression tests for sub-circuit virtual internal nodes.
//
// Historical bug: subcircuit.ts used the raw `sys.addExtra()` MATRIX row
// index as the node id for internal-only nodes, but every stamp helper takes
// 1-based node ids (row = id − 1). The stamps landed on the last real node's
// row and the allocated extra row stayed empty → singular matrix →
// solveDC() returned null for ANY sub-circuit with an internal node.
//
// The companion bug: step() re-derived internal node ids with a DIFFERENT
// numbering (union-find ids starting at 1), so reactive internal components
// (capacitors/inductors) read the wrong node voltages during transient.
//
// Test topology: pin OUT on the FAR terminal of the internal divider/RC so
// the mid node stays internal-only (virtual, backed by an extra row) while
// every parent-visible pin remains wired to a real, readable parent node.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, registerPlugin } from '../src/lib/circuit/registry';
import { solveDC, simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { createSubCircuitPlugin, type SubCircuitDefinition } from '../src/lib/circuit/subcircuit';
import type { CircuitComponent, CircuitDocument, ComponentPlugin, Wire } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/sources');
});

function comp(t: string, id: string, p?: Record<string, unknown>): CircuitComponent {
  const pl = getPlugin(t);
  const d: Record<string, unknown> = {};
  if (pl) for (const pm of pl.parameters) d[pm.key] = pm.default;
  return {
    id,
    type: t,
    position: { x: 0, y: 0 },
    rotation: 0,
    parameters: { ...d, ...p },
    simState: {},
  };
}

function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}

/**
 * Internal: R1 (IN→M) in series with R2 (M→OUT). Pins: in→R1.a, out→R2.b,
 * gnd→GND. The mid node M (R1.b—R2.a) is internal-only → virtual node.
 */
function dividerDef(type = 'scDiv'): SubCircuitDefinition {
  return {
    type,
    name: 'Divider',
    description: 'test divider sub-circuit',
    pins: [
      { id: 'in', label: 'IN', position: { x: 0, y: 1 } },
      { id: 'out', label: 'OUT', position: { x: 4, y: 1 } },
      { id: 'gnd', label: 'GND', position: { x: 2, y: 3 } },
    ],
    document: {
      version: 1,
      components: [
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('resistor', 'R2', { resistance: 1000 }),
        comp('ground', 'GND'),
      ],
      wires: [wire('iw1', 'R1', 'b', 'R2', 'a')],
    } as CircuitDocument,
    pinMap: [
      { pinId: 'in', componentId: 'R1', terminalId: 'a' },
      { pinId: 'out', componentId: 'R2', terminalId: 'b' },
      { pinId: 'gnd', componentId: 'GND', terminalId: 'g' },
    ],
    boundingBox: { width: 4, height: 4 },
  };
}

/**
 * Internal: R (IN→M) + C (M→OUT). The capacitor's 'a' terminal sits on the
 * VIRTUAL mid node — its step() must read the virtual node voltage through
 * the sim view or the transient solution turns into NaN.
 */
function rcDef(type = 'scRC'): SubCircuitDefinition {
  return {
    type,
    name: 'RC',
    description: 'test rc sub-circuit',
    pins: [
      { id: 'in', label: 'IN', position: { x: 0, y: 1 } },
      { id: 'out', label: 'OUT', position: { x: 4, y: 1 } },
      { id: 'gnd', label: 'GND', position: { x: 2, y: 3 } },
    ],
    document: {
      version: 1,
      components: [
        comp('resistor', 'R', { resistance: 1000 }),
        comp('capacitor', 'C', { capacitance: 1e-6 }),
        comp('ground', 'GND'),
      ],
      wires: [wire('iw1', 'R', 'b', 'C', 'a')],
    } as CircuitDocument,
    pinMap: [
      { pinId: 'in', componentId: 'R', terminalId: 'a' },
      { pinId: 'out', componentId: 'C', terminalId: 'b' },
      { pinId: 'gnd', componentId: 'GND', terminalId: 'g' },
    ],
    boundingBox: { width: 4, height: 4 },
  };
}

function pluginsWith(...defs: SubCircuitDefinition[]): Map<string, ComponentPlugin> {
  const map = new Map<string, ComponentPlugin>();
  for (const d of defs) {
    const plugin = createSubCircuitPlugin(d);
    registerPlugin(plugin);
    map.set(d.type, plugin);
  }
  for (const t of ['dcVoltage', 'resistor', 'ground', 'capacitor']) {
    const p = getPlugin(t);
    if (p) map.set(t, p);
  }
  return map;
}

describe('sub-circuit virtual internal nodes', () => {
  it('DC: divider with an internal virtual node solves (was singular → null)', () => {
    const p = pluginsWith(dividerDef());
    // OUT loaded by 1k to ground: V(out) = 5 · 1k/(1k+1k+1k) = 5/3 V.
    const c = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('scDiv', 'U1'),
      comp('resistor', 'RLOAD', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const w = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'U1', 'gnd'),
      wire('w4', 'U1', 'out', 'RLOAD', 'a'),
      wire('w5', 'RLOAD', 'b', 'GND', 'g'),
    ];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, p);
    expect(dc!.nodeVoltage[nm.terminalNode.get('U1:out')!]).toBeCloseTo(5 / 3, 3);
  });

  it('DC: unwired OUT pin (pin itself becomes a virtual node) still solves', () => {
    const p = pluginsWith(dividerDef());
    const c = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('scDiv', 'U1'),
      comp('ground', 'GND'),
    ];
    const w = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'U1', 'gnd'),
      // OUT intentionally left unconnected — in+mid+out are all virtual.
    ];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
  });

  it('DC: two independent instances of the same sub-circuit both solve', () => {
    const p = pluginsWith(dividerDef());
    // Chain: V1(9) → U1 (2k) → U2 (2k) → RLOAD (1k) → GND  → 5k total.
    // V(U1.out) = 9·3/5 = 5.4 V, V(U2.out) = 9·1/5 = 1.8 V.
    const c = [
      comp('dcVoltage', 'V1', { voltage: 9 }),
      comp('scDiv', 'U1'),
      comp('scDiv', 'U2'),
      comp('resistor', 'RLOAD', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const w = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'U1', 'gnd'),
      wire('w4', 'U1', 'out', 'U2', 'in'),
      wire('w5', 'GND', 'g', 'U2', 'gnd'),
      wire('w6', 'U2', 'out', 'RLOAD', 'a'),
      wire('w7', 'RLOAD', 'b', 'GND', 'g'),
    ];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, p);
    expect(dc!.nodeVoltage[nm.terminalNode.get('U1:out')!]).toBeCloseTo(5.4, 3);
    expect(dc!.nodeVoltage[nm.terminalNode.get('U2:out')!]).toBeCloseTo(1.8, 3);
  });

  it('transient: RC sub-circuit charges through its virtual mid node', () => {
    const p = pluginsWith(rcDef());
    // V1(5) → U1.in; U1.out → 1MΩ → GND. τ = R·C = 1 ms (load ≫ R, so the
    // 1M leak only shifts the target by ~0.1%).
    const c = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('scRC', 'U1'),
      comp('resistor', 'RLOAD', { resistance: 1e6 }),
      comp('ground', 'GND'),
    ];
    const w = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'U1', 'gnd'),
      wire('w4', 'U1', 'out', 'RLOAD', 'a'),
      wire('w5', 'RLOAD', 'b', 'GND', 'g'),
    ];
    const tau = 1000 * 1e-6; // 1 ms
    const dt = tau / 50;
    const steps = 150; // 3τ → theory: 1−e^−3 ≈ 95% of target

    const nm = buildNodeMap(c, w, p);
    const outNode = nm.terminalNode.get('U1:out')!;
    let prev: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: Record<string, unknown> } | undefined;
    let outV = 0;
    for (let i = 0; i < steps; i++) {
      const r = simulateStep(c, w, p, prev, dt);
      expect(r).not.toBeNull();
      outV = r!.sim.nodeVoltage[outNode];
      // A mismatched step() node numbering (the old bug) poisons the state
      // with NaN within a couple of steps.
      expect(Number.isFinite(outV)).toBe(true);
      prev = {
        nodeVoltage: r!.sim.nodeVoltage,
        branchCurrent: r!.sim.branchCurrent,
        time: r!.sim.time,
        state: r!.sim.state,
      };
    }
    // Target ≈ 5·1M/(1k+1M) ≈ 4.995 V; after 3τ expect ≥ 90% charged.
    expect(outV).toBeGreaterThan(0.9 * 4.99);
    expect(outV).toBeLessThan(5.001);
  });

  it('extraVars: sub-circuit plugin declares its internal virtual node count', () => {
    const plugin = createSubCircuitPlugin(dividerDef());
    expect(plugin.extraVars).toBeDefined();
    // divider internal doc: mid node (+ unwired-pin upper bound) > 0
    const n = plugin.extraVars!({});
    expect(n).toBeGreaterThan(0);
  });
});
