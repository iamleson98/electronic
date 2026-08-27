// P3 logic IC tests: CD4027, CD4017, CD4060, CD4093, CD4511, 7490, 74164,
// 74245, 74374, 74HC4046.
//
// Sequential (clocked) behavior is tested by chaining simulateStep() calls
// with the previous step's {nodeVoltage, state} — the same mechanism the
// CD4026 and transmission-line tests use. Source levels are changed by
// mutating the dcVoltage `voltage` parameter between steps; an edge is seen
// by the IC's stamp one step after the new level is solved, so every level
// change is followed by (at least) two settle steps.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC, simulateStep, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import type { CircuitComponent, Wire, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(type: string, id: string, pos: [number, number], params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const pm of p.parameters) defaults[pm.key] = pm.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}
function plugins(): Map<string, any> {
  return new Map(getAllPlugins().map(p => [p.type, p]));
}

/** Voltage of a terminal, resolved through the (memoized) node map. */
function vOf(comps: CircuitComponent[], ws: Wire[], sim: SimContext, cid: string, tid: string): number {
  const map = buildNodeMap(comps, ws, plugins());
  const c = comps.find(x => x.id === cid)!;
  const p = getPlugin(c.type)!;
  const terms = getTerminalsForComponent(c, p, map);
  return sim.nodeVoltage[terms.find(t => t.terminalId === tid)?.nodeId ?? 0] ?? 0;
}

/**
 * Time-stepping driver: keeps the persistent state map and previous solution
 * across simulateStep() calls and lets tests change source levels mid-run.
 */
class Driver {
  comps: CircuitComponent[];
  ws: Wire[];
  prev: any = undefined;
  sim: SimContext | null = null;

  constructor(comps: CircuitComponent[], ws: Wire[]) {
    this.comps = comps;
    this.ws = ws;
  }

  step(dt = 1e-4): this {
    const r = simulateStep(this.comps, this.ws, plugins(), this.prev, dt);
    if (!r) throw new Error('simulateStep failed');
    this.sim = r.sim;
    this.prev = {
      nodeVoltage: r.sim.nodeVoltage,
      branchCurrent: r.sim.branchCurrent,
      time: r.sim.time,
      state: r.sim.state,
    };
    return this;
  }

  /** Let freshly changed source levels propagate and be seen by the stamps. */
  settle(n = 2, dt?: number): this {
    for (let i = 0; i < n; i++) this.step(dt);
    return this;
  }

  setV(id: string, volts: number): this {
    const c = this.comps.find(x => x.id === id);
    if (!c) throw new Error(`no source ${id}`);
    c.parameters.voltage = volts;
    return this;
  }

  /** Apply N full clock pulses (rising + falling) to a mutable dc source. */
  pulse(clkId: string, n = 1, dt?: number): this {
    for (let i = 0; i < n; i++) {
      this.setV(clkId, 5).settle(2, dt);
      this.setV(clkId, 0).settle(2, dt);
    }
    return this;
  }

  v(cid: string, tid: string): number {
    if (!this.sim) throw new Error('no sim yet');
    return vOf(this.comps, this.ws, this.sim, cid, tid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: registration', () => {
  const cases: { type: string; terminals: string[]; params: string[] }[] = [
    { type: 'cd4027', terminals: ['j1', 'k1', 'clk1', 'set1', 'rst1', 'q1', 'qbar1', 'j2', 'k2', 'clk2', 'set2', 'rst2', 'q2', 'qbar2', 'vcc', 'gnd'], params: ['vcc', 'threshold'] },
    { type: 'cd4017', terminals: ['clk', 'rst', 'en', 'y0', 'y5', 'y9', 'carry', 'vcc', 'gnd'], params: ['vcc', 'threshold'] },
    { type: 'cd4060', terminals: ['rs', 'rc', 'clk', 'rst', 'q3', 'q4', 'q10', 'q12', 'q13', 'q14', 'vcc', 'gnd'], params: ['vcc', 'oscFreq'] },
    { type: 'cd4093', terminals: ['a', 'b', 'y', 'vcc', 'gnd'], params: ['vcc', 'vtPos', 'vtNeg'] },
    { type: 'cd4511', terminals: ['d0', 'd1', 'd2', 'd3', 'le', 'bi', 'lt', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'vcc', 'gnd'], params: ['vcc', 'threshold'] },
    { type: 'ic7490', terminals: ['clka', 'clkb', 'r0a', 'r0b', 'r9a', 'r9b', 'qa', 'qb', 'qc', 'qd', 'vcc', 'gnd'], params: ['vcc', 'threshold'] },
    { type: 'ic74164', terminals: ['a', 'b', 'clk', 'clr', 'q0', 'q7', 'vcc', 'gnd'], params: ['vcc', 'threshold'] },
    { type: 'ic74245', terminals: ['dir', 'oe', 'a0', 'a7', 'b0', 'b7', 'vcc', 'gnd'], params: ['ron', 'roff', 'threshold'] },
    { type: 'ic74374', terminals: ['d0', 'd7', 'clk', 'oe', 'q0', 'q7', 'vcc', 'gnd'], params: ['vcc', 'threshold'] },
    { type: 'pll4046', terminals: ['sigin', 'compin', 'pcpout', 'vcoin', 'vcoout', 'inh', 'vcc', 'gnd'], params: ['fmin', 'fmax', 'icp', 'vcoDuty'] },
  ];
  for (const { type, terminals, params } of cases) {
    it(`${type} is registered with terminals and params`, () => {
      const p = getPlugin(type);
      expect(p).toBeDefined();
      expect(p!.category).toBe('logic');
      const ids = p!.terminals.map(t => t.id);
      for (const t of terminals) expect(ids).toContain(t);
      for (const k of params) expect(p!.parameters.some(pp => pp.key === k)).toBe(true);
    });
  }

  it('cd4060 skips q11 (not bonded on the real part)', () => {
    const p = getPlugin('cd4060')!;
    expect(p.terminals.some(t => t.id === 'q11')).toBe(false);
  });

  it('cd4017 has all ten decoded outputs', () => {
    const ids = getPlugin('cd4017')!.terminals.map(t => t.id);
    for (let i = 0; i < 10; i++) expect(ids).toContain(`y${i}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4027 — dual JK flip-flop
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: CD4027 dual JK flip-flop', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'VJ', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VK', [0, 5], { voltage: 0 }),
      comp('dcVoltage', 'VCLK', [0, 10], { voltage: 0 }),
      comp('dcVoltage', 'VRST', [0, 15], { voltage: 0 }),
      comp('dcVoltage', 'VSET', [0, 20], { voltage: 0 }),
      comp('cd4027', 'U1', [6, 0]),
      comp('resistor', 'RQ1', [16, 0], { resistance: 1000 }),
      comp('resistor', 'RQ2', [16, 6], { resistance: 1000 }),
      comp('ground', 'GND', [16, 14]),
    ];
    const ws = [
      wire('w1', 'VJ', 'p', 'U1', 'j1'),
      wire('w2', 'VK', 'p', 'U1', 'k1'),
      wire('w3', 'VCLK', 'p', 'U1', 'clk1'),
      wire('w4', 'VRST', 'p', 'U1', 'rst1'),
      wire('w5', 'VSET', 'p', 'U1', 'set1'),
      wire('w6', 'U1', 'q1', 'RQ1', 'a'),
      wire('w7', 'RQ1', 'b', 'GND', 'g'),
      wire('w8', 'U1', 'q2', 'RQ2', 'a'),
      wire('w9', 'RQ2', 'b', 'GND', 'g'),
      wire('w10', 'VJ', 'n', 'GND', 'g'),
      wire('w11', 'VK', 'n', 'GND', 'g'),
      wire('w12', 'VCLK', 'n', 'GND', 'g'),
      wire('w13', 'VRST', 'n', 'GND', 'g'),
      wire('w14', 'VSET', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('solveDC twice (clock low then high): J=K=1 toggles Q', () => {
    const { comps, ws } = mk();
    // J = K = 1 for the whole test.
    comps.find(x => x.id === 'VJ')!.parameters.voltage = 5;
    comps.find(x => x.id === 'VK')!.parameters.voltage = 5;
    const dcLow = solveDC(comps, ws, plugins());
    expect(dcLow).not.toBeNull();
    expect(vOf(comps, ws, dcLow!, 'U1', 'q1')).toBeLessThan(0.5);
    // Raise the clock and re-solve: the rising edge fires during the second
    // solve's Newton iterations → Q flips to VCC.
    const c = comps.find(x => x.id === 'VCLK')!;
    c.parameters.voltage = 5;
    const dcHigh = solveDC(comps, ws, plugins());
    expect(dcHigh).not.toBeNull();
    expect(vOf(comps, ws, dcHigh!, 'U1', 'q1')).toBeGreaterThan(4.5);
    // Async RST forces Q back to 0 even with the clock still high.
    const r = comps.find(x => x.id === 'VRST')!;
    r.parameters.voltage = 5;
    const dcRst = solveDC(comps, ws, plugins());
    expect(dcRst).not.toBeNull();
    expect(vOf(comps, ws, dcRst!, 'U1', 'q1')).toBeLessThan(0.5);
  });

  it('J=K=1 toggles on every clock pulse; Q̄ complements Q; unit 2 independent', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.setV('VJ', 5).setV('VK', 5).settle();
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);   // reset state
    d.pulse('VCLK');
    expect(d.v('U1', 'q1')).toBeGreaterThan(4.5); // toggled to 1
    expect(d.v('U1', 'q2')).toBeLessThan(0.5);    // untouched unit
    d.pulse('VCLK');
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);    // toggled back to 0
    expect(d.v('U1', 'q2')).toBeLessThan(0.5);
    d.pulse('VCLK');
    expect(d.v('U1', 'q1')).toBeGreaterThan(4.5);
  });

  it('J=1, K=0 sets and holds; J=0, K=1 resets', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.setV('VJ', 5).setV('VK', 0).settle();
    d.pulse('VCLK');
    expect(d.v('U1', 'q1')).toBeGreaterThan(4.5);
    d.pulse('VCLK');
    expect(d.v('U1', 'q1')).toBeGreaterThan(4.5); // set — no toggle
    d.setV('VJ', 0).setV('VK', 5).settle();
    d.pulse('VCLK');
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);    // reset
  });

  it('async SET and RST dominate the clock', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.setV('VJ', 5).setV('VK', 5).settle();
    d.setV('VRST', 5).settle();
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);    // async reset
    d.pulse('VCLK');
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);    // still held at 0
    d.setV('VRST', 0).setV('VSET', 5).settle();
    expect(d.v('U1', 'q1')).toBeGreaterThan(4.5); // async set (no clock!)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4017 — decade counter
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: CD4017 decade counter', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'VCLK', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VEN', [0, 5], { voltage: 0 }),
      comp('dcVoltage', 'VRST', [0, 10], { voltage: 0 }),
      comp('cd4017', 'U1', [6, 0]),
      comp('resistor', 'RY0', [16, 0], { resistance: 1000 }),
      comp('resistor', 'RY3', [20, 0], { resistance: 1000 }),
      comp('resistor', 'RY8', [24, 0], { resistance: 1000 }),
      comp('resistor', 'RCO', [28, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 10]),
    ];
    const ws = [
      wire('w1', 'VCLK', 'p', 'U1', 'clk'),
      wire('w2', 'VEN', 'p', 'U1', 'en'),
      wire('w3', 'VRST', 'p', 'U1', 'rst'),
      wire('w4', 'U1', 'y0', 'RY0', 'a'),
      wire('w5', 'RY0', 'b', 'GND', 'g'),
      wire('w6', 'U1', 'y3', 'RY3', 'a'),
      wire('w7', 'RY3', 'b', 'GND', 'g'),
      wire('w8', 'U1', 'y8', 'RY8', 'a'),
      wire('w9', 'RY8', 'b', 'GND', 'g'),
      wire('w10', 'U1', 'carry', 'RCO', 'a'),
      wire('w11', 'RCO', 'b', 'GND', 'g'),
      wire('w12', 'VCLK', 'n', 'GND', 'g'),
      wire('w13', 'VEN', 'n', 'GND', 'g'),
      wire('w14', 'VRST', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('counts 0→9 and wraps, with CARRY high for counts 0-4', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.settle();
    expect(d.v('U1', 'y0')).toBeGreaterThan(4.5); // count 0
    expect(d.v('U1', 'carry')).toBeGreaterThan(4.5);
    d.pulse('VCLK', 3);
    expect(d.v('U1', 'y3')).toBeGreaterThan(4.5); // count 3
    expect(d.v('U1', 'y0')).toBeLessThan(0.5);
    expect(d.v('U1', 'carry')).toBeGreaterThan(4.5); // 3 < 5
    d.pulse('VCLK', 5);
    expect(d.v('U1', 'y8')).toBeGreaterThan(4.5); // count 8
    expect(d.v('U1', 'y3')).toBeLessThan(0.5);
    expect(d.v('U1', 'carry')).toBeLessThan(0.5);  // 8 >= 5
    d.pulse('VCLK', 2);
    expect(d.v('U1', 'y0')).toBeGreaterThan(4.5); // 10 → wraps to 0
    expect(d.v('U1', 'y8')).toBeLessThan(0.5);
    expect(d.v('U1', 'carry')).toBeGreaterThan(4.5);
  });

  it('EN high inhibits the clock', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.settle();
    expect(d.v('U1', 'y0')).toBeGreaterThan(4.5);
    d.setV('VEN', 5).settle();
    d.pulse('VCLK', 3);
    expect(d.v('U1', 'y0')).toBeGreaterThan(4.5); // count frozen at 0
    expect(d.v('U1', 'y3')).toBeLessThan(0.5);
  });

  it('RST is async and active high', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.pulse('VCLK', 3);
    expect(d.v('U1', 'y3')).toBeGreaterThan(4.5);
    d.setV('VRST', 5).settle();
    expect(d.v('U1', 'y3')).toBeLessThan(0.5);
    expect(d.v('U1', 'y0')).toBeGreaterThan(4.5); // count forced to 0
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4060 — 14-stage ripple counter with oscillator
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: CD4060 ripple counter', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'VCLK', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VRST', [0, 5], { voltage: 0 }),
      comp('cd4060', 'U1', [6, 0]),
      comp('resistor', 'RQ3', [16, 0], { resistance: 1000 }),
      comp('resistor', 'RQ4', [20, 0], { resistance: 1000 }),
      comp('resistor', 'RQ14', [24, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 10]),
    ];
    const ws = [
      wire('w1', 'VCLK', 'p', 'U1', 'clk'),
      wire('w2', 'VRST', 'p', 'U1', 'rst'),
      wire('w3', 'U1', 'q3', 'RQ3', 'a'),
      wire('w4', 'RQ3', 'b', 'GND', 'g'),
      wire('w5', 'U1', 'q4', 'RQ4', 'a'),
      wire('w6', 'RQ4', 'b', 'GND', 'g'),
      wire('w7', 'U1', 'q14', 'RQ14', 'a'),
      wire('w8', 'RQ14', 'b', 'GND', 'g'),
      wire('w9', 'VCLK', 'n', 'GND', 'g'),
      wire('w10', 'VRST', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('external CLK: outputs are the binary count bits (qN = bit N)', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.settle();
    expect(d.v('U1', 'q3')).toBeLessThan(0.5); // count 0
    d.pulse('VCLK', 8);
    expect(d.v('U1', 'q3')).toBeGreaterThan(4.5); // count 8  = 0b1000
    expect(d.v('U1', 'q4')).toBeLessThan(0.5);
    expect(d.v('U1', 'q14')).toBeLessThan(0.5);
    d.pulse('VCLK', 8);
    expect(d.v('U1', 'q4')).toBeGreaterThan(4.5); // count 16 = 0b10000
    expect(d.v('U1', 'q3')).toBeLessThan(0.5);
  });

  it('RST is async and active high', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.pulse('VCLK', 16);
    expect(d.v('U1', 'q4')).toBeGreaterThan(4.5);
    d.setV('VRST', 5).settle();
    expect(d.v('U1', 'q4')).toBeLessThan(0.5); // count cleared
  });

  it('internal oscillator counts when CLK is unwired', () => {
    // No VCLK source, CLK pin left floating → internal osc at oscFreq.
    // dt = 2 ms, oscFreq = 500 Hz → exactly one count per step after the
    // first; 12 steps land the count in 10..12 → bit 3 set, bit 4 clear.
    const comps = [
      comp('dcVoltage', 'VRST', [0, 5], { voltage: 0 }),
      comp('cd4060', 'U1', [6, 0], { oscFreq: 500 }),
      comp('resistor', 'RQ3', [16, 0], { resistance: 1000 }),
      comp('resistor', 'RQ4', [20, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 10]),
    ];
    const ws = [
      wire('w1', 'VRST', 'p', 'U1', 'rst'),
      wire('w2', 'U1', 'q3', 'RQ3', 'a'),
      wire('w3', 'RQ3', 'b', 'GND', 'g'),
      wire('w4', 'U1', 'q4', 'RQ4', 'a'),
      wire('w5', 'RQ4', 'b', 'GND', 'g'),
      wire('w6', 'VRST', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws);
    d.settle(12, 2e-3);
    expect(d.v('U1', 'q3')).toBeGreaterThan(4.5); // count 8..15
    expect(d.v('U1', 'q4')).toBeLessThan(0.5);    // count < 16
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4093 — quad NAND Schmitt trigger
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: CD4093 NAND Schmitt trigger', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'VINA', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VINB', [0, 5], { voltage: 5 }),
      comp('cd4093', 'U1', [6, 0]),
      comp('resistor', 'RY', [12, 0], { resistance: 1000 }),
      comp('ground', 'GND', [12, 8]),
    ];
    const ws = [
      wire('w1', 'VINA', 'p', 'U1', 'a'),
      wire('w2', 'VINB', 'p', 'U1', 'b'),
      wire('w3', 'U1', 'y', 'RY', 'a'),
      wire('w4', 'RY', 'b', 'GND', 'g'),
      wire('w5', 'VINA', 'n', 'GND', 'g'),
      wire('w6', 'VINB', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('hysteresis: switches at VT+ going up, holds until VT− coming down', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    // Between the thresholds with no prior state → input reads LOW.
    d.setV('VINA', 2.5).settle();
    expect(d.v('U1', 'y')).toBeGreaterThan(4.5);
    // Above VT+ (3.0) → NAND output goes LOW.
    d.setV('VINA', 3.2).settle();
    expect(d.v('U1', 'y')).toBeLessThan(0.5);
    // Back into the hysteresis band (2.6): a plain 2.5 V-threshold gate
    // would already switch; the Schmitt state HOLDS the input HIGH.
    d.setV('VINA', 2.6).settle();
    expect(d.v('U1', 'y')).toBeLessThan(0.5);
    // Below VT− (2.0) → input finally releases → output HIGH.
    d.setV('VINA', 1.8).settle();
    expect(d.v('U1', 'y')).toBeGreaterThan(4.5);
  });

  it('NAND truth table (solveDC)', () => {
    const { comps, ws } = mk();
    const a = comps.find(x => x.id === 'VINA')!;
    a.parameters.voltage = 5;
    let dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    expect(vOf(comps, ws, dc!, 'U1', 'y')).toBeLessThan(0.5); // 1 NAND 1 = 0
    const b = comps.find(x => x.id === 'VINB')!;
    b.parameters.voltage = 0;
    dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    expect(vOf(comps, ws, dc!, 'U1', 'y')).toBeGreaterThan(4.5); // 1 NAND 0 = 1
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4511 — BCD to 7-segment latch/decoder/driver
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: CD4511 BCD→7-segment', () => {
  function segLoad(prefix: string) {
    // resistor per segment a..g, all returned for wiring
    return ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(s => comp('resistor', `${prefix}_${s}`, [30, 0], { resistance: 1000 }));
  }

  it('decodes BCD 3: segments a,b,c,d,g on; e,f off (solveDC, LE low)', () => {
    const rs = segLoad('R');
    const comps = [
      comp('dcVoltage', 'VD0', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'VD1', [0, 5], { voltage: 5 }),
      comp('dcVoltage', 'VHI', [0, 10], { voltage: 5 }),
      comp('cd4511', 'U1', [6, 0]),
      ...rs,
      comp('ground', 'GND', [30, 12]),
    ];
    const ws = [
      wire('w1', 'VD0', 'p', 'U1', 'd0'),
      wire('w2', 'VD1', 'p', 'U1', 'd1'),
      wire('w3', 'VHI', 'p', 'U1', 'bi'),
      wire('w4', 'VHI', 'p', 'U1', 'lt'),
      wire('w5', 'U1', 'le', 'GND', 'g'), // LE low = transparent
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((s, i) => [
        wire(`ws${i}`, 'U1', s, `R_${s}`, 'a'),
        wire(`wg${i}`, `R_${s}`, 'b', 'GND', 'g'),
      ]),
      wire('w6', 'VD0', 'n', 'GND', 'g'),
      wire('w7', 'VD1', 'n', 'GND', 'g'),
      wire('w8', 'VHI', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    for (const s of ['a', 'b', 'c', 'd', 'g']) {
      expect(vOf(comps, ws, dc!, 'U1', s)).toBeGreaterThan(4.5);
    }
    for (const s of ['e', 'f']) {
      expect(vOf(comps, ws, dc!, 'U1', s)).toBeLessThan(0.5);
    }
  });

  it('BI low blanks all segments', () => {
    const rs = segLoad('R');
    const comps = [
      comp('dcVoltage', 'VD0', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'VD1', [0, 5], { voltage: 5 }),
      comp('dcVoltage', 'VHI', [0, 10], { voltage: 5 }),
      comp('cd4511', 'U1', [6, 0]),
      ...rs,
      comp('ground', 'GND', [30, 12]),
    ];
    const ws = [
      wire('w1', 'VD0', 'p', 'U1', 'd0'),
      wire('w2', 'VD1', 'p', 'U1', 'd1'),
      wire('w3', 'VHI', 'p', 'U1', 'lt'),
      wire('w4', 'U1', 'bi', 'GND', 'g'), // blanking active
      wire('w5', 'U1', 'le', 'GND', 'g'),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((s, i) => [
        wire(`ws${i}`, 'U1', s, `R_${s}`, 'a'),
        wire(`wg${i}`, `R_${s}`, 'b', 'GND', 'g'),
      ]),
      wire('w6', 'VD0', 'n', 'GND', 'g'),
      wire('w7', 'VD1', 'n', 'GND', 'g'),
      wire('w8', 'VHI', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(vOf(comps, ws, dc!, 'U1', s)).toBeLessThan(0.5);
    }
  });

  it('LT low lights all segments (overrides BI)', () => {
    const rs = segLoad('R');
    const comps = [
      comp('dcVoltage', 'VD0', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'VHI', [0, 10], { voltage: 5 }),
      comp('cd4511', 'U1', [6, 0]),
      ...rs,
      comp('ground', 'GND', [30, 12]),
    ];
    const ws = [
      wire('w1', 'VD0', 'p', 'U1', 'd0'),
      wire('w2', 'VHI', 'p', 'U1', 'bi'),
      wire('w3', 'U1', 'lt', 'GND', 'g'), // lamp test active
      wire('w4', 'U1', 'le', 'GND', 'g'),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((s, i) => [
        wire(`ws${i}`, 'U1', s, `R_${s}`, 'a'),
        wire(`wg${i}`, `R_${s}`, 'b', 'GND', 'g'),
      ]),
      wire('w5', 'VD0', 'n', 'GND', 'g'),
      wire('w6', 'VHI', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(vOf(comps, ws, dc!, 'U1', s)).toBeGreaterThan(4.5);
    }
  });

  it('LE high latches the decoded value', () => {
    const rs = segLoad('R');
    const comps = [
      comp('dcVoltage', 'VD0', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VD1', [0, 5], { voltage: 0 }),
      comp('dcVoltage', 'VLE', [0, 10], { voltage: 0 }),
      comp('dcVoltage', 'VHI', [0, 15], { voltage: 5 }),
      comp('cd4511', 'U1', [6, 0]),
      ...rs,
      comp('ground', 'GND', [30, 12]),
    ];
    const ws = [
      wire('w1', 'VD0', 'p', 'U1', 'd0'),
      wire('w2', 'VD1', 'p', 'U1', 'd1'),
      wire('w3', 'VLE', 'p', 'U1', 'le'),
      wire('w4', 'VHI', 'p', 'U1', 'bi'),
      wire('w5', 'VHI', 'p', 'U1', 'lt'),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((s, i) => [
        wire(`ws${i}`, 'U1', s, `R_${s}`, 'a'),
        wire(`wg${i}`, `R_${s}`, 'b', 'GND', 'g'),
      ]),
      wire('w6', 'VD0', 'n', 'GND', 'g'),
      wire('w7', 'VD1', 'n', 'GND', 'g'),
      wire('w8', 'VLE', 'n', 'GND', 'g'),
      wire('w9', 'VHI', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws);
    // BCD = 3, latch transparent → segments show "3".
    d.setV('VD0', 5).setV('VD1', 5).settle();
    expect(d.v('U1', 'g')).toBeGreaterThan(4.5);
    expect(d.v('U1', 'e')).toBeLessThan(0.5);
    // Latch, then change the BCD input to 0 → display still shows "3".
    d.setV('VLE', 5).settle();
    d.setV('VD0', 0).setV('VD1', 0).settle();
    expect(d.v('U1', 'g')).toBeGreaterThan(4.5);
    expect(d.v('U1', 'e')).toBeLessThan(0.5);
    // Release the latch → display follows the (new) input, digit 0.
    d.setV('VLE', 0).settle();
    expect(d.v('U1', 'g')).toBeLessThan(0.5);
    expect(d.v('U1', 'e')).toBeGreaterThan(4.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7490 — decade counter (÷2 and ÷5)
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: 7490 decade counter', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'VCLKA', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VCLKB', [0, 5], { voltage: 0 }),
      comp('dcVoltage', 'VR0', [0, 10], { voltage: 0 }),
      comp('dcVoltage', 'VR9', [0, 15], { voltage: 0 }),
      comp('ic7490', 'U1', [6, 0]),
      comp('resistor', 'RQA', [16, 0], { resistance: 1000 }),
      comp('resistor', 'RQB', [20, 0], { resistance: 1000 }),
      comp('resistor', 'RQC', [24, 0], { resistance: 1000 }),
      comp('resistor', 'RQD', [28, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 10]),
    ];
    const ws = [
      wire('w1', 'VCLKA', 'p', 'U1', 'clka'),
      wire('w2', 'VCLKB', 'p', 'U1', 'clkb'),
      wire('w3', 'VR0', 'p', 'U1', 'r0a'),
      wire('w4', 'VR0', 'p', 'U1', 'r0b'),
      wire('w5', 'VR9', 'p', 'U1', 'r9a'),
      wire('w6', 'VR9', 'p', 'U1', 'r9b'),
      wire('w7', 'U1', 'qa', 'RQA', 'a'),
      wire('w8', 'RQA', 'b', 'GND', 'g'),
      wire('w9', 'U1', 'qb', 'RQB', 'a'),
      wire('w10', 'RQB', 'b', 'GND', 'g'),
      wire('w11', 'U1', 'qc', 'RQC', 'a'),
      wire('w12', 'RQC', 'b', 'GND', 'g'),
      wire('w13', 'U1', 'qd', 'RQD', 'a'),
      wire('w14', 'RQD', 'b', 'GND', 'g'),
      wire('w15', 'VCLKA', 'n', 'GND', 'g'),
      wire('w16', 'VCLKB', 'n', 'GND', 'g'),
      wire('w17', 'VR0', 'n', 'GND', 'g'),
      wire('w18', 'VR9', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('÷2 section: QA toggles on falling CLKA edges (two pulses → QA back to 0)', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.pulse('VCLKA');
    expect(d.v('U1', 'qa')).toBeGreaterThan(4.5); // toggled once
    d.pulse('VCLKA');
    expect(d.v('U1', 'qa')).toBeLessThan(0.5);    // toggled twice
  });

  it('÷5 section: counts 0-4 in binary on falling CLKB edges (QB = LSB)', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.pulse('VCLKB', 3); // count5 = 3 = 0b011
    expect(d.v('U1', 'qb')).toBeGreaterThan(4.5);
    expect(d.v('U1', 'qc')).toBeGreaterThan(4.5);
    expect(d.v('U1', 'qd')).toBeLessThan(0.5);
    d.pulse('VCLKB', 2); // count5 = 5 → wraps to 0
    expect(d.v('U1', 'qb')).toBeLessThan(0.5);
    expect(d.v('U1', 'qc')).toBeLessThan(0.5);
    expect(d.v('U1', 'qd')).toBeLessThan(0.5);
  });

  it('R0(1)&R0(2) high resets to zero; R9(1)&R9(2) high presets to nine', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.pulse('VCLKA').pulse('VCLKB', 3);
    expect(d.v('U1', 'qa')).toBeGreaterThan(4.5);
    expect(d.v('U1', 'qc')).toBeGreaterThan(4.5);
    d.setV('VR0', 5).settle();
    expect(d.v('U1', 'qa')).toBeLessThan(0.5);
    expect(d.v('U1', 'qb')).toBeLessThan(0.5);
    expect(d.v('U1', 'qc')).toBeLessThan(0.5);
    expect(d.v('U1', 'qd')).toBeLessThan(0.5);
    d.setV('VR0', 0).setV('VR9', 5).settle();
    expect(d.v('U1', 'qa')).toBeGreaterThan(4.5); // 9 = 1001
    expect(d.v('U1', 'qd')).toBeGreaterThan(4.5);
    expect(d.v('U1', 'qb')).toBeLessThan(0.5);
    expect(d.v('U1', 'qc')).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 74164 — 8-bit serial-in / parallel-out shift register
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: 74164 shift register', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'VDATA', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VCLK', [0, 5], { voltage: 0 }),
      comp('dcVoltage', 'VCLR', [0, 10], { voltage: 5 }), // active low
      comp('ic74164', 'U1', [6, 0]),
      comp('resistor', 'RQ0', [16, 0], { resistance: 1000 }),
      comp('resistor', 'RQ1', [20, 0], { resistance: 1000 }),
      comp('resistor', 'RQ2', [24, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 10]),
    ];
    const ws = [
      wire('w1', 'VDATA', 'p', 'U1', 'a'),
      wire('w2', 'VDATA', 'p', 'U1', 'b'),
      wire('w3', 'VCLK', 'p', 'U1', 'clk'),
      wire('w4', 'VCLR', 'p', 'U1', 'clr'),
      wire('w5', 'U1', 'q0', 'RQ0', 'a'),
      wire('w6', 'RQ0', 'b', 'GND', 'g'),
      wire('w7', 'U1', 'q1', 'RQ1', 'a'),
      wire('w8', 'RQ1', 'b', 'GND', 'g'),
      wire('w9', 'U1', 'q2', 'RQ2', 'a'),
      wire('w10', 'RQ2', 'b', 'GND', 'g'),
      wire('w11', 'VDATA', 'n', 'GND', 'g'),
      wire('w12', 'VCLK', 'n', 'GND', 'g'),
      wire('w13', 'VCLR', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('shifts the AND of A and B in at Q0 on each rising clock edge', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.setV('VDATA', 5).settle();
    d.pulse('VCLK');
    expect(d.v('U1', 'q0')).toBeGreaterThan(4.5); // 1 shifted in
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);
    d.setV('VDATA', 0).settle();
    d.pulse('VCLK');
    expect(d.v('U1', 'q0')).toBeLessThan(0.5);    // 0 shifted in...
    expect(d.v('U1', 'q1')).toBeGreaterThan(4.5); // ...previous 1 moved up
    d.pulse('VCLK');
    expect(d.v('U1', 'q2')).toBeGreaterThan(4.5); // and again
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);
  });

  it('CLR low asynchronously clears all outputs', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.setV('VDATA', 5).settle();
    d.pulse('VCLK', 3);
    expect(d.v('U1', 'q2')).toBeGreaterThan(4.5);
    d.setV('VCLR', 0).settle();
    expect(d.v('U1', 'q0')).toBeLessThan(0.5);
    expect(d.v('U1', 'q1')).toBeLessThan(0.5);
    expect(d.v('U1', 'q2')).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 74245 — octal bus transceiver
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: 74245 bus transceiver', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'V5', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'VOE', [0, 5], { voltage: 0 }),
      comp('dcVoltage', 'VDIR', [0, 10], { voltage: 5 }),
      comp('ic74245', 'U1', [6, 0]),
      comp('resistor', 'RB0', [16, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 8]),
    ];
    const ws = [
      wire('w1', 'V5', 'p', 'U1', 'a0'),
      wire('w2', 'VOE', 'p', 'U1', 'oe'),
      wire('w3', 'VDIR', 'p', 'U1', 'dir'),
      wire('w4', 'U1', 'b0', 'RB0', 'a'),
      wire('w5', 'RB0', 'b', 'GND', 'g'),
      wire('w6', 'V5', 'n', 'GND', 'g'),
      wire('w7', 'VOE', 'n', 'GND', 'g'),
      wire('w8', 'VDIR', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('OE low: A0 passes to B0 through RON (5 V · 1k/(1k+10Ω) ≈ 4.95 V)', () => {
    const { comps, ws } = mk();
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    const vb = vOf(comps, ws, dc!, 'U1', 'b0');
    expect(vb).toBeGreaterThan(4.5);
    expect(vb).toBeLessThan(5);
  });

  it('OE high: B0 floats (only ROFF to A0) → ≈ 0 V through the load', () => {
    const { comps, ws } = mk();
    const oe = comps.find(x => x.id === 'VOE')!;
    oe.parameters.voltage = 5;
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    expect(vOf(comps, ws, dc!, 'U1', 'b0')).toBeLessThan(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 74374 — octal D flip-flop with tri-state outputs
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: 74374 octal D flip-flop', () => {
  function mk() {
    const comps = [
      comp('dcVoltage', 'VD0', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VCLK', [0, 5], { voltage: 0 }),
      comp('dcVoltage', 'VOE', [0, 10], { voltage: 0 }), // active low
      comp('ic74374', 'U1', [6, 0]),
      comp('resistor', 'RQ0', [16, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 8]),
    ];
    const ws = [
      wire('w1', 'VD0', 'p', 'U1', 'd0'),
      wire('w2', 'VCLK', 'p', 'U1', 'clk'),
      wire('w3', 'VOE', 'p', 'U1', 'oe'),
      wire('w4', 'U1', 'q0', 'RQ0', 'a'),
      wire('w5', 'RQ0', 'b', 'GND', 'g'),
      wire('w6', 'VD0', 'n', 'GND', 'g'),
      wire('w7', 'VCLK', 'n', 'GND', 'g'),
      wire('w8', 'VOE', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('latches D on the clock edge and drives Q while OE is low', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.setV('VD0', 5).settle();
    expect(d.v('U1', 'q0')).toBeLessThan(0.5); // no clock yet
    d.pulse('VCLK');
    expect(d.v('U1', 'q0')).toBeGreaterThan(4.5);
    d.setV('VD0', 0).settle();
    expect(d.v('U1', 'q0')).toBeGreaterThan(4.5); // Q holds (no new edge)
  });

  it('OE high → high-Z (Q pulled to 0 by the load); latched value survives', () => {
    const { comps, ws } = mk();
    const d = new Driver(comps, ws);
    d.setV('VD0', 5).settle();
    d.pulse('VCLK');
    expect(d.v('U1', 'q0')).toBeGreaterThan(4.5);
    d.setV('VOE', 5).settle();
    expect(d.v('U1', 'q0')).toBeLessThan(0.5);  // high-Z into the 1k load
    d.setV('VOE', 0).settle();
    expect(d.v('U1', 'q0')).toBeGreaterThan(4.5); // state kept through Hi-Z
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 74HC4046 — phase-locked loop
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 logic: 74HC4046 PLL', () => {
  function mkVco() {
    const comps = [
      comp('dcVoltage', 'VIN', [0, 0], { voltage: 2.5 }), // mid-scale control
      comp('dcVoltage', 'VINH', [0, 5], { voltage: 0 }),
      comp('pll4046', 'U1', [6, 0], { fmin: 1000, fmax: 10000, icp: 0.001, vcoDuty: 0.5 }),
      comp('resistor', 'R1', [16, 0], { resistance: 10000 }),
      comp('ground', 'GND', [16, 8]),
    ];
    const ws = [
      wire('w1', 'VIN', 'p', 'U1', 'vcoin'),
      wire('w2', 'VINH', 'p', 'U1', 'inh'),
      wire('w3', 'U1', 'vcoout', 'R1', 'a'),
      wire('w4', 'R1', 'b', 'GND', 'g'),
      wire('w5', 'VIN', 'n', 'GND', 'g'),
      wire('w6', 'VINH', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('VCO frequency = FMIN + (FMAX−FMIN)·V(VCOIN)/VCC (2.5 V → 5.5 kHz)', () => {
    const { comps, ws } = mkVco();
    const d = new Driver(comps, ws);
    const dt = 1e-5;
    const N = 1000;
    const levels: boolean[] = [];
    for (let i = 0; i < N; i++) {
      d.step(dt);
      levels.push(d.v('U1', 'vcoout') > 2.5);
    }
    let transitions = 0;
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] !== levels[i - 1]) transitions++;
    }
    const fMeasured = transitions / 2 / (N * dt);
    // 55 full cycles expected over 10 ms; step-quantized detection.
    expect(Math.abs(fMeasured - 5500)).toBeLessThan(300);
  });

  it('INH high parks the VCO output low', () => {
    const { comps, ws } = mkVco();
    const d = new Driver(comps, ws);
    d.setV('VINH', 5).settle(); // let the inhibit level reach the stamp
    for (let i = 0; i < 50; i++) {
      d.step(1e-4);
      expect(d.v('U1', 'vcoout')).toBeLessThan(0.5);
    }
  });

  it('charge pump: UP sources +ICp·R, DOWN sinks −ICp·R, overlap resets to Hi-Z', () => {
    const comps = [
      comp('dcVoltage', 'VSIG', [0, 0], { voltage: 0 }),
      comp('dcVoltage', 'VCOMP', [0, 5], { voltage: 0 }),
      comp('pll4046', 'U1', [6, 0], { fmin: 1000, fmax: 10000, icp: 0.001, vcoDuty: 0.5 }),
      comp('resistor', 'RP', [16, 0], { resistance: 1000 }),
      comp('ground', 'GND', [16, 8]),
    ];
    const ws = [
      wire('w1', 'VSIG', 'p', 'U1', 'sigin'),
      wire('w2', 'VCOMP', 'p', 'U1', 'compin'),
      wire('w3', 'U1', 'pcpout', 'RP', 'a'),
      wire('w4', 'RP', 'b', 'GND', 'g'),
      wire('w5', 'VSIG', 'n', 'GND', 'g'),
      wire('w6', 'VCOMP', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws);
    d.settle();
    expect(Math.abs(d.v('U1', 'pcpout'))).toBeLessThan(0.05); // both low → Hi-Z
    // Reference leads: SIGIN rising edge arms UP → pump sources 1 mA.
    d.setV('VSIG', 5).settle();
    expect(d.v('U1', 'pcpout')).toBeGreaterThan(0.9);  // +ICp·1k = +1 V
    // Feedback catches up: COMPIN rising edge arms DOWN too → overlap reset.
    d.setV('VCOMP', 5).settle();
    expect(Math.abs(d.v('U1', 'pcpout'))).toBeLessThan(0.05);
    // Reset both inputs, then let the feedback lead → DOWN sinks 1 mA.
    d.setV('VSIG', 0).setV('VCOMP', 0).settle();
    d.setV('VCOMP', 5).settle();
    expect(d.v('U1', 'pcpout')).toBeLessThan(-0.9);   // −ICp·1k = −1 V
  });

  it('survives a DC solve (finite voltages, no hang)', () => {
    const { comps, ws } = mkVco();
    const dc = solveDC(comps, ws, plugins());
    expect(dc).not.toBeNull();
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
  });
});
