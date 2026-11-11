// Component stress check — PSpice "Smoke"-style derating analysis.
//
// After a simulation, compare every part's simulated stress (voltage across /
// between its pins, terminal current, dissipation) with the datasheet
// ABSOLUTE-MAXIMUM ratings its plugin declares (`ComponentPlugin.ratings`,
// attached in components/ratings.ts) and report one row per rating:
//
//   ok    value ≤ derated limit              (derated limit = abs max × derating)
//   warn  derated limit < value ≤ abs max    (only possible when derating < 1)
//   fail  value > abs max
//
// What is compared (worst case over the run):
//   • voltage  — PEAK of V(plus)−V(minus) in each direction (ratings.ts decides
//                which pair and direction; e.g. a polarized cap's reverse bias).
//   • current  — PEAK |terminal current|.
//   • power    — TIME-AVERAGED dissipation Σ V·I over the run (datasheet Pd /
//                P_tot are continuous ratings; a short pulse above Pd is not
//                a failure). The peak is reported in the row note.
//   For a DC operating point the single sample is both peak and average.
//
// Currents come from SimContext.terminalCurrents (exact, KCL-consistent,
// recorded by the engine when a step runs with `recordTerminalCurrents`). Without
// them only 2-terminal parts can be checked (via computeComponentCurrents).
//
// Parts whose plugin has no `ratings` hook produce no rows — nothing is guessed.

import type { CircuitComponent, ComponentPlugin, PartRatings, SimContext, Wire } from './types';
import {
  buildNodeMap, getTerminalsForComponent, simulateStep, solveDC, computeComponentCurrents,
} from './engine';
import { attachRatings } from './components/ratings';
import { assignRefdes } from '../pcb/netlist-sync';
import { dcSolveOpts, mergeOptions } from './sim-options';

export type StressStatus = 'ok' | 'warn' | 'fail';
export type StressKind = 'voltage' | 'current' | 'power';

export interface StressRow {
  componentId: string;
  /** reference designator (R1, Q2, …) */
  ref: string;
  /** plugin type id */
  type: string;
  /** datasheet part identity, e.g. "2N7000" */
  part?: string;
  /** what was measured, e.g. "Vgs", "Ic", "P (avg)", "V (reverse)" */
  metric: string;
  kind: StressKind;
  /** worst-case simulated value (positive magnitude in the stressed direction) */
  value: number;
  unit: 'V' | 'A' | 'W';
  /** datasheet absolute maximum */
  rating: number;
  /** rating × derating factor */
  deratedLimit: number;
  /** value / rating (1 = exactly at absolute max) */
  ratio: number;
  /** value / deratedLimit */
  deratedRatio: number;
  status: StressStatus;
  /** time of the worst-case sample, when a time series was evaluated */
  atTime?: number;
  note?: string;
}

export interface StressOptions {
  /** fraction of the absolute max allowed before a WARN, (0,1]. 1 = abs max only; 0.8 = "professional" margin. */
  derating?: number;
  /** supply designators (otherwise assignRefdes, same as the BOM / PCB) */
  refdesOf?: Map<string, string>;
}

/** Derating presets offered in the UI. */
export const DERATING_PRESETS: { label: string; value: number }[] = [
  { label: 'None — absolute max only (100 %)', value: 1 },
  { label: 'Professional (80 %)', value: 0.8 },
  { label: 'Conservative (70 %)', value: 0.7 },
  { label: 'Military / high-rel (50 %)', value: 0.5 },
];

const REL_EPS = 1e-9;

export function clampDerating(d: number | undefined): number {
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.min(1, d) : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accumulator — fold a stream of solved states into per-rating worst cases
// ─────────────────────────────────────────────────────────────────────────────

interface Tracked {
  comp: CircuitComponent;
  plugin: ComponentPlugin;
  ratings: PartRatings;
  /** terminal id → node id */
  nodes: Map<string, number>;
  volt: { posPeak: number; posT: number; negPeak: number; negT: number }[];
  curr: { peak: number; t: number }[];
  pPeak: number;
  pPeakT: number;
  pEnergy: number;
}

export class StressAccumulator {
  private tracked: Tracked[] = [];
  private totalWeight = 0;
  private samples = 0;
  private needsCurrent = false;
  private readonly plugins: Map<string, ComponentPlugin>;
  private readonly comps: CircuitComponent[];
  private readonly wires: Wire[];
  private readonly refdesOf?: Map<string, string>;

  constructor(
    components: CircuitComponent[],
    wires: Wire[],
    plugins: Map<string, ComponentPlugin>,
    refdesOf?: Map<string, string>,
  ) {
    attachRatings();
    this.comps = components;
    this.wires = wires;
    this.plugins = plugins;
    this.refdesOf = refdesOf;
    const nodeMap = buildNodeMap(components, wires, plugins);
    for (const comp of components) {
      if (comp.variant === 'dnp') continue;
      const plugin = plugins.get(comp.type);
      if (!plugin?.ratings) continue;
      let ratings: PartRatings | undefined;
      try { ratings = plugin.ratings(comp.parameters ?? {}); } catch { ratings = undefined; }
      if (!ratings) continue;
      const nodes = new Map<string, number>();
      for (const t of getTerminalsForComponent(comp, plugin, nodeMap)) nodes.set(t.terminalId, t.nodeId);
      const volt = (ratings.voltages ?? []).map(() => ({ posPeak: 0, posT: 0, negPeak: 0, negT: 0 }));
      const curr = (ratings.currents ?? []).map(() => ({ peak: 0, t: 0 }));
      if (curr.length > 0 || ratings.power) this.needsCurrent = true;
      this.tracked.push({ comp, plugin, ratings, nodes, volt, curr, pPeak: 0, pPeakT: 0, pEnergy: 0 });
    }
  }

  /** Number of parts that have datasheet ratings. */
  get partCount(): number { return this.tracked.length; }
  get sampleCount(): number { return this.samples; }

  /**
   * Fold one solved state in. `weight` is the time the state represents (for
   * the average power); defaults to sim.dt, or 1 when that is unusable.
   */
  add(sim: SimContext, weight?: number): void {
    if (this.tracked.length === 0) { this.samples++; return; }
    const w = weight !== undefined && weight > 0 ? weight : (sim.dt > 0 && Number.isFinite(sim.dt) ? sim.dt : 1);
    let fallback: Map<string, number> | undefined;
    if (this.needsCurrent && !(sim.terminalCurrents && sim.terminalCurrents.size > 0)) {
      try { fallback = computeComponentCurrents(this.comps, this.wires, this.plugins, sim); } catch { fallback = undefined; }
    }
    const t = sim.time;
    const V = (n: number) => { const v = sim.nodeVoltage[n]; return n > 0 && Number.isFinite(v) ? v : 0; };
    this.totalWeight += w;
    this.samples++;

    for (const tr of this.tracked) {
      const { ratings, comp } = tr;
      (ratings.voltages ?? []).forEach((vr, i) => {
        const v = V(tr.nodes.get(vr.plus) ?? 0) - V(tr.nodes.get(vr.minus) ?? 0);
        const s = tr.volt[i];
        if (v > s.posPeak) { s.posPeak = v; s.posT = t; }
        if (-v > s.negPeak) { s.negPeak = -v; s.negT = t; }
      });

      // terminal currents INTO the component
      const into = (terminal: string): number | undefined => {
        const exact = sim.terminalCurrents?.get(`${comp.id}:${terminal}`);
        if (exact !== undefined) return exact;
        if (fallback && tr.plugin.terminals.length === 2) {
          const i = fallback.get(comp.id);
          if (i === undefined) return undefined;
          return terminal === tr.plugin.terminals[0].id ? i : -i;
        }
        return undefined;
      };

      (ratings.currents ?? []).forEach((cr, i) => {
        const cur = into(cr.terminal);
        if (cur === undefined || !Number.isFinite(cur)) return;
        const m = Math.abs(cur);
        if (m > tr.curr[i].peak) { tr.curr[i].peak = m; tr.curr[i].t = t; }
      });

      if (ratings.power) {
        let p = 0;
        let known = false;
        for (const term of tr.plugin.terminals) {
          const cur = into(term.id);
          if (cur === undefined || !Number.isFinite(cur)) continue;
          known = true;
          p += V(tr.nodes.get(term.id) ?? 0) * cur;
        }
        if (known) {
          if (p > tr.pPeak) { tr.pPeak = p; tr.pPeakT = t; }
          tr.pEnergy += p * w;
        }
      }
    }
  }

  /** Evaluate the accumulated worst cases against the ratings. */
  rows(opts: StressOptions = {}): StressRow[] {
    const derating = clampDerating(opts.derating);
    const refs = opts.refdesOf ?? this.refdesOf ?? assignRefdes(this.comps);
    const timed = this.samples > 1;
    const out: StressRow[] = [];

    const push = (
      tr: Tracked, metric: string, kind: StressKind, value: number, rating: number, atTime: number | undefined, note?: string,
    ) => {
      if (!(rating > 0) || !Number.isFinite(value)) return;
      const deratedLimit = rating * derating;
      const status: StressStatus =
        value > rating * (1 + REL_EPS) ? 'fail' : value > deratedLimit * (1 + REL_EPS) ? 'warn' : 'ok';
      out.push({
        componentId: tr.comp.id,
        ref: refs.get(tr.comp.id) ?? tr.comp.refdes ?? tr.comp.id,
        type: tr.comp.type,
        part: tr.ratings.part,
        metric, kind, value,
        unit: kind === 'voltage' ? 'V' : kind === 'current' ? 'A' : 'W',
        rating, deratedLimit,
        ratio: value / rating,
        deratedRatio: value / deratedLimit,
        status,
        atTime: timed ? atTime : undefined,
        note,
      });
    };

    for (const tr of this.tracked) {
      (tr.ratings.voltages ?? []).forEach((vr, i) => {
        const s = tr.volt[i];
        const cands: { metric: string; value: number; limit: number; t: number }[] = [];
        if (vr.max !== undefined) cands.push({ metric: vr.label, value: s.posPeak, limit: vr.max, t: s.posT });
        if (vr.reverse !== undefined) {
          cands.push({ metric: vr.max !== undefined && vr.max !== vr.reverse ? `${vr.label} (reverse)` : vr.label, value: s.negPeak, limit: vr.reverse, t: s.negT });
        }
        if (cands.length === 0) return;
        const worst = cands.reduce((a, b) => (b.value / b.limit > a.value / a.limit ? b : a));
        push(tr, worst.metric, 'voltage', worst.value, worst.limit, worst.t, vr.note);
      });
      (tr.ratings.currents ?? []).forEach((cr, i) => {
        push(tr, cr.label, 'current', tr.curr[i].peak, cr.max, tr.curr[i].t, cr.note);
      });
      if (tr.ratings.power) {
        const pr = tr.ratings.power;
        const avg = this.totalWeight > 0 ? Math.max(0, tr.pEnergy / this.totalWeight) : 0;
        const notes: string[] = [];
        if (timed && tr.pPeak > avg * 1.05 && tr.pPeak > 0) notes.push(`peak ${tr.pPeak.toPrecision(3)} W`);
        if (pr.note && pr.freeAir !== undefined && avg > pr.freeAir) notes.push(pr.note);
        else if (pr.note && pr.freeAir === undefined) notes.push(pr.note);
        push(tr, `${pr.label ?? 'P'} (avg)`, 'power', avg, pr.max, undefined, notes.join('; ') || undefined);
      }
    }

    const rank: Record<StressStatus, number> = { fail: 0, warn: 1, ok: 2 };
    return out.sort((a, b) => rank[a.status] - rank[b.status] || b.ratio - a.ratio || a.ref.localeCompare(b.ref));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure entry point: document + solved state(s) → rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate stress from one solved state (DC operating point / live snapshot)
 * or a time series of states (one SimContext per step — worst case over the
 * run, average power weighted by each state's `dt`).
 */
export function stressCheck(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  sims: SimContext | SimContext[],
  opts: StressOptions = {},
): StressRow[] {
  const acc = new StressAccumulator(components, wires, plugins, opts.refdesOf);
  const list = Array.isArray(sims) ? sims : [sims];
  // a single DC solve carries a huge dt (1e6 s) — irrelevant for one sample
  for (const s of list) acc.add(s, list.length === 1 ? 1 : undefined);
  return acc.rows(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-contained runner (DC operating point, or DC + transient)
// ─────────────────────────────────────────────────────────────────────────────

export interface StressRunOptions extends StressOptions {
  /** 'dc' = operating point only; 'tran' = DC seed + transient to tStop (default when tStop > 0) */
  mode?: 'dc' | 'tran';
  tStop?: number;
  tStep?: number;
  method?: 'euler' | 'trap' | 'gear';
  temp?: number;
  /** hard cap on transient steps (default 20000) */
  maxSteps?: number;
}

export interface StressReport {
  rows: StressRow[];
  /** counts by status */
  summary: { ok: number; warn: number; fail: number; parts: number; failingParts: number };
  mode: 'dc' | 'tran';
  derating: number;
  /** simulated time span (0 for DC) */
  simulatedTime: number;
  samples: number;
  converged: boolean;
  /** why the run is incomplete, if it is */
  error?: string;
}

export function summarizeStress(rows: StressRow[], parts: number) {
  const s = { ok: 0, warn: 0, fail: 0, parts, failingParts: 0 };
  const failing = new Set<string>();
  for (const r of rows) {
    s[r.status]++;
    if (r.status === 'fail') failing.add(r.componentId);
  }
  s.failingParts = failing.size;
  return s;
}

/**
 * Solve the circuit (DC, then optionally transient) on private copies of the
 * components and stress-check the result. Never touches the live simulation.
 */
export function runStressAnalysis(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  opts: StressRunOptions = {},
): StressReport {
  const derating = clampDerating(opts.derating);
  const tStop = opts.tStop ?? 0;
  const mode: 'dc' | 'tran' = opts.mode ?? (tStop > 0 ? 'tran' : 'dc');
  const tStep = opts.tStep && opts.tStep > 0 ? opts.tStep : 1e-4;
  const temp = opts.temp ?? 27;
  const method = opts.method ?? 'gear';
  const comps = components.map((c) => ({ ...c, parameters: { ...c.parameters }, simState: {} }));
  const acc = new StressAccumulator(comps, wires, plugins, opts.refdesOf);

  const fail = (error: string): StressReport => ({
    rows: [], summary: summarizeStress([], acc.partCount), mode, derating,
    simulatedTime: 0, samples: acc.sampleCount, converged: false, error,
  });

  let dc: SimContext | null = null;
  try {
    dc = solveDC(comps, wires, plugins, 100, dcSolveOpts(mergeOptions({ temp })));
  } catch (e) {
    return fail(`DC solve threw: ${(e as Error).message}`);
  }
  if (!dc) return fail('DC operating point did not converge');

  let simulatedTime = 0;
  let error: string | undefined;
  if (mode === 'dc') {
    acc.add(dc, 1);
  } else {
    acc.add(dc, tStep);
    let prev = { nodeVoltage: dc.nodeVoltage, branchCurrent: dc.branchCurrent, time: 0, state: dc.state };
    const steps = Math.min(Math.ceil(tStop / tStep), opts.maxSteps ?? 20000);
    for (let i = 0; i < steps; i++) {
      const r = simulateStep(comps, wires, plugins, prev, tStep, { method, temp, recordTerminalCurrents: true });
      if (!r) { error = `transient step failed at t=${(i * tStep).toPrecision(4)} s`; break; }
      acc.add(r.sim, tStep);
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
      simulatedTime = (i + 1) * tStep;
    }
  }
  const rows = acc.rows({ derating, refdesOf: opts.refdesOf });
  return {
    rows, summary: summarizeStress(rows, acc.partCount), mode, derating,
    simulatedTime, samples: acc.sampleCount, converged: !error, error,
  };
}

/** Format a stress row's numbers with engineering prefixes for tables / AI output. */
export function formatStressValue(v: number, unit: string): string {
  const a = Math.abs(v);
  if (a === 0) return `0 ${unit}`;
  const prefixes: [number, string][] = [[1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']];
  for (const [scale, p] of prefixes) {
    if (a >= scale * 0.9995) return `${Number((v / scale).toPrecision(3))} ${p}${unit}`;
  }
  return `${v.toExponential(2)} ${unit}`;
}

/** Plain-text table (tests, AI tool, console). */
export function stressTable(rows: StressRow[]): string {
  const head = ['Ref', 'Part', 'Metric', 'Value', 'Limit', '% of abs max', 'Status'];
  const body = rows.map((r) => [
    r.ref, r.part ?? r.type, r.metric, formatStressValue(r.value, r.unit),
    formatStressValue(r.rating, r.unit), `${(r.ratio * 100).toFixed(0)}%`, r.status.toUpperCase(),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), ...body.map(line)].join('\n');
}
