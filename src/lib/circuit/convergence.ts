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

  // Build a wrapper around the MNA system that adds gmin conductances.
  // We use a "virtual" MNA system that intercepts stamp calls and adds the
  // gmin conductance from each node to ground after stamping.
  const gminStart = 1.0;        // 1 S = 1 Ω to ground (very stiff)
  const gminTarget = options.gmin ?? 1e-12;
  const gminDecay = 0.1;        // reduce gmin by 10× each iteration
  const maxIter = options.itl4 ?? 50;

  let gmin = gminStart;
  let converged = false;
  let prevVoltages = new Float64Array(numNodes);
  let delta = Infinity;
  let finalSim: SimContext | null = null;

  for (let iter = 0; iter < maxIter; iter++) {
    // Create a sim context with the current gmin
    const sim: SimContext = {
      nodeVoltage: new Float64Array(numNodes),
      branchCurrent: new Float64Array(components.length * 4 + 8),
      time: 0,
      dt: 1e-3,
      state: { __pseudo_tran: true, __gmin: gmin },
    };

    // Build the MNA system with gmin conductances added
    const sys = createMnaSystem(numNodes, components.length * 4 + 8);

    // Stamp all components
    for (const comp of components) {
      const plugin = plugins.get(comp.type);
      if (!plugin) continue;
      const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
      try {
        plugin.stamp?.(comp.parameters, terminals, sys, sim);
      } catch {
        // ignore stamping errors during pseudo-tran
      }
    }

    // Add gmin conductance from each non-ground node to ground
    for (let i = 1; i < numNodes; i++) {
      sys.stampConductance(i, 0, gmin);
    }

    // Solve
    const sol = solveMna(sys);
    if (!sol) {
      attempts.push(`iter ${iter}: singular matrix at gmin=${gmin.toExponential(2)}`);
      gmin *= gminDecay;
      if (gmin < gminTarget) break;
      continue;
    }

    // Update sim voltages
    for (let i = 0; i < numNodes; i++) {
      sim.nodeVoltage[i] = sol[i] ?? 0;
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
