// Task executor shared by the pool worker (batch.worker.ts) and the in-process
// fallback. Every task is a PURE function of its payload, which is what makes
// serial and pooled execution produce identical results.

import { pluginsFor } from './live-step';
import { runMonteCarloTrial, resolveTolerances, type MonteCarloConfig, type MonteCarloRun } from './monte-carlo';
import { runBatchPoint, type BatchConfig, type BatchPointResult, type SweepValue } from './batch-runner';
import { runAnalysis, type AnalysisConfig, type AnalysisResult } from './analysis';
import type { SimOptions } from './sim-options';
import type { CircuitComponent, CircuitDocument, Wire } from './types';

export interface TempPointResult {
  temp: number;
  converged: boolean;
  traces: AnalysisResult['traces'];
}

export type BatchTask =
  | { kind: 'mc'; doc: CircuitDocument; config: MonteCarloConfig; start: number; end: number }
  | { kind: 'sweep'; components: CircuitComponent[]; wires: Wire[]; config: BatchConfig; points: SweepValue[]; opts?: Partial<SimOptions> }
  | { kind: 'temp'; components: CircuitComponent[]; wires: Wire[]; inner: AnalysisConfig; temps: number[]; opts?: Partial<SimOptions> };

export type BatchTaskResult = MonteCarloRun[] | BatchPointResult[] | TempPointResult[];

/** Number of work units in a task (for progress weighting). */
export function taskWeight(task: BatchTask): number {
  switch (task.kind) {
    case 'mc': return task.end - task.start;
    case 'sweep': return task.points.length;
    case 'temp': return task.temps.length;
  }
}

export function runTempPoint(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: ReturnType<typeof pluginsFor>,
  inner: AnalysisConfig,
  temp: number,
  opts?: Partial<SimOptions>,
): TempPointResult {
  const r = runAnalysis(components, wires, plugins, inner, { ...opts, temp });
  return { temp, converged: r.report.converged, traces: r.traces };
}

export function executeBatchTask(task: BatchTask): BatchTaskResult {
  switch (task.kind) {
    case 'mc': {
      const plugins = pluginsFor(task.doc.components);
      const tolerances = resolveTolerances(task.doc, task.config);
      const out: MonteCarloRun[] = [];
      for (let i = task.start; i < task.end; i++) {
        out.push(runMonteCarloTrial(task.doc, tolerances, task.config, plugins, i));
      }
      return out;
    }
    case 'sweep': {
      const plugins = pluginsFor(task.components);
      return task.points.map((sv) => runBatchPoint(task.components, task.wires, plugins, task.config, sv, task.opts));
    }
    case 'temp': {
      const plugins = pluginsFor(task.components);
      return task.temps.map((t) => runTempPoint(task.components, task.wires, plugins, task.inner, t, task.opts));
    }
  }
}
