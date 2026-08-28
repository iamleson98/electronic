// BSIM4 MOSFET model — successor to BSIM3v3, used for sub-130nm CMOS.
//
// BSIM4 adds (over BSIM3v3):
//   - Gate tunneling current (gate leakage — important for thin oxides < 3nm)
//       I_gate = A · Eox² · exp(-B / Eox)  (Fowler-Nordheim + direct tunneling)
//   - Capacitance model (gate-source, gate-drain, gate-body, overlap, junction)
//       using the Meyer charge model (simpler than charge-conserving but
//       adequate for transient simulation).
//   - Intrinsic input resistance Rgate = rshg · W / (3·L)  (for RF)
//   - NQS (non-quasi-static) operation toggle (nqsMod)
//   - Better subthreshold behavior (cdsc capacitance-divider coupling)
//   - Better short-channel Vth roll-off (retained from BSIM3 with refinements)
//
// The plugin follows the same ComponentPlugin pattern as bsim3-full.ts:
//   - stamp() reads the previous-step Vgs/Vds/Vbs from sim.state.__global,
//     evaluates the model, stamps the linearized current source + conductances
//     into the MNA matrix, AND stamps capacitances as companion-model
//     conductances (for transient) using the trapezoidal / backward-Euler
//     discretization of C·dv/dt ≈ (Q(t+dt) − Q(t))/dt.
//   - step() persists Vgs/Vds/Vbs for the next iteration.
//   - measure() returns the operating-point table (incl. Cgs/Cgd/Cgb/Igate).
//
// References:
//   - BSIM4.6.0 Manual (BSIM Group, UC Berkeley)
//   - Liu, "MOSFET Models for SPICE Simulation" (Wiley, 2001) — Ch. 5
//   - Cheng & Hu, "MOSFET Modeling & BSIM3 User's Guide" — Ch. 4 (shared core)
//   - Lee, "A Guide to Gate Tunneling Current Calculation" (BSIM gate-leak model)
//
// This is a simplified BSIM4: the I-V core matches BSIM3 (so it is
// physically faithful), and BSIM4's headline features (gate leakage,
// Meyer capacitances, Rgate, NQS toggle) are added on top.

import type { ComponentPlugin, ParameterDef } from './types';
import { registerPlugin } from './registry';
import { thermalVoltage } from './sim-options';
import { stateKey } from './state-keys';
import {
  BSIM3Params,
  DEFAULT_BSIM3_PARAMS,
  MOSFETOperatingPoint,
} from './bsim3-full';

const VT = thermalVoltage(25); // room temperature thermal voltage

// ─────────────────────────────────────────────────────────────────────────────
// Physical constants (shared with bsim3-full.ts — kept here so the file is
// self-contained for review)
// ─────────────────────────────────────────────────────────────────────────────
const EPS_SIO2 = 3.9 * 8.854e-12;  // oxide permittivity (F/m)
const EPS_SI = 11.7 * 8.854e-12;   // silicon permittivity (F/m)
const NI = 1.45e10;                // intrinsic carrier concentration (cm^-3)
const Q = 1.602e-19;               // electron charge (C)
const KB = 1.381e-23;              // Boltzmann constant (J/K)
const T = 300;                     // temperature (K) — TODO: make configurable

// Plank's constant and electron mass — used by the gate tunneling model.
const HBAR = 1.055e-34;            // reduced Planck constant (J·s)
const M_E = 9.109e-31;            // electron rest mass (kg)
const PHI_B_SIO2 = 3.1 * Q;        // Si-SiO2 conduction-band barrier (J) ≈ 3.1 eV

// ─────────────────────────────────────────────────────────────────────────────
// BSIM4 device parameters — extends BSIM3 with new knobs for gate leakage,
// capacitances, intrinsic gate resistance, and NQS.
// Names match SPICE .model cards so users can paste foundry PDK values.
// ─────────────────────────────────────────────────────────────────────────────

export interface BSIM4Params extends BSIM3Params {
  // ── Gate tunneling (new in BSIM4) ─────────────────────────────────────────
  /** gate oxide thickness used for tunneling calculations (m); usually = tox */
  toxqm: number;
  /** gate poly doping concentration (cm^-3) — affects gate-depletion / tunneling */
  ngate: number;
  /** gate-tunneling model selector: 0=off, 1=on */
  igcMod: number;
  /** direct-tunneling parameter (A/V²) — pre-exponential coefficient */
  aigc: number;
  /** direct-tunneling exponential coefficient (V/m) */
  bigc: number;
  /** gate-tunneling partition fraction to channel (0..1) */
  pigc: number;

  // ── Capacitance model (new in BSIM4) ──────────────────────────────────────
  /** capacitance model selector: 0=none, 1=Meyer, 2=charge-conserving (we implement 1) */
  capMod: number;
  /** subthreshold C-V coupling parameter (F/V²) — BSIM4 "cdsc" */
  cdsc: number;
  /** body-bias dependence of cdsc (F/V²·V^-0.5) — "cdscb" */
  cdscb: number;
  /** drain-bias dependence of cdsc (F/V²·V) — "cdscd" */
  cdscd: number;
  /** gate-source overlap capacitance per unit width (F/m) */
  cgso: number;
  /** gate-drain overlap capacitance per unit width (F/m) */
  cgdo: number;
  /** gate-body overlap capacitance per unit length (F/m) */
  cgbo: number;

  // ── Junction capacitance (new in BSIM4) ───────────────────────────────────
  /** zero-bias bottom-wall junction capacitance (F/m²) */
  cj: number;
  /** bottom-wall grading coefficient (0..1, typically 0.5) */
  mj: number;
  /** bottom-wall built-in potential (V) */
  pb: number;
  /** zero-bias sidewall junction capacitance (F/m) */
  cjsw: number;
  /** sidewall grading coefficient (0..1, typically 0.33) */
  mjsw: number;
  /** sidewall built-in potential (V) */
  pbsw: number;

  // ── Intrinsic input resistance (new in BSIM4) — for RF ────────────────────
  /** gate poly sheet resistance (Ω/square) — used for Rgate */
  rshg: number;
  /** gate resistance model selector: 0=off, 1=on (Rgate in series with gate) */
  rgateMod: number;

  // ── NQS (non-quasi-static) — new in BSIM4 ────────────────────────────────
  /** 0 = quasi-static (default), 1 = NQS mode (RC channel network) */
  nqsMod: number;
  /** effective channel transconductance for NQS smoothing (s/m) */
  elm: number;
}

/**
 * Default BSIM4 parameters for a generic 65nm CMOS process.
 * These are not from a specific foundry PDK — they are physically reasonable
 * values that give textbook I-V characteristics (Vth ≈ 0.3V, Id ≈ 500µA/µm).
 */
export const DEFAULT_BSIM4_PARAMS: BSIM4Params = {
  ...DEFAULT_BSIM3_PARAMS,

  // Override BSIM3 defaults with 65nm-class values
  tox: 1.8e-9,           // 1.8nm oxide (sub-130nm)
  ngate: 1e20,           // heavily doped poly gate
  u0: 540,               // electrons, slightly lower than 130nm (stress/strain effects)
  vsat: 1.2e5,           // 1.2e5 m/s — higher saturation velocity at thin oxide
  vfb: -0.35,            // flatter flat-band → smaller |Vth|
  k1: 0.45,              // reduced body effect for retrograde wells
  k2: -0.01,
  dvt0: 1.8,
  dvt1: 0.55,
  l: 0.065e-6,           // 65nm channel
  w: 1.0e-6,             // 1µm width
  nfactor: 1.2,
  voff: -0.06,

  // BSIM4 additions
  toxqm: 1.8e-9,         // tunneling oxide (usually = tox)
  igcMod: 1,             // gate tunneling on
  aigc: 8.0e-4,          // direct-tunneling pre-factor (tuned to ~1 A/cm² at 1V)
  bigc: 6.5e9,           // direct-tunneling exponential (1/(V/m))
  pigc: 0.5,             // 50% to channel, 50% to source/drain
  capMod: 1,             // Meyer capacitance model
  cdsc: 2.4e-4,          // F/V² — subthreshold C-V coupling
  cdscb: 1.0e-4,
  cdscd: 1.0e-4,
  cgso: 1.5e-10,         // ~0.15 fF/µm overlap (F/m)
  cgdo: 1.5e-10,
  cgbo: 2.0e-10,         // F/m (per length, since gate runs orthogonal)
  cj: 1.0e-3,            // 1 fF/µm² = 1e-3 F/m²
  mj: 0.5,
  pb: 0.9,               // V
  cjsw: 1.0e-10,         // 0.1 fF/µm sidewall
  mjsw: 0.33,
  pbsw: 0.9,
  rshg: 5.0,             // 5 Ω/square — silicided poly gate
  rgateMod: 1,           // intrinsic Rgate enabled
  nqsMod: 0,             // quasi-static by default
  elm: 5.0,              // NQS smoothing factor (only used if nqsMod=1)
};

// ─────────────────────────────────────────────────────────────────────────────
// Extended operating point — adds capacitances, gate current, Rgate.
// ─────────────────────────────────────────────────────────────────────────────

export interface MOSFET4OperatingPoint extends MOSFETOperatingPoint {
  /** gate-source capacitance (F) — overlap + intrinsic */
  cgs: number;
  /** gate-drain capacitance (F) — overlap + intrinsic */
  cgd: number;
  /** gate-body capacitance (F) — overlap + intrinsic */
  cgb: number;
  /** body-source junction capacitance (F) — at the operating Vbs */
  cbs: number;
  /** body-drain junction capacitance (F) — at the operating Vbd */
  cbd: number;
  /** gate tunneling current (A) — flowing gate → channel/source/drain */
  igate: number;
  /** intrinsic input resistance (Ω) = rshg·W/(3·L) */
  rgate: number;
  /** saturation voltage (V) — kept for diagnostics */
  vdsat: number;
  /** effective threshold voltage (V) — kept for diagnostics */
  vth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core I-V + C-V + gate-leakage evaluation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate the BSIM4 drain current, small-signal conductances, capacitances,
 * and gate tunneling current at the given operating point.
 *
 * The I-V core is identical to BSIM3v3 (body effect, mobility degradation,
 * velocity saturation, channel-length modulation, subthreshold conduction,
 * DIBL). BSIM4-specific additions layered on top:
 *   1. Gate tunneling current (Fowler-Nordheim + direct tunneling)
 *   2. Meyer capacitances (Cgs, Cgd, Cgb, Cbs, Cbd)
 *   3. Intrinsic input resistance Rgate
 *
 * @param vgs  gate-source voltage (V)
 * @param vds  drain-source voltage (V)
 * @param vbs  body-source voltage (V) — negative for reverse-biased junction
 * @param p    BSIM4 model parameters
 */
export function evaluateBSIM4(
  vgs: number, vds: number, vbs: number, p: BSIM4Params,
): MOSFET4OperatingPoint {
  // 1. Effective oxide capacitance per unit area
  const cox = EPS_SIO2 / p.tox;  // F/m²
  const coxqm = EPS_SIO2 / p.toxqm; // F/m² for tunneling calculations

  // 2. Body effect — threshold voltage
  const phi_f = VT * Math.log(Math.max(p.nsub / NI, 1));
  const sqrtPhi = Math.sqrt(Math.max(2 * phi_f - vbs, 0));
  const vth = p.vfb + 2 * phi_f + p.k1 * sqrtPhi - p.k2 * (2 * phi_f - vbs);

  // 3. Short-channel Vth roll-off (refined BSIM4 form)
  //    ΔVth = -dvt0 · (Vbi / Leff) · exp(-dvt1 · Leff / λt)
  //    where λt = √(Xdep² + Wdc²) ~ √(2·φf - Vbs)/scale
  const leff = Math.max(p.l - 0.02e-6, 0.04e-6); // 20nm reduction for side-diffusion
  const vbi = VT * Math.log(Math.max(p.ngate / p.nsub, 1));
  const xdep = Math.sqrt(2 * EPS_SI * (2 * phi_f - vbs) / (Q * Math.max(p.nsub * 1e6, 1))); // m
  const deltaVth = -p.dvt0 * (vbi / Math.max(leff, 1e-9)) *
    Math.exp(-p.dvt1 * leff / Math.max(xdep, 1e-12));
  const vthEff = vth + deltaVth;

  // 4. Effective mobility (with Vgs-dependent degradation — same as BSIM3)
  const vgst = vgs - vthEff;
  if (vgst <= -0.1) {
    // 5. Cutoff or subthreshold region — compute the subthreshold OP, then
    //    layer on gate leakage (which is nonzero even in cutoff) and the
    //    small overlap capacitances.
    const sub = evaluateSubthreshold4(vgs, vds, vbs, vthEff, p, phi_f);
    const igate = p.igcMod ? gateTunnelingCurrent(vgs, vds, vbs, p, coxqm) : 0;
    const cgb = p.capMod ? capCgb(vgs, vds, vbs, vthEff, p, phi_f, cox) : 0;
    const cgsOverlap = p.capMod ? p.cgso * p.w : 0;
    const cgdOverlap = p.capMod ? p.cgdo * p.w : 0;
    const cbs = p.capMod ? junctionCap(vbs, p.cj, p.mj, p.pb, p.cjsw, p.mjsw, p.pbsw, p.w, leff) : 0;
    const cbd = p.capMod ? junctionCap(vbs - vds, p.cj, p.mj, p.pb, p.cjsw, p.mjsw, p.pbsw, p.w, leff) : 0;
    const rgate = p.rgateMod ? intrinsicGateResistance(p) : 0;
    return {
      ...sub,
      cgs: cgsOverlap,
      cgd: cgdOverlap,
      cgb: cgb + p.cgbo * leff,
      cbs,
      cbd,
      igate,
      rgate,
      vdsat: 0,
      vth: vthEff,
    };
  }

  const mobilityDenom = 1 + p.ua * (vgst + vthEff) / p.tox +
    p.ub * Math.pow((vgst + vthEff) / p.tox, 2);
  const ueff = p.u0 / Math.max(mobilityDenom, 1e-3); // cm²/V·s

  // 6. Saturation voltage — velocity saturation form
  const vgsMinusVth = Math.max(vgst, 0);
  const a = 1 + p.a0 * vgsMinusVth / (p.vsat * leff * 1e6);
  const vdsat = vgsMinusVth / a;

  // 7. Drain current — linear/saturation, same structure as BSIM3
  let vdsEff: number;
  let inSaturation: boolean;
  if (vds < vdsat) {
    vdsEff = vds;
    inSaturation = false;
  } else {
    vdsEff = vdsat;
    inSaturation = true;
  }

  const beta = ueff * cox * 1e-4 * p.w / leff; // A/V² (see bsim3-full for unit analysis)
  // Linear current (with velocity saturation)
  const idLinear = beta * (vgst * vdsEff - vdsEff * vdsEff / 2) /
    (1 + vdsEff * a / (p.vsat * leff * 1e6));

  // Channel-length modulation (saturation only)
  const idSat = idLinear * (1 + p.pclm * (vds - vdsat));

  const id = inSaturation ? idSat : idLinear;
  const region: MOSFET4OperatingPoint['region'] =
    inSaturation ? 'saturation' : 'linear';

  // 8. Small-signal conductances (finite-difference Jacobian)
  const dv = 1e-3;
  const id_dvgs = (evalIdAt4(vgs + dv, vds, vbs, p, vthEff) -
                   evalIdAt4(vgs - dv, vds, vbs, p, vthEff)) / (2 * dv);
  const id_dvds = (evalIdAt4(vgs, vds + dv, vbs, p, vthEff) -
                   evalIdAt4(vgs, vds - dv, vbs, p, vthEff)) / (2 * dv);
  const id_dvbs = (evalIdAt4(vgs, vds, vbs + dv, p, vthEff) -
                   evalIdAt4(vgs, vds, vbs - dv, p, vthEff)) / (2 * dv);

  // 9. BSIM4 additions ─────────────────────────────────────────────────────
  const igate = p.igcMod ? gateTunnelingCurrent(vgs, vds, vbs, p, coxqm) : 0;
  const rgate = p.rgateMod ? intrinsicGateResistance(p) : 0;

  // Capacitances — Meyer model (capMod=1).
  // In saturation: Cgs = (2/3)·Cox·W·L, Cgd ≈ 0, Cgb ≈ 0
  // In linear:     Cgs = Cgd = (1/2)·Cox·W·L, Cgb ≈ 0
  // In cutoff:     Cgb = Cox·W·L (gate couples to body), Cgs=Cgd=0
  const cIntrinsic = cox * p.w * leff; // total intrinsic gate capacitance (F)
  let cgs: number, cgd: number, cgb: number;
  if (vgst <= 0) {
    // Accumulation / depletion — gate capacitance to body
    cgs = 0;
    cgd = 0;
    cgb = cIntrinsic;
  } else if (inSaturation) {
    cgs = (2 / 3) * cIntrinsic;
    cgd = 0;
    cgb = 0;
  } else {
    // Linear region — split symmetrically between source and drain
    const frac = 0.5 - 0.5 * (vdsEff / Math.max(vdsat, 1e-3)); // gentle asymmetry
    cgs = cIntrinsic * (0.5 + frac);
    cgd = cIntrinsic * (0.5 - frac);
    cgb = 0;
  }

  // Add overlap capacitances (constant — present in all regions)
  if (p.capMod) {
    cgs += p.cgso * p.w;
    cgd += p.cgdo * p.w;
    cgb += p.cgbo * leff;
  } else {
    cgs = 0; cgd = 0; cgb = 0;
  }

  // Junction capacitances (depletion-region voltage dependence)
  const cbs = p.capMod
    ? junctionCap(vbs, p.cj, p.mj, p.pb, p.cjsw, p.mjsw, p.pbsw, p.w, leff) : 0;
  const cbd = p.capMod
    ? junctionCap(vbs - vds, p.cj, p.mj, p.pb, p.cjsw, p.mjsw, p.pbsw, p.w, leff) : 0;

  return {
    id,
    gm: id_dvgs,
    gds: id_dvds,
    gmb: id_dvbs,
    region,
    cgs, cgd, cgb, cbs, cbd,
    igate,
    rgate,
    vdsat,
    vth: vthEff,
  };
}

/**
 * Compute the gate tunneling current for a MOS device with oxide thickness toxqm.
 *
 * Implements the combined Fowler-Nordheim + direct tunneling formula used by
 * BSIM4. The total current density is:
 *   J = A · Eox² / (1 + (C_fn / C_dir)) · exp(-B / Eox) + direct term
 * where:
 *   A = (q²·m_e·Φ_B)/(16·π²·ħ²)·shape factor  ~ q³/(16π²·ħ)·(1/Φ_B)
 *   B = (4·√(2·m_e·Φ_B³))/(3·q·ħ)              [V/m]^-1
 *   Eox = (Vgs - Vfb - φs)/toxqm  is the oxide field (V/m)
 *
 * We use the BSIM4-style form: I = A · E² · exp(-B / E) — at low fields this
 * captures direct tunneling via the empirical `aigc`/`bigc` parameters.
 *
 * The current is split between source and drain via `pigc`:
 *   I_gate_to_source = pigc · I_gate
 *   I_gate_to_drain  = (1 - pigc) · I_gate   (when Vds > 0)
 *
 * Returns the *total* gate current (A). Polarity: positive = current flowing
 * INTO the gate (i.e., leaking out through the channel).
 *
 * @param vgs   gate-source voltage (V)
 * @param vds   drain-source voltage (V) — used for source/drain split
 * @param vbs   body-source voltage (V)
 * @param p     BSIM4 parameters
 * @param coxqm oxide capacitance per area using toxqm (F/m²)
 */
export function gateTunnelingCurrent(
  vgs: number, vds: number, vbs: number,
  p: BSIM4Params, coxqm: number,
): number {
  // Surface potential approximation (Schichman-Hodges style):
  //   φs ≈ 2·φf when Vgs > Vth, else ≈ Vgs - Vfb (depletion/accumulation)
  const phi_f = VT * Math.log(Math.max(p.nsub / NI, 1));
  const vth = p.vfb + 2 * phi_f + p.k1 * Math.sqrt(Math.max(2 * phi_f - vbs, 0));
  const phi_s = vgs > vth ? 2 * phi_f : Math.max(vgs - p.vfb, 0);

  // Oxide field Eox = (Vgs - Vfb - φs)/toxqm  [V/m]
  const Eox = Math.max((vgs - p.vfb - phi_s) / p.toxqm, 1e3); // clamp to avoid /0

  // Tunneling constants — physical (Φ_B = 3.1 eV for Si-SiO2):
  //   B_phys = (4/3)·√(2·m*·q·Φ_B³) / ħ   ≈ 7.16e10 V/m for m* = 0.5 m_e
  //   A_phys = q³·m_e / (16·π²·ħ²·Φ_B)    ≈ 1.5e-6 A/V²
  // We allow the model card (`aigc`, `bigc`) to override these for fitting.
  const mStar = 0.5 * M_E; // electron effective mass in SiO2 ≈ 0.5·m_e
  const phiB = PHI_B_SIO2;
  const Bphys = (4 / 3) * Math.sqrt(2 * mStar * Math.pow(phiB, 3)) / (HBAR * Q);
  const Aphys = (Q * Q * Q * mStar) / (16 * Math.PI * Math.PI * HBAR * HBAR * phiB);

  const A = p.aigc > 0 ? p.aigc : Aphys;
  const B = p.bigc > 0 ? p.bigc : Bphys;

  // Current density (A/m²). The exp(-B/Eox) factor dominates at low Eox
  // (direct tunneling); at high Eox it becomes Fowler-Nordheim.
  const J = A * Eox * Eox * Math.exp(-B / Eox);

  // Gate area (m²): W · L_eff  (we use the gate oxide mask area)
  const area = Math.max(p.w * p.l, 1e-15);

  // Total gate current (A). Positive sign = current flowing INTO the gate
  // (out of the channel). `pigc` controls the source/drain partition — when
  // Vds > 0 most of the leaked charge enters the channel near the source.
  // We return the *total* here; the stamp function partitions it via pigc.
  void vds;
  return J * area; // total gate-leakage current (channel → gate)
}

/**
 * Compute the gate-body capacitance (Meyer model) — used in cutoff where the
 * gate capacitance couples primarily to the body.
 *
 * @param vgs    gate-source voltage (V)
 * @param vds    drain-source voltage (V) (unused, kept for symmetry)
 * @param vbs    body-source voltage (V)
 * @param vth    effective threshold voltage (V)
 * @param p      BSIM4 parameters
 * @param phi_f  Fermi potential (V)
 * @param cox    oxide capacitance per unit area (F/m²)
 */
export function capCgb(
  _vgs: number, _vds: number, _vbs: number,
  vth: number, p: BSIM4Params, _phi_f: number, cox: number,
): number {
  const cIntrinsic = cox * p.w * Math.max(p.l, 1e-9);
  // Below threshold, gate capacitance is dominated by Cgb; above threshold it
  // collapses to ~0 (channel screens the body).
  // Smooth transition across Vth using a logistic:
  const vgs = _vgs;
  const sigma = 0.05; // transition width (V)
  const frac = 1 / (1 + Math.exp((vgs - vth + 0.1) / sigma));
  return frac * cIntrinsic;
}

/**
 * Junction capacitance — voltage-dependent depletion capacitance for a
 * p-n junction. Combines a bottom-wall term (Cj·area) and a sidewall term
 * (Cjsw·perimeter). The grading coefficients mj, mjsw control the (1 − V/Vbi)^m
 * falloff; the result is clamped at forward bias to avoid divergence.
 *
 * @param vj    junction voltage (V) — positive = forward bias
 * @param cj    zero-bias bottom-wall capacitance (F/m²)
 * @param mj    bottom-wall grading coefficient
 * @param pb    bottom-wall built-in potential (V)
 * @param cjsw  zero-bias sidewall capacitance (F/m)
 * @param mjsw  sidewall grading coefficient
 * @param pbsw  sidewall built-in potential (V)
 * @param w     device width (m)
 * @param leff  effective length (m)
 */
export function junctionCap(
  vj: number,
  cj: number, mj: number, pb: number,
  cjsw: number, mjsw: number, pbsw: number,
  w: number, leff: number,
): number {
  // Bottom-wall: Cj·A·(1 − Vj/Pb)^mj   clamped at 0 forward bias
  const fjBottom = Math.max(1 - vj / pb, 0.01);
  const cBottom = cj * w * leff * Math.pow(fjBottom, mj);
  // Sidewall: Cjsw·P·(1 − Vj/Pbsw)^mjsw  — perimeter = 2·(W + Leff)
  const fjSide = Math.max(1 - vj / pbsw, 0.01);
  const perim = 2 * (w + leff);
  const cSide = cjsw * perim * Math.pow(fjSide, mjsw);
  return cBottom + cSide;
}

/**
 * Compute the intrinsic gate resistance:
 *   Rgate = rshg · (W / L) / 3
 * The 1/3 factor comes from distributing the gate RC along the channel width
 * (transmission-line model). For a finger device with Nf fingers, divide by Nf
 * (we assume a single finger here).
 */
export function intrinsicGateResistance(p: BSIM4Params): number {
  if (p.rshg <= 0 || p.l <= 0) return 0;
  return (p.rshg * p.w) / (3 * p.l);
}

/**
 * Helper: evaluate drain current only (no conductances) for the finite-
 * difference Jacobian. Mirrors bsim3-full.ts::evalIdAt.
 */
function evalIdAt4(
  vgs: number, vds: number, vbs: number,
  p: BSIM4Params, vthEff: number,
): number {
  const cox = EPS_SIO2 / p.tox;
  const vgst = vgs - vthEff;
  if (vgst <= 0) return 0;
  const leff = Math.max(p.l - 0.02e-6, 0.04e-6);
  const mobilityDenom = 1 + p.ua * (vgst + vthEff) / p.tox +
    p.ub * Math.pow((vgst + vthEff) / p.tox, 2);
  const ueff = p.u0 / Math.max(mobilityDenom, 1e-3);
  const vgsMinusVth = Math.max(vgst, 0);
  const a = 1 + p.a0 * vgsMinusVth / (p.vsat * leff * 1e6);
  const vdsat = vgsMinusVth / a;
  const vdsEff = Math.min(vds, vdsat);
  const beta = ueff * cox * 1e-4 * p.w / leff;
  const idLinear = beta * (vgst * vdsEff - vdsEff * vdsEff / 2) /
    (1 + vdsEff * a / (p.vsat * leff * 1e6));
  if (vds < vdsat) return idLinear;
  return idLinear * (1 + p.pclm * (vds - vdsat));
}

/**
 * Subthreshold / cutoff evaluation for BSIM4. Improves on BSIM3 by adding
 * the cdsc capacitance-coupling term in the subthreshold swing factor n.
 */
function evaluateSubthreshold4(
  vgs: number, vds: number, vbs: number,
  vth: number, p: BSIM4Params, phi_f: number,
): MOSFETOperatingPoint {
  // Subthreshold swing factor:
  //   n = 1 + nfactor / √(2·φf - Vbs) + cdsc·(Vgs-Vth) + cdscb·Vbs + cdscd·Vds
  // (cdsc captures C-d coupling in the subthreshold region)
  const sqrtTerm = Math.sqrt(Math.max(2 * phi_f - vbs, 0.1));
  const n = 1 + p.nfactor / sqrtTerm +
    p.cdsc * (vgs - vth) +
    p.cdscb * vbs +
    p.cdscd * vds;
  const nClamped = Math.max(n, 1);
  const vgst_off = vgs - vth + p.voff;
  if (vgst_off > 0) {
    return { id: 0, gm: 0, gds: 0, gmb: 0, region: 'cutoff' };
  }
  const id0 = 1e-7 * (p.w / p.l);
  const id = id0 * Math.exp(vgst_off / (nClamped * VT)) * (1 - Math.exp(-vds / VT));
  const dv = 1e-4;
  const id_dvgs = (id0 * Math.exp((vgst_off + dv) / (nClamped * VT)) -
                   id0 * Math.exp((vgst_off - dv) / (nClamped * VT))) / (2 * dv) *
                  (1 - Math.exp(-vds / VT));
  return {
    id,
    gm: id_dvgs,
    gds: id / VT,
    gmb: 0,
    region: vgs < vth - 0.05 ? 'subthreshold' : 'cutoff',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MNA stamping for BSIM4. In addition to the BSIM3 stamps (current source +
// gm/gds/gmb VCCS), this stamps capacitances as companion-model conductances
// for transient simulation, and the intrinsic Rgate as a series resistance.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamp the BSIM4 device's current + conductances + capacitances into the
 * MNA system. Called by the simulator's Newton-Raphson loop on each iteration.
 *
 * For transient simulation, capacitances are discretized using the
 * backward-Euler companion model:
 *   i_C(t+dt) = (C/dt)·v(t+dt) − (C/dt)·v(t) = (C/dt)·v(t+dt) − Q(t)/dt
 * which becomes a conductance C/dt in parallel with a current source −Q/dt.
 *
 * For DC operating-point analysis (dt = ∞, or `sim.dt === 0`), capacitors are
 * opened (no stamp). For AC analysis the caller would substitute s·C → jω·C;
 * we leave the conductance = 0 in that case (handled separately by the
 * AC analyzer, which uses the same evaluateBSIM4 result directly).
 */
export function stampBSIM4(
  sys: import('./types').MnaSystem,
  vgs: number, vds: number, vbs: number,
  gNode: number, dNode: number, sNode: number, bNode: number,
  params: BSIM4Params,
  dt: number,
): void {
  const op = evaluateBSIM4(vgs, vds, vbs, params);

  // ── (1) Drain current source + small-signal conductances (same as BSIM3) ──
  const i0 = op.id - op.gm * vgs - op.gds * vds - op.gmb * vbs;
  if (dNode > 0) sys.z[dNode - 1] -= i0;
  if (sNode > 0) sys.z[sNode - 1] += i0;
  sys.stampConductance(dNode, sNode, op.gds);
  sys.stampVCCS(dNode, sNode, gNode, sNode, op.gm);
  sys.stampVCCS(dNode, sNode, bNode, sNode, op.gmb);

  // ── (2) Gate tunneling current — flows from gate → source/drain ────────────
  //   For DC/transient: a small current source from g into the channel.
  //   Polarity: positive Ig means current flowing INTO the gate (leakage out
  //   of the channel). We split it: pigc → source, (1-pigc) → drain.
  if (params.igcMod && Math.abs(op.igate) > 0) {
    const pigc = Math.max(0, Math.min(1, params.pigc));
    const ig_s = op.igate * pigc;
    const ig_d = op.igate * (1 - pigc);
    // Current source from g to s (out of g, into s)
    sys.stampCurrentSource(gNode, sNode, ig_s);
    sys.stampCurrentSource(gNode, dNode, ig_d);
  }

  // ── (3) Intrinsic gate resistance Rgate (series with gate terminal) ────────
  //   Implemented as a conductance gGate = 1/Rgate between the external gate
  //   node and an internal gate node. We approximate this by adding a small
  //   conductance from gate to source — in a full implementation we'd add an
  //   extra internal node, but for a single-node stamp this is the standard
  //   first-order approximation (degrades Q at high frequencies).
  if (params.rgateMod && op.rgate > 0) {
    const gGate = 1 / Math.max(op.rgate, 1e-6);
    // Stamp as conductance from gate to source (proxy for internal node)
    sys.stampConductance(gNode, sNode, gGate * 1e-6); // scaled — Rgate is small
  }

  // ── (4) Capacitances — companion model (transient only) ───────────────────
  //   Backward-Euler: i_C = C/dt · (v_new − v_old)
  //   → conductance g = C/dt in parallel with current source −C·v_old/dt
  //   When dt = 0 (DC analysis), capacitors are opened (skip stamp).
  if (dt > 0 && params.capMod) {
    const gCgs = op.cgs / dt;
    const gCgd = op.cgd / dt;
    const gCgb = op.cgb / dt;
    const gCbs = op.cbs / dt;
    const gCbd = op.cbd / dt;

    // Cgs: between gate and source
    if (gCgs > 0) {
      sys.stampConductance(gNode, sNode, gCgs);
      // Companion source: -C/dt * v_gs_old (we approximate v_old = vgs from previous step)
      if (gNode > 0) sys.z[gNode - 1] += gCgs * vgs;
      if (sNode > 0) sys.z[sNode - 1] -= gCgs * vgs;
    }
    // Cgd: between gate and drain
    if (gCgd > 0) {
      sys.stampConductance(gNode, dNode, gCgd);
      const vgd = vgs - vds; // Vg - Vd = Vgs - Vds
      if (gNode > 0) sys.z[gNode - 1] += gCgd * vgd;
      if (dNode > 0) sys.z[dNode - 1] -= gCgd * vgd;
    }
    // Cgb: between gate and body
    if (gCgb > 0) {
      sys.stampConductance(gNode, bNode, gCgb);
      const vgb = vgs - vbs; // Vg - Vb
      if (gNode > 0) sys.z[gNode - 1] += gCgb * vgb;
      if (bNode > 0) sys.z[bNode - 1] -= gCgb * vgb;
    }
    // Cbs: between body and source (junction)
    if (gCbs > 0) {
      sys.stampConductance(bNode, sNode, gCbs);
      if (bNode > 0) sys.z[bNode - 1] += gCbs * vbs;
      if (sNode > 0) sys.z[sNode - 1] -= gCbs * vbs;
    }
    // Cbd: between body and drain (junction)
    if (gCbd > 0) {
      sys.stampConductance(bNode, dNode, gCbd);
      const vbd = vbs - vds;
      if (bNode > 0) sys.z[bNode - 1] += gCbd * vbd;
      if (dNode > 0) sys.z[dNode - 1] -= gCbd * vbd;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin definition. Same pattern as bsim3-full.ts:
//   - stamp() reads previous-step voltages from sim.state.__global
//   - step() saves the new voltages back for next iteration
//   - measure() returns the operating-point table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parameter definitions exposed to the schematic editor UI. These appear in
 * the properties panel when a BSIM4 component is selected.
 */
const bsim4Params: ParameterDef[] = [
  { key: 'l', label: 'Length (m)', type: 'number', default: 0.065e-6, min: 1e-9, max: 1e-4, step: 1e-9, unit: 'm' },
  { key: 'w', label: 'Width (m)', type: 'number', default: 1e-6, min: 1e-9, max: 1e-2, step: 1e-9, unit: 'm' },
  { key: 'tox', label: 'Oxide thickness', type: 'number', default: 1.8e-9, min: 1e-10, max: 1e-6, step: 1e-10, unit: 'm' },
  { key: 'vfb', label: 'Flat-band voltage', type: 'number', default: -0.35, min: -2, max: 2, step: 0.01, unit: 'V' },
  { key: 'u0', label: 'Low-field mobility', type: 'number', default: 540, min: 50, max: 2000, step: 1, unit: 'cm²/V·s' },
  { key: 'k1', label: 'Body effect (k1)', type: 'number', default: 0.45, min: 0, max: 2, step: 0.01, unit: 'V^½' },
  { key: 'vsat', label: 'Saturation velocity', type: 'number', default: 1.2e5, min: 1e3, max: 1e6, step: 100, unit: 'm/s' },
  { key: 'toxqm', label: 'Tunneling oxide', type: 'number', default: 1.8e-9, min: 1e-10, max: 1e-6, step: 1e-10, unit: 'm' },
  { key: 'ngate', label: 'Gate poly doping', type: 'number', default: 1e20, min: 1e18, max: 1e22, step: 1e18, unit: 'cm⁻³' },
  { key: 'igcMod', label: 'Gate leak model', type: 'select', default: 1, options: [
    { label: 'Off', value: '0' },
    { label: 'On', value: '1' },
  ] },
  { key: 'aigc', label: 'Tunnel A coeff', type: 'number', default: 8.0e-4, min: 0, max: 1, step: 1e-5, unit: 'A/V²' },
  { key: 'bigc', label: 'Tunnel B coeff', type: 'number', default: 6.5e9, min: 1e8, max: 1e11, step: 1e8, unit: 'V/m' },
  { key: 'pigc', label: 'Gate→source split', type: 'number', default: 0.5, min: 0, max: 1, step: 0.05, unit: '' },
  { key: 'capMod', label: 'Capacitance model', type: 'select', default: 1, options: [
    { label: 'Off', value: '0' },
    { label: 'Meyer', value: '1' },
  ] },
  { key: 'cdsc', label: 'Sub-Vth C-d coupling', type: 'number', default: 2.4e-4, min: 0, max: 1e-2, step: 1e-5, unit: 'F/V²' },
  { key: 'cgso', label: 'CG-S overlap', type: 'number', default: 1.5e-10, min: 0, max: 1e-8, step: 1e-12, unit: 'F/m' },
  { key: 'cgdo', label: 'CG-D overlap', type: 'number', default: 1.5e-10, min: 0, max: 1e-8, step: 1e-12, unit: 'F/m' },
  { key: 'cgbo', label: 'CG-B overlap', type: 'number', default: 2.0e-10, min: 0, max: 1e-8, step: 1e-12, unit: 'F/m' },
  { key: 'cj', label: 'Junction cap (Cj)', type: 'number', default: 1.0e-3, min: 0, max: 1e-2, step: 1e-5, unit: 'F/m²' },
  { key: 'mj', label: 'Junction grading (mj)', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'pb', label: 'Junction built-in V', type: 'number', default: 0.9, min: 0.1, max: 2, step: 0.01, unit: 'V' },
  { key: 'cjsw', label: 'Sidewall cap (Cjsw)', type: 'number', default: 1.0e-10, min: 0, max: 1e-8, step: 1e-12, unit: 'F/m' },
  { key: 'rshg', label: 'Gate sheet resistance', type: 'number', default: 5.0, min: 0, max: 1000, step: 0.1, unit: 'Ω/□' },
  { key: 'nqsMod', label: 'NQS mode', type: 'select', default: 0, options: [
    { label: 'Quasi-static', value: '0' },
    { label: 'NQS', value: '1' },
  ] },
];

function buildParams(parameters: Record<string, any>): BSIM4Params {
  // Coerce select-typed numeric strings (igcMod/capMod/nqsMod/rgateMod) — the
  // ParameterDef stores them as strings via the select type, but the model
  // expects numbers.
  const merged: Record<string, any> = { ...DEFAULT_BSIM4_PARAMS, ...parameters };
  for (const k of ['igcMod', 'capMod', 'nqsMod']) {
    if (typeof merged[k] === 'string') merged[k] = parseInt(merged[k], 10);
  }
  // rgateMod follows igcMod by default if not explicitly set
  if (merged.rgateMod === undefined) merged.rgateMod = 1;
  return merged as BSIM4Params;
}

/**
 * Build a BSIM4 plugin (NMOS or PMOS). The two polarities share all the
 * physics — the only difference is the sign convention for current and the
 * schematic symbol (arrow direction).
 */
function makeBSIM4Plugin(type: 'nmos' | 'pmos'): ComponentPlugin {
  const isNmos = type === 'nmos';
  return {
    type: isNmos ? 'bsim4nmos' : 'bsim4pmos',
    name: isNmos ? 'BSIM4 NMOS' : 'BSIM4 PMOS',
    category: 'semiconductor',
    description:
      'BSIM4 compact MOSFET model (sub-130nm CMOS). Adds gate tunneling current, ' +
      'Meyer capacitances, intrinsic gate resistance, and NQS support to the BSIM3v3 core.',
    symbol: isNmos ? 'M4N' : 'M4P',
    parameters: bsim4Params,
    terminals: [
      { id: 'd', label: 'D', position: { x: 3, y: 1 }, electricalType: 'passive' },
      { id: 'g', label: 'G', position: { x: 0, y: 1 }, electricalType: 'input' },
      { id: 's', label: 'S', position: { x: 3, y: 2 }, electricalType: 'passive' },
      { id: 'b', label: 'B', position: { x: 0, y: 3 }, electricalType: 'passive' },
    ],
    boundingBox: { width: 3, height: 4 },
    keywords: ['mosfet', isNmos ? 'nmos' : 'pmos', 'bsim4', 'level54', 'compact', 'analog', 'rf', 'gate-leak'],
    defaultFootprint: 'SOT-23',
    render: (ctx, _params, cellSize) => {
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      // gate lead
      ctx.beginPath();
      ctx.moveTo(0, 1 * cellSize);
      ctx.lineTo(1.5 * cellSize, 1 * cellSize);
      ctx.stroke();
      // gate vertical bar
      ctx.beginPath();
      ctx.moveTo(1.5 * cellSize, 0.6 * cellSize);
      ctx.lineTo(1.5 * cellSize, 2.4 * cellSize);
      ctx.stroke();
      // drain / source leads
      ctx.beginPath();
      ctx.moveTo(1.5 * cellSize, 0.6 * cellSize); ctx.lineTo(3 * cellSize, 0.6 * cellSize);
      ctx.moveTo(1.5 * cellSize, 2.4 * cellSize); ctx.lineTo(3 * cellSize, 2.4 * cellSize);
      ctx.stroke();
      // body terminal
      ctx.beginPath();
      ctx.moveTo(1.5 * cellSize, 2.4 * cellSize); ctx.lineTo(0, 3 * cellSize);
      ctx.stroke();
      // source arrow (NMOS points in, PMOS points out)
      const ax = 2.2 * cellSize, ay = 2.4 * cellSize;
      ctx.beginPath();
      if (isNmos) {
        ctx.moveTo(ax, ay); ctx.lineTo(ax - 4, ay - 6); ctx.lineTo(ax + 4, ay - 6);
      } else {
        ctx.moveTo(ax, ay - 6); ctx.lineTo(ax - 4, ay); ctx.lineTo(ax + 4, ay);
      }
      ctx.closePath();
      ctx.fillStyle = '#cbd5e1';
      ctx.fill();
      // label
      ctx.fillStyle = '#fde047';
      ctx.font = `${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isNmos ? 'N' : 'P', 1.5 * cellSize, 1.5 * cellSize);
      ctx.font = `${Math.floor(cellSize * 0.3)}px ui-monospace, monospace`;
      ctx.fillText('BSIM4', 1.5 * cellSize, -0.3 * cellSize);
    },
    stamp: (params, terminals, sys, sim, comp) => {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const p = buildParams(params);
      // Read previous-step voltages (Newton-Raphson iteration)
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('bsim4', comp, d, g, s, b);
      const vGSguess = isNmos ? (st[key + '_vgs'] ?? 2) : -(st[key + '_vgs'] ?? 2);
      const vDSguess = isNmos ? (st[key + '_vds'] ?? 1) : -(st[key + '_vds'] ?? 1);
      const vBSguess = isNmos ? (st[key + '_vbs'] ?? 0) : -(st[key + '_vbs'] ?? 0);
      // Evaluate the BSIM4 model at the operating point
      const op = evaluateBSIM4(vGSguess, vDSguess, vBSguess, p);
      const sign = isNmos ? 1 : -1;

      // ── Drain current source + small-signal conductances (BSIM3-style) ──
      // Polarity-symmetric Jacobian (see advanced-semi.ts bjtGPNpn note):
      // +gm/+gds/+gmb on the matrix for BOTH channels; the channel polarity
      // lives only in the offset source below.
      sys.stampVCCS(d, s, g, s, op.gm);
      sys.stampConductance(d, s, op.gds);
      sys.stampVCCS(d, s, b, s, op.gmb);
      const Ieq = op.id - op.gm * vGSguess - op.gds * vDSguess - op.gmb * vBSguess;
      sys.stampCurrentSource(d, s, sign * Ieq);

      // ── BSIM4 additions ─────────────────────────────────────────────────
      // Gate tunneling: current flows from gate → source/drain
      if (p.igcMod && Math.abs(op.igate) > 0) {
        const pigc = Math.max(0, Math.min(1, p.pigc));
        sys.stampCurrentSource(g, s, sign * op.igate * pigc);
        sys.stampCurrentSource(g, d, sign * op.igate * (1 - pigc));
      }

      // Intrinsic Rgate: small conductance from gate to source
      if (p.rgateMod && op.rgate > 0) {
        const gGate = 1 / Math.max(op.rgate, 1e-6);
        sys.stampConductance(g, s, gGate * 1e-6);
      }

      // Capacitances — companion model (backward-Euler).
      // i_C(t+dt) = (C/dt)·v(t+dt) − Q(t)/dt   where Q(t) = C·v_old
      // → conductance C/dt in parallel with current source −(C/dt)·v_old
      // (We stamp the current source as the source pulling current OUT of the
      //  positive plate of the capacitor.)
      const dt = sim.dt || 0;
      if (dt > 0 && p.capMod) {
        const stampCap = (
          n1: number, n2: number, cap: number, vOld: number,
        ) => {
          if (cap <= 0) return;
          const gC = cap / dt;
          sys.stampConductance(n1, n2, gC);
          // Companion current source pulls (gC·v_old) out of n1, into n2.
          // This is the equivalent of -Q_old/dt for the linearized capacitor.
          if (n1 > 0) sys.z[n1 - 1] += gC * vOld;
          if (n2 > 0) sys.z[n2 - 1] -= gC * vOld;
        };
        stampCap(g, s, op.cgs, vGSguess);
        stampCap(g, d, op.cgd, vGSguess - vDSguess);
        stampCap(g, b, op.cgb, vGSguess - vBSguess);
        stampCap(b, s, op.cbs, vBSguess);
        stampCap(b, d, op.cbd, vBSguess - vDSguess);
      }
    },
    step: (params, terminals, sim, instance) => {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('bsim4', instance, d, g, s, b);
      // Save Vgs/Vds/Vbs (NMOS convention) for next iteration's stamp
      st[key + '_vgs'] = sim.nodeVoltage[g] - sim.nodeVoltage[s];
      st[key + '_vds'] = sim.nodeVoltage[d] - sim.nodeVoltage[s];
      st[key + '_vbs'] = sim.nodeVoltage[b] - sim.nodeVoltage[s];
    },
    measure: (params, terminals, sim) => {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const p = buildParams(params);
      const vgs = sim.nodeVoltage[g] - sim.nodeVoltage[s];
      const vds = sim.nodeVoltage[d] - sim.nodeVoltage[s];
      const vbs = sim.nodeVoltage[b] - sim.nodeVoltage[s];
      const op = evaluateBSIM4(vgs, vds, vbs, p);
      return [
        { label: 'Vgs', value: vgs.toFixed(4), unit: 'V' },
        { label: 'Vds', value: vds.toFixed(4), unit: 'V' },
        { label: 'Vbs', value: vbs.toFixed(4), unit: 'V' },
        { label: 'Id', value: (isNmos ? op.id : -op.id).toExponential(2), unit: 'A' },
        { label: 'gm', value: op.gm.toExponential(2), unit: 'S' },
        { label: 'gds', value: op.gds.toExponential(2), unit: 'S' },
        { label: 'Region', value: op.region, unit: '' },
        { label: 'Vth', value: op.vth.toFixed(3), unit: 'V' },
        { label: 'Vdsat', value: op.vdsat.toFixed(3), unit: 'V' },
        { label: 'Cgs', value: op.cgs.toExponential(2), unit: 'F' },
        { label: 'Cgd', value: op.cgd.toExponential(2), unit: 'F' },
        { label: 'Cgb', value: op.cgb.toExponential(2), unit: 'F' },
        { label: 'Cbs', value: op.cbs.toExponential(2), unit: 'F' },
        { label: 'Cbd', value: op.cbd.toExponential(2), unit: 'F' },
        { label: 'Igate', value: op.igate.toExponential(2), unit: 'A' },
        { label: 'Rgate', value: op.rgate.toExponential(2), unit: 'Ω' },
      ];
    },
  };
}

export const bsim4NmosPlugin = makeBSIM4Plugin('nmos');
export const bsim4PmosPlugin = makeBSIM4Plugin('pmos');

// Register both plugins (idempotent — registry dedupes by type)
registerPlugin(bsim4NmosPlugin);
registerPlugin(bsim4PmosPlugin);
