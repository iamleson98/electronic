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

// Import the full plugin registry — plugins self-register via side-effect
// imports (store.ts does the same on the main thread). Without this the
// worker's registry is empty, getPlugin() returns undefined for every type,
// and simulateStep stamps nothing.
import './components';
import { simulateStep } from '../circuit/engine';
import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from '../circuit/types';
import { getPlugin } from '../circuit/registry';

// Wire up the message handler
self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'step': {
      const { components, wires, prev, dt, method, pluginsSnapshot, requestId } = msg;
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
          method ? { method } as any : undefined,
        );
        if (result) {
          // Transfer the result back — use structured clone (default).
          // NOTE: every reply MUST echo requestId — the main thread keys its
          // pending promises by it.
          (self as any).postMessage({
            type: 'result',
            requestId,
            sim: result.sim,
            branchCurrentSize: result.branchCurrentSize,
            nodeMap: result.nodeMap,
          });
        } else {
          (self as any).postMessage({ type: 'error', requestId, message: 'simulateStep returned null' });
        }
      } catch (err) {
        (self as any).postMessage({ type: 'error', requestId, message: (err as Error).message });
      }
      break;
    }
    case 'batch': {
      // Run a batch of steps (e.g. for a transient sweep)
      const { components, wires, prev, dt, count, method, pluginsSnapshot, requestId } = msg;
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
            method ? { method } as any : undefined,
          );
          if (!result) {
            (self as any).postMessage({ type: 'error', requestId, message: `step ${i} returned null`, partial: results });
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
        (self as any).postMessage({ type: 'batch_result', requestId, results });
      } catch (err) {
        (self as any).postMessage({ type: 'error', requestId, message: (err as Error).message });
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
