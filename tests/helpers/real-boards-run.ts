import { loadBoard, readDeck, transient, acSweep, dcOperatingPoint } from './real-boards';
import { runNgspice } from './ngspice-run';
import type { DeckSpec, Series, Metrics } from './real-boards-specs';

const MULT: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
export function parseSpice(s: string): number {
  const m = /^([-+.\d]+(?:e[-+]?\d+)?)(meg|[tgkmunpf])?/i.exec(s)!;
  return parseFloat(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1);
}

/** Run the deck through the app's importer + engine over the spec's analysis window. */
export function runOurs(spec: DeckSpec): { series: Series; ms: number } {
  const b = loadBoard(readDeck(spec.id));
  const t0 = Date.now();
  let series: Series;
  if (spec.kind === 'op') {
    const dc = dcOperatingPoint(b);
    if (!dc) throw new Error('DC operating point failed');
    series = { x: [0], v: Object.fromEntries(spec.probes.map((p) => [p, [dc.nodeVoltage[b.node(p)]]])) };
  } else if (spec.kind === 'tran') {
    const m = /\.tran\s+(\S+)\s+(\S+)/i.exec(spec.analysis!)!;
    const r = transient(b, { tstep: spec.ours!.tstep, tstop: parseSpice(m[2]), probes: spec.probes, method: spec.ours!.method, every: spec.ours!.every });
    series = { x: r.t, v: r.v };
  } else {
    const m = /\.ac\s+(\w+)\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(spec.analysis!)!;
    const r = acSweep(b, spec.probes, { sweep: m[1] as 'dec' | 'oct' | 'lin', nPoints: parseSpice(m[2]), fStart: parseSpice(m[3]), fStop: parseSpice(m[4]) });
    series = {
      x: r[spec.probes[0]].map((p) => p.f),
      v: Object.fromEntries(spec.probes.map((p) => [p, r[p].map((q) => q.re)])),
      vi: Object.fromEntries(spec.probes.map((p) => [p, r[p].map((q) => q.im)])),
    };
  }
  return { series, ms: Date.now() - t0 };
}

/** DC operating point of the probes on the app engine. */
export function ourDcOp(spec: DeckSpec): Record<string, number> {
  const b = loadBoard(readDeck(spec.id));
  const dc = dcOperatingPoint(b);
  if (!dc) throw new Error('DC operating point failed');
  return Object.fromEntries(spec.probes.map((p) => [p, dc.nodeVoltage[b.node(p)]]));
}

/** Reference values from a live ngspice run: metrics over the spec window and the .op of the probes. */
export function ngspiceReference(spec: DeckSpec): { metrics: Metrics; dcOp: Record<string, number> } {
  const deck = readDeck(spec.id);
  const run = runNgspice(deck, { probes: spec.probes, analysis: spec.kind === 'op' ? 'op' : spec.analysis, options: spec.ngOptions });
  const op = runNgspice(deck, { probes: spec.probes, analysis: 'op', options: spec.ngOptions });
  return {
    metrics: spec.metrics({ x: run.x, v: run.v, vi: run.vi }),
    dcOp: Object.fromEntries(spec.probes.map((p) => [p, op.v[p][0]])),
  };
}
