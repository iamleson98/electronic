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
    const IsT = tempScaleIs(Is, simTemp, 27);
    const vscale = N * Vt;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('dio', comp, a, k);
    // ── Newton-Raphson with CircuitJS1/SPICE voltage limiting ────────────
    // The engine re-stamps this component once per Newton round (nonLinear:
    // true below) with fresh node voltages. vPrev = last round's accepted
    // junction voltage; the raw new estimate is limited along the exponential
    // (limitStep) so the linearized current changes by at most ~e per round —
    // without this, a 0.8 V estimate on Is=1e-14 explodes to e^31 ≈ 3e13 A.
    const vPrev = (st[key + '_vl'] as number | undefined) ?? 0.7;
    const vRaw = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const v = limitStep(vRaw, vPrev, vscale, junctionVCrit(vscale, IsT));
    st[key + '_vl'] = v;
    // SPICE-style escalating gmin: keeps the matrix non-singular and tames
    // stubborn convergence after many Newton rounds (CircuitJS1 Diode.java).
    const gmin = escalateGmin(sim.newtonIter ?? 0);
    // Shockley companion at the (limited) operating point v.
    const { g, iEq } = shockleyCompanion(v, IsT, vscale, gmin);
    // ── Series resistance via a REAL internal node ───────────────────────
    // Rs is in series with the junction; the correct MNA treatment is an
    // internal pseudo-node (like makeLevel1MOS's Rd/Rs). The old code
    // folded Rs into G_total = g/(1+g·Rs) — an approximation that
    // distorts the linearization source when Rs is large.
    let an = a;
    if (Rs > 0) {
      an = sys.addExtra() + 1; // pseudo-node id (extra index + 1)
      sys.stampConductance(an, a, 1 / Rs);
    }
    sys.stampConductance(an, k, g);
    sys.stampCurrentSource(an, k, iEq);
    // ── Charge storage: Cj(v) + diffusion capacitance ────────────────────
    // Cj = Cjo/(1−v/Vj)^M (depletion), Cd = Tt·g (diffusion, transit-time).
    // Linearized at v with the backward-Euler capacitor companion
    // (first-order keeps this robust; the parameters are small so BE's
    // damping is invisible at normal timesteps).
    const Ceq = junctionCapacitance(v, Cjo, Vj, M) + Tt * g;
    if (Ceq > 0) {
      const dt = Math.max(sim.dt, 1e-12);
      const ckey = key + '_cj';
      const vCjPrev = (st[ckey] as number | undefined) ?? v;
      const gc = Ceq / dt;
      // i(a→k) = gc·v + (−gc·vCjPrev) — stamp onto the internal junction
      // node so the series Rs is outside the charge path (physical).
      sys.stampConductance(an, k, gc);
      sys.stampCurrentSource(an, k, -gc * vCjPrev);
      // persist for the next step (BE history — see capacitor plugin);
      // only on the first Newton round so re-stamps don't shift history
      if ((sim.newtonIter ?? 0) === 0) st[ckey] = v;
    }
  },
  step(params, terminals, sim, instance) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    st[stateKey('dio', instance, a, k)] = sim.nodeVoltage[a] - sim.nodeVoltage[k];
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
  measure(params, terminals, sim, comp) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const Is = params.Is as number;
    const N = params.N as number;
    const Vt = thermalVoltage(deviceTemp(sim, comp));
    const i = Is * (Math.exp(Math.min(v / (N * Vt), 30)) - 1);
    return [
      { label: 'V', value: v.toFixed(4), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(4), unit: 'mA' },
      { label: 'P', value: (v * i * 1000).toFixed(4), unit: 'mW' },
    ];
  },
};

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
    stamp(params, terminals, sys, sim, comp) {
      const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
      const Is = params.Is as number;
      const Bf = params.Bf as number;
      const Br = params.Br as number;
      const Vaf = params.Vaf as number;
      const Vt = thermalVoltage(deviceTemp(sim, comp));
      // Get previous voltages
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('bjt', comp, c, b, e);
      // PNP: work in the flipped world — negate the SIGNED stored voltages,
      // and default the cold-start guess to the flipped ON value (−0.7 →
      // +0.7 after negation). The old `?? 0.7` negated to −0.7 → exp(−27) ≈ 0:
      // the very first stamp after power-up modeled the PNP as an open circuit.
      const vBEguess = isNpn ? (st[key + '_vbe'] ?? 0.7) : -(st[key + '_vbe'] ?? -0.7);
      const vCEguess = isNpn ? (st[key + '_vce'] ?? 0.2) : -(st[key + '_vce'] ?? -0.2);
      // Ebers-Moll simplified:
      // Ic = Is * (exp(vBE/Vt) - exp(-vCE/Vt)) * (1 + vCE/Vaf)
      // For active region (vCE > 0, vBE > 0): Ic ≈ Is*exp(vBE/Vt)*(1 + vCE/Vaf)
      //                                          Ib ≈ Is/Bf * exp(vBE/Vt)
      // Conductances:
      //   dIc/dvBE = Is/Vt * exp(vBE/Vt) * (1 + vCE/Vaf) = gm + Ic/Vt
      //   dIc/dvCE = Is*exp(vBE/Vt)/Vaf = gds
      //   dIb/dvBE = Is/(Bf*Vt) * exp(vBE/Vt) = gm/Bf
      const evBE = Math.exp(Math.min(vBEguess / Vt, 30));
      const Ic = Is * evBE * (1 + vCEguess / Vaf);
      const gm = Is * evBE / Vt;
      const gds = Is * evBE / Vaf;
      const gpi = gm / Bf;
      // Linearized model: VCCS c→e controlled by b→e (gm), conductance c-e
      // (gds), conductance b-e (gpi). The LHS stamps are polarity-SYMMETRIC:
      // for both NPN and PNP the through-device current I(c→e) responds to
      // V(b→e) and V(c→e) with positive gm/gds/gpi (the PNP's reversed current
      // direction cancels its reversed junction polarities), so no `sign` is
      // needed on the matrix stamps. Only the RHS offset sources carry the
      // polarity: +IbEq/IcEq (NPN: currents c→e and b→e) vs −… for PNP.
      // stampVCCS(c, e, b, e, gm): current c→e = gm·V(b→e) — sinks gm·Vbe
      // from the collector and returns it at the emitter (correct for NPN;
      // for PNP the negative Vbe makes the current flow e→c, also correct).
      sys.stampVCCS(c, e, b, e, gm);
      // output conductance gds (always positive — a negative conductance is a
      // generator and blew PNP collectors above the rail)
      sys.stampConductance(c, e, gds);
      // input conductance gpi (at b-e junction, always positive)
      sys.stampConductance(b, e, gpi);
      const sign = isNpn ? 1 : -1;
      // current sources for the constant offsets (linearization around guess)
      const IcEq = Ic - gm * vBEguess - gds * vCEguess;
      // Base current at the operating point: Ib = Is/Bf·e^(vBE/Vt) = gm·Vt/Bf.
      // The old expression `gm*vBEguess/Bf − gpi*vBEguess` collapsed to exactly
      // zero because gpi = gm/Bf — leaving the b-e junction a plain resistor
      // through the origin with no exponential base-current offset.
      const IbEq = gpi * (Vt - vBEguess);
      sys.stampCurrentSource(c, e, sign * IcEq);
      sys.stampCurrentSource(b, e, sign * IbEq);
    },
    step(params, terminals, sim, instance) {
      const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('bjt', instance, c, b, e);
      st[key + '_vbe'] = sim.nodeVoltage[b] - sim.nodeVoltage[e];
      st[key + '_vce'] = sim.nodeVoltage[c] - sim.nodeVoltage[e];
    },
    getFlowPath() { return [{ x: 4, y: 1 }, { x: 2, y: 3 }, { x: 4, y: 3 }]; },
    measure(params, terminals, sim, comp) {
      const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
      const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
      const vBE = sim.nodeVoltage[b] - sim.nodeVoltage[e];
      const vCE = sim.nodeVoltage[c] - sim.nodeVoltage[e];
      const Is = params.Is as number;
      const Bf = params.Bf as number;
      const Vaf = params.Vaf as number;
      const Vt = thermalVoltage(deviceTemp(sim, comp));
      // Use |vBE| magnitude — a PNP's vBE is negative in normal operation and
      // exp(negative) → 0 made every PNP read Ic ≈ 0.
      const Ic = Is * Math.exp(Math.min(Math.abs(vBE) / Vt, 30)) * (1 + Math.abs(vCE) / Vaf);
      const Ib = Ic / Bf;
      return [
        { label: 'Vbe', value: vBE.toFixed(4), unit: 'V' },
        { label: 'Vce', value: vCE.toFixed(4), unit: 'V' },
        { label: 'Ic', value: (Ic * 1000).toFixed(4), unit: 'mA' },
        { label: 'Ib', value: (Ib * 1000).toFixed(4), unit: 'mA' },
      ];
    },
  };
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
      { key: 'Kp', label: 'Transconductance Param', type: 'number', default: 0.05, unit: 'A/V²', min: 1e-6, max: 1, step: 1e-3 },
      { key: 'Gamma', label: 'Body Effect Coeff', type: 'number', default: 0.5, unit: 'V^0.5', min: 0, max: 5, step: 0.05 },
      { key: 'Phi', label: 'Surface Potential', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 2, step: 0.05 },
      { key: 'Lambda', label: 'Channel-Length Mod', type: 'number', default: 0.02, unit: '1/V', min: 0, max: 1, step: 0.005 },
      { key: 'W', label: 'Channel Width', type: 'number', default: 100e-6, unit: 'm', min: 1e-9, max: 1e-2, step: 1e-7 },
      { key: 'L', label: 'Channel Length', type: 'number', default: 10e-6, unit: 'm', min: 1e-9, max: 1e-2, step: 1e-7 },
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
      const Vto0 = params.Vto as number;
      const Kp = params.Kp as number;
      const Gamma = params.Gamma as number;
      const Phi = params.Phi as number;
      const Lambda = params.Lambda as number;
      const Rd = params.Rd as number;
      const Rs = params.Rs as number;
      // Get previous voltages
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('mos', comp, d, g, s, b);
      // Work in MAGNITUDES for region classification (NMOS: identity; PMOS:
      // negate the signed stored values). The old code mixed a magnitude
      // vGSguess with the SIGNED (negative) PMOS Vth, so any biased PMOS fell
      // into the sub-threshold branch and exploded to ~1e6 A after the first
      // timestep (the first step only worked by accident of the default).
      const vGSguess = isNmos ? (st[key + '_vgs'] ?? 2) : -(st[key + '_vgs'] ?? -2);
      const vDSguess = isNmos ? (st[key + '_vds'] ?? 1) : -(st[key + '_vds'] ?? -1);
      const vBSguess = isNmos ? (st[key + '_vbs'] ?? 0) : -(st[key + '_vbs'] ?? 0);
      // Threshold magnitude with body effect, SIGNED (flip-world Vbs for the
      // P-channel): Vth = Vto + γ(√(2ΦF − Vbs) − √(2ΦF)) — reverse body bias
      // (Vbs < 0) RAISES Vth. The old Math.abs() mapped reverse bias into the
      // forward-bias formula √(2ΦF − |Vbs|), so Vth DECREASED with reverse
      // body bias (Vsb=2 V, Vto=1, γ=0.5: 0.41 V instead of the required
      // 1.33 V — the device conducted ~4× the true current).
      const vthMag = (isNmos ? Vto0 : -Vto0) + Gamma * (Math.sqrt(Math.max(0, 2 * Phi - vBSguess)) - Math.sqrt(2 * Phi));
      const vov = vGSguess - vthMag;
      // Compute Id
      let Id = 0;
      let gm = 0;
      let gds = 0;
      if (vov > 0) {
        if (vDSguess > vov) {
          // saturation
          Id = 0.5 * Kp * vov * vov * (1 + Lambda * vDSguess);
          gm = Kp * vov;
          gds = 0.5 * Kp * vov * vov * Lambda;
        } else {
          // linear
          Id = Kp * (vov * vDSguess - 0.5 * vDSguess * vDSguess) * (1 + Lambda * vDSguess);
          gm = Kp * vDSguess;
          gds = Kp * (vov - vDSguess) * (1 + Lambda * vDSguess) + Kp * (vov * vDSguess - 0.5 * vDSguess * vDSguess) * Lambda;
        }
      } else {
        // sub-threshold: weak inversion — Id ∝ exp((Vgs-Vth)/(n*Vt))
        // n is sub-threshold slope factor (typical 1.5)
        const Vt_thermal = 0.026; // 26 mV at room temp
        const n = 1.5;
        const expArg = Math.min((vGSguess - vthMag) / (n * Vt_thermal), 30);
        Id = 1e-7 * (Math.exp(expArg) - 1) * (1 + Lambda * vDSguess);
        gm = 1e-7 * Math.exp(expArg) / (n * Vt_thermal);
        gds = 1e-7 * (Math.exp(expArg) - 1) * Lambda;
      }
      // Effective channel terminals. When Rd/Rs > 0 the channel connects to
      // the external terminal through a REAL series conductance via an
      // internal pseudo-node (an extra unknown used as a voltage node). The
      // old code stamped them d→s in PARALLEL with the channel — a leak across
      // the device even when the channel was off.
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
      // stamp VCCS d→s controlled by g→s. Polarity-symmetric Jacobian (see
      // bjtGPNpn note): through-device current I(d→s) responds to V(g→s)
      // with +gm for BOTH N- and P-channel — the P-channel's reversed current
      // direction cancels its reversed gate polarity. A negative gds stamp
      // is a generator (PMOS drain hit −50 V before this fix).
      sys.stampVCCS(dEff, sEff, g, sEff, gm);
      // output conductance (always positive)
      sys.stampConductance(dEff, sEff, gds);
      // current source offset (linearization) — carries the channel polarity
      const sign = isNmos ? 1 : -1;
      const Ieq = Id - gm * vGSguess - gds * vDSguess;
      sys.stampCurrentSource(dEff, sEff, sign * Ieq);
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
    measure(params, terminals, sim) {
      const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
      const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
      const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
      const vGS = sim.nodeVoltage[g] - sim.nodeVoltage[s];
      const vDS = sim.nodeVoltage[d] - sim.nodeVoltage[s];
      return [
        { label: 'Vgs', value: vGS.toFixed(4), unit: 'V' },
        { label: 'Vds', value: vDS.toFixed(4), unit: 'V' },
        { label: 'Vth', value: (params.Vto as number).toFixed(3), unit: 'V' },
      ];
    },
  };
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
