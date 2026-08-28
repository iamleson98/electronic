// IO/display/wireless component tests: rotaryEncoder (EC11), ws2812b
// (NeoPixel), rgbLed (common cathode), buzzer, electretMic, lcd1602, ssd1306,
// nrf24l01, esp32dev.
//
// Combinational parts are solved with solveDC; anything whose level is
// decided from a previous-iterate voltage (ws2812b DOUT repeater) or whose
// parameters change mid-run uses the Driver class (chained simulateStep with
// the persistent state map — the same mechanism as the hall/p3-logic tests).

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC, simulateStep, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import type { CircuitComponent, Wire, SimContext, ComponentPlugin } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
  // io-display.ts registers its plugins at module load; index.ts wiring is
  // done by the main agent, so import the module directly (idempotent —
  // registerPlugin overwrites built-ins with identical data).
  await import('../src/lib/circuit/components/io-display');
});

function comp(type: string, id: string, pos: [number, number] = [0, 0], params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const pm of p.parameters) defaults[pm.key] = pm.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}
function plugins(): Map<string, ComponentPlugin> {
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

/** measure() rows for a component in a solved circuit. */
function measureOf(comps: CircuitComponent[], ws: Wire[], sim: SimContext, cid: string) {
  const map = buildNodeMap(comps, ws, plugins());
  const c = comps.find(x => x.id === cid)!;
  const p = getPlugin(c.type)!;
  const terms = getTerminalsForComponent(c, p, map);
  return p.measure!(c.parameters, terms, sim, c);
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

/** DC operating point of a circuit (asserts solvability). */
function dc(comps: CircuitComponent[], ws: Wire[]): SimContext {
  const sim = solveDC(comps, ws, plugins());
  expect(sim).not.toBeNull();
  return sim!;
}

/** Supply current [A] read through an ammeter in series with the rail. */
function supplyCurrent(comps: CircuitComponent[], ws: Wire[], sim: SimContext, ammeterId: string): number {
  const rows = measureOf(comps, ws, sim, ammeterId);
  const row = rows.find(r => r.label === 'I')!;
  return parseFloat(row.value) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

describe('IO/display: registration', () => {
  const cases: { type: string; part: string; category: string; terms: string[]; params: string[] }[] = [
    { type: 'rotaryEncoder', part: 'EC11', category: 'sensor', terms: ['vcc', 'gnd', 'a', 'b', 'sw'], params: ['vcc', 'position', 'detents', 'pressed'] },
    { type: 'ws2812b', part: 'WS2812B', category: 'io', terms: ['vcc', 'gnd', 'din', 'dout'], params: ['red', 'green', 'blue', 'brightness', 'ledCurrent_mA'] },
    { type: 'rgbLed', part: 'RGB', category: 'io', terms: ['r', 'g', 'b', 'k'], params: ['vfR', 'vfG', 'vfB', 'rs'] },
    { type: 'buzzer', part: 'Buzzer', category: 'io', terms: ['pos', 'neg'], params: ['ratedVoltage', 'frequency', 'current_mA'] },
    { type: 'electretMic', part: 'Electret', category: 'sensor', terms: ['out', 'gnd'], params: ['spl_dB', 'sensitivity'] },
    { type: 'lcd1602', part: 'LCD', category: 'io', terms: ['vcc', 'gnd', 'sda', 'scl'], params: ['vcc', 'backlight', 'row1Text', 'row2Text', 'contrast'] },
    { type: 'ssd1306', part: 'OLED', category: 'io', terms: ['vcc', 'gnd', 'sda', 'scl'], params: ['vcc', 'contrast', 'on', 'text'] },
    { type: 'nrf24l01', part: 'nRF24L01', category: 'ic', terms: ['vcc', 'gnd', 'ce', 'csn', 'sck', 'mosi', 'miso', 'irq'], params: ['vcc', 'mode', 'channel', 'powerLevel', 'dataReady'] },
    { type: 'esp32dev', part: 'ESP32', category: 'mcu', terms: ['vin', 'gnd', '3v3', 'gnd2', 'en', 'd2', 'rx0', 'tx0', 'd23', 'vp', 'vn'], params: ['wifiMode', 'gpio2'] },
  ];
  for (const { type, part, category, terms, params } of cases) {
    it(`${type} registers with expected terminals, category and params`, () => {
      const p = getPlugin(type);
      expect(p).toBeDefined();
      expect(p!.category).toBe(category);
      expect(p!.name).toContain(part);
      for (const t of terms) expect(p!.terminals.some(tt => tt.id === t)).toBe(true);
      for (const k of params) expect(p!.parameters.some(pp => pp.key === k)).toBe(true);
    });
  }

  it('esp32dev exposes the full 30-pin DevKitC pinout', () => {
    const p = getPlugin('esp32dev')!;
    expect(p.terminals.length).toBe(30);
    const ids = p.terminals.map(t => t.id);
    // left column: 15 pins ending in gnd/vin; right column: 15 starting 3v3
    expect(ids.slice(0, 15)).toEqual(['en', 'vp', 'vn', 'd34', 'd35', 'd32', 'd33', 'd25', 'd26', 'd27', 'd14', 'd12', 'd13', 'gnd', 'vin']);
    expect(ids.slice(15)).toEqual(['3v3', 'gnd2', 'd15', 'd2', 'd4', 'rx2', 'tx2', 'd5', 'd18', 'd19', 'd21', 'rx0', 'tx0', 'd22', 'd23']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rotaryEncoder — quadrature gray code + SW contact
// ─────────────────────────────────────────────────────────────────────────────

function encCirc(position = 0, pressed = false, extra: Record<string, any> = {}) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
    comp('rotaryEncoder', 'U1', [6, 0], { position, pressed, ...extra }),
    comp('voltmeter', 'VMA', [12, 0]),
    comp('voltmeter', 'VMB', [12, 4]),
    comp('ground', 'GND', [12, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'U1', 'vcc'),
    wire('w2', 'U1', 'gnd', 'GND', 'g'),
    wire('w3', 'VS', 'n', 'GND', 'g'),
    wire('w4', 'VMA', 'p', 'U1', 'a'),
    wire('w5', 'VMA', 'n', 'GND', 'g'),
    wire('w6', 'VMB', 'p', 'U1', 'b'),
    wire('w7', 'VMB', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('rotaryEncoder: quadrature truth table', () => {
  // state = position mod 4 → A/B gray-code sequence 00, 10, 11, 01
  const table: { pos: number; a: boolean; b: boolean }[] = [
    { pos: 0, a: false, b: false },
    { pos: 1, a: true, b: false },
    { pos: 2, a: true, b: true },
    { pos: 3, a: false, b: true },
  ];
  for (const { pos, a, b } of table) {
    it(`position ${pos} → A=${a ? 1 : 0}, B=${b ? 1 : 0}`, () => {
      const { comps, ws } = encCirc(pos);
      const sim = dc(comps, ws);
      const va = vOf(comps, ws, sim, 'U1', 'a');
      const vb = vOf(comps, ws, sim, 'U1', 'b');
      if (a) expect(va).toBeGreaterThan(3.2); else expect(va).toBeLessThan(0.05);
      if (b) expect(vb).toBeGreaterThan(3.2); else expect(vb).toBeLessThan(0.05);
    });
  }

  it('negative positions wrap: position −1 → state 3 (A=0, B=1)', () => {
    const { comps, ws } = encCirc(-1);
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'a')).toBeLessThan(0.05);
    expect(vOf(comps, ws, sim, 'U1', 'b')).toBeGreaterThan(3.2);
  });

  it('SW pressed pulls the (externally pulled-up) switch node to ~0 V', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
      comp('rotaryEncoder', 'U1', [6, 0], { pressed: true }),
      comp('resistor', 'RPU', [12, 0], { resistance: 10000 }),
      comp('voltmeter', 'VM', [12, 4]),
      comp('ground', 'GND', [12, 8]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vcc'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'RPU', 'a', 'VS', 'p'),
      wire('w5', 'RPU', 'b', 'U1', 'sw'),
      wire('w6', 'VM', 'p', 'U1', 'sw'),
      wire('w7', 'VM', 'n', 'GND', 'g'),
    ];
    const sim = dc(comps, ws);
    const v = vOf(comps, ws, sim, 'U1', 'sw');
    expect(v).toBeGreaterThan(0.005);  // 3.3·100/10100 ≈ 33 mV
    expect(v).toBeLessThan(0.05);
  });

  it('SW released leaves the pull-up high', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
      comp('rotaryEncoder', 'U1', [6, 0], { pressed: false }),
      comp('resistor', 'RPU', [12, 0], { resistance: 10000 }),
      comp('voltmeter', 'VM', [12, 4]),
      comp('ground', 'GND', [12, 8]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vcc'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'RPU', 'a', 'VS', 'p'),
      wire('w5', 'RPU', 'b', 'U1', 'sw'),
      wire('w6', 'VM', 'p', 'U1', 'sw'),
      wire('w7', 'VM', 'n', 'GND', 'g'),
    ];
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'sw')).toBeGreaterThan(3.2);
  });

  it('measure() reports position, state, A/B levels and SW state', () => {
    const { comps, ws } = encCirc(2, true);
    const sim = dc(comps, ws);
    const rows = measureOf(comps, ws, sim, 'U1');
    const by = Object.fromEntries(rows.map(r => [r.label, r.value]));
    expect(by['Pos']).toBe('2');
    expect(by['State']).toBe('2');
    expect(parseFloat(by['A'])).toBeGreaterThan(3.2);
    expect(parseFloat(by['B'])).toBeGreaterThan(3.2);
    expect(by['SW']).toBe('PRESSED');
    expect(by['Detent']).toBe('0'); // detents=true → floor(2/4)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ws2812b — per-channel current sinks + data repeater
// ─────────────────────────────────────────────────────────────────────────────

function wsCirc(r: number, g: number, b: number, brightness = 1) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('ammeter', 'A1', [4, 0]),
    comp('ws2812b', 'U1', [8, 0], { red: r, green: g, blue: b, brightness }),
    comp('ground', 'GND', [8, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'A1', 'p'),
    wire('w2', 'A1', 'n', 'U1', 'vcc'),
    wire('w3', 'U1', 'gnd', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('ws2812b: channel currents', () => {
  it('full white (255,255,255) at brightness 1 → ≈ 3 × 20 mA', () => {
    const { comps, ws } = wsCirc(255, 255, 255);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.058);
    expect(i).toBeLessThan(0.062);
  });

  it('half brightness halves the total current', () => {
    const { comps, ws } = wsCirc(255, 255, 255, 0.5);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.028);
    expect(i).toBeLessThan(0.032);
  });

  it('black (0,0,0) draws no current', () => {
    const { comps, ws } = wsCirc(0, 0, 0);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(Math.abs(i)).toBeLessThan(1e-6);
  });

  it('per-channel scaling: (255,0,0) → 20 mA, (128,0,0) → ≈ 10 mA', () => {
    const full = wsCirc(255, 0, 0);
    const simF = dc(full.comps, full.ws);
    const iF = supplyCurrent(full.comps, full.ws, simF, 'A1');
    expect(iF).toBeGreaterThan(0.019);
    expect(iF).toBeLessThan(0.021);
    const half = wsCirc(128, 0, 0);
    const simH = dc(half.comps, half.ws);
    const iH = supplyCurrent(half.comps, half.ws, simH, 'A1');
    expect(iH).toBeGreaterThan(0.0095);
    expect(iH).toBeLessThan(0.0105);
  });

  it('DOUT repeats DIN (Driver: low → ~0 V, high → rail level)', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'VDIN', [0, 6], { voltage: 0 }),
      comp('ws2812b', 'U1', [8, 0], { red: 255, green: 0, blue: 0 }),
      comp('voltmeter', 'VM', [14, 0]),
      comp('ground', 'GND', [14, 8]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vcc'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'VDIN', 'p', 'U1', 'din'),
      wire('w5', 'VDIN', 'n', 'GND', 'g'),
      wire('w6', 'VM', 'p', 'U1', 'dout'),
      wire('w7', 'VM', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws);
    d.settle(2);
    expect(d.v('U1', 'dout')).toBeLessThan(0.05);        // DIN low → DOUT low
    d.set('VDIN', 'voltage', 5).settle(2);
    expect(d.v('U1', 'dout')).toBeGreaterThan(4.9);      // DIN high → DOUT at rail
    d.set('VDIN', 'voltage', 0).settle(2);
    expect(d.v('U1', 'dout')).toBeLessThan(0.05);
  });

  it('DIN at 3.3 V logic still reads high (threshold 1.65 V)', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'VDIN', [0, 6], { voltage: 3.3 }),
      comp('ws2812b', 'U1', [8, 0]),
      comp('voltmeter', 'VM', [14, 0]),
      comp('ground', 'GND', [14, 8]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vcc'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'VDIN', 'p', 'U1', 'din'),
      wire('w5', 'VDIN', 'n', 'GND', 'g'),
      wire('w6', 'VM', 'p', 'U1', 'dout'),
      wire('w7', 'VM', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws);
    d.settle(2);
    expect(d.v('U1', 'dout')).toBeGreaterThan(4.9);
  });

  it('measure() reports per-channel currents, total and hex color', () => {
    const { comps, ws } = wsCirc(255, 128, 0, 0.5);
    const sim = dc(comps, ws);
    const rows = measureOf(comps, ws, sim, 'U1');
    const by = Object.fromEntries(rows.map(r => [r.label, r.value]));
    expect(parseFloat(by['I R'])).toBeCloseTo(10, 1);
    expect(parseFloat(by['I G'])).toBeCloseTo(5.02, 1);
    expect(parseFloat(by['I B'])).toBeCloseTo(0, 3);
    expect(parseFloat(by['Itotal'])).toBeCloseTo(15, 1);
    expect(by['Color']).toBe('#804000'); // brightness-scaled: (255,128,0)·0.5
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rgbLed — three diodes sharing one cathode
// ─────────────────────────────────────────────────────────────────────────────

/** One channel driven from `supply` V through 220 Ω; returns {comps, ws}. */
function rgbCirc(channels: { r?: boolean; g?: boolean; b?: boolean }, supply = 5) {
  const comps: CircuitComponent[] = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: supply }),
    comp('ammeter', 'AK', [4, 4]), // cathode current = sum of channels
    comp('rgbLed', 'U1', [8, 0]),
    comp('ground', 'GND', [8, 8]),
  ];
  const ws: Wire[] = [
    wire('wg', 'U1', 'k', 'AK', 'p'),
    wire('wk', 'AK', 'n', 'GND', 'g'),
    wire('w0', 'VS', 'n', 'GND', 'g'),
  ];
  let n = 0;
  for (const ch of ['r', 'g', 'b'] as const) {
    if (!channels[ch]) continue;
    n++;
    comps.push(comp('resistor', `R${ch}`, [4, 2 * n], { resistance: 220 }));
    ws.push(wire(`ws${ch}`, 'VS', 'p', `R${ch}`, 'a'));
    ws.push(wire(`wd${ch}`, `R${ch}`, 'b', 'U1', ch));
  }
  return { comps, ws };
}

describe('rgbLed: diode channels', () => {
  it('red at 5 V through 220 Ω → ~10 mA region (Vf 2.0 + 22 Ω)', () => {
    const { comps, ws } = rgbCirc({ r: true });
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'AK');
    expect(i).toBeGreaterThan(0.009);   // (5−2)/(220+22) ≈ 12.4 mA
    expect(i).toBeLessThan(0.016);
  });

  it('blue at 2.6 V does not conduct meaningfully (Vf 3.0)', () => {
    const { comps, ws } = rgbCirc({ b: true }, 2.6);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'AK');
    expect(Math.abs(i)).toBeLessThan(0.0001); // leakage only
  });

  it('blue at 5 V conducts ((5−3)/(220+22) ≈ 8.3 mA)', () => {
    const { comps, ws } = rgbCirc({ b: true });
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'AK');
    expect(i).toBeGreaterThan(0.006);
    expect(i).toBeLessThan(0.011);
  });

  it('shared cathode carries the sum of the conducting channels', () => {
    const rOnly = rgbCirc({ r: true });
    const simR = dc(rOnly.comps, rOnly.ws);
    const iR = supplyCurrent(rOnly.comps, rOnly.ws, simR, 'AK');
    const bOnly = rgbCirc({ b: true });
    const simB = dc(bOnly.comps, bOnly.ws);
    const iB = supplyCurrent(bOnly.comps, bOnly.ws, simB, 'AK');
    const both = rgbCirc({ r: true, b: true });
    const simRB = dc(both.comps, both.ws);
    const iRB = supplyCurrent(both.comps, both.ws, simRB, 'AK');
    expect(iRB).toBeGreaterThan(iR + iB - 0.0005);
    expect(iRB).toBeLessThan(iR + iB + 0.0005);
  });

  it('measure() reports per-channel currents, Vf, dominant color and hex mix', () => {
    const { comps, ws } = rgbCirc({ r: true });
    const sim = dc(comps, ws);
    const rows = measureOf(comps, ws, sim, 'U1');
    const by = Object.fromEntries(rows.map(r => [r.label, r.value]));
    expect(parseFloat(by['I R'])).toBeGreaterThan(9);
    expect(parseFloat(by['I R'])).toBeLessThan(16);
    expect(parseFloat(by['I G'])).toBeCloseTo(0, 5);
    expect(parseFloat(by['I B'])).toBeCloseTo(0, 5);
    expect(by['Dominant']).toBe('red');
    expect(by['Color']).toBe('#ff0000');
    expect(parseFloat(by['Vf R'])).toBeCloseTo(2.0, 1);
  });

  it('per-channel conduction state is comp-id keyed (two LEDs independent)', () => {
    const comps: CircuitComponent[] = [
      comp('dcVoltage', 'VS1', [0, 0], { voltage: 5 }),   // drives U1 red (conducts)
      comp('dcVoltage', 'VS2', [0, 8], { voltage: 2.6 }), // below blue Vf (off)
      comp('rgbLed', 'U1', [8, 0]),
      comp('rgbLed', 'U2', [8, 8]),
      comp('resistor', 'R1', [4, 0], { resistance: 220 }),
      comp('resistor', 'R2', [4, 8], { resistance: 220 }),
      comp('ground', 'GND', [12, 12]),
    ];
    const ws = [
      wire('w0', 'VS1', 'n', 'GND', 'g'),
      wire('w0b', 'VS2', 'n', 'GND', 'g'),
      wire('w1', 'VS1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'U1', 'r'),
      wire('w3', 'U1', 'k', 'GND', 'g'),
      wire('w4', 'VS2', 'p', 'R2', 'a'),
      wire('w5', 'R2', 'b', 'U2', 'b'),
      wire('w6', 'U2', 'k', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws);
    d.settle(3);
    const g = (d.sim!.state.__global ?? {}) as Record<string, any>;
    expect((g['rgbled_U1'] as any).r).toBe(true);   // 5 V > Vf red
    expect((g['rgbled_U2'] as any).b).toBe(false);  // 2.6 V < Vf blue
    const rows = measureOf(comps, ws, d.sim!, 'U2');
    const by = Object.fromEntries(rows.map(r => [r.label, r.value]));
    expect(parseFloat(by['I B'])).toBeLessThan(0.0001);
    // power U2's blue from 5 V now: it turns on while U1 keeps its state
    d.set('VS2', 'voltage', 5).settle(3);
    expect((g['rgbled_U2'] as any).b).toBe(true);
    const rows2 = measureOf(comps, ws, d.sim!, 'U2');
    const by2 = Object.fromEntries(rows2.map(r => [r.label, r.value]));
    expect(parseFloat(by2['I B'])).toBeGreaterThan(0.006);
    expect((g['rgbled_U1'] as any).r).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buzzer — coil resistance + active threshold
// ─────────────────────────────────────────────────────────────────────────────

function bzCirc(supply = 5) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: supply }),
    comp('ammeter', 'A1', [4, 0]),
    comp('buzzer', 'U1', [8, 0]),
    comp('ground', 'GND', [8, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'A1', 'p'),
    wire('w2', 'A1', 'n', 'U1', 'pos'),
    wire('w3', 'U1', 'neg', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('buzzer: coil current and active state', () => {
  it('5 V across → ≈ 30 mA (R = 5 V / 30 mA ≈ 167 Ω)', () => {
    const { comps, ws } = bzCirc(5);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.029);
    expect(i).toBeLessThan(0.031);
  });

  it('3 V across → ≈ 18 mA (same coil)', () => {
    const { comps, ws } = bzCirc(3);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.0175);
    expect(i).toBeLessThan(0.0185);
  });

  it('active threshold: 5 V ≥ 0.8·rated → ON; 3 V < 4 V → OFF', () => {
    const on = bzCirc(5);
    const simOn = dc(on.comps, on.ws);
    const rowsOn = measureOf(on.comps, on.ws, simOn, 'U1');
    expect(Object.fromEntries(rowsOn.map(r => [r.label, r.value]))['State']).toBe('ON');
    const off = bzCirc(3);
    const simOff = dc(off.comps, off.ws);
    const rowsOff = measureOf(off.comps, off.ws, simOff, 'U1');
    expect(Object.fromEntries(rowsOff.map(r => [r.label, r.value]))['State']).toBe('OFF');
  });

  it('measure() reports V, I, frequency and state', () => {
    const { comps, ws } = bzCirc(5);
    const sim = dc(comps, ws);
    const by = Object.fromEntries(measureOf(comps, ws, sim, 'U1').map(r => [r.label, r.value]));
    expect(parseFloat(by['V'])).toBeCloseTo(5, 1);
    expect(parseFloat(by['I'])).toBeCloseTo(30, 0);
    expect(by['Freq']).toBe('2300');
    expect(by['State']).toBe('ON');
  });

  it('step() stashes the solved voltage for the render (simState.__buzzer)', () => {
    const { comps, ws } = bzCirc(5);
    const d = new Driver(comps, ws);
    d.settle(2);
    const bz = (d.comps.find(c => c.id === 'U1')!.simState as any).__buzzer;
    expect(bz.v).toBeGreaterThan(4.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// electretMic — FET bias sink + signal amplitude readout
// ─────────────────────────────────────────────────────────────────────────────

function micCirc(spl = 60, pullUp = 2200) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('resistor', 'RPU', [4, 0], { resistance: pullUp }),
    comp('electretMic', 'U1', [8, 0], { spl_dB: spl }),
    comp('voltmeter', 'VM', [8, 4]),
    comp('ground', 'GND', [8, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'RPU', 'a'),
    wire('w2', 'RPU', 'b', 'U1', 'out'),
    wire('w3', 'U1', 'gnd', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
    wire('w5', 'VM', 'p', 'U1', 'out'),
    wire('w6', 'VM', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('electretMic: FET bias and signal readout', () => {
  it('with a 2.2 kΩ pull-up to 5 V the output sits at 5 − 0.5 mA·2.2 kΩ ≈ 3.9 V', () => {
    const { comps, ws } = micCirc();
    const sim = dc(comps, ws);
    const v = vOf(comps, ws, sim, 'U1', 'out');
    expect(v).toBeGreaterThan(3.85);
    expect(v).toBeLessThan(3.95);
  });

  it('a weaker pull-up (10 kΩ) pulls the node toward the rail — FET limits it', () => {
    // 5 − 0.5 mA·10 kΩ would be negative → the ohmic region clamps near 0.4 V
    const { comps, ws } = micCirc(60, 10000);
    const sim = dc(comps, ws);
    const v = vOf(comps, ws, sim, 'U1', 'out');
    expect(v).toBeGreaterThan(0.1);
    expect(v).toBeLessThan(1.0);
  });

  it('without a pull-up the node stays near 0 V (ohmic region, no rail)', () => {
    const comps = [
      comp('electretMic', 'U1', [0, 0]),
      comp('voltmeter', 'VM', [4, 0]),
      comp('ground', 'GND', [4, 4]),
    ];
    const ws = [
      wire('w1', 'VM', 'p', 'U1', 'out'),
      wire('w2', 'VM', 'n', 'GND', 'g'),
      wire('w3', 'U1', 'gnd', 'GND', 'g'),
    ];
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'out')).toBeLessThan(0.1);
  });

  it('measure(): signal amplitude grows with spl_dB (60 → 80 dB = ×10)', () => {
    const q = micCirc(60);
    const sim60 = dc(q.comps, q.ws);
    const by60 = Object.fromEntries(measureOf(q.comps, q.ws, sim60, 'U1').map(r => [r.label, r.value]));
    const q80 = micCirc(80);
    const sim80 = dc(q80.comps, q80.ws);
    const by80 = Object.fromEntries(measureOf(q80.comps, q80.ws, sim80, 'U1').map(r => [r.label, r.value]));
    // 2 · 10^(−38/20) · 20 µPa · 10^(spl/20) · 1000 mV
    expect(parseFloat(by60['Signal'])).toBeCloseTo(0.504, 2);
    expect(parseFloat(by80['Signal'])).toBeCloseTo(5.036, 1);
    expect(parseFloat(by80['Signal'])).toBeGreaterThan(parseFloat(by60['Signal']) * 9);
  });

  it('measure(): bias current 0.5 mA and pull-up detection', () => {
    const { comps, ws } = micCirc();
    const sim = dc(comps, ws);
    const by = Object.fromEntries(measureOf(comps, ws, sim, 'U1').map(r => [r.label, r.value]));
    expect(by['Bias']).toBe('0.50');
    expect(by['Pull-up']).toBe('UP');
    expect(parseFloat(by['Vout'])).toBeGreaterThan(3.85);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lcd1602 — current draw + open-drain I2C bus
// ─────────────────────────────────────────────────────────────────────────────

function lcdCirc(backlight = true) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('ammeter', 'A1', [4, 0]),
    comp('lcd1602', 'U1', [8, 0], { backlight }),
    comp('ground', 'GND', [8, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'A1', 'p'),
    wire('w2', 'A1', 'n', 'U1', 'vcc'),
    wire('w3', 'U1', 'gnd', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('lcd1602: supply current and I2C pins', () => {
  it('backlight on → 1.2 mA logic + 22 mA backlight ≈ 23.2 mA', () => {
    const { comps, ws } = lcdCirc(true);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.0225);
    expect(i).toBeLessThan(0.024);
  });

  it('backlight off → 1.2 mA logic only', () => {
    const { comps, ws } = lcdCirc(false);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.001);
    expect(i).toBeLessThan(0.0015);
  });

  it('SDA with an external 4.7 kΩ pull-up reads HIGH (open-drain leak only)', () => {
    const { comps, ws } = lcdCirc(true);
    comps.push(comp('resistor', 'RSDA', [12, 4], { resistance: 4700 }));
    ws.push(wire('w5', 'RSDA', 'a', 'VS', 'p'));
    ws.push(wire('w6', 'RSDA', 'b', 'U1', 'sda'));
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'sda')).toBeGreaterThan(4.9);
  });

  it('measure() reports current, backlight state and (truncated) texts', () => {
    const { comps, ws } = lcdCirc(true);
    const sim = dc(comps, ws);
    const by = Object.fromEntries(measureOf(comps, ws, sim, 'U1').map(r => [r.label, r.value]));
    expect(parseFloat(by['I'])).toBeGreaterThan(22.5);
    expect(parseFloat(by['I'])).toBeLessThan(24);
    expect(by['Backlight']).toBe('ON');
    expect(by['Row1']).toBe('Hello CircuitLab');
    expect(by['Row2']).toBe('(empty)');
    // long text truncates to 16 characters
    const long = lcdCirc(true);
    long.comps.find(c => c.id === 'U1')!.parameters.row1Text = 'ThisIsAVeryLongTextOver16';
    const sim2 = dc(long.comps, long.ws);
    const by2 = Object.fromEntries(measureOf(long.comps, long.ws, sim2, 'U1').map(r => [r.label, r.value]));
    expect(by2['Row1'].length).toBe(16);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ssd1306 — contrast-scaled current
// ─────────────────────────────────────────────────────────────────────────────

function oledCirc(on = true, contrast = 0.8) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
    comp('ammeter', 'A1', [4, 0]),
    comp('ssd1306', 'U1', [8, 0], { on, contrast }),
    comp('ground', 'GND', [8, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'A1', 'p'),
    wire('w2', 'A1', 'n', 'U1', 'vcc'),
    wire('w3', 'U1', 'gnd', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('ssd1306: OLED current', () => {
  it('on at contrast 0.8 → 12 + 10·0.8 = 20 mA', () => {
    const { comps, ws } = oledCirc(true, 0.8);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.0195);
    expect(i).toBeLessThan(0.0205);
  });

  it('off → no current', () => {
    const { comps, ws } = oledCirc(false);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(Math.abs(i)).toBeLessThan(1e-6);
  });

  it('contrast scales the current (0 → 12 mA, 0.4 → 16 mA)', () => {
    const lo = oledCirc(true, 0);
    const simLo = dc(lo.comps, lo.ws);
    const iLo = supplyCurrent(lo.comps, lo.ws, simLo, 'A1');
    expect(iLo).toBeGreaterThan(0.0115);
    expect(iLo).toBeLessThan(0.0125);
    const mid = oledCirc(true, 0.4);
    const simMid = dc(mid.comps, mid.ws);
    const iMid = supplyCurrent(mid.comps, mid.ws, simMid, 'A1');
    expect(iMid).toBeGreaterThan(0.0155);
    expect(iMid).toBeLessThan(0.0165);
  });

  it('measure() reports current, state and resolution', () => {
    const { comps, ws } = oledCirc(true, 0.8);
    const sim = dc(comps, ws);
    const by = Object.fromEntries(measureOf(comps, ws, sim, 'U1').map(r => [r.label, r.value]));
    expect(parseFloat(by['I'])).toBeGreaterThan(19.5);
    expect(by['State']).toBe('ON');
    expect(by['Res']).toBe('128×64');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nrf24l01 — mode current table, MISO, IRQ
// ─────────────────────────────────────────────────────────────────────────────

function rfCirc(mode = 'idle', extra: Record<string, any> = {}) {
  const comps = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
    comp('ammeter', 'A1', [4, 0]),
    comp('nrf24l01', 'U1', [8, 0], { mode, ...extra }),
    comp('ground', 'GND', [8, 8]),
  ];
  const ws = [
    wire('w1', 'VS', 'p', 'A1', 'p'),
    wire('w2', 'A1', 'n', 'U1', 'vcc'),
    wire('w3', 'U1', 'gnd', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
  ];
  return { comps, ws };
}

describe('nrf24l01: mode current table', () => {
  const table: { mode: string; power?: string; ma: number }[] = [
    { mode: 'idle', ma: 0.026 },
    { mode: 'tx', power: '0dB', ma: 11.3 },
    { mode: 'tx', power: 'm6dB', ma: 9.8 },
    { mode: 'tx', power: 'm12dB', ma: 8.3 },
    { mode: 'tx', power: 'm18dB', ma: 6.8 },
    { mode: 'rx', ma: 12.6 },
  ];
  for (const { mode, power, ma } of table) {
    it(`${mode}${power ? ` @ ${power}` : ''} → ${ma} mA`, () => {
      const { comps, ws } = rfCirc(mode, power ? { powerLevel: power } : {});
      const sim = dc(comps, ws);
      const i = supplyCurrent(comps, ws, sim, 'A1') * 1000;
      expect(Math.abs(i - ma)).toBeLessThan(0.05);
    });
  }

  it('TX current decreases monotonically with power level', () => {
    const currents = ['0dB', 'm6dB', 'm12dB', 'm18dB'].map(power => {
      const { comps, ws } = rfCirc('tx', { powerLevel: power });
      const sim = dc(comps, ws);
      return supplyCurrent(comps, ws, sim, 'A1');
    });
    for (let i = 1; i < currents.length; i++) {
      expect(currents[i]).toBeLessThan(currents[i - 1]);
    }
  });
});

describe('nrf24l01: MISO and IRQ', () => {
  function rfPins(mode: string, dataReady: boolean) {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }),
      comp('nrf24l01', 'U1', [8, 0], { mode, dataReady }),
      comp('resistor', 'RIRQ', [14, 0], { resistance: 10000 }),
      comp('voltmeter', 'VMM', [14, 4]),
      comp('voltmeter', 'VMI', [14, 8]),
      comp('ground', 'GND', [14, 12]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vcc'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'VMM', 'p', 'U1', 'miso'),
      wire('w5', 'VMM', 'n', 'GND', 'g'),
      wire('w6', 'RIRQ', 'a', 'VS', 'p'),
      wire('w7', 'RIRQ', 'b', 'U1', 'irq'),
      wire('w8', 'VMI', 'p', 'U1', 'irq'),
      wire('w9', 'VMI', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('MISO is HIGH (rail) in RX mode when dataReady', () => {
    const { comps, ws } = rfPins('rx', true);
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'miso')).toBeGreaterThan(3.2);
  });

  it('MISO stays LOW in RX mode without data, and in idle/tx modes', () => {
    for (const [mode, dr] of [['rx', false], ['idle', true], ['tx', true]] as [string, boolean][]) {
      const { comps, ws } = rfPins(mode, dr);
      const sim = dc(comps, ws);
      expect(vOf(comps, ws, sim, 'U1', 'miso')).toBeLessThan(0.05);
    }
  });

  it('IRQ open-drain: dataReady pulls the pulled-up IRQ line LOW (~0.3 V)', () => {
    const on = rfPins('rx', true);
    const simOn = dc(on.comps, on.ws);
    const v = vOf(on.comps, on.ws, simOn, 'U1', 'irq');
    expect(v).toBeGreaterThan(0.2);   // 3.3·1k/11k ≈ 0.3 V
    expect(v).toBeLessThan(0.5);
  });

  it('IRQ released (no data) leaves the pull-up HIGH', () => {
    const off = rfPins('rx', false);
    const simOff = dc(off.comps, off.ws);
    expect(vOf(off.comps, off.ws, simOff, 'U1', 'irq')).toBeGreaterThan(3.2);
  });

  it('measure() reports mode, current, channel, power and pin levels', () => {
    const { comps, ws } = rfPins('rx', true);
    const sim = dc(comps, ws);
    const by = Object.fromEntries(measureOf(comps, ws, sim, 'U1').map(r => [r.label, r.value]));
    expect(by['Mode']).toBe('RX');
    expect(parseFloat(by['I'])).toBeCloseTo(12.6, 1);
    expect(by['Chan']).toBe('76');
    expect(by['Power']).toBe('0');
    expect(parseFloat(by['MISO'])).toBeGreaterThan(3.2);
    expect(parseFloat(by['Freq'])).toBe(2476);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// esp32dev — LDO rail, WiFi currents, GPIO2, EN pull-up
// ─────────────────────────────────────────────────────────────────────────────

function espCirc(wifiMode = 'idle', load = 0) {
  const comps: CircuitComponent[] = [
    comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
    comp('ammeter', 'A1', [4, 0]),
    comp('esp32dev', 'U1', [8, 0], { wifiMode }),
    comp('ground', 'GND', [8, 20]),
  ];
  const ws: Wire[] = [
    wire('w1', 'VS', 'p', 'A1', 'p'),
    wire('w2', 'A1', 'n', 'U1', 'vin'),
    wire('w3', 'U1', 'gnd', 'GND', 'g'),
    wire('w4', 'VS', 'n', 'GND', 'g'),
  ];
  if (load > 0) {
    comps.push(comp('resistor', 'RL', [16, 0], { resistance: load }));
    ws.push(wire('w5', 'RL', 'a', 'U1', '3v3'));
    ws.push(wire('w6', 'RL', 'b', 'GND', 'g'));
  }
  return { comps, ws };
}

describe('esp32dev: 3V3 LDO rail', () => {
  it('VIN = 5 V → 3V3 rail ≈ 3.3 V under a 100 Ω load', () => {
    const { comps, ws } = espCirc('idle', 100);
    const sim = dc(comps, ws);
    const v3 = vOf(comps, ws, sim, 'U1', '3v3');
    expect(v3).toBeGreaterThan(3.25);  // 3.3·100/100.1 ≈ 3.297 through 0.1 Ω
    expect(v3).toBeLessThan(3.35);
  });

  it('VIN current = module (60 mA idle) + 33 mA load ≈ 93 mA', () => {
    const { comps, ws } = espCirc('idle', 100);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.090);
    expect(i).toBeLessThan(0.096);
  });

  it('dropout: VIN = 3.4 V (< 3.3 + 0.3) leaves the rail below 3.3 V', () => {
    const { comps, ws } = espCirc('idle', 100);
    comps.find(c => c.id === 'VS')!.parameters.voltage = 3.4;
    const sim = dc(comps, ws);
    const v3 = vOf(comps, ws, sim, 'U1', '3v3');
    expect(v3).toBeGreaterThan(2.5);
    expect(v3).toBeLessThan(3.29); // tracks Vin − 0.3 − I·ron
  });

  it('current limit: a 3 Ω load (would draw >1 A) is capped at 600 mA', () => {
    const { comps, ws } = espCirc('idle', 3);
    const sim = dc(comps, ws);
    const v3 = vOf(comps, ws, sim, 'U1', '3v3');
    expect(v3).toBeGreaterThan(1.5);   // ~0.6 A · 3 Ω ≈ 1.8 V
    expect(v3).toBeLessThan(2.5);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(i).toBeGreaterThan(0.55);
    expect(i).toBeLessThan(0.75);
  });
});

describe('esp32dev: module current by WiFi mode', () => {
  const modes: { mode: string; ma: number }[] = [
    { mode: 'off', ma: 40 },
    { mode: 'idle', ma: 60 },
    { mode: 'active', ma: 280 },
  ];
  for (const { mode, ma } of modes) {
    it(`wifiMode=${mode} → ${ma} mA from VIN (3V3 rail wired)`, () => {
      const { comps, ws } = espCirc(mode, 0);
      // wire the 3V3 pin to a voltmeter so the rail node exists
      comps.push(comp('voltmeter', 'VM3', [16, 0]));
      ws.push(wire('w5', 'VM3', 'p', 'U1', '3v3'));
      ws.push(wire('w6', 'VM3', 'n', 'GND', 'g'));
      const sim = dc(comps, ws);
      const i = supplyCurrent(comps, ws, sim, 'A1');
      // the module is a conductance load, so the current droops slightly with
      // the rail (V3 = 3.3 − I·0.1 Ω pass resistance) — ~0.85 % at 280 mA
      expect(Math.abs(i * 1000 - ma)).toBeLessThan(3);
      expect(vOf(comps, ws, sim, 'U1', '3v3')).toBeGreaterThan(3.25);
    });
  }

  it('currents are strictly monotonic: off < idle < active', () => {
    const currents = ['off', 'idle', 'active'].map(mode => {
      const { comps, ws } = espCirc(mode, 0);
      comps.push(comp('voltmeter', 'VM3', [16, 0]));
      ws.push(wire('w5', 'VM3', 'p', 'U1', '3v3'));
      ws.push(wire('w6', 'VM3', 'n', 'GND', 'g'));
      const sim = dc(comps, ws);
      return supplyCurrent(comps, ws, sim, 'A1');
    });
    expect(currents[0]).toBeLessThan(currents[1]);
    expect(currents[1]).toBeLessThan(currents[2]);
  });

  it('3V3 pin unwired but VIN powered: module current still drawn from VIN', () => {
    const { comps, ws } = espCirc('idle', 0);
    const sim = dc(comps, ws);
    const i = supplyCurrent(comps, ws, sim, 'A1');
    expect(Math.abs(i * 1000 - 60)).toBeLessThan(1);
  });
});

describe('esp32dev: GPIO2 and EN', () => {
  function espGpio(gpio2: boolean) {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('esp32dev', 'U1', [8, 0], { gpio2 }),
      comp('voltmeter', 'VMD2', [16, 0]),
      comp('voltmeter', 'VMEN', [16, 4]),
      comp('voltmeter', 'VM3', [16, 8]),
      comp('ground', 'GND', [16, 12]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vin'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'VMD2', 'p', 'U1', 'd2'),
      wire('w5', 'VMD2', 'n', 'GND', 'g'),
      wire('w6', 'VMEN', 'p', 'U1', 'en'),
      wire('w7', 'VMEN', 'n', 'GND', 'g'),
      wire('w8', 'VM3', 'p', 'U1', '3v3'),
      wire('w9', 'VM3', 'n', 'GND', 'g'),
    ];
    return { comps, ws };
  }

  it('gpio2 = true drives D2 at the 3.3 V rail level', () => {
    const { comps, ws } = espGpio(true);
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'd2')).toBeGreaterThan(3.2);
    expect(vOf(comps, ws, sim, 'U1', 'd2')).toBeLessThan(3.4);
  });

  it('gpio2 = false leaves D2 Hi-Z (reads ~0 V unloaded)', () => {
    const { comps, ws } = espGpio(false);
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'd2')).toBeLessThan(0.05);
  });

  it('D2 holds ~3.3 V through a 330 Ω load when gpio2 is high', () => {
    const { comps, ws } = espGpio(true);
    comps.push(comp('resistor', 'RLED', [20, 0], { resistance: 330 }));
    ws.push(wire('w10', 'RLED', 'a', 'U1', 'd2'));
    ws.push(wire('w11', 'RLED', 'b', 'GND', 'g'));
    const sim = dc(comps, ws);
    // 100 Ω Thevenin: 3.3·330/430 ≈ 2.53 V
    const v = vOf(comps, ws, sim, 'U1', 'd2');
    expect(v).toBeGreaterThan(2.3);
    expect(v).toBeLessThan(2.8);
  });

  it('EN is pulled up to the 3V3 rail through the internal 10 kΩ', () => {
    const { comps, ws } = espGpio(false);
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'en')).toBeGreaterThan(3.2);
  });

  it('EN pull-up also works with the 3V3 pin unwired (VIN-powered fallback)', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('esp32dev', 'U1', [8, 0]),
      comp('voltmeter', 'VMEN', [16, 0]),
      comp('ground', 'GND', [16, 8]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vin'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'VMEN', 'p', 'U1', 'en'),
      wire('w5', 'VMEN', 'n', 'GND', 'g'),
    ];
    const sim = dc(comps, ws);
    expect(vOf(comps, ws, sim, 'U1', 'en')).toBeGreaterThan(3.2);
  });

  it('measure() reports rails, current breakdown and gpio2 state', () => {
    const { comps, ws } = espGpio(true);
    comps.find(c => c.id === 'U1')!.parameters.wifiMode = 'active';
    const sim = dc(comps, ws);
    const by = Object.fromEntries(measureOf(comps, ws, sim, 'U1').map(r => [r.label, r.value]));
    expect(parseFloat(by['VIN'])).toBeCloseTo(5, 1);
    expect(parseFloat(by['3V3'])).toBeGreaterThan(3.25);
    expect(by['MCU']).toBe('40.0');
    expect(by['WiFi']).toBe('240.0');
    expect(by['Total']).toBe('280.0');
    expect(by['GPIO2']).toBe('HIGH');
    expect(by['Mode']).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Robustness: unwired outputs never leave a singular matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('IO/display: unwired outputs stay solvable', () => {
  it('every part solves with only its power pins wired (outputs open)', () => {
    const fixtures: { type: string; build: () => { comps: CircuitComponent[]; ws: Wire[] } }[] = [
      {
        type: 'rotaryEncoder', build: () => {
          const comps = [comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }), comp('rotaryEncoder', 'U1', [6, 0], { position: 2, pressed: true }), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'VS', 'p', 'U1', 'vcc'), wire('w2', 'U1', 'gnd', 'GND', 'g'), wire('w3', 'VS', 'n', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'ws2812b', build: () => {
          const comps = [comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }), comp('ws2812b', 'U1', [6, 0], { red: 255, green: 128, blue: 64 }), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'VS', 'p', 'U1', 'vcc'), wire('w2', 'U1', 'gnd', 'GND', 'g'), wire('w3', 'VS', 'n', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'rgbLed', build: () => {
          const comps = [comp('rgbLed', 'U1', [6, 0]), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'U1', 'k', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'buzzer', build: () => {
          const comps = [comp('buzzer', 'U1', [6, 0]), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'U1', 'neg', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'electretMic', build: () => {
          const comps = [comp('electretMic', 'U1', [6, 0]), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'U1', 'gnd', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'lcd1602', build: () => {
          const comps = [comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }), comp('lcd1602', 'U1', [6, 0]), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'VS', 'p', 'U1', 'vcc'), wire('w2', 'U1', 'gnd', 'GND', 'g'), wire('w3', 'VS', 'n', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'ssd1306', build: () => {
          const comps = [comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }), comp('ssd1306', 'U1', [6, 0]), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'VS', 'p', 'U1', 'vcc'), wire('w2', 'U1', 'gnd', 'GND', 'g'), wire('w3', 'VS', 'n', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'nrf24l01', build: () => {
          const comps = [comp('dcVoltage', 'VS', [0, 0], { voltage: 3.3 }), comp('nrf24l01', 'U1', [6, 0], { mode: 'rx', dataReady: true }), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'VS', 'p', 'U1', 'vcc'), wire('w2', 'U1', 'gnd', 'GND', 'g'), wire('w3', 'VS', 'n', 'GND', 'g')];
          return { comps, ws };
        },
      },
      {
        type: 'esp32dev', build: () => {
          const comps = [comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }), comp('esp32dev', 'U1', [6, 0], { gpio2: true }), comp('ground', 'GND', [12, 8])];
          const ws = [wire('w1', 'VS', 'p', 'U1', 'vin'), wire('w2', 'U1', 'gnd', 'GND', 'g'), wire('w3', 'VS', 'n', 'GND', 'g')];
          return { comps, ws };
        },
      },
    ];
    for (const { type, build } of fixtures) {
      const { comps, ws } = build();
      const sim = solveDC(comps, ws, plugins());
      expect(sim, `${type} must solve with outputs open`).not.toBeNull();
      for (let i = 0; i < sim!.nodeVoltage.length; i++) {
        expect(Number.isFinite(sim!.nodeVoltage[i])).toBe(true);
      }
    }
  });

  it('ws2812b drives nothing when DOUT feeds only a voltmeter (no singularity)', () => {
    const comps = [
      comp('dcVoltage', 'VS', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'VDIN', [0, 6], { voltage: 5 }),
      comp('ws2812b', 'U1', [8, 0]),
      comp('voltmeter', 'VM', [14, 0]),
      comp('ground', 'GND', [14, 8]),
    ];
    const ws = [
      wire('w1', 'VS', 'p', 'U1', 'vcc'),
      wire('w2', 'U1', 'gnd', 'GND', 'g'),
      wire('w3', 'VS', 'n', 'GND', 'g'),
      wire('w4', 'VDIN', 'p', 'U1', 'din'),
      wire('w5', 'VDIN', 'n', 'GND', 'g'),
      wire('w6', 'VM', 'p', 'U1', 'dout'),
      wire('w7', 'VM', 'n', 'GND', 'g'),
    ];
    const d = new Driver(comps, ws).settle(3);
    expect(d.v('U1', 'dout')).toBeGreaterThan(4.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// measure() shape sanity for all 9 parts
// ─────────────────────────────────────────────────────────────────────────────

describe('IO/display: measure() shapes', () => {
  it('every part returns ≥3 well-formed rows from a powered circuit', () => {
    const circuits: { type: string; cid: string; build: () => { comps: CircuitComponent[]; ws: Wire[] } }[] = [
      { type: 'rotaryEncoder', cid: 'U1', build: () => encCirc(1, true) },
      { type: 'ws2812b', cid: 'U1', build: () => wsCirc(255, 0, 0) },
      { type: 'rgbLed', cid: 'U1', build: () => rgbCirc({ r: true, b: true }) },
      { type: 'buzzer', cid: 'U1', build: () => bzCirc(5) },
      { type: 'electretMic', cid: 'U1', build: () => micCirc(70) },
      { type: 'lcd1602', cid: 'U1', build: () => lcdCirc(true) },
      { type: 'ssd1306', cid: 'U1', build: () => oledCirc(true, 0.5) },
      { type: 'nrf24l01', cid: 'U1', build: () => rfCirc('tx') },
      { type: 'esp32dev', cid: 'U1', build: () => espCirc('idle', 100) },
    ];
    for (const { type, cid, build } of circuits) {
      const { comps, ws } = build();
      const sim = dc(comps, ws);
      const rows = measureOf(comps, ws, sim, cid);
      expect(rows.length, `${type} measure rows`).toBeGreaterThanOrEqual(3);
      for (const row of rows) {
        expect(typeof row.label).toBe('string');
        expect(row.label.length).toBeGreaterThan(0);
        expect(typeof row.value).toBe('string');
        expect(row.value.length).toBeGreaterThan(0);
        expect(['string', 'undefined'].includes(typeof row.unit)).toBe(true);
      }
    }
  });
});
