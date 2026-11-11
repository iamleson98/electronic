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
 * SPICE3 / ngspice DEVpnjlim — P-N junction voltage limiting.
 *
 * Unlike limitStep (CircuitJS1 flavour) this also limits the DOWNWARD
 * direction: a reverse-going iterate (vnew < 0) is clamped to at most one
 * volt below the previous iterate (or 2·|vold|+1 when vold ≤ 0), so a single
 * wild Newton step cannot throw an off junction to kilovolts and leave the
 * following rounds to crawl back. Forward steps past vcrit are compressed
 * logarithmically (vold + vt·(2 + ln(arg − 2))).
 *
 * The caller compares the result against vnew: any difference is SPICE's
 * `icheck` — the device limited, so the iteration has not converged.
 */
const PNJLIM_RAW_MAX = 20;
const PNJLIM_CEIL_VT = 10;
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      // `PNJLIM_RAW_MAX` bounds the raw Newton step the log compression sees: a
      // linearisation that asks for 1e5…1e12 V is numerical garbage (ill-conditioned
      // active-device cascades), and ln() of it would still kick the junction up by
      // ≈ 0.8 V = e^32 in current. Anything beyond a real 20 V swing is treated as 20 V.
      const arg = Math.max(-PNJLIM_RAW_MAX / vt, Math.min(PNJLIM_RAW_MAX / vt, (vnew - vold) / vt));
      vnew = arg > 0 ? vold + vt * (2 + Math.log(arg - 2)) : vold - vt * (2 + Math.log(2 - arg));
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
    // Evaluation ceiling (deviation from SPICE): repeated kicks from garbage
    // rounds would otherwise stack the junction several volts up, where the
    // tangent Newton step walks it back one Vt per round (130 rounds for 3.4 V).
    // vcrit + PNJLIM_CEIL_VT·Vt is ~e^PNJLIM_CEIL_VT × 18 mA ≈ 400 A — never a real operating point.
    const ceil = vcrit + PNJLIM_CEIL_VT * vt;
    if (vnew > ceil) vnew = ceil;
  } else if (vnew < 0) {
    const arg = vold > 0 ? -vold - 1 : 2 * vold - 1;
    if (vnew < arg) vnew = arg;
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
  // Explosion guard: past x = 200 (e^200 ≈ 7e86, far from overflow)
  // continue the exponential along its tangent. The old cap at x = 40 froze
  // the current instead — an LED (Is ≈ 1e-21, x ≈ 43 at 20 mA) or any
  // junction above ~1 V stopped conducting more as the voltage rose.
  const XMAX = 200;
  const x = Math.min(v0 / vscale, XMAX);
  const ev = Math.exp(x);
  const over = v0 - XMAX * vscale;
  const i0 = saturationCurrent * (ev - 1) + (over > 0 ? (saturationCurrent * ev / vscale) * over : 0);
  const g = (saturationCurrent * ev) / vscale + gmin;
  const iEq = i0 - g * v0;
  return { g, iEq, i0 };
}

/** Constant device gmin (SPICE GMIN). Not escalated per Newton round: the DC ladder owns gmin stepping. */
export const DEVICE_GMIN = 1e-12;

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
