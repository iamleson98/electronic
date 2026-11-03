// Advanced semiconductor models — KiCad/ngspice parity.
//
// These plugins add more accurate semiconductor models that are commonly used
// in ngspice. They use DISTINCT plugin type names so the existing simple
// 'diode', 'npn', 'nmos' etc. plugins continue to work unchanged.
//
// New plugin types:
//   - diodeShockley  — Shockley diode with full Is/N/Rs/Cjo/M/Vj/Tt + temperature
//   - bjtGummelPoon  — Gummel-Poon NPN/PNP (Is/Bf/Br/Vaf/Var)
//   - mosLevel1      — Schichman-Hodges Level-1 NMOS/PMOS (Vto/Kp/Gamma/Phi/Lambda)
//   - jfetN / jfetP  — JFET models
//   - bjtSubVt       — BJT with sub-threshold (extra Gummel-Poon fields)

import type { ComponentPlugin } from '../types';
import { registerPlugin } from '../registry';
import { drawLabel } from './draw';
import { thermalVoltage, tempScaleIs } from '../sim-options';
import { stateKey } from '../state-keys';
import {
  limitStep,
  junctionVCrit,
  shockleyCompanion,
  escalateGmin,
  junctionCapacitance,
} from '../nonlinear';
import type { SimContext, CircuitComponent } from '../types';

/**
 * Effective device temperature in °C: per-component `temp` override wins,
 * else the sim-global temp, else 27. Wires the PropertyPanel Production
 * temp field into every temperature-dependent stamp in this file.
 */
export function deviceTemp(sim: SimContext, comp?: CircuitComponent): number {
  const compTemp = comp?.temp;
  if (typeof compTemp === 'number' && Number.isFinite(compTemp)) return compTemp;
  const simTemp = (sim as unknown as { temp?: number }).temp;
  if (typeof simTemp === 'number' && Number.isFinite(simTemp)) return simTemp;
  return 27;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shockley diode — full model
//   I = Is * (exp(V/(n*Vt)) - 1)
//   Linearized conductance: g = Is/(n*Vt) * exp(V/(n*Vt))
//   Junction capacitance: Cj = Cjo / (1 - V/Vj)^M  (depletion)
//   Diffusion capacitance: Cd = Tt * dI/dV
// ─────────────────────────────────────────────────────────────────────────────

export const diodeShockley: ComponentPlugin = {
  type: 'diodeShockley',
  name: 'Diode (Shockley)',
  category: 'semiconductor',
  description: 'Full Shockley diode with Is/N/Rs/Cjo/M/Vj/Tt and temperature dependence.',
  symbol: 'D',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'passive' },
    { id: 'k', label: 'K', position: { x: 4, y: 1 }, electricalType: 'passive' },
  ],
  parameters: [
    // Defaults give a real silicon Vf: Is=1e-14, N=1.0 ->
    // Vf = N*Vt*ln(1mA/Is) = 25.85mV*ln(1e11) ~= 0.65V (1N4148-class).
    // The old N=1.5 default gave ~0.98V at 1mA — far too high for Si.
    { key: 'Is', label: 'Saturation Current', type: 'number', default: 1e-14, unit: 'A', min: 1e-20, max: 1e-3, step: 1e-15 },
    { key: 'N', label: 'Emission Coeff', type: 'number', default: 1.0, min: 0.1, max: 5, step: 0.1 },
    { key: 'Rs', label: 'Series Resistance', type: 'number', default: 0.5, unit: 'Ω', min: 0, max: 1000, step: 0.1 },
    { key: 'Cjo', label: 'Junction Cap', type: 'number', default: 4e-12, unit: 'F', min: 0, max: 1e-6, step: 1e-13 },
    { key: 'M', label: 'Grading Coeff', type: 'number', default: 0.333, min: 0, max: 2, step: 0.05 },
    { key: 'Vj', label: 'Junction Potential', type: 'number', default: 0.7, unit: 'V', min: 0.01, max: 5, step: 0.05 },
    { key: 'Tt', label: 'Transit Time', type: 'number', default: 4.5e-9, unit: 's', min: 0, max: 1e-3, step: 1e-10 },
    { key: 'Bv', label: 'Breakdown Voltage', type: 'number', default: 100, unit: 'V', min: 1, max: 10000, step: 1 },
  ],
  keywords: ['diode', 'shockley', 'junction', 'rectifier'],
  defaultFootprint: 'D0805',
  datasheet: 'https://en.wikipedia.org/wiki/Diode_modelling',
  nonLinear: true,
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(2 * cellSize - 3, cellSize);
    ctx.moveTo(2 * cellSize + 3, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    ctx.beginPath();
    ctx.moveTo(-10, -10); ctx.lineTo(10, 10);
    ctx.lineTo(10, -10); ctx.closePath();
    ctx.fillStyle = '#cbd5e1';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-10, 10); ctx.lineTo(10, 10);
    ctx.stroke();
    drawLabel(ctx, `Is=${(params.Is as number).toExponential(1)}`, 0, -16);
  },
  stamp(params, terminals, sys, sim, comp) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const Is = params.Is as number;
    const N = params.N as number;
    const Rs = params.Rs as number;
    const Cjo = params.Cjo as number;
    const Vj = params.Vj as number;
    const M = params.M as number;
    const Tt = params.Tt as number;
    // Thermal voltage tracks the device temperature (per-part override,
    // else sim temp) so .temp sweeps move the Shockley curve.
    const simTemp = deviceTemp(sim, comp);
    const Vt = thermalVoltage(simTemp);
    const IsT = tempScaleIs(Is, simTemp, 27, N);
    const vscale = N * Vt;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('dio', comp, a, k);
    // ── Series resistance via a REAL internal node ───────────────────────
    // Rs sits in series with the junction; the junction (exponential and
    // charge storage) lives between the internal node and the cathode.
    let an = a;
    if (Rs > 0) {
      an = sys.addExtra() + 1; // pseudo-node id (extra index + 1)
      sys.stampConductance(an, a, 1 / Rs);
    }
    st[key + '_an'] = an;
    // ── Newton-Raphson with SPICE junction limiting ─────────────────────
    // Linearize at the JUNCTION voltage of the current iterate (internal
    // node − cathode; the old code used the terminal voltage, i.e. it
    // included the I·Rs drop), limited along the exponential against the
    // previous ROUND (sim.newtonMemory — plugin state is rolled back every
    // round) so the linearized current changes by at most ~e per round.
    const mem = sim.newtonMemory;
    const vRaw = nodeV(sim, an) - nodeV(sim, k);
    const vPrev = mem?.[key + '_vl'] ?? (st[key] as number | undefined) ?? 0.7;
    const vcrit = junctionVCrit(vscale, IsT);
    let v = limitStep(vRaw, vPrev, vscale, vcrit);
    // Reverse breakdown (SPICE BV/IBV): I_bv = −IBV·e^(−(v+Bv)/(N·Vt)),
    // limited in the mirrored variable w = −v − Bv.
    const Bv = params.Bv as number;
    const IBV = 1e-3;
    const hasBv = typeof Bv === 'number' && Number.isFinite(Bv) && Bv > 0;
    if (hasBv && v < -Bv + 20 * vscale) {
      const w = limitStep(-v - Bv, -vPrev - Bv, vscale, junctionVCrit(vscale, IBV));
      v = -w - Bv;
    }
    if (mem) {
      mem[key + '_vl'] = v;
      if (Math.abs(v - vRaw) > 1e-9) mem.__limited = (mem.__limited ?? 0) + 1;
    }
    // SPICE-style escalating gmin: keeps the matrix non-singular and tames
    // stubborn convergence after many Newton rounds (CircuitJS1 Diode.java).
    const gmin = escalateGmin(sim.newtonIter ?? 0);
    // Shockley companion at the (limited) operating point v.
    let { g, iEq } = shockleyCompanion(v, IsT, vscale, gmin);
    if (hasBv) {
      const e = Math.exp(Math.min(80, -(v + Bv) / vscale));
      const iB = -IBV * e;
      const gB = (IBV / vscale) * e;
      g += gB;
      iEq += iB - gB * v;
    }
    sys.stampConductance(an, k, g);
    sys.stampCurrentSource(an, k, iEq);
    // ── Charge storage: Cj(v) + diffusion capacitance ────────────────────
    // Cj = Cjo/(1−v/Vj)^M (depletion), Cd = Tt·g (diffusion, transit-time).
    // Linearized at v with the backward-Euler capacitor companion on the
    // internal junction (the series Rs is outside the charge path). The
    // history voltage is the previous step's COMMITTED junction voltage,
    // written by step().
    const Ceq = junctionCapacitance(v, Cjo, Vj, M) + Tt * g;
    if (Ceq > 0) {
      const dt = Math.max(sim.dt, 1e-12);
      const vCjPrev = (st[key + '_cj'] as number | undefined) ?? v;
      const gc = Ceq / dt;
      sys.stampConductance(an, k, gc);
      sys.stampCurrentSource(an, k, -gc * vCjPrev);
    }
  },
  step(params, terminals, sim, instance) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('dio', instance, a, k);
    const an = (st[key + '_an'] as number | undefined) ?? a;
    const vj = nodeV(sim, an) - nodeV(sim, k);
    st[key] = vj;          // committed junction voltage (limiting reference)
    st[key + '_cj'] = vj;  // charge-storage history
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
  measure(params, terminals, sim, comp) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const N = params.N as number;
    const T = deviceTemp(sim, comp);
    const Vt = thermalVoltage(T);
    // Prefer the exact solved current (includes Rs and temperature); else
    // evaluate the same temperature-scaled Shockley law the stamp uses.
    const recorded = comp ? sim.terminalCurrents?.get(`${comp.id}:a`) : undefined;
    const i = recorded ?? tempScaleIs(params.Is as number, T, 27, N) * (Math.exp(Math.min(v / (N * Vt), 30)) - 1);
    return [
      { label: 'V', value: v.toFixed(4), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(4), unit: 'mA' },
      { label: 'P', value: (v * i * 1000).toFixed(4), unit: 'mW' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Basic diode / LED / zener parts on the Shockley core
//   The simple parts expose datasheet-style numbers; they map to a Shockley
//   junction (no charge storage) so the I–V curve is the real exponential:
//     forwardV  junction drop at the datasheet test current (1 mA signal
//               diode / zener, 20 mA LED) — the old piecewise model's drop
//               at that current, so circuits keep their operating point
//     onR / seriesR   bulk series resistance Rs
//     zenerV    breakdown voltage at Izt = 5 mA
//     offR      parallel leakage (diode / zener), as before
// ─────────────────────────────────────────────────────────────────────────────

export const SIMPLE_DIODE_N = 1.8;
const ZENER_IZT = 5e-3;
const SHOCKLEY_IBV = 1e-3; // matches diodeShockley's breakdown IBV

export function simpleDiodeIref(type: string): number {
  return type === 'led' ? 20e-3 : 1e-3;
}

/** diodeShockley parameters for a basic diode-family part. */
export function simpleDiodeModel(type: string, p: Record<string, unknown>): Record<string, number> {
  const num = (k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] as number : d);
  const N = SIMPLE_DIODE_N;
  const vt = thermalVoltage(27);
  const vf = num('forwardV', type === 'led' ? 2.0 : 0.7);
  const Is = simpleDiodeIref(type) / Math.expm1(Math.max(0.05, vf) / (N * vt));
  const Rs = type === 'led' ? Math.max(0.01, num('seriesR', 5)) : Math.max(0.001, num('onR', 1));
  const Bv = type === 'zener' ? Math.max(0.1, num('zenerV', 3.3) - N * vt * Math.log(ZENER_IZT / SHOCKLEY_IBV)) : 0;
  return { Is, N, Rs, Cjo: 0, M: 0.333, Vj: 0.7, Tt: 0, Bv };
}

const leakG = (type: string, p: Record<string, unknown>) =>
  type === 'led' ? 0 : 1 / Math.max(1e3, typeof p.offR === 'number' ? p.offR : 1e7);

export function stampSimpleDiode(type: string, params: Record<string, unknown>, terminals: { terminalId: string; nodeId: number }[], sys: Parameters<NonNullable<ComponentPlugin['stamp']>>[2], sim: SimContext, comp?: CircuitComponent): void {
  diodeShockley.stamp!(simpleDiodeModel(type, params), terminals, sys, sim, comp);
  const g = leakG(type, params);
  if (g > 0) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    sys.stampConductance(a, k, g);
  }
}

export function stepSimpleDiode(type: string, params: Record<string, unknown>, terminals: { terminalId: string; nodeId: number }[], sim: SimContext, comp: CircuitComponent): void {
  diodeShockley.step!(simpleDiodeModel(type, params), terminals, sim, comp);
}

/** Exact element current a→k (A) of a basic diode-family part in `sim`. */
export function simpleDiodeCurrent(comp: CircuitComponent, sim: SimContext, a: number, k: number): number {
  const m = simpleDiodeModel(comp.type, comp.parameters);
  const st = sim.state?.__global ?? {};
  const an = st[stateKey('dio', comp, a, k) + '_an'] as number | undefined;
  const v = nodeV(sim, a) - nodeV(sim, k);
  let i: number;
  if (an !== undefined && an !== a && m.Rs > 0) {
    i = (nodeV(sim, a) - nodeV(sim, an)) / m.Rs; // the Rs branch carries it all
  } else {
    const T = deviceTemp(sim, comp);
    const vs = m.N * thermalVoltage(T);
    i = tempScaleIs(m.Is, T, 27, m.N) * Math.expm1(Math.min(v / vs, 200));
  }
  return i + leakG(comp.type, comp.parameters) * v;
}

/** Small-signal conductance a–k at the operating point in `sim`. */
export function simpleDiodeSmallSignalG(comp: CircuitComponent, sim: Pick<SimContext, 'nodeVoltage' | 'state'>, a: number, k: number): number {
  const m = simpleDiodeModel(comp.type, comp.parameters);
  const T = deviceTemp(sim as SimContext, comp);
  const vs = m.N * thermalVoltage(T);
  const IsT = tempScaleIs(m.Is, T, 27, m.N);
  const st = sim.state?.__global ?? {};
  // the junction voltage step() committed (excludes the Rs drop)
  const vj = (st[stateKey('dio', comp, a, k)] as number | undefined)
    ?? (sim.nodeVoltage[a] ?? 0) - (sim.nodeVoltage[k] ?? 0);
  let gd = (IsT * Math.exp(Math.min(vj / vs, 200))) / vs + 1e-12;
  if (m.Bv > 0) gd += (SHOCKLEY_IBV / vs) * Math.exp(Math.min(80, -(vj + m.Bv) / vs));
  return 1 / (m.Rs + 1 / gd) + leakG(comp.type, comp.parameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gummel-Poon BJT (NPN and PNP)
//   Includes: Is (saturation), Bf (forward beta), Br (reverse beta),
//             Vaf (Forward Early voltage), Var (Reverse Early voltage),
//             Ikf (forward knee current), Ise (B-E leakage)
//   Simplified — uses Ebers-Moll with Early effect
// ─────────────────────────────────────────────────────────────────────────────

function makeGummelPoonBJT(type: 'npn' | 'pnp'): ComponentPlugin {
  const isNpn = type === 'npn';
  return {
    type: isNpn ? 'bjtGPNpn' : 'bjtGPPnp',
    name: `${isNpn ? 'NPN' : 'PNP'} BJT (Gummel-Poon)`,
    category: 'semiconductor',
    description: `Gummel-Poon ${isNpn ? 'NPN' : 'PNP'} BJT with Is/Bf/Br/Vaf/Var/Early effect.`,
    symbol: isNpn ? 'Qn' : 'Qp',
    boundingBox: { width: 4, height: 4 },
    terminals: [
      { id: 'c', label: 'C', position: { x: 4, y: 1 }, electricalType: 'passive' },
      { id: 'b', label: 'B', position: { x: 0, y: 3 }, electricalType: 'input' },
      { id: 'e', label: 'E', position: { x: 4, y: 3 }, electricalType: 'passive' },
    ],
    parameters: [
      { key: 'Is', label: 'Saturation Current', type: 'number', default: 1e-15, unit: 'A', min: 1e-20, max: 1e-3, step: 1e-16 },
      { key: 'Bf', label: 'Forward Beta', type: 'number', default: 100, min: 1, max: 10000, step: 1 },
      { key: 'Br', label: 'Reverse Beta', type: 'number', default: 1, min: 0.1, max: 100, step: 0.1 },
      { key: 'Vaf', label: 'Forward Early V', type: 'number', default: 100, unit: 'V', min: 1, max: 10000, step: 1 },
      { key: 'Var', label: 'Reverse Early V', type: 'number', default: 50, unit: 'V', min: 1, max: 10000, step: 1 },
      { key: 'Ikf', label: 'Forward Knee I', type: 'number', default: 1, unit: 'A', min: 1e-6, max: 100, step: 0.1 },
    ],
    keywords: ['bjt', 'transistor', isNpn ? 'npn' : 'pnp', 'gummel-poon'],
    nonLinear: true,
    defaultFootprint: 'TO-92',
    render(ctx, params, cellSize) {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
      // base lead
      ctx.beginPath(); ctx.moveTo(0, 3 * cellSize); ctx.lineTo(2 * cellSize, 3 * cellSize); ctx.stroke();
      // base vertical bar
      ctx.beginPath(); ctx.moveTo(2 * cellSize, 2 * cellSize); ctx.lineTo(2 * cellSize, 4 * cellSize); ctx.stroke();
      // collector lead
      ctx.beginPath();
      if (isNpn) {
        ctx.moveTo(2 * cellSize, 2 * cellSize); ctx.lineTo(4 * cellSize, cellSize);
      } else {
        ctx.moveTo(4 * cellSize, cellSize); ctx.lineTo(2 * cellSize, 2 * cellSize);
      }
      ctx.stroke();
      // emitter lead
      ctx.beginPath();
      ctx.moveTo(2 * cellSize, 4 * cellSize); ctx.lineTo(4 * cellSize, 3 * cellSize);
      ctx.stroke();
      // arrow on emitter
      const ax = 3 * cellSize, ay = 3.5 * cellSize;
      ctx.beginPath();
      if (isNpn) {
        ctx.moveTo(ax, ay); ctx.lineTo(ax - 6, ay - 4); ctx.lineTo(ax - 4, ay + 2); ctx.closePath();
      } else {
        ctx.moveTo(ax, ay); ctx.lineTo(ax + 6, ay + 4); ctx.lineTo(ax + 4, ay - 2); ctx.closePath();
      }
      ctx.fillStyle = '#cbd5e1'; ctx.fill();
      drawLabel(ctx, isNpn ? 'NPN' : 'PNP', 2 * cellSize, 0);
    },
      // Gummel-Poon transport model:
    //   If = Is(e^(vbe/Vt) − 1), Ir = Is(e^(vbc/Vt) − 1)
    //   Icc = (If − Ir)/qb  (qb: Early effects Vaf/Var + high injection Ikf)
    //   Ic = Icc − Ir/Br,  Ib = If/Bf + Ir/Br,  Ie = −(Ic + Ib)
    // The previous model had no base–collector junction (Ic = Is·e^(vbe/Vt)
    // ·(1+vce/Vaf)), so a saturated transistor drove its collector far below
    // the emitter, and it linearized around the PREVIOUS TIMESTEP's voltages
    // (written only by step()), so the engine's Newton loop re-stamped the
    // same linearization every round and never converged within a step —
    // a purely resistive bias network drifted away from its DC solution.
    stamp(params, terminals, sys, sim, comp) {
      stampBJT(params, terminals, sys, sim, comp, isNpn);
    },
    step(params, terminals, sim, instance) {
      stepBJT(terminals, sim, instance);
    },
    getFlowPath() { return [{ x: 4, y: 1 }, { x: 2, y: 3 }, { x: 4, y: 3 }]; },
    measure(params, terminals, sim, comp) {
      return measureBJT(params, terminals, sim, comp, isNpn);
    },
  };
}

type Terminals = { terminalId: string; nodeId: number }[];
const pins3 = (terminals: Terminals) => ({
  c: terminals.find((t) => t.terminalId === 'c')!.nodeId,
  b: terminals.find((t) => t.terminalId === 'b')!.nodeId,
  e: terminals.find((t) => t.terminalId === 'e')!.nodeId,
});

/** Newton-linearized Gummel-Poon stamp (shared by the basic NPN/PNP). */
export function stampBJT(
  params: Record<string, unknown>, terminals: Terminals, sys: Parameters<NonNullable<ComponentPlugin['stamp']>>[2],
  sim: SimContext, comp: CircuitComponent | undefined, isNpn: boolean,
): void {
  const { c, b, e } = pins3(terminals);
  const op = gummelPoonOp(params, sim, comp, c, b, e, isNpn, true);
  const { gcbe, gcbc, gbbe, gbbc, ic, ib, vbe, vbc } = op;
  const gmin = escalateGmin(sim.newtonIter ?? 0);
  // Collector current c→e: ic + gcbe·Δvbe + gcbc·Δvbc. The Jacobian is
  // polarity-symmetric (the PNP's flipped currents and voltages cancel);
  // only the constant terms carry the polarity sign.
  sys.stampVCCS(c, e, b, e, gcbe);
  sys.stampVCCS(c, e, b, c, gcbc);
  // Base current b→e: ib + gbbe·Δvbe + gbbc·Δvbc
  sys.stampVCCS(b, e, b, e, gbbe);
  sys.stampVCCS(b, e, b, c, gbbc);
  // junction gmin keeps the matrix regular with both junctions off
  sys.stampConductance(b, e, gmin);
  sys.stampConductance(b, c, gmin);
  const sign = isNpn ? 1 : -1;
  sys.stampCurrentSource(c, e, sign * (ic - gcbe * vbe - gcbc * vbc));
  sys.stampCurrentSource(b, e, sign * (ib - gbbe * vbe - gbbc * vbc));
}

/** Record the committed junction voltages (seed for the next step's Newton). */
export function stepBJT(terminals: Terminals, sim: SimContext, instance: CircuitComponent | undefined): void {
  const { c, b, e } = pins3(terminals);
  const st = sim.state.__global ?? (sim.state.__global = {});
  const key = stateKey('bjt', instance, c, b, e);
  st[key + '_vbe'] = sim.nodeVoltage[b] - sim.nodeVoltage[e];
  st[key + '_vce'] = sim.nodeVoltage[c] - sim.nodeVoltage[e];
}

export function measureBJT(
  params: Record<string, unknown>, terminals: Terminals, sim: SimContext, comp: CircuitComponent | undefined, isNpn: boolean,
) {
  const { c, b, e } = pins3(terminals);
  const vBE = sim.nodeVoltage[b] - sim.nodeVoltage[e];
  const vCE = sim.nodeVoltage[c] - sim.nodeVoltage[e];
  // Same model as the stamp, evaluated (unlimited) at the solution;
  // magnitudes so PNP currents read positive.
  const op = gummelPoonOp(params, sim, comp, c, b, e, isNpn, false);
  return [
    { label: 'Vbe', value: vBE.toFixed(4), unit: 'V' },
    { label: 'Vce', value: vCE.toFixed(4), unit: 'V' },
    { label: 'Ic', value: (Math.abs(op.ic) * 1000).toFixed(4), unit: 'mA' },
    { label: 'Ib', value: (Math.abs(op.ib) * 1000).toFixed(4), unit: 'mA' },
  ];
}

/**
 * Gummel-Poon (Ebers–Moll transport) operating point in the device's
 * "flipped world" (PNP voltages negated so both polarities share one model).
 * With `limit`, the junction voltages are Newton-limited against the
 * previous round's linearization (sim.newtonMemory) and recorded for the
 * next round.
 */
function gummelPoonOp(
  params: Record<string, unknown>, sim: SimContext, comp: CircuitComponent | undefined,
  c: number, b: number, e: number, isNpn: boolean, limit: boolean,
) {
  const Is = params.Is as number;
  const Bf = Math.max(1e-3, params.Bf as number);
  const Br = Math.max(1e-3, params.Br as number);
  const Vaf = Math.max(1e-3, params.Vaf as number);
  const Var = Math.max(1e-3, (params.Var as number) ?? Infinity);
  const Ikf = Math.max(1e-12, (params.Ikf as number) ?? Infinity);
  const T = deviceTemp(sim, comp);
  const Vt = thermalVoltage(T);
  const IsT = tempScaleIs(Is, T, 27);
  const pol = isNpn ? 1 : -1;
  let vbe = pol * (sim.nodeVoltage[b] - sim.nodeVoltage[e]);
  let vbc = pol * (sim.nodeVoltage[b] - sim.nodeVoltage[c]);
  if (limit) {
    const mem = sim.newtonMemory;
    const key = stateKey('bjt', comp, c, b, e);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const vcrit = junctionVCrit(Vt, IsT);
    const cold = mem?.[key + '_lbe'] === undefined && st[key + '_vbe'] === undefined;
    if (cold) {
      // SPICE MODEINITJCT: first-ever linearization at Vbe = Vcrit, Vbc = 0
      // (from all-zero node voltages Newton would start at an off junction
      // and need many limited rounds to reach conduction).
      vbe = vcrit;
      vbc = 0;
    } else {
      // previous linearization: this step's last round, else the last
      // committed step
      const prevVbe = mem?.[key + '_lbe'] ?? pol * st[key + '_vbe'];
      const prevVbc = mem?.[key + '_lbc'] ?? (st[key + '_vce'] !== undefined
        ? pol * (st[key + '_vbe'] - st[key + '_vce']) : vbc);
      const rawBe = vbe;
      const rawBc = vbc;
      vbe = limitStep(vbe, prevVbe, Vt, vcrit);
      vbc = limitStep(vbc, prevVbc, Vt, vcrit);
      if (mem && (Math.abs(vbe - rawBe) > 1e-9 || Math.abs(vbc - rawBc) > 1e-9)) {
        mem.__limited = (mem.__limited ?? 0) + 1;
      }
    }
    if (mem) { mem[key + '_lbe'] = vbe; mem[key + '_lbc'] = vbc; }
  }
  const ebe = Math.exp(Math.min(vbe / Vt, 80));
  const ebc = Math.exp(Math.min(vbc / Vt, 80));
  const If = IsT * (ebe - 1);
  const Ir = IsT * (ebc - 1);
  const gif = IsT * ebe / Vt;
  const gir = IsT * ebc / Vt;
  // Gummel-Poon base charge: qb = q1·(1 + √(1 + 4·q2))/2 with
  //   q1 = 1/(1 − Vbc/Vaf − Vbe/Var)  (forward + reverse Early effect)
  //   q2 = If/Ikf                       (high-level injection knee)
  const den = 1 - vbc / Vaf - vbe / Var;
  const clamped = den < 0.05;
  const q1 = 1 / (clamped ? 0.05 : den);
  const dq1be = clamped ? 0 : (q1 * q1) / Var;
  const dq1bc = clamped ? 0 : (q1 * q1) / Vaf;
  const q2 = Math.max(0, If) / Ikf;
  const dq2be = If > 0 ? gif / Ikf : 0;
  const sq = Math.sqrt(1 + 4 * q2);
  const qb = (q1 * (1 + sq)) / 2;
  const dqbbe = (dq1be * (1 + sq)) / 2 + (q1 * dq2be) / sq;
  const dqbbc = (dq1bc * (1 + sq)) / 2;
  const icc = (If - Ir) / qb;
  const ic = icc - Ir / Br;
  const ib = If / Bf + Ir / Br;
  const gcbe = gif / qb - ((If - Ir) * dqbbe) / (qb * qb);
  const gcbc = -gir / qb - ((If - Ir) * dqbbc) / (qb * qb) - gir / Br;
  const gbbe = gif / Bf;
  const gbbc = gir / Br;
  return { vbe, vbc, ic, ib, gcbe, gcbc, gbbe, gbbc };
}

export const bjtGPNpn = makeGummelPoonBJT('npn');
export const bjtGPPnp = makeGummelPoonBJT('pnp');

// ─────────────────────────────────────────────────────────────────────────────
// Schichman-Hodges Level-1 MOSFET (NMOS and PMOS)
//   Id = Kp/2 * (Vgs-Vth)^2 * (1 + λ*Vds) [saturation]
//   Id = Kp * ((Vgs-Vth)*Vds - Vds^2/2) * (1 + λ*Vds) [linear]
//   Includes body effect: Vth = Vth0 + γ*(sqrt(2ΦF - Vbs) - sqrt(2ΦF))
//   Includes sub-threshold: weak inversion when Vgs < Vth
// ─────────────────────────────────────────────────────────────────────────────

function makeLevel1MOS(type: 'nmos' | 'pmos'): ComponentPlugin {
  const isNmos = type === 'nmos';
  return {
    type: isNmos ? 'mosLevel1N' : 'mosLevel1P',
    name: `${isNmos ? 'NMOS' : 'PMOS'} (Level-1 Schichman-Hodges)`,
    category: 'semiconductor',
    description: 'Full Schichman-Hodges Level-1 MOSFET with Gamma/Phi/Lambda/body effect/sub-threshold.',
    symbol: isNmos ? 'Mn' : 'Mp',
    boundingBox: { width: 4, height: 4 },
    terminals: [
      { id: 'd', label: 'D', position: { x: 4, y: 1 }, electricalType: 'passive' },
      { id: 'g', label: 'G', position: { x: 0, y: 2 }, electricalType: 'input' },
      { id: 's', label: 'S', position: { x: 4, y: 3 }, electricalType: 'passive' },
      { id: 'b', label: 'B', position: { x: 0, y: 4 }, electricalType: 'passive' },
    ],
    parameters: [
      { key: 'Vto', label: 'Threshold Voltage', type: 'number', default: isNmos ? 1.0 : -1.0, unit: 'V', min: -10, max: 10, step: 0.05 },
      // Kp here is the WHOLE-DEVICE transconductance β (SPICE KP·W/L):
      // Id = ½·β·Vov². W and L used to be listed too but were never used.
      { key: 'Kp', label: 'Transconductance β (KP·W/L)', type: 'number', default: 0.05, unit: 'A/V²', min: 1e-6, max: 1, step: 1e-3 },
      { key: 'Gamma', label: 'Body Effect Coeff', type: 'number', default: 0.5, unit: 'V^0.5', min: 0, max: 5, step: 0.05 },
      { key: 'Phi', label: 'Surface Potential', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 2, step: 0.05 },
      { key: 'Lambda', label: 'Channel-Length Mod', type: 'number', default: 0.02, unit: '1/V', min: 0, max: 1, step: 0.005 },
      { key: 'Rd', label: 'Drain Resistance', type: 'number', default: 0, unit: 'Ω', min: 0, max: 1000, step: 0.1 },
      { key: 'Rs', label: 'Source Resistance', type: 'number', default: 0, unit: 'Ω', min: 0, max: 1000, step: 0.1 },
    ],
    keywords: ['mosfet', isNmos ? 'nmos' : 'pmos', 'level1', 'schichman-hodges'],
    nonLinear: true,
    defaultFootprint: 'SOT-23',
    render(ctx, _params, cellSize) {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
      // gate lead
      ctx.beginPath(); ctx.moveTo(0, 2 * cellSize); ctx.lineTo(2 * cellSize, 2 * cellSize); ctx.stroke();
      // gate vertical bar
      ctx.beginPath(); ctx.moveTo(2 * cellSize, cellSize); ctx.lineTo(2 * cellSize, 3 * cellSize); ctx.stroke();
      // drain / source
      ctx.beginPath();
      ctx.moveTo(2 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
      ctx.moveTo(2 * cellSize, 3 * cellSize); ctx.lineTo(4 * cellSize, 3 * cellSize);
      ctx.stroke();
      // arrow on source (NMOS points in, PMOS points out)
      ctx.beginPath();
      const ax = 3 * cellSize, ay = 3 * cellSize;
      if (isNmos) {
        ctx.moveTo(ax, ay); ctx.lineTo(ax - 4, ay - 6); ctx.lineTo(ax + 4, ay - 6); ctx.closePath();
      } else {
        ctx.moveTo(ax, ay - 6); ctx.lineTo(ax - 4, ay); ctx.lineTo(ax + 4, ay); ctx.closePath();
      }
      ctx.fillStyle = '#cbd5e1'; ctx.fill();
      // body terminal
      ctx.beginPath(); ctx.moveTo(2 * cellSize, 3 * cellSize); ctx.lineTo(0, 4 * cellSize); ctx.stroke();
      drawLabel(ctx, isNmos ? 'NMOS' : 'PMOS', 2 * cellSize, 0);
    },
    stamp(params, terminals, sys, sim, comp) {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const Rd = params.Rd as number;
      const Rs = params.Rs as number;
      // Effective channel terminals. When Rd/Rs > 0 the channel connects to
      // the external terminal through a REAL series conductance via an
      // internal pseudo-node (an extra unknown used as a voltage node).
      let dEff = d;
      let sEff = s;
      if (Rd > 0) {
        const di = sys.addExtra() + 1; // pseudo-node id (extra index + 1)
        sys.stampConductance(di, d, 1 / Rd);
        dEff = di;
      }
      if (Rs > 0) {
        const si = sys.addExtra() + 1;
        sys.stampConductance(si, s, 1 / Rs);
        sEff = si;
      }
      // Linearize at the CURRENT Newton iterate (sim.nodeVoltage holds the
      // previous round's solution) — the old code used voltages written by
      // step() once per timestep, so re-stamp rounds never moved and a
      // resistive circuit took several timesteps to reach its DC answer.
      // Newton step limiting (SPICE fetlim on Vgs and Vgd, device frame),
      // against this step's previous round, else the last committed step.
      const pol = isNmos ? 1 : -1;
      const vto = pol * (params.Vto as number);
      const mem = sim.newtonMemory;
      const st = sim.state.__global ?? {};
      const key = stateKey('mos', comp, d, g, s, b);
      const vS = nodeV(sim, sEff);
      const rawGs = pol * (sim.nodeVoltage[g] - vS);
      const rawGd = pol * (sim.nodeVoltage[g] - nodeV(sim, dEff));
      const cGs = st[key + '_vgs'] as number | undefined;
      const cDs = st[key + '_vds'] as number | undefined;
      const oldGs = mem?.[key + '_lgs'] ?? (cGs !== undefined ? pol * cGs : undefined);
      const oldGd = mem?.[key + '_lgd'] ?? (cGs !== undefined && cDs !== undefined ? pol * (cGs - cDs) : undefined);
      const vgs = oldGs !== undefined ? fetlim(rawGs, oldGs, vto) : rawGs;
      const vgd = oldGd !== undefined ? fetlim(rawGd, oldGd, vto) : rawGd;
      if (mem) {
        mem[key + '_lgs'] = vgs;
        mem[key + '_lgd'] = vgd;
        if (Math.abs(vgs - rawGs) > 1e-9 || Math.abs(vgd - rawGd) > 1e-9) mem.__limited = (mem.__limited ?? 0) + 1;
      }
      // linearize at the limited point (node voltages rebuilt around the source)
      const op = level1Op(params, sim, comp, vS + pol * (vgs - vgd), vS + pol * vgs, vS, sim.nodeVoltage[b], isNmos);
      // Reverse mode (Vds < 0 in the device's polarity): the physical source
      // and drain swap roles. The old model fed a negative Vds into the
      // triode formula, which has spurious roots (Vd = −50 V from a 10 V rail).
      const D = op.reversed ? sEff : dEff;
      const S = op.reversed ? dEff : sEff;
      sys.stampVCCS(D, S, g, S, op.gm);
      sys.stampConductance(D, S, op.gds);
      sys.stampVCCS(D, S, b, S, op.gmbs);
      // channel gmin: keeps an off device from leaving its drain floating
      sys.stampConductance(D, S, 1e-12);
      const sign = isNmos ? 1 : -1;
      sys.stampCurrentSource(D, S, sign * (op.id - op.gm * op.vgs - op.gds * op.vds - op.gmbs * op.vbs));
    },
    step(params, terminals, sim, instance) {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('mos', instance, d, g, s, b);
      st[key + '_vgs'] = sim.nodeVoltage[g] - sim.nodeVoltage[s];
      st[key + '_vds'] = sim.nodeVoltage[d] - sim.nodeVoltage[s];
      st[key + '_vbs'] = sim.nodeVoltage[b] - sim.nodeVoltage[s];
    },
    getFlowPath() { return [{ x: 4, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 3 }]; },
    measure(params, terminals, sim, comp) {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const vGS = sim.nodeVoltage[g] - sim.nodeVoltage[s];
      const vDS = sim.nodeVoltage[d] - sim.nodeVoltage[s];
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const op = level1Op(params, sim, comp, sim.nodeVoltage[d], sim.nodeVoltage[g], sim.nodeVoltage[s], sim.nodeVoltage[b], isNmos);
      return [
        { label: 'Vgs', value: vGS.toFixed(4), unit: 'V' },
        { label: 'Vds', value: vDS.toFixed(4), unit: 'V' },
        { label: 'Vth', value: (isNmos ? op.vth : -op.vth).toFixed(3), unit: 'V' },
        { label: 'Id', value: (Math.abs(op.id) * 1000).toFixed(4), unit: 'mA' },
      ];
    },
  };
}

/** Voltage of a node id, including extra-row-backed pseudo-nodes. */
function nodeV(sim: SimContext, n: number): number {
  if (n <= 0) return 0;
  if (n < sim.nodeVoltage.length) return sim.nodeVoltage[n];
  const k = n - sim.nodeVoltage.length; // extra index − (numNodes − 1)
  return sim.branchCurrent[k] ?? 0;
}

/**
 * Schichman-Hodges Level-1 operating point in the flipped world (PMOS
 * voltages negated). Handles reverse mode by swapping source and drain
 * (`reversed`), returning the controlling voltages relative to the
 * effective source plus gm / gds / gmbs for the Newton stamp.
 */
/**
 * SPICE DEVfetlim (ngspice devsup.c): limit a MOSFET's gate-referenced
 * voltage step per Newton round, relative to the threshold `vto` (device
 * polarity frame). Without it a switching node that swings hundreds of volts
 * in one round turns the device fully on, flings the node back, and the
 * iteration cycles (a buck converter's freewheel diode never caught the
 * inductor current).
 */
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = vtsthi / 2 + 2;
  const vtox = vto + 3.5;
  const delv = vnew - vold;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) {
        if (vnew >= vtox) { if (-delv > vtstlo) return vold - vtstlo; }
        else return Math.max(vnew, vto + 2);
      } else if (delv >= vtsthi) return vold + vtsthi;
    } else {
      return delv <= 0 ? Math.max(vnew, vto - 0.5) : Math.min(vnew, vto + 4);
    }
  } else if (delv <= 0) {
    if (-delv > vtsthi) return vold - vtsthi;
  } else {
    const vtemp = vto + 0.5;
    if (vnew <= vtemp) { if (delv > vtstlo) return vold + vtstlo; }
    else return vtemp;
  }
  return vnew;
}

function level1Op(
  params: Record<string, unknown>, sim: SimContext, comp: CircuitComponent | undefined,
  vd: number, vg: number, vs: number, vb: number, isNmos: boolean,
) {
  const Vto0 = params.Vto as number;
  const Kp = params.Kp as number;
  const Gamma = params.Gamma as number;
  const Phi = Math.max(1e-3, params.Phi as number);
  const Lambda = params.Lambda as number;
  const pol = isNmos ? 1 : -1;
  let vds = pol * (vd - vs);
  const reversed = vds < 0;
  // in reverse mode the physical drain acts as the source
  const vsrc = reversed ? vd : vs;
  const vgs = pol * (vg - vsrc);
  const vbs = pol * (vb - vsrc);
  if (reversed) vds = -vds;
  // Body effect: Vth = Vto + γ(√(2ΦF − Vbs) − √(2ΦF)); reverse bias raises Vth
  const sq = Math.sqrt(Math.max(1e-9, 2 * Phi - vbs));
  const vth = pol * Vto0 + Gamma * (sq - Math.sqrt(2 * Phi));
  const dVthdVbs = Gamma > 0 && 2 * Phi - vbs > 1e-9 ? -Gamma / (2 * sq) : 0;
  const vov = vgs - vth;
  let id: number;
  let gm: number;
  let gds: number;
  if (vov > 0) {
    if (vds >= vov) {
      id = 0.5 * Kp * vov * vov * (1 + Lambda * vds);
      gm = Kp * vov * (1 + Lambda * vds);
      gds = 0.5 * Kp * vov * vov * Lambda;
    } else {
      const core = vov * vds - 0.5 * vds * vds;
      id = Kp * core * (1 + Lambda * vds);
      gm = Kp * vds * (1 + Lambda * vds);
      gds = Kp * (vov - vds) * (1 + Lambda * vds) + Kp * core * Lambda;
    }
  } else {
    id = 0;
    gm = 0;
    gds = 0;
  }
  // Weak inversion: I = I0·e^(min(Vov,0)/(n·Vt))·(1 − e^(−Vds/Vt)) — positive,
  // zero at Vds = 0, continuous across threshold. (The old I0·(e^x − 1)
  // went to −100 nA below threshold: an off device conducted backwards.)
  {
    const Vt = thermalVoltage(deviceTemp(sim, comp));
    const nVt = 1.5 * Vt;
    const I0 = 1e-7;
    const ex = Math.exp(Math.max(-80, Math.min(vov, 0) / nVt));
    const ed = Math.exp(-Math.min(vds / Vt, 80));
    const clm = 1 + Lambda * vds;
    const w = I0 * ex * (1 - ed);
    id += w * clm;
    if (vov < 0) gm += (w / nVt) * clm;
    gds += I0 * ex * (ed / Vt) * clm + w * Lambda;
  }
  // dId/dVbs = dId/dVov · (−dVth/dVbs) = gm·(−dVth/dVbs)
  const gmbs = gm * -dVthdVbs;
  return { reversed, vgs, vds, vbs, vth, id, gm, gds, gmbs };
}

export const mosLevel1N = makeLevel1MOS('nmos');
export const mosLevel1P = makeLevel1MOS('pmos');

// ─────────────────────────────────────────────────────────────────────────────
// JFET (N-channel and P-channel)
//   Shockley model:
//   For Vgs > Vp (pinch-off): Id = 0
//   For Vgs < Vp and Vds > Vgs - Vp (saturation): Id = Idss * (1 - Vgs/Vp)^2
//   For Vgs < Vp and Vds < Vgs - Vp (linear): Id = Idss * (2*(1 - Vgs/Vp)*Vds - Vds^2/Vp^2)
// ─────────────────────────────────────────────────────────────────────────────

function makeJFET(type: 'n' | 'p'): ComponentPlugin {
  const isN = type === 'n';
  return {
    type: isN ? 'jfetN' : 'jfetP',
    name: `${isN ? 'N' : 'P'}-channel JFET`,
    category: 'semiconductor',
    description: 'Junction Field-Effect Transistor (Shockley square-law model).',
    symbol: isN ? 'Jn' : 'Jp',
    boundingBox: { width: 4, height: 4 },
    terminals: [
      { id: 'd', label: 'D', position: { x: 4, y: 1 }, electricalType: 'passive' },
      { id: 'g', label: 'G', position: { x: 0, y: 2 }, electricalType: 'input' },
      { id: 's', label: 'S', position: { x: 4, y: 3 }, electricalType: 'passive' },
    ],
    parameters: [
      { key: 'Vp', label: 'Pinch-off Voltage', type: 'number', default: isN ? -2 : 2, unit: 'V', min: -10, max: 10, step: 0.1 },
      { key: 'Idss', label: 'Saturation Current', type: 'number', default: 0.01, unit: 'A', min: 1e-6, max: 1, step: 1e-4 },
    ],
    keywords: ['jfet', isN ? 'n-channel' : 'p-channel'],
    nonLinear: true,
    defaultFootprint: 'TO-92',
    render(ctx, _params, cellSize) {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 2 * cellSize); ctx.lineTo(2 * cellSize, 2 * cellSize);
      ctx.moveTo(2 * cellSize, cellSize); ctx.lineTo(2 * cellSize, 3 * cellSize);
      ctx.moveTo(2 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
      ctx.moveTo(2 * cellSize, 3 * cellSize); ctx.lineTo(4 * cellSize, 3 * cellSize);
      ctx.stroke();
      // arrow on gate (always pointing into the gate for N, out for P)
      const ax = 2 * cellSize, ay = 2 * cellSize;
      ctx.beginPath();
      if (isN) {
        ctx.moveTo(ax - 4, ay); ctx.lineTo(ax - 4, ay + 6); ctx.lineTo(ax, ay); ctx.closePath();
      } else {
        ctx.moveTo(ax, ay); ctx.lineTo(ax - 4, ay - 6); ctx.lineTo(ax - 4, ay); ctx.closePath();
      }
      ctx.fillStyle = '#cbd5e1'; ctx.fill();
      drawLabel(ctx, isN ? 'NJF' : 'PJF', 2 * cellSize, 0);
    },
    stamp(params, terminals, sys, sim, comp) {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const Vp = params.Vp as number;
      const Idss = params.Idss as number;
      // Vp = 0: vov = 1 − vgs/0 → NaN stamps. The device is pinched off at
      // zero gate drive by definition — stamp nothing (open circuit).
      if (Math.abs(Vp) < 1e-9) return;
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('jfet', comp, d, g, s);
      // Flip-world (see makeLevel1MOS): the P-channel negates the SIGNED
      // stored voltages AND the pinch-off voltage, then runs the N-channel
      // Shockley formulas unchanged. The old code negated the voltages but
      // NOT Vp, so vov = 1 + Vgs/Vp GREW with gate drive (a P-JFET that
      // could never turn off), gm/gds came out NEGATIVE — a stamp that
      // GENERATES energy, driving the drain above its own supply rail — and
      // the saturation boundary −vov·Vp flipped sign so every P bias read
      // "saturation".
      const vGSguess = isN ? (st[key + '_vgs'] ?? 0) : -(st[key + '_vgs'] ?? 0);
      const vDSguess = isN ? (st[key + '_vds'] ?? 1) : -(st[key + '_vds'] ?? -1);
      const VpEff = isN ? Vp : -Vp;
      const vov = 1 - vGSguess / VpEff;
      let Id = 0;
      let gm = 0;
      let gds = 0;
      if (vov > 0) {
        if (vDSguess > -vov * VpEff) {
          // saturation: Id = Idss * vov^2
          Id = Idss * vov * vov;
          gm = -2 * Idss * vov / VpEff;
          gds = 0;
        } else {
          // Shockley triode region: Id = Idss·(2·vov·vds/(−Vp) − (vds/(−Vp))²).
          // Both terms below were sign-flipped (Id came out NEGATIVE for an
          // N-JFET, gm was negative → positive feedback) and discontinuous
          // with the saturation branch at the boundary.
          Id = Idss * (-2 * vov * vDSguess / VpEff - vDSguess * vDSguess / (VpEff * VpEff));
          gm = 2 * Idss * vDSguess / (VpEff * VpEff);
          gds = -2 * Idss * (vov / VpEff + vDSguess / (VpEff * VpEff));
        }
      }
      const sign = isN ? 1 : -1;
      // Polarity-symmetric Jacobian (see bjtGPNpn note): +gm/+gds for both
      // N- and P-channel; the polarity lives only in the offset source.
      sys.stampVCCS(d, s, g, s, gm);
      sys.stampConductance(d, s, gds);
      const Ieq = Id - gm * vGSguess - gds * vDSguess;
      sys.stampCurrentSource(d, s, sign * Ieq);
    },
    step(params, terminals, sim, instance) {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('jfet', instance, d, g, s);
      st[key + '_vgs'] = sim.nodeVoltage[g] - sim.nodeVoltage[s];
      st[key + '_vds'] = sim.nodeVoltage[d] - sim.nodeVoltage[s];
    },
    getFlowPath() { return [{ x: 4, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 3 }]; },
  };
}

export const jfetN = makeJFET('n');
export const jfetP = makeJFET('p');

// ─────────────────────────────────────────────────────────────────────────────
// Register everything
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin(diodeShockley);
registerPlugin(bjtGPNpn);
registerPlugin(bjtGPPnp);
registerPlugin(mosLevel1N);
registerPlugin(mosLevel1P);
registerPlugin(jfetN);
registerPlugin(jfetP);
