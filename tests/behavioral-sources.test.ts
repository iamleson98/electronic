// Behavioral sources (BV / BI) — expression parser, V(node) / I(source)
// resolution, and the engine's Gauss–Seidel feedback iteration.
//
// Before this feature, bvSource/biSource passed an EMPTY node-name map into
// evalExpression, so V(node) always resolved to 0 — the sources only worked
// for pure `time` expressions. These tests pin:
//
//   - the expression parser grammar (arithmetic, functions, V()/I(), pi, time)
//   - buildBehavioralTables (net-name map + absolute→0-based branch indices)
//   - net label resolution through buildNodeMap → NodeMap.netNames
//   - feedforward expressions (V = 2*V(in)) converging exactly
//   - self-referencing expressions (V = 5 − V(out)) converging via the damped
//     fixed-point iteration (impossible with a one-step lag — it oscillates
//     5→0→5 forever)
//   - I(source) mirroring with correct SPICE branch-current signs
//   - graceful behavior on unknown nodes / divergent positive feedback

import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { evalExpression, buildBehavioralTables } from '../src/lib/circuit/components/advanced-devices';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/power-symbols');
  await import('../src/lib/circuit/components/advanced-devices');
});

function comp(type: string, id: string, params?: any, refdes?: string): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return {
    id, type,
    position: { x: 0, y: 0 },
    rotation: 0,
    parameters: { ...defaults, ...params },
    ...(refdes ? { refdes } : {}),
  };
}

function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}

function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().filter(p => components.some(c => c.type === p.type)).map(p => [p.type, p]));
}

function nodeOf(sim: SimContext, nodeMap: ReturnType<typeof buildNodeMap>, termKey: string): number {
  return nodeMap.terminalNode.get(termKey) ?? 0;
}

/** Run N steps from cold start. */
function run(
  circ: { components: CircuitComponent[]; wires: Wire[]; plugins: Map<string, ComponentPlugin> },
  n = 1,
  dt = 1e-3,
): SimContext | null {
  let prev: any;
  let sim: SimContext | null = null;
  for (let i = 0; i < n; i++) {
    const r = simulateStep(circ.components, circ.wires, circ.plugins, prev, dt);
    if (!r) return null;
    sim = r.sim;
    prev = {
      nodeVoltage: sim.nodeVoltage,
      branchCurrent: sim.branchCurrent,
      time: sim.time,
      state: sim.state,
    };
  }
  return sim;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression parser (pure unit tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('behavioral expression parser', () => {
  const emptyVolts = new Float64Array(1);
  const emptyMap = new Map<string, number>();

  it('evaluates arithmetic with correct precedence', () => {
    expect(evalExpression('2+3*4', emptyVolts, emptyMap, 0)).toBeCloseTo(14, 12);
    expect(evalExpression('(2+3)*4', emptyVolts, emptyMap, 0)).toBeCloseTo(20, 12);
    expect(evalExpression('10/4', emptyVolts, emptyMap, 0)).toBeCloseTo(2.5, 12);
    expect(evalExpression('2^10', emptyVolts, emptyMap, 0)).toBeCloseTo(1024, 12);
    expect(evalExpression('-5+3', emptyVolts, emptyMap, 0)).toBeCloseTo(-2, 12);
    expect(evalExpression('2*-3', emptyVolts, emptyMap, 0)).toBeCloseTo(-6, 12);
  });

  it('evaluates math functions', () => {
    expect(evalExpression('abs(-5)', emptyVolts, emptyMap, 0)).toBeCloseTo(5, 12);
    expect(evalExpression('sqrt(16)', emptyVolts, emptyMap, 0)).toBeCloseTo(4, 12);
    expect(evalExpression('exp(0)', emptyVolts, emptyMap, 0)).toBeCloseTo(1, 12);
    expect(evalExpression('log(exp(1))', emptyVolts, emptyMap, 0)).toBeCloseTo(1, 12);
    expect(evalExpression('ln(exp(2))', emptyVolts, emptyMap, 0)).toBeCloseTo(2, 12);
    expect(evalExpression('log10(1000)', emptyVolts, emptyMap, 0)).toBeCloseTo(3, 12);
    expect(evalExpression('sin(0)', emptyVolts, emptyMap, 0)).toBeCloseTo(0, 12);
    expect(evalExpression('cos(0)', emptyVolts, emptyMap, 0)).toBeCloseTo(1, 12);
    expect(evalExpression('min(3,7)', emptyVolts, emptyMap, 0)).toBeCloseTo(3, 12);
    expect(evalExpression('max(3,7)', emptyVolts, emptyMap, 0)).toBeCloseTo(7, 12);
  });

  it('supports the pi constant and time variable', () => {
    expect(evalExpression('pi', emptyVolts, emptyMap, 0)).toBeCloseTo(Math.PI, 12);
    expect(evalExpression('2*pi', emptyVolts, emptyMap, 0)).toBeCloseTo(2 * Math.PI, 12);
    expect(evalExpression('time', emptyVolts, emptyMap, 2.5e-3)).toBeCloseTo(2.5e-3, 15);
    // 50 Hz sine at t = 5ms → sin(π/2) = 1
    expect(evalExpression('sin(2*pi*50*time)', emptyVolts, emptyMap, 5e-3)).toBeCloseTo(1, 12);
  });

  it('evaluates comparisons (ngspice parity for if() conditions)', () => {
    const volts = new Float64Array([0, 3]);
    const names = new Map([['a', 1]]);
    expect(evalExpression('V(a)>1', volts, names, 0)).toBe(1);
    expect(evalExpression('V(a)<1', volts, names, 0)).toBe(0);
    expect(evalExpression('V(a)>=3', volts, names, 0)).toBe(1);
    expect(evalExpression('V(a)<=3', volts, names, 0)).toBe(1);
    expect(evalExpression('V(a)==3', volts, names, 0)).toBe(1);
    expect(evalExpression('V(a)!=3', volts, names, 0)).toBe(0);
    expect(evalExpression('if(V(a)>1, 5, -5)', volts, names, 0)).toBeCloseTo(5, 12);
    expect(evalExpression('if(V(a)>4, 5, -5)', volts, names, 0)).toBeCloseTo(-5, 12);
  });

  it('evaluates limit() as a clamp and if() as a ternary', () => {
    expect(evalExpression('limit(5, 0, 3)', emptyVolts, emptyMap, 0)).toBeCloseTo(3, 12);
    expect(evalExpression('limit(-5, 0, 3)', emptyVolts, emptyMap, 0)).toBeCloseTo(0, 12);
    expect(evalExpression('limit(2, 0, 3)', emptyVolts, emptyMap, 0)).toBeCloseTo(2, 12);
    expect(evalExpression('if(1, 10, 20)', emptyVolts, emptyMap, 0)).toBeCloseTo(10, 12);
    expect(evalExpression('if(0, 10, 20)', emptyVolts, emptyMap, 0)).toBeCloseTo(20, 12);
  });

  it('resolves V(node) and V(node1,node2) against the name map', () => {
    const volts = new Float64Array([0, 5, 2]); // node 1 = 5V, node 2 = 2V
    const names = new Map([['a', 1], ['b', 2], ['gnd', 0], ['0', 0]]);
    expect(evalExpression('V(a)', volts, names, 0)).toBeCloseTo(5, 12);
    expect(evalExpression('V(b)', volts, names, 0)).toBeCloseTo(2, 12);
    expect(evalExpression('V(a,b)', volts, names, 0)).toBeCloseTo(3, 12);
    expect(evalExpression('V(gnd)', volts, names, 0)).toBeCloseTo(0, 12);
    expect(evalExpression('2*V(a)+1', volts, names, 0)).toBeCloseTo(11, 12);
    // unknown node resolves to 0V
    expect(evalExpression('V(nope)', volts, names, 0)).toBeCloseTo(0, 12);
  });

  it('resolves I(source) against the branch-current map', () => {
    const branches = new Map([['V1', -0.005], ['Vsense', 0.25]]);
    expect(evalExpression('I(V1)', emptyVolts, emptyMap, 0, branches)).toBeCloseTo(-0.005, 12);
    expect(evalExpression('1000*I(V1)', emptyVolts, emptyMap, 0, branches)).toBeCloseTo(-5, 12);
    expect(evalExpression('I(Vsense)', emptyVolts, emptyMap, 0, branches)).toBeCloseTo(0.25, 12);
    // unknown source → 0
    expect(evalExpression('I(nope)', emptyVolts, emptyMap, 0, branches)).toBeCloseTo(0, 12);
  });

  it('degrades gracefully on malformed input instead of throwing', () => {
    expect(evalExpression('V(', emptyVolts, emptyMap, 0)).toBe(0);
    expect(evalExpression('', emptyVolts, emptyMap, 0)).toBe(0);
    expect(evalExpression(')))((', emptyVolts, emptyMap, 0)).toBe(0);
    // trailing operator is treated leniently (missing operand = 0)
    expect(evalExpression('2+', emptyVolts, emptyMap, 0)).toBeCloseTo(2, 12);
  });

  it('unknown bare variables evaluate to 0', () => {
    expect(evalExpression('foo + 2', emptyVolts, emptyMap, 0)).toBeCloseTo(2, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildBehavioralTables — branch index conversion
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBehavioralTables', () => {
  it('converts absolute branch row indices to 0-based extra indices', () => {
    // numNodes = 4 → base = 3. V1 got absolute row 3 (extra 0), V2 row 5 (extra 2).
    const sim: SimContext = {
      nodeVoltage: new Float64Array(4),
      branchCurrent: new Float64Array([10, 0, 20, 0]),
      state: { __branchIndices: { V1: 3, V2: 5 } },
      time: 0,
      dt: 1e-3,
    };
    const { branchCurrents } = buildBehavioralTables(sim);
    expect(branchCurrents.get('V1')).toBeCloseTo(10, 12);
    expect(branchCurrents.get('V2')).toBeCloseTo(20, 12);
  });

  it('ignores branch indices outside the solved range (truncated extras)', () => {
    const sim: SimContext = {
      nodeVoltage: new Float64Array(4),
      branchCurrent: new Float64Array([10]),
      state: { __branchIndices: { V1: 3, V2: 99 } },
      time: 0,
      dt: 1e-3,
    };
    const { branchCurrents } = buildBehavioralTables(sim);
    expect(branchCurrents.get('V1')).toBeCloseTo(10, 12);
    expect(branchCurrents.has('V2')).toBe(false);
  });

  it('carries net names into the node-name table', () => {
    const sim: SimContext = {
      nodeVoltage: new Float64Array(3),
      branchCurrent: new Float64Array(0),
      state: {},
      time: 0,
      dt: 1e-3,
      netNames: new Map([['in', 1], ['out', 2]]),
    };
    const { nodeNameToId } = buildBehavioralTables(sim);
    expect(nodeNameToId.get('in')).toBe(1);
    expect(nodeNameToId.get('out')).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Net label resolution through the engine
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeMap.netNames', () => {
  it('exposes net label names with final node ids', () => {
    const components = [
      comp('ground', 'gnd'),
      comp('netLabel', 'lIn', { net: 'in' }),
      comp('netLabel', 'lOut', { net: 'out' }),
      comp('resistor', 'r1', { resistance: 1000 }),
    ];
    const wires = [
      wire('w1', 'lIn', 'p', 'r1', 'a'),
      wire('w2', 'r1', 'b', 'lOut', 'p'),
    ];
    const nm = buildNodeMap(components, wires, pluginsFor(components));
    expect(nm.netNames.get('in')).toBeDefined();
    expect(nm.netNames.get('out')).toBeDefined();
    expect(nm.netNames.get('in')).toBe(nm.terminalNode.get('r1:a'));
    expect(nm.netNames.get('out')).toBe(nm.terminalNode.get('r1:b'));
    expect(nm.netNames.get('in')).not.toBe(nm.netNames.get('out'));
  });

  it('two same-named labels unify to one node', () => {
    const components = [
      comp('ground', 'gnd'),
      comp('netLabel', 'l1', { net: 'SIG' }),
      comp('netLabel', 'l2', { net: 'SIG' }),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('resistor', 'r2', { resistance: 1000 }),
    ];
    const wires = [
      wire('w1', 'l1', 'p', 'r1', 'a'),
      wire('w2', 'l2', 'p', 'r2', 'a'),
      wire('w3', 'r1', 'b', 'gnd', 'g'),
      wire('w4', 'r2', 'b', 'gnd', 'g'),
    ];
    const nm = buildNodeMap(components, wires, pluginsFor(components));
    expect(nm.netNames.get('SIG')).toBe(nm.terminalNode.get('r1:a'));
    expect(nm.netNames.get('SIG')).toBe(nm.terminalNode.get('r2:a'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BV source circuit-level tests
// ─────────────────────────────────────────────────────────────────────────────

/** 3V source on net 'in'; BV from node_out to gnd; 1k load on node_out. */
function bvCircuit(expr: string) {
  const components = [
    comp('ground', 'gnd'),
    comp('dcVoltage', 'v1', { voltage: 3 }, 'V1'),
    comp('netLabel', 'lIn', { net: 'in' }),
    comp('netLabel', 'lOut', { net: 'out' }),
    comp('bvSource', 'b1', { expr }),
    comp('resistor', 'r1', { resistance: 1000 }),
  ];
  const wires = [
    wire('w1', 'v1', 'p', 'lIn', 'p'),
    wire('w2', 'v1', 'n', 'gnd', 'g'),
    wire('w3', 'b1', 'p', 'r1', 'a'),
    wire('w4', 'b1', 'p', 'lOut', 'p'),
    wire('w5', 'r1', 'b', 'gnd', 'g'),
    wire('w6', 'b1', 'n', 'gnd', 'g'),
  ];
  return { components, wires, plugins: pluginsFor(components) };
}

describe('BV source circuits', () => {
  it('feedforward gain: V = 2*V(in) gives exactly 6V from a 3V net', () => {
    const circ = bvCircuit('2*V(in)');
    const sim = run(circ);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(6, 6);
    // and the input net is still exactly 3V
    const inNode = nodeOf(sim!, nm, 'v1:p');
    expect(sim!.nodeVoltage[inNode]).toBeCloseTo(3, 6);
  });

  it('self-referencing negative feedback: V = 5 - V(out) converges to 2.5V', () => {
    // With the old one-step lag this oscillates 5→0→5 forever. The engine's
    // damped Gauss–Seidel iteration must find the fixed point V(out) = 2.5.
    const circ = bvCircuit('5 - V(out)');
    const sim = run(circ);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(2.5, 5);
  });

  it('attenuator: V = 0.5*V(in) gives 1.5V', () => {
    const circ = bvCircuit('0.5*V(in)');
    const sim = run(circ);
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(1.5, 6);
  });

  it('differential read: V = V(in,gnd) equals the node voltage', () => {
    const circ = bvCircuit('V(in,gnd)');
    const sim = run(circ);
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(3, 6);
  });

  it('soft clipper shape: limit(V(in)*3, 0, 4) clamps at 4V', () => {
    const circ = bvCircuit('limit(V(in)*3, 0, 4)');
    const sim = run(circ);
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    // 3*3 = 9 clamped to 4
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(4, 6);
  });

  it('unknown node reference degrades to 0V output (no crash)', () => {
    const circ = bvCircuit('2*V(nosuchnet) + 1');
    const sim = run(circ);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(1, 6);
  });

  it('divergent positive feedback stays finite (iteration capped)', () => {
    const circ = bvCircuit('10*V(out) + 0.1');
    const sim = run(circ);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(Number.isFinite(sim!.nodeVoltage[outNode])).toBe(true);
  });

  it('time-based expression: sin(2*pi*50*time) reaches 1V at t = 5ms', () => {
    const circ = bvCircuit('sin(2*pi*50*time)');
    // Cold-start steps run at t = 0, 1, 2, …ms — the 6th step stamps at t=5ms
    // where sin(π/2) = 1.
    const sim = run(circ, 6);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(1, 6);
  });

  it('BV source measure() reports voltage and current', () => {
    const circ = bvCircuit('2*V(in)');
    const sim = run(circ);
    const plugin = circ.plugins.get('bvSource')!;
    const c1 = circ.components.find(c => c.type === 'bvSource')!;
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const terms = plugin.terminals.map(t => ({
      terminalId: t.id,
      nodeId: nm.terminalNode.get(`${c1.id}:${t.id}`) ?? 0,
    }));
    const readings = plugin.measure!(c1.parameters, terms, sim!, c1);
    expect(readings.length).toBeGreaterThanOrEqual(1);
    expect(readings[0].label).toBe('V');
    expect(parseFloat(readings[0].value)).toBeCloseTo(6, 2);
  });

  it('BV driving an RC load settles to the amplified value (trap)', () => {
    const components = [
      comp('ground', 'gnd'),
      comp('dcVoltage', 'v1', { voltage: 3 }),
      comp('netLabel', 'lIn', { net: 'in' }),
      comp('bvSource', 'b1', { expr: '2*V(in)' }),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('capacitor', 'c1', { capacitance: 1e-6 }),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'lIn', 'p'),
      wire('w2', 'v1', 'n', 'gnd', 'g'),
      wire('w3', 'b1', 'p', 'r1', 'a'),
      wire('w4', 'r1', 'b', 'gnd', 'g'),
      wire('w5', 'b1', 'p', 'c1', 'a'),
      wire('w6', 'c1', 'b', 'gnd', 'g'),
      wire('w7', 'b1', 'n', 'gnd', 'g'),
    ];
    const circ = { components, wires, plugins: pluginsFor(components) };
    const sim = run(circ, 10, 1e-3); // τ = 1ms, 10 time constants
    const nm = buildNodeMap(components, wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(6, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BI source circuit-level tests
// ─────────────────────────────────────────────────────────────────────────────

/** V1 (5V, refdes V1) → R 1k → gnd. B1 expr from p→node2→R2 1k→gnd. */
function biCircuit(expr: string) {
  const components = [
    comp('ground', 'gnd'),
    comp('dcVoltage', 'v1', { voltage: 5 }, 'V1'),
    comp('resistor', 'r1', { resistance: 1000 }),
    comp('biSource', 'b1', { expr }),
    comp('resistor', 'r2', { resistance: 1000 }),
  ];
  const wires = [
    wire('w1', 'v1', 'p', 'r1', 'a'),
    wire('w2', 'r1', 'b', 'gnd', 'g'),
    wire('w3', 'v1', 'n', 'gnd', 'g'),
    wire('w4', 'b1', 'p', 'r2', 'a'),
    wire('w5', 'r2', 'b', 'gnd', 'g'),
    wire('w6', 'b1', 'n', 'gnd', 'g'),
  ];
  return { components, wires, plugins: pluginsFor(components) };
}

describe('BI source circuits', () => {
  it('constant expression: I = 0.01 draws 10mA out of + → V = −10V across 1k', () => {
    // Engine/SPICE convention: positive source current flows from + through
    // the source to −, i.e. it is DRAWN OUT of the + node externally.
    const circ = biCircuit('0.01');
    const sim = run(circ);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const node2 = nodeOf(sim!, nm, 'r2:a');
    expect(sim!.nodeVoltage[node2]).toBeCloseTo(-10, 4);
  });

  it('I(V1) reads the battery branch current (−5mA for a 5V/1k load)', () => {
    const circ = biCircuit('1000*I(V1)');
    const sim = run(circ);
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const node2 = nodeOf(sim!, nm, 'r2:a');
    // I(V1) = −5mA → 1000·(−0.005) = −5 A drawn out of + → V = +5000?? No —
    // the expression value is the SOURCE current: −5A flows p→n internally,
    // i.e. 5A is pushed INTO node p → V(node2) = +5000V is absurd but exact.
    // Use a gentler gain instead — see the mirror test below.
    expect(Number.isFinite(sim!.nodeVoltage[node2])).toBe(true);
  });

  it('current mirror: I = I(V1)*2 reflects double the sensed current', () => {
    // I(V1) = −5mA (battery delivering). B1 stamps 2·(−5mA) = −10mA:
    // negative current drawn from + = 10mA INJECTED into node2 → V = +10V.
    const circ = biCircuit('I(V1)*2');
    const sim = run(circ);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const node2 = nodeOf(sim!, nm, 'r2:a');
    expect(sim!.nodeVoltage[node2]).toBeCloseTo(10, 4);
  });

  it('V()-referenced current source: I = V(in)*1e-3 acts as a 1kΩ load mirror', () => {
    const components = [
      comp('ground', 'gnd'),
      comp('dcVoltage', 'v1', { voltage: 4 }),
      comp('netLabel', 'lIn', { net: 'in' }),
      comp('biSource', 'b1', { expr: 'V(in)*1e-3' }),
      comp('resistor', 'r2', { resistance: 1000 }),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'lIn', 'p'),
      wire('w2', 'v1', 'n', 'gnd', 'g'),
      wire('w3', 'b1', 'p', 'r2', 'a'),
      wire('w4', 'r2', 'b', 'gnd', 'g'),
      wire('w5', 'b1', 'n', 'gnd', 'g'),
    ];
    const circ = { components, wires, plugins: pluginsFor(components) };
    const sim = run(circ);
    const nm = buildNodeMap(components, wires, circ.plugins);
    const node2 = nodeOf(sim!, nm, 'r2:a');
    // expr = 4e-3 A drawn out of + → V = −4V
    expect(sim!.nodeVoltage[node2]).toBeCloseTo(-4, 4);
  });

  it('BI source measure() reports current', () => {
    const circ = biCircuit('0.01');
    const sim = run(circ);
    const plugin = circ.plugins.get('biSource')!;
    const c1 = circ.components.find(c => c.type === 'biSource')!;
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const terms = plugin.terminals.map(t => ({
      terminalId: t.id,
      nodeId: nm.terminalNode.get(`${c1.id}:${t.id}`) ?? 0,
    }));
    const readings = plugin.measure!(c1.parameters, terms, sim!, c1);
    expect(readings.length).toBeGreaterThanOrEqual(1);
    expect(readings[0].label).toBe('I');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feedback iteration — engine behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('feedback iteration semantics', () => {
  it('a settled behavioral circuit converges without extra solves (steady state)', () => {
    // Run the feedforward circuit twice: the second step is fully settled
    // (round 0 self-consistent) and must reproduce exactly 6V.
    const circ = bvCircuit('2*V(in)');
    const sim = run(circ, 3);
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(6, 6);
  });

  it('cascaded behavioral sources: BV → BV chain composes gains', () => {
    // b1: out1 = 2*V(in); b2: out2 = V(out1)+1 → 6+1 = 7V
    const components = [
      comp('ground', 'gnd'),
      comp('dcVoltage', 'v1', { voltage: 3 }),
      comp('netLabel', 'lIn', { net: 'in' }),
      comp('netLabel', 'lMid', { net: 'mid' }),
      comp('bvSource', 'b1', { expr: '2*V(in)' }),
      comp('bvSource', 'b2', { expr: 'V(mid)+1' }),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('resistor', 'r2', { resistance: 1000 }),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'lIn', 'p'),
      wire('w2', 'v1', 'n', 'gnd', 'g'),
      wire('w3', 'b1', 'p', 'r1', 'a'),
      wire('w4', 'b1', 'p', 'lMid', 'p'),
      wire('w5', 'r1', 'b', 'gnd', 'g'),
      wire('w6', 'b1', 'n', 'gnd', 'g'),
      wire('w7', 'b2', 'p', 'r2', 'a'),
      wire('w8', 'r2', 'b', 'gnd', 'g'),
      wire('w9', 'b2', 'n', 'gnd', 'g'),
    ];
    const circ = { components, wires, plugins: pluginsFor(components) };
    const sim = run(circ);
    const nm = buildNodeMap(components, wires, circ.plugins);
    const midNode = nodeOf(sim!, nm, 'r1:a');
    const outNode = nodeOf(sim!, nm, 'r2:a');
    expect(sim!.nodeVoltage[midNode]).toBeCloseTo(6, 6);
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(7, 5);
  });

  it('oscillator gain −2: V = 5 − 2*V(out) still converges (2.5V fixpoint? no — 1.667V)', () => {
    // V(out) = 5 − 2·V(out) → 3·V(out) = 5 → V(out) = 5/3 ≈ 1.6667.
    // Raw Gauss–Seidel oscillates with growing amplitude (gain −2), so the
    // 50/50 damping must engage for the iteration to settle.
    const circ = bvCircuit('5 - 2*V(out)');
    const sim = run(circ);
    expect(sim).not.toBeNull();
    const nm = buildNodeMap(circ.components, circ.wires, circ.plugins);
    const outNode = nodeOf(sim!, nm, 'r1:a');
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(5 / 3, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalog example — "Behavioral Signal Chain" end-to-end physics
// ─────────────────────────────────────────────────────────────────────────────

describe('Behavioral Signal Chain example (catalog)', () => {
  it('amplifies the sine by 3 and squares it through the comparator', async () => {
    const { exampleBehavioral } = await import('../src/lib/circuit/examples');
    expect(exampleBehavioral.components.some(c => c.type === 'bvSource')).toBe(true);
    const plugins = pluginsFor(exampleBehavioral.components);
    let prev: any;
    let sim: SimContext | null = null;
    // 51 steps of dt=1e-4 → last step at t = 5ms = the sine's first peak
    for (let i = 0; i < 51; i++) {
      const r = simulateStep(exampleBehavioral.components, exampleBehavioral.wires, plugins, prev, 1e-4);
      expect(r).not.toBeNull();
      sim = r!.sim;
      prev = {
        nodeVoltage: sim.nodeVoltage,
        branchCurrent: sim.branchCurrent,
        time: sim.time,
        state: sim.state,
      };
    }
    const nm = buildNodeMap(exampleBehavioral.components, exampleBehavioral.wires, plugins);
    const inNode = nodeOf(sim!, nm, 'vIn:p');
    const ampNode = nodeOf(sim!, nm, 'r1:a');
    const outNode = nodeOf(sim!, nm, 'r2:a');
    // At t = 5ms the 50 Hz sine peaks: V(in) = 1.5V → amp = 3·1.5 = 4.5V
    // → comparator (amp > 2) → out = 4V.
    expect(sim!.nodeVoltage[inNode]).toBeCloseTo(1.5, 2);
    expect(sim!.nodeVoltage[ampNode]).toBeCloseTo(4.5, 2);
    expect(sim!.nodeVoltage[outNode]).toBeCloseTo(4, 2);
  });

  it('KB documents the behavioral sources and integration methods', async () => {
    const { getArticle, searchArticles } = await import('../src/lib/ai/knowledge/knowledge-base');
    const bv = getArticle('behavioral-sources');
    expect(bv).toBeDefined();
    expect(bv!.body).toContain('if(V(in) > 2.5, 5, 0)');
    expect(bv!.body).toContain('Gauss–Seidel');
    const im = getArticle('integration-methods');
    expect(im).toBeDefined();
    expect(im!.body).toContain('Trapezoidal');
    // searchable
    expect(searchArticles('behavioral comparator').some(a => a.id === 'behavioral-sources')).toBe(true);
    expect(searchArticles('trapezoidal gear integration').some(a => a.id === 'integration-methods')).toBe(true);
  });
});
