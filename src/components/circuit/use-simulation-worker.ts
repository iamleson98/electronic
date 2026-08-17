// Re-export the real Web Worker hook.
// Previously this was a 1-line stub that always returned isWorkerReady: false.
// The real implementation is in src/lib/circuit/use-sim-worker.ts and includes
// a synchronous fallback for when Workers aren't available (SSR, CSP, etc.).
export { useSimWorker as useSimulationWorker } from '@/lib/circuit/use-sim-worker';
