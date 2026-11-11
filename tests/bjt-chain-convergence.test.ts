// Newton-Raphson convergence on big nonlinear circuits: a DC-coupled chain of
// N BJT inverters (Rc = 4.7 kΩ, Rb = 10 kΩ, Vcc = 5 V). Every stage's
// linearisation has gain ≈ gm·Rc; with all stages active the small-signal
// gains multiply (1e30+), so the raw Newton step is astronomical and only the
// devices' SPICE-style junction limiting (pnjlim on vbe AND vbc, evaluation at
// the limited point, non-convergence flagged) keeps the iteration alive.
//
// Reference values: ngspice 47 `.op` of the exported deck with the input held
// at 0 V (stage 0 off, stage 1 saturated, alternating).
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { runTran } from '../src/lib/circuit/analysis';
import { pnjlim } from '../src/lib/circuit/nonlinear';

const plugins = new Map(getAllPlugins().map((p) => [p.type, p]));

function comp(type: string, id: string, params?: Record<string, unknown>) {
  const pl: any = getPlugin(type);
  const d: Record<string, unknown> = {};
  if (pl) for (const pm of pl.parameters) d[pm.key] = pm.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...params }, simState: {} } as any;
}
let wid = 0;
const W = (f: string, ft: string, t: string, tt: string) =>
  ({ id: `w${wid++}`, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } });

function chain(n: number, input: 'dc0' | 'pulse') {
  const c = [
    input === 'dc0' ? comp('dcVoltage', 'V1', { voltage: 0 }) : comp('pulseSource', 'V1', { high: 1, low: 0, frequency: 1e3, duty: 50 }),
    comp('dcVoltage', 'VCC', { voltage: 5 }),
    comp('ground', 'GND'),
  ];
  const w = [W('V1', 'n', 'GND', 'g'), W('VCC', 'n', 'GND', 'g')];
  for (let i = 0; i < n; i++) {
    c.push(comp('npn', `Q${i}`), comp('resistor', `RC${i}`, { resistance: 4700 }), comp('resistor', `RB${i}`, { resistance: 10000 }), comp('capacitor', `CL${i}`, { capacitance: 1e-12 }));
    w.push(W('VCC', 'p', `RC${i}`, 'a'), W(`RC${i}`, 'b', `Q${i}`, 'c'), W(`Q${i}`, 'e', 'GND', 'g'), W(`CL${i}`, 'a', `Q${i}`, 'c'), W(`CL${i}`, 'b', 'GND', 'g'));
    w.push(i === 0 ? W('V1', 'p', 'RB0', 'a') : W(`Q${i - 1}`, 'c', `RB${i}`, 'a'), W(`RB${i}`, 'b', `Q${i}`, 'b'));
  }
  return { c, w };
}

/** Run `fn` while counting matrix builds (one dcVoltage stamp per build). */
function countBuilds<T>(fn: () => T): { value: T; builds: number } {
  const pl: any = plugins.get('dcVoltage');
  const orig = pl.stamp;
  let builds = 0;
  pl.stamp = function (...a: unknown[]) { builds++; return orig.apply(this, a); };
  try { return { value: fn(), builds }; } finally { pl.stamp = orig; }
}

const V = (sim: any, c: any[], w: any[], id: string, term: string) => sim.nodeVoltage[buildNodeMap(c, w, plugins).terminalNode.get(`${id}:${term}`)!];

// ngspice 47, input 0 V: even stages off, odd stages saturated.
const NG = { cOff: 3.629084, bOn: 0.7122431, cOn: 0.04557564 };

function expectNgspice(sim: any, c: any[], w: any[], n: number) {
  for (const i of [0, 1, 2, 3, n - 2, n - 1]) {
    const off = i % 2 === 0;
    expect(Math.abs(V(sim, c, w, `Q${i}`, 'c') - (off ? NG.cOff : NG.cOn))).toBeLessThan(1e-3);
    // off stage: base sits at the previous (saturated) collector (0 V for stage 0); on stage: one Vbe drop
    expect(Math.abs(V(sim, c, w, `Q${i}`, 'b') - (off ? (i === 0 ? 0 : NG.cOn) : NG.bOn))).toBeLessThan(1e-3);
  }
}

describe('BJT inverter chain — Newton convergence on large nonlinear circuits', () => {
  it('N=50 DC converges in < 100 matrix builds (was 2461) and matches ngspice', () => {
    const { c, w } = chain(50, 'dc0');
    const { value: sim, builds } = countBuilds(() => solveDC(c, w, plugins, 50, { robust: true }));
    expect(sim).not.toBeNull();
    expect(builds).toBeLessThan(100);
    expectNgspice(sim, c, w, 50);
  });

  it('N=200 DC converges and matches ngspice within 1 mV', () => {
    const { c, w } = chain(200, 'dc0');
    const t0 = performance.now();
    const sim = solveDC(c, w, plugins, 50, { robust: true });
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(sim).not.toBeNull();
    expectNgspice(sim, c, w, 200);
  });

  it('N=200 with a pulse input (starts high → Q0 on) converges and runs a fast transient', () => {
    const { c, w } = chain(200, 'pulse');
    const t0 = performance.now();
    const { value: r, builds } = countBuilds(() =>
      runTran(c, w, plugins, { type: 'tran', tStop: 200e-6, tStep: 1e-6, probes: ['Q199:c'] } as any));
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(r.report.converged).toBe(true);
    expect(r.scalars.steps).toBeGreaterThanOrEqual(200);
    // ≈ 1 Newton round per step once the operating point is in (was ~280)
    expect(builds / (r.scalars.steps as number)).toBeLessThan(3);
    // alternating logic levels at the far end of the chain
    const y = r.traces[0].yValues;
    const last = y[y.length - 1];
    expect(last === last).toBe(true);
    expect(Math.min(...Array.from(y))).toBeGreaterThanOrEqual(-0.1);
    expect(Math.max(...Array.from(y))).toBeLessThanOrEqual(5.1);
  });

  it('the DC ladder alone (gmin → source → pseudo-transient) solves the N=10 chain', async () => {
    const { dcGminStepping, dcSourceStepping, dcPseudoTransient } = await import('../src/lib/circuit/engine');
    const { c, w } = chain(10, 'dc0');
    for (const fn of [dcGminStepping, dcSourceStepping, dcPseudoTransient]) {
      const sim = fn(c, w, plugins, 50);
      expect(sim, fn.name).not.toBeNull();
      expectNgspice(sim!, c, w, 10);
    }
  });
});

describe('pnjlim (SPICE3 DEVpnjlim)', () => {
  const vt = 0.025852, vcrit = 0.78;
  it('passes small steps through unchanged', () => {
    expect(pnjlim(0.62, 0.6, vt, vcrit)).toBe(0.62);
  });
  it('compresses a forward overshoot logarithmically from the previous iterate', () => {
    const v = pnjlim(5, 0.6, vt, 0.5);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(1.0);
  });
  it('bounds a garbage 1e12 V step the same as a 20 V one (no e^32 current kick)', () => {
    expect(pnjlim(1e12, 0.6, vt, 0.5)).toBeLessThan(pnjlim(20, 0.6, vt, 0.5) + 1e-9);
  });
  it('limits the downward direction: vnew < 0 is clamped to vold − 1 (vold > 0)', () => {
    expect(pnjlim(-1e5, 0.6, vt, vcrit)).toBeCloseTo(-1.6, 12);
    expect(pnjlim(-1e5, -0.3, vt, vcrit)).toBeCloseTo(2 * -0.3 - 1, 12);
  });
  it('first-iteration case (vold ≤ 0) uses vt·ln(vnew/vt)', () => {
    expect(pnjlim(5, 0, vt, 0.5)).toBeCloseTo(vt * Math.log(5 / vt), 12);
  });
  it('never evaluates beyond vcrit + 10·Vt', () => {
    expect(pnjlim(30, 3, vt, vcrit)).toBeLessThanOrEqual(vcrit + 10 * vt + 1e-12);
  });
});
