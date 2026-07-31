// Simulation options — ngspice/KiCad parity.
//
// This module defines a SimOptions struct that controls solver behavior,
// convergence thresholds, integration method, and temperature.
//
// Existing functions continue to work unchanged when SimOptions is not passed
// (defaults are chosen to match the existing hard-coded constants).

import type { CircuitComponent, MnaSystem, SimContext } from './types';

export interface SimOptions {
  /** Relative tolerance — convergence requires |Δx| < reltol*|x| + abstol */
  reltol: number;        // default 1e-3
  /** Absolute tolerance for voltages */
  vntol: number;         // default 1e-6 V
  /** Absolute tolerance for currents */
  abstol: number;         // default 1e-12 A
  /** Minimum conductance added to all nodes to prevent singularity */
  gmin: number;            // default 1e-12 S
  /** Maximum iterations for DC operating point */
  itl1: number;            // default 100
  /** Maximum iterations for transient step (Newton) */
  itl2: number;            // default 50
  /** Maximum iterations at a time point with cutoff */
  itl4: number;            // default 10
  /** Pivot floor for LU decomposition */
  pivtol: number;          // default 1e-13
  /** Integration method: 'trap' (trapezoidal) | 'gear' | 'euler' (backward Euler) */
  method: 'trap' | 'gear' | 'euler';
  /** Max order for Gear integration (1..6) */
  maxord: number;          // default 2
  /** Temperature in °C */
  temp: number;            // default 27 (300.15 K)
  /** Nominal temperature (where model parameters are extracted) */
  tnom: number;            // default 27
  /** Initial time step for transient (will be adapted) */
  tstep: number;
  /** Stop time for transient */
  tstop: number;
  /** Start time for data output (no output before this) */
  tstart: number;
  /** Maximum internal timestep */
  tmax: number;
  /** Use initial conditions (.tran UIC) — skip DC bias point computation */
  uic: boolean;
  /** Charge error tolerance (for trap oscillation detection) */
  chgtol: number;
  /** Whether to attempt gmin stepping if Newton fails */
  gminStep: boolean;
  /** Whether to attempt source stepping if gmin stepping fails */
  sourceStep: boolean;
  /** Whether to attempt pseudo-transient as last resort */
  pseudoTran: boolean;
}

export const DEFAULT_OPTIONS: SimOptions = {
  reltol: 1e-3,
  vntol: 1e-6,
  abstol: 1e-12,
  gmin: 1e-12,
  itl1: 100,
  itl2: 50,
  itl4: 10,
  pivtol: 1e-13,
  method: 'euler',           // preserve existing behavior
  maxord: 2,
  temp: 27,
  tnom: 27,
  tstep: 1e-4,
  tstop: 10e-3,
  tstart: 0,
  tmax: 1e-3,
  uic: false,
  chgtol: 1e-14,
  gminStep: true,
  sourceStep: true,
  pseudoTran: true,
};

export function mergeOptions(opts?: Partial<SimOptions>): SimOptions {
  return { ...DEFAULT_OPTIONS, ...opts };
}

// Kelvin conversion helpers
export const C_TO_K = 273.15;
export function toKelvin(celsius: number): number { return celsius + C_TO_K; }

// ─────────────────────────────────────────────────────────────────────────────
// Convergence diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export type ConvergenceFailure =
  | 'singular_matrix'
  | 'newton_max_iter'
  | 'gmin_step_failed'
  | 'source_step_failed'
  | 'pseudo_tran_failed'
  | 'timestep_too_small'
  | 'trap_oscillation'
  | 'no_dc_path';

export interface ConvergenceReport {
  converged: boolean;
  iterations: number;
  failure?: ConvergenceFailure;
  message?: string;
  /** max abs voltage delta at convergence */
  finalDelta?: number;
  /** strategies attempted (for diagnostics) */
  attempts: string[];
}

export function reportOK(iterations: number, finalDelta: number): ConvergenceReport {
  return { converged: true, iterations, finalDelta, attempts: [] };
}

export function reportFail(failure: ConvergenceFailure, message: string, attempts: string[] = []): ConvergenceReport {
  return { converged: false, iterations: 0, failure, message, attempts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: apply gmin stepping — add 1/gminFactor conductance from each node to ground,
// then exponentially reduce it to actual gmin
// ─────────────────────────────────────────────────────────────────────────────

export function applyGminStepping(
  sys: MnaSystem,
  numNodes: number,
  gminStart: number = 1e-3,
  gminEnd: number = 1e-12,
  factor: number = 10,
): void {
  // Adds G[k] = gminStep from node k to ground (node 0)
  // The actual stepping logic happens in the solver loop, not here.
  // This function just adds the initial gmin.
  for (let n = 1; n < numNodes; n++) {
    sys.stampConductance(n, 0, gminStart);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: temperature-dependent parameter scaling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scale a resistance for temperature: R(T) = R0 * (1 + TC1*(T-T0) + TC2*(T-T0)^2)
 */
export function tempScaleResistance(r0: number, tc1: number, tc2: number, tCelsius: number, tnomCelsius: number): number {
  const dt = tCelsius - tnomCelsius;
  return r0 * (1 + tc1 * dt + tc2 * dt * dt);
}

/**
 * Scale a saturation current Is for temperature:
 *   Is(T) = Is(Tnom) * exp((T-Tnom)/Tnom * (Eg/kT) * (some factor))
 * Simplified: Is(T) = Is0 * 2^((T-Tnom)/10)
 */
export function tempScaleIs(is0: number, tCelsius: number, tnomCelsius: number): number {
  // doubling every 10°C is a rough rule-of-thumb (Ngspice uses proper Eg formula)
  const dt = tCelsius - tnomCelsius;
  return is0 * Math.pow(2, dt / 10);
}

/**
 * Thermal voltage Vt = kT/q
 *  k = 1.380649e-23 J/K
 *  q = 1.602176634e-19 C
 */
export function thermalVoltage(tCelsius: number): number {
  const T = toKelvin(tCelsius);
  return 1.380649e-23 * T / 1.602176634e-19;
}
