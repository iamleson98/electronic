// Hall-effect sensor tests: A1302-style linear ratiometric sensor
// (hallLinear) and US1881-style digital switch with hysteresis (hallSwitch).
//
// Linear behavior is purely combinational → solveDC. The switch's hysteresis
// needs state that persists across `field` parameter changes → the Driver
// class chains simulateStep() with the previous step's {nodeVoltage, state}
// (the same mechanism the p3-logic sequential tests use), mutating `field`
// between steps and settling twice per change.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC, simulateStep, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { COMP_ID_STATE_PREFIXES, cleanupComponentState } from '../src/lib/circuit/memory';
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
 * across simulateStep() calls and lets tests change parameters mid-run.
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

  /** Let freshly changed parameters propagate through a solved step. */
  settle(n = 2, dt?: number): this {
    for (let i = 0; i < n; i++) this.step(dt);
    return this;
  }

  set(id: string, key: string, value: any): this {
    const c = this.comps.find(x => x.id === id);
    if (!c) throw new Error(`no component ${id}`);
    c.parameters[key] = value;
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

describe('Hall sensors: registration', () => {
  const cases: { type: string; part: string; params: string[] }[] = [
    { type: 'hallLinear', part: 'A1302', params: ['vcc', 'sensitivity', 'quiescent', 'field', 'ratiometric'] },
    { type: 'hallSwitch', part: 'US1881', params: ['vcc', 'field', 'bop', 'brp', 'ron', 'internalPullup'] },
  ];
  for (const { type, part, params } of cases) {
    it(`${type} registers with vcc/gnd/out terminals and sensor category`, () => {
      const p = getPlugin(type);
      expect(p).toBeDefined();
      expect(p!.category).toBe('sensor');
      expect(p!.terminals.map(t => t.id).sort()).toEqual(['gnd', 'out', 'vcc']);
      expect(p!.name).toContain(part);
      for (const k of params) expect(p!.parameters.some(pp => pp.key === k)).toBe(true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// hallLinear — A1302-style ratiometric output
// ─────────────────────────────────────────────────────────────────────────────

function linCirc(field = 0, supply = 5, load = 1000, extra: Record<string, any> = {}) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: supply }),
    comp('hallLinear', 'U1', [6, 0], { field, ...extra }),
    comp('resistor', 'RL', [12, 0], { resistance: load }),
    comp('ground', 'GND', [12, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'U1', 'out', 'RL', 'a'),
    wire('w4', 'RL', 'b', 'GND', 'g'),
    wire('w5', 'VS', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

/** DC output voltage of a loaded linear sensor at the given field. */
function linOut(field: number, supply = 5, load = 1000, extra: Record<string, any> = {}): number {
  const { comps, ws } = linCirc(field, supply, load, extra);
  const sim = solveDC(comps, ws, plugins());
  expect(sim).not.toBeNull();
  return vOf(comps, ws, sim!, 'U1', 'out');
}

describe('hallLinear: ratiometric transfer curve', () => {
  it('field = 0 → quiescent output (2.5 V on a 5 V rail)', () => {
    expect(linOut(0)).toBeCloseTo(2.5, 2);
  });

  it('field = ±40 mT → 2.5 ± 40·0.025 V (3.5 V / 1.5 V)', () => {
    // 25 mV/mT · 40 mT = 1 V of swing (within 1 % incl. the 1 Ω Thevenin drop)
    expect(Math.abs(linOut(40) - 3.5)).toBeLessThan(0.035);
    expect(Math.abs(linOut(-40) - 1.5)).toBeLessThan(0.035);
  });

  it('output saturates 0.05 V from the rails (field = ±200 mT)', () => {
    const hi = linOut(200);
    expect(hi).toBeGreaterThan(4.9);   // clamped near vcc − 0.05, not 7.5 V
    expect(hi).toBeLessThan(4.951);
    const lo = linOut(-200);
    expect(lo).toBeGreaterThan(0.04);
    expect(lo).toBeLessThan(0.06);
  });

  it('ratiometric: 3.3 V supply scales quiescent (and sensitivity) by 3.3/5', () => {
    expect(Math.abs(linOut(0, 3.3) - 1.65)).toBeLessThan(0.02);
    // 1.65 + 25·0.66·40/1000 = 2.31 V
    expect(Math.abs(linOut(40, 3.3) - 2.31)).toBeLessThan(0.03);
  });

  it('non-ratiometric mode ignores the actual supply', () => {
    expect(Math.abs(linOut(0, 3.3, 1000, { ratiometric: false }) - 2.5)).toBeLessThan(0.025);
  });

  it('voltage holds under load (1 kΩ and 100 Ω to ground)', () => {
    // 1 Ω Thevenin output: 1 kΩ load → 0.1 % error, 100 Ω → 1 %
    expect(Math.abs(linOut(40, 5, 1000) - 3.5)).toBeLessThan(0.035);
    expect(Math.abs(linOut(40, 5, 100) - 3.5)).toBeLessThan(0.07);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hallSwitch — US1881-style hysteresis + open drain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Switch fixture: 5 V rail, one hallSwitch, voltmeter on OUT (gives the node
 * existence without loading it), and either an external 10 kΩ pull-up to the
 * rail or the model's internal pull-up (internalPullup = true).
 */
function swCirc(internalPullup = false) {
  const comps: CircuitComponent[] = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('hallSwitch', 'U1', [6, 0], { internalPullup }),
    comp('voltmeter', 'VM', [12, 0]),
    comp('ground', 'GND', [12, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'VM', 'p', 'U1', 'out'),
    wire('w5', 'VM', 'n', 'GND', 'g'),
  ];
  if (!internalPullup) {
    comps.push(comp('resistor', 'RPU', [12, 4], { resistance: 10000 }));
    ws.push(wire('w6', 'RPU', 'a', 'U1', 'out'));
    ws.push(wire('w7', 'RPU', 'b', 'VS', 'p'));
  }
  return { comps, ws };
}

describe('hallSwitch: open-drain output with hysteresis', () => {
  it('field = 0 → off: output pulled high by the external 10 kΩ pull-up', () => {
    const { comps, ws } = swCirc(false);
    const d = new Driver(comps, ws).settle();
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9);
  });

  it('field = 15 mT (> Bop) → on: ron pulls OUT low (~12 mV vs 10 kΩ)', () => {
    const { comps, ws } = swCirc(false);
    const d = new Driver(comps, ws);
    d.set('U1', 'field', 15).settle();
    const v = d.v('U1', 'out');
    expect(v).toBeLessThan(0.5);
    expect(v).toBeGreaterThan(0.005); // 5·25/10025 ≈ 12.5 mV
    expect(v).toBeLessThan(0.02);
  });

  it('hysteresis: 0 → 15 → 7 (band) stays on; 7 → 3 (< Brp) releases', () => {
    const { comps, ws } = swCirc(false);
    const d = new Driver(comps, ws);
    d.settle();                                    // field 0 → off, out high
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9);
    d.set('U1', 'field', 15).settle();            // > Bop → on
    expect(d.v('U1', 'out')).toBeLessThan(0.5);
    d.set('U1', 'field', 7).settle();             // between Brp=5 and Bop=10
    expect(d.v('U1', 'out')).toBeLessThan(0.5);   // still on (hysteresis)
    d.set('U1', 'field', 3).settle();             // < Brp → off
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9);
  });

  it('fresh solve with the field inside the band starts OFF (no false trigger)', () => {
    const { comps, ws } = swCirc(false);
    const d = new Driver(comps, ws);
    d.set('U1', 'field', 7).settle();             // power-up inside the band
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9);
  });

  it('internalPullup=true: same behavior without any external resistor', () => {
    const { comps, ws } = swCirc(true);
    const d = new Driver(comps, ws);
    d.settle();
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9); // off: pulled up via internal 10 kΩ
    d.set('U1', 'field', 15).settle();
    expect(d.v('U1', 'out')).toBeLessThan(0.5);    // on
    d.set('U1', 'field', 7).settle();
    expect(d.v('U1', 'out')).toBeLessThan(0.5);    // hysteresis holds on
    d.set('U1', 'field', 3).settle();
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9); // released
  });

  it('negative field (north pole) keeps the switch off', () => {
    const { comps, ws } = swCirc(false);
    const d = new Driver(comps, ws);
    d.set('U1', 'field', -30).settle();
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sim-state hygiene
// ─────────────────────────────────────────────────────────────────────────────

describe('Hall sensors: sim state', () => {
  it("memory.ts prefix list contains 'hallsw' (hallLinear is stateless)", () => {
    expect(COMP_ID_STATE_PREFIXES).toContain('hallsw');
    expect(COMP_ID_STATE_PREFIXES).not.toContain('hallLinear');
  });

  it('hallLinear keeps no sim state at all', () => {
    const { comps, ws } = linCirc(40);
    const d = new Driver(comps, ws);
    d.settle(3);
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    expect(Object.keys(g).filter(k => k.startsWith('hall'))).toEqual([]);
  });

  it('deleting the switch frees its hallsw_<id> state; keeping it preserves it', () => {
    const { comps, ws } = swCirc(false);
    const d = new Driver(comps, ws);
    d.set('U1', 'field', 15).settle();
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    expect(g['hallsw_U1']).toBe(true);
    // component still present → state survives a cleanup pass
    expect(cleanupComponentState(d.sim, d.comps)).toBe(0);
    expect(g['hallsw_U1']).toBe(true);
    // component deleted → state entry is garbage-collected
    expect(cleanupComponentState(d.sim, d.comps.filter(c => c.id !== 'U1'))).toBeGreaterThanOrEqual(1);
    expect(g['hallsw_U1']).toBeUndefined();
  });

  it('state keys are comp-id keyed: two instances behave independently', () => {
    // two linear sensors, different fields → independent outputs
    const lcomps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('hallLinear', 'U1', [6, 0], { field: 40 }),
      comp('hallLinear', 'U2', [6, 6], { field: -40 }),
      comp('resistor', 'RL1', [12, 0], { resistance: 1000 }),
      comp('resistor', 'RL2', [12, 6], { resistance: 1000 }),
      comp('ground', 'GND', [12, 12]),
    ];
    const lws = [
      wire('lw1', 'VS', 'p', 'U1', 'vcc'),
      wire('lw2', 'VS', 'p', 'U2', 'vcc'),
      wire('lw3', 'U1', 'gnd', 'GND', 'g'),
      wire('lw4', 'U2', 'gnd', 'GND', 'g'),
      wire('lw5', 'VS', 'n', 'GND', 'g'),
      wire('lw6', 'U1', 'out', 'RL1', 'a'),
      wire('lw7', 'RL1', 'b', 'GND', 'g'),
      wire('lw8', 'U2', 'out', 'RL2', 'a'),
      wire('lw9', 'RL2', 'b', 'GND', 'g'),
    ];
    const lsim = solveDC(lcomps, lws, plugins());
    expect(lsim).not.toBeNull();
    expect(Math.abs(vOf(lcomps, lws, lsim!, 'U1', 'out') - 3.5)).toBeLessThan(0.035);
    expect(Math.abs(vOf(lcomps, lws, lsim!, 'U2', 'out') - 1.5)).toBeLessThan(0.035);

    // two switches: hysteresis tracked per instance
    const scomps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('hallSwitch', 'U1', [6, 0], { internalPullup: true }),
      comp('hallSwitch', 'U2', [6, 6], { internalPullup: true }),
      comp('voltmeter', 'VM1', [12, 0]),
      comp('voltmeter', 'VM2', [12, 6]),
      comp('ground', 'GND', [12, 12]),
    ];
    const sws = [
      wire('sw1', 'VS', 'p', 'U1', 'vcc'),
      wire('sw2', 'VS', 'p', 'U2', 'vcc'),
      wire('sw3', 'U1', 'gnd', 'GND', 'g'),
      wire('sw4', 'U2', 'gnd', 'GND', 'g'),
      wire('sw5', 'VS', 'n', 'GND', 'g'),
      wire('sw6', 'VM1', 'p', 'U1', 'out'),
      wire('sw7', 'VM1', 'n', 'GND', 'g'),
      wire('sw8', 'VM2', 'p', 'U2', 'out'),
      wire('sw9', 'VM2', 'n', 'GND', 'g'),
    ];
    const d = new Driver(scomps, sws);
    d.settle();
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9);
    expect(d.v('U2', 'out')).toBeGreaterThan(4.9);
    d.set('U1', 'field', 15).settle();            // only U1 operates
    expect(d.v('U1', 'out')).toBeLessThan(0.5);
    expect(d.v('U2', 'out')).toBeGreaterThan(4.9);
    d.set('U1', 'field', 7).set('U2', 'field', 15).settle();
    expect(d.v('U1', 'out')).toBeLessThan(0.5);   // U1 latched on (band)
    expect(d.v('U2', 'out')).toBeLessThan(0.5);   // U2 just operated
    d.set('U1', 'field', 3).set('U2', 'field', 7).settle();
    expect(d.v('U1', 'out')).toBeGreaterThan(4.9); // U1 released
    expect(d.v('U2', 'out')).toBeLessThan(0.5);    // U2 latched on
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    expect(g['hallsw_U1']).toBe(false);
    expect(g['hallsw_U2']).toBe(true);
  });
});
