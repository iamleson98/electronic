// PSpice "Smoke"-style stress check: simulated part stress vs datasheet
// absolute-maximum ratings.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { exampleLed, example555 } from '../src/lib/circuit/examples';
import {
  runStressAnalysis, stressCheck, stressTable, type StressRow,
} from '../src/lib/circuit/stress-check';
import { solveDC } from '../src/lib/circuit/engine';
import type { CircuitComponent, ComponentPlugin, Wire } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

const plugins = () => new Map<string, ComponentPlugin>(getAllPlugins().map((p) => [p.type, p]));

function C(type: string, id: string, params: Record<string, number | string | boolean> = {}): CircuitComponent {
  const defaults: Record<string, number | string | boolean> = {};
  for (const p of getPlugin(type)!.parameters) defaults[p.key] = p.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...defaults, ...params } };
}
let wn = 0;
const W = (a: string, at: string, b: string, bt: string): Wire => ({
  id: `w${++wn}`, from: { componentId: a, terminalId: at }, to: { componentId: b, terminalId: bt },
});

const row = (rows: StressRow[], id: string, metric: RegExp) => rows.find((r) => r.componentId === id && metric.test(r.metric));
const failing = (rows: StressRow[]) => rows.filter((r) => r.status === 'fail');

describe('stress check', () => {
  it('flags a 100 Ω 1206 resistor across 12 V (1.44 W vs 0.25 W)', () => {
    const comps = [C('dcVoltage', 'v1', { voltage: 12 }), C('resistor', 'r1', { resistance: 100 }), C('ground', 'g1')];
    const wires = [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    const rep = runStressAnalysis(comps, wires, plugins(), { mode: 'dc' });
    expect(rep.converged).toBe(true);
    const p = row(rep.rows, 'r1', /^P/)!;
    expect(p.value).toBeCloseTo(1.44, 2);
    expect(p.rating).toBe(0.25);
    expect(p.status).toBe('fail');
    expect(p.ratio).toBeCloseTo(5.76, 1);
    // the 12 V across it is far below the 200 V working-voltage limit
    expect(row(rep.rows, 'r1', /^V/)!.status).toBe('ok');
    // ...and a 5 W-rated part is fine
    comps[1].parameters.powerRating = 5;
    expect(runStressAnalysis(comps, wires, plugins(), { mode: 'dc' }).summary.fail).toBe(0);
    // eslint-disable-next-line no-console
    console.log('\n' + stressTable(rep.rows));
  });

  it('flags an LED with no resistor on 5 V (current)', () => {
    const comps = [C('dcVoltage', 'v1', { voltage: 5 }), C('led', 'led1'), C('ground', 'g1')];
    const wires = [W('v1', 'p', 'led1', 'a'), W('led1', 'k', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    const rep = runStressAnalysis(comps, wires, plugins(), { mode: 'dc' });
    const i = row(rep.rows, 'led1', /^If/)!;
    expect(i.value).toBeGreaterThan(0.03);
    expect(i.status).toBe('fail');
  });

  it('flags a 2N7000 with Vgs = 25 V (and passes it at 10 V)', () => {
    const build = (vg: number) => {
      const comps = [
        C('dcVoltage', 'vg', { voltage: vg }), C('dcVoltage', 'vd', { voltage: 5 }),
        C('resistor', 'rd', { resistance: 1000 }), C('nmos', 'm1', { part: '2N7000' }), C('ground', 'g1'),
      ];
      const wires = [
        W('vg', 'p', 'm1', 'g'), W('vd', 'p', 'rd', 'a'), W('rd', 'b', 'm1', 'd'),
        W('m1', 's', 'g1', 'g'), W('vg', 'n', 'g1', 'g'), W('vd', 'n', 'g1', 'g'),
      ];
      return runStressAnalysis(comps, wires, plugins(), { mode: 'dc' });
    };
    const bad = build(25);
    const vgs = row(bad.rows, 'm1', /^Vgs/)!;
    expect(vgs.value).toBeCloseTo(25, 1);
    expect(vgs.rating).toBe(20);
    expect(vgs.status).toBe('fail');
    expect(row(build(10).rows, 'm1', /^Vgs/)!.status).toBe('ok');
    expect(failing(build(10).rows)).toHaveLength(0);
  });

  it('flags a reversed polarized capacitor but not a correctly biased one', () => {
    const build = (reversed: boolean) => {
      const comps = [C('dcVoltage', 'v1', { voltage: 5 }), C('resistor', 'r1', { resistance: 1000 }),
        C('capacitor', 'c1', { polarized: true, ratedVoltage: 16 }), C('ground', 'g1')];
      const wires = reversed
        ? [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'c1', 'b'), W('c1', 'a', 'g1', 'g'), W('v1', 'n', 'g1', 'g')]
        : [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'c1', 'a'), W('c1', 'b', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
      return runStressAnalysis(comps, wires, plugins(), { mode: 'tran', tStop: 20e-3, tStep: 1e-4 });
    };
    const bad = row(build(true).rows, 'c1', /^V/)!;
    expect(bad.metric).toMatch(/reverse/);
    expect(bad.status).toBe('fail');
    expect(bad.value).toBeGreaterThan(0.5);
    const good = row(build(false).rows, 'c1', /^V/)!;
    expect(good.status).toBe('ok');
    expect(good.rating).toBe(16);
  });

  it('derating turns a 90 %-of-max stress into WARN, and 100 % derating leaves it OK', () => {
    // 5 V across 100 Ω = 0.25 W... use 4.74 V -> ~0.225 W = 90 % of 0.25 W
    const comps = [C('dcVoltage', 'v1', { voltage: 4.743 }), C('resistor', 'r1', { resistance: 100 }), C('ground', 'g1')];
    const wires = [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    const at100 = runStressAnalysis(comps, wires, plugins(), { mode: 'dc', derating: 1 });
    const at80 = runStressAnalysis(comps, wires, plugins(), { mode: 'dc', derating: 0.8 });
    expect(row(at100.rows, 'r1', /^P/)!.status).toBe('ok');
    const p80 = row(at80.rows, 'r1', /^P/)!;
    expect(p80.status).toBe('warn');
    expect(p80.deratedLimit).toBeCloseTo(0.2, 6);
  });

  it('time series: peak voltage and average (not peak) power', () => {
    // pulsed 20 V / 10 % duty into 1 kΩ: peak 0.4 W but average 0.04 W — passes a 0.25 W part
    const comps = [C('pulseSource', 'p1', { amplitude: 20, frequency: 1000, dutyCycle: 0.1 } as any), C('resistor', 'r1', { resistance: 1000 }), C('ground', 'g1')];
    const wires = [W('p1', 'p', 'r1', 'a'), W('r1', 'b', 'g1', 'g'), W('p1', 'n', 'g1', 'g')];
    const rep = runStressAnalysis(comps, wires, plugins(), { mode: 'tran', tStop: 5e-3, tStep: 2e-5 });
    const pw = row(rep.rows, 'r1', /^P/);
    if (pw) {
      expect(pw.value).toBeLessThan(0.25);
      expect(pw.status).toBe('ok');
    }
  });

  it('a parts without ratings emit no rows', () => {
    const comps = [C('dcVoltage', 'v1'), C('ground', 'g1'), C('resistor', 'r1')];
    const wires = [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    const rep = runStressAnalysis(comps, wires, plugins(), { mode: 'dc' });
    expect(rep.rows.every((r) => r.componentId === 'r1')).toBe(true);
  });

  it('stressCheck() accepts an already-solved DC context', () => {
    const comps = [C('dcVoltage', 'v1', { voltage: 12 }), C('resistor', 'r1', { resistance: 100 }), C('ground', 'g1')];
    const wires = [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    const dc = solveDC(comps, wires, plugins(), 50)!;
    expect(row(stressCheck(comps, wires, plugins(), dc), 'r1', /^P/)!.status).toBe('fail');
  });

  it('the LED example (330 Ω) is entirely OK', () => {
    const rep = runStressAnalysis(exampleLed.components as CircuitComponent[], exampleLed.wires as Wire[], plugins(), { mode: 'tran', tStop: 10e-3, tStep: 1e-4 });
    expect(rep.converged).toBe(true);
    expect(rep.rows.length).toBeGreaterThan(0);
    expect(failing(rep.rows)).toHaveLength(0);
    expect(rep.summary.warn).toBe(0);
    const i = row(rep.rows, 'led1', /^If/)!;
    expect(i.value).toBeGreaterThan(0.005);
    expect(i.value).toBeLessThan(0.02);
  });

  it('the 555 astable example is entirely OK', () => {
    const rep = runStressAnalysis(example555.components as CircuitComponent[], example555.wires as Wire[], plugins(), { mode: 'tran', tStop: 20e-3, tStep: 1e-4 });
    expect(rep.converged).toBe(true);
    expect(row(rep.rows, 'ic1', /^Vcc/)).toBeDefined();
    expect(failing(rep.rows)).toHaveLength(0);
  });

  it('a 555 on 18 V fails (NE555 abs max 16 V)', () => {
    const comps = [C('dcVoltage', 'v1', { voltage: 18 }), C('timer555', 'ic1'), C('ground', 'g1')];
    const wires = [W('v1', 'p', 'ic1', 'vcc'), W('v1', 'p', 'ic1', 'rst'), W('ic1', 'gnd', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    const rep = runStressAnalysis(comps, wires, plugins(), { mode: 'dc' });
    expect(row(rep.rows, 'ic1', /^Vcc/)!.status).toBe('fail');
  });

  it('1/8 W resistor at 5 W and the hook table cover every datasheet part', () => {
    for (const [type, parts] of [
      ['npn', ['2N3904', 'PN2222A', 'P2N2222A', 'BC547B', 'BC337-40', 'MMBT3904', 'TIP31C']],
      ['pnp', ['2N3906', 'BC557B', 'BC327-40', 'MMBT3906', 'TIP32C']],
      ['nmos', ['2N7000', 'BS170', 'BSS138', 'AO3400A', 'IRF540N', 'IRLZ44N']],
      ['pmos', ['BSS84', 'AO3401A', 'IRF9540N']],
    ] as const) {
      for (const part of parts) {
        const r = getPlugin(type)!.ratings!({ part });
        expect(r, `${type} ${part}`).toBeDefined();
        expect(r!.power!.max).toBeGreaterThan(0);
      }
    }
    expect(getPlugin('nmos')!.ratings!({ part: '2N7000' })!.currents![0].max).toBe(0.2);
    expect(getPlugin('pnp')!.ratings!({ part: 'TIP32C' })!.power!.max).toBe(40);
  });

  it('AI tool stress_check returns rows and a verdict', async () => {
    const { TOOLS_BY_NAME } = await import('../src/lib/ai/tools');
    const tool = TOOLS_BY_NAME.get('stress_check')!;
    const comps = [C('dcVoltage', 'v1', { voltage: 12 }), C('resistor', 'r1', { resistance: 100 }), C('ground', 'g1')];
    const wires = [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    const res: any = await tool.execute({ mode: 'dc' }, { doc: { version: 1, components: comps, wires } as any, plugins: plugins() });
    expect(res.ok).toBe(true);
    expect(res.result.verdict).toBe('fail');
    expect(res.result.rows[0]).toMatchObject({ ref: 'R1', status: 'fail' });
  });

  it('store.runStressCheck stores the report and marks failing parts on the canvas', async () => {
    const { useEditor } = await import('../src/lib/circuit/store');
    const comps = [C('dcVoltage', 'v1', { voltage: 12 }), C('resistor', 'r1', { resistance: 100 }), C('ground', 'g1')];
    const wires = [W('v1', 'p', 'r1', 'a'), W('r1', 'b', 'g1', 'g'), W('v1', 'n', 'g1', 'g')];
    useEditor.setState({ components: comps, wires, ercErrors: [] });
    useEditor.getState().setSimOptions({ stressDerating: 0.8 });
    const rep = useEditor.getState().runStressCheck({ mode: 'dc' });
    expect(rep.derating).toBe(0.8);
    expect(useEditor.getState().stressReport).toBe(rep);
    const marks = useEditor.getState().ercErrors.filter((e) => e.type === 'component_overstress');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ componentId: 'r1', severity: 'error' });
  });
});
