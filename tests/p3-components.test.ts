// Tests for the P3 analog/discrete components: LM324, NE5532, LM311, LM393,
// LM1117, LT3045, IGBT, current-regulator diode (CRD), PTC thermistor, MOV,
// solid-state relay (SSR).

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(type: string, id: string, pos: [number, number], params?: any): any {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const pm of p.parameters) defaults[pm.key] = pm.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): any {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}
function plugins(): Map<string, any> {
  return new Map(getAllPlugins().map((p: any) => [p.type, p]));
}

/** solveDC + a voltage lookup helper keyed by '<compId>:<terminalId>'. */
function solveWithNodes(components: any[], wires: any[]) {
  const dc = solveDC(components, wires, plugins());
  expect(dc).not.toBeNull();
  const nm = buildNodeMap(components, wires, plugins());
  return {
    dc: dc!,
    v: (key: string) => dc!.nodeVoltage[nm.terminalNode.get(key)!],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration & parameter defaults
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: registration & defaults', () => {
  it('LM324 is registered with datasheet-realistic parameters', () => {
    const p = getPlugin('lm324');
    expect(p).toBeDefined();
    expect(p!.name).toBe('LM324');
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['inn', 'inp', 'out', 'vcc', 'vee']);
    expect(p!.parameters.find(x => x.key === 'gain')!.default).toBe(1e5);
    expect(p!.parameters.find(x => x.key === 'gbw')!.default).toBe(1.2e6);
    expect(p!.parameters.find(x => x.key === 'slewRate')!.default).toBe(0.5);
    expect(p!.parameters.find(x => x.key === 'voff')!.default).toBe(3);
    expect(p!.parameters.find(x => x.key === 'ibias')!.default).toBe(45);
    expect(p!.parameters.find(x => x.key === 'rout')!.default).toBe(300);
    expect(p!.parameters.find(x => x.key === 'voutMargin')!.default).toBe(1.4);
  });

  it('NE5532 is registered with datasheet-realistic parameters', () => {
    const p = getPlugin('ne5532');
    expect(p).toBeDefined();
    expect(p!.name).toBe('NE5532');
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['inn', 'inp', 'out', 'vcc', 'vee']);
    expect(p!.parameters.find(x => x.key === 'gbw')!.default).toBe(1e7);
    expect(p!.parameters.find(x => x.key === 'slewRate')!.default).toBe(9);
    expect(p!.parameters.find(x => x.key === 'voff')!.default).toBe(0.5);
    expect(p!.parameters.find(x => x.key === 'rout')!.default).toBe(10);
    expect(p!.parameters.find(x => x.key === 'voutMargin')!.default).toBe(2);
  });

  it('LM311 is registered with strobe pin', () => {
    const p = getPlugin('lm311');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['gnd', 'inn', 'inp', 'out', 'strobe', 'vcc']);
    expect(p!.parameters.find(x => x.key === 'voff')!.default).toBe(2);
    expect(p!.parameters.find(x => x.key === 'ron')!.default).toBe(10);
    expect(p!.parameters.find(x => x.key === 'vlow')!.default).toBe(0.2);
  });

  it('LM393 is registered without strobe pin', () => {
    const p = getPlugin('lm393');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['gnd', 'inn', 'inp', 'out', 'vcc']);
    expect(p!.parameters.find(x => x.key === 'voff')!.default).toBe(1);
    expect(p!.parameters.find(x => x.key === 'ibias')!.default).toBe(25);
  });

  it('LM1117 is registered with select output voltage', () => {
    const p = getPlugin('lm1117');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['gnd', 'in', 'out']);
    const outV = p!.parameters.find(x => x.key === 'outputV')!;
    expect(outV.type).toBe('select');
    expect(outV.options!.map(o => o.value)).toEqual(['1.8', '2.5', '3.3', '5.0']);
    expect(Number(outV.default)).toBeCloseTo(3.3, 5);
    expect(p!.parameters.find(x => x.key === 'dropoutV')!.default).toBe(1.1);
    expect(p!.parameters.find(x => x.key === 'ron')!.default).toBe(0.15);
    expect(p!.parameters.find(x => x.key === 'iq')!.default).toBe(0.005);
  });

  it('LT3045 is registered with low-noise LDO parameters', () => {
    const p = getPlugin('lt3045');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['gnd', 'in', 'out']);
    expect(p!.parameters.find(x => x.key === 'outputV')!.default).toBe(3.3);
    expect(p!.parameters.find(x => x.key === 'dropoutV')!.default).toBe(0.35);
    expect(p!.parameters.find(x => x.key === 'ron')!.default).toBe(0.05);
    expect(p!.parameters.find(x => x.key === 'iq')!.default).toBe(0.002);
  });

  it('IGBT is registered with gate/collector/emitter terminals', () => {
    const p = getPlugin('igbt');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['c', 'e', 'g']);
    expect(p!.parameters.find(x => x.key === 'vth')!.default).toBe(4.5);
    expect(p!.parameters.find(x => x.key === 'kp')!.default).toBe(2);
    expect(p!.parameters.find(x => x.key === 'ron')!.default).toBe(0.05);
    expect(p!.parameters.find(x => x.key === 'roff')!.default).toBe(1e9);
  });

  it('CRD is registered with 1mA regulated current', () => {
    const p = getPlugin('crd');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['a', 'k']);
    expect(p!.parameters.find(x => x.key === 'ip')!.default).toBe(0.001);
    expect(p!.parameters.find(x => x.key === 'vknee')!.default).toBe(3);
    expect(p!.parameters.find(x => x.key === 'roff')!.default).toBe(1e7);
  });

  it('PTC thermistor is registered with positive beta', () => {
    const p = getPlugin('ptc');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['a', 'b']);
    expect(p!.parameters.find(x => x.key === 'r25')!.default).toBe(1000);
    expect(p!.parameters.find(x => x.key === 'beta')!.default).toBe(1500);
    expect(p!.parameters.find(x => x.key === 'tempC')!.default).toBe(25);
  });

  it('MOV is registered with clamping parameters', () => {
    const p = getPlugin('mov');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['a', 'b']);
    expect(p!.parameters.find(x => x.key === 'vc')!.default).toBe(130);
    expect(p!.parameters.find(x => x.key === 'ron')!.default).toBe(1);
    expect(p!.parameters.find(x => x.key === 'rleak')!.default).toBe(1e7);
  });

  it('SSR is registered with LED input and isolated output', () => {
    const p = getPlugin('ssr');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id).sort()).toEqual(['inn', 'inp', 'out1', 'out2']);
    expect(p!.parameters.find(x => x.key === 'ledVf')!.default).toBe(1.2);
    expect(p!.parameters.find(x => x.key === 'rled')!.default).toBe(350);
    expect(p!.parameters.find(x => x.key === 'iTrigger')!.default).toBe(0.002);
    expect(p!.parameters.find(x => x.key === 'ron')!.default).toBe(0.1);
    expect(p!.parameters.find(x => x.key === 'zeroCross')!.default).toBe(1);
  });

  it('all 11 P3 analog types are in the registry', () => {
    const expected = ['lm324', 'ne5532', 'lm311', 'lm393', 'lm1117', 'lt3045', 'igbt', 'crd', 'ptc', 'mov', 'ssr'];
    for (const type of expected) expect(getPlugin(type)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Op-amp macromodels — LM324, NE5532
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: LM324 op-amp macromodel', () => {
  // Non-inverting amplifier, gain = 1 + Rf/Rg = 2, single 12V supply.
  function lm324Amp(vin: number) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 12 }),
      comp('dcVoltage', 'V2', [0, 6], { voltage: vin }),
      comp('lm324', 'U1', [6, 0]),
      comp('resistor', 'Rf', [14, 0], { resistance: 10000 }),
      comp('resistor', 'Rg', [14, 6], { resistance: 10000 }),
      comp('ground', 'GND', [14, 12]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'vcc'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'U1', 'vee'),
      wire('w4', 'V2', 'p', 'U1', 'inp'),
      wire('w5', 'V2', 'n', 'GND', 'g'),
      wire('w6', 'U1', 'out', 'Rf', 'a'),
      wire('w7', 'Rf', 'b', 'U1', 'inn'),
      wire('w8', 'Rg', 'a', 'U1', 'inn'),
      wire('w9', 'Rg', 'b', 'GND', 'g'),
    ];
    return solveWithNodes(components, wires);
  }

  it('non-inverting gain of 2 amplifies 1V to ~2V', () => {
    const { v } = lm324Amp(1);
    const vout = v('U1:out');
    expect(vout).toBeGreaterThan(1.8);
    expect(vout).toBeLessThan(2.2); // within 10% of 2.0
  });

  it('output saturates below the rail (Vcc − 1.4V swing margin)', () => {
    const { v } = lm324Amp(6); // closed-loop would want 12V
    const vout = v('U1:out');
    expect(vout).toBeLessThan(11.5); // below the 12V rail
    expect(vout).toBeGreaterThan(9.8); // and near Vcc−1.4 ≈ 10.6V
  });
});

describe('P3: NE5532 op-amp macromodel', () => {
  // Non-inverting amplifier, gain 2, ±15V supplies.
  function ne5532Amp(vin: number) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 15 }),
      comp('dcVoltage', 'V3', [0, 12], { voltage: -15 }),
      comp('dcVoltage', 'V2', [0, 6], { voltage: vin }),
      comp('ne5532', 'U1', [6, 0]),
      comp('resistor', 'Rf', [14, 0], { resistance: 10000 }),
      comp('resistor', 'Rg', [14, 6], { resistance: 10000 }),
      comp('ground', 'GND', [14, 12]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'vcc'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'V3', 'p', 'U1', 'vee'),
      wire('w4', 'V3', 'n', 'GND', 'g'),
      wire('w5', 'V2', 'p', 'U1', 'inp'),
      wire('w6', 'V2', 'n', 'GND', 'g'),
      wire('w7', 'U1', 'out', 'Rf', 'a'),
      wire('w8', 'Rf', 'b', 'U1', 'inn'),
      wire('w9', 'Rg', 'a', 'U1', 'inn'),
      wire('w10', 'Rg', 'b', 'GND', 'g'),
    ];
    return solveWithNodes(components, wires);
  }

  it('non-inverting gain of 2 amplifies 1V to ~2V on ±15V rails', () => {
    const { v } = ne5532Amp(1);
    const vout = v('U1:out');
    expect(vout).toBeGreaterThan(1.8);
    expect(vout).toBeLessThan(2.2);
  });

  it('output saturates below the +15V rail (±13V swing)', () => {
    const { v } = ne5532Amp(10); // closed-loop would want 20V
    const vout = v('U1:out');
    expect(vout).toBeLessThan(14); // below the +15V rail
    expect(vout).toBeGreaterThan(12); // and near +13V
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Comparators — LM311 (with strobe), LM393
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: LM311 comparator', () => {
  // V+ = 5V, V− = 0V, 10k pull-up to 5V. STROBE wired high (not asserted).
  function lm311Circuit(strobeToGnd: boolean) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('lm311', 'U1', [6, 0]),
      comp('resistor', 'R1', [14, 0], { resistance: 10000 }),
      comp('ground', 'GND', [14, 8]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'vcc'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'V1', 'p', 'U1', 'inp'), // V+ = 5V
      wire('w4', 'GND', 'g', 'U1', 'inn'), // V− = 0V
      wire('w5', 'V1', 'p', 'R1', 'a'), // pull-up from 5V
      wire('w6', 'R1', 'b', 'U1', 'out'),
      wire('w7', 'GND', 'g', 'U1', 'gnd'),
      strobeToGnd
        ? wire('w8', 'GND', 'g', 'U1', 'strobe') // strobe asserted low
        : wire('w8', 'V1', 'p', 'U1', 'strobe'), // strobe high (inactive)
    ];
    return solveWithNodes(components, wires);
  }

  it('pulls the output LOW when V+ > V− (strobe inactive)', () => {
    const { v } = lm311Circuit(false);
    const vout = v('U1:out');
    expect(vout).toBeLessThan(0.5); // saturated output transistor (~0.2V)
    expect(vout).toBeGreaterThan(0);
  });

  it('strobe low forces the output off — pulled HIGH by the pull-up', () => {
    const { v } = lm311Circuit(true);
    const vout = v('U1:out');
    expect(vout).toBeGreaterThan(4.5); // floats up to the 5V rail
  });
});

describe('P3: LM393 comparator', () => {
  function lm393Circuit(vPlusTo5: boolean) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('lm393', 'U1', [6, 0]),
      comp('resistor', 'R1', [14, 0], { resistance: 10000 }),
      comp('ground', 'GND', [14, 8]),
    ];
    const wires = vPlusTo5
      ? [
          wire('w1', 'V1', 'p', 'U1', 'vcc'),
          wire('w2', 'V1', 'n', 'GND', 'g'),
          wire('w3', 'V1', 'p', 'U1', 'inp'), // V+ = 5V
          wire('w4', 'GND', 'g', 'U1', 'inn'), // V− = 0V
          wire('w5', 'V1', 'p', 'R1', 'a'),
          wire('w6', 'R1', 'b', 'U1', 'out'),
          wire('w7', 'GND', 'g', 'U1', 'gnd'),
        ]
      : [
          wire('w1', 'V1', 'p', 'U1', 'vcc'),
          wire('w2', 'V1', 'n', 'GND', 'g'),
          wire('w3', 'GND', 'g', 'U1', 'inp'), // V+ = 0V
          wire('w4', 'V1', 'p', 'U1', 'inn'), // V− = 5V
          wire('w5', 'V1', 'p', 'R1', 'a'),
          wire('w6', 'R1', 'b', 'U1', 'out'),
          wire('w7', 'GND', 'g', 'U1', 'gnd'),
        ];
    return solveWithNodes(components, wires);
  }

  it('pulls the output LOW when V+ > V−', () => {
    const { v } = lm393Circuit(true);
    expect(v('U1:out')).toBeLessThan(0.5);
  });

  it('releases the output (pulled HIGH) when V+ < V−', () => {
    const { v } = lm393Circuit(false);
    expect(v('U1:out')).toBeGreaterThan(4.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LDO regulators — LM1117, LT3045
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: LM1117 LDO regulator', () => {
  function lm1117Circuit(vin: number, params?: any) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: vin }),
      comp('lm1117', 'U1', [6, 0], params),
      comp('resistor', 'R1', [14, 0], { resistance: 1000 }),
      comp('ground', 'GND', [14, 8]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'U1', 'out', 'R1', 'a'),
      wire('w4', 'R1', 'b', 'GND', 'g'),
      wire('w5', 'U1', 'gnd', 'GND', 'g'),
    ];
    return solveWithNodes(components, wires);
  }

  it('regulates a 5V input to 3.3V with a 1k load (default select outputV)', () => {
    const { v } = lm1117Circuit(5);
    const vout = v('U1:out');
    expect(vout).toBeGreaterThan(3.2);
    expect(vout).toBeLessThan(3.4);
  });

  it('drops out below regulation: 3.5V in → output ≈ Vin − dropout (~2.4V)', () => {
    const { v } = lm1117Circuit(3.5);
    const vout = v('U1:out');
    expect(vout).toBeLessThan(3.3); // not regulating
    expect(vout).toBeGreaterThan(0);
    expect(vout).toBeCloseTo(2.4, 0); // ≈ 3.5 − 1.1
  });
});

describe('P3: LT3045 LDO regulator', () => {
  it('regulates a 5V input to 3.3V with a 1k load', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('lt3045', 'U1', [6, 0]),
      comp('resistor', 'R1', [14, 0], { resistance: 1000 }),
      comp('ground', 'GND', [14, 8]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'in'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'U1', 'out', 'R1', 'a'),
      wire('w4', 'R1', 'b', 'GND', 'g'),
      wire('w5', 'U1', 'gnd', 'GND', 'g'),
    ];
    const { v } = solveWithNodes(components, wires);
    const vout = v('U1:out');
    expect(vout).toBeGreaterThan(3.2);
    expect(vout).toBeLessThan(3.4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IGBT
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: IGBT', () => {
  // 12V supply → 100Ω load → collector, emitter grounded. Gate driven by V2.
  function igbtCircuit(vgate: number) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 12 }),
      comp('dcVoltage', 'V2', [0, 8], { voltage: vgate }),
      comp('igbt', 'Q1', [8, 0]),
      comp('resistor', 'R1', [4, 0], { resistance: 100 }),
      comp('ground', 'GND', [8, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'Q1', 'c'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'Q1', 'e', 'GND', 'g'),
      wire('w5', 'V2', 'p', 'Q1', 'g'),
      wire('w6', 'V2', 'n', 'GND', 'g'),
    ];
    return solveWithNodes(components, wires);
  }

  it('gate at 0V → no conduction (load sees ~0V)', () => {
    const { v } = igbtCircuit(0);
    const vLoad = 12 - v('Q1:c'); // voltage across the 100Ω load
    expect(vLoad).toBeLessThan(0.01);
    expect(v('Q1:c')).toBeGreaterThan(11.9); // collector sits at the rail
  });

  it('gate at 10V → fully on, collector near emitter', () => {
    const { v } = igbtCircuit(10);
    const vce = v('Q1:c'); // emitter is grounded
    expect(vce).toBeLessThan(0.1); // V_CE(sat)-ish
    const iLoad = (12 - vce) / 100;
    expect(iLoad).toBeGreaterThan(0.11); // ~120mA through the load
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Current-regulator diode (CRD)
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: current-regulator diode', () => {
  it('regulates ~1mA through a series 1k resistor from a 12V source', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 12 }),
      comp('crd', 'D1', [6, 0]),
      comp('resistor', 'R1', [12, 0], { resistance: 1000 }),
      comp('ground', 'GND', [12, 8]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'D1', 'a'),
      wire('w2', 'D1', 'k', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const { v } = solveWithNodes(components, wires);
    // Current = V(R1)/1k; 12V − 3V knee leaves 9V of headroom ≫ enough.
    const i = v('R1:a') / 1000;
    expect(i).toBeGreaterThan(0.00085); // within 15% of 1mA
    expect(i).toBeLessThan(0.00115);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PTC thermistor
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: PTC thermistor', () => {
  function ptcDivider(tempC: number) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('resistor', 'R1', [4, 0], { resistance: 1000 }),
      comp('ptc', 'TH1', [10, 0], { tempC }),
      comp('ground', 'GND', [10, 8]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'TH1', 'a'),
      wire('w3', 'TH1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    return solveWithNodes(components, wires);
  }

  it('resistance at 25°C equals r25 (divider mid at 2.5V)', () => {
    const { v } = ptcDivider(25);
    expect(v('TH1:a')).toBeCloseTo(2.5, 1);
  });

  it('resistance rises at higher temperature (R > r25)', () => {
    const { v } = ptcDivider(85);
    // R(85°C) = 1k·exp(1500·(1/298.15 − 1/358.15)) ≈ 2.32k → node ≈ 3.49V
    expect(v('TH1:a')).toBeGreaterThan(3.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOV varistor
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: MOV varistor', () => {
  function movCircuit(vsource: number) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: vsource }),
      comp('resistor', 'R1', [4, 0], { resistance: 1000 }),
      comp('mov', 'RV1', [10, 0]),
      comp('ground', 'GND', [10, 8]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'RV1', 'a'),
      wire('w3', 'RV1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    return solveWithNodes(components, wires);
  }

  it('clamps a 200V surge through 1k to ≈ vc + I·ron (~130.07V)', () => {
    const { v } = movCircuit(200);
    const vmov = v('RV1:a');
    expect(vmov).toBeGreaterThan(129.5);
    expect(vmov).toBeLessThan(130.7);
  });

  it('leaks at 50V — voltage stays ≈ 50V across it', () => {
    const { v } = movCircuit(50);
    const vmov = v('RV1:a');
    expect(vmov).toBeGreaterThan(49.9);
    expect(vmov).toBeLessThan(50.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Solid-state relay
// ─────────────────────────────────────────────────────────────────────────────
describe('P3: solid-state relay', () => {
  // 5V input drive; 12V through a 100Ω load on the output side.
  function ssrCircuit(inputV: number, zeroCross: number) {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: inputV }),
      comp('ssr', 'K1', [6, 0], { zeroCross }),
      comp('dcVoltage', 'V2', [14, 0], { voltage: 12 }),
      comp('resistor', 'R1', [18, 0], { resistance: 100 }),
      comp('ground', 'GND', [10, 12]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'K1', 'inp'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'GND', 'g', 'K1', 'inn'),
      wire('w4', 'V2', 'p', 'R1', 'a'),
      wire('w5', 'R1', 'b', 'K1', 'out1'),
      wire('w6', 'K1', 'out2', 'GND', 'g'),
      wire('w7', 'V2', 'n', 'GND', 'g'),
    ];
    return solveWithNodes(components, wires);
  }

  it('input driven at 5V (random-turn-on) → output conducts', () => {
    const { v } = ssrCircuit(5, 0);
    const vout = v('K1:out1'); // out2 is grounded
    expect(vout).toBeLessThan(0.1); // small V across the closed switch
    const iLoad = (12 - vout) / 100;
    expect(iLoad).toBeGreaterThan(0.1); // carrying the load current
  });

  it('input at 0V → output open, load current ~0', () => {
    const { v } = ssrCircuit(0, 0);
    const vout = v('K1:out1');
    expect(vout).toBeGreaterThan(11.9); // no current → full supply across the SSR
    const iLoad = (12 - vout) / 100;
    expect(iLoad).toBeLessThan(1e-4);
  });

  it('zero-cross SSR never closes for a DC load (waits for a zero crossing)', () => {
    const { v } = ssrCircuit(5, 1);
    const vout = v('K1:out1');
    expect(vout).toBeGreaterThan(11.9); // still open: 12V DC never crosses zero
  });
});
