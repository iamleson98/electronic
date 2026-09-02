// Non-linear device helpers — Newton-Raphson convergence machinery ported
// from Falstad/CircuitJS1 (Diode.java / TransistorElm.java, SPICE 3f5 lineage).
//
// The exponential I-V of a P-N junction is the textbook hard case for Newton
// iteration: a raw new operating voltage of, say, +1 V with Is = 1e-14 maps to
// e^38 ≈ 3e16 A — the linearization explodes and the iteration diverges.
// SPICE and CircuitJS1 solve this with **voltage limiting** (limitStep): the
// proposed junction voltage is walked along the exponential curve so the
// linearized current grows at most by a factor of e per iteration.
//
// Reference: circuitjs1 Diode.java limitStep() (GPL-2.0, Paul Falstad &
// Iain Sharp). Verified against SPICE 3f5 diode.c `DIOlimit`.

/** Thermal voltage Vt = k·T/q at temperature T (K). */
export function thermalVoltage(celsius: number): number {
  const T = celsius + 273.15;
  return (1.380649e-23 * T) / 1.602176634e-19; // ≈ 25.7 mV at 27 °C
}

/**
 * Critical voltage of a junction exponential — the point where the tangent
 * from the origin touches the I-V curve. Beyond it the exponential is so
 * steep that Newton steps must be limited.
 *
 * CircuitJS1: `vcrit = vscale * log(vscale / (sqrt(2) * leakage))`
 * where vscale = n·Vt and leakage = Is.
 */
export function junctionVCrit(vscale: number, saturationCurrent: number): number {
  return vscale * Math.log(vscale / (Math.sqrt(2) * Math.max(saturationCurrent, 1e-30)));
}

/**
 * Limit a junction's new Newton iterate (CircuitJS1 Diode.limitStep port).
 *
 * If the proposed `vnew` would move the linearized current by more than a
 * factor of e² (checked via the critical voltage), walk it back along the
 * exponential so the tangent model's current matches — guaranteeing the
 * iteration contracts. Returns the (possibly) limited voltage. The caller
 * should treat a limited step as "not converged yet".
 *
 * @param vnew   proposed junction voltage from this Newton round
 * @param vold   junction voltage the current linearization used
 * @param vscale n·Vt (thermal voltage scaled by emission coefficient)
 * @param vcrit  critical voltage (junctionVCrit)
 */
export function limitStep(vnew: number, vold: number, vscale: number, vcrit: number): number {
  // Check new voltage: has the current changed by factor of e^2?
  if (vnew > vcrit && Math.abs(vnew - vold) > vscale + vscale) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vscale;
      if (arg > 0) {
        // adjust vnew so the current is the same as in the linearized model
        // from the previous iteration: current at vnew = old current * arg
        vnew = vold + vscale * Math.log(arg);
      } else {
        vnew = vcrit;
      }
    } else {
      // adjust vnew so the current is the same as in the linearized model
      // (1/vscale = slope of the load line)
      if (vnew > 0) vnew = vscale * Math.log(vnew / vscale);
      else vnew = 0;
    }
  }
  return vnew;
}

/**
 * Companion model of a Shockley junction at a given linearization point,
 * with gmin added (SPICE-style minimum conductance for matrix conditioning).
 *
 * I(v) = Is·(e^(v/vscale) − 1) + gmin·v
 * Linearized at v₀:  I ≈ g_eq·v + i_eq  with
 *   g_eq = Is·e^(v₀/vscale)/vscale + gmin
 *   i_eq = Is·(e^(v₀/vscale) − 1) − g_eq·v₀
 *
 * Stamp as: conductance g_eq between (a, k) + current source i_eq from
 * a to k (i(a→k) = g_eq·v + i_eq — same convention as the capacitor
 * companion in passive.ts).
 */
export function shockleyCompanion(
  v0: number,
  saturationCurrent: number,
  vscale: number,
  gmin: number,
): { g: number; iEq: number; i0: number } {
  // Clamp the exponent: beyond e^40 the double would overflow in the
  // current source term even though g stays finite — this also matches
  // the "explosion guard" every SPICE has.
  const x = Math.min(v0 / vscale, 40);
  const ev = Math.exp(x);
  const i0 = saturationCurrent * (ev - 1);
  const g = (saturationCurrent * ev) / vscale + gmin;
  const iEq = i0 - g * v0;
  return { g, iEq, i0 };
}

/**
 * SPICE-style escalating gmin for non-converging Newton loops.
 *
 * CircuitJS1: after 100 subiterations, gmin ramps as
 *   gmin = 10^(−9·(1 − iter/300))
 * capped at 0.1 S. ngspice does the same in `NotreCont()`. The engine
 * exposes the current Newton round index so stamps can pick this up.
 */
export function escalateGmin(round: number): number {
  if (round < 100) return 1e-12;
  const g = Math.exp(-9 * Math.log(10) * (1 - round / 300));
  return Math.min(g, 0.1);
}

/**
 * PN junction depletion capacitance (SPICE diode model):
 *   Cj(V) = Cjo / (1 − V/Vj)^M   for V < FC·Vj
 *   Beyond FC·Vj SPICE switches to a linear continuation that matches the
 *   value AND the slope at the switch point (avoids the singularity at
 *   V = Vj while staying C⁰/C¹ continuous):
 *   Cj(V) = Cjo·F1·[1 + M·(V − FC·Vj)/((1−FC)·Vj)],  F1 = (1−FC)^(−M)
 */
export function junctionCapacitance(
  v: number,
  cjo: number,
  vj: number,
  m: number,
  fc = 0.5,
): number {
  if (cjo <= 0 || vj <= 0) return 0;
  if (v < fc * vj) {
    const den = Math.max(1 - v / vj, 1e-6); // guard the singularity
    return cjo / Math.pow(den, m);
  }
  const f1 = Math.pow(1 - fc, -m);
  return cjo * f1 * (1 + (m * (v - fc * vj)) / ((1 - fc) * vj));
}
