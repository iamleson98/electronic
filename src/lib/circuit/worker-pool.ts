// Small Web Worker pool for batch analyses (Monte Carlo, sweeps).
//
// Size = navigator.hardwareConcurrency - 1, capped at 8, min 1 (one core is
// left for the UI thread). Workers are created lazily and torn down on cancel.
// The worker factory is injectable so the pool logic is unit-testable in Node
// with in-process fake workers; `defaultWorkerFactory()` returns null when
// real Workers are unavailable (SSR, Node, vitest) and callers fall back to
// the serial path.

import { executeBatchTask, taskWeight, type BatchTask, type BatchTaskResult } from './batch-tasks';

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: any }) => void) | null;
  onerror: ((e: any) => void) | null;
}
export type WorkerFactory = () => WorkerLike;

export interface PoolRunOptions {
  /** (completed work units, total work units) — units = MC trials / sweep points */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export function defaultPoolSize(hw?: number): number {
  const n = hw ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined) ?? 2;
  return Math.max(1, Math.min(8, Math.floor(n) - 1));
}

/** Real-Worker factory, or null when Workers don't exist in this environment. */
export function defaultWorkerFactory(): WorkerFactory | null {
  if (typeof Worker === 'undefined') return null;
  return () =>
    new Worker(new URL('./batch.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

/** In-process "worker" — runs tasks on a microtask. For tests / diagnostics. */
export function inlineWorkerFactory(): WorkerFactory {
  return () => {
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      terminate() { w.onmessage = null; },
      postMessage(msg: any) {
        const { id, task } = msg as { id: number; task: BatchTask };
        // Round-trip through structured clone, like a real worker would.
        const cloned = structuredClone(task);
        queueMicrotask(() => {
          let reply: any;
          try { reply = { id, ok: true, result: structuredClone(executeBatchTask(cloned)) }; }
          catch (err) { reply = { id, ok: false, error: (err as Error).message }; }
          w.onmessage?.({ data: reply });
        });
      },
    };
    return w;
  };
}

export class AbortError extends Error {
  constructor() { super('Aborted'); this.name = 'AbortError'; }
}

interface Slot { worker: WorkerLike; busy: boolean }

export class WorkerPool {
  readonly size: number;
  private slots: Slot[] = [];
  private nextId = 1;

  constructor(private factory: WorkerFactory, size: number = defaultPoolSize()) {
    this.size = Math.max(1, size);
  }

  private ensureSlots(n: number): void {
    while (this.slots.length < n) this.slots.push({ worker: this.factory(), busy: false });
  }

  /** Run tasks across the pool; results are returned IN TASK ORDER. */
  run<R extends BatchTaskResult>(tasks: BatchTask[], opts: PoolRunOptions = {}): Promise<R[]> {
    if (tasks.length === 0) return Promise.resolve([]);
    if (opts.signal?.aborted) return Promise.reject(new AbortError());
    const nWorkers = Math.min(this.size, tasks.length);
    this.ensureSlots(nWorkers);
    const slots = this.slots.slice(0, nWorkers);
    const weights = tasks.map(taskWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    const results: R[] = new Array(tasks.length);
    let next = 0;
    let finished = 0;
    let doneUnits = 0;
    let settled = false;

    return new Promise<R[]>((resolve, reject) => {
      const cleanup = () => {
        opts.signal?.removeEventListener('abort', onAbort);
        for (const s of slots) { s.worker.onmessage = null; s.worker.onerror = null; s.busy = false; }
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Workers may be mid-task: kill them all; they respawn on next run().
        this.terminate();
        reject(err);
      };
      const onAbort = () => fail(new AbortError());
      opts.signal?.addEventListener('abort', onAbort);

      const dispatch = (slot: Slot) => {
        if (settled || next >= tasks.length) return;
        const idx = next++;
        const id = this.nextId++;
        slot.busy = true;
        slot.worker.onmessage = (e) => {
          const d = e.data;
          if (d.id !== id || settled) return;
          slot.busy = false;
          if (!d.ok) return fail(new Error(d.error ?? 'worker task failed'));
          results[idx] = d.result as R;
          finished++;
          doneUnits += weights[idx];
          opts.onProgress?.(doneUnits, total);
          if (finished === tasks.length) {
            settled = true;
            cleanup();
            resolve(results);
          } else {
            dispatch(slot);
          }
        };
        slot.worker.onerror = (ev) => fail(new Error(ev?.message ?? 'worker error'));
        slot.worker.postMessage({ id, task: tasks[idx] });
      };
      for (const s of slots) dispatch(s);
    });
  }

  terminate(): void {
    for (const s of this.slots) { try { s.worker.terminate(); } catch { /* ignore */ } }
    this.slots = [];
  }
}

let shared: WorkerPool | null | undefined;
/** Lazily created process-wide pool, or null when Workers are unavailable. */
export function getSharedPool(): WorkerPool | null {
  if (shared !== undefined) return shared;
  const factory = defaultWorkerFactory();
  shared = factory ? new WorkerPool(factory) : null;
  return shared;
}
/** Test hook. */
export function setSharedPool(pool: WorkerPool | null | undefined): void {
  shared = pool;
}
