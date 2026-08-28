// Multi-threaded simulation hook.
//
// Wraps the simulation engine in a Web Worker so long-running analyses
// (transient sweeps, Monte Carlo, etc.) don't block the UI thread.
//
// Falls back to synchronous execution if Workers aren't available (e.g.
// in older browsers or in SSR contexts).

import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { simulateStep } from '@/lib/circuit/engine';
import { getPlugin } from '@/lib/circuit/registry';
import type { CircuitComponent, Wire, SimContext } from '@/lib/circuit/types';

interface WorkerResult {
  sim: SimContext;
  branchCurrentSize: number;
}

interface BatchResult {
  results: WorkerResult[];
}

/**
 * Hook for running simulation steps in a Web Worker.
 *
 * Returns:
 *   - `stepAsync(components, wires, prev, dt)` — Promise<WorkerResult | null>
 *   - `batchAsync(components, wires, prev, dt, count)` — Promise<WorkerResult[] | null>
 *   - `isWorkerReady` — boolean, true if the worker is loaded and ready
 *
 * If the worker can't be loaded, falls back to synchronous execution.
 */
export function useSimWorker() {
  const workerRef = useRef<Worker | null>(null);
  const [isWorkerReady, setIsWorkerReady] = useState(false);
  const pendingRef = useRef<Map<string, (result: any) => void>>(new Map());
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (typeof Worker === 'undefined') return;
    try {
      const worker = new Worker(new URL('./sim-worker.ts', import.meta.url));
      workerRef.current = worker;
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        // Resolve the pending promise for this request
        const resolver = pendingRef.current.get(msg.requestId);
        if (resolver) {
          pendingRef.current.delete(msg.requestId);
          if (msg.type === 'result' || msg.type === 'batch_result') {
            resolver(msg);
          } else if (msg.type === 'error') {
            resolver(null);
          }
        }
        if (msg.type === 'pong') {
          setIsWorkerReady(true);
        }
      };
      worker.onerror = () => {
        // Worker failed to load — fall back to sync and settle every pending
        // request so awaiting callers don't hang forever (and pendingRef
        // doesn't leak).
        setIsWorkerReady(false);
        for (const resolve of pendingRef.current.values()) resolve(null);
        pendingRef.current.clear();
      };
      // Ping the worker to check if it's ready
      worker.postMessage({ type: 'ping' });
      return () => {
        worker.terminate();
        workerRef.current = null;
        // Settle in-flight requests on unmount
        for (const resolve of pendingRef.current.values()) resolve(null);
        pendingRef.current.clear();
      };
    } catch {
      // Worker creation failed (e.g., CSP restriction) — fall back to sync
    }
  }, []);

  const stepAsync = useCallback(
    (components: CircuitComponent[], wires: Wire[], prev: any, dt: number, method?: 'euler' | 'trap' | 'gear'): Promise<WorkerResult | null> => {
      if (!workerRef.current || !isWorkerReady) {
        // Fallback: synchronous execution
        const plugins = new Map<string, any>();
        for (const c of components) {
          const p = getPlugin(c.type);
          if (p) plugins.set(c.type, p);
        }
        const result = simulateStep(components, wires, plugins, prev, dt, method ? { method } : undefined);
        return Promise.resolve(result ? { sim: result.sim, branchCurrentSize: result.branchCurrentSize } : null);
      }
      // Async via worker
      const requestId = `req_${++requestIdRef.current}`;
      const pluginsSnapshot = Array.from(new Set(components.map((c) => c.type)));
      return new Promise((resolve) => {
        pendingRef.current.set(requestId, resolve);
        workerRef.current!.postMessage({
          type: 'step',
          requestId,
          components,
          wires,
          prev,
          dt,
          method,
          pluginsSnapshot,
        });
      });
    },
    [isWorkerReady],
  );

  const batchAsync = useCallback(
    (components: CircuitComponent[], wires: Wire[], prev: any, dt: number, count: number, method?: 'euler' | 'trap' | 'gear'): Promise<WorkerResult[] | null> => {
      if (!workerRef.current || !isWorkerReady) {
        // Fallback: synchronous
        const plugins = new Map<string, any>();
        for (const c of components) {
          const p = getPlugin(c.type);
          if (p) plugins.set(c.type, p);
        }
        const results: WorkerResult[] = [];
        let currentPrev = prev;
        for (let i = 0; i < count; i++) {
          const result = simulateStep(components, wires, plugins, currentPrev, dt, method ? { method } : undefined);
          if (!result) return Promise.resolve(null);
          results.push({ sim: result.sim, branchCurrentSize: result.branchCurrentSize });
          currentPrev = {
            nodeVoltage: result.sim.nodeVoltage,
            branchCurrent: result.sim.branchCurrent,
            time: result.sim.time,
            state: result.sim.state,
          };
        }
        return Promise.resolve(results);
      }
      const requestId = `req_${++requestIdRef.current}`;
      const pluginsSnapshot = Array.from(new Set(components.map((c) => c.type)));
      return new Promise((resolve) => {
        pendingRef.current.set(requestId, (result: any) => {
          if (result && result.type === 'batch_result') {
            resolve(result.results as WorkerResult[]);
          } else {
            resolve(null);
          }
        });
        workerRef.current!.postMessage({
          type: 'batch',
          requestId,
          components,
          wires,
          prev,
          dt,
          count,
          method,
          pluginsSnapshot,
        });
      });
    },
    [isWorkerReady],
  );

  return { stepAsync, batchAsync, isWorkerReady };
}
