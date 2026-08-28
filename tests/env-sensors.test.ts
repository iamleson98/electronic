// Environment / motion / gas sensor tests (adxl335, mpu6050, ds18b20,
// dht22, hcsr04, pir501, acs712, mq2) + LM565 analog PLL.
//
// Combinational sensor behavior is checked with solveDC; everything that
// needs state persistence (mpu6050 AD0 stepping, lm565 VCO/PFD/loop filter)
// uses the Driver class — simulateStep chained with the previous step's
// {nodeVoltage, state} (same mechanism as the p3-logic / hall-sensors tests).

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins, registerPlugin } from '../src/lib/circuit/registry';
import { solveDC, simulateStep, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { COMP_ID_STATE_PREFIXES, cleanupComponentState } from '../src/lib/circuit/memory';
import * as env from '../src/lib/circuit/components/env-sensors';
import type { CircuitComponent, Wire, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
  // env-sensors self-registers on import; re-register explicitly so this
  // suite is self-contained even before components/index.ts wires the file.
  for (const p of [env.adxl335, env.mpu6050, env.ds18b20, env.dht22, env.hcsr04, env.pir501, env.acs712, env.mq2, env.lm565]) {
    registerPlugin(p);
  }
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

/** measure() rows of a component, resolved through the node map. */
function measOf(comps: CircuitComponent[], ws: Wire[], sim: SimContext, cid: string): { label: string; value: string; unit?: string }[] {
  const map = buildNodeMap(comps, ws, plugins());
  const c = comps.find(x => x.id === cid)!;
  const p = getPlugin(c.type)!;
  const terms = getTerminalsForComponent(c, p, map);
  return (p.measure as any)(c.parameters, terms, sim, c);
}

function entry(rows: { label: string; value: string }[], label: string): string {
  const r = rows.find(x => x.label === label);
  if (!r) throw new Error(`no measure row "${label}"`);
  return r.value;
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

describe('Env sensors: registration', () => {
  const cases: { type: string; part: string; category: string; terms: string[]; params: string[] }[] = [
    { type: 'adxl335', part: 'ADXL335', category: 'sensor', terms: ['gnd', 'vcc', 'x', 'y', 'z'], params: ['vcc', 'accelX', 'accelY', 'accelZ'] },
    { type: 'mpu6050', part: 'MPU6050', category: 'sensor', terms: ['ad0', 'gnd', 'int', 'scl', 'sda', 'vcc'], params: ['vcc', 'accel', 'gyro', 'motionThreshold', 'idleCurrent_mA'] },
    { type: 'ds18b20', part: 'DS18B20', category: 'sensor', terms: ['dq', 'gnd', 'vdd'], params: ['temperature', 'resolutionBits', 'internalPullup'] },
    { type: 'dht22', part: 'DHT22', category: 'sensor', terms: ['data', 'gnd', 'vcc'], params: ['temperature', 'humidity'] },
    { type: 'hcsr04', part: 'HC-SR04', category: 'sensor', terms: ['echo', 'gnd', 'trig', 'vcc'], params: ['vcc', 'distance_cm', 'triggered', 'current_mA'] },
    { type: 'pir501', part: 'SR501', category: 'sensor', terms: ['gnd', 'out', 'vcc'], params: ['vcc', 'motion', 'sensitivity', 'current_mA'] },
    { type: 'acs712', part: 'ACS712', category: 'sensor', terms: ['gnd', 'ip1', 'ip2', 'vcc', 'vout'], params: ['vcc', 'sensitivity', 'offset', 'range'] },
    { type: 'mq2', part: 'MQ-2', category: 'sensor', terms: ['aout', 'dout', 'gnd', 'vcc'], params: ['vcc', 'ppm', 'threshold_ppm', 'heaterResistance', 'internalPullup'] },
    { type: 'lm565', part: 'LM565', category: 'ic', terms: ['cpin', 'demodout', 'gnd', 'rpin', 'vcc', 'vcc2', 'vcoout', 'vin'], params: ['vpos', 'vneg', 'timingR_kΩ', 'timingC_nF', 'vcoRange'] },
  ];
  for (const { type, part, category, terms, params } of cases) {
    it(`${type} registers with ${terms.length} terminals, category ${category}, params`, () => {
      const p = getPlugin(type);
      expect(p).toBeDefined();
      expect(p!.category).toBe(category);
      expect(p!.terminals.map(t => t.id).sort()).toEqual(terms);
      expect(p!.name).toContain(part);
      for (const k of params) expect(p!.parameters.some(pp => pp.key === k)).toBe(true);
      expect(typeof p!.stamp).toBe('function');
      expect(typeof p!.measure).toBe('function');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// adxl335 — ratiometric analog accelerometer
// ─────────────────────────────────────────────────────────────────────────────

function adxlCirc(supply = 3.3, params: Record<string, any> = {}, load = 1000) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: supply }),
    comp('adxl335', 'U1', [6, 0], params),
    comp('resistor', 'RLX', [12, 0], { resistance: load }),
    comp('resistor', 'RLY', [12, 4], { resistance: load }),
    comp('resistor', 'RLZ', [12, 8], { resistance: load }),
    comp('ground', 'GND', [12, 12]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'U1', 'x', 'RLX', 'a'),
    wire('w5', 'RLX', 'b', 'GND', 'g'),
    wire('w6', 'U1', 'y', 'RLY', 'a'),
    wire('w7', 'RLY', 'b', 'GND', 'g'),
    wire('w8', 'U1', 'z', 'RLZ', 'a'),
    wire('w9', 'RLZ', 'b', 'GND', 'g'),
  ];
  return { comps, ws };
}

function adxlOut(tid: string, supply = 3.3, params: Record<string, any> = {}, load = 1000): number {
  const { comps, ws } = adxlCirc(supply, params, load);
  const sim = solveDC(comps, ws, plugins());
  expect(sim).not.toBeNull();
  return vOf(comps, ws, sim!, 'U1', tid);
}

describe('adxl335: ratiometric analog outputs', () => {
  it('zero-g: all three outputs sit at mid-rail (1.65 V on a 3.3 V supply)', () => {
    for (const t of ['x', 'y', 'z']) {
      expect(Math.abs(adxlOut(t) - 1.65)).toBeLessThan(0.01);
    }
  });

  it('±1 g on X/Y: outputs move 1.65 ± 0.330 V', () => {
    expect(Math.abs(adxlOut('x', 3.3, { accelX: 1 }) - 1.98)).toBeLessThan(0.02);
    expect(Math.abs(adxlOut('y', 3.3, { accelY: -1 }) - 1.32)).toBeLessThan(0.02);
    expect(Math.abs(adxlOut('z', 3.3, { accelZ: 1 }) - 1.98)).toBeLessThan(0.02);
  });

  it('ratiometric: on a 2.0 V supply zero-g is 1.0 V and +1 g is 1.2 V', () => {
    expect(Math.abs(adxlOut('x', 2.0) - 1.0)).toBeLessThan(0.01);
    expect(Math.abs(adxlOut('x', 2.0, { accelX: 1 }) - 1.2)).toBeLessThan(0.02);
  });

  it('outputs clamp 0.05 V from the rails (±10 g overdrive)', () => {
    const hi = adxlOut('x', 3.3, { accelX: 10 });
    expect(hi).toBeGreaterThan(3.2);
    expect(hi).toBeLessThan(3.251);
    const lo = adxlOut('x', 3.3, { accelX: -10 });
    expect(lo).toBeGreaterThan(0.04);
    expect(lo).toBeLessThan(0.06);
  });

  it('voltage holds under a 1 kΩ load on every axis (1 Ω Thevenin)', () => {
    // 1 kΩ load on a 1 Ω source: ≤0.2 % error on the ±1 g swing
    expect(Math.abs(adxlOut('x', 3.3, { accelX: 1 }, 1000) - 1.98)).toBeLessThan(0.011);
    expect(Math.abs(adxlOut('y', 3.3, { accelY: -1 }, 1000) - 1.32)).toBeLessThan(0.011);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mpu6050 — digital IMU (open-drain bus, INT, AD0)
// ─────────────────────────────────────────────────────────────────────────────

function mpuCirc(accel = 0) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
    comp('dcVoltage', 'VSAD', [0, 6], { voltage: 0 }),
    comp('mpu6050', 'U1', [6, 0], { accel }),
    comp('resistor', 'RSDA', [12, 0], { resistance: 10000 }),
    comp('resistor', 'RSCL', [12, 4], { resistance: 10000 }),
    comp('voltmeter', 'VMI', [12, 8]),
    comp('ground', 'GND', [12, 12]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'RSDA', 'a', 'VS', 'p'),
    wire('w5', 'RSDA', 'b', 'U1', 'sda'),
    wire('w6', 'RSCL', 'a', 'VS', 'p'),
    wire('w7', 'RSCL', 'b', 'U1', 'scl'),
    wire('w8', 'VMI', 'p', 'U1', 'int'),
    wire('w9', 'VMI', 'n', 'GND', 'g'),
    wire('w10', 'VSAD', 'p', 'U1', 'ad0'),
    wire('w11', 'VSAD', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('mpu6050: INT, open-drain bus, current draw, AD0', () => {
  it('INT threshold: 0.4 g → LOW, 0.6 g → HIGH (threshold 0.5 g)', () => {
    const low = mpuCirc(0.4);
    const simLo = solveDC(low.comps, low.ws, plugins());
    expect(simLo).not.toBeNull();
    expect(vOf(low.comps, low.ws, simLo!, 'U1', 'int')).toBeLessThan(0.05);

    const high = mpuCirc(0.6);
    const simHi = solveDC(high.comps, high.ws, plugins());
    expect(simHi).not.toBeNull();
    expect(vOf(high.comps, high.ws, simHi!, 'U1', 'int')).toBeGreaterThan(3.2);
  });

  it('SDA/SCL are open-drain: external 10 kΩ pull-ups → ~3.3 V (only 1e-9 S leakage)', () => {
    const { comps, ws } = mpuCirc();
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'sda')).toBeGreaterThan(3.29);
    expect(vOf(comps, ws, sim!, 'U1', 'scl')).toBeGreaterThan(3.29);
  });

  it('current draw: 3.9 mA nominal — 10 Ω series resistor drops ~39 mV', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
      comp('resistor', 'RS', [4, 0], { resistance: 10 }),
      comp('mpu6050', 'U1', [8, 0]),
      comp('voltmeter', 'VMI', [12, 0]),
      comp('ground', 'GND', [12, 6]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'RS', 'a'),
      wire('w2', 'RS', 'b', 'U1', 'vcc'),
      wire('w3', 'U1', 'gnd', 'GND', 'g'),
      wire('w4', 'VS', 'n', 'GND', 'g'),
      wire('w5', 'VMI', 'p', 'U1', 'int'),
      wire('w6', 'VMI', 'n', 'GND', 'g'),
    ];
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const drop = vOf(comps, ws, sim!, 'RS', 'a') - vOf(comps, ws, sim!, 'RS', 'b');
    expect(drop).toBeGreaterThan(0.030); // ≥ 3.0 mA through the rail
    expect(drop).toBeLessThan(0.045);    // ≤ 4.5 mA
  });

  it('AD0 address select: low/floating → 0x68, high → 0x69 (Driver-stepped)', () => {
    const { comps, ws } = mpuCirc();
    const d = new Driver(comps, ws);
    d.settle();
    expect(entry(measOf(d.comps, d.ws, d.sim!, 'U1'), 'Addr')).toBe('0x68');
    d.set('VSAD', 'voltage', 3.3).settle();
    expect(entry(measOf(d.comps, d.ws, d.sim!, 'U1'), 'Addr')).toBe('0x69');
    d.set('VSAD', 'voltage', 0).settle();
    expect(entry(measOf(d.comps, d.ws, d.sim!, 'U1'), 'Addr')).toBe('0x68');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ds18b20 — 1-wire temperature sensor
// ─────────────────────────────────────────────────────────────────────────────

function dsCirc(params: Record<string, any> = {}, pullup = true) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('ds18b20', 'U1', [6, 0], params),
    comp('voltmeter', 'VMQ', [12, 0]),
    comp('ground', 'GND', [12, 6]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vdd'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'VMQ', 'p', 'U1', 'dq'),
    wire('w5', 'VMQ', 'n', 'GND', 'g'),
  ];
  if (pullup) {
    comps.push(comp('resistor', 'RPU', [12, 4], { resistance: 4700 }));
    ws.push(wire('w6', 'RPU', 'a', 'U1', 'dq'));
    ws.push(wire('w7', 'RPU', 'b', 'VS', 'p'));
  }
  return { comps, ws };
}

describe('ds18b20: temp code + 1-wire open-drain DQ', () => {
  it('12-bit code: +25.0625 °C → 0x191; −10.0625 °C → 0xF5F (two\'s complement)', () => {
    const a = dsCirc({ temperature: 25.0625 });
    const simA = solveDC(a.comps, a.ws, plugins());
    expect(simA).not.toBeNull();
    expect(entry(measOf(a.comps, a.ws, simA!, 'U1'), 'Code')).toBe('0x191');
    expect(entry(measOf(a.comps, a.ws, simA!, 'U1'), 'Res')).toBe('12');

    const b = dsCirc({ temperature: -10.0625 });
    const simB = solveDC(b.comps, b.ws, plugins());
    expect(simB).not.toBeNull();
    expect(entry(measOf(b.comps, b.ws, simB!, 'U1'), 'Code')).toBe('0xF5F');
  });

  it('9-bit code: +25.0625 °C rounds to 50 (0x032); −0.5 °C → 0x1FF', () => {
    const a = dsCirc({ temperature: 25.0625, resolutionBits: '9' });
    const simA = solveDC(a.comps, a.ws, plugins());
    expect(simA).not.toBeNull();
    expect(entry(measOf(a.comps, a.ws, simA!, 'U1'), 'Code')).toBe('0x032');

    const b = dsCirc({ temperature: -0.5, resolutionBits: '9' });
    const simB = solveDC(b.comps, b.ws, plugins());
    expect(simB).not.toBeNull();
    expect(entry(measOf(b.comps, b.ws, simB!, 'U1'), 'Code')).toBe('0x1FF');
  });

  it('internalPullup: DQ rises to VDD with no external resistor', () => {
    const { comps, ws } = dsCirc({ internalPullup: true }, false);
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'dq')).toBeGreaterThan(4.9);
  });

  it('open-drain leakage: external 4.7 kΩ pull-up holds DQ at the pull-up rail', () => {
    const { comps, ws } = dsCirc({ internalPullup: false }, true);
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'dq')).toBeGreaterThan(4.99);
  });

  it('measure reports parasite power when VDD is tied to GND', () => {
    const comps = [
      comp('ds18b20', 'U1', [6, 0], { temperature: 25 }),
      comp('voltmeter', 'VMQ', [12, 0]),
      comp('resistor', 'RPU', [12, 4], { resistance: 4700 }),
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('ground', 'GND', [12, 8]),
    ];
    const ws = [
      wire('w1', 'U1', 'vdd', 'GND', 'g'), // parasite mode: VDD to ground
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VMQ', 'p', 'U1', 'dq'),
      wire('w4', 'VMQ', 'n', 'GND', 'g'),
      wire('w5', 'RPU', 'a', 'U1', 'dq'),
      wire('w6', 'RPU', 'b', 'VS', 'p'),
      wire('w7', 'VS', 'n', 'GND', 'g'),
    ];
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(entry(measOf(comps, ws, sim!, 'U1'), 'Power')).toBe('parasite');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dht22 — temperature + humidity
// ─────────────────────────────────────────────────────────────────────────────

function dhtCirc(params: Record<string, any> = {}, pullup = true) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
    comp('dht22', 'U1', [6, 0], params),
    comp('voltmeter', 'VMD', [12, 0]),
    comp('ground', 'GND', [12, 6]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'VMD', 'p', 'U1', 'data'),
    wire('w5', 'VMD', 'n', 'GND', 'g'),
  ];
  if (pullup) {
    comps.push(comp('resistor', 'RPU', [12, 4], { resistance: 10000 }));
    ws.push(wire('w6', 'RPU', 'a', 'U1', 'data'));
    ws.push(wire('w7', 'RPU', 'b', 'VS', 'p'));
  }
  return { comps, ws };
}

describe('dht22: codes + open-drain DATA', () => {
  it('measure: 25.5 °C / 45.2 %RH → codes 0x00FF / 0x01C4; −10.5 °C → 0x8069', () => {
    const a = dhtCirc({ temperature: 25.5, humidity: 45.2 });
    const simA = solveDC(a.comps, a.ws, plugins());
    expect(simA).not.toBeNull();
    const rows = measOf(a.comps, a.ws, simA!, 'U1');
    expect(entry(rows, 'Temp')).toBe('25.5');
    expect(entry(rows, 'RH')).toBe('45.2');
    expect(entry(rows, 'tCode')).toBe('0x00FF');
    expect(entry(rows, 'hCode')).toBe('0x01C4');

    const b = dhtCirc({ temperature: -10.5, humidity: 60 });
    const simB = solveDC(b.comps, b.ws, plugins());
    expect(simB).not.toBeNull();
    expect(entry(measOf(b.comps, b.ws, simB!, 'U1'), 'tCode')).toBe('0x8069');
  });

  it('DATA is open-drain: external 10 kΩ pull-up → ~3.3 V', () => {
    const { comps, ws } = dhtCirc();
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'data')).toBeGreaterThan(3.29);
  });

  it('current draw: 1.5 mA average — 10 Ω series resistor drops ~15 mV', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
      comp('resistor', 'RS', [4, 0], { resistance: 10 }),
      comp('dht22', 'U1', [8, 0]),
      comp('voltmeter', 'VMD', [12, 0]),
      comp('ground', 'GND', [12, 6]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'RS', 'a'),
      wire('w2', 'RS', 'b', 'U1', 'vcc'),
      wire('w3', 'U1', 'gnd', 'GND', 'g'),
      wire('w4', 'VS', 'n', 'GND', 'g'),
      wire('w5', 'VMD', 'p', 'U1', 'data'),
      wire('w6', 'VMD', 'n', 'GND', 'g'),
    ];
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const drop = vOf(comps, ws, sim!, 'RS', 'a') - vOf(comps, ws, sim!, 'RS', 'b');
    expect(drop).toBeGreaterThan(0.010);
    expect(drop).toBeLessThan(0.020);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hcsr04 — ultrasonic ranger
// ─────────────────────────────────────────────────────────────────────────────

function hcsrCirc(params: Record<string, any> = {}) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('hcsr04', 'U1', [6, 0], params),
    comp('voltmeter', 'VME', [12, 0]),
    comp('ground', 'GND', [12, 6]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'VME', 'p', 'U1', 'echo'),
    wire('w5', 'VME', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('hcsr04: ECHO level + pulse width', () => {
  it('triggered + distance 100 cm → ECHO high (~5 V)', () => {
    const { comps, ws } = hcsrCirc({ triggered: true, distance_cm: 100 });
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'echo')).toBeGreaterThan(4.9);
  });

  it('not triggered → ECHO low', () => {
    const { comps, ws } = hcsrCirc({ triggered: false, distance_cm: 100 });
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'echo')).toBeLessThan(0.05);
  });

  it('distance 1 cm (below the 2 cm minimum) → ECHO low; 400 cm (max) → high', () => {
    const near = hcsrCirc({ triggered: true, distance_cm: 1 });
    const simN = solveDC(near.comps, near.ws, plugins());
    expect(simN).not.toBeNull();
    expect(vOf(near.comps, near.ws, simN!, 'U1', 'echo')).toBeLessThan(0.05);

    const far = hcsrCirc({ triggered: true, distance_cm: 400 });
    const simF = solveDC(far.comps, far.ws, plugins());
    expect(simF).not.toBeNull();
    expect(vOf(far.comps, far.ws, simF!, 'U1', 'echo')).toBeGreaterThan(4.9);
  });

  it('pulse width follows the standard formula: 100 cm / 0.0172 ≈ 5814 µs', () => {
    const { comps, ws } = hcsrCirc({ triggered: true, distance_cm: 100 });
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const rows = measOf(comps, ws, sim!, 'U1');
    expect(entry(rows, 'Echo')).toBe('HIGH');
    expect(Math.abs(parseFloat(entry(rows, 'Width')) - 100 / 0.0172)).toBeLessThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pir501 — PIR motion sensor
// ─────────────────────────────────────────────────────────────────────────────

function pirCirc(motion: boolean) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('pir501', 'U1', [6, 0], { motion }),
    comp('voltmeter', 'VMO', [12, 0]),
    comp('ground', 'GND', [12, 6]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'VMO', 'p', 'U1', 'out'),
    wire('w5', 'VMO', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('pir501: 3.3 V push-pull output + quiescent current', () => {
  it('motion → OUT = 3.3 V (module regulates the output stage)', () => {
    const { comps, ws } = pirCirc(true);
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const vOut = vOf(comps, ws, sim!, 'U1', 'out');
    expect(Math.abs(vOut - 3.3)).toBeLessThan(0.05);
    expect(entry(measOf(comps, ws, sim!, 'U1'), 'Motion')).toBe('YES');
  });

  it('no motion → OUT = 0 V', () => {
    const { comps, ws } = pirCirc(false);
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'out')).toBeLessThan(0.05);
  });

  it('quiescent current: 50 µA — 1 kΩ series resistor drops ~50 mV', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('resistor', 'RS', [4, 0], { resistance: 1000 }),
      comp('pir501', 'U1', [8, 0], { motion: false }),
      comp('voltmeter', 'VMO', [12, 0]),
      comp('ground', 'GND', [12, 6]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'RS', 'a'),
      wire('w2', 'RS', 'b', 'U1', 'vcc'),
      wire('w3', 'U1', 'gnd', 'GND', 'g'),
      wire('w4', 'VS', 'n', 'GND', 'g'),
      wire('w5', 'VMO', 'p', 'U1', 'out'),
      wire('w6', 'VMO', 'n', 'GND', 'g'),
    ];
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const drop = vOf(comps, ws, sim!, 'RS', 'a') - vOf(comps, ws, sim!, 'RS', 'b');
    expect(drop).toBeGreaterThan(0.040);
    expect(drop).toBeLessThan(0.060);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// acs712 — Hall current sensor (real current path)
// ─────────────────────────────────────────────────────────────────────────────

/** 5 V source → series resistor R → acs712 IP1, IP2 → ground, VCC on the 5 V rail. */
function acsCirc(seriesR: number) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('resistor', 'RL', [4, 0], { resistance: seriesR }),
    comp('acs712', 'U1', [8, 0]),
    comp('voltmeter', 'VMV', [12, 0]),
    comp('ground', 'GND', [12, 6]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'RL', 'a'),
    wire('w2', 'RL', 'b', 'U1', 'ip1'),
    wire('w3', 'U1', 'ip2', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
    wire('w5', 'U1', 'vcc', 'VS', 'p'),
    wire('w6', 'U1', 'gnd', 'GND', 'g'),
    wire('w7', 'VMV', 'p', 'U1', 'vout'),
    wire('w8', 'VMV', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('acs712: real current path → ratiometric VOUT', () => {
  it('KEY: 5 V through 100 Ω → I ≈ 49.99 mA → VOUT ≈ 2.509 V', () => {
    const { comps, ws } = acsCirc(100);
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const iExp = 5 / (100 + 0.0012);
    const vExp = 2.5 + 0.185 * iExp;
    expect(Math.abs(vOf(comps, ws, sim!, 'U1', 'vout') - vExp)).toBeLessThan(0.005);
    const rows = measOf(comps, ws, sim!, 'U1');
    expect(Math.abs(parseFloat(entry(rows, 'Ipath')) - iExp)).toBeLessThan(0.001);
    expect(entry(rows, 'Range')).toBe('ok');
  });

  it('reversed path current → VOUT below the 2.5 V offset', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('resistor', 'RL', [4, 0], { resistance: 100 }),
      comp('acs712', 'U1', [8, 0]),
      comp('voltmeter', 'VMV', [12, 0]),
      comp('ground', 'GND', [12, 6]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'RL', 'a'),
      wire('w2', 'RL', 'b', 'U1', 'ip2'), // reversed: current enters IP2
      wire('w3', 'U1', 'ip1', 'GND', 'g'),
      wire('w4', 'VS', 'n', 'GND', 'g'),
      wire('w5', 'U1', 'vcc', 'VS', 'p'),
      wire('w6', 'U1', 'gnd', 'GND', 'g'),
      wire('w7', 'VMV', 'p', 'U1', 'vout'),
      wire('w8', 'VMV', 'n', 'GND', 'g'),
    ];
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const vOut = vOf(comps, ws, sim!, 'U1', 'vout');
    expect(vOut).toBeLessThan(2.499);
    expect(Math.abs(vOut - (2.5 - 0.185 * (5 / 100.0012)))).toBeLessThan(0.005);
  });

  it('overrange: |I| > 5 A (0.98 Ω load) → Range flag OVER', () => {
    const { comps, ws } = acsCirc(0.98);
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const rows = measOf(comps, ws, sim!, 'U1');
    const iPath = parseFloat(entry(rows, 'Ipath'));
    expect(iPath).toBeGreaterThan(5.05);
    expect(entry(rows, 'Range')).toBe('OVER');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mq2 — gas sensor (heater + divider + comparator)
// ─────────────────────────────────────────────────────────────────────────────

function mqCirc(params: Record<string, any> = {}, seriesR = 0) {
  const comps: CircuitComponent[] = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('mq2', 'U1', [8, 0], params),
    comp('voltmeter', 'VMA', [12, 0]),
    comp('resistor', 'RPU', [12, 4], { resistance: 10000 }),
    comp('ground', 'GND', [12, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'VMA', 'p', 'U1', 'aout'),
    wire('w5', 'VMA', 'n', 'GND', 'g'),
    wire('w6', 'RPU', 'a', 'U1', 'dout'),
    wire('w7', 'RPU', 'b', 'VS', 'p'),
  ];
  if (seriesR > 0) {
    comps.push(comp('resistor', 'RS', [4, 0], { resistance: seriesR }));
    // rewire vcc through the series resistor
    ws[0] = wire('w1', 'VS', 'p', 'RS', 'a');
    ws.push(wire('w8', 'RS', 'b', 'U1', 'vcc'));
  }
  return { comps, ws };
}

describe('mq2: heater, AOUT divider, open-collector DOUT', () => {
  it('heater is a real 33 Ω resistor: 1 Ω series → ~147 mA node current', () => {
    const { comps, ws } = mqCirc({}, 1);
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    const drop = vOf(comps, ws, sim!, 'RS', 'a') - vOf(comps, ws, sim!, 'RS', 'b');
    // 5 V / 34 Ω ≈ 147 mA through the 1 Ω sense resistor
    expect(Math.abs(drop - 5 / 34)).toBeLessThan(0.005);
    const iHeat = parseFloat(entry(measOf(comps, ws, sim!, 'U1'), 'Iheat'));
    expect(iHeat).toBeGreaterThan(140);
    expect(iHeat).toBeLessThan(152);
  });

  it('AOUT ratio: ppm 0 → 0.5 V, 5000 → 2.5 V, 10000 → 4.5 V (and clamps above)', () => {
    for (const [ppm, vExp] of [[0, 0.5], [5000, 2.5], [10000, 4.5]] as const) {
      const { comps, ws } = mqCirc({ ppm });
      const sim = solveDC(comps, ws, plugins());
      expect(sim).not.toBeNull();
      expect(Math.abs(vOf(comps, ws, sim!, 'U1', 'aout') - vExp)).toBeLessThan(0.02);
    }
    const { comps, ws } = mqCirc({ ppm: 20000 }); // saturates at 10000 ppm
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(Math.abs(vOf(comps, ws, sim!, 'U1', 'aout') - 4.5)).toBeLessThan(0.02);
  });

  it('DOUT comparator: ppm 299 → pulled HIGH by external 10 kΩ; ppm 300 → LOW (~0.45 V)', () => {
    const below = mqCirc({ ppm: 299 });
    const simB = solveDC(below.comps, below.ws, plugins());
    expect(simB).not.toBeNull();
    expect(vOf(below.comps, below.ws, simB!, 'U1', 'dout')).toBeGreaterThan(4.9);
    expect(entry(measOf(below.comps, below.ws, simB!, 'U1'), 'DOUT')).toBe('HIGH');

    const above = mqCirc({ ppm: 300 });
    const simA = solveDC(above.comps, above.ws, plugins());
    expect(simA).not.toBeNull();
    // 1 kΩ ON transistor against the 10 kΩ pull-up: 5·(1/11) ≈ 0.455 V
    expect(Math.abs(vOf(above.comps, above.ws, simA!, 'U1', 'dout') - 5 / 11)).toBeLessThan(0.02);
    expect(entry(measOf(above.comps, above.ws, simA!, 'U1'), 'DOUT')).toBe('LOW');
  });

  it('internalPullup option: DOUT high with no external resistor when below threshold', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('mq2', 'U1', [8, 0], { ppm: 100, internalPullup: true }),
      comp('voltmeter', 'VMD', [12, 0]),
      comp('ground', 'GND', [12, 6]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vcc'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'VMD', 'p', 'U1', 'dout'),
      wire('w5', 'VMD', 'n', 'GND', 'g'),
    ];
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
    expect(vOf(comps, ws, sim!, 'U1', 'dout')).toBeGreaterThan(4.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lm565 — analog PLL
// ─────────────────────────────────────────────────────────────────────────────

/** ±6 V supplies, LM565, voltmeters on VCO/DEM, VSIN drives vin (toggled by tests). */
function pllCirc(u1params: Record<string, any> = {}) {
  const comps = [
    comp('dcVoltage', 'VSP', [0, 0], { voltage: 6 }),
    comp('dcVoltage', 'VSN', [0, 4], { voltage: -6 }),
    comp('dcVoltage', 'VSIN', [0, 8], { voltage: -1 }),
    comp('lm565', 'U1', [8, 0], u1params),
    comp('voltmeter', 'VMV', [14, 0]),
    comp('voltmeter', 'VMD', [14, 4]),
    comp('ground', 'GND', [14, 8]),
  ];
  const ws = [
    wire('w1', 'VSP', 'p', 'U1', 'vcc'),
    wire('w2', 'VSN', 'p', 'U1', 'vcc2'),
    wire('w3', 'U1', 'gnd', 'GND', 'g'),
    wire('w4', 'VSP', 'n', 'GND', 'g'),
    wire('w5', 'VSN', 'n', 'GND', 'g'),
    wire('w6', 'VSIN', 'p', 'U1', 'vin'),
    wire('w7', 'VSIN', 'n', 'GND', 'g'),
    wire('w8', 'VMV', 'p', 'U1', 'vcoout'),
    wire('w9', 'VMV', 'n', 'GND', 'g'),
    wire('w10', 'VMD', 'p', 'U1', 'demodout'),
    wire('w11', 'VMD', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

// f0 with default timing R/C: 1/(3.7·4k·100n) = 675.6757 Hz → the VSIN
// square-wave step cadence that matches it EXACTLY is 20 × 7.4e-5 s.
const F0 = 1 / (3.7 * 4000 * 100e-9);
const DT = 7.4e-5;

describe('lm565: VCO, lock and beat behavior', () => {
  it(`free-run frequency f0 = 1/(3.7·R·C) = ${F0.toFixed(1)} Hz with default timing`, () => {
    const { comps, ws } = pllCirc();
    const d = new Driver(comps, ws).settle(2, 1e-4);
    const rows = measOf(d.comps, d.ws, d.sim!, 'U1');
    expect(Math.abs(parseFloat(entry(rows, 'f0')) - F0)).toBeLessThan(0.5);
    expect(Math.abs(parseFloat(entry(rows, 'f_VCO')) - F0)).toBeLessThan(1);
    // R/C row reports the param values
    expect(entry(rows, 'R/C')).toBe('4.00k/100n');
  });

  it('VCO output is a square wave toggling between the rails (±5.5 V)', () => {
    const { comps, ws } = pllCirc();
    const d = new Driver(comps, ws).settle(3, 1e-4);
    let transitions = 0;
    let prev = d.v('U1', 'vcoout') > 0 ? 1 : 0;
    let maxV = -Infinity;
    let minV = Infinity;
    for (let i = 0; i < 1000; i++) {
      d.step(1e-4);
      const lv = d.v('U1', 'vcoout');
      maxV = Math.max(maxV, lv);
      minV = Math.min(minV, lv);
      const b = lv > 0 ? 1 : 0;
      if (b !== prev) transitions++;
      prev = b;
    }
    // ~67.6 periods per 0.1 s → ~135 transitions; levels hit both rails.
    expect(transitions).toBeGreaterThan(105);
    expect(transitions).toBeLessThan(165);
    expect(maxV).toBeGreaterThan(5.2);
    expect(minV).toBeLessThan(-5.2);
  });

  it('lock: vin at f0 → control voltage settles near mid-supply and Lock = LOCK', () => {
    const { comps, ws } = pllCirc();
    const d = new Driver(comps, ws);
    let level = -1;
    for (let i = 0; i < 4000; i++) {
      if (i % 10 === 0) level = -level; // rising edge every 20 steps = f0
      d.set('VSIN', 'voltage', level);
      d.step(DT);
    }
    const vdem = d.v('U1', 'demodout');
    expect(Math.abs(vdem)).toBeLessThan(0.25); // mid-supply of ±6 V is 0 V
    const rows = measOf(d.comps, d.ws, d.sim!, 'U1');
    expect(entry(rows, 'Lock')).toBe('LOCK');
    expect(Math.abs(parseFloat(entry(rows, 'f_VCO')) - F0)).toBeLessThan(F0 * 0.05);
  });

  it('far-off input (2·f0): control voltage rails toward one side, Lock = UNLOCK', () => {
    const { comps, ws } = pllCirc();
    const d = new Driver(comps, ws);
    let level = -1;
    for (let i = 0; i < 2000; i++) {
      if (i % 5 === 0) level = -level; // rising edge every 10 steps = 2·f0
      d.set('VSIN', 'voltage', level);
      d.step(DT);
    }
    expect(d.v('U1', 'demodout')).toBeGreaterThan(2);
    const rows = measOf(d.comps, d.ws, d.sim!, 'U1');
    expect(entry(rows, 'Lock')).toBe('UNLOCK');
  });

  it('external timing resistor on the R pin is measured electrically (8 kΩ → f0 halves)', () => {
    const { comps, ws } = pllCirc();
    comps.push(comp('resistor', 'R8', [12, 8], { resistance: 8000 }));
    ws.push(wire('wr1', 'R8', 'a', 'U1', 'rpin'));
    ws.push(wire('wr2', 'R8', 'b', 'GND', 'g'));
    const d = new Driver(comps, ws).settle(3, 1e-4);
    const rows = measOf(d.comps, d.ws, d.sim!, 'U1');
    expect(Math.abs(parseFloat(entry(rows, 'f0')) - F0 / 2)).toBeLessThan(0.5);
    expect(entry(rows, 'R/C')).toBe('8.00k/100n');
  });

  it('measure() fields exist (f0, f_VCO, Lock, Vdemod, VCOout, Vin, R/C)', () => {
    const { comps, ws } = pllCirc();
    const d = new Driver(comps, ws).settle(2, 1e-4);
    const rows = measOf(d.comps, d.ws, d.sim!, 'U1');
    const labels = rows.map(r => r.label);
    for (const l of ['f0', 'f_VCO', 'Lock', 'Vdemod', 'VCOout', 'Vin', 'R/C']) {
      expect(labels).toContain(l);
    }
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sim-state hygiene
// ─────────────────────────────────────────────────────────────────────────────

const STATELESS_PREFIXES = ['adxl335', 'mpu6050', 'ds18b20', 'dht22', 'hcsr04', 'pir501', 'acs712', 'mq2'];

describe('Env sensors: sim state hygiene', () => {
  it('the 8 sensor plugins keep no sim state at all (only lm565 does)', () => {
    // one circuit with every stateless sensor on a shared 5 V rail
    const comps: CircuitComponent[] = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('adxl335', 'A1', [6, 0], { accelX: 1 }),
      comp('mpu6050', 'M1', [6, 5], { accel: 0.6 }),
      comp('ds18b20', 'D1', [6, 10], { internalPullup: true }),
      comp('dht22', 'H1', [6, 15]),
      comp('hcsr04', 'R1', [6, 20], { triggered: true }),
      comp('pir501', 'P1', [6, 25], { motion: true }),
      comp('acs712', 'C1', [6, 30]),
      comp('mq2', 'Q1', [6, 35], { ppm: 100 }),
      comp('voltmeter', 'VM', [12, 0]),
      comp('ground', 'GND', [12, 40]),
    ];
    const ws: Wire[] = [
      wire('x1', 'VS', 'p', 'A1', 'vcc'), wire('x2', 'A1', 'gnd', 'GND', 'g'),
      wire('x3', 'VS', 'p', 'M1', 'vcc'), wire('x4', 'M1', 'gnd', 'GND', 'g'),
      wire('x5', 'VS', 'p', 'D1', 'vdd'), wire('x6', 'D1', 'gnd', 'GND', 'g'),
      wire('x7', 'VS', 'p', 'H1', 'vcc'), wire('x8', 'H1', 'gnd', 'GND', 'g'),
      wire('x9', 'VS', 'p', 'R1', 'vcc'), wire('x10', 'R1', 'gnd', 'GND', 'g'),
      wire('x11', 'VS', 'p', 'P1', 'vcc'), wire('x12', 'P1', 'gnd', 'GND', 'g'),
      wire('x13', 'VS', 'p', 'C1', 'vcc'), wire('x14', 'C1', 'gnd', 'GND', 'g'),
      wire('x15', 'VS', 'p', 'Q1', 'vcc'), wire('x16', 'Q1', 'gnd', 'GND', 'g'),
      wire('x17', 'VS', 'n', 'GND', 'g'),
      wire('x18', 'VM', 'p', 'R1', 'echo'), wire('x19', 'VM', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws).settle(3);
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    for (const p of STATELESS_PREFIXES) {
      expect(Object.keys(g).filter(k => k.startsWith(`${p}_`))).toEqual([]);
    }
  });

  it('lm565 state is comp-id keyed: lm565_<id>', () => {
    const { comps, ws } = pllCirc();
    const d = new Driver(comps, ws).settle(2, 1e-4);
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    expect(Object.keys(g).filter(k => k.startsWith('lm565_'))).toEqual(['lm565_U1']);
    expect(g['lm565_U1']).toBeDefined();
    expect(g['lm565_U1'].phase).toBeDefined();
    expect(g['lm565_U1'].vctl).toBeDefined();
  });

  it('cleanupComponentState frees lm565 keys once the component is deleted (prefix registered)', () => {
    const { comps, ws } = pllCirc();
    const d = new Driver(comps, ws).settle(2, 1e-4);
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    expect(g['lm565_U1']).toBeDefined();
    // 'lm565' IS registered in COMP_ID_STATE_PREFIXES (wired by the main
    // agent alongside components/index.ts), so cleanup must free the key
    // once the component no longer exists.
    expect(COMP_ID_STATE_PREFIXES).toContain('lm565');
    expect(cleanupComponentState(d.sim, d.comps.filter(c => c.id !== 'U1'))).toBeGreaterThan(0);
    expect(g['lm565_U1']).toBeUndefined();
  });

  it('two lm565 instances run independently with separate state', () => {
    const comps = [
      comp('dcVoltage', 'VSP', [0, 0], { voltage: 6 }),
      comp('dcVoltage', 'VSN', [0, 4], { voltage: -6 }),
      comp('lm565', 'U1', [8, 0], { timingC_nF: 100 }),
      comp('lm565', 'U2', [8, 6], { timingC_nF: 200 }),
      comp('voltmeter', 'VM1', [14, 0]),
      comp('voltmeter', 'VM2', [14, 4]),
      comp('ground', 'GND', [14, 8]),
    ];
    const ws = [
      wire('w1', 'VSP', 'p', 'U1', 'vcc'), wire('w2', 'VSN', 'p', 'U1', 'vcc2'),
      wire('w3', 'VSP', 'p', 'U2', 'vcc'), wire('w4', 'VSN', 'p', 'U2', 'vcc2'),
      wire('w5', 'U1', 'gnd', 'GND', 'g'), wire('w6', 'U2', 'gnd', 'GND', 'g'),
      wire('w7', 'VSP', 'n', 'GND', 'g'), wire('w8', 'VSN', 'n', 'GND', 'g'),
      wire('w9', 'VM1', 'p', 'U1', 'vcoout'), wire('w10', 'VM1', 'n', 'GND', 'g'),
      wire('w11', 'VM2', 'p', 'U2', 'vcoout'), wire('w12', 'VM2', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws).settle(3, 1e-4);
    const rows1 = measOf(d.comps, d.ws, d.sim!, 'U1');
    const rows2 = measOf(d.comps, d.ws, d.sim!, 'U2');
    expect(Math.abs(parseFloat(entry(rows1, 'f0')) - F0)).toBeLessThan(0.5);
    expect(Math.abs(parseFloat(entry(rows2, 'f0')) - F0 / 2)).toBeLessThan(0.5);
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    expect(Object.keys(g).filter(k => k.startsWith('lm565_')).sort()).toEqual(['lm565_U1', 'lm565_U2']);
    expect(g['lm565_U1']).not.toEqual(g['lm565_U2']); // separate objects
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ERC safety: power-only placement (all signal pins unwired) stays solvable
// ─────────────────────────────────────────────────────────────────────────────

describe('Env sensors: unwired-output-safe stamps', () => {
  const powerOnly: { type: string; pins: [string, string][] }[] = [
    { type: 'adxl335', pins: [['vcc', 'p'], ['gnd', 'n']] },
    { type: 'mpu6050', pins: [['vcc', 'p'], ['gnd', 'n']] },
    { type: 'ds18b20', pins: [['vdd', 'p'], ['gnd', 'n']] },
    { type: 'dht22', pins: [['vcc', 'p'], ['gnd', 'n']] },
    { type: 'hcsr04', pins: [['vcc', 'p'], ['gnd', 'n']] },
    { type: 'pir501', pins: [['vcc', 'p'], ['gnd', 'n']] },
    { type: 'acs712', pins: [['vcc', 'p'], ['gnd', 'n']] },
    { type: 'mq2', pins: [['vcc', 'p'], ['gnd', 'n']] },
  ];
  for (const { type, pins } of powerOnly) {
    it(`${type} solves with only power pins wired (signal pins unwired)`, () => {
      const comps = [
        comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
        comp(type, 'U1', [6, 0]),
        comp('ground', 'GND', [12, 4]),
      ];
      const ws = pins.map(([tid, sp], i) => wire(`pw${i}`, 'VS', sp, 'U1', tid));
      ws.push(wire('pg', 'VS', 'n', 'GND', 'g'));
      const sim = solveDC(comps, ws, plugins());
      expect(sim).not.toBeNull();
    });
  }

  it('lm565 solves with only the supply pins wired', () => {
    const comps = [
      comp('dcVoltage', 'VSP', [0, 0], { voltage: 6 }),
      comp('dcVoltage', 'VSN', [0, 4], { voltage: -6 }),
      comp('lm565', 'U1', [8, 0]),
      comp('ground', 'GND', [14, 4]),
    ];
    const ws = [
      wire('w1', 'VSP', 'p', 'U1', 'vcc'),
      wire('w2', 'VSN', 'p', 'U1', 'vcc2'),
      wire('w3', 'VSP', 'n', 'GND', 'g'),
      wire('w4', 'VSN', 'n', 'GND', 'g'),
    ];
    const sim = solveDC(comps, ws, plugins());
    expect(sim).not.toBeNull();
  });
});
