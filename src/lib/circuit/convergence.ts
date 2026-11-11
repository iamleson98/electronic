// Convergence aids — gmin stepping, source stepping, pseudo-transient.
//
// These wrap solveDC to provide multiple fallback strategies when the basic
// Newton-Raphson iteration fails to converge. They are entirely opt-in:
// the existing solveDC() function is unchanged.

import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from './types';
import { solveDC, buildNodeMap, getTerminalsForComponent, stampFloatingGmin, dcGminStepping, dcSourceStepping } from './engine';
import { createMnaSystem, solveMna } from './solver';
import { mergeOptions, type SimOptions, type ConvergenceReport, reportOK, reportFail, dcSolveOpts } from './sim-options';

// ─────────────────────────────────────────────────────────────────────────────
// Gmin stepping
//   - Add a large conductance gmin_start from every node to ground (e.g., 1e-3 S)
//   - Solve DC operating point (this is well-conditioned because the gmin
//     conductances dominate and break any floating loops).
//   - Reduce gmin by a factor (typically 10×) and re-solve.
//   - Repeat until gmin reaches the actual value (typically 1e-12 S).
//
// Implemented by engine.dcGminStepping: the shunt is a simulateStep option
// (no cloned circuit) and every level is warm-started from the previous one,
// with the step factor adapting (grow on success, sqrt on failure) like
// ngspice's dynamic gmin.
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
  const directResult = solveDC(components, wires, plugins, options.itl1, dcSolveOpts(options, false));
  if (directResult) {
    return { sim: directResult, report: reportOK(0, 0) };
  }
  attempts.push('plain newton');

  // 2. Warm-started, adaptive gmin stepping (shunt 1e-2 S → gmin target,
  //    then a clean no-shunt solve). See engine.dcGminStepping.
  const gminTarget = options.gmin ?? 1e-12;
  const stepped = dcGminStepping(components, wires, plugins, options.itl1, dcSolveOpts(options, false).simOptions, gminTarget);
  attempts.push('gmin stepping (warm-started, adaptive)');
  if (stepped) return { sim: stepped, report: reportOK(attempts.length, 0) };
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

  // Ramp all independent sources 0 → 100 % with an adaptive step, each solve
  // warm-started from the previous one and the ramp finishing on an exact
  // alpha = 1 solve. See engine.dcSourceStepping.
  const stepped = dcSourceStepping(components, wires, plugins, options.itl1, dcSolveOpts(options, false).simOptions);
  if (stepped) {
    attempts.push('source stepping (reached alpha=1)');
    return { sim: stepped, report: reportOK(attempts.length, 0) };
  }
  attempts.push('source stepping (stalled)');
  return { sim: null, report: reportFail('source_step_failed', 'source stepping stalled before alpha=1', attempts) };
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

  // Pseudo-transient convergence: attach a large capacitor (1F) from every
  // non-ground node to ground, then run a transient simulation. The capacitors
  // act as "shock absorbers" that prevent Newton-Raphson from diverging as the
  // system evolves from its initial state (all zeros) toward the DC operating
  // point. After t = t_final, the voltages have settled to the DC solution.
  //
  // Implementation: we add a high conductance (gmin) from each node to ground
  // and gradually reduce it. This is equivalent to adding 1F caps with dt
  // stepping, but numerically simpler — no need to modify the component list.
  // The gmin starts at 1 S (1 Ω to ground) and decays by 10× each iteration
  // until it reaches the target gmin (default 1e-12 S = 1 TΩ).

  attempts.push('pseudo-transient (gmin stepping)');
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes;
  const numNonGround = numNodes - 1; // matrix rows/cols for node voltages

  // Build a wrapper around the MNA system that adds gmin conductances.
  // We use a "virtual" MNA system that intercepts stamp calls and adds the
  // gmin conductance from each node to ground after stamping.
  const gminStart = 1.0;        // 1 S = 1 Ω to ground (very stiff)
  const gminTarget = options.gmin ?? 1e-12;
  const gminDecay = 0.1;        // reduce gmin by 10× each iteration
  const maxIter = Math.max(30, options.itl4 ?? 50);

  let gmin = gminStart;
  let converged = false;
  let prevVoltages = new Float64Array(numNodes);
  let delta = Infinity;
  let finalSim: SimContext | null = null;

  let declaredExtras = 0;
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (plugin?.extraVars) declaredExtras += plugin.extraVars(comp.parameters);
  }
  const extraBudget = components.length * 4 + 8 + declaredExtras;

  for (let iter = 0; iter < maxIter; iter++) {
    // Create a sim context with the current gmin
    const sim: SimContext = {
      nodeVoltage: new Float64Array(numNodes),
      branchCurrent: new Float64Array(extraBudget),
      time: 0,
      dt: 1e-3,
      state: { __pseudo_tran: true, __gmin: gmin },
    };

    // Build the MNA system. NOTE: createMnaSystem expects the NON-GROUND
    // node count (matrix index of node k is k−1) — passing numNodes created
    // a phantom never-stamped row/column and made the matrix singular on
    // every iteration, so pseudo-transient could never succeed.
    const sys = createMnaSystem(numNonGround, extraBudget);
    sys.nextExtra = numNonGround;
    stampFloatingGmin(sys, nodeMap);

    // Stamp all components
    for (const comp of components) {
      const plugin = plugins.get(comp.type);
      if (!plugin) continue;
      const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
      try {
        plugin.stamp?.(comp.parameters, terminals, sys, sim, comp);
      } catch {
        // ignore stamping errors during pseudo-tran
      }
    }

    // Add gmin conductance from each non-ground node to ground
    for (let i = 1; i < numNodes; i++) {
      sys.stampConductance(i, 0, gmin);
    }

    // Shrink to the used block (mirrors the engine's compaction)
    const actualSize = sys.nextExtra;
    if (actualSize < sys.size) {
      const newA = new Float64Array(actualSize * actualSize);
      const newZ = new Float64Array(actualSize);
      for (let r = 0; r < actualSize; r++) {
        for (let c = 0; c < actualSize; c++) {
          newA[r * actualSize + c] = sys.A[r * sys.size + c];
        }
        newZ[r] = sys.z[r];
      }
      sys.A = newA;
      sys.z = newZ;
      sys.size = actualSize;
      sys.numExtra = actualSize - numNonGround;
    }

    // Solve
    const sol = solveMna(sys);
    if (!sol) {
      attempts.push(`iter ${iter}: singular matrix at gmin=${gmin.toExponential(2)}`);
      gmin *= gminDecay;
      if (gmin < gminTarget) break;
      continue;
    }

    // Update sim voltages. nodeVoltage is node-id indexed (0 = ground), so
    // node i's voltage is sol[i−1] — the old code copied sol[i] directly,
    // shifting every node reading by one.
    for (let i = 0; i < numNodes; i++) {
      sim.nodeVoltage[i] = i === 0 ? 0 : (sol[i - 1] ?? 0);
    }
    // Branch currents: extra variable j lives at matrix index numNonGround + j
    for (let j = 0; j < sys.numExtra && j < sim.branchCurrent.length; j++) {
      sim.branchCurrent[j] = sol[numNonGround + j] ?? 0;
    }

    // Check convergence: max delta between iterations
    delta = 0;
    for (let i = 0; i < numNodes; i++) {
      const d = Math.abs(sim.nodeVoltage[i] - prevVoltages[i]);
      if (d > delta) delta = d;
    }
    prevVoltages = Float64Array.from(sim.nodeVoltage);
    finalSim = sim;

    attempts.push(`iter ${iter}: gmin=${gmin.toExponential(2)}, delta=${delta.toExponential(2)}`);

    if (gmin <= gminTarget && delta < (options.reltol ?? 1e-3) * 1e-3) {
      converged = true;
      break;
    }

    gmin *= gminDecay;
    if (gmin < gminTarget) gmin = gminTarget;
  }

  if (!converged) {
    return { sim: null, report: reportFail('pseudo_tran_failed', `did not converge after ${maxIter} iterations (final delta=${delta.toExponential(2)}, gmin=${gmin.toExponential(2)})`, attempts) };
  }
  return { sim: finalSim, report: { converged: true, iterations: maxIter, finalDelta: delta, attempts } };
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
  const direct = solveDC(components, wires, plugins, options.itl1, dcSolveOpts(options, false));
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
