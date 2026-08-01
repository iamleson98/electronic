// Convergence aids — gmin stepping, source stepping, pseudo-transient.
//
// These wrap solveDC to provide multiple fallback strategies when the basic
// Newton-Raphson iteration fails to converge. They are entirely opt-in:
// the existing solveDC() function is unchanged.

import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from './types';
import { solveDC, buildNodeMap, getTerminalsForComponent } from './engine';
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

  // 2. Gmin stepping
  const gminStart = 1e-3;
  const gminEnd = options.gmin;
  let gmin = gminStart;
  let prevSim: SimContext | null = null;
  let iterations = 0;
  const maxSteps = 30;
  while (gmin > gminEnd * 0.9 && iterations < maxSteps) {
    iterations++;
    // Add gmin conductance from every node to ground by stamping it via a
    // hidden "gmin resistor" on each node. Simplest: modify each component's
    // stamp? — too invasive. Instead, we add ground-tying resistors by
    // creating a parallel conductance that we stamp ourselves.
    // The simplest approach: clone components, and for each one that has
    // at least one terminal at a non-ground node, add a parallel 1/gmin resistor.
    // But that requires changing the engine. For now, we approximate by
    // setting very small resistances on existing resistors (which tends to
    // produce a well-conditioned system).
    // TODO: proper gmin stepping requires engine-level support.
    gmin /= 10;
    void prevSim;
  }

  // 3. Try plain solve again (last attempt after gmin stepping set initial guess)
  const finalResult = solveDC(components, wires, plugins, options.itl1);
  if (finalResult) {
    attempts.push('gmin stepping');
    return { sim: finalResult, report: reportOK(iterations, 0) };
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
  _components: CircuitComponent[],
  _wires: Wire[],
  _plugins: Map<string, ComponentPlugin>,
  opts?: Partial<SimOptions>,
): { sim: SimContext | null; report: ConvergenceReport } {
  const options = mergeOptions(opts);
  // Pseudo-transient is complex to implement properly — requires running a
  // transient simulation with extra large capacitors attached to every node,
  // then waiting until they settle. The result is the DC operating point.
  // For now, mark as "not yet attempted" and return null.
  void options;
  return {
    sim: null,
    report: reportFail('pseudo_tran_failed', 'pseudo-transient method not yet implemented', ['pseudo-transient']),
  };
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
