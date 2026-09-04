// Sensitivity analysis (.sens) — DC and AC sensitivity of output to all device parameters.
//
// Implemented with forward finite differences: for each device parameter, the
// system is re-solved with a ±delta perturbation and dVout/dParam is estimated.
// This is simple and handles nonlinear circuits, but costs one solve per
// parameter (unlike a true adjoint method, which would use a single transpose
// solve — a documented future optimization).

import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from './types';
import { buildNodeMap, getTerminalsForComponent, solveDC } from './engine';
import { createMnaSystem, solveMna } from './solver';
import { mergeOptions, type SimOptions, type ConvergenceReport } from './sim-options';
import type { AnalysisResult, RealTrace, ComplexTrace } from './analysis';

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

  // AC mode: delegate to the small-signal sensitivity path (magnitude/phase
  // of the AC transfer w.r.t. each parameter at config.freq).
  if (config.mode === 'ac') {
    return computeACModeSensitivity(components, wires, plugins, config, options, start);
  }

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

/**
 * AC-mode sensitivity: d|H(jω)|/dParam and d∠H(jω)/dParam at config.freq,
 * where H is the small-signal transfer from the circuit's first independent
 * source to config.outputNode.
 *
 * This is computed by forward finite differences on the AC analysis path:
 * each parameter is perturbed ±, the AC system is rebuilt at `freq`, and the
 * transfer magnitude/phase derivatives are estimated. The trace carries the
 * magnitude sensitivities; phase sensitivities go in `tracePhase` metadata.
 */
export function computeACModeSensitivity(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: SensConfig,
  options: SimOptions,
  startMs: number,
): AnalysisResult {
  const freq = config.freq && Number.isFinite(config.freq) && config.freq > 0 ? config.freq : 1000;

  // Find the AC stimulus source: first independent source in the circuit.
  const stimulus = components.find((c) =>
    c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'currentSource' ||
    c.type === 'pulseSource' || c.type === 'sineSource' || c.type === 'acCurrent',
  );

  // Self-contained AC sensitivity: perturb each parameter, re-run the AC sweep
  // through the public runAC entry point (lazy-required to avoid a module
  // cycle — analysis.ts already imports sensitivity.ts), and differentiate
  // |H| and ∠H.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runAC } = require('./analysis') as typeof import('./analysis');
  const nominal = acTransfer(runAC, components, wires, plugins, stimulus?.id ?? '', config.outputNode, freq, options);
  if (!nominal) {
    return {
      type: 'sens', traces: [], scalars: {},
      report: { converged: false, iterations: 0, attempts: ['AC operating point failed'] },
      durationMs: performance.now() - startMs,
    };
  }

  const labels: string[] = [];
  const magSens: number[] = [];
  const phaseSens: number[] = [];
  const delta = 1e-3;
  for (const comp of components) {
    const raw = comp.parameters[config.parameter];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === 0) continue;
    const perturbedVal = raw * (1 + delta);
    const modified = components.map((c) =>
      c.id === comp.id ? { ...c, parameters: { ...c.parameters, [config.parameter]: perturbedVal } } : c,
    );
    const pert = acTransfer(runAC, modified, wires, plugins, stimulus?.id ?? '', config.outputNode, freq, options);
    if (!pert) continue;
    labels.push(comp.refdes ?? comp.id);
    magSens.push((pert.mag - nominal.mag) / (perturbedVal - raw));
    // unwrap phase difference to (−180°, 180°]
    let dp = pert.phaseDeg - nominal.phaseDeg;
    while (dp > 180) dp -= 360;
    while (dp <= -180) dp += 360;
    phaseSens.push(dp / (perturbedVal - raw));
  }

  const trace: RealTrace = {
    name: `d|H(${config.outputNode})|/d${config.parameter} @ ${freq}Hz`,
    xValues: Float64Array.from(magSens.map((_, i) => i)),
    yValues: Float64Array.from(magSens),
    xLabel: 'Component',
    yLabel: 'Mag sensitivity (1/unit)',
  };
  const phaseTrace: RealTrace = {
    name: `d∠H(${config.outputNode})/d${config.parameter} @ ${freq}Hz`,
    xValues: Float64Array.from(phaseSens.map((_, i) => i)),
    yValues: Float64Array.from(phaseSens),
    xLabel: 'Component',
    yLabel: 'Phase sensitivity (deg/unit)',
  };
  // Attach component labels for the chart tooltip.
  (trace as RealTrace & { labels?: string[] }).labels = labels;
  (phaseTrace as RealTrace & { labels?: string[] }).labels = labels;

  return {
    type: 'sens',
    traces: [trace, phaseTrace],
    scalars: { freq, nominalMag: nominal.mag, nominalPhaseDeg: nominal.phaseDeg },
    report: { converged: true, iterations: labels.length, finalDelta: 0, attempts: [`AC sensitivity @ ${freq}Hz`] },
    durationMs: performance.now() - startMs,
  };
}

/** Run a 1-point AC sweep and return the output transfer magnitude/phase. */
function acTransfer(
  runAC: (
    components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>,
    config: { type: 'ac'; sweep: 'lin'; nPoints: number; fStart: number; fStop: number; sourceId: string; outputNode?: string },
    opts?: Partial<SimOptions>,
  ) => AnalysisResult,
  components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>,
  sourceId: string, outputNode: string, freq: number, options?: SimOptions,
): { mag: number; phaseDeg: number } | null {
  const res = runAC(components, wires, plugins, {
    type: 'ac', sweep: 'lin', nPoints: 1, fStart: freq, fStop: freq,
    sourceId, outputNode,
  }, options ? { temp: options.temp, gmin: options.gmin, itl1: options.itl1 } : undefined);
  const t = res.traces[0] as ComplexTrace | undefined;
  if (!t || !(t.yValues instanceof Float64Array) || t.yValues.length < 2) return null;
  const re = t.yValues[0];
  const im = t.yValues[1];
  return { mag: Math.hypot(re, im), phaseDeg: Math.atan2(im, re) * 180 / Math.PI };
}
