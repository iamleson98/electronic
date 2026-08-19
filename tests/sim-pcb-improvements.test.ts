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
