// Helpers for the real-board regression suite: load a .cir deck, import it with
// the app's SPICE importer, and run DC / transient / AC through the app engine.
import { readFileSync } from 'fs';
import { join } from 'path';
import '../../src/lib/circuit/components';
import { importSpiceNetlist } from '../../src/lib/circuit/spice-import';
import { solveDC, simulateStep, buildNodeMap } from '../../src/lib/circuit/engine';
import { getAllPlugins } from '../../src/lib/circuit/registry';
import { runAC } from '../../src/lib/circuit/analysis';
import type { CircuitComponent, ComponentPlugin, Wire } from '../../src/lib/circuit/types';

export const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'real-boards');
export const readDeck = (name: string) => readFileSync(join(FIXTURE_DIR, `${name}.cir`), 'utf8');

export interface Board {
  components: CircuitComponent[];
  wires: Wire[];
  plugins: Map<string, ComponentPlugin>;
  warnings: string[];
  errors: string[];
  analyses: NonNullable<ReturnType<typeof importSpiceNetlist>['analyses']>;
  /** node id (engine) of a SPICE net name */
  node: (net: string) => number;
  /** component terminal sitting on a net (for runAC probes) */
  netTerminal: (net: string) => string;
}

export function loadBoard(netlist: string): Board {
  const r = importSpiceNetlist(netlist);
  if (!r.doc) throw new Error('import failed: ' + r.errors.join('; '));
  const plugins = new Map(getAllPlugins().map((p) => [p.type, p]));
  const components = r.doc.components.map((c) => ({ ...c, simState: {} }));
  const wires = r.doc.wires;
  const nm = buildNodeMap(components, wires, plugins);
  const term = (net: string) => {
    const t = r.nets!.get(net.toLowerCase());
    if (!t) throw new Error('no net ' + net);
    return t;
  };
  return {
    components, wires, plugins, warnings: r.warnings, errors: r.errors, analyses: r.analyses ?? {},
    node: (net) => nm.terminalNode.get(`${term(net).componentId}:${term(net).terminalId}`) ?? 0,
    netTerminal: (net) => `${term(net).componentId}:${term(net).terminalId}`,
  };
}

export type Method = 'euler' | 'trap' | 'gear';

export function dcOperatingPoint(b: Board) {
  return solveDC(b.components, b.wires, b.plugins, 100, { robust: true });
}

export interface TranResult { t: number[]; v: Record<string, number[]> }

/** Fixed-step transient from the DC operating point. */
export function transient(b: Board, o: { tstep: number; tstop: number; probes: string[]; method?: Method; every?: number }): TranResult {
  const dc = dcOperatingPoint(b);
  if (!dc) throw new Error('DC operating point failed');
  let prev = { nodeVoltage: dc.nodeVoltage, branchCurrent: dc.branchCurrent, time: 0, state: dc.state };
  const ids = o.probes.map((p) => b.node(p));
  const out: TranResult = { t: [0], v: Object.fromEntries(o.probes.map((p, i) => [p, [dc.nodeVoltage[ids[i]] ?? 0]])) };
  const n = Math.round(o.tstop / o.tstep);
  const every = o.every ?? 1;
  for (let i = 1; i <= n; i++) {
    const r = simulateStep(b.components, b.wires, b.plugins, prev, o.tstep, { method: o.method ?? 'gear' });
    if (!r) throw new Error(`transient step failed at t=${(i * o.tstep).toExponential(3)}`);
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    if (i % every === 0) {
      out.t.push(r.sim.time);
      o.probes.forEach((p, k) => out.v[p].push(r.sim.nodeVoltage[ids[k]] ?? 0));
    }
  }
  return out;
}

/** AC sweep: complex V(net) at each frequency from the app's AC solver (sources carry their own AC magnitude). */
export function acSweep(b: Board, nets: string[], cfg: { sweep: 'dec' | 'oct' | 'lin'; nPoints: number; fStart: number; fStop: number }, opts?: { reltol?: number }) {
  const r = runAC(b.components, b.wires, b.plugins, { type: 'ac', sourceId: '', outputNode: b.netTerminal(nets[0]), extraOutputs: nets.slice(1).map((n) => b.netTerminal(n)), ...cfg }, opts as never);
  const out: Record<string, { f: number; re: number; im: number }[]> = {};
  nets.forEach((n, k) => {
    const tr = r.traces[k] as { xValues: Float64Array; yValues: Float64Array };
    out[n] = Array.from(tr.xValues, (f, i) => ({ f, re: tr.yValues[2 * i], im: tr.yValues[2 * i + 1] }));
  });
  return out;
}

// ── waveform measurements (same definitions on ngspice and app data) ──
export const interp = (t: number[], y: number[], x: number): number => {
  let lo = 0, hi = t.length - 1;
  if (x <= t[0]) return y[0];
  if (x >= t[hi]) return y[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m; }
  return y[lo] + ((y[hi] - y[lo]) * (x - t[lo])) / (t[hi] - t[lo]);
};
const win = (t: number[], y: number[], t0: number, t1: number) => { const o: number[] = []; for (let i = 0; i < t.length; i++) if (t[i] >= t0 && t[i] <= t1) o.push(y[i]); return o; };
export const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export const maxOf = (a: number[]) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
export const minOf = (a: number[]) => a.reduce((m, v) => (v < m ? v : m), Infinity);
export const amp = (t: number[], y: number[], t0: number, t1: number) => { const w = win(t, y, t0, t1); return (maxOf(w) - minOf(w)) / 2; };
export const maxIn = (t: number[], y: number[], t0: number, t1: number) => maxOf(win(t, y, t0, t1));
export const minIn = (t: number[], y: number[], t0: number, t1: number) => minOf(win(t, y, t0, t1));
export const meanIn = (t: number[], y: number[], t0: number, t1: number) => mean(win(t, y, t0, t1));
/** frequency from rising mean-crossings in [t0, t1] */
export function freq(t: number[], y: number[], t0: number, t1: number): number {
  const idx: number[] = [];
  for (let i = 0; i < t.length; i++) if (t[i] >= t0 && t[i] <= t1) idx.push(i);
  const m = mean(idx.map((i) => y[i]));
  const cr: number[] = [];
  for (let k = 1; k < idx.length; k++) {
    const a = y[idx[k - 1]] - m, b = y[idx[k]] - m;
    if (a < 0 && b >= 0) cr.push(t[idx[k - 1]] + ((t[idx[k]] - t[idx[k - 1]]) * -a) / (b - a));
  }
  return cr.length < 3 ? 0 : (cr.length - 1) / (cr[cr.length - 1] - cr[0]);
}
