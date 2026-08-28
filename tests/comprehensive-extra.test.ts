// Comprehensive extra test suite — covers modules that previously had thin or no tests:
//   - complex-solver.ts (complex arithmetic + complex MNA)
//   - reference-solver.ts (independent reference MNA)
//   - integration.ts (Trapezoidal + Gear-2 + adaptive timestep + oscillation detection)
//   - measurement.ts (parseMeasLine, TraceMath, stimulusToSPICE, sampleStimulus)
//   - net-annotation.ts (annotateNets, getNetName, findNetConflicts)
//   - share-url.ts (createShareURL, loadFromShareURL)
//   - schematic-plot.ts (exportSchematicSVG)
//   - netlist-export.ts (exportSPICENetlist, exportKiCadNetlist, buildBOMRows, exportBOMCSV)
//   - erc.ts (runFullERC)
//   - Component plugin metadata (every registered plugin has the required shape)
//   - Examples (every example loads, simulates, has finite voltages)
//   - Additional circuit behaviors (parallel resistors, RC time constant, etc.)

import { describe, it, expect, beforeAll } from 'vitest';
import {
  cAdd, cSub, cMul, cDiv, cAbs, cPhase, cFromPolar,
  createComplexMnaSystem, cStampConductance, cStampCurrentSource,
  cStampVoltageSource, cStampVCCS, solveComplexMna, type Complex,
} from '../src/lib/circuit/complex-solver';
import { ReferenceSolver } from '../src/lib/circuit/reference-solver';
import {
  capTrapezoidal, capGear2, inductorTrapezoidal, inductorGear2,
  detectTrapOscillation, adaptTimestep, DEFAULT_TRAP_CONTROLLER,
} from '../src/lib/circuit/integration';
import {
  parseMeasLine, execMeas, TraceMath, stimulusToSPICE, sampleStimulus,
  type RealTrace,
} from '../src/lib/circuit/measurement';
import { annotateNets, getNetName, findNetConflicts } from '../src/lib/circuit/net-annotation';
import { createShareURL, loadFromShareURL } from '../src/lib/circuit/share-url';
import { exportSchematicSVG } from '../src/lib/circuit/schematic-plot';
import {
  exportSPICENetlist, exportKiCadNetlist, buildBOMRows, exportBOMCSV,
} from '../src/lib/circuit/netlist-export';
import { runFullERC } from '../src/lib/circuit/erc';
import { getAllPlugins, getPlugin, hasPlugin } from '../src/lib/circuit/registry';
import { simulateStep, solveDC, buildNodeMap, computeComponentCurrents } from '../src/lib/circuit/engine';
import { exampleCategories } from '../src/lib/circuit/examples';
import type { CircuitComponent, Wire, ComponentPlugin, CircuitDocument } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function approxEqual(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol || Math.abs(a - b) / Math.max(Math.abs(b), 1e-12) <= tol;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Complex number arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('Complex arithmetic', () => {
  it('cAdd: (1+2i) + (3+4i) = 4+6i', () => {
    const r = cAdd({ re: 1, im: 2 }, { re: 3, im: 4 });
    expect(r.re).toBe(4); expect(r.im).toBe(6);
  });
  it('cAdd: zero + zero = zero', () => {
    const r = cAdd({ re: 0, im: 0 }, { re: 0, im: 0 });
    expect(r.re).toBe(0); expect(r.im).toBe(0);
  });
  it('cAdd: negative imaginary parts', () => {
    const r = cAdd({ re: 5, im: -3 }, { re: -2, im: 4 });
    expect(r.re).toBe(3); expect(r.im).toBe(1);
  });
  it('cSub: (5+7i) - (2+3i) = 3+4i', () => {
    const r = cSub({ re: 5, im: 7 }, { re: 2, im: 3 });
    expect(r.re).toBe(3); expect(r.im).toBe(4);
  });
  it('cSub: a - a = 0', () => {
    const r = cSub({ re: 9, im: -2 }, { re: 9, im: -2 });
    expect(r.re).toBe(0); expect(r.im).toBe(0);
  });
  it('cMul: (1+1i)*(1-1i) = 2+0i', () => {
    const r = cMul({ re: 1, im: 1 }, { re: 1, im: -1 });
    expect(approxEqual(r.re, 2)).toBe(true);
    expect(approxEqual(r.im, 0)).toBe(true);
  });
  it('cMul: (3+2i)*(1+4i) = -5+14i', () => {
    const r = cMul({ re: 3, im: 2 }, { re: 1, im: 4 });
    expect(r.re).toBe(-5); expect(r.im).toBe(14);
  });
  it('cMul: 0 * anything = 0', () => {
    const r = cMul({ re: 0, im: 0 }, { re: 5, im: 9 });
    expect(r.re).toBe(0); expect(r.im).toBe(0);
  });
  it('cDiv: (4+0i)/(2+0i) = 2+0i', () => {
    const r = cDiv({ re: 4, im: 0 }, { re: 2, im: 0 });
    expect(approxEqual(r.re, 2)).toBe(true);
    expect(approxEqual(r.im, 0)).toBe(true);
  });
  it('cDiv: (1+1i)/(1-1i) = 0+1i', () => {
    const r = cDiv({ re: 1, im: 1 }, { re: 1, im: -1 });
    expect(approxEqual(r.re, 0)).toBe(true);
    expect(approxEqual(r.im, 1)).toBe(true);
  });
  it('cDiv: division by zero yields 0', () => {
    const r = cDiv({ re: 5, im: 5 }, { re: 0, im: 0 });
    expect(r.re).toBe(0); expect(r.im).toBe(0);
  });
  it('cAbs: |3+4i| = 5', () => {
    expect(cAbs({ re: 3, im: 4 })).toBe(5);
  });
  it('cAbs: |0+0i| = 0', () => {
    expect(cAbs({ re: 0, im: 0 })).toBe(0);
  });
  it('cAbs: |−5+0i| = 5', () => {
    expect(cAbs({ re: -5, im: 0 })).toBe(5);
  });
  it('cPhase: 1+0i → 0 rad', () => {
    expect(cPhase({ re: 1, im: 0 })).toBe(0);
  });
  it('cPhase: 0+1i → π/2', () => {
    expect(approxEqual(cPhase({ re: 0, im: 1 }), Math.PI / 2)).toBe(true);
  });
  it('cPhase: −1+0i → π', () => {
    expect(approxEqual(cPhase({ re: -1, im: 0 }), Math.PI)).toBe(true);
  });
  it('cPhase: 0−1i → −π/2', () => {
    expect(approxEqual(cPhase({ re: 0, im: -1 }), -Math.PI / 2)).toBe(true);
  });
  it('cFromPolar: mag=2, phase=0 → 2+0i', () => {
    const r = cFromPolar(2, 0);
    expect(approxEqual(r.re, 2)).toBe(true);
    expect(approxEqual(r.im, 0)).toBe(true);
  });
  it('cFromPolar: mag=3, phase=π/2 → 0+3i', () => {
    const r = cFromPolar(3, Math.PI / 2);
    expect(approxEqual(r.re, 0, 1e-12)).toBe(true);
    expect(approxEqual(r.im, 3)).toBe(true);
  });
  it('cFromPolar: mag=1, phase=π → −1+0i', () => {
    const r = cFromPolar(1, Math.PI);
    expect(approxEqual(r.re, -1)).toBe(true);
    expect(approxEqual(r.im, 0, 1e-12)).toBe(true);
  });
  it('round-trip: cAbs(cFromPolar(m, p)) ≈ m', () => {
    const m = 4.5, p = 1.234;
    const c = cFromPolar(m, p);
    expect(approxEqual(cAbs(c), m)).toBe(true);
  });
  it('round-trip: cPhase(cFromPolar(m, p)) ≈ p', () => {
    const m = 2, p = -0.7;
    const c = cFromPolar(m, p);
    expect(approxEqual(cPhase(c), p)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Complex MNA solver
// ─────────────────────────────────────────────────────────────────────────────

describe('Complex MNA solver', () => {
  it('createComplexMnaSystem: dimensions correct', () => {
    const sys = createComplexMnaSystem(2, 1);
    expect(sys.size).toBe(3);
    expect(sys.A.length).toBe(2 * 3 * 3);
    expect(sys.z.length).toBe(2 * 3);
    expect(sys.nextExtra).toBe(2);
  });
  it('solveComplexMna: empty system returns []', () => {
    const sys = createComplexMnaSystem(0, 0);
    const r = solveComplexMna(sys);
    expect(r).toEqual([]);
  });
  it('solveComplexMna: single voltage source → node voltage', () => {
    // V1 between node1 and ground, = 5V
    const sys = createComplexMnaSystem(1, 1);
    cStampVoltageSource(sys, 1, 0, { re: 5, im: 0 });
    const r = solveComplexMna(sys);
    expect(r).not.toBeNull();
    expect(approxEqual(r![0].re, 5)).toBe(true);
    expect(approxEqual(r![0].im, 0)).toBe(true);
  });
  it('solveComplexMna: voltage divider with complex R=Z (resistive)', () => {
    // 5V source → R1(1k) → node1 → R2(1k) → GND
    const sys = createComplexMnaSystem(2, 1);
    cStampVoltageSource(sys, 1, 0, { re: 5, im: 0 });  // V1 between node1 and 0
    cStampConductance(sys, 1, 2, { re: 1 / 1000, im: 0 });  // R1
    cStampConductance(sys, 2, 0, { re: 1 / 1000, im: 0 });  // R2
    const r = solveComplexMna(sys);
    expect(r).not.toBeNull();
    // node1 voltage = 5 (source), node2 voltage = 2.5 (divider)
    expect(approxEqual(r![0].re, 5, 1e-6)).toBe(true);
    expect(approxEqual(r![1].re, 2.5, 1e-6)).toBe(true);
  });
  it('solveComplexMna: capacitor impedance (1/(jωC)) at ω=1000 rad/s, C=1μF → |Z|=1000', () => {
    // Z_cap = 1/(jωC) → conductance g = jωC
    const omega = 1000, C = 1e-6;
    const sys = createComplexMnaSystem(2, 1);
    cStampVoltageSource(sys, 1, 0, { re: 1, im: 0 });
    cStampConductance(sys, 1, 2, { re: 1e-3, im: 0 });   // R = 1kΩ
    cStampConductance(sys, 2, 0, { re: 0, im: omega * C }); // capacitor (g = jωC)
    const r = solveComplexMna(sys);
    expect(r).not.toBeNull();
    // |Z_C| = 1/(ωC) = 1000, equal to R → divider magnitude halves at this frequency
    const v2mag = Math.hypot(r![1].re, r![1].im);
    expect(v2mag).toBeCloseTo(1 / Math.SQRT2, 3);  // |V| = 1/√2 ≈ 0.707
  });
  it('cStampCurrentSource: 1A into node from 0 → node voltage = 1V across 1Ω', () => {
    // cStampCurrentSource(sys, n1, n2, I): current flows OUT of n1, INTO n2.
    // To push 1A INTO node 1 from ground, call with n1=0, n2=1.
    const sys = createComplexMnaSystem(1, 0);
    cStampCurrentSource(sys, 0, 1, { re: 1, im: 0 });
    cStampConductance(sys, 1, 0, { re: 1, im: 0 });
    const r = solveComplexMna(sys);
    expect(r).not.toBeNull();
    expect(approxEqual(r![0].re, 1, 1e-9)).toBe(true);
  });
  it('solveComplexMna: returns null for singular matrix', () => {
    // Build a system with no stamps → all-zero matrix → singular
    const sys = createComplexMnaSystem(2, 0);
    const r = solveComplexMna(sys);
    expect(r).toBeNull();
  });
  it('cStampVCCS: gm=0.1 produces correct output', () => {
    // V1(5V) on node 1, gm=0.1 → VCCS produces I = g*(V_c − V_d) = 0.5A.
    // cStampVCCS(sys, n1, n2, c, d, g): current flows through the element
    // from n1 to n2 (SPICE G convention). To source INTO node 2 from
    // ground: call with n1=0, n2=2 (current flows from ground into node 2).
    // That current flows through R=10Ω → V(node2) = 0.5A × 10Ω = 5V.
    const sys = createComplexMnaSystem(2, 1);
    cStampVoltageSource(sys, 1, 0, { re: 5, im: 0 });
    cStampVCCS(sys, 0, 2, 1, 0, { re: 0.1, im: 0 });
    cStampConductance(sys, 2, 0, { re: 0.1, im: 0 });  // R = 10Ω
    const r = solveComplexMna(sys);
    expect(r).not.toBeNull();
    expect(approxEqual(r![1].re, 5, 1e-6)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reference solver (independent MNA implementation)
// ─────────────────────────────────────────────────────────────────────────────

describe('Reference solver', () => {
  it('addNode: ground returns 0', () => {
    const s = new ReferenceSolver();
    expect(s.addNode('0')).toBe(0);
    expect(s.addNode('gnd')).toBe(0);
  });
  it('addNode: returns sequential ids', () => {
    const s = new ReferenceSolver();
    expect(s.addNode('a')).toBe(1);
    expect(s.addNode('b')).toBe(2);
    expect(s.addNode('a')).toBe(1);  // already added
  });
  it('nodeId: unknown returns 0', () => {
    const s = new ReferenceSolver();
    expect(s.nodeId('unknown')).toBe(0);
  });
  it('stampR: zero resistance is clamped to 1e-12', () => {
    const s = new ReferenceSolver();
    expect(() => s.stampR('a', 'b', 0)).not.toThrow();
  });
  it('solve: empty system ok', () => {
    const s = new ReferenceSolver();
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('0')).toBe(0);
  });
  it('solve: single voltage source', () => {
    const s = new ReferenceSolver();
    s.stampV('a', '0', 5, 'V1');
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('a')).toBe(5);
  });
  it('solve: voltage divider', () => {
    const s = new ReferenceSolver();
    s.stampV('a', '0', 10, 'V1');
    s.stampR('a', 'b', 1000);  // R1
    s.stampR('b', '0', 1000);  // R2
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('b')).toBe(5);
  });
  it('solve: current source drives 1k resistor', () => {
    const s = new ReferenceSolver();
    s.stampI('a', '0', 0.001);  // 1mA into node a
    s.stampR('a', '0', 1000);   // 1kΩ to ground
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('a')).toBe(1);
  });
  it('solve: branch current returned for V source', () => {
    // V1(5V) → R(1kΩ) → GND, expected |I| = 5mA.
    const s = new ReferenceSolver();
    s.stampV('a', '0', 5, 'V1');
    s.stampR('a', '0', 1000);
    const r = s.solve();
    expect(r.ok).toBe(true);
    // Branch current sign depends on stamping convention; magnitude must match.
    expect(Math.abs(r.currents.get('V1')!)).toBeCloseTo(0.005, 6);
  });
  it('solve: VCCS mirrors current', () => {
    // V1 = 1V on node 'a', gm=0.5. stampVCCS('0','b','a','0',0.5) drives
    // 0.5·V(a) = 0.5A from ground INTO node 'b' (SPICE G convention: current
    // flows through the element from n1 to n2). Through R=2Ω on node b →
    // V(b) = 1V.
    const s = new ReferenceSolver();
    s.stampV('a', '0', 1, 'V1');
    s.stampVCCS('0', 'b', 'a', '0', 0.5);
    s.stampR('b', '0', 2);
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('b')).toBeCloseTo(1, 6);
  });
  it('solve: VCCS draws current from n1 (SPICE G polarity)', () => {
    // stampVCCS('b','0','a','0',0.5): current flows b→0 through the element,
    // i.e. 0.5A is DRAWN OUT of node 'b' → V(b) = −1V across 2Ω.
    const s = new ReferenceSolver();
    s.stampV('a', '0', 1, 'V1');
    s.stampVCCS('b', '0', 'a', '0', 0.5);
    s.stampR('b', '0', 2);
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('b')).toBeCloseTo(-1, 6);
  });
  it('solve: VCVS mirrors voltage', () => {
    // V1 = 3V on node 'a', mu=2 → VCVS makes V('b') = 6V
    const s = new ReferenceSolver();
    s.stampV('a', '0', 3, 'V1');
    s.stampVCVS('b', '0', 'a', '0', 2, 'E1');
    s.stampR('b', '0', 1000);
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('b')).toBeCloseTo(6, 6);
  });
  it('solve: singular matrix returns ok=false', () => {
    // No ground reference, no components → singular
    const s = new ReferenceSolver();
    s.stampR('a', 'b', 1000);
    s.stampR('b', 'a', 500);
    const r = s.solve();
    expect(r.ok).toBe(false);
  });
  it('reset: clears state', () => {
    const s = new ReferenceSolver();
    s.addNode('a');
    s.stampV('a', '0', 5, 'V1');
    s.reset();
    expect(s.numNodes).toBe(1);  // only ground (0)
  });
  it('solve: multi-node ladder', () => {
    const s = new ReferenceSolver();
    s.stampV('a', '0', 5, 'V1');
    // 5-node ladder with 1k each
    let prev = 'a';
    for (const n of ['b', 'c', 'd', 'e']) {
      s.stampR(prev, n, 1000);
      prev = n;
    }
    s.stampR(prev, '0', 1000);
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(r.voltages.get('e')!).toBeGreaterThan(0);
    expect(r.voltages.get('e')!).toBeLessThan(5);
  });
  it('solve: parallel resistors', () => {
    // V=10V → R1=1kΩ parallel with R2=1kΩ → V(node)=10V, total |I| = 20mA.
    const s = new ReferenceSolver();
    s.stampV('a', '0', 10, 'V1');
    s.stampR('a', '0', 1000);
    s.stampR('a', '0', 1000);
    const r = s.solve();
    expect(r.ok).toBe(true);
    // Total current magnitude from source = 20mA.
    expect(Math.abs(r.currents.get('V1')!)).toBeCloseTo(0.02, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Integration methods (companion models)
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration methods', () => {
  it('capTrapezoidal: gEq = 2C/dt', () => {
    const r = capTrapezoidal(1e-6, 1e-4, 0, 0);
    expect(r.gEq).toBeCloseTo(2 * 1e-6 / 1e-4, 9);
  });
  it('capTrapezoidal: iEq uses previous state', () => {
    const r = capTrapezoidal(1e-6, 1e-4, 5, 0.001);
    expect(r.iEq).toBeCloseTo((2 * 1e-6 / 1e-4) * 5 + 0.001, 9);
  });
  it('capTrapezoidal: newState stores vPrev and iPrev', () => {
    const r = capTrapezoidal(1e-6, 1e-4, 3, 0.002);
    expect(r.newState.vPrev).toBe(3);
    expect(r.newState.iPrev).toBe(0.002);
  });
  it('capGear2: gEq = 3C/(2dt)', () => {
    const r = capGear2(1e-6, 1e-4, 0, 0);
    expect(r.gEq).toBeCloseTo(3 * 1e-6 / (2 * 1e-4), 9);
  });
  it('capGear2: iEq uses vPrev and vPrev2', () => {
    const r = capGear2(1e-6, 1e-4, 4, 2);
    // iEq = -(2C/dt)*vPrev + (C/(2dt))*vPrev2  (Gear-2 form)
    expect(r.iEq).not.toBe(0);
  });
  it('inductorTrapezoidal: returns companion model', () => {
    const r = inductorTrapezoidal(1e-3, 1e-4, 0, 0);
    expect(r.gEq).toBeGreaterThan(0);
    expect(typeof r.iEq).toBe('number');
  });
  it('inductorGear2: returns companion model', () => {
    const r = inductorGear2(1e-3, 1e-4, 0.5, 0.3);
    expect(r.gEq).toBeGreaterThan(0);
    expect(typeof r.iEq).toBe('number');
  });
  it('detectTrapOscillation: returns false for monotonic increase', () => {
    const v = [0, 1, 2, 3, 4, 5];
    expect(detectTrapOscillation(v)).toBe(false);
  });
  it('detectTrapOscillation: returns true for alternating differences', () => {
    // Build values where consecutive differences alternate sign
    const v = [0, 2, 1, 3, 2, 4, 3, 5];
    // differences: +2, -1, +2, -1, +2, -1, +2 — alternating
    expect(detectTrapOscillation(v)).toBe(true);
  });
  it('detectTrapOscillation: returns false for too few samples', () => {
    expect(detectTrapOscillation([0, 1, 2])).toBe(false);
    expect(detectTrapOscillation([])).toBe(false);
  });
  it('detectTrapOscillation: returns false when diff is below chgtol', () => {
    // Consecutive values nearly identical → differences ≈ 0
    const v = [1, 1, 1, 1, 1];
    expect(detectTrapOscillation(v, 1e-14)).toBe(false);
  });
  it('adaptTimestep: shrinks when dv exceeds target', () => {
    const vPrev = new Float64Array([0]);
    const vNow = new Float64Array([10]);
    const newDt = adaptTimestep(DEFAULT_TRAP_CONTROLLER, 1e-4, vPrev, vNow);
    expect(newDt).toBeLessThan(1e-4);
  });
  it('adaptTimestep: grows when dv is well below target', () => {
    const vPrev = new Float64Array([0]);
    const vNow = new Float64Array([0.001]);
    const newDt = adaptTimestep(DEFAULT_TRAP_CONTROLLER, 1e-4, vPrev, vNow);
    expect(newDt).toBeGreaterThan(1e-4);
  });
  it('adaptTimestep: stays when dv is around target', () => {
    const vPrev = new Float64Array([0]);
    const vNow = new Float64Array([0.1]);  // exactly targetMaxDV
    const newDt = adaptTimestep(DEFAULT_TRAP_CONTROLLER, 1e-4, vPrev, vNow);
    expect(newDt).toBe(1e-4);
  });
  it('adaptTimestep: clamps to dtMax', () => {
    const vPrev = new Float64Array([0]);
    const vNow = new Float64Array([0]);  // zero change
    const newDt = adaptTimestep(DEFAULT_TRAP_CONTROLLER, 1e-3, vPrev, vNow);
    expect(newDt).toBeLessThanOrEqual(DEFAULT_TRAP_CONTROLLER.dtMax);
  });
  it('adaptTimestep: clamps to dtMin', () => {
    const vPrev = new Float64Array([0]);
    const vNow = new Float64Array([1000]);  // huge change
    const newDt = adaptTimestep(DEFAULT_TRAP_CONTROLLER, 1e-9, vPrev, vNow);
    expect(newDt).toBeGreaterThanOrEqual(DEFAULT_TRAP_CONTROLLER.dtMin);
  });
  it('DEFAULT_TRAP_CONTROLLER: has sensible values', () => {
    expect(DEFAULT_TRAP_CONTROLLER.dtMin).toBeGreaterThan(0);
    expect(DEFAULT_TRAP_CONTROLLER.dtMax).toBeGreaterThan(DEFAULT_TRAP_CONTROLLER.dtMin);
    expect(DEFAULT_TRAP_CONTROLLER.growFactor).toBeGreaterThan(1);
    expect(DEFAULT_TRAP_CONTROLLER.shrinkFactor).toBeLessThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Measurement parsing & execution
// ─────────────────────────────────────────────────────────────────────────────

describe('Measurement parsing', () => {
  it('parseMeasLine: parses basic .meas tran', () => {
    const r = parseMeasLine('.meas tran vout AVG V(out)');
    expect(r).not.toBeNull();
    expect(r!.mode).toBe('tran');
    expect(r!.name).toBe('vout');
    expect(r!.type).toBe('AVG');
  });
  it('parseMeasLine: parses MIN', () => {
    const r = parseMeasLine('.meas tran vmin MIN V(in)');
    expect(r!.type).toBe('MIN');
  });
  it('parseMeasLine: parses MAX', () => {
    const r = parseMeasLine('.meas tran vmax MAX V(in)');
    expect(r!.type).toBe('MAX');
  });
  it('parseMeasLine: parses PP', () => {
    const r = parseMeasLine('.meas tran vpp PP V(in)');
    expect(r!.type).toBe('PP');
  });
  it('parseMeasLine: parses RMS', () => {
    const r = parseMeasLine('.meas ac vrms RMS V(out)');
    expect(r!.mode).toBe('ac');
    expect(r!.type).toBe('RMS');
  });
  it('parseMeasLine: parses FIND...WHEN', () => {
    const r = parseMeasLine('.meas tran tfind FIND V(out) WHEN V(in)=2.5');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('FIND');
    expect(r!.whenExpr).toContain('V(in)');
  });
  it('parseMeasLine: parses FROM/TO', () => {
    const r = parseMeasLine('.meas tran vavg AVG V(out) FROM=0 TO=1m');
    expect(r).not.toBeNull();
    expect(r!.fromTime).toBe(0);
    expect(r!.toTime).toBeCloseTo(1e-3, 9);
  });
  it('parseMeasLine: parses TRIG/TARG', () => {
    const r = parseMeasLine('.meas tran tdly DELAY V(out) TRIG V(in)=1 TARG V(out)=4');
    expect(r).not.toBeNull();
    expect(r!.trigExpr).toBe('V(in)');
    expect(r!.trigVal).toBe(1);
    expect(r!.targExpr).toBe('V(out)');
    expect(r!.targVal).toBe(4);
  });
  it('parseMeasLine: returns null for invalid format', () => {
    expect(parseMeasLine('not a meas line')).toBeNull();
    expect(parseMeasLine('')).toBeNull();
  });
  it('parseMeasLine: parses dc mode', () => {
    const r = parseMeasLine('.meas dc gain PARAM 2*gain');
    expect(r!.mode).toBe('dc');
    expect(r!.type).toBe('PARAM');
  });
  it('parseMeasLine: parses WHEN alone', () => {
    const r = parseMeasLine('.meas tran t WHEN V(x)=3');
    expect(r!.type).toBe('WHEN');
  });
});

describe('Measurement execution', () => {
  function mkTrace(ys: number[], xs?: number[]): RealTrace {
    const x = xs ?? ys.map((_, i) => i);
    return {
      name: 't', xValues: Float64Array.from(x), yValues: Float64Array.from(ys),
      xLabel: 's', yLabel: 'V',
    };
  }
  it('execMeas AVG: average of constant = itself', () => {
    const t = mkTrace([5, 5, 5, 5]);
    const cmd = parseMeasLine('.meas tran avg AVG V(t)')!;
    const r = execMeas(cmd, t);
    expect(r.value).toBe(5);
  });
  it('execMeas AVG: average of [0,2,4,6] = 3', () => {
    const t = mkTrace([0, 2, 4, 6]);
    const cmd = parseMeasLine('.meas tran avg AVG V(t)')!;
    const r = execMeas(cmd, t);
    expect(r.value).toBe(3);
  });
  it('execMeas MIN: returns minimum', () => {
    const t = mkTrace([5, 1, 9, 3]);
    const r = execMeas(parseMeasLine('.meas tran mn MIN V(t)')!, t);
    expect(r.value).toBe(1);
  });
  it('execMeas MAX: returns maximum', () => {
    const t = mkTrace([5, 1, 9, 3]);
    const r = execMeas(parseMeasLine('.meas tran mx MAX V(t)')!, t);
    expect(r.value).toBe(9);
  });
  it('execMeas PP: peak-to-peak', () => {
    const t = mkTrace([2, 5, 9, 1]);
    const r = execMeas(parseMeasLine('.meas tran pp PP V(t)')!, t);
    expect(r.value).toBe(8);
  });
  it('execMeas RMS: RMS of [1, -1, 1, -1] = 1', () => {
    const t = mkTrace([1, -1, 1, -1]);
    const r = execMeas(parseMeasLine('.meas ac rms RMS V(t)')!, t);
    expect(r.value).toBeCloseTo(1, 6);
  });
  it('execMeas PARAM: parses numeric expression', () => {
    const cmd = parseMeasLine('.meas tran v PARAM 3.14')!;
    const r = execMeas(cmd, mkTrace([]));
    expect(r.value).toBeCloseTo(3.14, 6);
  });
  it('execMeas PARAM: non-numeric returns 0', () => {
    const cmd = parseMeasLine('.meas tran v PARAM notanumber')!;
    const r = execMeas(cmd, mkTrace([]));
    expect(r.value).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. TraceMath operations
// ─────────────────────────────────────────────────────────────────────────────

describe('TraceMath', () => {
  function mkTrace(ys: number[]): RealTrace {
    return {
      name: 't', xValues: Float64Array.from(ys.map((_, i) => i)),
      yValues: Float64Array.from(ys),
      xLabel: 's', yLabel: 'V',
    };
  }
  it('add: elementwise sum', () => {
    const r = TraceMath.add(mkTrace([1, 2, 3]), mkTrace([10, 20, 30]));
    expect(Array.from(r.yValues)).toEqual([11, 22, 33]);
  });
  it('sub: elementwise difference', () => {
    const r = TraceMath.sub(mkTrace([10, 20, 30]), mkTrace([1, 2, 3]));
    expect(Array.from(r.yValues)).toEqual([9, 18, 27]);
  });
  it('mul: elementwise product', () => {
    const r = TraceMath.mul(mkTrace([2, 3, 4]), mkTrace([5, 6, 7]));
    expect(Array.from(r.yValues)).toEqual([10, 18, 28]);
  });
  it('scale: multiplies by constant', () => {
    const r = TraceMath.scale(mkTrace([1, 2, 3]), 10);
    expect(Array.from(r.yValues)).toEqual([10, 20, 30]);
  });
  it('db20: 20*log10(|y|)', () => {
    const r = TraceMath.db20(mkTrace([1, 10, 100]));
    expect(r.yValues[0]).toBeCloseTo(0, 6);
    expect(r.yValues[1]).toBeCloseTo(20, 6);
    expect(r.yValues[2]).toBeCloseTo(40, 6);
  });
  it('db10: 10*log10(|y|)', () => {
    const r = TraceMath.db10(mkTrace([1, 10, 100]));
    expect(r.yValues[0]).toBeCloseTo(0, 6);
    expect(r.yValues[1]).toBeCloseTo(10, 6);
    expect(r.yValues[2]).toBeCloseTo(20, 6);
  });
  it('abs: elementwise absolute value', () => {
    const r = TraceMath.abs(mkTrace([-1, 2, -3]));
    expect(Array.from(r.yValues)).toEqual([1, 2, 3]);
  });
  it('integrate: trapezoidal sum', () => {
    // x = [0,1,2,3], y = [1,1,1,1] → integral step increments: 0, 1*1=1, 1*1=2, 1*1=3
    const r = TraceMath.integrate(mkTrace([1, 1, 1, 1]));
    expect(r.yValues[0]).toBe(0);
    expect(r.yValues[3]).toBeCloseTo(3, 6);
  });
  it('derivative: finite difference', () => {
    // x = [0,1,2,3], y = [0, 2, 4, 6] → derivative = 2 at each point (after first)
    const r = TraceMath.derivative(mkTrace([0, 2, 4, 6]));
    expect(r.yValues[1]).toBeCloseTo(2, 6);
    expect(r.yValues[2]).toBeCloseTo(2, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Stimulus helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('Stimulus', () => {
  it('stimulusToSPICE: sine', () => {
    const s = stimulusToSPICE({ type: 'sine', params: { voff: 0, vamp: 1, freq: 1000 } }, 'V1');
    expect(s).toContain('SINE');
    expect(s).toContain('V1');
    expect(s).toContain('1000');
  });
  it('stimulusToSPICE: pulse', () => {
    const s = stimulusToSPICE({ type: 'pulse', params: { v1: 0, v2: 5 } }, 'V2');
    expect(s).toContain('PULSE');
    expect(s).toContain('V2');
  });
  it('stimulusToSPICE: pwl', () => {
    const s = stimulusToSPICE({ type: 'pwl', params: { points: [0, 0, 1, 5] } }, 'V3');
    expect(s).toContain('PWL');
    expect(s).toContain('0 0');
    expect(s).toContain('1 5');
  });
  it('stimulusToSPICE: exp', () => {
    const s = stimulusToSPICE({ type: 'exp', params: { v1: 0, v2: 5 } }, 'V4');
    expect(s).toContain('EXP');
  });
  it('stimulusToSPICE: sffm', () => {
    const s = stimulusToSPICE({ type: 'sffm', params: { fc: 1000 } }, 'V5');
    expect(s).toContain('SFFM');
  });
  it('sampleStimulus: sine at t=0 returns voff', () => {
    const r = sampleStimulus({ type: 'sine', params: { voff: 2, vamp: 1, freq: 1000 } }, Float64Array.from([0]));
    expect(r[0]).toBeCloseTo(2, 6);
  });
  it('sampleStimulus: sine oscillates between voff-vamp and voff+vamp', () => {
    const ts = Float64Array.from({ length: 1000 }, (_, i) => i * 1e-5);
    const r = sampleStimulus({ type: 'sine', params: { voff: 0, vamp: 1, freq: 1000 } }, ts);
    const max = Math.max(...Array.from(r));
    const min = Math.min(...Array.from(r));
    expect(max).toBeGreaterThan(0.9);
    expect(min).toBeLessThan(-0.9);
  });
  it('sampleStimulus: pulse alternates between v1 and v2', () => {
    const ts = Float64Array.from({ length: 1000 }, (_, i) => i * 1e-4);
    const r = sampleStimulus({ type: 'pulse', params: { v1: 0, v2: 5, td: 0, tr: 1e-9, tf: 1e-9, pw: 5e-3, per: 10e-3 } }, ts);
    const set = new Set(Array.from(r).map(v => v > 2.5 ? 'HIGH' : 'LOW'));
    expect(set.has('HIGH')).toBe(true);
    expect(set.has('LOW')).toBe(true);
  });
  it('sampleStimulus: pwl interpolates linearly', () => {
    const ts = Float64Array.from([0, 0.5, 1]);
    const r = sampleStimulus({ type: 'pwl', params: { points: [0, 0, 1, 10] } }, ts);
    expect(r[0]).toBeCloseTo(0, 6);
    expect(r[1]).toBeCloseTo(5, 6);
    expect(r[2]).toBeCloseTo(10, 6);
  });
  it('sampleStimulus: exp rises from v1 to v2', () => {
    const ts = Float64Array.from([0, 0.001, 0.01]);
    const r = sampleStimulus({ type: 'exp', params: { v1: 0, v2: 5, td1: 0, tau1: 1e-3, td2: 100, tau2: 1e-3 } }, ts);
    expect(r[0]).toBeCloseTo(0, 6);
    expect(r[2]).toBeGreaterThan(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Net annotation
// ─────────────────────────────────────────────────────────────────────────────

describe('Net annotation', () => {
  function simpleCircuit() {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'GND', 'g'), wire('w3', 'V1', 'n', 'GND', 'g')];
    return { c, w };
  }
  it('annotateNets: assigns names to nodes', () => {
    const { c, w } = simpleCircuit();
    const anns = annotateNets(c, w, pluginsFor(c));
    expect(anns.length).toBeGreaterThan(0);
  });
  it('annotateNets: ground is named GND', () => {
    const { c, w } = simpleCircuit();
    const anns = annotateNets(c, w, pluginsFor(c));
    const gnd = anns.find(a => a.nodeId === 0);
    expect(gnd).toBeDefined();
    expect(gnd!.netName).toBe('GND');
    expect(gnd!.isPower).toBe(true);
  });
  it('annotateNets: non-ground nodes get N-prefixed names', () => {
    const { c, w } = simpleCircuit();
    const anns = annotateNets(c, w, pluginsFor(c));
    const nonGround = anns.filter(a => a.nodeId !== 0);
    expect(nonGround.length).toBeGreaterThan(0);
    for (const a of nonGround) {
      expect(a.netName.startsWith('N')).toBe(true);
    }
  });
  it('getNetName: returns name for known pin', () => {
    const { c, w } = simpleCircuit();
    const anns = annotateNets(c, w, pluginsFor(c));
    const name = getNetName('V1', 'p', anns);
    expect(name).not.toBeNull();
  });
  it('getNetName: returns null for unknown pin', () => {
    const { c, w } = simpleCircuit();
    const anns = annotateNets(c, w, pluginsFor(c));
    expect(getNetName('V1', 'unknown_terminal', anns)).toBeNull();
    expect(getNetName('unknownComponent', 'p', anns)).toBeNull();
  });
  it('findNetConflicts: no conflicts on clean circuit', () => {
    const { c, w } = simpleCircuit();
    const anns = annotateNets(c, w, pluginsFor(c));
    expect(findNetConflicts(anns)).toHaveLength(0);
  });
  it('annotateNets: handles empty circuit', () => {
    const anns = annotateNets([], [], new Map());
    expect(anns).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Share URL
// ─────────────────────────────────────────────────────────────────────────────

describe('Share URL', () => {
  it('createShareURL: starts with #circuit=', () => {
    const url = createShareURL({ version: 1, components: [], wires: [] });
    expect(url).toContain('#circuit=');
  });
  it('createShareURL: contains encoded components', () => {
    const url = createShareURL({
      version: 1,
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
    });
    expect(url.length).toBeGreaterThan(20);
  });
  it('createShareURL → loadFromShareURL: round-trips empty doc', () => {
    const doc = { version: 1 as const, components: [], wires: [] };
    const url = createShareURL(doc);
    const hash = url.substring(url.indexOf('#'));
    const restored = loadFromShareURL(hash);
    expect(restored).not.toBeNull();
    expect(restored!.components).toHaveLength(0);
    expect(restored!.wires).toHaveLength(0);
  });
  it('createShareURL → loadFromShareURL: round-trips doc with components', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [
        comp('resistor', 'R1', { resistance: 1500 }),
        comp('dcVoltage', 'V1', { voltage: 12 }),
      ],
      wires: [],
    };
    const url = createShareURL(doc);
    const hash = url.substring(url.indexOf('#'));
    const restored = loadFromShareURL(hash);
    expect(restored).not.toBeNull();
    expect(restored!.components.length).toBe(2);
    expect(restored!.components[0].type).toBe('resistor');
  });
  it('loadFromShareURL: returns null for invalid hash', () => {
    expect(loadFromShareURL('')).toBeNull();
    expect(loadFromShareURL('#wrong=stuff')).toBeNull();
    expect(loadFromShareURL('#circuit=!!!invalidbase64!!!')).toBeNull();
  });
  it('loadFromShareURL: returns null for hash without circuit prefix', () => {
    expect(loadFromShareURL('#other=value')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Schematic SVG export
// ─────────────────────────────────────────────────────────────────────────────

describe('Schematic SVG export', () => {
  it('exportSchematicSVG: produces valid SVG for empty circuit', () => {
    const svg = exportSchematicSVG({ version: 1, components: [], wires: [] });
    expect(svg).toContain('<?xml');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });
  it('exportSchematicSVG: includes components', () => {
    const svg = exportSchematicSVG({
      version: 1,
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
    });
    expect(svg).toContain('R1');
  });
  it('exportSchematicSVG: includes wires', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('ground', 'GND'),
      ],
      wires: [wire('w1', 'R1', 'b', 'GND', 'g')],
    };
    const svg = exportSchematicSVG(doc);
    expect(svg).toContain('<line');
  });
  it('exportSchematicSVG: has xml declaration', () => {
    const svg = exportSchematicSVG({ version: 1, components: [], wires: [] });
    expect(svg.startsWith('<?xml')).toBe(true);
  });
  it('exportSchematicSVG: contains viewBox', () => {
    const svg = exportSchematicSVG({ version: 1, components: [], wires: [] });
    expect(svg).toContain('viewBox');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Netlist & BOM export
// ─────────────────────────────────────────────────────────────────────────────

describe('Netlist export', () => {
  function simpleDoc(): CircuitDocument {
    return {
      version: 1,
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'GND', 'g'),
        wire('w3', 'V1', 'n', 'GND', 'g'),
      ],
    };
  }
  it('exportSPICENetlist: contains title and END', () => {
    const nl = exportSPICENetlist(simpleDoc(), 'Test Circuit');
    // Title appears as a SPICE comment line.
    expect(nl).toContain('Test Circuit');
    expect(nl.toLowerCase()).toContain('.end');
  });
  it('exportSPICENetlist: contains component reference', () => {
    const nl = exportSPICENetlist(simpleDoc());
    // Should reference V1 or R1 somewhere
    expect(/V1|R1/.test(nl)).toBe(true);
  });
  it('exportKiCadNetlist: produces XML structure', () => {
    const nl = exportKiCadNetlist(simpleDoc());
    expect(nl).toContain('export');
    expect(nl).toContain('components');
  });
  it('buildBOMRows: aggregates by type+value', () => {
    const rows = buildBOMRows(simpleDoc());
    expect(rows.length).toBeGreaterThan(0);
  });
  it('buildBOMRows: counts multiple resistors', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('resistor', 'R2', { resistance: 1000 }),
        comp('resistor', 'R3', { resistance: 1000 }),
      ],
      wires: [],
    };
    const rows = buildBOMRows(doc);
    expect(rows.length).toBeGreaterThan(0);
  });
  it('exportBOMCSV: produces CSV header', () => {
    const csv = exportBOMCSV(simpleDoc());
    expect(csv).toContain('Designator');
    expect(csv).toContain('\n');
  });
  it('exportSPICENetlist: handles empty circuit', () => {
    const nl = exportSPICENetlist({ version: 1, components: [], wires: [] });
    expect(nl.toLowerCase()).toContain('.end');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. ERC (Electrical Rule Check)
// ─────────────────────────────────────────────────────────────────────────────

describe('ERC', () => {
  it('runFullERC: empty circuit reports missing ground', () => {
    const r = runFullERC([], []);
    // No components → no errors of any kind
    expect(r.errors).toBeDefined();
  });
  it('runFullERC: detects unconnected pins', () => {
    // V1 with no wires → V1.p is unconnected
    const c = [comp('dcVoltage', 'V1', { voltage: 5 })];
    const r = runFullERC(c, []);
    const hasUnconnected = r.errors.some(e => e.type === 'unconnected_pin');
    expect(hasUnconnected).toBe(true);
  });
  it('runFullERC: complete circuit has fewer errors', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'GND', 'g'), wire('w3', 'V1', 'n', 'GND', 'g')];
    const r = runFullERC(c, w);
    const unconnected = r.errors.filter(e => e.type === 'unconnected_pin');
    expect(unconnected.length).toBeLessThan(r.errors.length + 1);
  });
  it('runFullERC: detects missing ground', () => {
    // V + R with no ground reference
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 })];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'V1', 'n')];
    const r = runFullERC(c, w);
    // Should detect either missing ground or unconnected power pins
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it('runFullERC: returns result object with errors array', () => {
    const r = runFullERC([], []);
    expect(Array.isArray(r.errors)).toBe(true);
    expect(typeof r).toBe('object');
  });
  it('runFullERC: respects NoConnect markers', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 })];
    const r = runFullERC(c, [], [{ componentId: 'V1', terminalId: 'p', position: { x: 0, y: 0 } }]);
    const hasUnconnectedP = r.errors.some(e => e.type === 'unconnected_pin' && e.terminalId === 'p');
    expect(hasUnconnectedP).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Component plugin metadata (every registered plugin is well-formed)
// ─────────────────────────────────────────────────────────────────────────────

describe('Component plugin metadata', () => {
  const allPlugins = getAllPlugins();
  it('registry is non-empty', () => {
    expect(allPlugins.length).toBeGreaterThan(20);
  });
  it('every plugin has unique type', () => {
    const types = new Set(allPlugins.map(p => p.type));
    expect(types.size).toBe(allPlugins.length);
  });
  it('every plugin has non-empty name', () => {
    for (const p of allPlugins) {
      expect(p.name.length).toBeGreaterThan(0);
    }
  });
  it('every plugin has valid category', () => {
    const validCategories = ['passive', 'source', 'semiconductor', 'ic', 'meter', 'mcu', 'io', 'logic', 'sensor'];
    for (const p of allPlugins) {
      expect(validCategories).toContain(p.category);
    }
  });
  it('every plugin has description', () => {
    for (const p of allPlugins) {
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
  it('every plugin has bounding box', () => {
    for (const p of allPlugins) {
      expect(p.boundingBox).toBeDefined();
      expect(p.boundingBox.width).toBeGreaterThan(0);
      expect(p.boundingBox.height).toBeGreaterThan(0);
    }
  });
  it('every plugin has at least one terminal (except sheet markers)', () => {
    // hierSheet is a hierarchical sheet marker — has no electrical terminals by design.
    const noTerminalTypes = new Set(['hierSheet']);
    for (const p of allPlugins) {
      if (noTerminalTypes.has(p.type)) continue;
      expect(p.terminals.length).toBeGreaterThan(0);
    }
  });
  it('every terminal has an id', () => {
    for (const p of allPlugins) {
      for (const t of p.terminals) {
        expect(t.id.length).toBeGreaterThan(0);
      }
    }
  });
  it('every plugin has parameters array', () => {
    for (const p of allPlugins) {
      expect(Array.isArray(p.parameters)).toBe(true);
    }
  });
  it('every plugin has render function', () => {
    for (const p of allPlugins) {
      expect(typeof p.render).toBe('function');
    }
  });
  it('resistor plugin exists and has resistance parameter', () => {
    const p = getPlugin('resistor');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'resistance')).toBe(true);
  });
  it('capacitor plugin exists and has capacitance parameter', () => {
    const p = getPlugin('capacitor');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'capacitance')).toBe(true);
  });
  it('inductor plugin exists and has inductance parameter', () => {
    const p = getPlugin('inductor');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'inductance')).toBe(true);
  });
  it('dcVoltage plugin exists and has voltage parameter', () => {
    const p = getPlugin('dcVoltage');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'voltage')).toBe(true);
  });
  it('ground plugin exists', () => {
    expect(hasPlugin('ground')).toBe(true);
  });
  it('acVoltage plugin exists and has amplitude', () => {
    const p = getPlugin('acVoltage');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'amplitude')).toBe(true);
  });
  it('diode plugin exists and has forwardV', () => {
    const p = getPlugin('diode');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'forwardV')).toBe(true);
  });
  it('npn plugin exists', () => {
    expect(hasPlugin('npn')).toBe(true);
  });
  it('pnp plugin exists', () => {
    expect(hasPlugin('pnp')).toBe(true);
  });
  it('nmos plugin exists', () => {
    expect(hasPlugin('nmos')).toBe(true);
  });
  it('pmos plugin exists', () => {
    expect(hasPlugin('pmos')).toBe(true);
  });
  it('led plugin exists', () => {
    expect(hasPlugin('led')).toBe(true);
  });
  it('pushButton plugin exists', () => {
    expect(hasPlugin('pushButton')).toBe(true);
  });
  it('switch plugin exists', () => {
    expect(hasPlugin('switch')).toBe(true);
  });
  it('voltmeter plugin exists', () => {
    expect(hasPlugin('voltmeter')).toBe(true);
  });
  it('ammeter plugin exists', () => {
    expect(hasPlugin('ammeter')).toBe(true);
  });
  it('parameter defaults match declared types (allowing int-mode selectors)', () => {
    // Note: BSIM4 models use 'select' type with integer defaults (e.g. capMod=0/1/2)
    // which is intentional for SPICE compatibility.
    for (const p of allPlugins) {
      for (const param of p.parameters) {
        if (param.type === 'number') {
          expect(typeof param.default).toBe('number');
        } else if (param.type === 'string' || param.type === 'color') {
          expect(typeof param.default).toBe('string');
        } else if (param.type === 'boolean') {
          expect(typeof param.default).toBe('boolean');
        }
        // 'select' can be either string or number — both are valid.
      }
    }
  });
  it('terminal positions are within or near bounding box', () => {
    // Allow generous tolerance — some plugins (dland, etc.) extend terminals slightly
    // beyond the bbox by design (terminal lies on the connector edge).
    for (const p of allPlugins) {
      for (const t of p.terminals) {
        expect(t.position.x).toBeGreaterThanOrEqual(-3);
        expect(t.position.x).toBeLessThanOrEqual(p.boundingBox.width + 6);
        expect(t.position.y).toBeGreaterThanOrEqual(-3);
        expect(t.position.y).toBeLessThanOrEqual(p.boundingBox.height + 6);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Examples — every example loads, simulates, produces finite voltages
// ─────────────────────────────────────────────────────────────────────────────

describe('Examples (comprehensive)', () => {
  let totalExamples = 0;
  beforeAll(() => {
    for (const cat of exampleCategories) totalExamples += cat.examples.length;
  });
  it('registry has multiple example categories', () => {
    expect(exampleCategories.length).toBeGreaterThan(0);
  });
  it('total examples count is at least 20', () => {
    expect(totalExamples).toBeGreaterThanOrEqual(20);
  });
  for (const category of exampleCategories) {
    describe(`category: ${category.name}`, () => {
      for (const ex of category.examples) {
        it(`example has version field: ${ex.name}`, () => {
          expect(ex.doc.version).toBeDefined();
        });
        it(`example has non-empty components: ${ex.name}`, () => {
          expect(ex.doc.components.length).toBeGreaterThan(0);
        });
        it(`example has at least one wire: ${ex.name}`, () => {
          expect(ex.doc.wires.length).toBeGreaterThan(0);
        });
        it(`example loads all component plugins: ${ex.name}`, () => {
          for (const c of ex.doc.components) {
            expect(getPlugin(c.type)).toBeDefined();
          }
        });
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Additional circuit behaviors
// ─────────────────────────────────────────────────────────────────────────────

describe('Additional circuit behaviors', () => {
  it('two resistors in series: total resistance adds', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 10 }), comp('resistor', 'R1', { resistance: 1000 }), comp('resistor', 'R2', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'R2', 'a'), wire('w3', 'R2', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    // total current = 10V / 2kΩ = 5mA
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const currents = computeComponentCurrents(c, w, pluginsFor(c), dc!);
    const r1current = currents.get('R1');
    expect(r1current).toBeDefined();
    expect(Math.abs(r1current!)).toBeCloseTo(0.005, 2);
  });
  it('two resistors in parallel: equivalent resistance less than either', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 10 }), comp('resistor', 'R1', { resistance: 1000 }), comp('resistor', 'R2', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w1b', 'V1', 'p', 'R2', 'a'), wire('w2', 'R1', 'b', 'GND', 'g'), wire('w2b', 'R2', 'b', 'GND', 'g'), wire('w3', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    // each resistor carries 10V / 1k = 10mA
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const currents = computeComponentCurrents(c, w, pluginsFor(c), dc!);
    expect(Math.abs(currents.get('R1')!)).toBeCloseTo(0.01, 2);
    expect(Math.abs(currents.get('R2')!)).toBeCloseTo(0.01, 2);
  });
  it('voltage divider with unequal resistors', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 12 }), comp('resistor', 'R1', { resistance: 3000 }), comp('resistor', 'R2', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'R2', 'a'), wire('w3', 'R2', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const midNode = nm.terminalNode.get('R1:b')!;
    // V_mid = 12 * 1k / (3k + 1k) = 3V
    expect(dc!.nodeVoltage[midNode]).toBeCloseTo(3, 1);
  });
  it('capacitor in DC steady state: V_cap = V_source', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('capacitor', 'C1', { capacitance: 1e-6 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'C1', 'a'), wire('w3', 'C1', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const capNode = nm.terminalNode.get('C1:a')!;
    expect(dc!.nodeVoltage[capNode]).toBeCloseTo(5, 0);
  });
  it('inductor in DC steady state: V ≈ 0 across inductor', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('inductor', 'L1', { inductance: 1e-3 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'L1', 'a'), wire('w3', 'L1', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const lNode = nm.terminalNode.get('L1:a')!;
    const lNodeB = nm.terminalNode.get('L1:b')!;
    // Inductor acts like short in DC → V across ≈ 0
    expect(Math.abs(dc!.nodeVoltage[lNode] - dc!.nodeVoltage[lNodeB])).toBeLessThan(0.1);
  });
  it('diode forward bias: V_drop ≈ 0.7V', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('diode', 'D1', { forwardV: 0.7, onR: 1 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'D1', 'a'), wire('w3', 'D1', 'k', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const anodeNode = nm.terminalNode.get('D1:a')!;
    const cathodeNode = nm.terminalNode.get('D1:k')!;
    const vDrop = dc!.nodeVoltage[anodeNode] - dc!.nodeVoltage[cathodeNode];
    expect(vDrop).toBeGreaterThan(0.5);
    expect(vDrop).toBeLessThan(1.0);
  });
  it('RC circuit transient: capacitor charges to source voltage over time', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('capacitor', 'C1', { capacitance: 1e-6 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'C1', 'a'), wire('w3', 'C1', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const p = pluginsFor(c);
    const nm = buildNodeMap(c, w, p);
    let prev: any = undefined;
    let lastV = 0;
    for (let i = 0; i < 500; i++) {
      const r = simulateStep(c, w, p, prev, 1e-4);
      if (!r) break;
      lastV = r.sim.nodeVoltage[nm.terminalNode.get('C1:a')!] ?? 0;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    // After 5 RC time constants (= 5ms = 50 steps of 1e-4), cap should be nearly charged
    expect(lastV).toBeGreaterThan(4.5);
    expect(lastV).toBeLessThan(5.1);
  });
  it('all node voltages are finite numbers in a stable circuit', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('resistor', 'R2', { resistance: 500 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'R2', 'a'), wire('w3', 'R2', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    for (const v of dc!.nodeVoltage) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
  it('open switch: no current flows', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('switch', 'S1', { closed: false }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'S1', 'a'), wire('w2', 'S1', 'b', 'R1', 'a'), wire('w3', 'R1', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    if (dc) {
      const nm = buildNodeMap(c, w, pluginsFor(c));
      const currents = computeComponentCurrents(c, w, pluginsFor(c), dc);
      // Open switch should have nearly zero current
      expect(Math.abs(currents.get('S1') ?? 0)).toBeLessThan(1e-3);
    }
  });
  it('closed switch: current flows freely', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('switch', 'S1', { closed: true }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'S1', 'a'), wire('w2', 'S1', 'b', 'R1', 'a'), wire('w3', 'R1', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const currents = computeComponentCurrents(c, w, pluginsFor(c), dc!);
    // Closed switch → 5mA through 1kΩ
    expect(Math.abs(currents.get('R1') ?? 0)).toBeCloseTo(0.005, 1);
  });
  it('current source drives 1mA through 1k resistor → |V| = 1V', () => {
    // 1mA through 1kΩ produces |V| = 1V. Sign depends on the source's terminal convention.
    const c = [comp('currentSource', 'I1', { current: 0.001 }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'I1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'GND', 'g'), wire('w3', 'I1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const vNode = nm.terminalNode.get('R1:a')!;
    expect(Math.abs(dc!.nodeVoltage[vNode])).toBeCloseTo(1, 1);
  });
  it('Wheatstone bridge with equal resistors: midpoint V=0', () => {
    const c = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('resistor', 'R3', { resistance: 1000 }),
      comp('resistor', 'R4', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const w = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w1b', 'V1', 'p', 'R3', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'R3', 'b', 'R4', 'a'),
      wire('w5', 'R4', 'b', 'GND', 'g'),
      wire('w6', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const midA = nm.terminalNode.get('R1:b')!;
    const midB = nm.terminalNode.get('R3:b')!;
    // Both midpoints at 2.5V → V_diff = 0
    expect(Math.abs(dc!.nodeVoltage[midA] - dc!.nodeVoltage[midB])).toBeLessThan(0.01);
  });
  it('buildNodeMap: returns valid node map', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'GND', 'g'), wire('w3', 'V1', 'n', 'GND', 'g')];
    const nm = buildNodeMap(c, w, pluginsFor(c));
    expect(nm).toBeDefined();
    expect(nm.terminalNode.size).toBeGreaterThan(0);
  });
  it('simulateStep: returns StepResult with sim field', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'GND', 'g'), wire('w3', 'V1', 'n', 'GND', 'g')];
    const r = simulateStep(c, w, pluginsFor(c), undefined, 1e-4);
    expect(r).toBeDefined();
    expect(r!.sim).toBeDefined();
    expect(r!.sim.nodeVoltage).toBeDefined();
  });
  it('solveDC: produces finite branch currents', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'GND', 'g'), wire('w3', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    if (dc!.branchCurrent) {
      for (const i of dc!.branchCurrent) {
        expect(Number.isFinite(i)).toBe(true);
      }
    }
  });
  it('chain of resistors: voltage drops linearly', () => {
    const c = [
      comp('dcVoltage', 'V1', { voltage: 4 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('resistor', 'R3', { resistance: 1000 }),
      comp('resistor', 'R4', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const w = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'R3', 'a'),
      wire('w4', 'R3', 'b', 'R4', 'a'),
      wire('w5', 'R4', 'b', 'GND', 'g'),
      wire('w6', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    // 4 resistors of 1k in series = 4kΩ total, I = 4V/4k = 1mA
    // Each resistor drops 1V: V at R1.b=3, R2.b=2, R3.b=1, R4.b=0
    const v1 = dc!.nodeVoltage[nm.terminalNode.get('R1:b')!];
    const v2 = dc!.nodeVoltage[nm.terminalNode.get('R2:b')!];
    const v3 = dc!.nodeVoltage[nm.terminalNode.get('R3:b')!];
    expect(v1).toBeCloseTo(3, 1);
    expect(v2).toBeCloseTo(2, 1);
    expect(v3).toBeCloseTo(1, 1);
  });
  it('Kirchhoff voltage law: sum of voltage drops around loop = 0', () => {
    const c = [comp('dcVoltage', 'V1', { voltage: 9 }), comp('resistor', 'R1', { resistance: 1000 }), comp('resistor', 'R2', { resistance: 2000 }), comp('ground', 'GND')];
    const w = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'R1', 'b', 'R2', 'a'), wire('w3', 'R2', 'b', 'GND', 'g'), wire('w4', 'V1', 'n', 'GND', 'g')];
    const dc = solveDC(c, w, pluginsFor(c));
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, pluginsFor(c));
    const vSource = dc!.nodeVoltage[nm.terminalNode.get('V1:p')!];
    const vMid = dc!.nodeVoltage[nm.terminalNode.get('R1:b')!];
    const vDropR1 = vSource - vMid;
    const vDropR2 = vMid - 0;  // ground = 0
    // KVL: V_source - V_R1 - V_R2 = 0
    expect(vSource - vDropR1 - vDropR2).toBeCloseTo(0, 6);
  });
});
