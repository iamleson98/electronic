// SPICE-faithful device plugins used by the .cir importer (spice-import.ts).
// ─────────────────────────────────────────────────────────────────────────────
// The basic library parts (diode / npn / vcSwitch / coupledInductor / dcVoltage…)
// expose datasheet-style knobs, not SPICE .model cards. Real boards (vendor
// Gummel-Poon BJT cards, hysteretic S switches, 3-winding K couplings, PULSE /
// SIN / PWL sources carrying an AC magnitude) need the actual SPICE equations,
// so these plugins implement them:
//
//   spiceDiode   D  : IS N RS CJO VJ M FC TT BV (junction + depletion/diffusion charge)
//   spiceBJT     Q  : full Gummel-Poon — IS NF NR BF BR ISE NE ISC NC VAF VAR IKF IKR
//                     RB RC RE (internal nodes) CJE VJE MJE CJC VJC MJC FC TF TR
//   spiceSwitch  S  : voltage-controlled switch with VT / VH hysteresis (ngspice semantics)
//   spiceMutual2/3  : 2 or 3 mutually coupled inductors (K cards), all pairs k_ij·√(Li·Lj)
//   spiceV / spiceI : independent sources with DC + AC mag/phase + SIN/PULSE/PWL/EXP
//
// Reactive branches use the engine's integration method (euler / trap / gear)
// on CHARGE, so the generic AC linearizer (ac-linearize.ts, three-dt fit of the
// euler companion) recovers the exact phasor admittances with no per-part AC code.

import type { ComponentPlugin, SimContext, CircuitComponent } from './types';
import { registerPlugin } from './registry';
import { thermalVoltage, pnjlim, junctionVCrit, shockleyCompanion, DEVICE_GMIN } from './nonlinear';
import { cStampVoltageSource, cStampCurrentSource } from './complex-solver';

// ─────────────────────────────────────────────────────────────────────────────
// Shared numerics
// ─────────────────────────────────────────────────────────────────────────────

type MnaTerminals = { terminalId: string; nodeId: number }[];
/** Terminal → node id (0 when absent). `hint` is the expected slot: the engine passes terminals in plugin order, so it almost always hits (see termNode). */
const term = (t: MnaTerminals, id: string, hint = 0): number => {
  const h = t[hint];
  return h !== undefined && h.terminalId === id ? h.nodeId : (t.find((x) => x.terminalId === id)?.nodeId ?? 0);
};

/** Voltage of a node id, including extra-row-backed pseudo-nodes. */
export function nodeV(sim: SimContext, n: number): number {
  if (n <= 0) return 0;
  if (n < sim.nodeVoltage.length) return sim.nodeVoltage[n];
  return sim.branchCurrent[n - sim.nodeVoltage.length] ?? NaN; // NaN: pseudo-node outside this solve (AC recorder)
}

export function bdf2(h: number, hPrev: number | undefined): { a0: number; a1: number; a2: number } {
  const w = hPrev !== undefined && hPrev > 0 ? h / hPrev : 1;
  return { a0: (1 + 2 * w) / (1 + w), a1: 1 + w, a2: (w * w) / (1 + w) };
}

/** SPICE depletion charge and capacitance (forward-bias linearisation beyond FC·VJ). */
export function depletion(v: number, cj0: number, vj: number, m: number, fc: number): [number, number] {
  if (!(cj0 > 0) || !(vj > 0)) return [0, 0];
  if (v < fc * vj) {
    const a = 1 - v / vj;
    if (Math.abs(1 - m) < 1e-9) return [-cj0 * vj * Math.log(a), cj0 / a];
    return [(cj0 * vj * (1 - Math.pow(a, 1 - m))) / (1 - m), cj0 * Math.pow(a, -m)];
  }
  const f1 = Math.abs(1 - m) < 1e-9 ? -vj * Math.log(1 - fc) : (vj * (1 - Math.pow(1 - fc, 1 - m))) / (1 - m);
  const f2 = Math.pow(1 - fc, 1 + m);
  const f3 = 1 - fc * (1 + m);
  const q = cj0 * (f1 + (1 / f2) * (f3 * (v - fc * vj) + (m / (2 * vj)) * (v * v - fc * fc * vj * vj)));
  const c = (cj0 / f2) * (f3 + (m * v) / vj);
  return [q, c];
}

export interface ChargeHist { q1: number; q2?: number; i1: number; hp?: number; n: number }

/**
 * Companion of one charge branch i = dq/dt linearised at (v0, q0, c0):
 *   i = alpha·q − beta  →  i ≈ g·v + iEq  (g = alpha·c0).
 * Returns null on the very first step (no history yet): the branch is then
 * quasi-static and step() seeds the history.
 */
export function chargeCompanion(sim: SimContext, h: ChargeHist | undefined, v0: number, q0: number, c0: number) {
  if (!h) return null;
  const dt = Math.max(sim.dt, 1e-18);
  const method = sim.method ?? 'euler';
  let alpha: number, beta: number;
  if (method === 'trap' && h.n >= 1) {
    alpha = 2 / dt; beta = (2 * h.q1) / dt + h.i1;
  } else if (method === 'gear' && h.q2 !== undefined) {
    const k = bdf2(dt, h.hp);
    alpha = k.a0 / dt; beta = (k.a1 * h.q1 - k.a2 * h.q2) / dt;
  } else {
    alpha = 1 / dt; beta = h.q1 / dt;
  }
  return { g: alpha * c0, iEq: alpha * (q0 - c0 * v0) - beta, alpha, beta };
}

export function commitCharge(sim: SimContext, st: Record<string, any>, key: string, q: number): void {
  const h = st[key] as ChargeHist | undefined;
  const dt = Math.max(sim.dt, 1e-18);
  let i = 0;
  if (h) {
    const c = chargeCompanion(sim, h, 0, q, 0)!;
    i = c.alpha * q - c.beta;
  }
  st[key] = { q1: q, q2: h?.q1, i1: i, hp: dt, n: (h?.n ?? 0) + 1 } satisfies ChargeHist;
}

/** SPICE device convergence tolerances (RELTOL / ABSTOL) for the current-prediction test. */
const CONV_RELTOL = 1e-3, CONV_ABSTOL = 1e-12;
const memLimited = (sim: SimContext) => { if (sim.newtonMemory) sim.newtonMemory.__limited = (sim.newtonMemory.__limited ?? 0) + 1; };

/** Current temperature in °C. */
const tempOf = (sim: SimContext): number => (typeof sim.temp === 'number' && Number.isFinite(sim.temp) ? sim.temp : 27);

const compKey = (prefix: string, comp: CircuitComponent | undefined, ...nodes: number[]) => `${prefix}_${comp?.id ?? nodes.join('_')}`;

function schematicBox(ctx: CanvasRenderingContext2D, label: string, w: number, h: number, cellSize: number): void {
  ctx.strokeRect(0, 0, w * cellSize, h * cellSize);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, (w * cellSize) / 2, (h * cellSize) / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Diode
// ─────────────────────────────────────────────────────────────────────────────

const num = (p: Record<string, any>, k: string, d: number): number => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);

export const spiceDiode: ComponentPlugin = {
  type: 'spiceDiode',
  name: 'Diode (SPICE .model D)',
  category: 'semiconductor',
  description: 'SPICE level-1 diode: IS N RS CJO VJ M FC TT BV with depletion and diffusion charge.',
  symbol: 'D',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'passive' },
    { id: 'k', label: 'K', position: { x: 4, y: 1 }, electricalType: 'passive' },
  ],
  parameters: [
    { key: 'modelName', label: 'Model', type: 'string', default: '' },
    { key: 'Is', label: 'IS', type: 'number', default: 1e-14, unit: 'A' },
    { key: 'N', label: 'N', type: 'number', default: 1 },
    { key: 'Rs', label: 'RS', type: 'number', default: 0, unit: 'Ω' },
    { key: 'Cjo', label: 'CJO', type: 'number', default: 0, unit: 'F' },
    { key: 'Vj', label: 'VJ', type: 'number', default: 1, unit: 'V' },
    { key: 'M', label: 'M', type: 'number', default: 0.5 },
    { key: 'Fc', label: 'FC', type: 'number', default: 0.5 },
    { key: 'Tt', label: 'TT', type: 'number', default: 0, unit: 's' },
    { key: 'Bv', label: 'BV (0 = none)', type: 'number', default: 0, unit: 'V' },
    { key: 'area', label: 'Area', type: 'number', default: 1 },
  ],
  keywords: ['diode', 'spice', 'model'],
  nonLinear: true,
  pureStamp: true, // stamp() only rewrites idempotent topology keys; Newton memory lives in sim.newtonMemory
  pureStatePrefixes: ['spd_'],
  extraVars: (p) => (num(p, 'Rs', 0) > 0 ? 1 : 0),
  render(ctx, _p, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.6 * cellSize, cellSize);
    ctx.moveTo(2.4 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(1.6 * cellSize, 0.4 * cellSize); ctx.lineTo(1.6 * cellSize, 1.6 * cellSize); ctx.lineTo(2.4 * cellSize, cellSize); ctx.closePath();
    ctx.moveTo(2.4 * cellSize, 0.4 * cellSize); ctx.lineTo(2.4 * cellSize, 1.6 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    const a = term(terminals, 'a', 0);
    const k = term(terminals, 'k', 1);
    const area = num(params, 'area', 1);
    const Is = num(params, 'Is', 1e-14) * area;
    const N = num(params, 'N', 1);
    const Rs = num(params, 'Rs', 0) / area;
    const Cjo = num(params, 'Cjo', 0) * area;
    const Vj = num(params, 'Vj', 1);
    const M = num(params, 'M', 0.5);
    const Fc = num(params, 'Fc', 0.5);
    const Tt = num(params, 'Tt', 0);
    const Bv = num(params, 'Bv', 0);
    const vscale = N * thermalVoltage(tempOf(sim));
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = compKey('spd', comp, a, k);
    let an = a;
    if (Rs > 0) {
      an = sys.addExtra() + 1;
      sys.stampConductance(an, a, 1 / Rs);
    }
    st[key + '_an'] = an;
    const mem = sim.newtonMemory;
    const vPrev = mem?.[key + '_vl'] ?? (st[key] as number | undefined) ?? 0.6;
    let vRaw = nodeV(sim, an) - nodeV(sim, k);
    if (!Number.isFinite(vRaw)) vRaw = (st[key] as number | undefined) ?? vPrev; // linearise at the committed point
    const vcrit = junctionVCrit(vscale, Is);
    let v = pnjlim(vRaw, vPrev, vscale, vcrit);
    if (mem) { mem[key + '_vl'] = v; if (v !== vRaw) memLimited(sim); }
    const gmin = DEVICE_GMIN;
    let { g, iEq, i0 } = shockleyCompanion(v, Is, vscale, gmin);
    if (Bv > 0) {
      const IBV = 1e-3;
      const e = Math.exp(Math.min(80, -(v + Bv) / vscale));
      g += (IBV / vscale) * e; iEq += -IBV * e - (IBV / vscale) * e * v;
    }
    sys.stampConductance(an, k, g);
    sys.stampCurrentSource(an, k, iEq);
    if (Cjo > 0 || Tt > 0) {
      const [qd, cd] = depletion(v, Cjo, Vj, M, Fc);
      const gd = g - gmin;
      const cc = chargeCompanion(sim, st[key + '_q'], v, qd + Tt * i0, cd + Tt * gd);
      if (cc) { sys.stampConductance(an, k, cc.g); sys.stampCurrentSource(an, k, cc.iEq); }
    }
  },
  step(params, terminals, sim, comp) {
    const a = term(terminals, 'a', 0);
    const k = term(terminals, 'k', 1);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = compKey('spd', comp, a, k);
    const an = (st[key + '_an'] as number | undefined) ?? a;
    const v = nodeV(sim, an) - nodeV(sim, k);
    st[key] = v;
    const area = num(params, 'area', 1);
    const Is = num(params, 'Is', 1e-14) * area;
    const vscale = num(params, 'N', 1) * thermalVoltage(tempOf(sim));
    const i0 = Is * (Math.exp(Math.min(v / vscale, 200)) - 1);
    const [qd] = depletion(v, num(params, 'Cjo', 0) * area, num(params, 'Vj', 1), num(params, 'M', 0.5), num(params, 'Fc', 0.5));
    commitCharge(sim, st, key + '_q', qd + num(params, 'Tt', 0) * i0);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// BJT — full SPICE Gummel-Poon
// ─────────────────────────────────────────────────────────────────────────────

export interface BjtModel {
  IS: number; NF: number; NR: number; BF: number; BR: number;
  ISE: number; NE: number; ISC: number; NC: number;
  VAF: number; VAR: number; IKF: number; IKR: number;
  RB: number; RC: number; RE: number;
  CJE: number; VJE: number; MJE: number; CJC: number; VJC: number; MJC: number; FC: number; TF: number; TR: number;
  area: number;
}
const inv = (x: number) => (x > 0 ? 1 / x : 0); // SPICE: 0 means "infinite"

export function bjtModel(p: Record<string, any>): BjtModel {
  const area = num(p, 'area', 1);
  return {
    IS: num(p, 'Is', 1e-16) * area, NF: num(p, 'Nf', 1), NR: num(p, 'Nr', 1),
    BF: Math.max(1e-3, num(p, 'Bf', 100)), BR: Math.max(1e-3, num(p, 'Br', 1)),
    ISE: num(p, 'Ise', 0) * area, NE: num(p, 'Ne', 1.5), ISC: num(p, 'Isc', 0) * area, NC: num(p, 'Nc', 2),
    VAF: inv(num(p, 'Vaf', 0)), VAR: inv(num(p, 'Var', 0)), IKF: inv(num(p, 'Ikf', 0)) / area, IKR: inv(num(p, 'Ikr', 0)) / area,
    RB: num(p, 'Rb', 0) / area, RC: num(p, 'Rc', 0) / area, RE: num(p, 'Re', 0) / area,
    CJE: num(p, 'Cje', 0) * area, VJE: num(p, 'Vje', 0.75), MJE: num(p, 'Mje', 0.33),
    CJC: num(p, 'Cjc', 0) * area, VJC: num(p, 'Vjc', 0.75), MJC: num(p, 'Mjc', 0.33),
    FC: num(p, 'Fc', 0.5), TF: num(p, 'Tf', 0), TR: num(p, 'Tr', 0), area,
  };
}

/** Gummel-Poon operating point in the "flipped" (NPN-like) world. */
export function bjtOp(m: BjtModel, vbe: number, vbc: number, vt: number) {
  const xf = Math.min(vbe / (m.NF * vt), 80), xr = Math.min(vbc / (m.NR * vt), 80);
  const ef = Math.exp(xf), er = Math.exp(xr);
  const If = m.IS * (ef - 1), Ir = m.IS * (er - 1);
  const gif = (m.IS * ef) / (m.NF * vt), gir = (m.IS * er) / (m.NR * vt);
  let Ile = 0, gle = 0, Ilc = 0, glc = 0;
  if (m.ISE > 0) { const e = Math.exp(Math.min(vbe / (m.NE * vt), 80)); Ile = m.ISE * (e - 1); gle = (m.ISE * e) / (m.NE * vt); }
  if (m.ISC > 0) { const e = Math.exp(Math.min(vbc / (m.NC * vt), 80)); Ilc = m.ISC * (e - 1); glc = (m.ISC * e) / (m.NC * vt); }
  const den = 1 - vbc * m.VAF - vbe * m.VAR;
  const clamped = den < 0.05;
  const q1 = 1 / (clamped ? 0.05 : den);
  const dq1be = clamped ? 0 : q1 * q1 * m.VAR;
  const dq1bc = clamped ? 0 : q1 * q1 * m.VAF;
  const q2 = Math.max(0, If) * m.IKF + Math.max(0, Ir) * m.IKR;
  const sq = Math.sqrt(1 + 4 * q2);
  const qb = (q1 * (1 + sq)) / 2;
  const dq2be = If > 0 ? gif * m.IKF : 0, dq2bc = Ir > 0 ? gir * m.IKR : 0;
  const dqbbe = (dq1be * (1 + sq)) / 2 + (q1 / sq) * dq2be;
  const dqbbc = (dq1bc * (1 + sq)) / 2 + (q1 / sq) * dq2bc;
  const icc = (If - Ir) / qb;
  return {
    If, Ir, qb,
    icc, giccBE: gif / qb - (icc / qb) * dqbbe, giccBC: -gir / qb - (icc / qb) * dqbbc,
    ibe: If / m.BF + Ile, gbe: gif / m.BF + gle,
    ibc: Ir / m.BR + Ilc, gbc: gir / m.BR + glc,
    // charge pieces (depletion added by caller)
    qdifBE: (m.TF * If) / qb, cdifBE: m.TF * (gif / qb - (If / (qb * qb)) * dqbbe),
    qdifBC: m.TR * Ir, cdifBC: m.TR * gir,
  };
}

/** Number of internal nodes (RC / RB / RE) a model needs. */
export const bjtExtraCount = (m: Pick<BjtModel, 'RB' | 'RC' | 'RE'>): number => (m.RB > 0 ? 1 : 0) + (m.RC > 0 ? 1 : 0) + (m.RE > 0 ? 1 : 0);

type StampSys = Parameters<NonNullable<ComponentPlugin['stamp']>>[2];

/**
 * Shared Gummel-Poon stamp (used by spiceNpn/spicePnp, bjtGPNpn/Pnp and the
 * simple npn/pnp parts). `m.IS` must already be temperature-scaled and `vt`
 * is the thermal voltage at the device temperature. pol = +1 NPN, −1 PNP.
 */
export function bjtStampCore(
  m: BjtModel, vt: number, pol: 1 | -1, terminals: MnaTerminals, sys: StampSys, sim: SimContext, comp: CircuitComponent | undefined,
): void {
  const c = term(terminals, 'c', 0), b = term(terminals, 'b', 1), e = term(terminals, 'e', 2);
  const st = sim.state.__global ?? (sim.state.__global = {});
  const key = compKey('spq', comp, c, b, e);
  // internal nodes behind RC / RB / RE
  let cx = c, bx = b, ex = e;
  if (m.RC > 0) { cx = sys.addExtra() + 1; sys.stampConductance(c, cx, 1 / m.RC); }
  if (m.RB > 0) { bx = sys.addExtra() + 1; sys.stampConductance(b, bx, 1 / m.RB); }
  if (m.RE > 0) { ex = sys.addExtra() + 1; sys.stampConductance(e, ex, 1 / m.RE); }
  st[key + '_n'] = [cx, bx, ex];
  const mem = sim.newtonMemory;
  let vbe = pol * (nodeV(sim, bx) - nodeV(sim, ex));
  let vbc = pol * (nodeV(sim, bx) - nodeV(sim, cx));
  const vcritE = junctionVCrit(m.NF * vt, m.IS), vcritC = junctionVCrit(m.NR * vt, m.IS);
  const prevBE = mem?.[key + '_lbe'] ?? (st[key + '_vbe'] as number | undefined);
  const prevBC = mem?.[key + '_lbc'] ?? (st[key + '_vbc'] as number | undefined);
  if (!Number.isFinite(vbe) || !Number.isFinite(vbc)) {
    // internal nodes unavailable (AC small-signal recorder): linearise at the committed junction voltages
    vbe = prevBE ?? vcritE; vbc = prevBC ?? 0;
  } else if (prevBE === undefined || prevBC === undefined) {
    vbe = vcritE; vbc = 0; // SPICE MODEINITJCT
  } else {
    const rawE = vbe, rawC = vbc;
    vbe = pnjlim(vbe, prevBE, m.NF * vt, vcritE);
    vbc = pnjlim(vbc, prevBC, m.NR * vt, vcritC);
    if (mem) {
      if (vbe !== rawE || vbc !== rawC) memLimited(sim);
      else {
        // SPICE BJTconvTest: the previous round's linearisation, stepped to the
        // new junction voltages, must predict collector and base currents that
        // barely moved (reltol·|i| + abstol) — not merely small Δv, which for
        // an exponential junction is a 20 % current error at reltol·5 V.
        const lin = (mem as Record<string, any>)[key + '_lin'] as number[] | undefined;
        if (lin) {
          const dE = rawE - lin[0], dC = rawC - lin[1];
          const dic = lin[4] * dE + lin[5] * dC, dib = lin[6] * dE + lin[7] * dC;
          if (Math.abs(dic) > CONV_RELTOL * Math.max(Math.abs(lin[2]), Math.abs(lin[2] + dic)) + CONV_ABSTOL
            || Math.abs(dib) > CONV_RELTOL * Math.max(Math.abs(lin[3]), Math.abs(lin[3] + dib)) + CONV_ABSTOL) memLimited(sim);
        }
      }
    }
  }
  if (mem) { mem[key + '_lbe'] = vbe; mem[key + '_lbc'] = vbc; }
  const op = bjtOp(m, vbe, vbc, vt);
  if (mem) (mem as Record<string, any>)[key + '_lin'] = [vbe, vbc, op.icc - op.ibc, op.ibe + op.ibc, op.giccBE, op.giccBC - op.gbc, op.gbe, op.gbc];
  const gmin = DEVICE_GMIN;
  const tBE = pol * vbe, tBC = pol * vbc; // terminal-side junction voltages at the linearisation point
  // base-emitter and base-collector junction currents
  sys.stampConductance(bx, ex, op.gbe + gmin);
  sys.stampCurrentSource(bx, ex, pol * op.ibe - op.gbe * tBE);
  sys.stampConductance(bx, cx, op.gbc + gmin);
  sys.stampCurrentSource(bx, cx, pol * op.ibc - op.gbc * tBC);
  // transport current c'→e'
  sys.stampVCCS(cx, ex, bx, ex, op.giccBE);
  sys.stampVCCS(cx, ex, bx, cx, op.giccBC);
  sys.stampCurrentSource(cx, ex, pol * op.icc - op.giccBE * tBE - op.giccBC * tBC);
  // charge storage
  if (m.CJE > 0 || m.TF > 0) {
    const [qd, cd] = depletion(vbe, m.CJE, m.VJE, m.MJE, m.FC);
    const cc = chargeCompanion(sim, st[key + '_qbe'], vbe, qd + op.qdifBE, cd + op.cdifBE);
    if (cc) { sys.stampConductance(bx, ex, cc.g); sys.stampCurrentSource(bx, ex, pol * (cc.alpha * (qd + op.qdifBE) - cc.beta) - cc.g * tBE); }
  }
  if (m.CJC > 0 || m.TR > 0) {
    const [qd, cd] = depletion(vbc, m.CJC, m.VJC, m.MJC, m.FC);
    const cc = chargeCompanion(sim, st[key + '_qbc'], vbc, qd + op.qdifBC, cd + op.cdifBC);
    if (cc) { sys.stampConductance(bx, cx, cc.g); sys.stampCurrentSource(bx, cx, pol * (cc.alpha * (qd + op.qdifBC) - cc.beta) - cc.g * tBC); }
  }
}

/** Commit junction voltages and charges at an accepted timestep. */
export function bjtStepCore(
  m: BjtModel, vt: number, pol: 1 | -1, terminals: MnaTerminals, sim: SimContext, comp: CircuitComponent | undefined,
): void {
  const c = term(terminals, 'c', 0), b = term(terminals, 'b', 1), e = term(terminals, 'e', 2);
  const st = sim.state.__global ?? (sim.state.__global = {});
  const key = compKey('spq', comp, c, b, e);
  const [cx, bx, ex] = (st[key + '_n'] as number[] | undefined) ?? [c, b, e];
  const vbe = pol * (nodeV(sim, bx) - nodeV(sim, ex));
  const vbc = pol * (nodeV(sim, bx) - nodeV(sim, cx));
  st[key + '_vbe'] = vbe; st[key + '_vbc'] = vbc;
  const op = bjtOp(m, vbe, vbc, vt);
  commitCharge(sim, st, key + '_qbe', depletion(vbe, m.CJE, m.VJE, m.MJE, m.FC)[0] + op.qdifBE);
  commitCharge(sim, st, key + '_qbc', depletion(vbc, m.CJC, m.VJC, m.MJC, m.FC)[0] + op.qdifBC);
}

/** Internal-junction operating point at the solved voltages (flipped/NPN-like world, signed currents). */
export function bjtMeasureCore(
  m: BjtModel, vt: number, pol: 1 | -1, terminals: MnaTerminals, sim: SimContext, comp: CircuitComponent | undefined,
): { vbe: number; vbc: number; ic: number; ib: number } {
  const c = term(terminals, 'c', 0), b = term(terminals, 'b', 1), e = term(terminals, 'e', 2);
  const st = sim.state.__global ?? {};
  const [cx, bx, ex] = (st[compKey('spq', comp, c, b, e) + '_n'] as number[] | undefined) ?? [c, b, e];
  let vbe = pol * (nodeV(sim, bx) - nodeV(sim, ex)), vbc = pol * (nodeV(sim, bx) - nodeV(sim, cx));
  if (!Number.isFinite(vbe)) vbe = 0;
  if (!Number.isFinite(vbc)) vbc = 0;
  const op = bjtOp(m, vbe, vbc, vt);
  return { vbe, vbc, ic: op.icc - op.ibc, ib: op.ibe + op.ibc };
}

function makeBjt(isNpn: boolean): ComponentPlugin {
  const pol: 1 | -1 = isNpn ? 1 : -1;
  return {
    type: isNpn ? 'spiceNpn' : 'spicePnp',
    name: `${isNpn ? 'NPN' : 'PNP'} (SPICE Gummel-Poon)`,
    category: 'semiconductor',
    description: 'Full SPICE Gummel-Poon BJT: leakage ISE/ISC, Early VAF/VAR, knees IKF/IKR, RB/RC/RE, junction + diffusion charge (CJE CJC TF TR).',
    symbol: isNpn ? 'Qn' : 'Qp',
    boundingBox: { width: 4, height: 4 },
    terminals: [
      { id: 'c', label: 'C', position: { x: 4, y: 1 }, electricalType: 'passive' },
      { id: 'b', label: 'B', position: { x: 0, y: 3 }, electricalType: 'input' },
      { id: 'e', label: 'E', position: { x: 4, y: 3 }, electricalType: 'passive' },
    ],
    parameters: [
      { key: 'modelName', label: 'Model', type: 'string', default: '' },
      ...(['Is:1e-16', 'Nf:1', 'Nr:1', 'Bf:100', 'Br:1', 'Ise:0', 'Ne:1.5', 'Isc:0', 'Nc:2', 'Vaf:0', 'Var:0', 'Ikf:0', 'Ikr:0',
        'Rb:0', 'Rc:0', 'Re:0', 'Cje:0', 'Vje:0.75', 'Mje:0.33', 'Cjc:0', 'Vjc:0.75', 'Mjc:0.33', 'Fc:0.5', 'Tf:0', 'Tr:0', 'area:1'] as const)
        .map((s) => { const [key, d] = s.split(':'); return { key, label: key.toUpperCase(), type: 'number' as const, default: Number(d) }; }),
    ],
    keywords: ['bjt', 'spice', 'gummel-poon', isNpn ? 'npn' : 'pnp'],
    nonLinear: true,
    pureStamp: true, // stamp() only rewrites idempotent topology keys; Newton memory lives in sim.newtonMemory
    pureStatePrefixes: ['spq_'],
    extraVars: (p) => (num(p, 'Rb', 0) > 0 ? 1 : 0) + (num(p, 'Rc', 0) > 0 ? 1 : 0) + (num(p, 'Re', 0) > 0 ? 1 : 0),
    render(ctx, _p, cellSize) { schematicBox(ctx, isNpn ? 'NPN' : 'PNP', 4, 4, cellSize); },
    stamp(params, terminals, sys, sim, comp) {
      bjtStampCore(bjtModel(params), thermalVoltage(tempOf(sim)), pol, terminals, sys, sim, comp);
    },
    step(params, terminals, sim, comp) {
      bjtStepCore(bjtModel(params), thermalVoltage(tempOf(sim)), pol, terminals, sim, comp);
    },
    measure(params, terminals, sim, comp) {
      const r = bjtMeasureCore(bjtModel(params), thermalVoltage(tempOf(sim)), pol, terminals, sim, comp);
      return [
        { label: 'Vbe', value: r.vbe.toFixed(4), unit: 'V' },
        { label: 'Ic', value: (r.ic * 1000).toFixed(4), unit: 'mA' },
        { label: 'Ib', value: (r.ib * 1000).toFixed(4), unit: 'mA' },
      ];
    },
    getFlowPath() { return [{ x: 4, y: 1 }, { x: 2, y: 3 }, { x: 4, y: 3 }]; },
  };
}
export const spiceNpn = makeBjt(true);
export const spicePnp = makeBjt(false);

// ─────────────────────────────────────────────────────────────────────────────
// Voltage-controlled switch with hysteresis (ngspice S element)
// ─────────────────────────────────────────────────────────────────────────────

export const spiceSwitch: ComponentPlugin = {
  type: 'spiceSwitch',
  name: 'Switch (SPICE S)',
  category: 'passive',
  description: 'Voltage-controlled switch: ON (RON) above VT+VH, OFF (ROFF) below VT−VH, previous state in between.',
  symbol: 'S',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'passive' },
    { id: 'b', label: 'B', position: { x: 6, y: 1 }, electricalType: 'passive' },
    { id: 'cp', label: 'C+', position: { x: 2, y: 4 }, electricalType: 'input' },
    { id: 'cn', label: 'C-', position: { x: 4, y: 4 }, electricalType: 'input' },
  ],
  parameters: [
    { key: 'vt', label: 'VT', type: 'number', default: 0, unit: 'V' },
    { key: 'vh', label: 'VH', type: 'number', default: 0, unit: 'V' },
    { key: 'ron', label: 'RON', type: 'number', default: 1, unit: 'Ω' },
    { key: 'roff', label: 'ROFF', type: 'number', default: 1e12, unit: 'Ω' },
    { key: 'initialOn', label: 'Initial state ON', type: 'boolean', default: false },
  ],
  keywords: ['switch', 'spice'],
  nonLinear: true,
  render(ctx, _p, cellSize) { schematicBox(ctx, 'S', 6, 2, cellSize); },
  stamp(params, terminals, sys, sim, comp) {
    const a = term(terminals, 'a'), b = term(terminals, 'b'), cp = term(terminals, 'cp'), cn = term(terminals, 'cn');
    const vt = num(params, 'vt', 0), vh = Math.abs(num(params, 'vh', 0));
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = compKey('sps', comp, a, b, cp, cn);
    const prevOn = (st[key] as boolean | undefined) ?? params.initialOn === true;
    const vc = nodeV(sim, cp) - nodeV(sim, cn);
    let on = prevOn;
    if (vc > vt + vh) on = true;
    else if (vc < vt - vh) on = false;
    st[key + '_now'] = on;
    sys.stampConductance(a, b, 1 / Math.max(1e-9, on ? num(params, 'ron', 1) : num(params, 'roff', 1e12)));
  },
  step(params, terminals, sim, comp) {
    const a = term(terminals, 'a'), b = term(terminals, 'b'), cp = term(terminals, 'cp'), cn = term(terminals, 'cn');
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = compKey('sps', comp, a, b, cp, cn);
    const vt = num(params, 'vt', 0), vh = Math.abs(num(params, 'vh', 0));
    const prevOn = (st[key] as boolean | undefined) ?? params.initialOn === true;
    const vc = nodeV(sim, cp) - nodeV(sim, cn);
    st[key] = vc > vt + vh ? true : vc < vt - vh ? false : prevOn;
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Mutually coupled inductors (K cards): up to three windings, every pair coupled
// ─────────────────────────────────────────────────────────────────────────────

interface MutualState { i: number[]; i2?: number[]; v1: number[]; hp?: number; n: number }

function invert3(L: number[][], n: number): number[][] {
  if (n === 2) {
    const d = L[0][0] * L[1][1] - L[0][1] * L[1][0];
    return [[L[1][1] / d, -L[0][1] / d], [-L[1][0] / d, L[0][0] / d]];
  }
  const [[a, b, c], [d, e, f], [g, h, i]] = L;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

function makeMutual(n: 2 | 3): ComponentPlugin {
  const ids = ['1', '2', '3'].slice(0, n);
  const lMatrix = (p: Record<string, any>): number[][] => {
    const L = ids.map((_, j) => Math.max(1e-15, num(p, `L${j + 1}`, 1e-3)));
    const kk = (i: number, j: number) => Math.min(0.999999, Math.max(-0.999999, num(p, `k${Math.min(i, j) + 1}${Math.max(i, j) + 1}`, 0)));
    return L.map((li, i) => L.map((lj, j) => (i === j ? li : kk(i, j) * Math.sqrt(li * lj))));
  };
  const nodes = (t: MnaTerminals) => ids.map((s) => [term(t, `a${s}`), term(t, `b${s}`)] as [number, number]);
  const coef = (sim: SimContext, s: MutualState | undefined) => {
    const dt = Math.max(sim.dt, 1e-18);
    const method = sim.method ?? 'euler';
    if (method === 'trap' && s && s.n >= 1) return { c: dt / 2, kind: 'trap' as const, dt };
    if (method === 'gear' && s?.i2) { const k = bdf2(dt, s.hp); return { c: dt / k.a0, kind: 'gear' as const, dt, k }; }
    return { c: dt, kind: 'euler' as const, dt };
  };
  return {
    type: `spiceMutual${n}`,
    name: `${n} coupled inductors (K)`,
    category: 'passive',
    description: `${n} windings with mutual coupling M_ij = k_ij·√(Li·Lj) (SPICE K element).`,
    symbol: 'K',
    boundingBox: { width: 4, height: 2 + 2 * n },
    terminals: ids.flatMap((s, j) => [
      { id: `a${s}`, label: `A${s}`, position: { x: 0, y: 1 + 2 * j }, electricalType: 'passive' as const },
      { id: `b${s}`, label: `B${s}`, position: { x: 4, y: 1 + 2 * j }, electricalType: 'passive' as const },
    ]),
    parameters: [
      ...ids.map((s) => ({ key: `L${s}`, label: `L${s}`, type: 'number' as const, default: 1e-3, unit: 'H' })),
      ...(n === 2 ? ['k12'] : ['k12', 'k13', 'k23']).map((k) => ({ key: k, label: k, type: 'number' as const, default: 0.99 })),
    ],
    keywords: ['coupled', 'mutual', 'transformer', 'k'],
    render(ctx, _p, cellSize) { schematicBox(ctx, 'K', 4, 2 + 2 * n, cellSize); },
    stamp(params, terminals, sys, sim, comp) {
      const nd = nodes(terminals);
      const G0 = invert3(lMatrix(params), n);
      const st = sim.state.__global ?? (sim.state.__global = {});
      const s = st[compKey('spk', comp, ...nd.flat())] as MutualState | undefined;
      const { c, kind, k } = coef(sim, s) as { c: number; kind: string; k?: { a0: number; a1: number; a2: number } };
      for (let j = 0; j < n; j++) {
        // history current of winding j
        let hist = s?.i[j] ?? 0;
        if (kind === 'trap') hist += c * G0[j].reduce((acc, g, m) => acc + g * (s?.v1[m] ?? 0), 0);
        else if (kind === 'gear' && k && s?.i2) hist = (k.a1 * s.i[j] - k.a2 * s.i2[j]) / k.a0;
        sys.stampConductance(nd[j][0], nd[j][1], c * G0[j][j]);
        sys.stampCurrentSource(nd[j][0], nd[j][1], hist);
        for (let m = 0; m < n; m++) if (m !== j) sys.stampVCCS(nd[j][0], nd[j][1], nd[m][0], nd[m][1], c * G0[j][m]);
      }
    },
    step(params, terminals, sim, comp) {
      const nd = nodes(terminals);
      const G0 = invert3(lMatrix(params), n);
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = compKey('spk', comp, ...nd.flat());
      const s = st[key] as MutualState | undefined;
      const { c, kind, k } = coef(sim, s) as { c: number; kind: string; k?: { a0: number; a1: number; a2: number } };
      const v = nd.map(([a, b]) => nodeV(sim, a) - nodeV(sim, b));
      const iNew = nd.map((_, j) => {
        let hist = s?.i[j] ?? 0;
        if (kind === 'trap') hist += c * G0[j].reduce((acc, g, m) => acc + g * (s?.v1[m] ?? 0), 0);
        else if (kind === 'gear' && k && s?.i2) hist = (k.a1 * s.i[j] - k.a2 * s.i2[j]) / k.a0;
        return hist + c * G0[j].reduce((acc, g, m) => acc + g * v[m], 0);
      });
      st[key] = { i: iNew, i2: s?.i, v1: v, hp: Math.max(sim.dt, 1e-18), n: (s?.n ?? 0) + 1 } satisfies MutualState;
    },
    getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
  };
}
export const spiceMutual2 = makeMutual(2);
export const spiceMutual3 = makeMutual(3);

// ─────────────────────────────────────────────────────────────────────────────
// Independent sources with SPICE waveforms and AC magnitude
// ─────────────────────────────────────────────────────────────────────────────

export type WaveFn = (t: number) => number;

/** Parse "SIN(...)", "PULSE(...)", "PWL(...)", "EXP(...)" into f(t). Arguments must be numbers already. */
export function parseWave(spec: string): WaveFn | null {
  const m = /^\s*(sin|pulse|pwl|exp)\s*\(([^)]*)\)\s*$/i.exec(spec ?? '');
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const a = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (kind === 'sin') {
    const [vo = 0, va = 0, f = 0, td = 0, th = 0, ph = 0] = a;
    const phr = (ph * Math.PI) / 180;
    return (t) => (t < td ? vo + va * Math.sin(phr) : vo + va * Math.exp(-th * (t - td)) * Math.sin(2 * Math.PI * f * (t - td) + phr));
  }
  if (kind === 'pulse') {
    const [v1 = 0, v2 = 0, td = 0, tr = 1e-12, tf = 1e-12, pw = Infinity, per = Infinity] = a;
    const r = Math.max(tr, 1e-15), f = Math.max(tf, 1e-15);
    return (t) => {
      if (t < td) return v1;
      const tt = Number.isFinite(per) && per > 0 ? (t - td) % per : t - td;
      if (tt < r) return v1 + ((v2 - v1) * tt) / r;
      if (tt < r + pw) return v2;
      if (tt < r + pw + f) return v2 + ((v1 - v2) * (tt - r - pw)) / f;
      return v1;
    };
  }
  if (kind === 'exp') {
    const [v1 = 0, v2 = 0, td1 = 0, tau1 = 1e-9, td2 = Infinity, tau2 = 1e-9] = a;
    return (t) => {
      if (t < td1) return v1;
      let v = v1 + (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
      if (t >= td2) v += (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2));
      return v;
    };
  }
  // pwl
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < a.length; i += 2) pts.push([a[i], a[i + 1]]);
  if (pts.length === 0) return () => 0;
  return (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
        return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    }
    return pts[pts.length - 1][1];
  };
}

const waveCache = new Map<string, WaveFn | null>();
function waveOf(spec: string): WaveFn | null {
  if (!waveCache.has(spec)) waveCache.set(spec, parseWave(spec));
  return waveCache.get(spec) ?? null;
}

function sourceValue(params: Record<string, any>, sim: SimContext): number {
  const dc = num(params, 'dc', 0);
  const w = typeof params.wave === 'string' && params.wave ? waveOf(params.wave) : null;
  if (!w) return dc;
  // .op / DC analysis: the explicit DC value if given, else the waveform at t = 0
  if (sim.time <= 0) return params.dcSet === true ? dc : w(0);
  return w(sim.time);
}

function makeSource(isV: boolean): ComponentPlugin {
  return {
    type: isV ? 'spiceV' : 'spiceI',
    name: isV ? 'V source (SPICE)' : 'I source (SPICE)',
    category: 'source',
    description: `Independent ${isV ? 'voltage' : 'current'} source: DC, AC magnitude/phase, SIN / PULSE / PWL / EXP waveform.`,
    symbol: isV ? 'V' : 'I',
    boundingBox: { width: 2, height: 4 },
    terminals: [
      { id: 'p', label: '+', position: { x: 1, y: 0 }, electricalType: isV ? 'output' : 'passive' },
      { id: 'n', label: '-', position: { x: 1, y: 4 }, electricalType: 'passive' },
    ],
    parameters: [
      { key: 'dc', label: 'DC', type: 'number', default: 0 },
      { key: 'dcSet', label: 'DC given', type: 'boolean', default: false },
      { key: 'acMag', label: 'AC magnitude', type: 'number', default: 0 },
      { key: 'acPhase', label: 'AC phase', type: 'number', default: 0, unit: '°' },
      { key: 'wave', label: 'Waveform', type: 'string', default: '' },
    ],
    keywords: ['source', 'spice', 'pulse', 'sin', 'pwl'],
    render(ctx, _p, cellSize) {
      ctx.beginPath(); ctx.arc(cellSize, 2 * cellSize, 0.7 * cellSize, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cellSize, 0); ctx.lineTo(cellSize, 1.3 * cellSize); ctx.moveTo(cellSize, 2.7 * cellSize); ctx.lineTo(cellSize, 4 * cellSize); ctx.stroke();
    },
    stamp(params, terminals, sys, sim, comp) {
      const p = term(terminals, 'p'), n = term(terminals, 'n');
      const v = sourceValue(params, sim);
      if (isV) {
        const idx = sys.stampVoltageSource(p, n, v);
        const map = sim.state.__branchIndices ?? (sim.state.__branchIndices = {});
        if (comp) { map[comp.id] = idx; if (comp.refdes) map[comp.refdes] = idx; }
      } else {
        sys.stampCurrentSource(p, n, v);
      }
    },
    acStamp(params, terminals, sys) {
      const p = term(terminals, 'p'), n = term(terminals, 'n');
      const mag = num(params, 'acMag', 0), ph = (num(params, 'acPhase', 0) * Math.PI) / 180;
      const z = { re: mag * Math.cos(ph), im: mag * Math.sin(ph) };
      if (isV) cStampVoltageSource(sys, p, n, z);
      else if (mag !== 0) cStampCurrentSource(sys, p, n, z);
    },
    measure(_params, terminals, sim) {
      return [{ label: 'V', value: (nodeV(sim, term(terminals, 'p')) - nodeV(sim, term(terminals, 'n'))).toFixed(4), unit: 'V' }];
    },
  };
}
export const spiceV = makeSource(true);
export const spiceI = makeSource(false);

for (const p of [spiceDiode, spiceNpn, spicePnp, spiceSwitch, spiceMutual2, spiceMutual3, spiceV, spiceI]) registerPlugin(p);
