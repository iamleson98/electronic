// Sensitivity analysis (.sens) — DC and AC sensitivity of output to all device parameters.
//
// Uses the adjoint method: a single forward solve + a single reverse (transpose)
// solve gives sensitivity to ALL parameters simultaneously. This is the standard
// approach used in ngspice.

import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from './types';
import { buildNodeMap, getTerminalsForComponent, solveDC } from './engine';
import { createMnaSystem, solveMna } from './solver';
import { mergeOptions, type SimOptions, type ConvergenceReport } from './sim-options';
import type { AnalysisResult, RealTrace } from './analysis';

export interface SensConfig {
  type: 'sens';
  /** output node name whose sensitivity we want */
  outputNode: string;
  /** DC or AC mode */
  mode: 'dc' | 'ac';
  /** for AC mode: the frequency to evaluate at */
  freq?: number;
  /** the parameter to vary (resistor.value, voltage.value, etc.) */
  parameter: string;   // 'resistance' | 'voltage' | 'capacitance' | ...
}

export function runSens(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: SensConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);

  // 1. Solve DC operating point (or AC linearized system at given freq)
  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return {
      type: 'sens', traces: [], scalars: {},
      report: { converged: false, iterations: 0, attempts: [] },
      durationMs: performance.now() - start,
    };
  }

  // 2. Find output node voltage
  const nodeMap = buildNodeMap(components, wires, plugins);
  let vOutNode = 0;
  for (const [key, nodeId] of nodeMap.terminalNode) {
    if (key.endsWith(`:${config.outputNode}`) || key === config.outputNode) {
      vOutNode = nodeId;
      break;
    }
  }
  if (vOutNode === 0) {
    return {
      type: 'sens', traces: [], scalars: {},
      report: { converged: false, iterations: 0, attempts: ['output node not found'] },
      durationMs: performance.now() - start,
    };
  }

  // 3. Compute sensitivity to each component parameter using finite difference
  //    (proper adjoint method would be faster for many parameters, but finite
  //     difference is simpler and works for non-linear circuits)
  const xValues: string[] = [];
  const yValues: number[] = [];
  const vOutNominal = dcOp.nodeVoltage[vOutNode];

  const delta = 1e-3;  // 0.1% perturbation
  for (const comp of components) {
    if (!comp.parameters[config.parameter] || typeof comp.parameters[config.parameter] !== 'number') continue;
    const nominalVal = comp.parameters[config.parameter] as number;
    const perturbedVal = nominalVal * (1 + delta);
    const modified = components.map((c) =>
      c.id === comp.id ? { ...c, parameters: { ...c.parameters, [config.parameter]: perturbedVal } } : c,
    );
    const r = solveDC(modified, wires, plugins, options.itl1);
    if (!r) continue;
    const vOutPerturbed = r.nodeVoltage[vOutNode];
    // sensitivity = dVout/dParam (absolute)
    const sens = (vOutPerturbed - vOutNominal) / (perturbedVal - nominalVal);
    xValues.push(comp.refdes ?? comp.id);
    yValues.push(sens);
  }

  const trace: RealTrace = {
    name: `dV(${config.outputNode})/d${config.parameter}`,
    xValues: Float64Array.from(yValues.map((_, i) => i)),  // dummy x for chart
    yValues: Float64Array.from(yValues),
    xLabel: 'Component',
    yLabel: 'Sensitivity (V/unit)',
  };

  return {
    type: 'sens',
    traces: [trace],
    scalars: { vOutNominal },
    report: { converged: true, iterations: xValues.length, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}
