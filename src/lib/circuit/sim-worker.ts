// Web Worker for multi-threaded simulation.
//
// Runs the simulation engine in a separate thread so the UI doesn't block
// during long transient analyses or DC sweeps on large circuits.
//
// Usage from main thread:
//   const worker = new Worker(new URL('./sim-worker.ts', import.meta.url));
//   worker.postMessage({ type: 'step', components, wires, prev, dt });
//   worker.onmessage = (e) => { if (e.data.type === 'result') { ... } };
//
// The worker uses the same engine code (simulateStep) — it just runs it
// off the main thread. For circuits > 200 nodes, this keeps the UI
// responsive (60fps) while the solver churns in the background.

import { simulateStep } from '../circuit/engine';
import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from '../circuit/types';
import { getPlugin } from '../circuit/registry';

// Wire up the message handler
self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'step': {
      const { components, wires, prev, dt, pluginsSnapshot } = msg;
      try {
        // Rebuild the plugins map from the snapshot (plugins aren't directly transferable)
        const plugins = new Map<string, ComponentPlugin>();
        for (const type of pluginsSnapshot as string[]) {
          const p = getPlugin(type);
          if (p) plugins.set(type, p);
        }
        const result = simulateStep(
          components as CircuitComponent[],
          wires as Wire[],
          plugins,
          prev as any,
          dt as number,
        );
        if (result) {
          // Transfer the result back — use structured clone (default)
          (self as any).postMessage({
            type: 'result',
            sim: result.sim,
            branchCurrentSize: result.branchCurrentSize,
            nodeMap: result.nodeMap,
          });
        } else {
          (self as any).postMessage({ type: 'error', message: 'simulateStep returned null' });
        }
      } catch (err) {
        (self as any).postMessage({ type: 'error', message: (err as Error).message });
      }
      break;
    }
    case 'batch': {
      // Run a batch of steps (e.g. for a transient sweep)
      const { components, wires, prev, dt, count, pluginsSnapshot } = msg;
      try {
        const plugins = new Map<string, ComponentPlugin>();
        for (const type of pluginsSnapshot as string[]) {
          const p = getPlugin(type);
          if (p) plugins.set(type, p);
        }
        let currentPrev = prev;
        const results: any[] = [];
        for (let i = 0; i < count; i++) {
          const result = simulateStep(
            components as CircuitComponent[],
            wires as Wire[],
            plugins,
            currentPrev as any,
            dt as number,
          );
          if (!result) {
            (self as any).postMessage({ type: 'error', message: `step ${i} returned null`, partial: results });
            return;
          }
          results.push({
            sim: result.sim,
            branchCurrentSize: result.branchCurrentSize,
          });
          currentPrev = {
            nodeVoltage: result.sim.nodeVoltage,
            branchCurrent: result.sim.branchCurrent,
            time: result.sim.time,
            state: result.sim.state,
          };
        }
        (self as any).postMessage({ type: 'batch_result', results });
      } catch (err) {
        (self as any).postMessage({ type: 'error', message: (err as Error).message });
      }
      break;
    }
    case 'ping': {
      (self as any).postMessage({ type: 'pong' });
      break;
    }
  }
};

// Export nothing — this module is loaded as a Worker, not imported directly.
export {};
