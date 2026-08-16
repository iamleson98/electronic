// Batch sweep runner — runs an analysis many times with swept parameters,
// returning a family of traces (one per sweep value).
//
// Supports:
//   - .step param NAME start stop step
//   - .step param NAME list val1 val2 ...
//   - .mc — Monte Carlo with statistical distributions (uniform, gaussian)
//   - .worst — worst-case analysis (sensitivity-driven min/max)
//
// The runner does NOT modify the existing store.step / store.setRunning.
// It is invoked explicitly via runBatch() and returns a FamilyResult.

import type { CircuitComponent, ComponentPlugin, Wire } from './types';
import type { AnalysisConfig, AnalysisResult, RealTrace } from './analysis';
import { runAnalysis } from './analysis';
import { mergeOptions, type SimOptions } from './sim-options';

export interface SweepValue {
  name: string;
  value: number;
}

export interface BatchConfig {
  type: 'step' | 'mc' | 'worst';
  /** parameter key to sweep (e.g. 'resistance', 'vth') */
  param: string;
  /** component id whose parameter to vary */
  componentId: string;
  /** for .step: sweep range */
  start?: number;
  stop?: number;
  step?: number;
  /** for .step list mode */
  list?: number[];
  /** for .mc: number of runs */
  runs?: number;
  /** for .mc: distribution type */
  distribution?: 'uniform' | 'gaussian' | 'worst_case';
  /** for .mc: +/- tolerance (e.g. 0.05 = 5%) */
  tolerance?: number;
  /** for .worst: sensitivity-driven — find min and max of output */
  outputNode?: string;
  /** inner analysis to run at each sweep value */
  inner: AnalysisConfig;
}

export interface BatchResult {
  type: 'step' | 'mc' | 'worst';
  /** one trace per sweep value */
  traces: RealTrace[];
  /** sweep values used */
  sweepValues: SweepValue[];
  /** statistics (min/max/mean/std) for .mc */
  stats?: {
    min: number;
    max: number;
    mean: number;
    std: number;
  };
  durationMs: number;
}

export function runBatch(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: BatchConfig,
  opts?: Partial<SimOptions>,
): BatchResult {
  const start = performance.now();
  const sweepValues = generateSweepValues(config, components);
  const traces: RealTrace[] = [];
  const outputValues: number[] = [];

  for (const sv of sweepValues) {
    // clone components with the swept parameter modified
    const modified = components.map((c) =>
      c.id === config.componentId
        ? { ...c, parameters: { ...c.parameters, [sv.name]: sv.value } }
        : c,
    );
    const result: AnalysisResult = runAnalysis(modified, wires, plugins, config.inner, opts);
    if (!result.report.converged) continue;
    // extract output value
    const outValue = extractOutputValue(result, config.outputNode);
    outputValues.push(outValue);
    // push the result trace with sweep value in name
    for (const tr of result.traces) {
      if ('yValues' in tr) {
        const rt = tr as RealTrace;
        traces.push({ ...rt, name: `${rt.name} @ ${sv.value}` });
      }
    }
  }

  // statistics for Monte Carlo
  let stats: { min: number; max: number; mean: number; std: number } | undefined;
  if (config.type === 'mc' && outputValues.length > 0) {
    const min = Math.min(...outputValues);
    const max = Math.max(...outputValues);
    const mean = outputValues.reduce((a, b) => a + b, 0) / outputValues.length;
    const variance = outputValues.reduce((a, b) => a + (b - mean) ** 2, 0) / outputValues.length;
    stats = { min, max, mean, std: Math.sqrt(variance) };
  }

  return {
    type: config.type,
    traces,
    sweepValues,
    stats,
    durationMs: performance.now() - start,
  };
}

function generateSweepValues(config: BatchConfig, components?: CircuitComponent[]): SweepValue[] {
  const values: SweepValue[] = [];
  if (config.type === 'step') {
    if (config.list) {
      for (const v of config.list) {
        values.push({ name: config.param, value: v });
      }
    } else if (config.start !== undefined && config.stop !== undefined && config.step !== undefined) {
      const step = config.step;
      for (let v = config.start; (step > 0 ? v <= config.stop : v >= config.stop); v += step) {
        values.push({ name: config.param, value: v });
      }
    }
  } else if (config.type === 'mc') {
    const runs = config.runs ?? 100;
    const tol = config.tolerance ?? 0.05;
    const dist = config.distribution ?? 'uniform';
    // Look up the actual nominal value of the param from the components array.
    // If the caller explicitly provided `config.start`, use that instead
    // (for cases where the user wants to sweep an absolute range rather than
    // perturb the nominal).
    let nominal: number | undefined = config.start;
    if (nominal === undefined && components) {
      const c = components.find(cc => cc.id === config.componentId);
      if (c) {
        const v = c.parameters[config.param];
        if (typeof v === 'number') nominal = v;
      }
    }
    // Fall back to 1 if we genuinely can't find a nominal — better than 1000.
    const nominalValue = nominal ?? 1;
    for (let i = 0; i < runs; i++) {
      let delta: number;
      if (dist === 'uniform') {
        delta = (Math.random() * 2 - 1) * tol * nominalValue;
      } else if (dist === 'gaussian') {
        // Box-Muller transform for gaussian
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        delta = z * (tol / 3) * nominalValue;  // 3σ = tol
      } else {
        // worst_case: ±tol only
        delta = (i % 2 === 0 ? 1 : -1) * tol * nominalValue;
      }
      values.push({ name: config.param, value: nominalValue + delta });
    }
  } else if (config.type === 'worst') {
    // Two runs: min and max (worst-case ±tol)
    const tol = config.tolerance ?? 0.05;
    // Look up nominal from components (same as .mc above)
    let nominal: number | undefined = config.start;
    if (nominal === undefined && components) {
      const c = components.find(cc => cc.id === config.componentId);
      if (c) {
        const v = c.parameters[config.param];
        if (typeof v === 'number') nominal = v;
      }
    }
    const nominalValue = nominal ?? 1;
    values.push({ name: config.param, value: nominalValue * (1 + tol) });
    values.push({ name: config.param, value: nominalValue * (1 - tol) });
  }
  return values;
}

function extractOutputValue(result: AnalysisResult, outputNode?: string): number {
  if (!result.traces.length) return 0;
  const tr = result.traces[0];
  if ('yValues' in tr && tr.yValues.length > 0) {
    // For real traces: take last value (steady-state)
    if (tr.yValues instanceof Float64Array) {
      return tr.yValues[tr.yValues.length - 1] as number;
    }
  }
  void outputNode;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// .param: substitute named parameters into components
// ─────────────────────────────────────────────────────────────────────────────

export interface ParamDef {
  name: string;
  value: number | string;
}

export function applyParams(
  components: CircuitComponent[],
  params: ParamDef[],
): CircuitComponent[] {
  // For each component, replace any string parameter that's a {param_name} reference
  return components.map((c) => {
    const newParams = { ...c.parameters };
    for (const [key, val] of Object.entries(newParams)) {
      if (typeof val === 'string') {
        let replaced = val;
        for (const p of params) {
          replaced = replaced.replace(new RegExp(`\\{${p.name}\\}`, 'g'), String(p.value));
        }
        // try to evaluate as number if no {} remain
        if (!replaced.includes('{')) {
          const num = parseFloat(replaced);
          if (!isNaN(num)) newParams[key] = num;
          else newParams[key] = replaced;
        }
      }
    }
    return { ...c, parameters: newParams };
  });
}
