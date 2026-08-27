// DESIGN CALCULATORS — exact EE design math for the AI agent.
// ─────────────────────────────────────────────────────────────────────────────
// One tool (design.calculate) exposing ~25 canonical electronics formulas.
// Every calculator returns: computed outputs + the formula used + a worked
// explanation, so the AI can quote exact numbers and reasoning to the user
// instead of doing error-prone mental arithmetic.
//
// All public compute* functions are pure (no ctx) so they are unit-testable
// and reusable from design-patterns.ts (the one-shot circuit builders).

import type { Tool } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Standard-value (E-series) helpers
// ─────────────────────────────────────────────────────────────────────────────

const E12_BASE = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
const E24_BASE = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
const E96_BASE = [
  1.00, 1.02, 1.05, 1.07, 1.10, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.30, 1.33, 1.37, 1.40, 1.43,
  1.47, 1.50, 1.54, 1.58, 1.62, 1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.00, 2.05, 2.10,
  2.15, 2.21, 2.26, 2.32, 2.37, 2.43, 2.49, 2.55, 2.61, 2.67, 2.74, 2.80, 2.87, 2.94, 3.01, 3.09,
  3.16, 3.24, 3.32, 3.40, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42, 4.53,
  4.64, 4.75, 4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.90, 6.04, 6.19, 6.34, 6.49, 6.65,
  6.81, 6.98, 7.15, 7.32, 7.50, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];

export type ESeries = 'E6' | 'E12' | 'E24' | 'E96';

/** Nearest standard value from an E-series (any decade). */
export function nearestStandard(value: number, series: ESeries = 'E24'): number {
  if (!isFinite(value) || value <= 0) return value;
  const base = series === 'E6' ? E12_BASE.filter((_, i) => i % 2 === 0)
    : series === 'E12' ? E12_BASE
    : series === 'E24' ? E24_BASE
    : E96_BASE;
  const decade = Math.floor(Math.log10(value));
  let best = value;
  let bestErr = Infinity;
  for (let d = decade - 1; d <= decade + 1; d++) {
    const scale = Math.pow(10, d);
    for (const b of base) {
      const v = b * scale;
      const err = Math.abs(Math.log(v / value));
      if (err < bestErr) { bestErr = err; best = v; }
    }
  }
  return best;
}

/** Engineering-notation formatting: 4700 → "4.7k", 0.0000001 → "100n". */
export function engFormat(value: number, unit = ''): string {
  if (!isFinite(value)) return String(value);
  if (value === 0) return `0${unit ? ' ' + unit : ''}`;
  const prefixes: [number, string][] = [
    [1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
    [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
  ];
  const abs = Math.abs(value);
  for (const [scale, prefix] of prefixes) {
    if (abs >= scale) {
      const scaled = value / scale;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `${Number(scaled.toFixed(digits))}${prefix}${unit}`;
    }
  }
  return `${value.toExponential(2)}${unit}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure calculators (exported for reuse + tests)
// ─────────────────────────────────────────────────────────────────────────────

export interface CalcOutput {
  outputs: Record<string, number | string | boolean>;
  formula: string;
  explanation: string;
  notes?: string[];
}

const LN2 = Math.LN2;
const LN3 = Math.log(3);

/** Ohm's law — solve for the missing quantity given any 2 of V, I, R. */
export function calcOhmsLaw(v?: number, i?: number, r?: number): CalcOutput {
  let V = v, I = i, R = r;
  if (V !== undefined && I !== undefined) R = V / I;
  else if (V !== undefined && R !== undefined) I = V / R;
  else if (I !== undefined && R !== undefined) V = I * R;
  else throw new Error('Provide exactly 2 of: v, i, r');
  const P = V! * I!;
  return {
    outputs: { v: V!, i: I!, r: R!, p: P },
    formula: 'V = I·R,  P = V·I',
    explanation: `V = ${engFormat(V!, 'V')}, I = ${engFormat(I!, 'A')}, R = ${engFormat(R!, 'Ω')} → P = ${engFormat(P, 'W')}`,
  };
}

/** LED series resistor: R = (Vsupply − Vf) / I_target. */
export function calcLedResistor(supplyV: number, vf: number, targetI: number, series: ESeries = 'E24'): CalcOutput {
  if (targetI <= 0) throw new Error('targetI must be > 0');
  if (supplyV <= vf) throw new Error(`Supply ${supplyV}V is not higher than the LED forward voltage ${vf}V — the LED cannot conduct. Use a higher supply or a LED with lower Vf.`);
  const rExact = (supplyV - vf) / targetI;
  const rStd = nearestStandard(rExact, series);
  const iActual = (supplyV - vf) / rStd;
  const pResistor = iActual * iActual * rStd;
  const pLed = vf * iActual;
  return {
    outputs: {
      rExact, rStandard: rStd, rLabel: engFormat(rStd, 'Ω'),
      actualCurrent: iActual, currentLabel: engFormat(iActual, 'A'),
      powerResistor: pResistor, powerLed: pLed,
    },
    formula: 'R = (Vsupply − Vf) / I_target',
    explanation: `R = (${supplyV}V − ${vf}V) / ${engFormat(targetI, 'A')} = ${engFormat(rExact, 'Ω')} → nearest ${series}: ${engFormat(rStd, 'Ω')} → actual I = ${engFormat(iActual, 'A')} (${((iActual / targetI - 1) * 100).toFixed(1)}% off target)`,
    notes: [
      `Resistor dissipates ${engFormat(pResistor, 'W')} — use a ${pResistor > 0.2 ? '1/2 W' : '1/4 W'} or larger part.`,
      `LED dissipates ${engFormat(pLed, 'W')}.`,
    ],
  };
}

/** Voltage divider — forward (values → Vout) or design (target → R1/R2). */
export function calcVoltageDivider(vin: number, r1?: number, r2?: number, targetVout?: number, rTotal?: number, series: ESeries = 'E24'): CalcOutput {
  if (targetVout !== undefined && rTotal !== undefined) {
    if (targetVout >= vin) throw new Error(`Target Vout ${targetVout}V must be below Vin ${vin}V (a passive divider can only attenuate).`);
    if (targetVout <= 0) throw new Error('targetVout must be > 0');
    const r2Exact = rTotal * (targetVout / vin);
    const r1Exact = rTotal - r2Exact;
    const r2Std = nearestStandard(r2Exact, series);
    const r1Std = nearestStandard(r1Exact, series);
    const voutActual = vin * r2Std / (r1Std + r2Std);
    const current = vin / (r1Std + r2Std);
    return {
      outputs: {
        r1: r1Std, r2: r2Std, r1Label: engFormat(r1Std, 'Ω'), r2Label: engFormat(r2Std, 'Ω'),
        voutActual, errorPct: (voutActual / targetVout - 1) * 100,
        dividerCurrent: current, quiescentPower: vin * current,
      },
      formula: 'Vout = Vin·R2/(R1+R2);  R2 = Rtotal·Vout/Vin',
      explanation: `Target ${targetVout}V from ${vin}V with Rtotal = ${engFormat(rTotal, 'Ω')}: R2 = ${engFormat(r2Exact, 'Ω')} (top R1 = ${engFormat(r1Exact, 'Ω')}) → ${series}: R1 = ${engFormat(r1Std, 'Ω')}, R2 = ${engFormat(r2Std, 'Ω')} → Vout = ${voutActual.toFixed(3)}V`,
      notes: [
        `Divider draws ${engFormat(current, 'A')} continuously (${engFormat(vin * current, 'W')}).`,
        `Keep divider current ≥ 10× load current, or buffer with an op-amp follower.`,
      ],
    };
  }
  if (r1 !== undefined && r2 !== undefined) {
    const vout = vin * r2 / (r1 + r2);
    const current = vin / (r1 + r2);
    return {
      outputs: { vout, dividerCurrent: current, quiescentPower: vin * current },
      formula: 'Vout = Vin·R2/(R1+R2)',
      explanation: `Vout = ${vin}V · ${engFormat(r2, 'Ω')}/(${engFormat(r1, 'Ω')}+${engFormat(r2, 'Ω')}) = ${vout.toFixed(3)}V`,
    };
  }
  throw new Error('Provide either (r1, r2) or (targetVout, rTotal)');
}

/** RC filter cutoff — forward (R,C → fc) or design (fc + C → R, or fc + R → C). */
export function calcRcFilter(r?: number, c?: number, fc?: number, series: ESeries = 'E24'): CalcOutput {
  if (fc !== undefined && c !== undefined) {
    const rExact = 1 / (2 * Math.PI * fc * c);
    const rStd = nearestStandard(rExact, series);
    const fcActual = 1 / (2 * Math.PI * rStd * c);
    return {
      outputs: { rExact, rStandard: rStd, rLabel: engFormat(rStd, 'Ω'), fcActual, tau: rStd * c },
      formula: 'fc = 1/(2πRC)  →  R = 1/(2π·fc·C)',
      explanation: `For fc = ${engFormat(fc, 'Hz')} with C = ${engFormat(c, 'F')}: R = ${engFormat(rExact, 'Ω')} → ${series}: ${engFormat(rStd, 'Ω')} → actual fc = ${engFormat(fcActual, 'Hz')}`,
      notes: [`Attenuates −20 dB/decade (first order). At fc the output is −3 dB (0.707×) with −45° phase.`],
    };
  }
  if (fc !== undefined && r !== undefined) {
    const cExact = 1 / (2 * Math.PI * fc * r);
    return {
      outputs: { cExact, cLabel: engFormat(cExact, 'F'), tau: r * cExact },
      formula: 'C = 1/(2π·fc·R)',
      explanation: `For fc = ${engFormat(fc, 'Hz')} with R = ${engFormat(r, 'Ω')}: C = ${engFormat(cExact, 'F')}`,
      notes: [`Round to a standard cap value (E6/E12): e.g. ${engFormat(nearestStandard(cExact * 1e12, 'E12') / 1e12, 'F')}`],
    };
  }
  if (r !== undefined && c !== undefined) {
    const f = 1 / (2 * Math.PI * r * c);
    return {
      outputs: { fc: f, tau: r * c, settleTime5Tau: 5 * r * c },
      formula: 'fc = 1/(2πRC),  τ = RC',
      explanation: `fc = 1/(2π·${engFormat(r, 'Ω')}·${engFormat(c, 'F')}) = ${engFormat(f, 'Hz')}; τ = ${engFormat(r * c, 's')} (settles in ~${engFormat(5 * r * c, 's')})`,
    };
  }
  throw new Error('Provide (r, c) or (fc, c) or (fc, r)');
}

/** RL first-order: fc = R/(2πL), τ = L/R. */
export function calcRlFilter(r: number, l: number): CalcOutput {
  const fc = r / (2 * Math.PI * l);
  const tau = l / r;
  return {
    outputs: { fc, tau },
    formula: 'fc = R/(2πL),  τ = L/R',
    explanation: `fc = ${engFormat(r, 'Ω')}/(2π·${engFormat(l, 'H')}) = ${engFormat(fc, 'Hz')}; τ = ${engFormat(tau, 's')}`,
  };
}

/** 555 astable — forward (R1,R2,C → f/duty) or design (f,duty,C → R1,R2). */
export function calc555Astable(r1?: number, r2?: number, c?: number, f?: number, duty?: number, series: ESeries = 'E24'): CalcOutput {
  const notes: string[] = [];
  if (f !== undefined && duty !== undefined && c !== undefined) {
    if (duty <= 0 || duty >= 1) throw new Error('duty must be between 0 and 1 (e.g. 0.6 = 60%)');
    if (duty < 0.5) {
      notes.push(`Classic 555 astable cannot go below 50% duty (T_high = ln2·(R1+R2)·C ≥ ln2·R2·C = T_low). Requested ${(duty * 100).toFixed(0)}% < 50% — clamped to 51%. For true low duty add a diode across R2.`);
      duty = 0.51;
    }
    const T = 1 / f;
    const tHigh = duty * T;
    const tLow = T - tHigh;
    const r2Exact = tLow / (LN2 * c);
    const r1Exact = tHigh / (LN2 * c) - r2Exact;
    if (r1Exact <= 0) throw new Error('No valid R1 (duty too close to 50%). Increase duty slightly or change C.');
    const r1Std = nearestStandard(r1Exact, series);
    const r2Std = nearestStandard(r2Exact, series);
    const fActual = 1 / (LN2 * (r1Std + 2 * r2Std) * c);
    const dutyActual = (r1Std + r2Std) / (r1Std + 2 * r2Std);
    if (r1Std < 1000) notes.push(`R1 = ${engFormat(r1Std, 'Ω')} is below the 1k minimum — the discharge transistor may not saturate. Consider a smaller C.`);
    return {
      outputs: {
        r1: r1Std, r2: r2Std, r1Label: engFormat(r1Std, 'Ω'), r2Label: engFormat(r2Std, 'Ω'), c,
        fExact: 1 / (LN2 * (r1Exact + 2 * r2Exact) * c), fActual, dutyActual,
        tHigh: LN2 * (r1Std + r2Std) * c, tLow: LN2 * r2Std * c,
      },
      formula: 'f = 1/(ln2·(R1+2·R2)·C),  duty = (R1+R2)/(R1+2·R2)',
      explanation: `Target f = ${engFormat(f, 'Hz')}, duty = ${(duty * 100).toFixed(0)}%, C = ${engFormat(c, 'F')}: R2 = T_low/(ln2·C) = ${engFormat(r2Exact, 'Ω')}, R1 = T_high/(ln2·C) − R2 = ${engFormat(r1Exact, 'Ω')} → ${series}: R1 = ${engFormat(r1Std, 'Ω')}, R2 = ${engFormat(r2Std, 'Ω')} → f = ${engFormat(fActual, 'Hz')}, duty = ${(dutyActual * 100).toFixed(1)}%`,
      notes,
    };
  }
  if (r1 !== undefined && r2 !== undefined && c !== undefined) {
    const freq = 1 / (LN2 * (r1 + 2 * r2) * c);
    const d = (r1 + r2) / (r1 + 2 * r2);
    return {
      outputs: { f: freq, duty: d, tHigh: LN2 * (r1 + r2) * c, tLow: LN2 * r2 * c, period: 1 / freq },
      formula: 'f = 1/(ln2·(R1+2·R2)·C),  duty = (R1+R2)/(R1+2·R2)',
      explanation: `f = 1/(0.693·(${engFormat(r1, 'Ω')}+2·${engFormat(r2, 'Ω')})·${engFormat(c, 'F')}) = ${engFormat(freq, 'Hz')}; duty = ${(d * 100).toFixed(1)}%; T_high = ${engFormat(LN2 * (r1 + r2) * c, 's')}, T_low = ${engFormat(LN2 * r2 * c, 's')}`,
    };
  }
  throw new Error('Provide (r1, r2, c) or (f, duty, c)');
}

/** 555 monostable: T = ln(3)·R·C ≈ 1.1·R·C. */
export function calc555Monostable(r?: number, c?: number, pulseWidth?: number, series: ESeries = 'E24'): CalcOutput {
  if (pulseWidth !== undefined && c !== undefined) {
    const rExact = pulseWidth / (LN3 * c);
    const rStd = nearestStandard(rExact, series);
    const tActual = LN3 * rStd * c;
    return {
      outputs: { rExact, rStandard: rStd, rLabel: engFormat(rStd, 'Ω'), pulseWidthActual: tActual },
      formula: 'T = ln(3)·R·C ≈ 1.1·R·C',
      explanation: `For T = ${engFormat(pulseWidth, 's')} with C = ${engFormat(c, 'F')}: R = ${engFormat(rExact, 'Ω')} → ${series}: ${engFormat(rStd, 'Ω')} → T = ${engFormat(tActual, 's')}`,
    };
  }
  if (r !== undefined && c !== undefined) {
    const t = LN3 * r * c;
    return {
      outputs: { pulseWidth: t },
      formula: 'T = ln(3)·R·C ≈ 1.1·R·C',
      explanation: `T = 1.1·${engFormat(r, 'Ω')}·${engFormat(c, 'F')} = ${engFormat(t, 's')}`,
    };
  }
  throw new Error('Provide (r, c) or (pulseWidth, c)');
}

/** Op-amp gain — inverting: G = −Rf/Rin; non-inverting: G = 1 + Rf/Rg. */
export function calcOpampGain(kind: 'inverting' | 'noninverting', rinOrRg?: number, rf?: number, targetGain?: number, series: ESeries = 'E24'): CalcOutput {
  if (targetGain !== undefined && rinOrRg !== undefined) {
    if (kind === 'inverting') {
      if (targetGain <= 0) throw new Error('Inverting gain magnitude must be > 0 (the sign is the inversion)');
      const rfExact = targetGain * rinOrRg;
      const rfStd = nearestStandard(rfExact, series);
      return {
        outputs: { rf: rfStd, rfLabel: engFormat(rfStd, 'Ω'), gainActual: -rfStd / rinOrRg, gainDb: 20 * Math.log10(rfStd / rinOrRg) },
        formula: 'G = −Rf/Rin',
        explanation: `For |G| = ${targetGain} with Rin = ${engFormat(rinOrRg, 'Ω')}: Rf = ${engFormat(targetGain * rinOrRg, 'Ω')} → ${series}: ${engFormat(rfStd, 'Ω')} → G = −${(rfStd / rinOrRg).toFixed(3)} (${(20 * Math.log10(rfStd / rinOrRg)).toFixed(1)} dB)`,
        notes: [`Keep Rin ≥ 1k to avoid loading the source; keep Rf ≤ 1M to limit offset from bias currents.`],
      };
    } else {
      if (targetGain < 1) throw new Error('Non-inverting gain must be ≥ 1 (G = 1 + Rf/Rg)');
      const rfExact = (targetGain - 1) * rinOrRg;
      const rfStd = nearestStandard(rfExact, series);
      return {
        outputs: { rf: rfStd, rfLabel: engFormat(rfStd, 'Ω'), gainActual: 1 + rfStd / rinOrRg, gainDb: 20 * Math.log10(1 + rfStd / rinOrRg) },
        formula: 'G = 1 + Rf/Rg',
        explanation: `For G = ${targetGain} with Rg = ${engFormat(rinOrRg, 'Ω')}: Rf = ${engFormat(rfExact, 'Ω')} → ${series}: ${engFormat(rfStd, 'Ω')} → G = ${(1 + rfStd / rinOrRg).toFixed(3)} (${(20 * Math.log10(1 + rfStd / rinOrRg)).toFixed(1)} dB)`,
      };
    }
  }
  if (rinOrRg !== undefined && rf !== undefined) {
    const g = kind === 'inverting' ? -rf / rinOrRg : 1 + rf / rinOrRg;
    return {
      outputs: { gain: g, gainDb: 20 * Math.log10(Math.abs(kind === 'inverting' ? rf / rinOrRg : 1 + rf / rinOrRg)) },
      formula: kind === 'inverting' ? 'G = −Rf/Rin' : 'G = 1 + Rf/Rg',
      explanation: `G = ${g.toFixed(3)} (${(20 * Math.log10(Math.abs(g))).toFixed(1)} dB)`,
    };
  }
  throw new Error('Provide (rinOrRg, rf) or (targetGain, rinOrRg)');
}

/** LM317: Vout = 1.25·(1 + R2/R1), R1 = 240Ω typical. */
export function calcLm317(targetVout?: number, r1 = 240, r2?: number, series: ESeries = 'E24'): CalcOutput {
  if (targetVout !== undefined) {
    if (targetVout < 1.3 || targetVout > 37) {
      // Allow but warn — outside the datasheet guaranteed range
    }
    const r2Exact = r1 * (targetVout / 1.25 - 1);
    if (r2Exact <= 0) throw new Error(`LM317 cannot output ${targetVout}V (minimum is 1.25V)`);
    const r2Std = nearestStandard(r2Exact, series);
    const voutActual = 1.25 * (1 + r2Std / r1);
    return {
      outputs: { r1, r2: r2Std, r2Label: engFormat(r2Std, 'Ω'), voutActual, minLoadCurrent: 0.0035, dropout: 3 },
      formula: 'Vout = 1.25·(1 + R2/R1)',
      explanation: `For Vout = ${targetVout}V with R1 = ${r1}Ω: R2 = ${engFormat(r2Exact, 'Ω')} → ${series}: ${engFormat(r2Std, 'Ω')} → Vout = ${voutActual.toFixed(3)}V`,
      notes: [
        `LM317 needs Vin ≥ Vout + 3V (dropout) and a ≥ 3.5mA load (the R1 divider provides ${engFormat(1.25 / r1, 'A')} — ${1.25 / r1 >= 0.0035 ? 'sufficient' : 'INSUFFICIENT, lower R1 to 120Ω'}).`,
        targetVout > 37 ? 'Above 37V exceeds the LM317 absolute maximum.' : '',
        `Add a 0.1µF ceramic + 10µF electrolytic on the output for stability.`,
      ].filter(Boolean),
    };
  }
  if (r2 !== undefined) {
    const vout = 1.25 * (1 + r2 / r1);
    return {
      outputs: { vout },
      formula: 'Vout = 1.25·(1 + R2/R1)',
      explanation: `Vout = 1.25·(1 + ${engFormat(r2, 'Ω')}/${r1}Ω) = ${vout.toFixed(3)}V`,
    };
  }
  throw new Error('Provide targetVout or r2');
}

/** Zener shunt regulator series resistor. */
export function calcZenerResistor(vin: number, vz: number, iLoad: number, izMin = 0.005, series: ESeries = 'E24'): CalcOutput {
  if (vin <= vz) throw new Error(`Vin ${vin}V must exceed Vz ${vz}V`);
  const iTotal = izMin + iLoad;
  const rMax = (vin - vz) / iTotal;
  const rStd = nearestStandard(rMax * 0.9, series); // 10% headroom below Rmax
  const iZenerNoLoad = (vin - vz) / rStd - iLoad; // worst case when load disconnects
  const pZener = vz * Math.max(iZenerNoLoad, 0);
  const pR = (vin - vz) * (vin - vz) / rStd;
  return {
    outputs: { rMax, rStandard: rStd, rLabel: engFormat(rStd, 'Ω'), powerResistor: pR, powerZenerWorstCase: pZener, zenerCurrentNoLoad: Math.max(iZenerNoLoad, 0) },
    formula: 'R = (Vin − Vz)/(Iz_min + I_load)',
    explanation: `Rmax = (${vin}−${vz})V/(${engFormat(izMin, 'A')}+${engFormat(iLoad, 'A')}) = ${engFormat(rMax, 'Ω')} → chosen ${engFormat(rStd, 'Ω')} (10% margin)`,
    notes: [
      `Worst case (load disconnected): zener dissipates ${engFormat(pZener, 'W')} — pick a ≥ ${pZener > 0.5 ? 1 : 0.5}W zener.`,
      `Resistor dissipates ${engFormat(pR, 'W')} at full load.`,
      `Shunt regulators are inefficient (< 50% at light load) — for > 100mA use an LDO instead.`,
    ],
  };
}

/** Wheatstone bridge output. */
export function calcWheatstone(vex: number, r1: number, r2: number, r3: number, r4: number): CalcOutput {
  const vLeft = vex * r2 / (r1 + r2);
  const vRight = vex * r4 / (r3 + r4);
  const vout = vLeft - vRight;
  const balanced = Math.abs(vout) < vex * 1e-9;
  return {
    outputs: { vout, balanced, leftTap: vLeft, rightTap: vRight },
    formula: 'Vout = Vex·(R2/(R1+R2) − R4/(R3+R4)); balanced when R2·R3 = R1·R4',
    explanation: `Vout = ${vex}·(${engFormat(r2, 'Ω')}/(${engFormat(r1, 'Ω')}+${engFormat(r2, 'Ω')}) − ${engFormat(r4, 'Ω')}/(${engFormat(r3, 'Ω')}+${engFormat(r4, 'Ω')})) = ${vout.toFixed(4)}V ${balanced ? '(balanced)' : '(unbalanced)'}`,
  };
}

/** Ideal transformer. */
export function calcTransformer(vin: number, n1: number, n2: number, pLoad?: number): CalcOutput {
  const vout = vin * n2 / n1;
  const outputs: Record<string, number | string | boolean> = { vout, turnsRatio: n1 / n2 };
  let expl = `Vout = ${vin}V · ${n2}/${n1} = ${vout.toFixed(2)}V`;
  if (pLoad !== undefined) {
    const i2 = pLoad / vout;
    const i1 = i2 * n2 / n1;
    outputs.iSecondary = i2;
    outputs.iPrimary = i1;
    expl += `; I2 = ${engFormat(i2, 'A')}, I1 (reflected) = ${engFormat(i1, 'A')}`;
  }
  return { outputs, formula: 'V2 = V1·N2/N1,  I2 = I1·N1/N2', explanation: expl };
}

/** Power from any two of V, I, R. */
export function calcPower(v?: number, i?: number, r?: number): CalcOutput {
  const { outputs, explanation } = calcOhmsLaw(v, i, r);
  return {
    outputs,
    formula: 'P = V·I = I²·R = V²/R',
    explanation: `P = ${engFormat(outputs.p as number, 'W')}. ${explanation}`,
  };
}

/** dB conversions. */
export function calcDb(db?: number, linear?: number, power?: boolean, dbm?: number, impedance?: number): CalcOutput {
  if (db !== undefined) {
    const lin = Math.pow(10, db / (power ? 10 : 20));
    return {
      outputs: { linear: lin },
      formula: power ? 'linear = 10^(dB/10)' : 'linear = 10^(dB/20)',
      explanation: `${db} dB (${power ? 'power' : 'amplitude'}) = ${lin.toExponential(4)}×`,
    };
  }
  if (linear !== undefined) {
    const d = (power ? 10 : 20) * Math.log10(linear);
    return { outputs: { db: d }, formula: power ? 'dB = 10·log10(x)' : 'dB = 20·log10(x)', explanation: `${linear}× = ${d.toFixed(2)} dB` };
  }
  if (dbm !== undefined) {
    const pW = 1e-3 * Math.pow(10, dbm / 10);
    const z = impedance ?? 50;
    const vrms = Math.sqrt(pW * z);
    return {
      outputs: { powerW: pW, vrms, impedance: z },
      formula: 'P = 1mW·10^(dBm/10),  Vrms = √(P·Z)',
      explanation: `${dbm} dBm into ${z}Ω = ${engFormat(pW, 'W')} = ${engFormat(vrms, 'V')} rms`,
    };
  }
  throw new Error('Provide db, linear, or dbm');
}

/** Resistor network: parallel or series. */
export function calcResistorNetwork(values: number[], mode: 'parallel' | 'series'): CalcOutput {
  if (values.length === 0) throw new Error('values array is empty');
  if (mode === 'parallel') {
    const sumInv = values.reduce((s, v) => s + 1 / v, 0);
    const r = 1 / sumInv;
    return {
      outputs: { equivalent: r, label: engFormat(r, 'Ω') },
      formula: '1/Rpar = Σ(1/Ri)',
      explanation: `${values.map(v => engFormat(v, 'Ω')).join(' ∥ ')} = ${engFormat(r, 'Ω')}`,
      notes: [`Each resistor sees only a fraction of the power — two identical resistors in parallel double the power rating.`],
    };
  }
  const r = values.reduce((s, v) => s + v, 0);
  return { outputs: { equivalent: r, label: engFormat(r, 'Ω') }, formula: 'Rser = Σ(Ri)', explanation: `${values.map(v => engFormat(v, 'Ω')).join(' + ')} = ${engFormat(r, 'Ω')}` };
}

/** Reactance at a frequency. */
export function calcReactance(f: number, c?: number, l?: number): CalcOutput {
  if (c !== undefined) {
    const xc = 1 / (2 * Math.PI * f * c);
    return { outputs: { xc }, formula: 'Xc = 1/(2πfC)', explanation: `Xc = 1/(2π·${engFormat(f, 'Hz')}·${engFormat(c, 'F')}) = ${engFormat(xc, 'Ω')}` };
  }
  if (l !== undefined) {
    const xl = 2 * Math.PI * f * l;
    return { outputs: { xl }, formula: 'Xl = 2πfL', explanation: `Xl = 2π·${engFormat(f, 'Hz')}·${engFormat(l, 'H')}) = ${engFormat(xl, 'Ω')}` };
  }
  throw new Error('Provide c or l');
}

/** First-order RC transfer function at a frequency (LP or HP). */
export function calcRcTransfer(r: number, c: number, f: number, kind: 'lowpass' | 'highpass' = 'lowpass'): CalcOutput {
  const fc = 1 / (2 * Math.PI * r * c);
  const x = f / fc;
  const mag = kind === 'lowpass' ? 1 / Math.sqrt(1 + x * x) : x / Math.sqrt(1 + x * x);
  const phaseDeg = (kind === 'lowpass' ? -1 : 1) * Math.atan(x) * 180 / Math.PI;
  return {
    outputs: { fc, magnitude: mag, magnitudeDb: 20 * Math.log10(mag), phaseDeg },
    formula: kind === 'lowpass' ? '|H| = 1/√(1+(f/fc)²),  φ = −atan(f/fc)' : '|H| = (f/fc)/√(1+(f/fc)²),  φ = +atan(f/fc)',
    explanation: `fc = ${engFormat(fc, 'Hz')}; at ${engFormat(f, 'Hz')}: |H| = ${mag.toFixed(4)} (${(20 * Math.log10(mag)).toFixed(1)} dB), phase = ${phaseDeg.toFixed(1)}°`,
  };
}

/** Transistor switch base resistor. */
export function calcBaseResistor(vDrive: number, vbe: number, icTarget: number, hfeMin: number, saturationFactor = 5, series: ESeries = 'E24'): CalcOutput {
  if (hfeMin <= 0) throw new Error('hfeMin must be > 0');
  const ibForced = icTarget / hfeMin * saturationFactor;
  const rExact = (vDrive - vbe) / ibForced;
  const rStd = nearestStandard(rExact, series);
  const ibActual = (vDrive - vbe) / rStd;
  const icCapable = ibActual * hfeMin / saturationFactor;
  return {
    outputs: { rExact, rStandard: rStd, rLabel: engFormat(rStd, 'Ω'), ibForced, ibActual, icCapable },
    formula: 'Ib_forced = (Ic/hFE_min)·k (k≈5 for hard saturation);  Rb = (Vdrive − Vbe)/Ib',
    explanation: `Ib = ${engFormat(icTarget, 'A')}/${hfeMin}·${saturationFactor} = ${engFormat(ibForced, 'A')} → Rb = (${vDrive}−${vbe})V/${engFormat(ibForced, 'A')} = ${engFormat(rExact, 'Ω')} → ${series}: ${engFormat(rStd, 'Ω')}`,
    notes: [
      `With ${engFormat(rStd, 'Ω')} the transistor can sink ≥ ${engFormat(icCapable, 'A')} in saturation.`,
      saturationFactor > 3 ? 'Forced-beta of 5 guarantees hard saturation (Vce_sat ≈ 0.1–0.2V).' : 'Low saturation factor risks leaving the transistor in the linear region.',
    ],
  };
}

/** Energy storage. */
export function calcEnergy(c?: number, l?: number, v?: number, i?: number): CalcOutput {
  if (c !== undefined && v !== undefined) {
    const e = 0.5 * c * v * v;
    return { outputs: { energyJ: e }, formula: 'E = ½·C·V²', explanation: `E = 0.5·${engFormat(c, 'F')}·${v}V² = ${engFormat(e, 'J')}` };
  }
  if (l !== undefined && i !== undefined) {
    const e = 0.5 * l * i * i;
    return { outputs: { energyJ: e }, formula: 'E = ½·L·I²', explanation: `E = 0.5·${engFormat(l, 'H')}·${engFormat(i, 'A')}² = ${engFormat(e, 'J')}` };
  }
  throw new Error('Provide (c, v) or (l, i)');
}

/** RMS conversions for waveforms. */
export function calcRms(peak: number, waveform: 'sine' | 'square' | 'triangle' = 'sine'): CalcOutput {
  const factors = { sine: Math.SQRT1_2, square: 1, triangle: 1 / Math.sqrt(3) };
  const rms = peak * factors[waveform];
  return {
    outputs: { rms, average: waveform === 'square' ? peak : (waveform === 'sine' ? 2 * peak / Math.PI : peak / 2) },
    formula: { sine: 'Vrms = Vp/√2', square: 'Vrms = Vp', triangle: 'Vrms = Vp/√3' }[waveform],
    explanation: `${waveform}: Vrms = ${engFormat(rms, 'V')} from peak ${engFormat(peak, 'V')}`,
  };
}

/** Battery life estimate. */
export function calcBatteryLife(capacityMah: number, currentMa: number, derating = 0.8): CalcOutput {
  if (currentMa <= 0) throw new Error('currentMa must be > 0');
  const hours = capacityMah * derating / currentMa;
  return {
    outputs: { hours, days: hours / 24 },
    formula: 'life = capacity·derating / I',
    explanation: `${capacityMah}mAh · ${derating} / ${currentMa}mA = ${hours.toFixed(1)}h (${(hours / 24).toFixed(1)} days)`,
    notes: [`Derating ${derating * 100}% accounts for self-discharge, cutoff voltage, and Peukert losses.`],
  };
}

/** DC-DC converter duty cycles (ideal, CCM). */
export function calcDcDc(vin: number, vout: number, kind: 'buck' | 'boost'): CalcOutput {
  if (kind === 'buck') {
    if (vout >= vin) throw new Error(`Buck: Vout (${vout}V) must be below Vin (${vin}V)`);
    const d = vout / vin;
    return { outputs: { duty: d }, formula: 'D = Vout/Vin', explanation: `D = ${vout}/${vin} = ${(d * 100).toFixed(1)}%` };
  }
  if (vout <= vin) throw new Error(`Boost: Vout (${vout}V) must exceed Vin (${vin}V)`);
  const d = 1 - vin / vout;
  return { outputs: { duty: d }, formula: 'D = 1 − Vin/Vout', explanation: `D = 1 − ${vin}/${vout} = ${(d * 100).toFixed(1)}%` };
}

/** E-series nearest value. */
export function calcESeries(value: number, series: ESeries = 'E24'): CalcOutput {
  const std = nearestStandard(value, series);
  return {
    outputs: { standard: std, errorPct: (std / value - 1) * 100 },
    formula: `nearest ${series} value`,
    explanation: `${engFormat(value, 'Ω')} → ${engFormat(std, 'Ω')} (${((std / value - 1) * 100).toFixed(2)}% off)`,
  };
}

/** RC time constant / charging. */
export function calcTimeConstant(r: number, c: number, targetPct = 63.2): CalcOutput {
  const tau = r * c;
  const t = -tau * Math.log(1 - targetPct / 100);
  return {
    outputs: { tau, settleTime5Tau: 5 * tau, timeToTarget: t },
    formula: 'τ = R·C;  V(t) = V∞(1 − e^(−t/τ))',
    explanation: `τ = ${engFormat(tau, 's')}; reaches ${targetPct}% in ${engFormat(t, 's')}; fully settled (~99.3%) in 5τ = ${engFormat(5 * tau, 's')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a numeric input that may come as number or numeric string. */
function num(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (isNaN(n)) throw new Error(`Parameter "${name}" is not a number: ${JSON.stringify(v)}`);
  return n;
}

const FORMULA_DESCRIPTIONS: Record<string, string> = {
  'ohms-law': 'Solve Ohm\'s law + power. Give any 2 of v, i, r.',
  'led-series-resistor': 'LED current-limiting resistor. Inputs: supplyV, vf (LED forward voltage), targetI (amps). Returns exact + E24 standard R, actual current, power ratings.',
  'voltage-divider': 'Voltage divider. Forward: vin, r1, r2 → vout. Design: vin, targetVout, rTotal → r1, r2 (E24).',
  'rc-cutoff': 'RC filter cutoff. Forward: r, c → fc. Design: fc, c → r (E24) or fc, r → c.',
  'rc-time-constant': 'RC charging: r, c → tau, settle time, time to a target %.',
  'rl-cutoff': 'RL first-order cutoff: r, l → fc, tau.',
  'rc-transfer': 'First-order RC response at a frequency: r, c, f, kind (lowpass|highpass) → |H|, dB, phase.',
  '555-astable': '555 astable oscillator. Forward: r1, r2, c → f, duty. Design: f (Hz), duty (0-1), c → r1, r2 (E24).',
  '555-monostable': '555 monostable one-shot. Forward: r, c → pulse width. Design: pulseWidth, c → r (E24).',
  'opamp-gain': 'Op-amp gain. kind=inverting|noninverting. Forward: rinOrRg, rf → gain. Design: targetGain, rinOrRg → rf (E24).',
  'lm317': 'LM317 adjustable regulator: targetVout → r2 (with r1=240Ω), or r2 → vout. Vout = 1.25(1+R2/R1).',
  'zener-resistor': 'Zener shunt regulator series resistor: vin, vz, iLoad, izMin? → R, power ratings, worst case.',
  'wheatstone': 'Wheatstone bridge: vex, r1, r2, r3, r4 → vout, balance state.',
  'transformer': 'Ideal transformer: vin, n1, n2, pLoad? → vout, currents.',
  'power': 'Power dissipation from any 2 of v, i, r.',
  'db': 'dB conversions: db→linear (set power=true for power ratios), linear→db, or dbm+impedance→V/W.',
  'resistor-network': 'Series/parallel combination: values[], mode=parallel|series → equivalent R.',
  'reactance': 'Reactance at frequency: f + c → Xc, or f + l → Xl.',
  'base-resistor': 'Transistor switch base resistor: vDrive, vbe (0.7), icTarget, hfeMin, saturationFactor? → Rb (E24).',
  'energy': 'Stored energy: (c, v) → ½CV², or (l, i) → ½LI².',
  'rms': 'Waveform RMS: peak, waveform=sine|square|triangle.',
  'battery-life': 'Battery life: capacityMah, currentMa, derating? → hours.',
  'dcdc': 'Ideal converter duty: vin, vout, kind=buck|boost → duty cycle.',
  'e-series': 'Nearest standard E6/E12/E24/E96 value for any resistor/cap value.',
};

const designCalculateTool: Tool = {
  name: 'design.calculate',
  category: 'AI Diagnosis & Teaching',
  description:
    'Exact electronics design calculator. Given a formula name and inputs, returns computed values, the formula used, and a worked explanation with E-series standard values where relevant. ALWAYS use this before choosing component values — never do arithmetic in your head. Formulas: ' +
    Object.entries(FORMULA_DESCRIPTIONS).map(([k, d]) => `${k} (${d})`).join('; '),
  parameters: {
    type: 'object',
    properties: {
      formula: { type: 'string', enum: Object.keys(FORMULA_DESCRIPTIONS), description: 'Which formula to compute.' },
      inputs: {
        type: 'object',
        description: 'Numeric inputs for the formula (see the formula descriptions). Units: volts, amps, ohms, farads, henries, hertz, seconds, watts.',
        additionalProperties: true,
      },
      series: { type: 'string', enum: ['E6', 'E12', 'E24', 'E96'], description: 'Preferred standard-value series for snapped outputs (default E24).' },
    },
    required: ['formula', 'inputs'],
  },
  execute(args: { formula: string; inputs: Record<string, any>; series?: ESeries }, _ctx) {
    const i = args.inputs || {};
    const series = args.series || 'E24';
    try {
      let out: CalcOutput;
      switch (args.formula) {
        case 'ohms-law':
          out = calcOhmsLaw(num(i.v, 'v'), num(i.i, 'i'), num(i.r, 'r')); break;
        case 'led-series-resistor':
          out = calcLedResistor(requireNum(i.supplyV, 'supplyV'), requireNum(i.vf, 'vf'), requireNum(i.targetI, 'targetI'), series); break;
        case 'voltage-divider':
          out = calcVoltageDivider(requireNum(i.vin, 'vin'), num(i.r1, 'r1'), num(i.r2, 'r2'), num(i.targetVout, 'targetVout'), num(i.rTotal, 'rTotal'), series); break;
        case 'rc-cutoff':
          out = calcRcFilter(num(i.r, 'r'), num(i.c, 'c'), num(i.fc, 'fc'), series); break;
        case 'rc-time-constant':
          out = calcTimeConstant(requireNum(i.r, 'r'), requireNum(i.c, 'c'), num(i.targetPct, 'targetPct') ?? 63.2); break;
        case 'rl-cutoff':
          out = calcRlFilter(requireNum(i.r, 'r'), requireNum(i.l, 'l')); break;
        case 'rc-transfer':
          out = calcRcTransfer(requireNum(i.r, 'r'), requireNum(i.c, 'c'), requireNum(i.f, 'f'), (i.kind === 'highpass' ? 'highpass' : 'lowpass')); break;
        case '555-astable':
          out = calc555Astable(num(i.r1, 'r1'), num(i.r2, 'r2'), num(i.c, 'c'), num(i.f, 'f'), num(i.duty, 'duty'), series); break;
        case '555-monostable':
          out = calc555Monostable(num(i.r, 'r'), num(i.c, 'c'), num(i.pulseWidth, 'pulseWidth'), series); break;
        case 'opamp-gain':
          out = calcOpampGain(i.kind === 'noninverting' ? 'noninverting' : 'inverting', num(i.rinOrRg, 'rinOrRg'), num(i.rf, 'rf'), num(i.targetGain, 'targetGain'), series); break;
        case 'lm317':
          out = calcLm317(num(i.targetVout, 'targetVout'), num(i.r1, 'r1') ?? 240, num(i.r2, 'r2'), series); break;
        case 'zener-resistor':
          out = calcZenerResistor(requireNum(i.vin, 'vin'), requireNum(i.vz, 'vz'), requireNum(i.iLoad, 'iLoad'), num(i.izMin, 'izMin') ?? 0.005, series); break;
        case 'wheatstone':
          out = calcWheatstone(requireNum(i.vex, 'vex'), requireNum(i.r1, 'r1'), requireNum(i.r2, 'r2'), requireNum(i.r3, 'r3'), requireNum(i.r4, 'r4')); break;
        case 'transformer':
          out = calcTransformer(requireNum(i.vin, 'vin'), requireNum(i.n1, 'n1'), requireNum(i.n2, 'n2'), num(i.pLoad, 'pLoad')); break;
        case 'power':
          out = calcPower(num(i.v, 'v'), num(i.i, 'i'), num(i.r, 'r')); break;
        case 'db':
          out = calcDb(num(i.db, 'db'), num(i.linear, 'linear'), !!i.power, num(i.dbm, 'dbm'), num(i.impedance, 'impedance')); break;
        case 'resistor-network':
          out = calcResistorNetwork((Array.isArray(i.values) ? i.values : []).map((v: any, k: number) => requireNum(v, `values[${k}]`)), i.mode === 'series' ? 'series' : 'parallel'); break;
        case 'reactance':
          out = calcReactance(requireNum(i.f, 'f'), num(i.c, 'c'), num(i.l, 'l')); break;
        case 'base-resistor':
          out = calcBaseResistor(requireNum(i.vDrive, 'vDrive'), num(i.vbe, 'vbe') ?? 0.7, requireNum(i.icTarget, 'icTarget'), requireNum(i.hfeMin, 'hfeMin'), num(i.saturationFactor, 'saturationFactor') ?? 5, series); break;
        case 'energy':
          out = calcEnergy(num(i.c, 'c'), num(i.l, 'l'), num(i.v, 'v'), num(i.i, 'i')); break;
        case 'rms':
          out = calcRms(requireNum(i.peak, 'peak'), (['sine', 'square', 'triangle'] as const).includes(i.waveform) ? i.waveform : 'sine'); break;
        case 'battery-life':
          out = calcBatteryLife(requireNum(i.capacityMah, 'capacityMah'), requireNum(i.currentMa, 'currentMa'), num(i.derating, 'derating') ?? 0.8); break;
        case 'dcdc':
          out = calcDcDc(requireNum(i.vin, 'vin'), requireNum(i.vout, 'vout'), i.kind === 'boost' ? 'boost' : 'buck'); break;
        case 'e-series':
          out = calcESeries(requireNum(i.value, 'value'), series); break;
        default:
          return { ok: false, error: `Unknown formula "${args.formula}". Available: ${Object.keys(FORMULA_DESCRIPTIONS).join(', ')}` };
      }
      return { ok: true, result: { ...out, requestedFormula: args.formula, availableFormulas: Object.keys(FORMULA_DESCRIPTIONS) } };
    } catch (e) {
      return { ok: false, error: (e as Error).message, result: { formula: args.formula, availableFormulas: Object.keys(FORMULA_DESCRIPTIONS) } };
    }
  },
};

function requireNum(v: unknown, name: string): number {
  const n = num(v, name);
  if (n === undefined) throw new Error(`Missing required input "${name}" for this formula`);
  return n;
}

export { designCalculateTool };
