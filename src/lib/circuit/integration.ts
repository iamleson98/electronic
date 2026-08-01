// Integration methods — Trapezoidal (2nd-order) and Gear (variable order).
//
// These provide higher-accuracy alternatives to backward Euler for capacitor
// and inductor companion models. They are exported as standalone helper
// functions that can be plugged into a custom stamp() override.
//
// Backward Euler (existing) is preserved unchanged — plugins keep using their
// current stamp() logic by default. New integration is opt-in via SimOptions.method.

import type { MnaSystem, SimContext } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Capacitor companion model
//
// Backward Euler:  G_eq = C/dt,  I_eq = (C/dt)*vPrev
// Trapezoidal:     G_eq = 2C/dt, I_eq = (2C/dt)*vPrev + I_prev_eq
//                  where I_prev_eq is the current at the previous time step
//                  (which equals (C/dt)*(vNow-vPrev) — folded into I_eq as (2C/dt)*vPrev)
//                  plus the stored current from last iteration.
//                  Trap requires tracking I_eq from the previous step (state).
//
// Trapezoidal capacitor:
//   i_n = C/dt * (v_n - v_{n-1}) * 2 - i_{n-1}
//   => I_eq = (2C/dt)*vPrev - iPrev
//   => G_eq = 2C/dt
//
// Gear-2 capacitor:
//   i_n = (2C/dt) * (v_n - v_{n-1}) - (C/(2dt)) * (v_{n-1} - v_{n-2})
//   (slightly different coefficients than trapezoidal)
// ─────────────────────────────────────────────────────────────────────────────

export interface IntegratorState {
  vPrev: number;     // voltage across the element at the previous step
  vPrev2?: number;   // voltage two steps back (for Gear-2)
  iPrev?: number;    // current through the element at the previous step (for trap)
  iPrev2?: number;   // current two steps back (for inductor Gear-2)
}

export interface CompanionModel {
  gEq: number;       // equivalent conductance to stamp
  iEq: number;       // equivalent current source to stamp (flows from + to -)
  newState: IntegratorState;
}

/**
 * Capacitor companion model — Trapezoidal integration (2nd order).
 * Required state: vPrev AND iPrev (current through cap at previous step).
 * Trap is exact for linear ramps (no error).
 */
export function capTrapezoidal(
  C: number, dt: number, vPrev: number, iPrev: number,
): CompanionModel {
  const gEq = (2 * C) / dt;
  // I_eq flows from + terminal to - terminal internally
  // i_n = (2C/dt)*(v_n - vPrev) - iPrev
  // => stamp i_n with I_eq = (2C/dt)*vPrev - (-iPrev) = (2C/dt)*vPrev + iPrev
  // Wait, let me re-derive: we want to solve KCL where the cap appears as
  //   i_n + iEq = gEq * v_n
  // Substituting trap formula:
  //   i_n = (2C/dt)*(v_n - vPrev) - iPrev = gEq*v_n - gEq*vPrev - iPrev
  // So I_eq (constant current source to subtract) = gEq*vPrev + iPrev
  // (i.e., the stamp currentSource(a, b, iEq) where +a-b direction)
  const iEq = gEq * vPrev + iPrev;
  return {
    gEq,
    iEq,
    newState: { vPrev, iPrev },   // caller will update vPrev = current v, iPrev = computed i_n
  };
}

/**
 * Capacitor companion model — Gear order 2.
 * Required state: vPrev AND vPrev2 (voltage 2 steps back).
 */
export function capGear2(
  C: number, dt: number, vPrev: number, vPrev2: number,
): CompanionModel {
  // Gear-2 polynomial approximation:
  //   y(n) = (3*y_n - 4*y_{n-1} + y_{n-2}) / (2*dt)
  // For capacitor: i = C * dv/dt = C * (3v_n - 4vPrev + vPrev2) / (2*dt)
  // => G_eq = 3C/(2dt), I_eq = -C*(-4vPrev + vPrev2)/(2dt) = C*(4vPrev - vPrev2)/(2dt)
  const gEq = (3 * C) / (2 * dt);
  const iEq = C * (4 * vPrev - vPrev2) / (2 * dt);
  return { gEq, iEq, newState: { vPrev, vPrev2 } };
}

/**
 * Inductor companion model — Trapezoidal integration.
 * Required state: iPrev AND vPrev (voltage across L at previous step).
 * Trap: v_n = (2L/dt)*(i_n - iPrev) - vPrev
 *   => stamp as voltage source with V_eq = -(2L/dt)*iPrev - vPrev and series R = 2L/dt
 *   Or equivalently (Norton form): G_eq = dt/(2L), I_eq = iPrev + (dt/(2L))*vPrev
 */
export function inductorTrapezoidal(
  L: number, dt: number, iPrev: number, vPrev: number,
): CompanionModel {
  const gEq = dt / (2 * L);
  const iEq = iPrev + (dt / (2 * L)) * vPrev;
  return { gEq, iEq, newState: { vPrev, iPrev } };
}

/**
 * Inductor companion model — Gear order 2.
 */
export function inductorGear2(
  L: number, dt: number, iPrev: number, iPrev2: number,
): CompanionModel {
  // i_n = (4*iPrev - iPrev2)/3 + (2dt/(3L))*v_n
  const gEq = (2 * dt) / (3 * L);
  const iEq = (4 * iPrev - iPrev2) / 3;
  return { gEq, iEq, newState: { vPrev: iPrev, iPrev2 } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trap oscillation detection
// Trapezoidal can produce numerical oscillations when the time step is too large
// relative to the time constant. Detect by comparing charge at n-1 with n-2.
// If |q_n - q_n-1| > 10*|q_n-1 - q_n-2| then we have oscillation.
// ─────────────────────────────────────────────────────────────────────────────

export function detectTrapOscillation(
  vHistory: number[],
  chgtol: number = 1e-14,
): boolean {
  if (vHistory.length < 4) return false;
  const n = vHistory.length;
  // Detect alternating sign pattern in differences
  const dn = vHistory[n - 1] - vHistory[n - 2];
  const dn1 = vHistory[n - 2] - vHistory[n - 3];
  const dn2 = vHistory[n - 3] - vHistory[n - 4];
  if (Math.abs(dn1) < chgtol) return false;
  // oscillation: signs of consecutive differences alternate
  return (dn * dn1 < 0) && (dn1 * dn2 < 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive timestep controller
// Controls dt based on the rate of change of node voltages.
// If max(dv/dt) is large, reduce dt; if small, increase dt.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdaptiveTimestepController {
  dtMin: number;
  dtMax: number;
  /** factor by which to grow/shrink dt (default 2 / 0.5) */
  growFactor: number;
  shrinkFactor: number;
  /** target max voltage change per step */
  targetMaxDV: number;
}

export function adaptTimestep(
  controller: AdaptiveTimestepController,
  dt: number,
  vPrev: Float64Array,
  vNow: Float64Array,
): number {
  let maxDV = 0;
  for (let i = 0; i < vNow.length; i++) {
    const dv = Math.abs(vNow[i] - (vPrev[i] ?? 0));
    if (dv > maxDV) maxDV = dv;
  }
  let newDt = dt;
  if (maxDV > controller.targetMaxDV * 2) {
    newDt = dt * controller.shrinkFactor;
  } else if (maxDV < controller.targetMaxDV * 0.5) {
    newDt = dt * controller.growFactor;
  }
  return Math.max(controller.dtMin, Math.min(controller.dtMax, newDt));
}

export const DEFAULT_TRAP_CONTROLLER: AdaptiveTimestepController = {
  dtMin: 1e-9,
  dtMax: 1e-3,
  growFactor: 1.5,
  shrinkFactor: 0.5,
  targetMaxDV: 0.1,  // V
};
