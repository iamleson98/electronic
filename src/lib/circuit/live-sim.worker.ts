// Dedicated worker entry for the STATEFUL live simulation.
// Built by the bundler via:
//   new Worker(new URL('./live-sim.worker.ts', import.meta.url), { type: 'module' })
// All logic lives in LiveSimHost (sim-live-host.ts) so it is unit-testable in
// Node without a real Worker.

// Plugins self-register via side-effect imports; the worker's registry starts empty.
import './components';
import { LiveSimHost, type LiveHostMsg } from './sim-live-host';

const ctx = self as unknown as {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<LiveHostMsg>) => void) | null;
};
const host = new LiveSimHost((msg, transfer) => ctx.postMessage(msg, transfer ?? []));
ctx.onmessage = (e) => host.handle(e.data);

export {};
