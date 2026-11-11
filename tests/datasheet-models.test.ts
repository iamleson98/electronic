// Datasheet-accuracy checks for real-part models:
//   LM317 (ADJ regulation), LM311/LM393 output polarity, NE555 supply-referenced
//   thresholds + output stage, LED Vf by colour, discrete-part presets.
import { describe, it, expect } from 'vitest';
import { simulateStep, buildNodeMap, solveDC } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, SimContext } from '../src/lib/circuit/types';
import { partPreset, mosfetRdsPoint } from '../src/lib/circuit/discrete-presets';
import { DISCRETE_PARTS } from '../src/lib/circuit/part-presets';
import '../src/lib/circuit/components';

function comp(type: string, id: string, p: Record<string, unknown> = {}): CircuitComponent {
  const pl = getPlugin(type);
  const d: Record<string, unknown> = {};
  if (pl) for (const pm of pl.parameters) d[pm.key] = pm.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...p } as any, simState: {} };
}
let wn = 0;
const w = (f: string, ft: string, t: string, tt: string): Wire =>
  ({ id: `w${wn++}`, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } });
const plugins = () => new Map(getAllPlugins().map((p) => [p.type, p]));
const V = (c: CircuitComponent[], ws: Wire[], s: SimContext, key: string) =>
  s.nodeVoltage[buildNodeMap(c, ws, plugins()).terminalNode.get(key)!];

describe('LM317: V(out) − V(adj) = 1.25 V, Iadj = 50 µA, dropout 1.7 V', () => {
  function reg(vin: number, r2: number) {
    const c = [comp('dcVoltage', 'VI', { voltage: vin }), comp('lm317', 'U1'), comp('resistor', 'R1', { resistance: 240 }),
      comp('resistor', 'R2', { resistance: r2 }), comp('ground', 'G')];
    const ws = [w('VI', 'p', 'U1', 'in'), w('VI', 'n', 'G', 'g'), w('U1', 'out', 'R1', 'a'), w('R1', 'b', 'U1', 'adj'),
      w('U1', 'adj', 'R2', 'a'), w('R2', 'b', 'G', 'g')];
    const s = solveDC(c, ws, plugins())!;
    return V(c, ws, s, 'U1:out');
  }
  it('R2 = 720 Ω, Vin 12 V → 5.0 V (±1 %)', () => { const v = reg(12, 720); expect(v).toBeGreaterThan(4.95); expect(v).toBeLessThan(5.05); });
  it('R2 = 2400 Ω, Vin 18 V → 13.87 V', () => expect(reg(18, 2400)).toBeCloseTo(13.87, 0));
  it('Vin 6 V with R2 = 2400 → dropout-limited ≈ Vin − 1.7', () => {
    const v = reg(6, 2400);
    expect(v).toBeGreaterThan(4.1); expect(v).toBeLessThan(4.4);
  });
});

describe('open-collector comparators: OUT low when V(−) > V(+)', () => {
  function cmp(type: string, vp: number, vm: number) {
    const c = [comp('dcVoltage', 'VCC', { voltage: 5 }), comp('dcVoltage', 'VP', { voltage: vp }), comp('dcVoltage', 'VM', { voltage: vm }),
      comp(type, 'U1'), comp('resistor', 'RP', { resistance: 10000 }), comp('ground', 'G')];
    const ws = [w('VCC', 'p', 'U1', 'vcc'), w('VCC', 'n', 'G', 'g'), w('VP', 'p', 'U1', 'inp'), w('VP', 'n', 'G', 'g'),
      w('VM', 'p', 'U1', 'inn'), w('VM', 'n', 'G', 'g'), w('U1', 'gnd', 'G', 'g'), w('VCC', 'p', 'RP', 'a'), w('RP', 'b', 'U1', 'out')];
    if (type === 'lm311') ws.push(w('VCC', 'p', 'U1', 'strobe'));
    const s = solveDC(c, ws, plugins())!;
    return V(c, ws, s, 'U1:out');
  }
  for (const t of ['lm393', 'lm311']) {
    it(`${t}: V+=3, V−=1 → released (≈5 V)`, () => expect(cmp(t, 3, 1)).toBeGreaterThan(4.9));
    it(`${t}: V+=1, V−=3 → pulled low (<0.4 V)`, () => expect(cmp(t, 1, 3)).toBeLessThan(0.4));
  }
});

describe('NE555 uses the wired supply', () => {
  function run(vcc: number, vtrig: number, vthr: number, prevFf = false, load = 0) {
    const c = [comp('dcVoltage', 'VCC', { voltage: vcc }), comp('timer555', 'U1', { vcc: 5 }),
      comp('dcVoltage', 'VT', { voltage: vtrig }), comp('dcVoltage', 'VH', { voltage: vthr }), comp('ground', 'G')];
    const ws = [w('VCC', 'p', 'U1', 'vcc'), w('VCC', 'p', 'U1', 'rst'), w('VCC', 'n', 'G', 'g'), w('U1', 'gnd', 'G', 'g'),
      w('VT', 'p', 'U1', 'trig'), w('VT', 'n', 'G', 'g'), w('VH', 'p', 'U1', 'thr'), w('VH', 'n', 'G', 'g')];
    if (load) { c.push(comp('resistor', 'RL', { resistance: load })); ws.push(w('U1', 'out', 'RL', 'a'), w('RL', 'b', 'G', 'g')); }
    let prev: any = prevFf ? { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: { t555_U1: { ff: true, outHigh: true } } } : undefined;
    let s: SimContext | null = null;
    for (let i = 0; i < 4; i++) {
      const r = simulateStep(c, ws, plugins(), prev, 1e-4)!;
      s = r.sim;
      prev = { nodeVoltage: s.nodeVoltage, branchCurrent: s.branchCurrent, time: s.time, state: s.state };
    }
    const dc = solveDC(c, ws, plugins());
    return { vout: V(c, ws, s!, 'U1:out'), icc: Math.abs(dc?.terminalCurrents?.get('VCC:p') ?? 0) };
  }
  it('12 V supply, TRIG = 0 → OUT ≈ Vcc − 1 V = 11 V unloaded', () => {
    const { vout } = run(12, 0, 0);
    expect(vout).toBeGreaterThan(10.8); expect(vout).toBeLessThan(11.1);
  });
  it('output sags 7 Ω/mA-slope under load (15 V, 100 mA ≈ 13.3 V)', () => {
    const { vout } = run(15, 0, 0, false, 133);
    expect(vout).toBeGreaterThan(12.9); expect(vout).toBeLessThan(13.6);
  });
  it('threshold = 2/3 of the wired supply: THR = 7 V resets at 9 V supply, not at 12 V', () => {
    expect(run(12, 12, 7, true).vout).toBeGreaterThan(10);   // 7 V < 8 V → stays high
    expect(run(9, 9, 7, true).vout).toBeLessThan(0.5);        // 7 V > 6 V → reset
  });
  it('quiescent supply current ≈ Vcc / 1.5 kΩ', () => {
    const { icc } = run(15, 12, 0, false);
    expect(icc).toBeGreaterThan(0.008); expect(icc).toBeLessThan(0.012);
  });
});

describe('LED forward voltage follows colour', () => {
  function led(color: string, extra: Record<string, unknown> = {}) {
    const c = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 150 }), comp('led', 'D1', { color, ...extra }), comp('ground', 'G')];
    const ws = [w('V1', 'p', 'R1', 'a'), w('R1', 'b', 'D1', 'a'), w('D1', 'k', 'G', 'g'), w('V1', 'n', 'G', 'g')];
    const s = solveDC(c, ws, plugins())!;
    return V(c, ws, s, 'D1:a');
  }
  it('red ≈ 2.0 V, green ≈ 2.2 V, blue ≈ 3.2 V, IR ≈ 1.3 V at ~20 mA', () => {
    expect(led('red')).toBeGreaterThan(1.9); expect(led('red')).toBeLessThan(2.15);
    expect(led('green')).toBeGreaterThan(2.1); expect(led('green')).toBeLessThan(2.35);
    expect(led('blue')).toBeGreaterThan(3.05); expect(led('blue')).toBeLessThan(3.3);
    expect(led('ir')).toBeGreaterThan(1.2); expect(led('ir')).toBeLessThan(1.45);
  });
  it('legacy saved blue LED with forwardV = 2.0 gets the real 3.2 V; an explicit value still wins', () => {
    expect(led('blue', { forwardV: 2.0 })).toBeGreaterThan(3.0);
    expect(led('blue', { forwardV: 2.5 })).toBeLessThan(2.8);
  });
});

describe('discrete part presets', () => {
  it('every listed transistor has a preset', () => {
    for (const t of ['npn', 'pnp', 'nmos', 'pmos'] as const)
      for (const d of DISCRETE_PARTS[t]) expect(partPreset(t, d.part), `${t} ${d.part}`).toBeDefined();
  });
  it('BJT presets: BC547B hFE 290 / Vbe 0.62; TIP32C veb', () => {
    expect(partPreset('npn', 'BC547B')).toEqual({ hfe: 290, vbe: 0.62 });
    expect(partPreset('pnp', 'TIP32C')).toEqual({ hfe: 50, veb: 0.55 });
  });
  const mos: [('nmos' | 'pmos'), string][] = [
    ['nmos', '2N7000'], ['nmos', 'BS170'], ['nmos', 'BSS138'], ['nmos', 'AO3400A'], ['nmos', 'IRF540N'], ['nmos', 'IRLZ44N'],
    ['pmos', 'BSS84'], ['pmos', 'AO3401A'], ['pmos', 'IRF9540N']];
  for (const [type, part] of mos) {
    it(`${part}: Rds(on) at the datasheet Vgs within ±25 %`, () => {
      const { rds, vgs } = mosfetRdsPoint(part)!;
      const sg = type === 'nmos' ? 1 : -1;
      const c = [comp(type, 'Q', { ...partPreset(type, part)!, part }), comp('dcVoltage', 'VG', { voltage: sg * vgs }),
        comp('dcVoltage', 'VD', { voltage: sg * 0.01 }), comp('ground', 'G')];
      const ws = [w('VG', 'p', 'Q', 'g'), w('VG', 'n', 'G', 'g'), w('VD', 'p', 'Q', 'd'), w('VD', 'n', 'G', 'g'), w('Q', 's', 'G', 'g')];
      const s = solveDC(c, ws, plugins())!;
      const id = Math.abs(s.terminalCurrents!.get('VD:p')!);
      const measured = 0.01 / id;
      expect(measured / rds).toBeGreaterThan(0.75); expect(measured / rds).toBeLessThan(1.25);
    });
  }
});

describe('555 Astable Blink example still oscillates at f ≈ 1.44/((R1+2R2)C)', () => {
  it('measured frequency within 10 % of 13.8 Hz', async () => {
    const { exampleCategories } = await import('../src/lib/circuit/examples');
    const ex = exampleCategories.flatMap((c) => c.examples).find((e) => e.name === '555 Astable Blink')!;
    const comps = ex.doc.components.map((c) => ({ ...c, simState: {} }));
    const nm = buildNodeMap(comps, ex.doc.wires, plugins());
    const out = nm.terminalNode.get('ic1:out')!;
    let prev: any; let high = false; const edges: number[] = [];
    const dt = 2e-4;
    for (let i = 0; i < 6000; i++) {
      const r = simulateStep(comps, ex.doc.wires, plugins(), prev, dt)!;
      const s = r.sim; prev = { nodeVoltage: s.nodeVoltage, branchCurrent: s.branchCurrent, time: s.time, state: s.state };
      const h = s.nodeVoltage[out] > 2.5;
      if (h && !high) edges.push(s.time);
      high = h;
    }
    expect(edges.length).toBeGreaterThan(8);
    const period = (edges[edges.length - 1] - edges[2]) / (edges.length - 3);
    const f = 1 / period;
    expect(f).toBeGreaterThan(13.8 * 0.9); expect(f).toBeLessThan(13.8 * 1.1);
  });
});
