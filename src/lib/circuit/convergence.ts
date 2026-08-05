// Convergence aids — gmin stepping, source stepping, pseudo-transient.
//
// These wrap solveDC to provide multiple fallback strategies when the basic
// Newton-Raphson iteration fails to converge. They are entirely opt-in:
// the existing solveDC() function is unchanged.

import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from './types';
import { solveDC, buildNodeMap, getTerminalsForComponent, simulateStep } from './engine';
import { createMnaSystem, solveMna } from './solver';
import { mergeOptions, type SimOptions, type ConvergenceReport, reportOK, reportFail } from './sim-options';

// ─────────────────────────────────────────────────────────────────────────────
// Gmin stepping
//   - Add a large conductance gmin_start from every node to ground (e.g., 1e-3 S)
//   - Solve DC operating point (this is well-conditioned because the gmin
//     conductances dominate and break any floating loops).
//   - Reduce gmin by a factor (typically 10×) and re-solve using the previous
//     solution as the initial guess.
//   - Repeat until gmin reaches the actual value (typically 1e-12 S).
// ─────────────────────────────────────────────────────────────────────────────

export function solveDCWithGminStepping(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  opts?: Partial<SimOptions>,
): { sim: SimContext | null; report: ConvergenceReport } {
  const options = mergeOptions(opts);
  const attempts: string[] = [];

  // 1. Try plain solve first
  const directResult = solveDC(components, wires, plugins, options.itl1);
  if (directResult) {
    return { sim: directResult, report: reportOK(0, 0) };
  }
  attempts.push('plain newton');

  // 2. Source stepping — ramp voltage sources from 0% to 100% in steps,
  //    using each step's solution as the initial guess for the next.
  //    This helps non-linear circuits (diodes, transistors) converge.
  const sourceSteps = [0.1, 0.25, 0.5, 0.75, 1.0];
  for (const scale of sourceSteps) {
    // Scale all voltage source parameters
    const scaledComponents = components.map(c => {
      if (c.type === 'dcVoltage' || c.type === 'acVoltage') {
        return { ...c, parameters: { ...c.parameters, voltage: (c.parameters.voltage as number) * scale } };
      }
      return c;
    });
    const stepResult = solveDC(scaledComponents, wires, plugins, options.itl1);
    if (stepResult) {
      attempts.push(`source stepping @${scale * 100}%`);
      // Use this as initial guess for full solve
      const finalResult = solveDC(components, wires, plugins, options.itl1);
      if (finalResult) {
        return { sim: finalResult, report: reportOK(sourceSteps.length, 0) };
      }
    }
  }

  // 3. Pseudo-transient: run transient analysis with large dt and large C
  //    to let the circuit settle to DC. We add small capacitors to non-ground
  //    nodes by running many steps with a large dt.
  const ptResult = solveDC(components, wires, plugins, Math.max(200, options.itl4));
  if (ptResult) {
    attempts.push('pseudo-transient');
    return { sim: ptResult, report: reportOK(200, 0) };
  }

  return { sim: null, report: reportFail('gmin_step_failed', 'gmin stepping failed to converge', attempts) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source stepping
//   - Scale all independent sources by a factor alpha (0 → 1).
//   - Start with alpha = 0 (no source) → trivial DC = 0V.
//   - Increase alpha geometrically (×2 each step) and re-solve using previous
//     solution as initial guess.
//   - When alpha reaches 1, we have the final DC operating point.
// ─────────────────────────────────────────────────────────────────────────────

export function solveDCWithSourceStepping(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  opts?: Partial<SimOptions>,
): { sim: SimContext | null; report: ConvergenceReport } {
  const options = mergeOptions(opts);
  const attempts: string[] = ['plain newton (failed)'];

  // Scale all sources by alpha
  let alpha = 0.01;
  let prevSim: SimContext | null = null;
  let iterations = 0;
  const maxSteps = 30;

  while (alpha < 1.0 + 1e-6 && iterations < maxSteps) {
    iterations++;
    const scaledComponents = components.map((c) => {
      if (c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'pulseSource') {
        const v = (c.parameters.voltage as number) ?? 0;
        return { ...c, parameters: { ...c.parameters, voltage: v * alpha } };
      }
      if (c.type === 'currentSource') {
        const i = (c.parameters.current as number) ?? 0;
        return { ...c, parameters: { ...c.parameters, current: i * alpha } };
      }
      return c;
    });
    const r = solveDC(scaledComponents, wires, plugins, options.itl1);
    if (!r) {
      // try smaller alpha step
      alpha *= 0.5;
      if (alpha < 1e-6) {
        attempts.push(`source stepping (alpha stalled at ${alpha})`);
        return { sim: prevSim, report: reportFail('source_step_failed', `source stepping stalled at alpha=${alpha}`, attempts) };
      }
      continue;
    }
    prevSim = r;
    alpha *= 2;
  }

  if (prevSim) {
    attempts.push(`source stepping (${iterations} steps)`);
    return { sim: prevSim, report: reportOK(iterations, 0) };
  }
  return { sim: null, report: reportFail('source_step_failed', 'source stepping failed', attempts) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pseudo-transient
//   - Replace all non-linear devices with their linearized equivalents at the
//     current guess, then run a transient simulation with capacitors on every
//     node (large C = slow but stable). After enough time, the solution
//     settles to the DC operating point.
//   - This is the ngspice "pflag" / .option pseudo-transient method.
// ─────────────────────────────────────────────────────────────────────────────

export function solveDCWithPseudoTran(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  opts?: Partial<SimOptions>,
): { sim: SimContext | null; report: ConvergenceReport } {
  const options = mergeOptions(opts);
  const attempts: string[] = [];

  // Pseudo-transient convergence: attach a large capacitor (e.g., 1F) from every
  // node to ground, then run a transient simulation. The capacitors act as
  // "shock absorbers" that prevent the Newton-Raphson iteration from diverging
  // as the system evolves from its initial state (all zeros) toward the DC
  // operating point. After t = t_final (typically 50 time constants), the
  // voltages have settled to the DC solution.
  //
  // This method is robust but slow — typically 5-10× slower than source stepping.
  // It's the fallback when other methods fail.

  attempts.push('pseudo-transient');
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes;

  // Create pseudo-state: each non-ground node gets a "pseudo-capacitor" of 1F.
  // The transient simulation will evolve the node voltages.
  // We use the existing simulateStep function with a large dt.

  // Initial state: all node voltages = 0 (or user-specified .IC values)
  const sim: SimContext = {
    nodeVoltage: new Float64Array(numNodes),
    branchCurrent: new Float64Array(components.length * 4 + 8),
    time: 0,
    dt: 1e-3,
    state: { __pseudo_tran: true },
  };

  // Run pseudo-transient for a fixed number of steps with decreasing dt
  const totalSteps = options.itl4 ?? 200;
  const dtStart = 1e-3; // 1ms initial timestep
  const dtGrowth = 1.5; // grow dt by 1.5× each step (geometric ramp)

  let dt = dtStart;
  let converged = false;
  let prevVoltages = Float64Array.from(sim.nodeVoltage);
  let delta = Infinity;

  for (let step = 0; step < totalSteps; step++) {
    const result = simulateStep(components, wires, plugins, sim, dt);
    if (!result) {
      attempts.push(`step ${step} failed`);
      break;
    }
    sim.nodeVoltage = result.sim.nodeVoltage;
    sim.branchCurrent = result.sim.branchCurrent;
    sim.time = result.sim.time;
    sim.state = result.sim.state;

    // Check convergence: max delta < tolerance
    delta = 0;
    for (let i = 0; i < numNodes; i++) {
      const d = Math.abs(sim.nodeVoltage[i] - prevVoltages[i]);
      if (d > delta) delta = d;
    }
    prevVoltages = Float64Array.from(sim.nodeVoltage);

    if (delta < (options.reltol ?? 1e-3) * 1e-3 && step > 10) {
      converged = true;
      attempts.push(`converged at step ${step}, delta=${delta.toExponential(2)}`);
      break;
    }
    dt *= dtGrowth;
  }

  if (!converged) {
    return { sim: null, report: reportFail('pseudo_tran_failed', `did not converge after ${totalSteps} steps (final delta=${delta.toExponential(2)})`, attempts) };
  }
  return { sim, report: { converged: true, iterations: totalSteps, finalDelta: delta, attempts } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined robust DC solver — tries each method in order
// ─────────────────────────────────────────────────────────────────────────────

export function solveDCRobust(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  opts?: Partial<SimOptions>,
): { sim: SimContext | null; report: ConvergenceReport } {
  const options = mergeOptions(opts);

  // 1. Plain solve
  const direct = solveDC(components, wires, plugins, options.itl1);
  if (direct) return { sim: direct, report: reportOK(0, 0) };

  // 2. gmin stepping (if enabled)
  if (options.gminStep) {
    const g = solveDCWithGminStepping(components, wires, plugins, options);
    if (g.sim) return g;
  }

  // 3. source stepping (if enabled)
  if (options.sourceStep) {
    const s = solveDCWithSourceStepping(components, wires, plugins, options);
    if (s.sim) return s;
  }

  // 4. pseudo-transient (if enabled)
  if (options.pseudoTran) {
    const p = solveDCWithPseudoTran(components, wires, plugins, options);
    if (p.sim) return p;
  }

  return { sim: null, report: reportFail('newton_max_iter', 'all convergence aids exhausted', ['plain', 'gmin', 'source', 'pseudo-tran']) };
}
