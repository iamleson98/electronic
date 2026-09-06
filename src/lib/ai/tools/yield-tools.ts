// AI yield / tolerance tools — Monte-Carlo yield + sensitivity via chat.
//
// Wraps the existing monte-carlo.ts / sensitivity.ts engines so the AI can
// answer "will 5% parts still pass?" with real statistics instead of guesses.

import { runMonteCarlo } from '../../circuit/monte-carlo';
import { runSens } from '../../circuit/sensitivity';
import type { Tool, ToolContext } from './types';
import { ensurePlugins } from './helpers';

/** Numeric sweepable parameters per component type (tolerance applies here).
 *  SOURCES excluded by default: the stimulus is exact in a tolerance study
 *  (perturbing the supply measures input variation, not part spread). A
 *  per-part `tolerance` on a source still opts it in explicitly below. */
const TOL_PARAMS: Record<string, string[]> = {
  resistor: ['resistance'],
  capacitor: ['capacitance'],
  inductor: ['inductance'],
  potentiometer: ['resistance'],
  led: ['forwardV', 'seriesR'],
  diode: ['forwardV', 'onR'],
  zener: ['zenerV', 'forwardV', 'onR'],
};

export const yieldMonteCarloTool: Tool = {
  name: 'yield.monteCarlo',
  category: 'Simulation & Analysis',
  description: 'Run a Monte-Carlo tolerance analysis: vary part values (resistors/caps/etc.) with Gaussian or uniform distribution and measure the output spread, mean, std-dev, min/max, and pass yield against a spec window. Use to answer "will this still work with 5% parts?" Non-mutating.',
  parameters: {
    type: 'object',
    properties: {
      runs: {
        type: 'number',
        description: 'Number of Monte-Carlo runs (default 100, max 1000).',
      },
      tolerance: {
        type: 'number',
        description: 'Global fractional part tolerance, e.g. 0.05 for ±5% (default 0.05). Per-part ProductionSection tolerances override this per component.',
      },
      distribution: {
        type: 'string',
        description: '"gauss" (default, sigma = tol/3) or "uniform". Per-part toleranceDist overrides this per component.',
      },
      outputNode: {
        type: 'string',
        description: 'Terminal key "compId:terminalId" to measure (e.g. "r1:b").',
      },
      specMin: {
        type: 'number',
        description: 'Optional lower spec limit for yield computation.',
      },
      specMax: {
        type: 'number',
        description: 'Optional upper spec limit for yield computation.',
      },
      seed: {
        type: 'number',
        description: 'Optional RNG seed for reproducibility.',
      },
    },
    required: ['outputNode'],
  },
  execute(args: {
    runs?: number;
    tolerance?: number;
    distribution?: string;
    outputNode: string;
    specMin?: number;
    specMax?: number;
    seed?: number;
  }, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const tol = args.tolerance ?? 0.05;
      const dist = args.distribution === 'uniform' ? 'uniform' : 'gauss';
      // Per-part merge: a component's own ProductionSection tolerance +
      // distribution WIN when set (1% reference vs 5% jellybeans); the
      // global args are the fallback for parts without explicit values.
      // NOTE: per-part tolerance/dist are COMPONENT-level production fields
      // (c.tolerance / c.toleranceDist), not parameters — reading them from
      // c.parameters.* always missed, silently applying the global tolerance
      // to every part including 1% references.
      const tolerances = ctx.doc.components.flatMap((c) => {
        const perPartTol = typeof c.tolerance === 'number' && c.tolerance > 0
          ? c.tolerance
          : tol;
        const perPartDist = c.toleranceDist === 'uniform' || c.toleranceDist === 'gauss'
          ? c.toleranceDist
          : dist;
        return (TOL_PARAMS[c.type] ?? [])
          .filter((p) => typeof c.parameters[p] === 'number')
          .map((p) => ({ componentId: c.id, param: p, tolerance: perPartTol, distribution: perPartDist as 'gauss' | 'uniform' }));
      });
      if (tolerances.length === 0) {
        return { ok: false, error: 'No toleranced numeric parameters found on this circuit.' };
      }
      const result = runMonteCarlo(
        { version: 1, components: ctx.doc.components, wires: ctx.doc.wires },
        {
          runs: Math.max(1, Math.min(1000, Math.trunc(args.runs ?? 100))),
          seed: args.seed ?? 1,
          tolerances,
          measurement: { type: 'voltage', node: args.outputNode },
          spec: args.specMin !== undefined || args.specMax !== undefined
            ? { min: args.specMin, max: args.specMax }
            : undefined,
        },
        ctx.plugins,
      );
      return {
        ok: true,
        result: {
          runs: result.runs.length,
          mean: result.stats.mean,
          std: result.stats.stddev,
          min: result.stats.min,
          max: result.stats.max,
          yield: result.yield,
          specMin: args.specMin,
          specMax: args.specMax,
          histogram: Array.from(result.histogram),
          histogramEdges: Array.from(result.histogramEdges),
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const yieldSensitivityTool: Tool = {
  name: 'yield.sensitivity',
  category: 'Simulation & Analysis',
  description: 'Run a sensitivity analysis: dV/dP of the output node with respect to each part parameter. Use to find which component dominates variation ("which part should be 1%?"). Non-mutating.',
  parameters: {
    type: 'object',
    properties: {
      outputNode: {
        type: 'string',
        description: 'Terminal key "compId:terminalId" to measure (e.g. "r1:b").',
      },
      parameter: {
        type: 'string',
        description: 'Parameter key to vary, e.g. "resistance" (default). Only components carrying it are ranked.',
      },
    },
    required: ['outputNode'],
  },
  execute(args: { outputNode: string; parameter?: string }, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const param = args.parameter ?? 'resistance';
      const result = runSens(
        ctx.doc.components,
        ctx.doc.wires,
        ctx.plugins,
        { type: 'sens', outputNode: args.outputNode, mode: 'dc', parameter: param },
      );
      const trace = result.traces[0] as unknown as
        | { xValues: Float64Array; yValues: Float64Array; labels?: string[] }
        | undefined;
      // Identity comes from the TRACE's own labels (runSens pushes a label
      // per successfully-perturbed component) — re-filtering components here
      // misaligned indices whenever a perturbed solve failed or a value was
      // exactly 0, silently attributing sensitivities to the WRONG parts.
      const labels = trace?.labels;
      const comps = ctx.doc.components.filter((c) => typeof c.parameters[param] === 'number');
      const identityFor = (i: number): string =>
        (labels && labels[i])
        ?? (comps[i] ? (comps[i].refdes ?? comps[i].id) : `#${i}`);
      const n = trace ? trace.yValues.length : 0;
      const rows = Array.from({ length: n }, (_, i) => ({
        component: identityFor(i),
        param,
        dVdP: trace ? trace.yValues[i] ?? 0 : 0,
      })).sort((a, b) => Math.abs(b.dVdP) - Math.abs(a.dVdP));
      return { ok: true, result: { outputNode: args.outputNode, parameter: param, sensitivities: rows } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
