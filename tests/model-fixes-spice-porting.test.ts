// Component-model bugs found while porting real-board SPICE decks:
//   1. behavioral-source expression evaluator (SPICE suffixes, && / ||, functions)
//   2. diodeShockley: internal Rs node bias in AC + integration-method charge
//   3. vcSwitch: SPICE hysteresis (VT±VH with memory)
//   4. coupledInductor: selected integration method
//   5. BJT models: full Gummel-Poon core (bjtGP*) + junction caps/TF on simple parts
// Reference numbers marked "ngspice" were produced by ngspice 47 and are stored
// so the suite runs without it; when ngspice is installed the decks are re-run.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import '../src/lib/circuit/components';
import { evalExpression } from '../src/lib/circuit/components/advanced-devices';
import { simpleBjtModel } from '../src/lib/circuit/components/semiconductors';
import { simulateStep, solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { runAnalysis } from '../src/lib/circuit/analysis';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { depletion } from '../src/lib/circuit/spice-devices';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

const hasNgspice = (() => {
  try { execFileSync('ngspice', ['-v'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

function ngspice(deck: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ngspice-port-'));
  try {
    const f = join(dir, 'd.cir');
    writeFileSync(f, deck);
    return execFileSync('ngspice', ['-b', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const ngVal = (out: string, name: string): number => {
  const m = new RegExp(`^${name}\\s*=\\s*([-+0-9.eE]+)`, 'm').exec(out);
  if (!m) throw new Error(`ngspice did not print ${name}`);
  return +m[1];
};

function comp(type: string, id: string, p: Record<string, unknown> = {}): CircuitComponent {
  const pl = getPlugin(type)!;
  const d: Record<string, unknown> = {};
  for (const pm of pl.parameters) d[pm.key] = pm.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...p } as any, simState: {} };
}
const w = (id: string, f: string, ft: string, t: string, tt: string): Wire =>
  ({ id, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } });
const plugins = () => new Map(getAllPlugins().map((p) => [p.type, p]));
const acMag = (r: any) => Math.hypot(r.traces[0].yValues[0], r.traces[0].yValues[1]);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Expression evaluator
// ─────────────────────────────────────────────────────────────────────────────
const ev = (expr: string, time = 0, v: Record<string, number> = {}): number => {
  const names = new Map(Object.keys(v).map((k, i) => [k, i + 1] as [string, number]));
  const nv = new Float64Array(names.size + 1);
  for (const [k, id] of names) nv[id] = v[k];
  return evalExpression(expr, nv, names, time);
};

describe('behavioral expression evaluator', () => {
  it('honors SPICE magnitude suffixes (case-insensitive)', () => {
    expect(ev('30m')).toBeCloseTo(0.03, 15);
    expect(ev('1k')).toBe(1000);
    expect(ev('2.2K')).toBeCloseTo(2200, 9);
    expect(ev('1meg')).toBe(1e6);
    expect(ev('1MEG')).toBe(1e6);
    expect(ev('3g')).toBe(3e9);
    expect(ev('2t')).toBe(2e12);
    expect(ev('4.7u')).toBeCloseTo(4.7e-6, 18);
    expect(ev('4.7µ')).toBeCloseTo(4.7e-6, 18);
    expect(ev('10n')).toBeCloseTo(1e-8, 20);
    expect(ev('5p')).toBeCloseTo(5e-12, 24);
    expect(ev('7f')).toBeCloseTo(7e-15, 27);
    expect(ev('1mil')).toBeCloseTo(25.4e-6, 12);
    expect(ev('1e-5')).toBe(1e-5);
    expect(ev('1.5e3k')).toBeCloseTo(1.5e6, 3);
    expect(ev('5V')).toBe(5); // trailing unit letters carry no scale
    expect(ev('10mV*2')).toBeCloseTo(0.02, 12);
    expect(ev('3m+2m')).toBeCloseTo(0.005, 15);
  });

  it('implements C/ngspice precedence: ^ (left-assoc, ngspice), unary, * /, + -, comparisons, ==/!=, &&, ||, ?:', () => {
    expect(ev('2+3*4')).toBe(14);
    expect(ev('2^3^2')).toBe(64);         // left-associative, as ngspice 47
    expect(ev('2**3')).toBe(8);
    expect(ev('2^-1')).toBe(0.5);
    expect(ev('-2^2')).toBe(-4);          // ^ binds tighter than unary minus (C/ngspice)
    expect(ev('10-4-3')).toBe(3);
    expect(ev('100/10/5')).toBe(2);
    expect(ev('1+2<4')).toBe(1);          // arithmetic before comparison
    expect(ev('1<2==1')).toBe(1);         // comparison before equality
    expect(ev('1==1&&2==3')).toBe(0);
    expect(ev('1||0&&0')).toBe(1);        // && before ||
    expect(ev('0&&0||1')).toBe(1);
    expect(ev('!0')).toBe(1);
    expect(ev('!(1>2)')).toBe(1);
    expect(ev('1!=2')).toBe(1);
    expect(ev('1>2?10:20')).toBe(20);
    expect(ev('1<2?10:1>2?20:30')).toBe(10);
    expect(ev('0?1:0?2:3')).toBe(3);      // ?: right-associative
    expect(ev('1+(0?5:7)*2')).toBe(15);
  });

  it('&&/|| window on time (was returning 1 at t=1e-7)', () => {
    const e = 'if(time>1e-5 && time<5e-5,1,0)';
    expect(ev(e, 1e-7)).toBe(0);
    expect(ev(e, 2e-5)).toBe(1);
    expect(ev(e, 6e-5)).toBe(0);
    expect(ev('if(time<1u || time>9u,5,0)', 5e-6)).toBe(0);
    expect(ev('if(time<1u || time>9u,5,0)', 9.5e-6)).toBe(5);
    expect(ev('(time>1e-5 && time<5e-5) ? 3 : -3', 2e-5)).toBe(3);
  });

  it('provides the common ngspice functions', () => {
    expect(ev('u(2)')).toBe(1);
    expect(ev('u(-2)')).toBe(0);
    expect(ev('uramp(3)')).toBe(3);
    expect(ev('uramp(-3)')).toBe(0);
    expect(ev('abs(-4)')).toBe(4);
    expect(ev('sqrt(16)')).toBe(4);
    expect(ev('exp(0)')).toBe(1);
    expect(ev('ln(exp(2))')).toBeCloseTo(2, 12);
    expect(ev('log(exp(3))')).toBeCloseTo(3, 12);     // ngspice log = natural
    expect(ev('log10(1000)')).toBeCloseTo(3, 12);
    expect(ev('sin(pi/2)')).toBeCloseTo(1, 12);
    expect(ev('cos(0)')).toBe(1);
    expect(ev('tan(pi/4)')).toBeCloseTo(1, 12);
    expect(ev('atan(1)')).toBeCloseTo(Math.PI / 4, 12);
    expect(ev('sinh(1)')).toBeCloseTo(Math.sinh(1), 12);
    expect(ev('cosh(1)')).toBeCloseTo(Math.cosh(1), 12);
    expect(ev('tanh(0.5)')).toBeCloseTo(Math.tanh(0.5), 12);
    expect(ev('pow(2,10)')).toBe(1024);
    expect(ev('pwr(-2,2)')).toBe(-4);                 // sign-preserving
    expect(ev('pwr(3,2)')).toBe(9);
    expect(ev('min(3,-1)')).toBe(-1);
    expect(ev('max(3,-1)')).toBe(3);
    expect(ev('limit(7,-1,5)')).toBe(5);
    expect(ev('limit(-7,-1,5)')).toBe(-1);
    expect(ev('limit(2,-1,5)')).toBe(2);
    expect(ev('sgn(-9)')).toBe(-1);
    expect(ev('sgn(0)')).toBe(0);
    expect(ev('sign(9)')).toBe(1);
    expect(ev('floor(2.7)')).toBe(2);
    expect(ev('ceil(2.1)')).toBe(3);
    expect(ev('ABS(-2)+Sqrt(4)')).toBe(4);            // case-insensitive names
  });

  it('resolves V()/I() with nested expressions and node names that contain functions-looking letters', () => {
    expect(ev('V(in)*2', 0, { in: 1.5 })).toBe(3);
    expect(ev('v(in,ref)', 0, { in: 5, ref: 2 })).toBe(3);
    expect(ev('V(a)>1 && V(b)<1 ? 10 : 20', 0, { a: 2, b: 0.5 })).toBe(10);
    expect(ev('limit(V(vin)*10, -5, 5)', 0, { vin: 1 })).toBe(5);
    expect(ev('V(pin)+V(time1)', 0, { pin: 1, time1: 2 })).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. diodeShockley
// ─────────────────────────────────────────────────────────────────────────────
describe('diodeShockley', () => {
  it('AC small-signal linearization uses the DC bias of the internal Rs node', () => {
    // V1(offset 5) -R- D(Rs=10 Ω) -G : gain at the anode = (rd+Rs)/(R+rd+Rs)
    const Rs = 10, R = 1000;
    const c = [comp('acVoltage', 'V1', { amplitude: 1, offset: 5, frequency: 1000 }), comp('resistor', 'R1', { resistance: R }),
      comp('diodeShockley', 'D1', { Rs, Cjo: 0, Tt: 0, Bv: 1000 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'D1', 'a'), w('3', 'D1', 'k', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g')];
    const dc = solveDC(c, ws, plugins())!;
    const id = Math.abs(dc.terminalCurrents!.get('D1:a')!);
    expect(id).toBeGreaterThan(3e-3);
    const vt = 1.380649e-23 * 300.15 / 1.602176634e-19;
    const rd = vt / id;
    const expected = (rd + Rs) / (R + rd + Rs);
    const r = runAnalysis(c, ws, plugins(), { type: 'ac', sweep: 'dec', nPoints: 1, fStart: 1000, fStop: 1000, sourceId: 'V1', outputNode: 'D1:a' } as any);
    // before the fix the internal node read 0 V → the diode looked open → gain ≈ 1
    expect(acMag(r)).toBeGreaterThan(0.005);
    expect(acMag(r)).toBeLessThan(0.02);
    expect(acMag(r) / expected).toBeGreaterThan(0.97);
    expect(acMag(r) / expected).toBeLessThan(1.03);
  });

  it('junction charge companion follows the selected integration method (Euler / trap / Gear)', () => {
    // Reverse-biased junction with constant C (M = 0) charged through R by a RAMP
    // a·t (a = 5 V/τ), h = τ/5, observed at t = 2τ:
    //   v(t) = a·(t − τ(1 − e^(−t/τ)))  →  5·(1 + e⁻²) = 5.6767 V
    // (a ramp rather than a step: the trapezoidal rule mis-integrates a
    // discontinuity at t0, which would mask the order of the method.)
    const exact = 5 * (1 + Math.exp(-2));
    const run = (method: 'euler' | 'trap' | 'gear', Rs: number): number => {
      const C = 1e-9, R = 1000, tau = R * C, h = tau / 5;
      const src = comp('dcVoltage', 'V1', { voltage: 0 });
      const c = [src, comp('resistor', 'R1', { resistance: R }),
        comp('diodeShockley', 'D1', { Is: 1e-14, Rs, Cjo: C, M: 0, Vj: 0.7, Tt: 0, Bv: 1000 }), comp('ground', 'G')];
      const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'D1', 'k'), w('3', 'D1', 'a', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g')];
      const nk = buildNodeMap(c, ws, plugins()).terminalNode.get('D1:k')!;
      let prev: any; let s: any;
      const step = () => {
        s = simulateStep(c, ws, plugins(), prev, h, { method })!.sim;
        prev = { nodeVoltage: s.nodeVoltage, branchCurrent: s.branchCurrent, time: s.time, state: s.state };
      };
      for (let i = 0; i < 4; i++) step();
      for (let k = 1; k <= 10; k++) { src.parameters.voltage = (5 / tau) * (k * h); step(); }
      return (s.nodeVoltage as Float64Array)[nk];
    };
    for (const Rs of [0, 0.001]) {
      const be = run('euler', Rs), tr = run('trap', Rs), ge = run('gear', Rs);
      expect(Math.abs(be - exact)).toBeGreaterThan(0.1);        // backward Euler: first-order error
      expect(Math.abs(tr - exact)).toBeLessThan(0.03);
      expect(Math.abs(ge - exact)).toBeLessThan(0.06);
      expect(Math.abs(tr - exact)).toBeLessThan(0.25 * Math.abs(be - exact));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. vcSwitch hysteresis
// ─────────────────────────────────────────────────────────────────────────────
describe('vcSwitch SPICE hysteresis', () => {
  // ngspice 47: S1 a b cp 0 (vt=1 vh=0.5 ron=0.01 roff=1e6), 5 V / 1 kΩ load;
  // control: 0 → 1.2 → 2 → 1.2 → 0.3 V  ⇒  V(b) = 4.995 mV, 4.995 mV, 4.99995 V, 4.99995 V, 4.995 mV
  const NG = [4.995e-3, 4.995e-3, 4.99995, 4.99995, 4.995e-3];
  const ctrl = [0, 1.2, 2, 1.2, 0.3];

  it('switches at VT±VH and remembers its state inside the band', () => {
    const cs = comp('dcVoltage', 'VC', { voltage: 0 });
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), cs, comp('vcSwitch', 'S1', { vt: 1, vh: 0.5, ron: 0.01, roff: 1e6 }),
      comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'S1', 'a'), w('2', 'S1', 'b', 'R1', 'a'), w('3', 'R1', 'b', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g'),
      w('5', 'VC', 'p', 'S1', 'cp'), w('6', 'VC', 'n', 'G', 'g'), w('7', 'S1', 'cn', 'G', 'g')];
    const nLoad = buildNodeMap(c, ws, plugins()).terminalNode.get('R1:a')!;
    let prev: any; let s: any;
    const vOut: number[] = [];
    for (const v of ctrl) {
      cs.parameters.voltage = v;
      for (let i = 0; i < 4; i++) {
        s = simulateStep(c, ws, plugins(), prev, 1e-5)!.sim;
        prev = { nodeVoltage: s.nodeVoltage, branchCurrent: s.branchCurrent, time: s.time, state: s.state };
      }
      vOut.push((s.nodeVoltage as Float64Array)[nLoad]);
    }
    vOut.forEach((x, i) => expect(x / NG[i], `ctrl=${ctrl[i]}`).toBeGreaterThan(0.99));
    vOut.forEach((x, i) => expect(x / NG[i], `ctrl=${ctrl[i]}`).toBeLessThan(1.01));
  });

  it.skipIf(!hasNgspice)('matches an ngspice .tran of the same switch', () => {
    const out = ngspice(`sw
V1 a 0 5
R1 b 0 1k
S1 a b cp 0 smod
Vc cp 0 PWL(0 0 1m 0 1.001m 1.2 2m 1.2 2.001m 2 3m 2 3.001m 1.2 4m 1.2 4.001m 0.3 5m 0.3)
.model smod sw vt=1 vh=0.5 ron=0.01 roff=1e6
.tran 0.1m 5m
.control
run
meas tran v1 find v(b) at=0.9m
meas tran v2 find v(b) at=1.9m
meas tran v3 find v(b) at=2.9m
meas tran v4 find v(b) at=3.9m
meas tran v5 find v(b) at=4.9m
.endc
.end
`);
    [1, 2, 3, 4, 5].forEach((k) => expect(ngVal(out, `v${k}`) / NG[k - 1]).toBeCloseTo(1, 2));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. coupledInductor integration method
// ─────────────────────────────────────────────────────────────────────────────
describe('coupledInductor integration method', () => {
  function i1At(method: 'euler' | 'trap' | 'gear') {
    // Ramp a·t (a = 5 V/τ) through RS = 1 kΩ into winding 1 (L1 = 1 mH → τ = L/R = 1 µs);
    // winding 2 open (1 MΩ load); h = τ/5, observed at t = 2τ.
    const tau = 1e-6, h = tau / 5;
    const src = comp('dcVoltage', 'V1', { voltage: 0 });
    const c = [src, comp('resistor', 'RS', { resistance: 1000 }), comp('coupledInductor', 'T1', { L1: 1e-3, L2: 1e-3, k: 0.5 }),
      comp('resistor', 'RL', { resistance: 1e6 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'RS', 'a'), w('2', 'RS', 'b', 'T1', 'p1'), w('3', 'T1', 'p2', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g'),
      w('5', 'T1', 's1', 'RL', 'a'), w('6', 'T1', 's2', 'G', 'g'), w('7', 'RL', 'b', 'G', 'g')];
    let prev: any; let s: any;
    const step = () => {
      s = simulateStep(c, ws, plugins(), prev, h, { method })!.sim;
      prev = { nodeVoltage: s.nodeVoltage, branchCurrent: s.branchCurrent, time: s.time, state: s.state };
    };
    for (let i = 0; i < 4; i++) step();
    for (let k = 1; k <= 10; k++) { src.parameters.voltage = (5 / tau) * (k * h); step(); }
    const key = Object.keys(s.state.__global).find((k) => k.startsWith('xfmr_') && !k.endsWith('_i2'))!;
    return { i1: s.state.__global[key] as number };
  }

  it('winding current at t = 2τ: Euler is first-order, trap / Gear are second-order', () => {
    // L·di/dt = a·t − R·i  →  i(t) = (a/R)(t − τ(1 − e^(−t/τ))) = 5 mA·(1 + e⁻²) = 5.677 mA
    const exact = 5e-3 * (1 + Math.exp(-2));
    const be = i1At('euler').i1, tr = i1At('trap').i1, ge = i1At('gear').i1;
    expect(Math.abs(be - exact)).toBeGreaterThan(1e-4);
    expect(Math.abs(tr - exact)).toBeLessThan(3e-5);
    expect(Math.abs(ge - exact)).toBeLessThan(6e-5);
    expect(Math.abs(tr - exact)).toBeLessThan(0.25 * Math.abs(be - exact));
  });

  it('measure()/engine current display still read the winding currents', () => {
    const r = i1At('trap');
    expect(r.i1).toBeGreaterThan(5e-3);
  });

  it('transformer AC response is unchanged by delegating to the shared core', () => {
    const L1 = 4e-3, L2 = 1e-3, k = 0.999;
    const c = [comp('acVoltage', 'V1', { amplitude: 1 }), comp('resistor', 'RS', { resistance: 1 }), comp('coupledInductor', 'T1', { L1, L2, k }),
      comp('resistor', 'RL', { resistance: 1000 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'RS', 'a'), w('2', 'RS', 'b', 'T1', 'p1'), w('3', 'T1', 'p2', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g'),
      w('5', 'T1', 's1', 'RL', 'a'), w('6', 'T1', 's2', 'G', 'g'), w('7', 'RL', 'b', 'G', 'g')];
    const r = runAnalysis(c, ws, plugins(), { type: 'ac', sweep: 'dec', nPoints: 1, fStart: 1000, fStop: 1000, sourceId: 'V1', outputNode: 'T1:s1' } as any);
    const om = 2 * Math.PI * 1000, M = k * Math.sqrt(L1 * L2);
    const re = 1000 - om * L1 * om * L2 + om * om * M * M, im = om * L2 + om * L1 * 1000;
    expect(acMag(r)).toBeCloseTo((om * M * 1000) / Math.hypot(re, im), 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. BJT models
// ─────────────────────────────────────────────────────────────────────────────
describe('Gummel-Poon BJT parts', () => {
  function bjtBench(type: string, qp: Record<string, unknown>) {
    const c = [comp('acVoltage', 'V1', { amplitude: 1, offset: 0.75 }), comp('resistor', 'R1', { resistance: 1000 }),
      comp(type, 'Q1', qp), comp('dcVoltage', 'VC', { voltage: 5 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'Q1', 'b'), w('3', 'Q1', 'e', 'G', 'g'), w('4', 'V1', 'n', 'G', 'g'),
      w('5', 'VC', 'p', 'Q1', 'c'), w('6', 'VC', 'n', 'G', 'g')];
    return { c, ws };
  }
  const acB = (c: CircuitComponent[], ws: Wire[], f: number) =>
    acMag(runAnalysis(c, ws, plugins(), { type: 'ac', sweep: 'dec', nPoints: 1, fStart: f, fStop: f, sourceId: 'V1', outputNode: 'Q1:b' } as any));

  const GP = { Is: 1e-15, Bf: 100, Br: 1, Vaf: 100, Var: 50, Ikf: 1 };

  it('TF / CJE / CJC load the base node at 100 MHz exactly like ngspice (|V(b)| = 0.04704)', () => {
    const NG_MAG = 0.0470376; // ngspice 47 .ac at 100 MHz, same deck (no caps: 0.5780073)
    const base = bjtBench('bjtGPNpn', { ...GP });
    const full = bjtBench('bjtGPNpn', { ...GP, Cje: 2e-12, Cjc: 1e-12, Tf: 0.4e-9 });
    const m0 = acB(base.c, base.ws, 100e6);
    const m1 = acB(full.c, full.ws, 100e6);
    expect(m0 / 0.5780073).toBeGreaterThan(0.995); // no capacitance: rπ/(R+rπ), ngspice 0.5780073
    expect(m0 / 0.5780073).toBeLessThan(1.005);
    expect(m1 / NG_MAG).toBeGreaterThan(0.97);
    expect(m1 / NG_MAG).toBeLessThan(1.03);
    if (hasNgspice) {
      const out = ngspice(`bjt ac
V1 in 0 dc 0.75 ac 1
R1 in b 1k
Q1 c b 0 qm
Vc c 0 5
.model qm npn(is=1e-15 bf=100 br=1 vaf=100 var=50 ikf=1 cje=2p vje=0.75 mje=0.33 cjc=1p vjc=0.75 mjc=0.33 tf=0.4n)
.ac lin 1 100meg 100meg
.control
run
let m=mag(v(b))
print m
.endc
.end
`);
      expect(ngVal(out, 'm')).toBeCloseTo(NG_MAG, 4);
    }
  });

  it('RB / RC / RE and leakage ISE give the ngspice operating point', () => {
    // ngspice 47: V(b)=1.405331  V(c)=4.382933  V(e)=0.6265338
    const c = [comp('dcVoltage', 'V1', { voltage: 1.5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('dcVoltage', 'VC', { voltage: 5 }),
      comp('resistor', 'R2', { resistance: 100 }), comp('bjtGPNpn', 'Q1', { ...GP, Rb: 50, Rc: 5, Re: 2, Ise: 1e-13, Ne: 1.5 }),
      comp('resistor', 'R3', { resistance: 100 }), comp('ground', 'G')];
    const ws = [w('1', 'V1', 'p', 'R1', 'a'), w('2', 'R1', 'b', 'Q1', 'b'), w('3', 'V1', 'n', 'G', 'g'), w('4', 'VC', 'p', 'R2', 'a'),
      w('5', 'VC', 'n', 'G', 'g'), w('6', 'R2', 'b', 'Q1', 'c'), w('7', 'Q1', 'e', 'R3', 'a'), w('8', 'R3', 'b', 'G', 'g')];
    const dc = solveDC(c, ws, plugins())!;
    const tn = buildNodeMap(c, ws, plugins()).terminalNode;
    const V = (k: string) => dc.nodeVoltage[tn.get(k)!];
    expect(V('Q1:b')).toBeCloseTo(1.405331, 2);
    expect(V('Q1:c')).toBeCloseTo(4.382933, 2);
    expect(V('Q1:e')).toBeCloseTo(0.6265338, 2);
    expect(Math.abs(V('Q1:c') - 4.382933)).toBeLessThan(5e-3);
    expect(Math.abs(V('Q1:e') - 0.6265338)).toBeLessThan(5e-3);
    if (hasNgspice) {
      const out = ngspice(`bjt dc rb rc re
V1 in 0 dc 1.5
R1 in b 1k
Vc cc 0 5
R2 cc c 100
Q1 c b e qm
R3 e 0 100
.model qm npn(is=1e-15 bf=100 br=1 vaf=100 var=50 ikf=1 rb=50 rc=5 re=2 ise=1e-13 ne=1.5)
.op
.control
run
print v(b) v(c) v(e)
.endc
.end
`);
      expect(ngVal(out, 'v\\(e\\)')).toBeCloseTo(0.6265338, 4);
    }
  });

  it('simple npn/pnp: part presets add vendor CJE/CJC/TF/TR; DC results unchanged', () => {
    const m = simpleBjtModel(150, 0.65, '2N3904');
    expect(m.Tf).toBeCloseTo(301.2e-12, 22);
    expect(m.Tr).toBeCloseTo(239.5e-9, 15);
    expect(m.Cje).toBeCloseTo(4.493e-12, 22);
    expect(m.Mje).toBeCloseTo(0.2593, 6);
    expect(m.Cjc).toBeCloseTo(3.638e-12, 22);
    expect(m.Mjc).toBeCloseTo(0.3085, 6);
    expect(simpleBjtModel(150, 0.65, 'PN2222A').Tf).toBeCloseTo(411.1e-12, 22);
    const bc = simpleBjtModel(290, 0.62, 'BC547B');
    expect(bc.Vje).toBeCloseTo(0.65, 6);
    expect(bc.Vjc).toBeCloseTo(0.3997, 6);
    expect(bc.Tr).toBeCloseTo(1e-9, 15);
    expect(simpleBjtModel(150, 0.65).Tf).toBeUndefined();        // unknown / no part: unchanged model
    expect(simpleBjtModel(400, 0.65, 'BC337-40').Cje).toBeUndefined();
  });

  it('2N3904 diffusion capacitance (TF·gm ≈ 58 pF at 5 mA) rolls off the base at tens of MHz; DC identical', () => {
    // 5 V -R- collector ; base driven from a 0.75 V offset through 1 kΩ… Ic ≈ 2–5 mA
    const mk = (part: string, hfe: number, vbe: number) => bjtBench('npn', { part, hfe, vbe });
    const withDyn = mk('2N3904', 150, 0.65);
    // same hFE / VBE but a part with no dynamic data (BC337-40 preset name, values overridden)
    const noDyn = mk('BC337-40', 150, 0.65);
    const dc1 = solveDC(withDyn.c, withDyn.ws, plugins())!;
    const dc2 = solveDC(noDyn.c, noDyn.ws, plugins())!;
    expect(dc1.nodeVoltage.length).toBe(dc2.nodeVoltage.length);
    for (let i = 0; i < dc1.nodeVoltage.length; i++) expect(dc1.nodeVoltage[i]).toBeCloseTo(dc2.nodeVoltage[i], 9);
    const f = 50e6;
    const a1 = acB(withDyn.c, withDyn.ws, f);
    const a0 = acB(noDyn.c, noDyn.ws, f);
    expect(a1).toBeLessThan(0.4 * a0);
  });

  it('depletion helper sanity (used for the BJT junction charge)', () => {
    const [q, c] = depletion(0.3, 1e-12, 0.75, 0.33, 0.5);
    expect(c).toBeGreaterThan(1e-12);
    expect(q).toBeGreaterThan(0);
  });
});
