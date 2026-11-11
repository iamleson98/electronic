// Pool worker for embarrassingly-parallel batch work (Monte Carlo trials,
// parameter / temperature sweep points). Stateless: each message is a task.
//   new Worker(new URL('./batch.worker.ts', import.meta.url), { type: 'module' })

import './components';
import { executeBatchTask, type BatchTask } from './batch-tasks';

const ctx = self as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((e: MessageEvent<{ id: number; task: BatchTask }>) => void) | null;
};
ctx.onmessage = (e) => {
  const { id, task } = e.data;
  try {
    ctx.postMessage({ id, ok: true, result: executeBatchTask(task) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error).message ?? String(err) });
  }
};

export {};
