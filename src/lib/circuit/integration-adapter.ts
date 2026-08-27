// Integration adapter — connects capacitor/inductor plugins to the trap/Gear2
// methods in integration.ts.
//
// The capacitor and inductor plugins in passive.ts currently hard-code backward
// Euler. This module provides a single `stampReactive` function that:
//   1. Reads the integration method from the sim context
//   2. Calls the appropriate companion model (capTrapezoidal / capGear2 / backward Euler)
//   3. Stamps the result into the MNA system
//   4. Updates the integrator state for the next step
//
// The method is selected via `simOptions.method` which defaults to 'euler' for
// backward compatibility. Plugins can opt in by calling `stampReactive` instead
// of their inline backward-Euler logic.

import type { MnaSystem, SimContext } from './types';
import { capTrapezoidal, capGear2, inductorTrapezoidal, inductorGear2, type IntegratorState } from './integration';

export type IntegrationMethod = 'euler' | 'trap' | 'gear';

export interface ReactiveState {
  vPrev: number;
  vPrev2?: number;
  iPrev?: number;
  iPrev2?: number;
}

/**
 * Stamp a capacitor into the MNA system using the selected integration method.
 *
 * @param a          positive terminal node ID
 * @param b          negative terminal node ID
 * @param C          capacitance (farads)
 * @param dt         timestep (seconds)
 * @param sys        MNA system to stamp into
 * @param sim        simulation context (for state storage)
 * @param compId     component ID (for state keying)
 * @param method     integration method ('euler' | 'trap' | 'gear')
 * @param initialV   initial voltage across the cap (used on first step)
 */
export function stampCapacitor(
  a: number,
  b: number,
  C: number,
  dt: number,
  sys: MnaSystem,
  sim: SimContext,
  compId: string,
  method: IntegrationMethod = 'euler',
  initialV: number = 0,
): void {
  const st = sim.state.__global ?? (sim.state.__global = {});
  const key = `cap_${compId}`;
  const state: ReactiveState = st[key] ?? { vPrev: initialV };
  const vPrev = state.vPrev;
  const dtSafe = Math.max(dt, 1e-12);
  const CSafe = Math.max(C, 1e-15);

  let gEq: number;
  let iEq: number;
  let newState: ReactiveState;

  if (method === 'trap') {
    // Trapezoidal: needs iPrev (current through cap at previous step)
    const iPrev = state.iPrev ?? 0;
    const companion = capTrapezoidal(CSafe, dtSafe, vPrev, iPrev);
    gEq = companion.gEq;
    iEq = companion.iEq;
    // The new iPrev for next step = gEq*v_n - iEq (the cap current at step n)
    // We'll compute it in the step() callback — for now, store the companion state
    newState = { vPrev: vPrev, iPrev: iPrev }; // updated in step()
  } else if (method === 'gear') {
    const vPrev2 = state.vPrev2 ?? vPrev;
    const companion = capGear2(CSafe, dtSafe, vPrev, vPrev2);
    gEq = companion.gEq;
    iEq = companion.iEq;
    newState = { vPrev: vPrev, vPrev2: vPrev2 };
  } else {
    // Backward Euler (default, existing behavior)
    gEq = CSafe / dtSafe;
    iEq = (CSafe / dtSafe) * vPrev;
    newState = { vPrev };
  }

  sys.stampConductance(a, b, gEq);
  sys.stampCurrentSource(b, a, iEq);
  st[key] = newState;
}

/**
 * Stamp an inductor into the MNA system using the selected integration method.
 *
 * @param a          positive terminal node ID
 * @param b          negative terminal node ID
 * @param L          inductance (henries)
 * @param dt         timestep (seconds)
 * @param sys        MNA system to stamp into
 * @param sim        simulation context (for state storage)
 * @param compId     component ID (for state keying)
 * @param method     integration method ('euler' | 'trap' | 'gear')
 * @param initialI   initial current through the inductor (used on first step)
 */
export function stampInductor(
  a: number,
  b: number,
  L: number,
  dt: number,
  sys: MnaSystem,
  sim: SimContext,
  compId: string,
  method: IntegrationMethod = 'euler',
  initialI: number = 0,
): void {
  const st = sim.state.__global ?? (sim.state.__global = {});
  const key = `ind_${compId}`;
  const state: ReactiveState = st[key] ?? { vPrev: 0, iPrev: initialI };
  const iPrev = state.iPrev ?? initialI;
  const dtSafe = Math.max(dt, 1e-12);
  const LSafe = Math.max(L, 1e-15);

  let gEq: number;
  let iEq: number;
  let newState: ReactiveState;

  if (method === 'trap') {
    const vPrev = state.vPrev ?? 0;
    const companion = inductorTrapezoidal(LSafe, dtSafe, iPrev, vPrev);
    gEq = companion.gEq;
    iEq = companion.iEq;
    newState = { vPrev, iPrev };
  } else if (method === 'gear') {
    const iPrev2 = state.iPrev2 ?? iPrev;
    const companion = inductorGear2(LSafe, dtSafe, iPrev, iPrev2);
    gEq = companion.gEq;
    iEq = companion.iEq;
    newState = { vPrev: 0, iPrev, iPrev2 };
  } else {
    // Backward Euler (default, existing behavior)
    // V = L * dI/dt → I_n = I_{n-1} + (dt/L) * V_n
    // Norton: I_eq = iPrev, G_eq = dt/L
    gEq = dtSafe / LSafe;
    iEq = iPrev;
    newState = { vPrev: 0, iPrev };
  }

  sys.stampConductance(a, b, gEq);
  // The inductor companion source carries iEq from a to b through the element
  // (same direction as the inductor current). This mirrors passive.ts's
  // backward-Euler stamp — stamping (b, a) would invert the source.
  sys.stampCurrentSource(a, b, iEq);
  st[key] = newState;
}

/**
 * Update the reactive state after a solve step.
 * Call this in the plugin's `step()` callback to record the current V/I
 * for use in the next step's companion model.
 */
export function updateCapacitorState(
  a: number,
  b: number,
  sim: SimContext,
  compId: string,
  method: IntegrationMethod = 'euler',
  C: number = 1e-6,
): void {
  const st = sim.state.__global ?? (sim.state.__global = {});
  const key = `cap_${compId}`;
  const state: ReactiveState = st[key] ?? { vPrev: 0 };
  const vNow = (sim.nodeVoltage[a] ?? 0) - (sim.nodeVoltage[b] ?? 0);
  const vPrev = state.vPrev ?? vNow;
  const dt = Math.max(sim.dt, 1e-12);

  if (method === 'gear') {
    // Gear-2 needs vPrev and vPrev2
    state.vPrev2 = vPrev;
  }
  state.vPrev = vNow;
  if (method === 'trap') {
    // Trapezoidal state update: i_n = (2C/dt)·(v_n − v_{n−1}) − i_{n−1}.
    // Zeroing iPrev here would silently degrade trap to plain Euler.
    const iPrev = state.iPrev ?? 0;
    state.iPrev = (2 * C / dt) * (vNow - vPrev) - iPrev;
  }
  st[key] = state;
}

/**
 * Update the inductor state after a solve step.
 */
export function updateInductorState(
  a: number,
  b: number,
  sim: SimContext,
  compId: string,
  method: IntegrationMethod = 'euler',
  L: number = 1e-3,
): void {
  const st = sim.state.__global ?? (sim.state.__global = {});
  const key = `ind_${compId}`;
  const state: ReactiveState = st[key] ?? { vPrev: 0, iPrev: 0 };
  const vNow = (sim.nodeVoltage[a] ?? 0) - (sim.nodeVoltage[b] ?? 0);
  const dt = Math.max(sim.dt, 1e-12);
  const LSafe = Math.max(L, 1e-15);

  if (method === 'gear') {
    state.iPrev2 = state.iPrev;
    // Gear-2: i_n = (4·i_{n−1} − i_{n−2})/3 + (2dt/3L)·v_n
    state.iPrev = (4 * (state.iPrev ?? 0) - (state.iPrev2 ?? 0)) / 3 + (2 * dt / (3 * LSafe)) * vNow;
  } else if (method === 'trap') {
    // Trapezoidal: i_n = i_{n−1} + (dt/2L)·(v_n + v_{n−1})
    state.iPrev = (state.iPrev ?? 0) + (dt / (2 * LSafe)) * (vNow + (state.vPrev ?? 0));
  } else {
    // Backward Euler: i_n = i_{n−1} + (dt/L)·v_n
    state.iPrev = (state.iPrev ?? 0) + (dt / LSafe) * vNow;
  }
  state.vPrev = vNow;
  st[key] = state;
}
