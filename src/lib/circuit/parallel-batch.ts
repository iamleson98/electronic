// Parallel front-ends for Monte Carlo / sweeps. Each runs on the WorkerPool when
// one is supplied (or Workers exist) and otherwise on the SERIAL core, which
// stays the tested reference: both paths execute the same pure per-trial /
// per-point functions, so results are identical.

import {
  runMonteCarloTrial, resolveTolerances, finalizeMonteCarlo,
  type MonteCarloConfig, type MonteCarloResult, type MonteCarloRun,
} from './monte-carlo';
import {
  runBatchPoint, generateSweepValues, assembleBatchResult,
  type BatchConfig, type BatchResult, type BatchPointResult,
} from './batch-runner';
import { runTempPoint, type BatchTask, type TempPointResult } from './batch-tasks';
import { AbortError, getSharedPool, type PoolRunOptions, type WorkerPool } from './worker-pool';
import { pluginsFor } from './live-step';
import type { AnalysisConfig } from './analysis';
import type { SimOptions } from './sim-options';
import type { CircuitComponent, CircuitDocument, ComponentPlugin, Wire } from './types';

export interface ParallelOptions extends PoolRunOptions {
  /** Pool to use. undefined = shared pool when Workers exist; null = force serial. */
  pool?: WorkerPool | null;
}

function resolvePool(o: ParallelOptions): WorkerPool | null {
  return o.pool === undefined ? getSharedPool() : o.pool;
}

/** Split [0,n) into up to `parts` contiguous, near-equal ranges. */
export function chunkRanges(n: number, parts: number): Array<[number, number]> {
  const k = Math.max(1, Math.min(n, parts));
  const out: Array<[number, number]> = [];
  let s = 0;
  for (let i = 0; i < k; i++) {
    const e = s + Math.floor(n / k) + (i < n % k ? 1 : 0);
    out.push([s, e]);
    s = e;
  }
  return out;
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

/** Serial async loop with progress/cancel and periodic yields (UI stays alive). */
async function serialEach(total: number, o: ParallelOptions, body: (i: number) => void): Promise<void> {
  let lastYield = Date.now();
  for (let i = 0; i < total; i++) {
    if (o.signal?.aborted) throw new AbortError();
    body(i);
    o.onProgress?.(i + 1, total);
    if (Date.now() - lastYield > 16) { await yieldToLoop(); lastYield = Date.now(); }
  }
}

export async function runMonteCarloParallel(
  doc: CircuitDocument,
  config: MonteCarloConfig,
  plugins: Map<string, ComponentPlugin>,
  opts: ParallelOptions = {},
): Promise<MonteCarloResult> {
  const nRuns = Math.max(1, config.runs ?? 100);
  const pool = resolvePool(opts);
  if (!pool) {
    const tolerances = resolveTolerances(doc, config);
    const runs: MonteCarloRun[] = [];
    await serialEach(nRuns, opts, (i) => { runs.push(runMonteCarloTrial(doc, tolerances, config, plugins, i)); });
    return finalizeMonteCarlo(runs, config);
  }
  const tasks: BatchTask[] = chunkRanges(nRuns, pool.size * 4)
    .map(([start, end]) => ({ kind: 'mc', doc, config, start, end }));
  const chunks = await pool.run<MonteCarloRun[]>(tasks, opts);
  return finalizeMonteCarlo(chunks.flat(), config);
}

export async function runBatchParallel(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: BatchConfig,
  simOpts?: Partial<SimOptions>,
  opts: ParallelOptions = {},
): Promise<BatchResult> {
  const start = performance.now();
  const sweepValues = generateSweepValues(config, components, wires, plugins);
  const pool = resolvePool(opts);
  let points: BatchPointResult[];
  if (!pool) {
    points = [];
    await serialEach(sweepValues.length, opts, (i) => {
      points.push(runBatchPoint(components, wires, plugins, config, sweepValues[i], simOpts));
    });
  } else {
    const tasks: BatchTask[] = chunkRanges(sweepValues.length, pool.size * 4).map(([s, e]) => ({
      kind: 'sweep', components, wires, config, points: sweepValues.slice(s, e), opts: simOpts,
    }));
    points = (await pool.run<BatchPointResult[]>(tasks, opts)).flat();
  }
  return assembleBatchResult(config, sweepValues, points, performance.now() - start);
}

/** Run `inner` once per temperature (°C). Results are index-aligned with `temps`. */
export async function runTempSweepParallel(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  inner: AnalysisConfig,
  temps: number[],
  simOpts?: Partial<SimOptions>,
  opts: ParallelOptions = {},
): Promise<TempPointResult[]> {
  const pool = resolvePool(opts);
  if (!pool) {
    const out: TempPointResult[] = [];
    const p = plugins.size ? plugins : pluginsFor(components);
    await serialEach(temps.length, opts, (i) => { out.push(runTempPoint(components, wires, p, inner, temps[i], simOpts)); });
    return out;
  }
  const tasks: BatchTask[] = chunkRanges(temps.length, pool.size * 4).map(([s, e]) => ({
    kind: 'temp', components, wires, inner, temps: temps.slice(s, e), opts: simOpts,
  }));
  return (await pool.run<TempPointResult[]>(tasks, opts)).flat();
}
