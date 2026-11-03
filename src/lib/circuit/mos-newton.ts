// Shared Newton machinery for N-form MOSFET models (BSIM3, BSIM4).
//
// The model evaluators take (vgs, vds ≥ 0, vbs) for an N-channel device in
// forward mode. This helper:
//   - linearizes at the CURRENT Newton iterate (sim.nodeVoltage), not at
//     voltages written by step() once per timestep — with the latter, the
//     engine's re-stamp rounds all saw the same linearization and the
//     transient drifted / diverged (kV–10³⁴ V outputs in the audit);
//   - maps P-channel devices into the N-form ("flipped world");
//   - handles reverse mode (Vds < 0) by swapping source and drain — the
//     evaluators are only valid for Vds ≥ 0;
//   - limits the gate-referenced junction steps per Newton round (SPICE
//     fetlim-style) and flags limited rounds as non-converged;
//   - replaces non-finite model outputs with a safe off-state.

import type { MnaSystem, SimContext } from './types';

export interface MosOp {
  id: number;
  gm: number;
  gds: number;
  gmb: number;
}

export interface MosNodes { d: number; g: number; s: number; b: number }

const MAX_STEP = 1.0; // V per Newton round on Vgs / Vgd

function limit(v: number, old: number | undefined, mem: Record<string, number> | undefined): number {
  if (old === undefined) return v;
  if (v > old + MAX_STEP) { if (mem) mem.__limited = (mem.__limited ?? 0) + 1; return old + MAX_STEP; }
  if (v < old - MAX_STEP) { if (mem) mem.__limited = (mem.__limited ?? 0) + 1; return old - MAX_STEP; }
  return v;
}

/**
 * Stamp the channel current of an N-form MOSFET model. `key` identifies the
 * device's Newton memory; `committed` gives the previous step's terminal
 * voltages (real, signed) used as the first round's limiting reference.
 */
export function stampMosChannel(
  sys: MnaSystem,
  sim: SimContext,
  n: MosNodes,
  isN: boolean,
  key: string,
  evaluate: (vgs: number, vds: number, vbs: number) => MosOp,
  committed?: { vgs?: number; vds?: number },
): MosOp & { reversed: boolean; D: number; S: number; cGs: number; cDs: number; cBs: number } {
  const pol = isN ? 1 : -1;
  const V = (x: number) => (x > 0 ? sim.nodeVoltage[x] ?? 0 : 0);
  const mem = sim.newtonMemory;
  // gate-referenced terminal voltages in the device's polarity frame
  let vgs = pol * (V(n.g) - V(n.s));
  let vgd = pol * (V(n.g) - V(n.d));
  const oldGs = mem?.[key + '_gs'] ?? (committed?.vgs !== undefined ? pol * committed.vgs : undefined);
  const oldGd = mem?.[key + '_gd'] ?? (committed?.vgs !== undefined && committed?.vds !== undefined
    ? pol * (committed.vgs - committed.vds) : undefined);
  vgs = limit(vgs, oldGs, mem);
  vgd = limit(vgd, oldGd, mem);
  if (mem) { mem[key + '_gs'] = vgs; mem[key + '_gd'] = vgd; }
  const vbsT = pol * (V(n.b) - V(n.s));
  const vds = vgs - vgd;
  const reversed = vds < 0;
  // forward-mode controlling voltages relative to the effective source
  const cGs = reversed ? vgd : vgs;
  const cDs = Math.abs(vds);
  const cBs = reversed ? vbsT + vds : vbsT; // vbd = vbs − vds
  let op = evaluate(cGs, cDs, cBs);
  if (![op.id, op.gm, op.gds, op.gmb].every(Number.isFinite)) op = { id: 0, gm: 0, gds: 1e-9, gmb: 0 };
  const D = reversed ? n.s : n.d;
  const S = reversed ? n.d : n.s;
  sys.stampVCCS(D, S, n.g, S, op.gm);
  sys.stampConductance(D, S, Math.max(op.gds, 0) + 1e-12);
  sys.stampVCCS(D, S, n.b, S, op.gmb);
  // Polarity-symmetric Jacobian; the polarity lives in the offset source.
  sys.stampCurrentSource(D, S, pol * (op.id - op.gm * cGs - op.gds * cDs - op.gmb * cBs));
  return { ...op, reversed, D, S, cGs, cDs, cBs };
}
