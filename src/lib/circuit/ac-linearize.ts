// Generic small-signal (AC) model for any component plugin.
//
// AC analysis has hand-written phasor models for the basic parts (R, C, L,
// sources, simple diode/BJT/MOSFET). Every other plugin used to be skipped —
// an OPEN CIRCUIT in Bode / noise / .tf / pole-zero results (potentiometers,
// LM358-class op-amps, Shockley diodes, Gummel-Poon / Level-1 / JFET
// transistors, zeners, transformers, switches …).
//
// A plugin's transient stamp at the converged DC operating point is its
// Newton linearization: the conductance / VCCS / VCVS entries ARE the
// small-signal Jacobian, and the RHS constants are the large-signal offsets
// (dropped in AC). So we record the stamp once per operating point and
// replay its matrix entries into the complex system at each frequency.
// Internal reactances: backward-Euler companion entries have the exact form
// e(dt) = a + b/dt + c·dt (resistive, capacitive C/dt, inductive dt/L). The
// stamp is recorded at three timesteps and every entry solved for (a, b, c);
// the phasor admittance is then a + jωb + c/(jω). This makes transformer and
// coupled-inductor windings, motor / relay coils and device capacitances
// frequency-correct with no per-part AC code. Parts whose stamp structure
// changes with dt fall back to the DC-step linearization. Parts with other
// frequency dependence (an op-amp's GBW pole) provide an explicit acStamp.

import type { CircuitComponent, ComponentPlugin, SimContext } from './types';
import type { ComplexMnaSystem } from './complex-solver';
import { cAddEntry, cAddExtra, cStampConductance, cStampVCCS, cStampVCVS, cStampVoltageSource } from './complex-solver';

type Op =
  | { k: 'G'; a: number; b: number; g: number; gc?: number; gl?: number }
  | { k: 'VS'; a: number; b: number }
  | { k: 'VCVS'; a: number; b: number; c: number; d: number; mu: number }
  | { k: 'VCCS'; a: number; b: number; c: number; d: number; g: number; gc?: number; gl?: number }
  | { k: 'CCCS'; a: number; b: number; e: number; beta: number }
  | { k: 'CCVS'; a: number; b: number; e: number; r: number }
  | { k: 'X' };

/** Recorded extras live at BASE+i so they can't collide with real nodes. */
const BASE = 1 << 28;

const cache = new WeakMap<SimContext, Map<string, Op[]>>();

function record(comp: CircuitComponent, plugin: ComponentPlugin, terminals: { terminalId: string; nodeId: number }[], dcOp: SimContext, state: Record<string, any>, dt?: number): Op[] {
  const ops: Op[] = [];
  let next = BASE;
  const ignore = new Proxy({} as any, { get: () => 0, set: () => true });
  const sys: any = {
    numNodes: BASE, numExtra: 0, size: BASE, A: ignore, z: ignore, nextExtra: BASE,
    addExtra: () => { ops.push({ k: 'X' }); return next++; },
    stampConductance: (a: number, b: number, g: number) => { if (g) ops.push({ k: 'G', a, b, g }); },
    stampCurrentSource: () => { /* large-signal offset: no AC contribution */ },
    stampVoltageSource: (a: number, b: number) => { ops.push({ k: 'VS', a, b }); return next++; },
    stampVCVS: (a: number, b: number, c: number, d: number, mu: number) => { ops.push({ k: 'VCVS', a, b, c, d, mu }); return next++; },
    stampVCCS: (a: number, b: number, c: number, d: number, g: number) => { if (g) ops.push({ k: 'VCCS', a, b, c, d, g }); },
    stampCCCS: (a: number, b: number, e: number, beta: number) => { ops.push({ k: 'CCCS', a, b, e, beta }); },
    stampCCVS: (a: number, b: number, e: number, r: number) => { ops.push({ k: 'CCVS', a, b, e, r }); return next++; },
  };
  const sim: SimContext = {
    ...dcOp,
    state,
    newtonMemory: {},
    newtonIter: 0,
    ...(dt !== undefined ? { dt, method: 'euler' as const } : {}),
  };
  try {
    plugin.stamp!(comp.parameters, terminals, sys, sim, comp);
  } catch {
    return [];
  }
  return ops;
}

/**
 * Stamp the generic small-signal model of `comp` into the complex system.
 * Records are cached per DC operating point, so an AC sweep pays the plugin
 * stamp once per component.
 */
const FIT_DT = [1e-4, 2e-4, 4e-4];

/**
 * Record at the DC step for the operating-point linearization, and at three
 * small timesteps to separate each G / VCCS entry into a + b/dt + c·dt.
 * Falls back to the DC record when the op structure differs between steps.
 */
function recordWithReactance(
  comp: CircuitComponent, plugin: ComponentPlugin, terminals: { terminalId: string; nodeId: number }[],
  dcOp: SimContext, state: Record<string, any>,
): Op[] {
  const base = record(comp, plugin, terminals, dcOp, structuredCloneSafe(state));
  const recs = FIT_DT.map((dt) => record(comp, plugin, terminals, dcOp, structuredCloneSafe(state), dt));
  const same = recs.every((r) => r.length === base.length && r.every((op, i) => op.k === base[i].k
    && (op as any).a === (base[i] as any).a && (op as any).b === (base[i] as any).b
    && (op as any).c === (base[i] as any).c && (op as any).d === (base[i] as any).d));
  if (!same) return base;
  const [t1, t2, t3] = FIT_DT;
  return base.map((op, i) => {
    if (op.k !== 'G' && op.k !== 'VCCS') return op;
    const e = recs.map((r) => (r[i] as any).g as number);
    // solve e_i = a + b/t_i + c·t_i
    const A = [[1, 1 / t1, t1], [1, 1 / t2, t2], [1, 1 / t3, t3]];
    const [a, b, c] = solve3(A, e);
    const scale = Math.max(...e.map(Math.abs), 1e-30);
    const tiny = (x: number, w: number) => (Math.abs(x * w) < 1e-9 * scale ? 0 : x);
    const bb = tiny(b, 1 / t2);
    const cc = tiny(c, t2);
    if (bb === 0 && cc === 0) return op; // purely resistive: keep the DC-point value
    return { ...op, g: tiny(a, 1), gc: bb, gl: cc } as Op;
  });
}

function structuredCloneSafe<T>(x: T): T {
  try { return structuredClone(x); } catch { return x; }
}

function solve3(A: number[][], y: number[]): [number, number, number] {
  const m = A.map((r, i) => [...r, y[i]]);
  for (let k = 0; k < 3; k++) {
    let p = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(m[i][k]) > Math.abs(m[p][k])) p = i;
    [m[k], m[p]] = [m[p], m[k]];
    for (let i = k + 1; i < 3; i++) {
      const f = m[i][k] / m[k][k];
      for (let j = k; j < 4; j++) m[i][j] -= f * m[k][j];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let sum = m[i][3];
    for (let j = i + 1; j < 3; j++) sum -= m[i][j] * x[j];
    x[i] = sum / m[i][i];
  }
  return x as [number, number, number];
}

export function stampGenericAC(
  comp: CircuitComponent,
  plugin: ComponentPlugin,
  terminals: { terminalId: string; nodeId: number }[],
  sys: ComplexMnaSystem,
  dcOp: SimContext,
  omega = 0,
): void {
  if (!plugin.stamp) return;
  let perOp = cache.get(dcOp);
  if (!perOp) {
    perOp = new Map();
    cache.set(dcOp, perOp);
  }
  let ops = perOp.get(comp.id);
  if (!ops) {
    // stamps may mutate plugin state — record against a private copy
    let state: Record<string, any>;
    try { state = structuredClone(dcOp.state); } catch { state = { ...dcOp.state }; }
    ops = recordWithReactance(comp, plugin, terminals, dcOp, state);
    perOp.set(comp.id, ops);
  }
  // replay: recorded extra indices (BASE+i) → freshly allocated extras
  const extraMap = new Map<number, number>();
  let rec = BASE;
  const alloc = (newIdx: number) => { extraMap.set(rec++, newIdx); return newIdx; };
  const node = (n: number) => (n > BASE ? (extraMap.get(n - 1) ?? -1) + 1 : n);
  const idx = (e: number) => (e >= BASE ? extraMap.get(e) ?? -1 : -1);
  const re = (v: number) => ({ re: v, im: 0 });
  // a + jωb + c/(jω) = a + j(ωb − c/ω)
  const adm = (a: number, b = 0, c = 0) => ({ re: a, im: omega * b - (omega > 0 ? c / omega : 0) });
  for (const op of ops) {
    switch (op.k) {
      case 'X': alloc(cAddExtra(sys)); break;
      case 'G': cStampConductance(sys, node(op.a), node(op.b), adm(op.g, op.gc, op.gl)); break;
      case 'VS': alloc(cStampVoltageSource(sys, node(op.a), node(op.b), re(0))); break;
      case 'VCVS': alloc(cStampVCVS(sys, node(op.a), node(op.b), node(op.c), node(op.d), re(op.mu))); break;
      case 'VCCS': cStampVCCS(sys, node(op.a), node(op.b), node(op.c), node(op.d), adm(op.g, op.gc, op.gl)); break;
      case 'CCCS': {
        // controlling branch must belong to this component (indices from the
        // DC system do not map onto the AC system's numbering)
        const e = idx(op.e);
        if (e < 0) break;
        const a = node(op.a), b = node(op.b);
        if (a > 0) cAddEntry(sys, a - 1, e, re(op.beta));
        if (b > 0) cAddEntry(sys, b - 1, e, re(-op.beta));
        break;
      }
      case 'CCVS': {
        const row = alloc(cStampVoltageSource(sys, node(op.a), node(op.b), re(0)));
        const e = idx(op.e);
        if (e >= 0) cAddEntry(sys, row, e, re(-op.r));
        break;
      }
    }
  }
}
