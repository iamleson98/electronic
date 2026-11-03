// Shared behavioral op-amp model — every op-amp part (generic opampRails,
// opampReal, LM358/LM324/LM741/TL072/NE5532) stamps through this core so
// each datasheet parameter it exposes is actually simulated:
//
//   input stage   V+ / V− with offset Vos, input bias current Ib (direction
//                 per input type), 1 GΩ leak, CMRR (common-mode error)
//   gain stage    single dominant pole: A(s) = A0 / (1 + s·τ), τ = A0/(2π·GBW)
//                 (backward-Euler in transient, exact phasor in AC)
//   slew limit    |dVint/dt| ≤ SR
//   output swing  between (V− + swingLow) and (V+ − swingHigh) of the ACTUAL
//                 rail voltages (part defaults when both rail pins are unwired)
//   output stage  Rout with short-circuit current limit Isc
//   supply        quiescent current Iq from V+ to V−; the output current is
//                 drawn from V+ when sourcing and returned to V− when sinking
//                 (so supply wires carry the load current, as in hardware)
//
// Limits are C¹-smooth (exponential knee) rather than hard regions: the
// Newton loop then converges without region memory. (The old models kept a
// linear/saturated flag in plugin state with "exit saturation through
// linear"; the engine rolls state back every Newton round, so a rail-to-rail
// edge committed the LINEAR solution — a one-step ~500 kV spike on every
// comparator-style transition.)

import type { MnaSystem, SimContext } from '../types';
import type { ComplexMnaSystem } from '../complex-solver';
import { cAddEntry, cAddExtra, cStampConductance, cStampVCVS } from '../complex-solver';
import { softClamp, limitAcross } from '../nl-limits';

export interface OpampSpec {
  /** open-loop DC gain (V/V) */
  gain: number;
  /** gain-bandwidth product (Hz); Infinity = no dominant pole */
  gbw: number;
  /** slew rate (V/µs); Infinity = unlimited */
  slewRate: number;
  /** input offset voltage (V) */
  voff: number;
  /** input bias current (A), positive = flowing INTO each input pin */
  ibias: number;
  /** common-mode rejection ratio (dB); Infinity = ideal */
  cmrr: number;
  /** open-loop output resistance (Ω) */
  rout: number;
  /** output headroom below V+ (V) */
  swingHigh: number;
  /** output headroom above V− (V) */
  swingLow: number;
  /** output short-circuit current limit (A); Infinity = unlimited */
  iLimit: number;
  /** quiescent supply current (A) */
  iq: number;
  /** rails assumed when BOTH supply pins are unwired */
  defVcc: number;
  defVee: number;
}

export interface OpampPins {
  inp: number;
  inn: number;
  out: number;
  vcc: number;
  vee: number;
}

/** Datasheet-style parameter block shared by the op-amp parts. */
export function opampParamDefs(d: {
  gain: number; gbw: number; slewRate: number; voffMv: number; ibiasNa: number; cmrrDb: number;
  rout: number; swingHigh: number; swingLow: number; iLimitMa: number; iqMa: number;
}, swingKeys: { high: string; low: string } = { high: 'swingHigh', low: 'swingLow' }) {
  return [
    { key: 'gain', label: 'Open-loop Gain (V/V)', type: 'number' as const, default: d.gain, min: 1, max: 1e9, step: 1000 },
    { key: 'gbw', label: 'Gain-Bandwidth (Hz)', type: 'number' as const, default: d.gbw, unit: 'Hz', min: 1, max: 1e10, step: 10000 },
    { key: 'slewRate', label: 'Slew Rate (V/µs)', type: 'number' as const, default: d.slewRate, min: 1e-4, max: 1e4, step: 0.1 },
    { key: 'voff', label: 'Offset Voltage (mV)', type: 'number' as const, default: d.voffMv, min: -100, max: 100, step: 0.1 },
    { key: 'ibias', label: 'Bias Current (nA, + into pins)', type: 'number' as const, default: d.ibiasNa, min: -1e5, max: 1e5, step: 5 },
    { key: 'cmrr', label: 'CMRR (dB)', type: 'number' as const, default: d.cmrrDb, min: 0, max: 200, step: 5 },
    { key: 'rout', label: 'Output Resistance (Ω)', type: 'number' as const, default: d.rout, min: 0.001, max: 1e6, step: 5 },
    { key: swingKeys.high, label: 'Output Headroom to V+ (V)', type: 'number' as const, default: d.swingHigh, unit: 'V', min: 0, max: 10, step: 0.05 },
    { key: swingKeys.low, label: 'Output Headroom to V− (V)', type: 'number' as const, default: d.swingLow, unit: 'V', min: 0, max: 10, step: 0.05 },
    { key: 'iLimit', label: 'Short-circuit Current (mA)', type: 'number' as const, default: d.iLimitMa, unit: 'mA', min: 0.01, max: 1e4, step: 1 },
    { key: 'iq', label: 'Quiescent Current (mA)', type: 'number' as const, default: d.iqMa, unit: 'mA', min: 0, max: 1e3, step: 0.1 },
  ];
}

/** Build a spec from datasheet-style params (mV, nA, dB, mA units). */
export function specFromParams(
  p: Record<string, any>,
  fallback: Partial<OpampSpec> & { defVcc: number; defVee: number },
  swingKeys: { high: string; low: string } = { high: 'swingHigh', low: 'swingLow' },
): OpampSpec {
  const num = (k: string, def: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] as number : def);
  return {
    gain: Math.max(1, num('gain', fallback.gain ?? 1e5)),
    gbw: p.gbw === undefined ? (fallback.gbw ?? Infinity) : Math.max(1, num('gbw', 1e6)),
    slewRate: p.slewRate === undefined ? (fallback.slewRate ?? Infinity) : Math.max(1e-6, num('slewRate', 1)),
    voff: p.voff === undefined ? (fallback.voff ?? 0) : num('voff', 0) / 1000,
    ibias: p.ibias === undefined ? (fallback.ibias ?? 0) : num('ibias', 0) * 1e-9,
    cmrr: p.cmrr === undefined ? (fallback.cmrr ?? Infinity) : num('cmrr', 90),
    rout: Math.max(1e-3, num('rout', fallback.rout ?? 75)),
    swingHigh: Math.max(0, num(swingKeys.high, fallback.swingHigh ?? 0.5)),
    swingLow: Math.max(0, num(swingKeys.low, fallback.swingLow ?? fallback.swingHigh ?? 0.5)),
    iLimit: p.iLimit === undefined ? (fallback.iLimit ?? Infinity) : Math.max(1e-6, num('iLimit', 25) / 1000),
    iq: p.iq === undefined ? (fallback.iq ?? 0) : Math.max(0, num('iq', 0) / 1000),
    defVcc: fallback.defVcc,
    defVee: fallback.defVee,
  };
}

/** Voltage of a node id, including extra-row-backed pseudo-nodes. */
function nodeV(sim: SimContext, n: number): number {
  if (n <= 0) return 0;
  if (n < sim.nodeVoltage.length) return sim.nodeVoltage[n];
  return sim.branchCurrent[n - sim.nodeVoltage.length] ?? 0;
}

function rails(spec: OpampSpec, pins: OpampPins, sim: SimContext) {
  // Unwired supply pins map to node 0. Both at node 0 → part defaults; a
  // single grounded rail is honored (single-supply operation).
  const both = pins.vcc === 0 && pins.vee === 0;
  const vccV = both ? spec.defVcc : nodeV(sim, pins.vcc);
  const veeV = both ? spec.defVee : nodeV(sim, pins.vee);
  let hi = vccV - spec.swingHigh;
  let lo = veeV + spec.swingLow;
  if (hi < lo) hi = lo = (hi + lo) / 2;
  return { hi, lo };
}

function poleCoeffs(spec: OpampSpec, dt: number) {
  if (!Number.isFinite(spec.gbw)) return { alpha: 1, beta: 0, tau: 0 };
  const tau = spec.gain / (2 * Math.PI * spec.gbw);
  const r = dt / tau;
  return { alpha: r / (1 + r), beta: 1 / (1 + r), tau };
}

export interface OpampStampResult {
  mode: 'linear' | 'rail+' | 'rail-' | 'slew' | 'ilimit';
}

/**
 * Stamp one op-amp. `key` identifies its persistent state (previous gain-
 * stage output, for the dominant pole and slew limit).
 */
export function stampOpamp(spec: OpampSpec, pins: OpampPins, sys: MnaSystem, sim: SimContext, key: string): OpampStampResult {
  const { inp, inn, out, vcc, vee } = pins;
  const st = sim.state.__global ?? (sim.state.__global = {});
  // ── input stage ─────────────────────────────────────────────────────────
  if (spec.ibias !== 0) {
    if (inp > 0) sys.stampCurrentSource(inp, 0, spec.ibias);
    if (inn > 0) sys.stampCurrentSource(inn, 0, spec.ibias);
  }
  sys.stampConductance(inp, 0, 1e-9);
  sys.stampConductance(inn, 0, 1e-9);
  // ── supply ──────────────────────────────────────────────────────────────
  if (spec.iq > 0 && vcc !== vee && (vcc !== 0 || vee !== 0)) sys.stampCurrentSource(vcc, vee, spec.iq);

  // ── gain stage at the current Newton iterate ────────────────────────────
  const vp = nodeV(sim, inp);
  const vn = nodeV(sim, inn);
  const vd = vp - vn;
  const vcm = (vp + vn) / 2;
  const cmErr = Number.isFinite(spec.cmrr) ? vcm / Math.pow(10, spec.cmrr / 20) : 0;
  const { alpha, beta } = poleCoeffs(spec, sim.dt);
  const xPrev = st[key + '_x'] as number | undefined;
  const xp = xPrev ?? 0;
  const k = alpha * spec.gain;
  const c = (xPrev === undefined ? 0 : beta * xp) + k * (spec.voff + cmErr);
  const mem = sim.newtonMemory;
  const RAIL_KNEE = 0.02;
  // slew limit on the step increment (skipped when the window is huge, e.g.
  // the DC operating point's 1e6 s step)
  const { hi, lo } = rails(spec, pins, sim);
  let u = k * vd + c;
  let us = u;
  let dSlew = 1;
  let slewing = false;
  if (Number.isFinite(spec.slewRate) && xPrev !== undefined) {
    const S = spec.slewRate * 1e6 * sim.dt;
    if (S < 1e3) {
      const d = limitAcross(u - xp, -S, S, 0.1 * S, mem, key + '_ld');
      u = xp + d;
      const r = softClamp(d, -S, S, 0.1 * S);
      us = xp + r.y;
      dSlew = r.dy;
      slewing = r.dy < 0.5;
    }
  }
  if (xPrev === undefined && mem && !mem[key + '_cold'] && hi - lo > 0.1) {
    // Cold start (no gain-stage history): initial guess = positive rail, like
    // SPICE's initial junction guess — applied on the first Newton round
    // whose rails are established (on round 0 of a cold start the supply
    // nodes still read 0 V). Negative-feedback circuits leave it in a couple
    // of rounds; regenerative ones (Schmitt triggers, astable oscillators)
    // start on a STABLE rail instead of their metastable all-zero
    // equilibrium, which real hardware escapes by noise.
    mem[key + '_cold'] = 1;
    const usl = hi + 1;
    u += usl - us;
    us = usl;
    mem[key + '_lu'] = us;
    mem.__limited = (mem.__limited ?? 0) + 1;
  } else if (!slewing) {
    // rail window limiting (in the post-slew variable)
    const usl = limitAcross(us, lo, hi, RAIL_KNEE, mem, key + '_lu');
    if (usl !== us) { u += usl - us; us = usl; }
  }
  const rc = softClamp(us, lo, hi, RAIL_KNEE);
  const x0 = rc.y;
  const g = rc.dy * dSlew; // dVint/du
  // Linearized about the (possibly limited) point u: the effective input
  // difference there is vdLin = (u − c)/k.
  const vdLin = (u - c) / k;
  // Linearized: Vint = g·k·(V+ − V−) + (x0 − g·k·vdLin)
  const internal = sys.addExtra() + 1; // pseudo-node id (extra index + 1)
  const vcvsIdx = sys.stampVCVS(internal, 0, inp, inn, g * k);
  sys.z[vcvsIdx] += x0 - g * k * vdLin;
  st[key + '_int'] = internal;

  // ── output stage: Rout with soft current limit ─────────────────────────
  let mode: OpampStampResult['mode'] = slewing ? 'slew' : rc.dy < 0.5 ? (x0 > (hi + lo) / 2 ? 'rail+' : 'rail-') : 'linear';
  if (out === 0) return { mode }; // output grounded: the stage has nothing to drive
  const vInt = nodeV(sim, internal);
  const vOut = nodeV(sim, out);
  const vdo = vInt - vOut;
  let gOut = 1 / spec.rout;
  let iEq = 0;
  let iOut = vdo / spec.rout;
  if (Number.isFinite(spec.iLimit)) {
    const Il = spec.iLimit;
    const r = softClamp(vdo / spec.rout, -Il, Il, 0.1 * Il);
    iOut = r.y;
    gOut = r.dy / spec.rout;
    iEq = r.y - gOut * vdo;
    if (r.dy < 0.5) mode = 'ilimit';
  }
  sys.stampConductance(internal, out, Math.max(gOut, 1e-12));
  if (iEq !== 0) sys.stampCurrentSource(internal, out, iEq);
  // Route the output current through the rails. The VCVS branch current is
  // −I(out); draw it from V+ while sourcing, return it to V− while sinking.
  if (iOut >= 0) {
    if (vcc !== 0) sys.stampCCCS(vcc, 0, vcvsIdx, -1);
  } else if (vee !== 0) {
    sys.stampCCCS(0, vee, vcvsIdx, 1);
  }
  st[key + '_mode'] = mode;
  return { mode };
}

/** Commit the gain-stage state after the step's final solve. */
export function stepOpamp(sim: SimContext, key: string): void {
  const st = sim.state.__global ?? (sim.state.__global = {});
  const internal = st[key + '_int'] as number | undefined;
  if (internal !== undefined) st[key + '_x'] = nodeV(sim, internal);
}

/** Probe readouts shared by the op-amp parts. */
export function measureOpamp(spec: OpampSpec, pins: OpampPins, sim: SimContext, key: string) {
  const st = sim.state.__global ?? {};
  const vOut = nodeV(sim, pins.out);
  const internal = st[key + '_int'] as number | undefined;
  let iOut = 0;
  if (internal !== undefined && pins.out !== 0) {
    iOut = (nodeV(sim, internal) - vOut) / spec.rout;
    if (Number.isFinite(spec.iLimit)) iOut = Math.max(-spec.iLimit, Math.min(spec.iLimit, iOut));
  }
  return [
    { label: 'V+', value: nodeV(sim, pins.inp).toFixed(4), unit: 'V' },
    { label: 'V−', value: nodeV(sim, pins.inn).toFixed(4), unit: 'V' },
    { label: 'Vout', value: vOut.toFixed(4), unit: 'V' },
    { label: 'Iout', value: (iOut * 1000).toFixed(3), unit: 'mA' },
    { label: 'Mode', value: String(st[key + '_mode'] ?? 'linear'), unit: '' },
  ];
}

/**
 * Small-signal model at the operating point: Vint = A(jω)·[vd + vcm/CMRR],
 * A(jω) = A0·g / (1 + jωτ) where g is the operating point's limiter slope
 * (≈0 when the output sits on a rail), then Rout to the output.
 */
export function acStampOpamp(spec: OpampSpec, pins: OpampPins, sys: ComplexMnaSystem, dcOp: SimContext, omega: number, key: string): void {
  const { inp, inn, out } = pins;
  cStampConductance(sys, inp, 0, { re: 1e-9, im: 0 });
  cStampConductance(sys, inn, 0, { re: 1e-9, im: 0 });
  // limiter slope at the DC point (output on a rail → no small-signal gain)
  const st = dcOp.state.__global ?? {};
  const mode = st[key + '_mode'] as OpampStampResult['mode'] | undefined;
  const g = mode === 'rail+' || mode === 'rail-' ? 1e-6 : 1;
  const tau = Number.isFinite(spec.gbw) ? spec.gain / (2 * Math.PI * spec.gbw) : 0;
  // A = A0·g / (1 + jωτ)
  const den = 1 + (omega * tau) ** 2;
  const A = { re: (spec.gain * g) / den, im: (-spec.gain * g * omega * tau) / den };
  const internalIdx = cAddExtra(sys);
  const internal = internalIdx + 1;
  const row = cStampVCVS(sys, internal, 0, inp, inn, A);
  if (Number.isFinite(spec.cmrr)) {
    // common-mode term: −A/(2·CMRR) on both input columns of the VCVS row
    const f = 1 / (2 * Math.pow(10, spec.cmrr / 20));
    const cm = { re: -A.re * f, im: -A.im * f };
    if (inp > 0) cAddEntry(sys, row, inp - 1, cm);
    if (inn > 0) cAddEntry(sys, row, inn - 1, cm);
  }
  const gOut = mode === 'ilimit' ? 1e-9 : 1 / spec.rout;
  if (out !== 0) cStampConductance(sys, internal, out, { re: gOut, im: 0 });
}
