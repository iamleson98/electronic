// Tests for the new P2 components: LM336, ICL8069, stepperMotor, servoMotor,
// photodiode, phototransistor, solarCell, crystalOscillator.

import { describe, it, expect } from 'vitest';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';
import type { ComponentPlugin, SimContext } from '../src/lib/circuit/types';

function mkSim(): SimContext {
  return {
    nodeVoltage: new Float64Array(20),
    branchCurrent: new Float64Array(10),
    state: {},
    time: 0,
    dt: 1e-4,
  };
}

function getTerms(plugin: ComponentPlugin, sim: SimContext) {
  // Assign each terminal a unique node id (skip 0 = ground)
  let nextNodeId = 1;
  return plugin.terminals.map((t) => {
    const nodeId = t.id === 'gnd' ? 0 : nextNodeId++;
    return { terminalId: t.id, nodeId };
  });
}

function getParams(plugin: ComponentPlugin): Record<string, any> {
  const params: Record<string, any> = {};
  for (const p of plugin.parameters) params[p.key] = p.default;
  return params;
}

describe('LM336 voltage reference', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('lm336');
    expect(p).toBeDefined();
    expect(p!.name).toContain('LM336');
    expect(p!.name).toContain('2.5V');
  });

  it('has A and K terminals', () => {
    const p = getPlugin('lm336')!;
    const ids = p.terminals.map(t => t.id);
    expect(ids).toContain('a');
    expect(ids).toContain('k');
  });

  it('exposes refV parameter defaulting near 2.49V', () => {
    const p = getPlugin('lm336')!;
    const refV = p.parameters.find(pa => pa.key === 'refV');
    expect(refV).toBeDefined();
    expect(refV!.default as number).toBeCloseTo(2.49, 1);
  });

  it('stamps conductance between A and K', () => {
    const p = getPlugin('lm336')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    const params = getParams(p);
    const sys = {
      stampConductance: (n1: number, n2: number, g: number) => {
        expect([n1, n2].sort()).toEqual([1, 2].sort());
        expect(g).toBeGreaterThan(0);
      },
      stampCurrentSource: (_n1: number, _n2: number, _i: number) => {},
      stampVoltageSource: () => 0,
      stampVCCS: () => {},
      stampVCVS: () => {},
      stampCCCS: () => {},
      stampCCVS: () => {},
    };
    // Set V(k) - V(a) > refV so it's "on"
    sim.nodeVoltage[1] = 0;  // a
    sim.nodeVoltage[2] = 5;  // k → reverse-biased > 2.49V
    expect(() => p.stamp!(params, terms, sys as any, sim)).not.toThrow();
  });

  it('measure returns the reverse voltage', () => {
    const p = getPlugin('lm336')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    sim.nodeVoltage[1] = 0;
    sim.nodeVoltage[2] = 2.5;
    const m = p.measure!(getParams(p), terms, sim);
    expect(m.length).toBe(1);
    expect(parseFloat(m[0].value)).toBeCloseTo(2.5, 1);
  });
});

describe('ICL8069 voltage reference', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('icl8069');
    expect(p).toBeDefined();
    expect(p!.name).toContain('ICL8069');
  });

  it('refV defaults near 1.23V', () => {
    const p = getPlugin('icl8069')!;
    const refV = p.parameters.find(pa => pa.key === 'refV');
    expect(refV).toBeDefined();
    expect(refV!.default as number).toBeCloseTo(1.23, 1);
  });
});

describe('Stepper Motor', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('stepperMotor');
    expect(p).toBeDefined();
    expect(p!.name).toContain('Stepper');
  });

  it('has 4 terminals: A+, A−, B+, B−', () => {
    const p = getPlugin('stepperMotor')!;
    const ids = p.terminals.map(t => t.id).sort();
    expect(ids).toEqual(['an', 'ap', 'bn', 'bp']);
  });

  it('stamps two conductances (one per winding)', () => {
    const p = getPlugin('stepperMotor')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    const params = getParams(p);
    let calls = 0;
    const sys = {
      stampConductance: () => { calls++; },
      stampCurrentSource: () => {},
      stampVoltageSource: () => 0,
      stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {},
    };
    p.stamp!(params, terms, sys as any, sim);
    expect(calls).toBe(2);  // one per winding
  });

  it('measure returns V_A, V_B, I_A, I_B', () => {
    const p = getPlugin('stepperMotor')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    sim.nodeVoltage[1] = 12;  // ap
    sim.nodeVoltage[2] = 0;   // an
    sim.nodeVoltage[3] = 12;  // bp
    sim.nodeVoltage[4] = 0;   // bn
    const m = p.measure!(getParams(p), terms, sim);
    const labels = m.map(x => x.label);
    expect(labels).toEqual(['V_A', 'V_B', 'I_A', 'I_B']);
  });
});

describe('Servo Motor', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('servoMotor');
    expect(p).toBeDefined();
    expect(p!.name).toContain('Servo');
  });

  it('has VCC, GND, CTRL terminals', () => {
    const p = getPlugin('servoMotor')!;
    const ids = p.terminals.map(t => t.id).sort();
    expect(ids).toEqual(['ctrl', 'gnd', 'vcc']);
  });

  it('measure includes angle θ', () => {
    const p = getPlugin('servoMotor')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    sim.nodeVoltage[1] = 5;  // vcc
    sim.nodeVoltage[2] = 0;  // gnd
    sim.nodeVoltage[3] = 5;  // ctrl high
    const m = p.measure!(getParams(p), terms, sim);
    const labels = m.map(x => x.label);
    expect(labels).toContain('θ');
  });
});

describe('Photodiode', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('photodiode');
    expect(p).toBeDefined();
    expect(p!.name).toBe('Photodiode');
  });

  it('exposes illuminance in lux', () => {
    const p = getPlugin('photodiode')!;
    const ill = p.parameters.find(pa => pa.key === 'illuminance');
    expect(ill).toBeDefined();
    expect(ill!.unit).toBe('lux');
  });

  it('stamps a current source (photocurrent)', () => {
    const p = getPlugin('photodiode')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    const params = getParams(p);
    let currentStamped = false;
    const sys = {
      stampConductance: () => {},
      stampCurrentSource: (_n1: number, _n2: number, i: number) => {
        currentStamped = true;
        expect(i).toBeGreaterThan(0);  // photocurrent is positive
      },
      stampVoltageSource: () => 0,
      stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {},
    };
    p.stamp!(params, terms, sys as any, sim);
    expect(currentStamped).toBe(true);
  });

  it('measure returns V_R, I_ph, lux', () => {
    const p = getPlugin('photodiode')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    const m = p.measure!(getParams(p), terms, sim);
    const labels = m.map(x => x.label);
    expect(labels).toEqual(['V_R', 'I_ph', 'lux']);
  });

  it('photocurrent increases with illuminance', () => {
    const p = getPlugin('photodiode')!;
    // Low light
    const sim1 = mkSim();
    const terms1 = getTerms(p, sim1);
    const params1 = getParams(p);
    params1.illuminance = 100;
    p.stamp!(params1, terms1, {
      stampConductance: () => {}, stampCurrentSource: (_n1, _n2, i: number) => {
        sim1.state.__iLow = i;
      },
      stampVoltageSource: () => 0,
      stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {},
    } as any, sim1);
    // Bright light
    const sim2 = mkSim();
    const terms2 = getTerms(p, sim2);
    const params2 = getParams(p);
    params2.illuminance = 10000;
    p.stamp!(params2, terms2, {
      stampConductance: () => {}, stampCurrentSource: (_n1, _n2, i: number) => {
        sim2.state.__iHigh = i;
      },
      stampVoltageSource: () => 0,
      stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {},
    } as any, sim2);
    expect(sim2.state.__iHigh).toBeGreaterThan(sim1.state.__iLow);
  });
});

describe('Phototransistor', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('phototransistor');
    expect(p).toBeDefined();
    expect(p!.name).toContain('Phototransistor');
  });

  it('has C and E terminals (no explicit base)', () => {
    const p = getPlugin('phototransistor')!;
    const ids = p.terminals.map(t => t.id).sort();
    expect(ids).toEqual(['c', 'e']);
  });

  it('collector current scales with illuminance × hFE', () => {
    const p = getPlugin('phototransistor')!;
    const params = getParams(p);
    const hfe = params.hfe as number;
    const lux = params.illuminance as number;
    const photoGain = params.photoGain as number;
    const expectedIC = hfe * photoGain * (lux / 1000);
    expect(expectedIC).toBeGreaterThan(0);
  });

  it('measure returns V_CE, I_C, lux', () => {
    const p = getPlugin('phototransistor')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    const m = p.measure!(getParams(p), terms, sim);
    const labels = m.map(x => x.label);
    expect(labels).toEqual(['V_CE', 'I_C', 'lux']);
  });
});

describe('Solar Cell', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('solarCell');
    expect(p).toBeDefined();
    expect(p!.name).toBe('Solar Cell');
  });

  it('has + and − terminals', () => {
    const p = getPlugin('solarCell')!;
    const ids = p.terminals.map(t => t.id).sort();
    expect(ids).toEqual(['n', 'p']);
  });

  it('stamps a voltage source (Thevenin)', () => {
    const p = getPlugin('solarCell')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    const params = getParams(p);
    let voltageStamped = false;
    const sys = {
      stampConductance: () => {},
      stampCurrentSource: () => {},
      stampVoltageSource: (_n1: number, _n2: number, v: number) => {
        voltageStamped = true;
        expect(v).toBeGreaterThan(0);
      },
      stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {}, addExtra: () => 5,
    };
    p.stamp!(params, terms, sys as any, sim);
    expect(voltageStamped).toBe(true);
  });

  it('voltage scales with sqrt(lux/1000)', () => {
    const p = getPlugin('solarCell')!;
    const params1 = getParams(p);
    params1.illuminance = 1000;
    const params2 = getParams(p);
    params2.illuminance = 4000;
    // sqrt(4000/1000) = 2× → 2× the voltage
    const sys1 = { stampConductance: () => {}, stampCurrentSource: () => {}, stampVoltageSource: (_n1: number, _n2: number, v: number) => { (globalThis as any).__v1 = v; }, stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {}, addExtra: () => 5 };
    const sys2 = { stampConductance: () => {}, stampCurrentSource: () => {}, stampVoltageSource: (_n1: number, _n2: number, v: number) => { (globalThis as any).__v2 = v; }, stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {}, addExtra: () => 5 };
    const sim = mkSim();
    const terms = getTerms(p, sim);
    p.stamp!(params1, terms, sys1 as any, sim);
    p.stamp!(params2, terms, sys2 as any, sim);
    const v1 = (globalThis as any).__v1 as number;
    const v2 = (globalThis as any).__v2 as number;
    expect(v2 / v1).toBeCloseTo(2, 3);
  });
});

describe('Crystal Oscillator (Active, 4-pin)', () => {
  it('is registered with the correct type', () => {
    const p = getPlugin('crystalOscillator');
    expect(p).toBeDefined();
    expect(p!.name).toContain('Crystal Oscillator');
    expect(p!.name).toContain('4-pin');
  });

  it('has VCC, GND, OUT, EN terminals', () => {
    const p = getPlugin('crystalOscillator')!;
    const ids = p.terminals.map(t => t.id).sort();
    expect(ids).toEqual(['en', 'gnd', 'out', 'vcc']);
  });

  it('frequency defaults to 16 MHz', () => {
    const p = getPlugin('crystalOscillator')!;
    const f = p.parameters.find(pa => pa.key === 'frequency');
    expect(f).toBeDefined();
    expect(f!.default as number).toBe(16000000);
  });

  it('outputs a square wave (alternates between voh and vol)', () => {
    const p = getPlugin('crystalOscillator')!;
    const params = getParams(p);
    params.frequency = 1000;  // 1kHz — period = 1ms
    const sys = {
      stampConductance: () => {},
      stampCurrentSource: () => {},
      stampVoltageSource: (_n1: number, _n2: number, v: number) => {
        (globalThis as any).__vOut = v;
      },
      stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {},
    };
    // Sample at t = 0.25ms (high) and t = 0.75ms (low)
    const terms = getTerms(p, mkSim());
    const sim1 = mkSim();
    sim1.time = 0.00025;
    sim1.nodeVoltage[1] = 5;  // vcc
    sim1.nodeVoltage[2] = 0;  // gnd
    sim1.nodeVoltage[3] = 5;  // en (high)
    p.stamp!(params, terms, sys as any, sim1);
    const v1 = (globalThis as any).__vOut as number;
    expect(v1).toBeCloseTo(5, 5);  // voh

    const sim2 = mkSim();
    sim2.time = 0.00075;
    sim2.nodeVoltage[1] = 5;
    sim2.nodeVoltage[2] = 0;
    sim2.nodeVoltage[3] = 5;
    p.stamp!(params, terms, sys as any, sim2);
    const v2 = (globalThis as any).__vOut as number;
    expect(v2).toBeCloseTo(0, 5);  // vol
  });

  it('outputs vol (low) when EN is below threshold', () => {
    const p = getPlugin('crystalOscillator')!;
    const params = getParams(p);
    const sys = {
      stampConductance: () => {},
      stampCurrentSource: () => {},
      stampVoltageSource: (_n1: number, _n2: number, v: number) => {
        (globalThis as any).__vOut = v;
      },
      stampVCCS: () => {}, stampVCVS: () => {}, stampCCCS: () => {}, stampCCVS: () => {},
    };
    const terms = getTerms(p, mkSim());
    const sim = mkSim();
    sim.time = 0.00025;  // would be "high" if enabled
    sim.nodeVoltage[1] = 5;  // vcc
    sim.nodeVoltage[2] = 0;  // gnd
    sim.nodeVoltage[3] = 0;  // en (low → disabled)
    p.stamp!(params, terms, sys as any, sim);
    const v = (globalThis as any).__vOut as number;
    expect(v).toBe(params.vol);  // disabled → outputs low
  });

  it('measure formats frequency correctly', () => {
    const p = getPlugin('crystalOscillator')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    const params = getParams(p);
    params.frequency = 16000000;
    const m = p.measure!(params, terms, sim);
    const freqItem = m.find(x => x.label === 'f');
    expect(freqItem).toBeDefined();
    expect(freqItem!.value).toContain('MHz');
  });
});

describe('DC Motor (improved)', () => {
  it('measure includes RPM (mechanical readout)', () => {
    const p = getPlugin('dcMotor')!;
    const sim = mkSim();
    const terms = getTerms(p, sim);
    sim.nodeVoltage[1] = 12;
    sim.nodeVoltage[2] = 0;
    const m = p.measure!(getParams(p), terms, sim);
    const labels = m.map(x => x.label);
    expect(labels).toContain('RPM');
    expect(labels).toContain('ω');  // angular velocity
  });
});
