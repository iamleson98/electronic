// Tests for the new simulation and PCB improvements:
//   - Integration adapter (trap/Gear2 wiring)
//   - Pseudo-transient convergence (gmin stepping)
//   - AC analysis with BJT and op-amp
//   - Per-net-class DRC rules
//   - Parametric footprint generator
//   - simulate.sweep tool

import { describe, it, expect } from 'vitest';
import { stampCapacitor, stampInductor, updateCapacitorState, updateInductorState } from '../src/lib/circuit/integration-adapter';
import { solveDCWithPseudoTran } from '../src/lib/circuit/convergence';
import { runAC } from '../src/lib/circuit/analysis';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import { generateSOIC, generateQFP, generateQFN, generateDIP, generateSOT23, generateChip, getParametricFootprint } from '../src/lib/pcb/parametric-footprints';
import { getFootprintDef } from '../src/lib/pcb/footprints';
import { createPCBFromSchematic } from '../src/lib/pcb/netlist-sync';
import '../src/lib/circuit/components';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, SimContext } from '../src/lib/circuit/types';
import type { NetClass } from '../src/lib/circuit/types';

function mkSim(numNodes = 5): SimContext {
  return {
    nodeVoltage: new Float64Array(numNodes),
    branchCurrent: new Float64Array(10),
    state: {},
    time: 0,
    dt: 1e-4,
  };
}

function mkMna(numNodes: number) {
  // Minimal MNA stub for testing stamp functions
  const size = numNodes + 10;
  const A = new Float64Array(size * size);
  const z = new Float64Array(size);
  return {
    numNodes,
    numExtra: 10,
    size,
    A,
    z,
    nextExtra: 0,
    addExtra: () => { const i = size; return i; },
    stampConductance: (n1: number, n2: number, g: number) => {
      if (n1 > 0) A[n1 * size + n1] += g;
      if (n2 > 0) A[n2 * size + n2] += g;
      if (n1 > 0 && n2 > 0) { A[n1 * size + n2] -= g; A[n2 * size + n1] -= g; }
    },
    stampCurrentSource: (n1: number, n2: number, i: number) => {
      if (n1 > 0) z[n1] += i;
      if (n2 > 0) z[n2] -= i;
    },
    stampVoltageSource: () => 0,
    stampVCCS: () => {},
    stampVCVS: () => 0,
    stampCCCS: () => {},
    stampCCVS: () => 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration Adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration Adapter', () => {
  it('stampCapacitor with backward Euler produces correct conductance', () => {
    const sim = mkSim(5);
    const sys = mkMna(5);
    stampCapacitor(1, 2, 1e-6, 1e-4, sys as any, sim, 'c1', 'euler', 0);
    // G = C/dt = 1e-6 / 1e-4 = 0.01 S
    expect(sys.A[1 * sys.size + 1]).toBeCloseTo(0.01, 6);
    expect(sys.A[2 * sys.size + 2]).toBeCloseTo(0.01, 6);
  });

  it('stampCapacitor with trap produces 2C/dt conductance', () => {
    const sim = mkSim(5);
    const sys = mkMna(5);
    stampCapacitor(1, 2, 1e-6, 1e-4, sys as any, sim, 'c1', 'trap', 0);
    // G = 2C/dt = 2e-6 / 1e-4 = 0.02 S
    expect(sys.A[1 * sys.size + 1]).toBeCloseTo(0.02, 6);
  });

  it('stampCapacitor with gear produces 3C/(2dt) conductance (Gear-2)', () => {
    const sim = mkSim(5);
    const sys = mkMna(5);
    stampCapacitor(1, 2, 1e-6, 1e-4, sys as any, sim, 'c1', 'gear', 0);
    // Gear-2: G = 3C/(2dt) = 3e-6 / (2e-4) = 0.015 S
    expect(sys.A[1 * sys.size + 1]).toBeCloseTo(0.015, 6);
  });

  it('stampInductor with backward Euler produces dt/L conductance', () => {
    const sim = mkSim(5);
    const sys = mkMna(5);
    stampInductor(1, 2, 1e-3, 1e-4, sys as any, sim, 'l1', 'euler', 0);
    // G = dt/L = 1e-4 / 1e-3 = 0.1 S
    expect(sys.A[1 * sys.size + 1]).toBeCloseTo(0.1, 6);
  });

  it('stampInductor with trap produces dt/(2L) conductance', () => {
    const sim = mkSim(5);
    const sys = mkMna(5);
    stampInductor(1, 2, 1e-3, 1e-4, sys as any, sim, 'l1', 'trap', 0);
    // G = dt/(2L) = 1e-4 / 2e-3 = 0.05 S
    expect(sys.A[1 * sys.size + 1]).toBeCloseTo(0.05, 6);
  });

  it('updateCapacitorState stores the current voltage', () => {
    const sim = mkSim(5);
    sim.nodeVoltage[1] = 5;
    sim.nodeVoltage[2] = 0;
    updateCapacitorState(1, 2, sim, 'c1', 'euler');
    const state = sim.state.__global['cap_c1'];
    expect(state.vPrev).toBe(5);
  });

  it('updateInductorState stores the current voltage', () => {
    const sim = mkSim(5);
    sim.nodeVoltage[1] = 5;
    sim.nodeVoltage[2] = 0;
    updateInductorState(1, 2, sim, 'l1', 'euler');
    const state = sim.state.__global['ind_l1'];
    expect(state.vPrev).toBe(5);
  });

  it('updateInductorState Gear-2 uses i_{n-2} BEFORE overwriting it (history-shift ordering)', () => {
    // Regression: the old code set state.iPrev2 = state.iPrev first and then
    // used state.iPrev2 in the formula — collapsing (4a − b)/3 to (4a − a)/3 = a
    // (Euler with a 2/3 coefficient) and losing the second-order history.
    const sim = mkSim(5);
    sim.dt = 1e-4;
    sim.nodeVoltage[1] = 2;  // vNow = 2 V across the inductor
    sim.nodeVoltage[2] = 0;
    sim.state.__global = { ind_lg: { vPrev: 1, iPrev: 0.5, iPrev2: 0.1 } };
    updateInductorState(1, 2, sim, 'lg', 'gear', 1e-3);
    const st = sim.state.__global['ind_lg'];
    const L = 1e-3, dt = 1e-4;
    const expected = (4 * 0.5 - 0.1) / 3 + ((2 * dt) / (3 * L)) * 2;
    expect(st.iPrev).toBeCloseTo(expected, 12);
    expect(st.iPrev2).toBeCloseTo(0.5, 12); // shifted to the old i_{n-1}
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pseudo-Transient Convergence (gmin stepping)
// ─────────────────────────────────────────────────────────────────────────────

describe('solveDCWithPseudoTran', () => {
  it('runs without crashing on a simple voltage divider', () => {
    const v1: CircuitComponent = {
      id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0,
      parameters: { voltage: 5 },
    };
    const r1: CircuitComponent = {
      id: 'r1', type: 'resistor', position: { x: 5, y: 0 }, rotation: 0,
      parameters: { resistance: 1000 },
    };
    const r2: CircuitComponent = {
      id: 'r2', type: 'resistor', position: { x: 10, y: 0 }, rotation: 0,
      parameters: { resistance: 1000 },
    };
    const gnd: CircuitComponent = {
      id: 'gnd1', type: 'ground', position: { x: 10, y: 5 }, rotation: 0,
      parameters: {},
    };
    const components = [v1, r1, r2, gnd];
    const wires: Wire[] = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'r2', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd1', terminalId: 'g' } },
      { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd1', terminalId: 'g' } },
    ];
    const plugins = new Map<string, any>();
    for (const c of components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    // Should run without throwing
    expect(() => solveDCWithPseudoTran(components, wires, plugins)).not.toThrow();
    const result = solveDCWithPseudoTran(components, wires, plugins);
    expect(result.report).toBeDefined();
    expect(result.report.attempts.length).toBeGreaterThan(0);
  });

  it('returns a report with attempts log', () => {
    const v1: CircuitComponent = {
      id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0,
      parameters: { voltage: 5 },
    };
    const r1: CircuitComponent = {
      id: 'r1', type: 'resistor', position: { x: 5, y: 0 }, rotation: 0,
      parameters: { resistance: 1000 },
    };
    const gnd: CircuitComponent = {
      id: 'gnd1', type: 'ground', position: { x: 5, y: 5 }, rotation: 0,
      parameters: {},
    };
    const components = [v1, r1, gnd];
    const wires: Wire[] = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'gnd1', terminalId: 'g' } },
      { id: 'w3', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd1', terminalId: 'g' } },
    ];
    const plugins = new Map<string, any>();
    for (const c of components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    const result = solveDCWithPseudoTran(components, wires, plugins);
    expect(result.report.attempts.length).toBeGreaterThan(0);
    expect(result.report.attempts[0]).toContain('pseudo-transient');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC Analysis with BJT and Op-amp
// ─────────────────────────────────────────────────────────────────────────────

describe('AC Analysis with semiconductor models', () => {
  it('does not crash on a circuit with a BJT', () => {
    // Simple common-emitter amplifier
    const v1: CircuitComponent = {
      id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0,
      parameters: { voltage: 12 },
    };
    const rc: CircuitComponent = {
      id: 'rc', type: 'resistor', position: { x: 5, y: 0 }, rotation: 0,
      parameters: { resistance: 4000 },
    };
    const q1: CircuitComponent = {
      id: 'q1', type: 'npn', position: { x: 10, y: 0 }, rotation: 0,
      parameters: { hfe: 100 },
    };
    const re: CircuitComponent = {
      id: 're', type: 'resistor', position: { x: 10, y: 5 }, rotation: 0,
      parameters: { resistance: 1000 },
    };
    const gnd: CircuitComponent = {
      id: 'gnd1', type: 'ground', position: { x: 10, y: 10 }, rotation: 0,
      parameters: {},
    };
    const components = [v1, rc, q1, re, gnd];
    const wires: Wire[] = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'rc', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'rc', terminalId: 'b' }, to: { componentId: 'q1', terminalId: 'c' } },
      { id: 'w3', from: { componentId: 'q1', terminalId: 'e' }, to: { componentId: 're', terminalId: 'a' } },
      { id: 'w4', from: { componentId: 're', terminalId: 'b' }, to: { componentId: 'gnd1', terminalId: 'g' } },
      { id: 'w5', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd1', terminalId: 'g' } },
    ];
    const plugins = new Map<string, any>();
    for (const c of components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    // Should not throw
    expect(() => {
      runAC(components, wires, plugins, {
        type: 'ac',
        sweep: 'decade',
        nPoints: 10,
        fStart: 10,
        fStop: 100000,
        sourceId: 'v1',
        acMag: 1,
      });
    }).not.toThrow();
  });

  it('does not crash on a circuit with an op-amp', () => {
    const v1: CircuitComponent = {
      id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0,
      parameters: { voltage: 5 },
    };
    const op1: CircuitComponent = {
      id: 'op1', type: 'opamp', position: { x: 10, y: 0 }, rotation: 0,
      parameters: {},
    };
    const r1: CircuitComponent = {
      id: 'r1', type: 'resistor', position: { x: 15, y: 5 }, rotation: 0,
      parameters: { resistance: 10000 },
    };
    const gnd: CircuitComponent = {
      id: 'gnd1', type: 'ground', position: { x: 5, y: 10 }, rotation: 0,
      parameters: {},
    };
    const components = [v1, op1, r1, gnd];
    const wires: Wire[] = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'op1', terminalId: 'in+' } },
      { id: 'w2', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd1', terminalId: 'g' } },
      { id: 'w3', from: { componentId: 'op1', terminalId: 'out' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w4', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'gnd1', terminalId: 'g' } },
    ];
    const plugins = new Map<string, any>();
    for (const c of components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    expect(() => {
      runAC(components, wires, plugins, {
        type: 'ac',
        sweep: 'decade',
        nPoints: 10,
        fStart: 10,
        fStop: 100000,
        sourceId: 'v1',
        acMag: 1,
      });
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-Net-Class DRC Rules
// ─────────────────────────────────────────────────────────────────────────────

describe('Per-Net-Class DRC', () => {
  it('runDRC accepts a netClasses parameter', () => {
    const errors = runDRC([], [], [], [], { width: 100, height: 100 }, DEFAULT_DRC_CONFIG, []);
    expect(errors).toBeDefined();
    expect(Array.isArray(errors)).toBe(true);
  });

  it('runDRC uses per-net trace width when a NetClass is defined', () => {
    // Create a trace with width 0.2mm, but the NetClass requires 0.5mm
    const traces = [{
      id: 't1',
      net: 'POWER',
      layer: 'top' as const,
      width: 0.2,  // too thin for POWER class
      segments: [{ start: { x: 10, y: 10 }, end: { x: 20, y: 10 } }],
    }];
    const ratsnest: any[] = [];
    const board = { width: 100, height: 100 };
    const netClasses: NetClass[] = [
      { id: 'nc1', name: 'Power', nets: ['POWER'], traceWidth: 0.5, clearance: 0.3 },
    ];
    const errors = runDRC([], traces, [], ratsnest, board, DEFAULT_DRC_CONFIG, netClasses);
    // Should flag the trace as too thin
    const widthError = errors.find(e => e.type === 'min_width');
    expect(widthError).toBeDefined();
    expect(widthError!.message).toContain('POWER');
    expect(widthError!.message).toContain('NetClass');
  });

  it('runDRC uses global minTraceWidth when no NetClass matches', () => {
    const traces = [{
      id: 't1',
      net: 'SIGNAL',
      layer: 'top' as const,
      width: 0.1,  // below default minTraceWidth of 0.15
      segments: [{ start: { x: 10, y: 10 }, end: { x: 20, y: 10 } }],
    }];
    const ratsnest: any[] = [];
    const board = { width: 100, height: 100 };
    const errors = runDRC([], traces, [], ratsnest, board, DEFAULT_DRC_CONFIG, undefined);
    const widthError = errors.find(e => e.type === 'min_width');
    expect(widthError).toBeDefined();
    // Should NOT mention NetClass
    expect(widthError!.message).not.toContain('NetClass');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parametric Footprint Generator
// ─────────────────────────────────────────────────────────────────────────────

describe('Parametric Footprint Generator', () => {
  it('generateSOIC-8 produces 8 pads', () => {
    const fp = generateSOIC(8);
    expect(fp.name).toBe('SOIC-8');
    expect(fp.pads.length).toBe(8);
  });

  it('generateSOIC-16 produces 16 pads', () => {
    const fp = generateSOIC(16);
    expect(fp.pads.length).toBe(16);
  });

  it('generateDIP-14 produces 14 THT pads with drill holes', () => {
    const fp = generateDIP(14);
    expect(fp.pads.length).toBe(14);
    for (const pad of fp.pads) {
      expect(pad.drill).toBeGreaterThan(0);
      expect(pad.shape).toBe('circle');
    }
  });

  it('generateQFP-32 produces 32 pads on 4 sides', () => {
    const fp = generateQFP(32);
    expect(fp.pads.length).toBe(32);
    // Check that pads are on all 4 sides (negative x, positive x, negative y, positive y)
    const hasLeft = fp.pads.some(p => p.position.x < 0);
    const hasRight = fp.pads.some(p => p.position.x > 0);
    const hasTop = fp.pads.some(p => p.position.y < 0);
    const hasBottom = fp.pads.some(p => p.position.y > 0);
    expect(hasLeft && hasRight && hasTop && hasBottom).toBe(true);
  });

  it('generateQFN-16 produces 16 pads + exposed pad', () => {
    const fp = generateQFN(16);
    // 16 signal pads + 1 exposed pad = 17
    expect(fp.pads.length).toBe(17);
    const ep = fp.pads.find(p => p.terminalId === 'ep');
    expect(ep).toBeDefined();
  });

  it('generateSOT23 produces 3 pads', () => {
    const fp = generateSOT23();
    expect(fp.pads.length).toBe(3);
  });

  it('generateChip 0805 produces 2 pads', () => {
    const fp = generateChip('0805');
    expect(fp.pads.length).toBe(2);
    expect(fp.name).toBe('0805');
  });

  it('getParametricFootprint matches SOIC-8', () => {
    const fp = getParametricFootprint('SOIC-8');
    expect(fp).not.toBeNull();
    expect(fp!.pads.length).toBe(8);
  });

  it('getParametricFootprint matches QFN-32', () => {
    const fp = getParametricFootprint('QFN-32');
    expect(fp).not.toBeNull();
    expect(fp!.pads.length).toBe(33); // 32 + exposed pad
  });

  it('getParametricFootprint matches DIP-28', () => {
    const fp = getParametricFootprint('DIP-28');
    expect(fp).not.toBeNull();
    expect(fp!.pads.length).toBe(28);
  });

  it('getParametricFootprint returns null for unknown package', () => {
    const fp = getParametricFootprint('BGA-999');
    expect(fp).toBeNull();
  });

  it('getParametricFootprint is case-insensitive', () => {
    const fp = getParametricFootprint('soic-8');
    expect(fp).not.toBeNull();
    expect(fp!.pads.length).toBe(8);
  });

  it('all generated footprints have valid bodySize', () => {
    const footprints = [generateSOIC(8), generateQFP(32), generateQFN(16), generateDIP(14), generateSOT23(), generateChip('0603')];
    for (const fp of footprints) {
      expect(fp.bodySize.width).toBeGreaterThan(0);
      expect(fp.bodySize.height).toBeGreaterThan(0);
    }
  });

  it('SOIC pads are at 1.27mm pitch', () => {
    const fp = generateSOIC(8);
    // Pads on the same side should be 1.27mm apart
    const leftPads = fp.pads.filter(p => p.position.x < 0).sort((a, b) => a.position.y - b.position.y);
    if (leftPads.length >= 2) {
      const pitch = Math.abs(leftPads[1].position.y - leftPads[0].position.y);
      expect(pitch).toBeCloseTo(1.27, 2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DRC cross-layer semantics + PCB store regression tests
// ─────────────────────────────────────────────────────────────────────────────

import type { Footprint, Pad } from '../src/lib/pcb/types';
import { usePCB } from '../src/lib/pcb/store';

function drcPad(id: string, x: number, y: number, net: string, layer: 'top' | 'bottom', drill = 0): Pad {
  return {
    id,
    componentId: `comp_${id}`,
    terminalId: 'a',
    position: { x, y },
    shape: drill > 0 ? 'circle' : 'rect',
    size: { width: 1.0, height: 1.0 },
    layer,
    net,
    drill,
  };
}

function drcFootprint(id: string, x: number, y: number, pads: Pad[], side: 'top' | 'bottom' = 'top'): Footprint {
  return {
    id,
    componentId: id,
    componentType: 'resistor',
    refdes: id.toUpperCase(),
    position: { x, y },
    rotation: 0,
    bodySize: { width: 3.2, height: 1.6 },
    pads,
    side,
  };
}

describe('DRC cross-layer pad semantics', () => {
  it('SMD pads on opposite layers do NOT conflict (was: every top/bottom pair flagged as short)', () => {
    const fpTop = drcFootprint('r1', 10, 10, [drcPad('p1', 10, 10, 'N1', 'top')]);
    const fpBottom = drcFootprint('r2', 10, 10, [drcPad('p2', 10, 10, 'N2', 'bottom')], 'bottom');
    const errors = runDRC([fpTop, fpBottom], [], [], [], { width: 50, height: 50 }, DEFAULT_DRC_CONFIG);
    expect(errors.filter((e) => e.type === 'short' || e.type === 'clearance')).toHaveLength(0);
  });

  it('a bottom trace overlapping a top THT pad (drill > 0) of another net IS a short', () => {
    const tht = drcFootprint('r1', 10, 10, [drcPad('p1', 10, 10, 'N1', 'top', 0.6)]);
    const trace = {
      id: 't1', net: 'N2', layer: 'bottom' as const, width: 0.3,
      segments: [{ start: { x: 10, y: 10 }, end: { x: 20, y: 10 }, width: 0.3 }],
    };
    const errors = runDRC([tht], [trace], [], [], { width: 50, height: 50 }, DEFAULT_DRC_CONFIG);
    expect(errors.some((e) => e.type === 'short')).toBe(true);
  });

  it('annular ring uses the pad drill field when present (not the 60% estimate)', () => {
    // 2.0mm pad with a 1.9mm drill → ring 0.05mm < default min 0.15mm → flagged.
    const fp = drcFootprint('r1', 10, 10, [drcPad('p1', 10, 10, 'N1', 'top', 1.9)]);
    fp.pads[0].size = { width: 2.0, height: 2.0 };
    const errors = runDRC([fp], [], [], [], { width: 50, height: 50 }, DEFAULT_DRC_CONFIG);
    const ring = errors.find((e) => e.type === 'annular_ring');
    expect(ring).toBeDefined();
    expect(ring!.message).toContain('0.050');
  });
});

describe('PCB store regressions', () => {
  beforeEach(() => {
    usePCB.getState().clearPCB();
  });

  it('flipFootprint mirrors pads around the footprint position (not around x=0)', () => {
    // Place a footprint at x=40 with a pad at x=42 — the old code mirrored
    // the pad to x=-42 (off the board).
    usePCB.setState({
      footprints: [drcFootprint('r1', 40, 30, [drcPad('p1', 42, 30, 'N1', 'top')])],
    });
    usePCB.getState().flipFootprint('r1');
    const fp = usePCB.getState().footprints[0];
    expect(fp.side).toBe('bottom');
    expect(fp.pads[0].position.x).toBeCloseTo(38, 6); // 2*40 - 42
    expect(fp.pads[0].position.y).toBeCloseTo(30, 6);
    expect(fp.pads[0].layer).toBe('bottom');
  });

  it('runDRC passes the PCB net classes to the DRC engine', () => {
    usePCB.setState({
      footprints: [],
      traces: [{
        id: 't1', net: 'PWR', layer: 'top' as const, width: 0.2,
        segments: [{ start: { x: 5, y: 5 }, end: { x: 15, y: 5 }, width: 0.2 }],
      }],
      netClasses: [{ name: 'Power', traceWidth: 0.5, clearance: 0.3, viaDiameter: 0.6, viaDrill: 0.3, nets: ['PWR'] }],
    });
    usePCB.getState().runDRC();
    const errors = usePCB.getState().drcErrors;
    const widthError = errors.find((e) => e.type === 'min_width');
    expect(widthError).toBeDefined();
    expect(widthError!.message).toContain('NetClass');
  });

  it('flipFootprint recomputes the ratsnest', () => {
    usePCB.setState({
      footprints: [
        drcFootprint('r1', 40, 30, [drcPad('p1', 42, 30, 'N1', 'top')]),
        drcFootprint('r2', 20, 30, [drcPad('p2', 18, 30, 'N1', 'top')]),
      ],
      ratsnest: [{ fromPadId: 'p1', toPadId: 'p2', net: 'N1', from: { x: 42, y: 30 }, to: { x: 18, y: 30 } }],
      padNets: new Map([['comp_p1:a', 'N1'], ['comp_p2:a', 'N1']]),
    });
    usePCB.getState().flipFootprint('r1');
    const rn = usePCB.getState().ratsnest;
    expect(rn.length).toBeGreaterThan(0);
    // The airwire endpoint must track the flipped pad (x = 38 now)
    const end = rn.find((r) => r.toPadId === 'p1' || r.fromPadId === 'p1');
    expect(end).toBeDefined();
    const flippedEnd = end!.toPadId === 'p1' ? end!.to : end!.from;
    expect(flippedEnd.x).toBeCloseTo(38, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Copper pour island removal
// ─────────────────────────────────────────────────────────────────────────────

import { generateCopperPour } from '../src/lib/pcb/copper-pour';

describe('Copper pour island removal', () => {
  it('removes fill islands not connected to a same-net pad', () => {
    const board = { width: 20, height: 20 };
    // GND pad near the left edge; a huge OTHER-net keep-out strip (as a fat
    // trace) divides the board into a connected west region and an isolated
    // east island.
    const gndFp = drcFootprint('g1', 3, 10, [drcPad('gp', 3, 10, 'GND', 'top', 0.6)]);
    const divider: any = {
      id: 'wall', net: 'OTHER', layer: 'top', width: 2,
      segments: [{ start: { x: 8, y: 0 }, end: { x: 8, y: 20 }, width: 2 }],
    };
    const pour = generateCopperPour('top', 'GND', [gndFp], [divider], [], board, 0.3);
    expect(pour.cells.length).toBeGreaterThan(0);
    // No filled cell to the east of the divider (col > 16 = x > 8)
    const eastCells = pour.cells.filter((c) => c.x > 9);
    expect(eastCells).toHaveLength(0);
    // The connected west region survives
    const westCells = pour.cells.filter((c) => c.x < 7);
    expect(westCells.length).toBeGreaterThan(0);
  });

  it('keeps the full fill when the pour net has no anchors (nothing to compare against)', () => {
    const board = { width: 10, height: 10 };
    const pour = generateCopperPour('top', 'GND', [], [], [], board, 0.3);
    expect(pour.cells.length).toBeGreaterThan(100); // 20x20 grid, nothing avoided
  });
});

describe('Footprint drill propagation', () => {
  it('built-in THT footprint defs carry a 1.0mm drill', () => {
    const def = getFootprintDef('switch');
    expect(def.pads.every((p) => p.drill === 1.0)).toBe(true);
  });

  it('createPCBFromSchematic propagates pad drills to the PCB pads', () => {
    const comp = {
      id: 'sw1', type: 'pushButton', position: { x: 5, y: 5 }, rotation: 0, parameters: {},
    } as any;
    const { footprints } = createPCBFromSchematic([comp], []);
    expect(footprints).toHaveLength(1);
    expect(footprints[0].pads.length).toBeGreaterThan(0);
    for (const p of footprints[0].pads) {
      expect(p.drill).toBe(1.0);
    }
  });
});
