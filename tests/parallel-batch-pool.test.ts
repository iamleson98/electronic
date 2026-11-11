// Worker pool + parallel Monte Carlo / sweep: serial and pooled execution must
// be bit-identical (per-trial seeding), and progress / cancel must work.
// Real Workers don't exist in Node, so the pool runs over in-process fake
// workers that still structured-clone every message like a real Worker.
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { exampleVoltageDivider } from '../src/lib/circuit/examples';
import { pluginsFor } from '../src/lib/circuit/live-step';
import { runMonteCarlo, trialSeed, type MonteCarloConfig } from '../src/lib/circuit/monte-carlo';
import { runBatch, type BatchConfig } from '../src/lib/circuit/batch-runner';
import { runMonteCarloParallel, runBatchParallel, runTempSweepParallel, chunkRanges } from '../src/lib/circuit/parallel-batch';
import { WorkerPool, inlineWorkerFactory, defaultPoolSize, defaultWorkerFactory, AbortError } from '../src/lib/circuit/worker-pool';
import { runAnalysis } from '../src/lib/circuit/analysis';
import { buildNodeMap } from '../src/lib/circuit/engine';

const doc = exampleVoltageDivider;
const plugins = pluginsFor(doc.components);

function outNode(): string {
  // any resistor terminal that lands on a non-ground node
  const nm = buildNodeMap(doc.components, doc.wires, plugins);
  for (const c of doc.components) {
    if (c.type !== 'resistor') continue;
    for (const t of ['a', 'b']) {
      const n = nm.terminalNode.get(`${c.id}:${t}`);
      if (n !== undefined && n > 0) return `${c.id}:${t}`;
    }
  }
  throw new Error('no node');
}

const mcConfig = (): MonteCarloConfig => ({
  runs: 37, seed: 1234, measurement: { type: 'voltage', node: outNode() },
  spec: { min: 0, max: 1e9 }, nBins: 10,
});

describe('pool sizing / environment', () => {
  it('size = hardwareConcurrency-1, capped 8, min 1', () => {
    expect(defaultPoolSize(1)).toBe(1);
    expect(defaultPoolSize(2)).toBe(1);
    expect(defaultPoolSize(8)).toBe(7);
    expect(defaultPoolSize(64)).toBe(8);
  });
  it('no Worker in Node => factory is null (serial fallback)', () => {
    expect(defaultWorkerFactory()).toBeNull();
  });
  it('chunkRanges partitions exactly', () => {
    for (const [n, k] of [[37, 12], [5, 8], [1, 3], [100, 7]] as const) {
      const r = chunkRanges(n, k);
      expect(r[0][0]).toBe(0);
      expect(r[r.length - 1][1]).toBe(n);
      for (let i = 1; i < r.length; i++) expect(r[i][0]).toBe(r[i - 1][1]);
    }
  });
  it('trial seeds are distinct and order-independent', () => {
    const s = new Set(Array.from({ length: 500 }, (_, i) => trialSeed(7, i)));
    expect(s.size).toBe(500);
    expect(trialSeed(7, 3)).toBe(trialSeed(7, 3));
  });
});

describe('Monte Carlo: serial == pool', () => {
  it('seeded run is identical serial vs pool (several pool sizes) vs forced-serial async', async () => {
    const serial = runMonteCarlo(doc, mcConfig(), plugins);
    expect(serial.runs).toHaveLength(37);
    expect(serial.stats.stddev).toBeGreaterThan(0); // tolerances actually perturb
    for (const size of [1, 3, 8]) {
      const pool = new WorkerPool(inlineWorkerFactory(), size);
      const par = await runMonteCarloParallel(doc, mcConfig(), plugins, { pool });
      expect(par).toEqual(serial);
      pool.terminate();
    }
    const asyncSerial = await runMonteCarloParallel(doc, mcConfig(), plugins, { pool: null });
    expect(asyncSerial).toEqual(serial);
  });

  it('different seed => different results; same seed => reproducible', () => {
    const a = runMonteCarlo(doc, mcConfig(), plugins);
    const b = runMonteCarlo(doc, mcConfig(), plugins);
    const c = runMonteCarlo(doc, { ...mcConfig(), seed: 99 }, plugins);
    expect(a).toEqual(b);
    expect(c.stats.mean).not.toBe(a.stats.mean);
  });

  it('reports progress up to total and supports cancel (pool + serial)', async () => {
    const pool = new WorkerPool(inlineWorkerFactory(), 3);
    const seen: Array<[number, number]> = [];
    await runMonteCarloParallel(doc, mcConfig(), plugins, { pool, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toEqual([37, 37]);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);

    const ac = new AbortController();
    const p = runMonteCarloParallel(doc, { ...mcConfig(), runs: 400 }, plugins, { pool, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    // pool is reusable after a cancel
    const again = await runMonteCarloParallel(doc, mcConfig(), plugins, { pool });
    expect(again.runs).toHaveLength(37);

    const ac2 = new AbortController();
    const sp = runMonteCarloParallel(doc, { ...mcConfig(), runs: 400 }, plugins, {
      pool: null, signal: ac2.signal, onProgress: (d) => { if (d === 3) ac2.abort(); },
    });
    await expect(sp).rejects.toBeInstanceOf(AbortError);
    pool.terminate();
  });

  it('worker errors reject the run', async () => {
    const pool = new WorkerPool(inlineWorkerFactory(), 2);
    const bad = { ...mcConfig(), runs: 4, tolerances: [{ componentId: 'x', param: 'p', tolerance: 0.1 }] };
    // unknown component is skipped, not an error — still resolves
    await expect(runMonteCarloParallel(doc, bad, plugins, { pool })).resolves.toBeTruthy();
    pool.terminate();
  });
});

describe('parameter / temperature sweeps: serial == pool', () => {
  const resistor = doc.components.find((c) => c.type === 'resistor')!;
  const batchCfg: BatchConfig = {
    type: 'step', param: 'resistance', componentId: resistor.id,
    start: 1000, stop: 9000, step: 1000,
    inner: { type: 'dc', source: doc.components.find((c) => c.type === 'dcVoltage')!.id, start: 0, stop: 5, step: 1 } as any,
  };

  it('runBatch step sweep matches pooled run', async () => {
    const serial = runBatch(doc.components, doc.wires, plugins, batchCfg);
    expect(serial.traces.length).toBeGreaterThan(3); // non-trivial comparison
    const pool = new WorkerPool(inlineWorkerFactory(), 4);
    const par = await runBatchParallel(doc.components, doc.wires, plugins, batchCfg, undefined, { pool });
    expect(par.sweepValues).toEqual(serial.sweepValues);
    expect(par.tracedSweepValues).toEqual(serial.tracedSweepValues);
    expect(par.traces).toEqual(serial.traces);
    const ser2 = await runBatchParallel(doc.components, doc.wires, plugins, batchCfg, undefined, { pool: null });
    expect(ser2.traces).toEqual(serial.traces);
    pool.terminate();
  });

  it('temperature sweep matches serial analysis per temperature', async () => {
    const inner = batchCfg.inner;
    const temps = [-40, 0, 27, 85, 125];
    const pool = new WorkerPool(inlineWorkerFactory(), 3);
    const par = await runTempSweepParallel(doc.components, doc.wires, plugins, inner, temps, undefined, { pool });
    expect(par.map((r) => r.temp)).toEqual(temps);
    expect(par.every((r) => r.converged && r.traces.length > 0)).toBe(true);
    for (const r of par) {
      const ref = runAnalysis(doc.components, doc.wires, plugins, inner, { temp: r.temp });
      expect(r.converged).toBe(ref.report.converged);
      expect(r.traces).toEqual(ref.traces);
    }
    pool.terminate();
  });
});
